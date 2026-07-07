import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DOWNLOADS_DIR, PROFILES_DIR } from '../shared/paths';
import { clip, inferJsonContentType, LogBuffer, normalizeUrl, prepareEval } from '../shared/util';
import { Emulator } from './emulation';
import { NetMonitor } from './netMonitor';
import { TargetResolver } from './targets';
import {
  LOG_CAP,
  TEXT_CAP,
  TEXT_CONTENT_RE,
  type ActionResult,
  type ConsoleEntry,
  type DownloadInfo,
  type HostOptions,
  type NetEntry,
  type RouteRule,
  type TabInfo,
  type Target,
} from './types';

// 型はデーモン内で共有するため types.ts にあるが、従来どおり host からも参照できるようにする
export type { ActionResult, ConsoleEntry, DownloadInfo, HostOptions, NetEntry, RouteRule, TabInfo, Target };

/** dom query --html の要素あたり outerHTML 上限。 */
const DOM_HTML_CAP = 2_000;
/** 操作系のデフォルトタイムアウト。 */
const ACTION_TIMEOUT = 10_000;

/**
 * Chromium(persistent context)を保持し、タブを ID で管理するブラウザホスト。
 * channel は chrome → msedge → 同梱 chromium の順でフォールバックする。
 * ネットワーク監視は NetMonitor、エミュレーションは Emulator、
 * ref の解決・自動再解決は TargetResolver に委譲する。
 */
export class BrowserHost {
  private context!: BrowserContext;
  /** connectOverCDP でアタッチした場合のみ保持(stop 時は切断のみでブラウザを閉じない)。 */
  private browser: Browser | null = null;
  /** 既存ブラウザへのアタッチモードか。再起動を伴う操作 (mode/profile/auth) は使えない。 */
  attached = false;
  private tabs = new Map<number, Page>();
  private nextTabId = 1;
  private activeTabId: number | null = null;

  private net = new NetMonitor();
  private emulator = new Emulator();
  private targets = new TargetResolver();
  private consoleLog = new LogBuffer<ConsoleEntry>(LOG_CAP);
  private downloads: DownloadInfo[] = [];
  private nextDownloadId = 1;

  private opts!: HostOptions;
  /** mode/profile/auth 切替による再起動中は context 'close' でのデーモン終了を抑止する。 */
  private restarting = false;

  channel = 'bundled chromium';
  headless = false;
  profile = 'default';

  /** ブラウザウィンドウが(手動含め)完全に閉じられたときに呼ばれる。 */
  onClosed: () => void = () => {};

  /** 操作ジャーナル用フック(main.ts が設定)。xhr/fetch/document/other の通信を全ヘッダ付きで通知する。 */
  set onJournalNet(fn: NetMonitor['onJournalNet']) {
    this.net.onJournalNet = fn;
  }

  /** 操作ジャーナル用フック(main.ts が設定)。コンソール出力・ページエラーを通知する。 */
  onJournalConsole: (ev: { kind: string; text: string; tab: number }) => void = () => {};

  async start(opts: HostOptions): Promise<void> {
    // アタッチ(--cdp)では stealth の起動フラグも init 相当も適用できない。CLI でも排他だが、
    // 別経路(デーモン直接起動等)で両方来ても status() が嘘をつかないよう stealth を落として正規化する。
    this.opts = opts.cdpUrl ? { ...opts, stealth: false } : opts;
    await this.launch(this.opts);
  }

  private async launch(opts: HostOptions): Promise<void> {
    this.headless = opts.headless;
    this.profile = opts.profile;

    if (opts.cdpUrl) {
      await this.attachOverCdp(opts.cdpUrl);
    } else {
      await this.launchOwned(opts);
    }

    for (const page of this.context.pages()) this.registerTab(page);
    this.context.on('page', (page) => this.registerTab(page));
    this.context.on('close', () => {
      if (!this.restarting) this.onClosed();
    });

    // block / mock ルールは context 単位なので再起動時に引き継ぐ
    await this.net.reapplyRoutes(this.context);
  }

  /** 自前でブラウザを起動する(通常モード)。channel 明示指定時はフォールバックしない。 */
  private async launchOwned(opts: HostOptions): Promise<void> {
    const userDataDir = path.join(PROFILES_DIR, opts.profile);
    const candidates: (string | undefined)[] = opts.channel
      ? [opts.channel === 'chromium' ? undefined : opts.channel]
      : ['chrome', 'msedge', undefined];
    const errors: string[] = [];
    let launched = false;
    for (const channel of candidates) {
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, {
          headless: opts.headless,
          channel,
          viewport: null,
          proxy: opts.proxy,
          httpCredentials: opts.httpCredentials,
          userAgent: opts.userAgent,
          // ステルス: navigator.webdriver を実 Chrome 同様に消す(JS で defineProperty するより
          // フラグで生やさない方が痕跡が残らない)。計測上、これだけで chrome チャネルの
          // JS レベルの自動化シグナルはほぼ実 Chrome と一致する。
          args: opts.stealth ? ['--disable-blink-features=AutomationControlled'] : undefined,
        });
        this.channel = channel ?? 'bundled chromium';
        launched = true;
        break;
      } catch (err) {
        const firstLine = String(err instanceof Error ? err.message : err).split('\n')[0];
        errors.push(`${channel ?? 'bundled chromium'}: ${firstLine}`);
      }
    }
    if (!launched) {
      const detail = errors.map((e) => `  - ${e}`).join('\n');
      const hint = errors.some((e) => /ProcessSingleton|already in use|SingletonLock/i.test(e))
        ? `プロファイル "${opts.profile}" が別の Chromium プロセスに使用されています。既存の kb デーモンや孤児プロセスを終了してください。`
        : 'Chrome/Edge が見つからない場合は "npx playwright install chromium" を実行してください。';
      throw new Error(`ブラウザを起動できません。${hint}\n候補ごとの失敗理由:\n${detail}`);
    }
  }

  /**
   * 起動済みブラウザへ connectOverCDP でアタッチする。対象は
   * `--remote-debugging-port` 付きで起動した Chrome / Edge / Chromium。
   * proxy / UA / Basic 認証などの起動時オプションは適用できない。
   */
  private async attachOverCdp(cdpUrl: string): Promise<void> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
    } catch (err) {
      throw new Error(
        `CDP エンドポイント ${cdpUrl} に接続できません。対象ブラウザを --remote-debugging-port 付きで起動してください` +
          `(例: chrome --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\kb-attach")。` +
          `Chrome 136 以降は普段使いの既定プロファイルではリモートデバッグが無効化されているため、専用の --user-data-dir が必要です。\n` +
          `(${String(err instanceof Error ? err.message : err).split('\n')[0]})`,
      );
    }
    const contexts = browser.contexts();
    if (!contexts.length) {
      await browser.close().catch(() => {});
      throw new Error('アタッチ先にブラウザコンテキストが見つかりません(ウィンドウが 1 つも開いていない可能性があります)');
    }
    this.browser = browser;
    this.attached = true;
    this.context = contexts[0];
    this.channel = `cdp:${cdpUrl}`;
    // ユーザーがブラウザを閉じた/接続が切れたらデーモンも終了する
    browser.on('disconnected', () => {
      if (!this.restarting) this.onClosed();
    });
  }

  /** アタッチモードでは使えない操作のガード。 */
  private assertNotAttached(op: string): void {
    if (this.attached) {
      throw new Error(
        `アタッチモード (connectOverCDP) では ${op} は使えません(接続先ブラウザの起動条件は kb からは変更できません)。` +
          `kb daemon stop で切断し、通常モードで起動し直してください。`,
      );
    }
  }

  /**
   * context を作り直す共通処理(headed⇄headless / プロファイル切替 / Basic 認証設定)。
   * profile(Cookie 等)は永続化されており、開いていたタブの URL も復元する。
   */
  private async restart(patch: Partial<HostOptions>): Promise<{ restoredTabs: number }> {
    const urls = [...this.tabs.values()].map((p) => p.url()).filter((u) => u && !u.startsWith('about:'));
    this.restarting = true;
    try {
      await this.context.close();
      this.tabs.clear();
      this.emulator.clear();
      this.targets.clear();
      this.activeTabId = null;
      this.opts = { ...this.opts, ...patch };
      await this.launch(this.opts);
      let restored = 0;
      let lastId: number | null = null;
      for (const url of urls) {
        try {
          const page = await this.context.newPage();
          const id = this.registerTab(page);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          restored++;
          lastId = id;
        } catch {
          /* 復元失敗したタブはスキップ */
        }
      }
      // 起動時に開く初期タブ (about:blank) はタブを復元できた場合は不要なので閉じる
      if (restored > 0) {
        for (const [, page] of [...this.tabs]) {
          if (page.url() === 'about:blank' || page.url() === '') await page.close().catch(() => {});
        }
        if (lastId != null && this.tabs.has(lastId)) this.activeTabId = lastId;
      }
      return { restoredTabs: restored };
    } finally {
      this.restarting = false;
    }
  }

  /** headless ⇄ headed を切り替える(Chromium の制約でブラウザ再起動が必要)。 */
  async setMode(headless: boolean): Promise<{ headless: boolean; restoredTabs: number; tabs: TabInfo[] }> {
    this.assertNotAttached('mode の切替');
    if (headless === this.headless) return { headless, restoredTabs: 0, tabs: await this.listTabs() };
    const { restoredTabs } = await this.restart({ headless });
    // 再起動でタブ ID が変わるため、呼び出し側が新しい ID を知れるよう一覧を返す
    return { headless, restoredTabs, tabs: await this.listTabs() };
  }

  /** ブラウザプロファイル(user-data-dir)を切り替える。再起動を伴う。 */
  async setProfile(name: string): Promise<{ profile: string; restoredTabs: number; tabs: TabInfo[] }> {
    this.assertNotAttached('profile の切替');
    if (!name) throw new Error('プロファイル名を指定してください');
    if (name === this.profile) return { profile: name, restoredTabs: 0, tabs: await this.listTabs() };
    const { restoredTabs } = await this.restart({ profile: name });
    return { profile: name, restoredTabs, tabs: await this.listTabs() };
  }

  /** 対象サイトの Basic 認証を設定/解除する。context オプションのため再起動を伴う。 */
  async setAuth(
    credentials: { username: string; password: string } | null,
  ): Promise<{ auth: boolean; restoredTabs: number; tabs: TabInfo[] }> {
    this.assertNotAttached('auth の設定');
    const { restoredTabs } = await this.restart({ httpCredentials: credentials ?? undefined });
    return { auth: credentials != null, restoredTabs, tabs: await this.listTabs() };
  }

  async stop(): Promise<void> {
    try {
      // アタッチモードでは切断のみ(ユーザーのブラウザは閉じない)。connectOverCDP の
      // browser.close() はプロセスを殺さず接続を切るだけ。
      if (this.attached) await this.browser?.close();
      else await this.context?.close();
    } catch {
      /* already closed */
    }
  }

  private registerTab(page: Page): number {
    for (const [id, p] of this.tabs) if (p === page) return id;
    const id = this.nextTabId++;
    this.tabs.set(id, page);
    // ポップアップ等がアクティブタブを奪わないよう、未設定のときだけアクティブにする
    // (明示的な open / activate は呼び出し側で activeTabId を設定する)
    if (this.activeTabId == null) this.activeTabId = id;
    page.on('close', () => {
      this.tabs.delete(id);
      this.emulator.dropTab(id);
      this.targets.dropTab(id);
      if (this.activeTabId === id) {
        const remaining = [...this.tabs.keys()];
        this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null;
      }
    });

    this.net.watchPage(page, id);

    page.on('console', (msg) => {
      this.consoleLog.push({ ts: new Date().toISOString(), tab: id, kind: msg.type(), text: msg.text() });
      this.onJournalConsole({ kind: msg.type(), text: msg.text(), tab: id });
    });
    page.on('pageerror', (err) => {
      this.consoleLog.push({ ts: new Date().toISOString(), tab: id, kind: 'pageerror', text: err.message });
      this.onJournalConsole({ kind: 'pageerror', text: err.message, tab: id });
    });
    page.on('download', (dl) => {
      const dlId = this.nextDownloadId++;
      const safeName = (dl.suggestedFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(DOWNLOADS_DIR, `${dlId}-${safeName}`);
      const info: DownloadInfo = { id: dlId, ts: new Date().toISOString(), tab: id, url: dl.url(), file, state: 'saving' };
      this.downloads.push(info);
      dl.saveAs(file).then(
        () => {
          info.state = 'saved';
        },
        (err) => {
          info.state = 'failed';
          info.error = String(err instanceof Error ? err.message : err).split('\n')[0];
        },
      );
    });

    return id;
  }

  private getPage(tabId?: number): { id: number; page: Page } {
    const id = tabId ?? this.activeTabId;
    if (id == null) throw new Error('開いているタブがありません。まず kb open <url> を実行してください。');
    const page = this.tabs.get(id);
    if (!page) throw new Error(`タブ ${id} は存在しません。kb tabs で確認してください。`);
    return { id, page };
  }

  /** 操作後の現在地(URL / タイトル)。ナビゲーション中なら少し待つ。 */
  private async feedback(page: Page): Promise<ActionResult> {
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  // ---- コマンド実装 ----

  async open(
    url: string,
    newTab: boolean,
    tabId?: number,
    waitUntil: 'domcontentloaded' | 'load' | 'networkidle' = 'domcontentloaded',
  ): Promise<{ tab: number; url: string; title: string }> {
    let id: number;
    let page: Page;
    if (newTab || (this.activeTabId == null && tabId == null)) {
      page = await this.context.newPage();
      id = this.registerTab(page);
    } else {
      ({ id, page } = this.getPage(tabId));
    }
    await page.goto(normalizeUrl(url), { waitUntil });
    this.activeTabId = id;
    return { tab: id, url: page.url(), title: await page.title().catch(() => '') };
  }

  async listTabs(): Promise<TabInfo[]> {
    const result: TabInfo[] = [];
    for (const [id, page] of this.tabs) {
      let title = '';
      try {
        title = await page.title();
      } catch {
        /* page might be navigating */
      }
      result.push({ id, url: page.url(), title, active: id === this.activeTabId });
    }
    return result;
  }

  async closeTab(tabId: number): Promise<void> {
    const { page } = this.getPage(tabId);
    // headed では最後のタブを閉じるとブラウザごと終了しデーモンが落ちるため、空タブを開いてから閉じる
    if (this.tabs.size === 1) {
      const blank = await this.context.newPage();
      this.registerTab(blank);
    }
    await page.close();
  }

  async activateTab(tabId: number): Promise<void> {
    const { id, page } = this.getPage(tabId);
    await page.bringToFront();
    this.activeTabId = id;
  }

  /** スクリーンショット。selector / ref を指定すると要素単位で撮る。 */
  async screenshot(
    outPath: string,
    opts: { full?: boolean; selector?: string; ref?: string; frame?: string; timeoutMs?: number },
    tabId?: number,
  ): Promise<string> {
    const { id, page } = this.getPage(tabId);
    if (opts.selector || opts.ref) {
      const t: Target = { selector: opts.selector, ref: opts.ref, frame: opts.frame };
      await this.targets.act(page, id, t, (loc) => loc.screenshot({ path: outPath, timeout: opts.timeoutMs ?? ACTION_TIMEOUT }));
    } else {
      // 重い SPA でフォント読み込み等の安定待ちが 30 秒(既定)を超えることがあるため timeout を指定可能にする
      await page.screenshot({ path: outPath, fullPage: !!opts.full, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
    }
    return outPath;
  }

  async text(
    tabId?: number,
    opts: { maxChars?: number; offset?: number } = {},
  ): Promise<{ url: string; title: string; text: string; totalChars: number; offset: number; truncated: boolean }> {
    const { page } = this.getPage(tabId);
    const raw = await page.evaluate(() => document.body?.innerText ?? '');
    const clipped = clip(raw, { maxChars: opts.maxChars ?? TEXT_CAP, offset: opts.offset });
    return { url: page.url(), title: await page.title().catch(() => ''), ...clipped };
  }

  async html(
    tabId?: number,
    opts: { maxChars?: number; offset?: number } = {},
  ): Promise<{ html: string; totalChars: number; offset: number; truncated: boolean }> {
    const { page } = this.getPage(tabId);
    const raw = await page.content();
    const clipped = clip(raw, { maxChars: opts.maxChars ?? TEXT_CAP, offset: opts.offset });
    return { html: clipped.text, totalChars: clipped.totalChars, offset: clipped.offset, truncated: clipped.truncated };
  }

  /**
   * アクセシビリティスナップショット(ref 付き)。iframe 内も f1e3 のような ref で参照でき、
   * click / fill などに --ref として渡せる。エージェントの要素発見はまずこれを使う。
   */
  async snapshot(
    tabId?: number,
    opts: { maxChars?: number; offset?: number } = {},
  ): Promise<{ url: string; title: string; snapshot: string; totalChars: number; offset: number; truncated: boolean }> {
    const { id, page } = this.getPage(tabId);
    let snap: string;
    try {
      snap = await page.locator('body').ariaSnapshot({ mode: 'ai' });
      this.targets.cacheSnapshot(id, snap); // 失効 ref の自動再解決用に全文をキャッシュ
    } catch {
      // 古い Playwright へのフォールバック(ref なし)
      snap = await page.locator('body').ariaSnapshot();
    }
    const clipped = clip(snap, { maxChars: opts.maxChars ?? TEXT_CAP, offset: opts.offset });
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      snapshot: clipped.text,
      totalChars: clipped.totalChars,
      offset: clipped.offset,
      truncated: clipped.truncated,
    };
  }

  /**
   * JS コードを実行する。await や複数文は自動で async IIFE にラップされ、
   * 最後の式(または return)の値が返る。結果(文字列化後)が上限を超える場合は
   * 切り詰めた文字列として返す(`document.body.innerHTML` のような巨大出力から
   * エージェントを守る)。
   */
  async eval(
    expression: string,
    tabId?: number,
    opts: { maxChars?: number; offset?: number } = {},
  ): Promise<{ result: unknown; truncated: boolean; totalChars?: number; offset?: number }> {
    const { page } = this.getPage(tabId);
    const raw = await page.evaluate(prepareEval(expression));
    const cap = opts.maxChars ?? TEXT_CAP;
    const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (serialized != null && ((cap > 0 && serialized.length > cap) || (opts.offset ?? 0) > 0)) {
      const clipped = clip(serialized, { maxChars: cap, offset: opts.offset });
      return { result: clipped.text, truncated: clipped.truncated, totalChars: clipped.totalChars, offset: clipped.offset };
    }
    return { result: raw, truncated: false };
  }

  /** feedback に ref 自動再解決の情報を合成する。 */
  private async acted(page: Page, r: { reResolved?: { from: string; to: string } }): Promise<ActionResult> {
    const fb = await this.feedback(page);
    return r.reResolved ? { ...fb, reResolvedRef: r.reResolved } : fb;
  }

  async click(t: Target): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.click({ timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async fill(t: Target, value: string): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.fill(value, { timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async press(key: string, tabId?: number): Promise<ActionResult> {
    const { page } = this.getPage(tabId);
    await page.keyboard.press(key);
    return this.feedback(page);
  }

  async hover(t: Target): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.hover({ timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async setChecked(t: Target, checked: boolean): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.setChecked(checked, { timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async select(t: Target, values: string[], byLabel: boolean): Promise<ActionResult & { selected: string[] }> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) =>
      byLabel
        ? loc.selectOption(values.map((label) => ({ label })), { timeout: ACTION_TIMEOUT })
        : loc.selectOption(values, { timeout: ACTION_TIMEOUT }),
    );
    return { selected: r.value, ...(await this.acted(page, r)) };
  }

  async upload(t: Target, files: string[]): Promise<ActionResult & { files: number }> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.setInputFiles(files, { timeout: ACTION_TIMEOUT }));
    return { files: files.length, ...(await this.acted(page, r)) };
  }

  async scroll(
    opts: { by?: number; to?: string; top?: boolean; bottom?: boolean },
    tabId?: number,
  ): Promise<{ scrollY: number }> {
    const { id, page } = this.getPage(tabId);
    if (opts.to) {
      await this.targets.act(page, id, { selector: opts.to }, (loc) => loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }));
    } else if (opts.top) {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (opts.bottom) {
      await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight ?? 0));
    } else {
      await page.evaluate((dy) => window.scrollBy(0, dy), opts.by ?? 600);
    }
    return { scrollY: await page.evaluate(() => window.scrollY) };
  }

  async goBack(tabId?: number): Promise<ActionResult & { navigated: boolean }> {
    const { page } = this.getPage(tabId);
    const res = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return { navigated: res != null, ...(await this.feedback(page)) };
  }

  async goForward(tabId?: number): Promise<ActionResult & { navigated: boolean }> {
    const { page } = this.getPage(tabId);
    const res = await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return { navigated: res != null, ...(await this.feedback(page)) };
  }

  async reload(tabId?: number): Promise<ActionResult> {
    const { page } = this.getPage(tabId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    return this.feedback(page);
  }

  /** PDF 出力。Chromium の制約で headless モードのみ。 */
  async pdf(outPath: string, tabId?: number): Promise<string> {
    if (!this.headless) {
      throw new Error('PDF 出力は headless モードのみ対応です。kb mode headless で切り替えてから実行してください。');
    }
    const { page } = this.getPage(tabId);
    await page.pdf({ path: outPath });
    return outPath;
  }

  // ---- ダウンロード ----

  listDownloads(): DownloadInfo[] {
    return this.downloads;
  }

  clearDownloads(): { cleared: number } {
    const n = this.downloads.length;
    this.downloads = [];
    return { cleared: n };
  }

  // ---- Cookie / ストレージ ----

  async cookies(domain?: string) {
    const all = await this.context.cookies();
    return domain ? all.filter((c) => c.domain.includes(domain)) : all;
  }

  async setCookie(cookie: { name: string; value: string; domain: string; path?: string }) {
    await this.context.addCookies([{ path: '/', ...cookie }]);
  }

  async removeCookie(name: string, domain?: string): Promise<void> {
    await this.context.clearCookies({ name, domain });
  }

  async clearCookies(): Promise<void> {
    await this.context.clearCookies();
  }

  async importCookies(cookies: unknown[]): Promise<{ imported: number }> {
    await this.context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
    return { imported: cookies.length };
  }

  /** Cookie + localStorage を一括ダンプする (Playwright storageState 形式)。 */
  async storageDump(): Promise<unknown> {
    return this.context.storageState();
  }

  /**
   * storageState 形式のダンプを復元する。Cookie は一括、localStorage は
   * オリジンごとに一時ページを開いて書き込む(失敗したオリジンはスキップ)。
   */
  async storageRestore(state: {
    cookies?: unknown[];
    origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
  }): Promise<{ cookies: number; origins: number; skippedOrigins: string[] }> {
    if (state.cookies?.length) {
      await this.context.addCookies(state.cookies as Parameters<BrowserContext['addCookies']>[0]);
    }
    let restored = 0;
    const skipped: string[] = [];
    for (const origin of state.origins ?? []) {
      const page = await this.context.newPage();
      try {
        await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.evaluate((items) => {
          for (const { name, value } of items) localStorage.setItem(name, value);
        }, origin.localStorage ?? []);
        restored++;
      } catch {
        skipped.push(origin.origin);
      } finally {
        await page.close().catch(() => {});
      }
    }
    return { cookies: state.cookies?.length ?? 0, origins: restored, skippedOrigins: skipped };
  }

  // ---- ネットワーク監視・改変 (NetMonitor へ委譲) ----

  netLogQuery(opts: { tab?: number; since?: number; filter?: string; limit?: number; responsesOnly?: boolean }): {
    entries: NetEntry[];
    seq: number;
    dropped: number;
  } {
    return this.net.query(opts);
  }

  netClear(): void {
    this.net.clear();
  }

  async addBlock(pattern: string): Promise<RouteRule> {
    return this.net.addBlock(this.context, pattern);
  }

  async addMock(pattern: string, status: number, contentType: string, body: string): Promise<RouteRule> {
    return this.net.addMock(this.context, pattern, status, contentType, body);
  }

  listRoutes(): RouteRule[] {
    return this.net.listRoutes();
  }

  async removeRoute(id: number): Promise<void> {
    return this.net.removeRoute(this.context, id);
  }

  async removeAllRoutes(): Promise<{ removed: number }> {
    return this.net.removeAllRoutes(this.context);
  }

  netBody(seq: number, opts: { maxChars?: number; offset?: number } = {}): ReturnType<NetMonitor['body']> {
    return this.net.body(seq, opts);
  }

  netHeadersQuery(seq: number): ReturnType<NetMonitor['headers']> {
    return this.net.headers(seq);
  }

  harStart(): { recording: boolean } {
    return this.net.harStart();
  }

  harStop(): unknown {
    return this.net.harStop();
  }

  harStatus(): { recording: boolean; entries: number } {
    return this.net.harStatus();
  }

  // ---- HTTP リクエスト (ページ非依存のミニ REST クライアント) ----

  /**
   * ブラウザの context.request で HTTP リクエストを送る。ページを開かずに API を叩ける。
   * Cookie はブラウザと共有され(Set-Cookie も反映される)、プロキシ設定も同じものを使う。
   */
  async httpRequest(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: string;
    timeoutMs?: number;
    follow?: boolean;
    savePath?: string;
    maxChars?: number;
    offset?: number;
  }): Promise<{
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    contentType: string;
    ms: number;
    bytes: number;
    savedTo?: string;
    binary?: boolean;
    body?: string;
    totalChars?: number;
    offset?: number;
    truncated?: boolean;
  }> {
    const started = Date.now();
    // JSON に見えるボディで Content-Type 未指定なら application/json を補う(明示ヘッダ優先)
    const inferred = inferJsonContentType(opts.data, opts.headers);
    const headersToSend = inferred ? { ...(opts.headers ?? {}), 'content-type': inferred } : opts.headers;
    const res = await this.context.request.fetch(normalizeUrl(opts.url), {
      method: (opts.method ?? 'GET').toUpperCase(),
      headers: headersToSend,
      data: opts.data,
      timeout: opts.timeoutMs ?? 30_000,
      maxRedirects: opts.follow === false ? 0 : undefined,
      failOnStatusCode: false,
    });
    const ms = Date.now() - started;
    const buf = await res.body().catch(() => Buffer.alloc(0)); // 204 等の空レスポンス
    const headers = res.headers();
    const contentType = headers['content-type'] ?? '';
    const base = {
      status: res.status(),
      statusText: res.statusText(),
      url: res.url(),
      headers,
      contentType,
      ms,
      bytes: buf.length,
    };
    res.dispose().catch(() => {});
    if (opts.savePath) {
      fs.writeFileSync(opts.savePath, buf);
      return { ...base, savedTo: opts.savePath };
    }
    if (buf.length > 0 && contentType && !TEXT_CONTENT_RE.test(contentType)) {
      return { ...base, binary: true };
    }
    const clipped = clip(buf.toString('utf8'), { maxChars: opts.maxChars ?? TEXT_CAP, offset: opts.offset });
    return {
      ...base,
      body: clipped.text,
      totalChars: clipped.totalChars,
      offset: clipped.offset,
      truncated: clipped.truncated,
    };
  }

  // ---- コンソール (DevTools Console 相当) ----

  consoleQuery(opts: { tab?: number; since?: number; limit?: number }): {
    entries: ConsoleEntry[];
    seq: number;
    dropped: number;
  } {
    return this.consoleLog.query({
      since: opts.since,
      limit: opts.limit,
      filter: (e) => opts.tab == null || e.tab === opts.tab,
    });
  }

  consoleClear(): void {
    this.consoleLog.clear();
  }

  // ---- 待機(手動介入との連携用) ----

  /**
   * 条件が満たされるまで待つ。url は glob (例: "**dashboard**")、selector は CSS、
   * idle は networkidle。どれも指定しない場合はページの load 完了を待つ。
   * 複数指定時は既定で AND(全条件を並列に待つ)、any=true で OR(どれか 1 つ)。
   */
  async waitFor(
    opts: { url?: string; selector?: string; idle?: boolean; any?: boolean; timeoutMs: number },
    tabId?: number,
  ): Promise<{ url: string; matched: string[] }> {
    const { page } = this.getPage(tabId);
    const conds: { name: string; wait: () => Promise<void> }[] = [];
    if (opts.url) conds.push({ name: `url=${opts.url}`, wait: () => page.waitForURL(opts.url!, { timeout: opts.timeoutMs }) });
    if (opts.selector)
      conds.push({
        name: `selector=${opts.selector}`,
        wait: async () => void (await page.waitForSelector(opts.selector!, { timeout: opts.timeoutMs, state: 'visible' })),
      });
    if (opts.idle) conds.push({ name: 'idle', wait: () => page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }) });
    if (!conds.length) conds.push({ name: 'load', wait: () => page.waitForLoadState('load', { timeout: opts.timeoutMs }) });

    if (opts.any && conds.length > 1) {
      // OR: 最初に満たされた条件で解決。残りの待機は裏で走り続けるが、
      // それぞれ自前のタイムアウトで終わるので放置してよい(rejection だけ握りつぶす)。
      const first = await Promise.any(
        conds.map((c) => {
          const p = c.wait().then(() => c.name);
          p.catch(() => {});
          return p;
        }),
      ).catch(() => {
        throw new Error(`どの条件も ${Math.round(opts.timeoutMs / 1000)} 秒以内に満たされませんでした (${conds.map((c) => c.name).join(' / ')})`);
      });
      return { url: page.url(), matched: [first] };
    }
    await Promise.all(conds.map((c) => c.wait()));
    return { url: page.url(), matched: conds.map((c) => c.name) };
  }

  // ---- エミュレーション (Emulator へ委譲) ----

  async emulate(
    opts: {
      ua?: string;
      viewport?: { width: number; height: number; dpr?: number; mobile?: boolean };
      timezone?: string;
      reset?: boolean;
    },
    tabId?: number,
  ): Promise<{ applied: string[] }> {
    const { id, page } = this.getPage(tabId);
    return this.emulator.apply(this.context, id, page, opts);
  }

  /** ネットワーク速度エミュレーション (offline | slow3g | fast3g | reset)。タブ単位。 */
  async emulateNetwork(preset: string, tabId?: number): Promise<{ preset: string }> {
    const { id, page } = this.getPage(tabId);
    return this.emulator.applyNetworkPreset(this.context, id, page, preset);
  }

  /** 位置情報のモック。context 全体(全タブ)に効く。 */
  async setGeolocation(latitude: number, longitude: number): Promise<void> {
    await this.context.grantPermissions(['geolocation']);
    await this.context.setGeolocation({ latitude, longitude });
  }

  // ---- DOM クエリ (DevTools Elements 相当) ----

  async domQuery(
    selector: string,
    opts: { html?: boolean; attr?: string; limit?: number; frame?: string },
    tabId?: number,
  ): Promise<{ total: number; matches: unknown[] }> {
    const { page } = this.getPage(tabId);
    const evalArgs = { html: !!opts.html, attr: opts.attr ?? null, limit: opts.limit ?? 20, htmlCap: DOM_HTML_CAP };
    const evalFn = (els: Element[], o: typeof evalArgs) => ({
      total: els.length,
      matches: els.slice(0, o.limit).map((el, index) => {
        const m: Record<string, unknown> = {
          index,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().slice(0, 300),
        };
        if (o.html) {
          const html = el.outerHTML;
          m.html = html.length > o.htmlCap ? html.slice(0, o.htmlCap) + '…' : html;
        }
        if (o.attr) {
          // 属性がなければ同名の DOM プロパティにフォールバックする
          // (<select> の value や checked はプロパティにしかないため)
          const attrValue = el.getAttribute(o.attr);
          if (attrValue != null) {
            m.attr = attrValue;
          } else {
            const propValue = (el as unknown as Record<string, unknown>)[o.attr];
            m.attr =
              propValue == null || typeof propValue === 'object' || typeof propValue === 'function' ? null : propValue;
          }
        }
        return m;
      }),
    });
    if (opts.frame) {
      return page.frameLocator(opts.frame).locator(selector).evaluateAll(evalFn, evalArgs);
    }
    return page.$$eval(selector, evalFn, evalArgs);
  }

  status() {
    return {
      pid: process.pid,
      headless: this.headless,
      channel: this.channel,
      profile: this.profile,
      tabs: this.tabs.size,
      activeTab: this.activeTabId,
      downloads: this.downloads.length,
      httpAuth: this.opts?.httpCredentials != null,
      ...(this.attached ? { attached: this.opts?.cdpUrl } : {}),
      ...(this.opts?.stealth ? { stealth: true } : {}),
    };
  }
}
