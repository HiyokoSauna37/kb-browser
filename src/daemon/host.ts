import path from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page, type Response, type Route } from 'playwright';
import { PROFILES_DIR } from '../shared/paths';

export interface HostOptions {
  headless: boolean;
  profile: string;
  /** ローカル中継プロキシのアドレス (例: "http://127.0.0.1:12345")。全タブがここを経由する。 */
  proxyServer?: string;
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

/** リングバッファの上限。超えた分は古いものから捨てる。 */
const LOG_CAP = 3000;
/** HAR に本文を含めるサイズ上限。 */
const HAR_BODY_CAP = 256 * 1024;

/**
 * Chromium(persistent context)を保持し、タブを ID で管理するブラウザホスト。
 * channel は chrome → msedge → 同梱 chromium の順でフォールバックする。
 */
export class BrowserHost {
  private context!: BrowserContext;
  private tabs = new Map<number, Page>();
  private nextTabId = 1;
  private activeTabId: number | null = null;

  private netLog: NetEntry[] = [];
  private netSeq = 0;
  private consoleLog: ConsoleEntry[] = [];
  private consoleSeq = 0;
  private routes = new Map<number, RouteRule & { handler: (route: Route) => void }>();
  private nextRouteId = 1;
  private har: { startedAt: string; entries: unknown[] } | null = null;

  private opts!: HostOptions;
  /** mode 切替による再起動中は context 'close' でのデーモン終了を抑止する。 */
  private restarting = false;
  /** エミュレーション用 CDP セッション。detach するとオーバーライドが解除されるためタブ毎に保持する。 */
  private cdpSessions = new Map<number, CDPSession>();

  channel = 'bundled chromium';
  headless = false;
  profile = 'default';

  /** ブラウザウィンドウが(手動含め)完全に閉じられたときに呼ばれる。 */
  onClosed: () => void = () => {};

  async start(opts: HostOptions): Promise<void> {
    this.opts = opts;
    await this.launch(opts);
  }

  private async launch(opts: HostOptions): Promise<void> {
    this.headless = opts.headless;
    this.profile = opts.profile;
    const userDataDir = path.join(PROFILES_DIR, opts.profile);

    const candidates: (string | undefined)[] = ['chrome', 'msedge', undefined];
    let lastError: unknown = null;
    for (const channel of candidates) {
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, {
          headless: opts.headless,
          channel,
          viewport: null,
          proxy: opts.proxyServer ? { server: opts.proxyServer } : undefined,
        });
        this.channel = channel ?? 'bundled chromium';
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      throw new Error(
        `ブラウザを起動できません。Chrome/Edge が見つからない場合は "npx playwright install chromium" を実行してください。\n` +
          String(lastError),
      );
    }

    for (const page of this.context.pages()) this.registerTab(page);
    this.context.on('page', (page) => this.registerTab(page));
    this.context.on('close', () => {
      if (!this.restarting) this.onClosed();
    });

    // block / mock ルールは context 単位なので再起動時に引き継ぐ
    for (const rule of this.routes.values()) await this.context.route(rule.pattern, rule.handler);
  }

  /**
   * headless ⇄ headed を切り替える。Chromium の制約でブラウザ再起動が必要だが、
   * profile(Cookie 等)は永続化されており、開いていたタブの URL も復元する。
   */
  async setMode(headless: boolean): Promise<{ headless: boolean; restoredTabs: number }> {
    if (headless === this.headless) return { headless, restoredTabs: 0 };
    const urls = [...this.tabs.values()].map((p) => p.url()).filter((u) => u && !u.startsWith('about:'));
    this.restarting = true;
    try {
      await this.context.close();
      this.tabs.clear();
      this.cdpSessions.clear();
      this.activeTabId = null;
      this.opts = { ...this.opts, headless };
      await this.launch(this.opts);
      let restored = 0;
      for (const url of urls) {
        try {
          const page = await this.context.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          restored++;
        } catch {
          /* 復元失敗したタブはスキップ */
        }
      }
      // 起動時に開く初期タブ (about:blank) はタブを復元できた場合は不要なので閉じる
      if (restored > 0) {
        for (const page of [...this.tabs.values()]) {
          if (page.url() === 'about:blank' || page.url() === '') await page.close().catch(() => {});
        }
      }
      return { headless, restoredTabs: restored };
    } finally {
      this.restarting = false;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* already closed */
    }
  }

  private registerTab(page: Page): number {
    for (const [id, p] of this.tabs) if (p === page) return id;
    const id = this.nextTabId++;
    this.tabs.set(id, page);
    this.activeTabId = id;
    page.on('close', () => {
      this.tabs.delete(id);
      this.cdpSessions.delete(id);
      if (this.activeTabId === id) {
        const remaining = [...this.tabs.keys()];
        this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null;
      }
    });

    page.on('request', (req) =>
      this.pushNet({ tab: id, event: 'request', method: req.method(), url: req.url(), resourceType: req.resourceType() }),
    );
    page.on('response', (res) => {
      const req = res.request();
      this.pushNet({
        tab: id,
        event: 'response',
        method: req.method(),
        url: res.url(),
        status: res.status(),
        resourceType: req.resourceType(),
      });
      if (this.har) void this.captureHarEntry(res);
    });
    page.on('requestfailed', (req) =>
      this.pushNet({
        tab: id,
        event: 'requestfailed',
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      }),
    );
    page.on('console', (msg) => this.pushConsole({ tab: id, kind: msg.type(), text: msg.text() }));
    page.on('pageerror', (err) => this.pushConsole({ tab: id, kind: 'pageerror', text: err.message }));

    return id;
  }

  private pushNet(entry: Omit<NetEntry, 'seq' | 'ts'>): void {
    this.netLog.push({ seq: ++this.netSeq, ts: new Date().toISOString(), ...entry });
    if (this.netLog.length > LOG_CAP) this.netLog.splice(0, this.netLog.length - LOG_CAP);
  }

  private pushConsole(entry: Omit<ConsoleEntry, 'seq' | 'ts'>): void {
    this.consoleLog.push({ seq: ++this.consoleSeq, ts: new Date().toISOString(), ...entry });
    if (this.consoleLog.length > LOG_CAP) this.consoleLog.splice(0, this.consoleLog.length - LOG_CAP);
  }

  private getPage(tabId?: number): { id: number; page: Page } {
    const id = tabId ?? this.activeTabId;
    if (id == null) throw new Error('開いているタブがありません。まず kb open <url> を実行してください。');
    const page = this.tabs.get(id);
    if (!page) throw new Error(`タブ ${id} は存在しません。kb tabs で確認してください。`);
    return { id, page };
  }

  // ---- コマンド実装 ----

  async open(url: string, newTab: boolean, tabId?: number): Promise<{ tab: number; url: string }> {
    let id: number;
    let page: Page;
    if (newTab || (this.activeTabId == null && tabId == null)) {
      page = await this.context.newPage();
      id = this.registerTab(page);
    } else {
      ({ id, page } = this.getPage(tabId));
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    this.activeTabId = id;
    return { tab: id, url: page.url() };
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
    await page.close();
  }

  async activateTab(tabId: number): Promise<void> {
    const { id, page } = this.getPage(tabId);
    await page.bringToFront();
    this.activeTabId = id;
  }

  async screenshot(outPath: string, fullPage: boolean, tabId?: number): Promise<string> {
    const { page } = this.getPage(tabId);
    await page.screenshot({ path: outPath, fullPage });
    return outPath;
  }

  async text(tabId?: number): Promise<{ url: string; title: string; text: string }> {
    const { page } = this.getPage(tabId);
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return { url: page.url(), title: await page.title(), text };
  }

  async html(tabId?: number): Promise<string> {
    const { page } = this.getPage(tabId);
    return page.content();
  }

  async eval(expression: string, tabId?: number): Promise<unknown> {
    const { page } = this.getPage(tabId);
    return page.evaluate(expression);
  }

  async click(selector: string, tabId?: number): Promise<void> {
    const { page } = this.getPage(tabId);
    await page.click(selector, { timeout: 10_000 });
  }

  async fill(selector: string, value: string, tabId?: number): Promise<void> {
    const { page } = this.getPage(tabId);
    await page.fill(selector, value, { timeout: 10_000 });
  }

  async press(key: string, tabId?: number): Promise<void> {
    const { page } = this.getPage(tabId);
    await page.keyboard.press(key);
  }

  async cookies(domain?: string) {
    const all = await this.context.cookies();
    return domain ? all.filter((c) => c.domain.includes(domain)) : all;
  }

  async setCookie(cookie: { name: string; value: string; domain: string; path?: string }) {
    await this.context.addCookies([{ path: '/', ...cookie }]);
  }

  async clearCookies(): Promise<void> {
    await this.context.clearCookies();
  }

  // ---- ネットワーク監視・改変 (DevTools Network 相当) ----

  netLogQuery(opts: { tab?: number; since?: number; filter?: string; limit?: number }): { entries: NetEntry[]; seq: number } {
    let entries = this.netLog;
    if (opts.since) entries = entries.filter((e) => e.seq > opts.since!);
    if (opts.tab != null) entries = entries.filter((e) => e.tab === opts.tab);
    if (opts.filter) {
      const re = new RegExp(opts.filter, 'i');
      entries = entries.filter((e) => re.test(e.url));
    }
    if (opts.limit && entries.length > opts.limit) entries = entries.slice(-opts.limit);
    return { entries, seq: this.netSeq };
  }

  netClear(): void {
    this.netLog = [];
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

  // ---- HAR 記録 ----

  harStart(): { recording: boolean } {
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

  consoleQuery(opts: { tab?: number; since?: number; limit?: number }): { entries: ConsoleEntry[]; seq: number } {
    let entries = this.consoleLog;
    if (opts.since) entries = entries.filter((e) => e.seq > opts.since!);
    if (opts.tab != null) entries = entries.filter((e) => e.tab === opts.tab);
    if (opts.limit && entries.length > opts.limit) entries = entries.slice(-opts.limit);
    return { entries, seq: this.consoleSeq };
  }

  consoleClear(): void {
    this.consoleLog = [];
  }

  // ---- 待機(手動介入との連携用) ----

  /**
   * 条件が満たされるまで待つ。url は glob (例: "**dashboard**")、selector は CSS。
   * どちらも指定しない場合はページの load 完了を待つ。
   */
  async waitFor(
    opts: { url?: string; selector?: string; timeoutMs: number },
    tabId?: number,
  ): Promise<{ url: string }> {
    const { page } = this.getPage(tabId);
    if (opts.url) await page.waitForURL(opts.url, { timeout: opts.timeoutMs });
    if (opts.selector) await page.waitForSelector(opts.selector, { timeout: opts.timeoutMs, state: 'visible' });
    if (!opts.url && !opts.selector) await page.waitForLoadState('load', { timeout: opts.timeoutMs });
    return { url: page.url() };
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
      applied.push('reset');
    }
    if (opts.ua) {
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: opts.ua });
      applied.push('ua');
    }
    if (opts.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: opts.viewport.width,
        height: opts.viewport.height,
        deviceScaleFactor: opts.viewport.dpr ?? 1,
        mobile: !!opts.viewport.mobile,
      });
      applied.push('viewport');
    }
    if (opts.timezone) {
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone });
      applied.push('timezone');
    }
    return { applied };
  }

  /** 位置情報のモック。context 全体(全タブ)に効く。 */
  async setGeolocation(latitude: number, longitude: number): Promise<void> {
    await this.context.grantPermissions(['geolocation']);
    await this.context.setGeolocation({ latitude, longitude });
  }

  // ---- DOM クエリ (DevTools Elements 相当) ----

  async domQuery(
    selector: string,
    opts: { html?: boolean; attr?: string; limit?: number },
    tabId?: number,
  ): Promise<{ total: number; matches: unknown[] }> {
    const { page } = this.getPage(tabId);
    return page.$$eval(
      selector,
      (els, o) => ({
        total: els.length,
        matches: els.slice(0, o.limit).map((el, index) => {
          const m: Record<string, unknown> = {
            index,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? '').trim().slice(0, 300),
          };
          if (o.html) m.html = el.outerHTML;
          if (o.attr) m.attr = el.getAttribute(o.attr);
          return m;
        }),
      }),
      { html: !!opts.html, attr: opts.attr ?? null, limit: opts.limit ?? 20 },
    );
  }

  status() {
    return {
      pid: process.pid,
      headless: this.headless,
      channel: this.channel,
      profile: this.profile,
      tabs: this.tabs.size,
      activeTab: this.activeTabId,
    };
  }
}
