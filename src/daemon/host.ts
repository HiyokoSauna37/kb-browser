import { type Browser, type BrowserContext, type Page } from 'playwright';
import { clip, LogBuffer, normalizeUrl, prepareEval } from '../shared/util';
import { Emulator } from './emulation';
import { DialogManager } from './host/dialogs';
import { DownloadManager } from './host/downloads';
import { httpRequest, type HttpRequestOptions, type HttpResult } from './host/httpClient';
import { attachOverCdp, launchOwned } from './host/launcher';
import { TabRegistry } from './host/tabs';
import { NetMonitor } from './netMonitor';
import { TargetResolver } from './targets';
import {
  LOG_CAP,
  TEXT_CAP,
  type ActionResult,
  type ConsoleEntry,
  type DialogInfo,
  type DialogPolicy,
  type DownloadInfo,
  type HostOptions,
  type NetEntry,
  type RouteRule,
  type TabInfo,
  type Target,
} from './types';

// 型はデーモン内で共有するため types.ts にあるが、従来どおり host からも参照できるようにする
export type { ActionResult, ConsoleEntry, DialogInfo, DialogPolicy, DownloadInfo, HostOptions, NetEntry, RouteRule, TabInfo, Target };

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
  /** タブの ID 管理(Map + 採番 + アクティブタブ)。イベント配線は registerTab が持つ。 */
  private tabs = new TabRegistry();

  private net = new NetMonitor();
  private emulator = new Emulator();
  private targets = new TargetResolver();
  private consoleLog = new LogBuffer<ConsoleEntry>(LOG_CAP);
  private downloads = new DownloadManager();

  /** JS ダイアログ (alert/confirm/prompt) の保留・応答。記録は logDialog 経由で consoleLog/journal へ。 */
  private dialogs = new DialogManager((tab, text) => this.logDialog(tab, text));

  private opts!: HostOptions;
  /** mode/profile/auth 切替による再起動中は context 'close' でのデーモン終了を抑止する。 */
  private restarting = false;

  channel = 'bundled chromium';
  headless = false;
  profile = 'default';

  /** ブラウザウィンドウが(手動含め)完全に閉じられたときに呼ばれる。 */
  onClosed: () => void = () => {};

  /**
   * 何らかのページ活動(ネットワークリクエスト / コンソール出力 / ページエラー)があるたびに
   * 呼ばれる。アイドル自動終了(idle reaper)が「headed でユーザーが直接操作中」を検知して
   * 延命するために使う(main.ts が設定)。
   */
  onActivity: () => void = () => {};

  /** 操作ジャーナル用フック(main.ts が設定)。xhr/fetch/document/other の通信を全ヘッダ付きで通知する。 */
  set onJournalNet(fn: NetMonitor['onJournalNet']) {
    this.net.onJournalNet = fn;
  }

  /** 操作ジャーナル用フック(main.ts が設定)。コンソール出力・ページエラーを通知する。 */
  onJournalConsole: (ev: { kind: string; text: string; tab: number }) => void = () => {};

  async start(opts: HostOptions): Promise<void> {
    // アタッチ(--cdp)では stealth / extensions / ignoreHTTPSErrors の起動フラグを適用できない
    // (context はアタッチ先が生成済み)。CLI でも排他だが、別経路(デーモン直接起動等)で両方来ても
    // status() が嘘をつかないよう落として正規化する。
    this.opts = opts.cdpUrl
      ? { ...opts, stealth: false, extensions: undefined, ignoreHttpsErrors: false, ignoreCertErrorsSpkiList: undefined }
      : opts;
    await this.launch(this.opts);
  }

  private async launch(opts: HostOptions): Promise<void> {
    this.headless = opts.headless;
    this.profile = opts.profile;

    const result = opts.cdpUrl ? await attachOverCdp(opts.cdpUrl) : await launchOwned(opts);
    this.context = result.context;
    this.browser = result.browser;
    this.attached = result.attached;
    this.channel = result.channel;

    // アタッチ時: ユーザーがブラウザを閉じた/接続が切れたらデーモンも終了する
    if (this.attached && this.browser) {
      this.browser.on('disconnected', () => {
        if (!this.restarting) this.onClosed();
      });
    }

    for (const page of this.context.pages()) this.registerTab(page);
    this.context.on('page', (page) => this.registerTab(page));
    this.context.on('close', () => {
      if (!this.restarting) this.onClosed();
    });

    // block / mock ルールは context 単位なので再起動時に引き継ぐ
    await this.net.reapplyRoutes(this.context);
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
    const urls = this.tabs.pages().map((p) => p.url()).filter((u) => u && !u.startsWith('about:'));
    this.restarting = true;
    try {
      await this.context.close();
      this.tabs.clear(); // Map を空にしアクティブも解除する
      this.emulator.clear();
      this.targets.clear();
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
        for (const [, page] of this.tabs.entries()) {
          if (page.url() === 'about:blank' || page.url() === '') await page.close().catch(() => {});
        }
        if (lastId != null && this.tabs.has(lastId)) this.tabs.active = lastId;
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
    const existing = this.tabs.find(page);
    if (existing != null) return existing;
    const id = this.tabs.add(page);
    page.on('close', () => {
      this.tabs.remove(id);
      this.emulator.dropTab(id);
      this.targets.dropTab(id);
      this.dialogs.dropTab(id);
    });

    page.on('dialog', (dialog) => this.dialogs.handle(dialog, id));
    // ユーザーがウィンドウ上で直接応答した場合も含め、ダイアログの閉鎖を検知して保留を解除する
    void this.dialogs.watchClose(page, id);

    this.net.watchPage(page, id);
    // ページのネットワーク活動を idle reaper へ通知する(headed でユーザーが直接操作 → ナビ →
    // リクエスト発生で延命される)。ログ蓄積は net.watchPage 側が別途行う。
    page.on('request', () => this.onActivity());

    page.on('console', (msg) => {
      this.consoleLog.push({ ts: new Date().toISOString(), tab: id, kind: msg.type(), text: msg.text() });
      this.onJournalConsole({ kind: msg.type(), text: msg.text(), tab: id });
      this.onActivity();
    });
    page.on('pageerror', (err) => {
      this.consoleLog.push({ ts: new Date().toISOString(), tab: id, kind: 'pageerror', text: err.message });
      this.onJournalConsole({ kind: 'pageerror', text: err.message, tab: id });
      this.onActivity();
    });
    page.on('download', (dl) => this.downloads.handle(dl, id));

    return id;
  }

  /** ダイアログ関連イベントをコンソールログ(kind=dialog)とジャーナルに記録する(DialogManager の onLog)。 */
  private logDialog(tab: number, text: string): void {
    this.consoleLog.push({ ts: new Date().toISOString(), tab, kind: 'dialog', text });
    this.onJournalConsole({ kind: 'dialog', text, tab });
  }

  /** タブ指定を解決する。応答待ちダイアログがある間、ページ JS を使う操作は進められないため既定で弾く。 */
  private getPage(tabId?: number, opts: { allowDialog?: boolean } = {}): { id: number; page: Page } {
    const id = tabId ?? this.tabs.active;
    if (id == null) throw new Error('開いているタブがありません。まず kb open <url> を実行してください。');
    const page = this.tabs.get(id);
    if (!page) throw new Error(`タブ ${id} は存在しません。kb tabs で確認してください。`);
    if (!opts.allowDialog && this.dialogs.has(id)) {
      const info = this.dialogs.get(id)!;
      throw new Error(
        `タブ ${id} で ${info.type} ダイアログ「${info.message}」が応答待ちです。kb dialog accept / kb dialog dismiss で応答してください(headed ならウィンドウ上でも応答できます)。`,
      );
    }
    return { id, page };
  }

  /** 操作後の現在地(URL / タイトル)。ナビゲーション中なら少し待つ。ダイアログ応答待ちなら待たずにその情報を返す。 */
  private async feedback(id: number, page: Page): Promise<ActionResult> {
    const dialog = this.dialogs.get(id);
    if (dialog) return { url: page.url(), title: '', dialog };
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
    if (newTab || (this.tabs.active == null && tabId == null)) {
      page = await this.context.newPage();
      id = this.registerTab(page);
    } else {
      ({ id, page } = this.getPage(tabId));
    }
    await page.goto(normalizeUrl(url), { waitUntil });
    this.tabs.active = id;
    return { tab: id, url: page.url(), title: await page.title().catch(() => '') };
  }

  async listTabs(): Promise<TabInfo[]> {
    const result: TabInfo[] = [];
    for (const [id, page] of this.tabs.entries()) {
      let title = '';
      try {
        // ダイアログ応答待ちのタブは JS が止まっており title() が返らないためスキップ
        if (!this.dialogs.has(id)) title = await page.title();
      } catch {
        /* page might be navigating */
      }
      result.push({ id, url: page.url(), title, active: id === this.tabs.active });
    }
    return result;
  }

  async closeTab(tabId: number): Promise<void> {
    const { page } = this.getPage(tabId, { allowDialog: true });
    // headed では最後のタブを閉じるとブラウザごと終了しデーモンが落ちるため、空タブを開いてから閉じる
    if (this.tabs.size === 1) {
      const blank = await this.context.newPage();
      this.registerTab(blank);
    }
    await page.close();
  }

  async activateTab(tabId: number): Promise<void> {
    // ダイアログ応答待ちのタブも前面に出せる(ユーザーがウィンドウ上で応答するため)
    const { id, page } = this.getPage(tabId, { allowDialog: true });
    await page.bringToFront();
    this.tabs.active = id;
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
  private async acted(id: number, page: Page, r: { reResolved?: { from: string; to: string } }): Promise<ActionResult> {
    const fb = await this.feedback(id, page);
    return r.reResolved ? { ...fb, reResolvedRef: r.reResolved } : fb;
  }

  /** actOrDialog のダイアログ側リターン(操作は保留ダイアログにブロックされ完了していない)。 */
  private dialogResult(page: Page, dialog: DialogInfo): ActionResult {
    return { url: page.url(), title: '', dialog };
  }

  async click(t: Target): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    return this.dialogs.actOrDialog(
      id,
      async () => this.acted(id, page, await this.targets.act(page, id, t, (loc) => loc.click({ timeout: ACTION_TIMEOUT }))),
      (d) => this.dialogResult(page, d),
    );
  }

  async fill(t: Target, value: string): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    return this.dialogs.actOrDialog(
      id,
      async () => this.acted(id, page, await this.targets.act(page, id, t, (loc) => loc.fill(value, { timeout: ACTION_TIMEOUT }))),
      (d) => this.dialogResult(page, d),
    );
  }

  async press(key: string, tabId?: number): Promise<ActionResult> {
    const { id, page } = this.getPage(tabId);
    return this.dialogs.actOrDialog(
      id,
      async () => {
        await page.keyboard.press(key);
        return this.feedback(id, page);
      },
      (d) => this.dialogResult(page, d),
    );
  }

  async hover(t: Target): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.hover({ timeout: ACTION_TIMEOUT }));
    return this.acted(id, page, r);
  }

  async setChecked(t: Target, checked: boolean): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    return this.dialogs.actOrDialog(
      id,
      async () =>
        this.acted(id, page, await this.targets.act(page, id, t, (loc) => loc.setChecked(checked, { timeout: ACTION_TIMEOUT }))),
      (d) => this.dialogResult(page, d),
    );
  }

  async select(t: Target, values: string[], byLabel: boolean): Promise<ActionResult & { selected: string[] }> {
    const { id, page } = this.getPage(t.tab);
    return this.dialogs.actOrDialog(
      id,
      async () => {
        const r = await this.targets.act(page, id, t, (loc) =>
          byLabel
            ? loc.selectOption(values.map((label) => ({ label })), { timeout: ACTION_TIMEOUT })
            : loc.selectOption(values, { timeout: ACTION_TIMEOUT }),
        );
        return { selected: r.value, ...(await this.acted(id, page, r)) };
      },
      (d) => ({ selected: [], ...this.dialogResult(page, d) }),
    );
  }

  async upload(t: Target, files: string[]): Promise<ActionResult & { files: number }> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.targets.act(page, id, t, (loc) => loc.setInputFiles(files, { timeout: ACTION_TIMEOUT }));
    return { files: files.length, ...(await this.acted(id, page, r)) };
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
    const { id, page } = this.getPage(tabId);
    const res = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return { navigated: res != null, ...(await this.feedback(id, page)) };
  }

  async goForward(tabId?: number): Promise<ActionResult & { navigated: boolean }> {
    const { id, page } = this.getPage(tabId);
    const res = await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return { navigated: res != null, ...(await this.feedback(id, page)) };
  }

  async reload(tabId?: number): Promise<ActionResult> {
    const { id, page } = this.getPage(tabId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    return this.feedback(id, page);
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
    return this.downloads.list();
  }

  clearDownloads(): { cleared: number } {
    return this.downloads.clear();
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

  async addMock(pattern: string, status?: number, contentType?: string, body?: string): Promise<RouteRule> {
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
  async httpRequest(opts: HttpRequestOptions): Promise<HttpResult> {
    return httpRequest(this.context, opts);
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
    opts: { url?: string; selector?: string; selectorGone?: string; idle?: boolean; any?: boolean; timeoutMs: number },
    tabId?: number,
  ): Promise<{ url: string; matched: string[] }> {
    // ダイアログ応答待ち中でも待機は開始できる(ユーザーがウィンドウ上で応答するのを待つ用途)。
    // ただしタイムアウト時は保留ダイアログが原因である可能性をヒントで示す。
    const { id, page } = this.getPage(tabId, { allowDialog: true });
    const conds: { name: string; wait: () => Promise<void> }[] = [];
    if (opts.url) conds.push({ name: `url=${opts.url}`, wait: () => page.waitForURL(opts.url!, { timeout: opts.timeoutMs }) });
    if (opts.selector)
      conds.push({
        name: `selector=${opts.selector}`,
        wait: async () => void (await page.waitForSelector(opts.selector!, { timeout: opts.timeoutMs, state: 'visible' })),
      });
    // selectorGone: 要素が消える(hidden または DOM から detach)まで待つ。ボット検出の
    // チャレンジ iframe が消える = 通過、を検知する用途(kb login --until-gone / kb wait --selector-gone)。
    if (opts.selectorGone)
      conds.push({
        name: `selector-gone=${opts.selectorGone}`,
        wait: async () => void (await page.waitForSelector(opts.selectorGone!, { timeout: opts.timeoutMs, state: 'hidden' })),
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
        throw this.dialogs.withHint(
          id,
          new Error(`どの条件も ${Math.round(opts.timeoutMs / 1000)} 秒以内に満たされませんでした (${conds.map((c) => c.name).join(' / ')})`),
        );
      });
      return { url: page.url(), matched: [first] };
    }
    await Promise.all(conds.map((c) => c.wait())).catch((err) => {
      throw this.dialogs.withHint(id, err);
    });
    return { url: page.url(), matched: conds.map((c) => c.name) };
  }

  // ---- JS ダイアログ (alert / confirm / prompt) — DialogManager へ委譲 ----

  /** 保留中ダイアログの情報と現在のポリシー。 */
  dialogInfo(tabId?: number): { pending: DialogInfo | null; pendingTabs: number[]; policy: DialogPolicy } {
    return this.dialogs.info(tabId, this.tabs.active);
  }

  /** 保留中ダイアログに応答する。promptText は prompt の入力値(accept 時のみ)。 */
  async dialogRespond(
    accept: boolean,
    promptText?: string,
    tabId?: number,
  ): Promise<{ responded: 'accept' | 'dismiss'; dialog: DialogInfo }> {
    return this.dialogs.respond(accept, promptText, tabId, this.tabs.active);
  }

  /** ダイアログの応答ポリシーを設定/取得する。 */
  setDialogPolicy(policy?: DialogPolicy): { policy: DialogPolicy } {
    return this.dialogs.setPolicy(policy);
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
      activeTab: this.tabs.active,
      downloads: this.downloads.count,
      httpAuth: this.opts?.httpCredentials != null,
      ...(this.attached ? { attached: this.opts?.cdpUrl } : {}),
      ...(this.opts?.stealth ? { stealth: true } : {}),
      ...(this.opts?.extensions ? { extensions: this.opts.extensions } : {}),
      ...(this.opts?.ignoreHttpsErrors ? { ignoreHttpsErrors: true } : {}),
      ...(this.opts?.ignoreCertErrorsSpkiList?.length ? { trustedCaSpki: this.opts.ignoreCertErrorsSpkiList.length } : {}),
      ...(this.dialogs.pendingCount ? { pendingDialogs: this.dialogs.pendingTabs } : {}),
      ...(this.dialogs.currentPolicy !== 'hold' ? { dialogPolicy: this.dialogs.currentPolicy } : {}),
    };
  }
}
