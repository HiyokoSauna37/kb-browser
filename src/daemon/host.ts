import fs from 'node:fs';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
} from 'playwright';
import { DOWNLOADS_DIR, PROFILES_DIR } from '../shared/paths';
import { BodyStore, clip, escapeRegExp, inferJsonContentType, LogBuffer, normalizeUrl, prepareEval } from '../shared/util';

export interface HostOptions {
  headless: boolean;
  profile: string;
  /** ローカル中継プロキシ (例: { server: "http://127.0.0.1:12345", username, password })。全タブがここを経由する。 */
  proxy?: { server: string; username?: string; password?: string };
  /** 対象サイトの Basic 認証 (context オプションのため変更には再起動が必要)。 */
  httpCredentials?: { username: string; password: string };
  /** 起動チャネルの明示指定。省略時は chrome → msedge → 同梱 chromium の順に自動選択。 */
  channel?: 'chrome' | 'msedge' | 'chromium';
  /** context 全体の User-Agent 上書き(headless の "HeadlessChrome" 対策など)。 */
  userAgent?: string;
  /** 既存ブラウザへのアタッチ (connectOverCDP)。指定時は launch せずこの CDP エンドポイントへ接続する。 */
  cdpUrl?: string;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface NetEntry {
  seq: number;
  ts: string;
  tab: number;
  event: 'request' | 'response' | 'requestfailed';
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
}

export interface ConsoleEntry {
  seq: number;
  ts: string;
  tab: number;
  kind: string;
  text: string;
}

export interface RouteRule {
  id: number;
  pattern: string;
  action: 'block' | 'mock';
  status?: number;
  contentType?: string;
}

export interface DownloadInfo {
  id: number;
  ts: string;
  tab: number;
  url: string;
  file: string;
  state: 'saving' | 'saved' | 'failed';
  error?: string;
}

/** 操作対象の指定。ref は kb snapshot が出力する要素参照 (例: "e12", iframe 内は "f1e3")。 */
export interface Target {
  selector?: string;
  ref?: string;
  /** iframe の CSS セレクタ。selector をこのフレーム内で解決する。 */
  frame?: string;
  tab?: number;
}

/** 操作後にエージェントへ返す現在地。 */
export interface ActionResult {
  url: string;
  title: string;
  /** 失効した ref を role/name の一致で新しい ref に自動再解決して操作した場合に入る。 */
  reResolvedRef?: { from: string; to: string };
}

/** リングバッファの上限。超えた分は古いものから捨てる。 */
const LOG_CAP = 3000;
/** HAR に本文を含めるサイズ上限。 */
const HAR_BODY_CAP = 256 * 1024;
/** net body 捕捉のエントリあたりサイズ上限(超過分は先頭のみ保持)。 */
const NET_BODY_CAP = 256 * 1024;
/** net body ストア全体の上限(件数 / バイト数)。超えたら古い本文から捨てる。 */
const NET_BODY_MAX_COUNT = 500;
const NET_BODY_MAX_BYTES = 32 * 1024 * 1024;
/** 本文を捕捉するテキスト系 Content-Type。 */
const TEXT_CONTENT_RE = /text|json|javascript|xml|html|css|svg|form-urlencoded/;
/** 本文を捕捉するリソース種別(API デバッグ用途。画像や大量の静的アセットは対象外)。 */
const BODY_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document', 'other']);
/** 全ヘッダ捕捉の保持件数上限(kb net headers 用。全レスポンスが対象)。 */
const NET_HEADERS_MAX = 2000;
/** text / html / snapshot のデフォルト出力上限(コンテキスト溢れ防止)。--max-chars 0 で無制限。 */
const TEXT_CAP = 20_000;
/** dom query --html の要素あたり outerHTML 上限。 */
const DOM_HTML_CAP = 2_000;
/** 操作系のデフォルトタイムアウト。 */
const ACTION_TIMEOUT = 10_000;

const NETWORK_PRESETS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  offline: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  slow3g: { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
  fast3g: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  reset: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

/**
 * Chromium(persistent context)を保持し、タブを ID で管理するブラウザホスト。
 * channel は chrome → msedge → 同梱 chromium の順でフォールバックする。
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

  private netLog = new LogBuffer<NetEntry>(LOG_CAP);
  /** 捕捉したレスポンス本文。キーは response エントリの seq。 */
  private netBodies = new BodyStore<{ body: Buffer; contentType: string; fullBytes: number }>(
    NET_BODY_MAX_COUNT,
    NET_BODY_MAX_BYTES,
  );
  /** 捕捉した全ヘッダ(kb net headers 用)。キーは response エントリの seq。挿入順で NET_HEADERS_MAX に切り詰め。 */
  private netHeaders = new Map<number, { request: Record<string, string>; response: Record<string, string> }>();
  private consoleLog = new LogBuffer<ConsoleEntry>(LOG_CAP);
  private routes = new Map<number, RouteRule & { handler: (route: Route) => void }>();
  private nextRouteId = 1;
  private har: { startedAt: string; entries: unknown[] } | null = null;
  private downloads: DownloadInfo[] = [];
  private nextDownloadId = 1;

  private opts!: HostOptions;
  /** mode/profile/auth 切替による再起動中は context 'close' でのデーモン終了を抑止する。 */
  private restarting = false;
  /** エミュレーション用 CDP セッション。detach するとオーバーライドが解除されるためタブ毎に保持する。 */
  private cdpSessions = new Map<number, CDPSession>();
  /** タブ毎の直近 snapshot(全文)。失効 ref の自動再解決(role/name 照合)に使う。 */
  private lastSnapshots = new Map<number, string>();

  channel = 'bundled chromium';
  headless = false;
  profile = 'default';

  /** ブラウザウィンドウが(手動含め)完全に閉じられたときに呼ばれる。 */
  onClosed: () => void = () => {};

  /** 操作ジャーナル用フック(main.ts が設定)。xhr/fetch/document/other の通信を全ヘッダ付きで通知する。 */
  onJournalNet: (ev: {
    method: string;
    url: string;
    status: number;
    resourceType: string;
    tab: number;
    requestHeaders: Record<string, string>;
    postData?: string;
    contentType?: string;
  }) => void = () => {};

  /** 操作ジャーナル用フック(main.ts が設定)。コンソール出力・ページエラーを通知する。 */
  onJournalConsole: (ev: { kind: string; text: string; tab: number }) => void = () => {};

  async start(opts: HostOptions): Promise<void> {
    this.opts = opts;
    await this.launch(opts);
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
    for (const rule of this.routes.values()) await this.context.route(rule.pattern, rule.handler);
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
      this.cdpSessions.clear();
      this.lastSnapshots.clear();
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
      this.cdpSessions.delete(id);
      this.lastSnapshots.delete(id);
      if (this.activeTabId === id) {
        const remaining = [...this.tabs.keys()];
        this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null;
      }
    });

    page.on('request', (req) =>
      this.netLog.push({ ts: new Date().toISOString(), tab: id, event: 'request', method: req.method(), url: req.url(), resourceType: req.resourceType() }),
    );
    page.on('response', (res) => {
      const req = res.request();
      const entry = this.netLog.push({
        ts: new Date().toISOString(),
        tab: id,
        event: 'response',
        method: req.method(),
        url: res.url(),
        status: res.status(),
        resourceType: req.resourceType(),
      });
      if (this.har) void this.captureHarEntry(res);
      void this.captureNetBody(entry.seq, res, req.resourceType());
      void this.captureNetHeaders(entry.seq, req, res, id);
    });
    page.on('requestfailed', (req) =>
      this.netLog.push({
        ts: new Date().toISOString(),
        tab: id,
        event: 'requestfailed',
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      }),
    );
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

  /** Target(selector / ref / frame)から Locator を解決する。 */
  private loc(page: Page, t: Target): Locator {
    if (t.ref) return page.locator(`aria-ref=${t.ref}`);
    if (!t.selector) throw new Error('selector か --ref のどちらかを指定してください。ref は kb snapshot で取得できます。');
    if (t.frame) return page.frameLocator(t.frame).locator(t.selector).first();
    return page.locator(t.selector).first();
  }

  /**
   * 要素操作を実行する。ref 操作がタイムアウトした場合は、直近の snapshot から
   * 同じ role/name の要素を新しい snapshot で探し、新 ref で 1 回だけリトライする
   * (SPA の再レンダで ref が失効しても、要素自体が残っていれば操作が通る)。
   * それでも失敗したら、エージェントが次に取るべき行動をヒントとして付ける。
   */
  private async act<T>(
    page: Page,
    tabId: number,
    t: Target,
    fn: (loc: Locator) => Promise<T>,
  ): Promise<{ value: T; reResolved?: { from: string; to: string } }> {
    let target = t;
    let reResolved: { from: string; to: string } | undefined;
    // ref が既に失効している(要素が見つからない)ならタイムアウトを待たずに即再解決する
    if (t.ref && (await this.loc(page, t).count().catch(() => 0)) === 0) {
      const newRef = await this.reResolveRef(page, tabId, t.ref).catch(() => null);
      if (!newRef) {
        // ref は snapshot 時点の要素インスタンスに紐づくため、待っても現れない。即エラーにする
        throw new Error(
          `ref "${t.ref}" の要素が見つかりません。ref はページ遷移や DOM 変化で失効します(自動再解決も一意に決まりませんでした)。kb snapshot を取り直して最新の ref を使ってください。`,
        );
      }
      target = { ...t, ref: newRef };
      reResolved = { from: t.ref, to: newRef };
    }
    try {
      return { value: await fn(this.loc(page, target)), reResolved };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timeout \d+ms exceeded/i.test(msg)) throw err;
      if (t.ref && !reResolved) {
        // count() では存在して見えたが操作はタイムアウトした場合の遅い再解決パス。
        // 再 snapshot は ref の紐付け自体を更新するため、同じ ref 番号が返っても再試行する価値がある
        const newRef = await this.reResolveRef(page, tabId, t.ref).catch(() => null);
        if (newRef) {
          try {
            const value = await fn(this.loc(page, { ...t, ref: newRef }));
            return { value, reResolved: { from: t.ref, to: newRef } };
          } catch {
            /* 再解決先でも失敗 → 下のヒント付きエラーへ */
          }
        }
      }
      const hint = t.ref
        ? `ref "${t.ref}" の要素が見つかりません。ref はページ遷移や DOM 変化で失効します(自動再解決も一意に決まりませんでした)。kb snapshot を取り直して最新の ref を使ってください。`
        : `要素が見つからないか操作できない状態です。kb snapshot でページ構造を確認してください。`;
      throw new Error(`${hint}\n(${msg.split('\n')[0]})`);
    }
  }

  /**
   * 失効した ref を再解決する。直近の snapshot キャッシュから旧 ref の行(role と
   * アクセシブルネーム)を取り出し、新しい snapshot で同じ role/name の行が
   * ちょうど 1 つのときだけ、その ref を返す(曖昧なら null)。
   */
  private async reResolveRef(page: Page, tabId: number, oldRef: string): Promise<string | null> {
    const prev = this.lastSnapshots.get(tabId);
    if (!prev) return null;
    const oldLine = prev.split('\n').find((l) => l.includes(`[ref=${oldRef}]`));
    if (!oldLine) return null;
    // 行の形式: `- button "Submit" [ref=e12]`。name のない要素は誤爆しやすいので対象外
    const parsed = /-\s+([a-zA-Z]+)\s+"([^"]+)"/.exec(oldLine);
    if (!parsed) return null;
    let snap: string;
    try {
      snap = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    } catch {
      return null;
    }
    this.lastSnapshots.set(tabId, snap);
    const lineRe = new RegExp(`-\\s+${escapeRegExp(parsed[1])}\\s+"${escapeRegExp(parsed[2])}".*\\[ref=([a-zA-Z0-9]+)\\]`);
    const hits = snap.split('\n').filter((l) => lineRe.test(l));
    if (hits.length !== 1) return null;
    return lineRe.exec(hits[0])![1];
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
      await this.act(page, id, t, (loc) => loc.screenshot({ path: outPath, timeout: opts.timeoutMs ?? ACTION_TIMEOUT }));
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
      this.lastSnapshots.set(id, snap); // 失効 ref の自動再解決用に全文をキャッシュ
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
    const r = await this.act(page, id, t, (loc) => loc.click({ timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async fill(t: Target, value: string): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.act(page, id, t, (loc) => loc.fill(value, { timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async press(key: string, tabId?: number): Promise<ActionResult> {
    const { page } = this.getPage(tabId);
    await page.keyboard.press(key);
    return this.feedback(page);
  }

  async hover(t: Target): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.act(page, id, t, (loc) => loc.hover({ timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async setChecked(t: Target, checked: boolean): Promise<ActionResult> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.act(page, id, t, (loc) => loc.setChecked(checked, { timeout: ACTION_TIMEOUT }));
    return this.acted(page, r);
  }

  async select(t: Target, values: string[], byLabel: boolean): Promise<ActionResult & { selected: string[] }> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.act(page, id, t, (loc) =>
      byLabel
        ? loc.selectOption(values.map((label) => ({ label })), { timeout: ACTION_TIMEOUT })
        : loc.selectOption(values, { timeout: ACTION_TIMEOUT }),
    );
    return { selected: r.value, ...(await this.acted(page, r)) };
  }

  async upload(t: Target, files: string[]): Promise<ActionResult & { files: number }> {
    const { id, page } = this.getPage(t.tab);
    const r = await this.act(page, id, t, (loc) => loc.setInputFiles(files, { timeout: ACTION_TIMEOUT }));
    return { files: files.length, ...(await this.acted(page, r)) };
  }

  async scroll(
    opts: { by?: number; to?: string; top?: boolean; bottom?: boolean },
    tabId?: number,
  ): Promise<{ scrollY: number }> {
    const { id, page } = this.getPage(tabId);
    if (opts.to) {
      await this.act(page, id, { selector: opts.to }, (loc) => loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }));
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

  // ---- ネットワーク監視・改変 (DevTools Network 相当) ----

  netLogQuery(opts: { tab?: number; since?: number; filter?: string; limit?: number; responsesOnly?: boolean }): {
    entries: NetEntry[];
    seq: number;
    dropped: number;
  } {
    const re = opts.filter ? new RegExp(opts.filter, 'i') : null;
    return this.netLog.query({
      since: opts.since,
      limit: opts.limit,
      filter: (e) =>
        (opts.tab == null || e.tab === opts.tab) &&
        (re == null || re.test(e.url)) &&
        // --responses: 送信相 (request) を省き、完了相 (response / requestfailed) の 1 行だけにする
        (!opts.responsesOnly || e.event !== 'request'),
    });
  }

  netClear(): void {
    this.netLog.clear();
  }

  async addBlock(pattern: string): Promise<RouteRule> {
    const handler = (route: Route) => void route.abort();
    await this.context.route(pattern, handler);
    const rule = { id: this.nextRouteId++, pattern, action: 'block' as const };
    this.routes.set(rule.id, { ...rule, handler });
    return rule;
  }

  async addMock(pattern: string, status: number, contentType: string, body: string): Promise<RouteRule> {
    const handler = (route: Route) => void route.fulfill({ status, contentType, body });
    await this.context.route(pattern, handler);
    const rule = { id: this.nextRouteId++, pattern, action: 'mock' as const, status, contentType };
    this.routes.set(rule.id, { ...rule, handler });
    return rule;
  }

  listRoutes(): RouteRule[] {
    return [...this.routes.values()].map(({ handler: _h, ...rule }) => rule);
  }

  async removeRoute(id: number): Promise<void> {
    const rule = this.routes.get(id);
    if (!rule) throw new Error(`ルール ${id} は存在しません。kb net rules で確認してください。`);
    await this.context.unroute(rule.pattern, rule.handler);
    this.routes.delete(id);
  }

  async removeAllRoutes(): Promise<{ removed: number }> {
    const n = this.routes.size;
    for (const rule of this.routes.values()) await this.context.unroute(rule.pattern, rule.handler);
    this.routes.clear();
    return { removed: n };
  }

  /**
   * レスポンス本文を捕捉する(kb net body 用)。API デバッグが目的なので、
   * テキスト系 Content-Type の XHR / fetch / document / other のみ対象。
   * サイズ・件数はストア側で上限管理される。
   */
  private async captureNetBody(seq: number, res: Response, resourceType: string): Promise<void> {
    if (!BODY_RESOURCE_TYPES.has(resourceType)) return;
    const contentType = res.headers()['content-type'] ?? '';
    if (!TEXT_CONTENT_RE.test(contentType)) return;
    try {
      const body = await res.body();
      this.netBodies.set(seq, {
        body: body.length > NET_BODY_CAP ? body.subarray(0, NET_BODY_CAP) : body,
        contentType,
        fullBytes: body.length,
      });
    } catch {
      /* ナビゲーション後は body が取れないことがある */
    }
  }

  /**
   * seq からログエントリを引く。request 行の seq が渡された場合は、
   * 対応する response(同タブ・同 URL で seq がより大きい最初のもの)へ自動で読み替える。
   */
  private resolveResponseSeq(seq: number): { seq: number; entry?: NetEntry } {
    const entry = this.netLog.query({ filter: (e) => e.seq === seq }).entries[0];
    if (entry?.event === 'request') {
      const resp = this.netLog.query({
        filter: (e) => e.event === 'response' && e.tab === entry.tab && e.url === entry.url && e.seq > seq,
      }).entries[0];
      if (resp) return { seq: resp.seq, entry: resp };
    }
    return { seq, entry };
  }

  /**
   * 捕捉済みのレスポンス本文を返す。seq は kb net log の行頭に出る番号
   * (request 行の seq でも対応する response に自動で読み替える)。
   */
  netBody(
    seq: number,
    opts: { maxChars?: number; offset?: number } = {},
  ): {
    seq: number;
    url?: string;
    status?: number;
    contentType: string;
    fullBytes: number;
    capturedTruncated: boolean;
    body: string;
    totalChars: number;
    offset: number;
    truncated: boolean;
  } {
    const resolved = this.resolveResponseSeq(seq);
    seq = resolved.seq;
    const entry = resolved.entry;
    const stored = this.netBodies.get(seq);
    if (!stored) {
      const reason = entry
        ? `seq ${seq} の本文は捕捉されていません(対象はテキスト系の XHR/fetch/document。古い本文は容量上限で破棄されます)`
        : `seq ${seq} のログはありません(バッファから消えた可能性があります)`;
      throw new Error(`${reason}。kb net log --filter <regex> で response 行の seq を確認してください。`);
    }
    const text = stored.body.toString('utf8');
    const clipped = clip(text, { maxChars: opts.maxChars ?? TEXT_CAP, offset: opts.offset });
    return {
      seq,
      url: entry?.url,
      status: entry?.status,
      contentType: stored.contentType,
      fullBytes: stored.fullBytes,
      capturedTruncated: stored.fullBytes > stored.body.length,
      body: clipped.text,
      totalChars: clipped.totalChars,
      offset: clipped.offset,
      truncated: clipped.truncated,
    };
  }

  /** 全ヘッダ(Cookie 等の CDP extra info 含む)を捕捉する。kb net headers と操作ジャーナル用。 */
  private async captureNetHeaders(seq: number, req: Request, res: Response, tabId: number): Promise<void> {
    try {
      const [request, response] = await Promise.all([req.allHeaders(), res.allHeaders()]);
      // kb 内部の中継プロキシ認証(セッショントークン)はサイト通信と無関係なので露出させない
      delete request['proxy-authorization'];
      this.netHeaders.set(seq, { request, response });
      for (const key of this.netHeaders.keys()) {
        if (this.netHeaders.size <= NET_HEADERS_MAX) break;
        this.netHeaders.delete(key);
      }
      const resourceType = req.resourceType();
      if (BODY_RESOURCE_TYPES.has(resourceType)) {
        this.onJournalNet({
          method: req.method(),
          url: res.url(),
          status: res.status(),
          resourceType,
          tab: tabId,
          requestHeaders: request,
          postData: req.postData() ?? undefined,
          contentType: response['content-type'],
        });
      }
    } catch {
      /* ナビゲーション後は取れないことがある */
    }
  }

  /** 捕捉済みの全リクエスト/レスポンスヘッダを返す。seq は kb net log の行頭の番号。 */
  netHeadersQuery(seq: number): {
    seq: number;
    url?: string;
    method?: string;
    status?: number;
    request: Record<string, string>;
    response: Record<string, string>;
  } {
    const { seq: resolvedSeq, entry } = this.resolveResponseSeq(seq);
    const stored = this.netHeaders.get(resolvedSeq);
    if (!stored) {
      const reason = entry
        ? `seq ${seq} のヘッダは記録されていません(直近 ${NET_HEADERS_MAX} レスポンスまで保持)`
        : `seq ${seq} のログはありません(バッファから消えた可能性があります)`;
      throw new Error(`${reason}。kb net log で response 行の seq を確認してください。`);
    }
    return {
      seq: resolvedSeq,
      url: entry?.url,
      method: entry?.method,
      status: entry?.status,
      request: stored.request,
      response: stored.response,
    };
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

  // ---- HAR 記録 ----

  harStart(): { recording: boolean } {
    if (this.har) throw new Error('HAR は既に記録中です。kb net har stop で保存してから開始してください。');
    this.har = { startedAt: new Date().toISOString(), entries: [] };
    return { recording: true };
  }

  harStop(): unknown {
    if (!this.har) throw new Error('HAR は記録中ではありません。kb net har start で開始してください。');
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'kb-browser', version: '0.1.0' },
        pages: [],
        entries: this.har.entries,
      },
    };
    this.har = null;
    return har;
  }

  harStatus(): { recording: boolean; entries: number } {
    return { recording: this.har != null, entries: this.har?.entries.length ?? 0 };
  }

  private async captureHarEntry(res: Response): Promise<void> {
    try {
      const req = res.request();
      const timing = req.timing();
      const contentType = res.headers()['content-type'] ?? '';
      let text: string | undefined;
      if (/text|json|javascript|xml|html|css|svg/.test(contentType)) {
        const body = await res.body();
        if (body.length <= HAR_BODY_CAP) text = body.toString('utf8');
      }
      const toNv = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
      this.har?.entries.push({
        startedDateTime: new Date().toISOString(),
        time: Math.max(timing.responseEnd, 0),
        request: {
          method: req.method(),
          url: req.url(),
          httpVersion: 'HTTP/1.1',
          headers: toNv(req.headers()),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: -1,
          ...(req.postData() != null
            ? { postData: { mimeType: req.headers()['content-type'] ?? '', text: req.postData() } }
            : {}),
        },
        response: {
          status: res.status(),
          statusText: res.statusText(),
          httpVersion: 'HTTP/1.1',
          headers: toNv(res.headers()),
          cookies: [],
          redirectURL: res.headers()['location'] ?? '',
          content: { size: text?.length ?? -1, mimeType: contentType, ...(text != null ? { text } : {}) },
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: {
          send: 0,
          wait: Math.max(timing.responseStart, 0),
          receive: Math.max(timing.responseEnd - timing.responseStart, 0),
        },
      });
    } catch {
      /* ナビゲーション後は body が取れないことがある */
    }
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

  // ---- エミュレーション (DevTools Device Toolbar 相当) ----

  private async cdpFor(tabId?: number): Promise<CDPSession> {
    const { id, page } = this.getPage(tabId);
    const existing = this.cdpSessions.get(id);
    if (existing) return existing;
    const session = await this.context.newCDPSession(page);
    this.cdpSessions.set(id, session);
    return session;
  }

  async emulate(
    opts: {
      ua?: string;
      viewport?: { width: number; height: number; dpr?: number; mobile?: boolean };
      timezone?: string;
      reset?: boolean;
    },
    tabId?: number,
  ): Promise<{ applied: string[] }> {
    const cdp = await this.cdpFor(tabId);
    const applied: string[] = [];
    if (opts.reset) {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await cdp.send('Emulation.clearGeolocationOverride').catch(() => {});
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      applied.push('reset');
    }
    if (opts.ua) {
      // Sec-CH-UA (Client Hints) と矛盾しないよう UA 文字列からメタデータも導出する
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: opts.ua,
        userAgentMetadata: uaMetadataFrom(opts.ua),
      });
      applied.push('ua');
    }
    if (opts.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: opts.viewport.width,
        height: opts.viewport.height,
        deviceScaleFactor: opts.viewport.dpr ?? 1,
        mobile: !!opts.viewport.mobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: !!opts.viewport.mobile,
        maxTouchPoints: opts.viewport.mobile ? 5 : 1,
      });
      applied.push('viewport');
    }
    if (opts.timezone) {
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone });
      applied.push('timezone');
    }
    return { applied };
  }

  /** ネットワーク速度エミュレーション (offline | slow3g | fast3g | reset)。タブ単位。 */
  async emulateNetwork(preset: string, tabId?: number): Promise<{ preset: string }> {
    const conditions = NETWORK_PRESETS[preset];
    if (!conditions) {
      throw new Error(`不明なプリセット "${preset}"。offline | slow3g | fast3g | reset から選んでください。`);
    }
    const cdp = await this.cdpFor(tabId);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', conditions);
    return { preset };
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
    };
  }
}

/** UA 文字列から Client Hints 用メタデータをおおまかに導出する。 */
function uaMetadataFrom(ua: string):
  | {
      brands: { brand: string; version: string }[];
      fullVersion: string;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
    }
  | undefined {
  const chromeVer = /Chrom(?:e|ium)\/(\d+)/.exec(ua)?.[1];
  if (!chromeVer) return undefined;
  const mobile = /Android|iPhone|Mobile/i.test(ua);
  let platform = 'Windows';
  if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad/.test(ua)) platform = 'iOS';
  else if (/Mac OS X/.test(ua)) platform = 'macOS';
  else if (/Linux/.test(ua)) platform = 'Linux';
  return {
    brands: [
      { brand: 'Chromium', version: chromeVer },
      { brand: 'Google Chrome', version: chromeVer },
      { brand: 'Not-A.Brand', version: '99' },
    ],
    fullVersion: `${chromeVer}.0.0.0`,
    platform,
    platformVersion: '',
    architecture: mobile ? '' : 'x86',
    model: '',
    mobile,
  };
}
