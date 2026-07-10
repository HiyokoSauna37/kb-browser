import type { BrowserContext, Page, Request, Response, Route } from 'playwright';
import { BodyStore, clip, LogBuffer } from '../shared/util';
import { KB_VERSION } from '../shared/version';
import { LOG_CAP, TEXT_CAP, TEXT_CONTENT_RE, type NetEntry, type RouteRule } from './types';

/** HAR に本文を含めるサイズ上限。 */
const HAR_BODY_CAP = 256 * 1024;
/**
 * HAR 記録のエントリ件数上限と本文合計バイト上限。
 * 他のバッファはリングバッファで古いものを捨てるが、HAR は「完全な記録」に意味があるため
 * 黙って古いエントリを落とさない。上限到達時は新規エントリの記録を停止し(既存分は保持)、
 * truncated フラグと HAR log.comment で欠落を明示する。
 */
const HAR_MAX_ENTRIES = 10_000;
const HAR_MAX_BODY_BYTES = 128 * 1024 * 1024;
/** net body 捕捉のエントリあたりサイズ上限(超過分は先頭のみ保持)。 */
const NET_BODY_CAP = 256 * 1024;
/** net body ストア全体の上限(件数 / バイト数)。超えたら古い本文から捨てる。 */
const NET_BODY_MAX_COUNT = 500;
const NET_BODY_MAX_BYTES = 32 * 1024 * 1024;
/** 本文を捕捉するリソース種別(API デバッグ用途。画像や大量の静的アセットは対象外)。 */
const BODY_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document', 'other']);
/** 全ヘッダ捕捉の保持件数上限(kb net headers 用。全レスポンスが対象)。 */
const NET_HEADERS_MAX = 2000;

/**
 * ネットワークの監視・改変 (DevTools Network 相当) を担当する。
 * - リングバッファへの通信ログ蓄積(kb net log)
 * - テキスト系レスポンス本文・全ヘッダの捕捉(kb net body / headers)
 * - block / mock ルール(kb net block / mock / unroute)
 * - HAR 記録(kb net har)
 */
export class NetMonitor {
  private netLog = new LogBuffer<NetEntry>(LOG_CAP);
  /** 捕捉したレスポンス本文。キーは response エントリの seq。 */
  private netBodies = new BodyStore<{ body: Buffer; contentType: string; fullBytes: number }>(
    NET_BODY_MAX_COUNT,
    NET_BODY_MAX_BYTES,
  );
  /** 捕捉した全ヘッダ(kb net headers 用)。キーは response エントリの seq。挿入順で NET_HEADERS_MAX に切り詰め。 */
  private netHeaders = new Map<number, { request: Record<string, string>; response: Record<string, string> }>();
  private routes = new Map<number, RouteRule & { handler: (route: Route) => void }>();
  private nextRouteId = 1;
  private har: { startedAt: string; entries: unknown[]; bodyBytes: number; truncated: boolean } | null = null;

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

  /** タブのネットワークイベントを購読する(タブ登録時に呼ぶ)。 */
  watchPage(page: Page, tabId: number): void {
    page.on('request', (req) =>
      this.netLog.push({ ts: new Date().toISOString(), tab: tabId, event: 'request', method: req.method(), url: req.url(), resourceType: req.resourceType() }),
    );
    page.on('response', (res) => {
      const req = res.request();
      const entry = this.netLog.push({
        ts: new Date().toISOString(),
        tab: tabId,
        event: 'response',
        method: req.method(),
        url: res.url(),
        status: res.status(),
        resourceType: req.resourceType(),
      });
      if (this.har) void this.captureHarEntry(res);
      void this.captureNetBody(entry.seq, res, req.resourceType());
      void this.captureNetHeaders(entry.seq, req, res, tabId);
    });
    page.on('requestfailed', (req) =>
      this.netLog.push({
        ts: new Date().toISOString(),
        tab: tabId,
        event: 'requestfailed',
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      }),
    );
  }

  query(opts: { tab?: number; since?: number; filter?: string; limit?: number; responsesOnly?: boolean }): {
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

  clear(): void {
    this.netLog.clear();
  }

  // ---- block / mock ルール ----

  async addBlock(context: BrowserContext, pattern: string): Promise<RouteRule> {
    const handler = (route: Route) => void route.abort();
    await context.route(pattern, handler);
    const rule = { id: this.nextRouteId++, pattern, action: 'block' as const };
    this.routes.set(rule.id, { ...rule, handler });
    return rule;
  }

  async addMock(context: BrowserContext, pattern: string, status: number, contentType: string, body: string): Promise<RouteRule> {
    const handler = (route: Route) => void route.fulfill({ status, contentType, body });
    await context.route(pattern, handler);
    const rule = { id: this.nextRouteId++, pattern, action: 'mock' as const, status, contentType };
    this.routes.set(rule.id, { ...rule, handler });
    return rule;
  }

  listRoutes(): RouteRule[] {
    return [...this.routes.values()].map(({ handler: _h, ...rule }) => rule);
  }

  async removeRoute(context: BrowserContext, id: number): Promise<void> {
    const rule = this.routes.get(id);
    if (!rule) throw new Error(`ルール ${id} は存在しません。kb net rules で確認してください。`);
    await context.unroute(rule.pattern, rule.handler);
    this.routes.delete(id);
  }

  async removeAllRoutes(context: BrowserContext): Promise<{ removed: number }> {
    const n = this.routes.size;
    for (const rule of this.routes.values()) await context.unroute(rule.pattern, rule.handler);
    this.routes.clear();
    return { removed: n };
  }

  /** block / mock ルールは context 単位なので、再起動後の新しい context に引き継ぐ。 */
  async reapplyRoutes(context: BrowserContext): Promise<void> {
    for (const rule of this.routes.values()) await context.route(rule.pattern, rule.handler);
  }

  // ---- 本文・ヘッダの捕捉 ----

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
  body(
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

  /** 捕捉済みの全リクエスト/レスポンスヘッダを返す。seq は kb net log の行頭の番号。 */
  headers(seq: number): {
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

  // ---- HAR 記録 ----

  harStart(): { recording: boolean } {
    if (this.har) throw new Error('HAR は既に記録中です。kb net har stop で保存してから開始してください。');
    this.har = { startedAt: new Date().toISOString(), entries: [], bodyBytes: 0, truncated: false };
    return { recording: true };
  }

  harStop(): unknown {
    if (!this.har) throw new Error('HAR は記録中ではありません。kb net har start で開始してください。');
    const truncated = this.har.truncated;
    const log: Record<string, unknown> = {
      version: '1.2',
      creator: { name: 'kb-browser', version: KB_VERSION },
      pages: [],
      entries: this.har.entries,
    };
    // 上限で打ち切った場合は HAR が不完全であることを log.comment で明示する(HAR 標準の任意フィールド)。
    if (truncated) {
      log.comment = `kb: 上限(${HAR_MAX_ENTRIES} entries / ${Math.round(HAR_MAX_BODY_BYTES / (1024 * 1024))}MB)に達したため以降の記録を停止しました。この HAR は不完全です。`;
    }
    this.har = null;
    return { log };
  }

  harStatus(): { recording: boolean; entries: number; truncated: boolean } {
    return { recording: this.har != null, entries: this.har?.entries.length ?? 0, truncated: this.har?.truncated ?? false };
  }

  private async captureHarEntry(res: Response): Promise<void> {
    // 既に上限到達で打ち切っているなら何もしない(黙って欠けさせず、truncated で明示済み)。
    if (!this.har || this.har.truncated) return;
    if (this.har.entries.length >= HAR_MAX_ENTRIES || this.har.bodyBytes >= HAR_MAX_BODY_BYTES) {
      this.har.truncated = true;
      return;
    }
    try {
      const req = res.request();
      const timing = req.timing();
      const contentType = res.headers()['content-type'] ?? '';
      let text: string | undefined;
      if (TEXT_CONTENT_RE.test(contentType)) {
        const body = await res.body();
        if (body.length <= HAR_BODY_CAP) text = body.toString('utf8');
      }
      // start/stop が非同期の隙間に走っても壊れないよう、await 後に har を再確認する。
      if (!this.har || this.har.truncated) return;
      if (text != null) this.har.bodyBytes += text.length;
      const toNv = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
      this.har.entries.push({
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
}
