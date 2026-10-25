import fs from 'node:fs';
import type { APIResponse, BrowserContext, Page } from 'playwright';
import { REQUEST_TIMEOUT_SEC, TEXT_CAP, TEXT_CONTENT_RE } from '../../shared/constants';
import { clip, inferJsonContentType, normalizeUrl } from '../../shared/util';

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string;
  timeoutMs?: number;
  follow?: boolean;
  /** --follow-verbose: リダイレクトを 1 ホップずつ追い、各ホップの status/Location/Set-Cookie を記録する。 */
  verbose?: boolean;
  savePath?: string;
  maxChars?: number;
  offset?: number;
}

/** リダイレクトチェーンの 1 ホップ(--follow-verbose 時のみ収集)。 */
export interface RedirectHop {
  status: number;
  statusText: string;
  /** このホップを発行した URL。 */
  url: string;
  /** Location ヘッダ(次の遷移先)。 */
  location?: string;
  /** このホップで付与された Set-Cookie(個別行)。 */
  setCookies?: string[];
}

export interface HttpResult {
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
  setCookies?: string[];
  /** --follow-verbose 時の中間リダイレクトホップ(最終レスポンスは含まない)。 */
  hops?: RedirectHop[];
}

/**
 * 送受信 1 往復の生の記録。kb request はページイベントに乗らないため、
 * これを NetMonitor に渡して通信ログ(= kb net log / kb net export の HAR)に載せる。
 * requestHeaders は「こちらが渡したヘッダ」で、APIRequestContext が自動付与する
 * Cookie / User-Agent 等は含まれない(取得手段がない)。
 */
export interface RecordedExchange {
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  responseHeaders: Record<string, string>;
  body?: Buffer;
  ms?: number;
}

export type ExchangeRecorder = (ex: RecordedExchange) => void;

/** 記録に必要な「送った側」の情報(レスポンスからは取れないため呼び出し側から引き回す)。 */
interface RecordContext {
  onRecord?: ExchangeRecorder;
  method: string;
  headers?: Record<string, string>;
  data?: string;
}

interface BufferedResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  ms: number;
  setCookies?: string[];
  hops?: RedirectHop[];
}

/** ブラウザ既定と同じ上限。ここに達したら最後のレスポンスをそのまま返す(追従を打ち切る)。 */
const MAX_REDIRECTS = 20;

/**
 * res.headers() は複数値ヘッダ(Set-Cookie)を畳んで parse 不能にするため、
 * headersArray() から改行区切りで組み直す(CDP / allHeaders と同じ表現)。
 */
function headersRecord(res: APIResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of res.headersArray()) {
    const key = name.toLowerCase();
    out[key] = out[key] === undefined ? value : `${out[key]}\n${value}`;
  }
  return out;
}

/** res.headers() は複数 Set-Cookie を 1 つに畳むため、headersArray() から個別に取り出す。 */
function extractSetCookies(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
}

/**
 * リダイレクト後のメソッド(ブラウザ準拠)。303 は必ず GET、301/302 は非 GET/HEAD を GET 化(ボディを落とす)、
 * 307/308 はメソッドとボディを維持。純関数なのでユニットテスト可能。
 */
export function methodAfterRedirect(status: number, method: string): { method: string; dropBody: boolean } {
  const m = method.toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && m !== 'GET' && m !== 'HEAD')) {
    return { method: 'GET', dropBody: true };
  }
  return { method: m, dropBody: false };
}

/** POST→GET 化のときに意味を失う body 系ヘッダ(content-type/length)を落とす。 */
function stripBodyHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^content-(type|length)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Buffer 化済みレスポンスから共通の HttpResult を組み立てる。 */
function buildBufferedResult(response: BufferedResponse, opts: HttpRequestOptions): HttpResult {
  const { body: buf, headers } = response;
  const contentType = headers['content-type'] ?? '';
  const base = {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    contentType,
    ms: response.ms,
    bytes: buf.length,
    // 空配列のときは結果要約に載せない(ヘッダ系レスポンスのノイズを抑える)
    ...(response.setCookies?.length ? { setCookies: response.setCookies } : {}),
    ...(response.hops?.length ? { hops: response.hops } : {}),
  };
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

/** APIResponse から HttpResult を組み立てる(本文の保存 / バイナリ判定 / 切り詰めを含む)。 */
async function buildResult(
  res: APIResponse,
  ms: number,
  opts: HttpRequestOptions,
  hops?: RedirectHop[],
  rec?: RecordContext,
): Promise<HttpResult> {
  const buf = await res.body().catch(() => Buffer.alloc(0)); // 204 等の空レスポンス
  const headers = res.headers();
  const setCookies = extractSetCookies(res);
  rec?.onRecord?.({
    method: rec.method,
    url: res.url(),
    status: res.status(),
    statusText: res.statusText(),
    requestHeaders: rec.headers,
    postData: rec.data,
    responseHeaders: headersRecord(res),
    body: buf,
    ms,
  });
  const result = buildBufferedResult(
    {
      status: res.status(),
      statusText: res.statusText(),
      url: res.url(),
      headers,
      body: buf,
      ms,
      setCookies,
      hops,
    },
    opts,
  );
  res.dispose().catch(() => {});
  return result;
}

/**
 * リダイレクトを 1 ホップずつ手動で追い、各ホップの status/Location/Set-Cookie を集める。
 * context.request は Cookie jar をブラウザと共有するため、途中で付与された Cookie は次ホップに
 * 自動反映される(= リダイレクト途中で Cookie を撒くフローの分析に使える)。
 * メソッド/ボディの引き継ぎはブラウザ準拠: 303 は必ず GET、301/302 は POST を GET 化、307/308 は維持。
 */
async function followVerbose(
  context: BrowserContext,
  opts: HttpRequestOptions,
  headersToSend: Record<string, string> | undefined,
  timeout: number,
  started: number,
  onRecord?: ExchangeRecorder,
): Promise<HttpResult> {
  const hops: RedirectHop[] = [];
  let url = normalizeUrl(opts.url);
  let method = (opts.method ?? 'GET').toUpperCase();
  let data = opts.data;
  let headers = headersToSend;

  for (let i = 0; ; i++) {
    const res = await context.request.fetch(url, {
      method,
      headers,
      data,
      timeout,
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const status = res.status();
    const location = res.headers()['location'];
    const setCookies = extractSetCookies(res);

    // 3xx + Location かつ上限未満なら 1 ホップとして記録し次へ。それ以外は最終レスポンスとして返す。
    if (status >= 300 && status < 400 && location && i < MAX_REDIRECTS) {
      hops.push({ status, statusText: res.statusText(), url, location, ...(setCookies.length ? { setCookies } : {}) });
      const next = new URL(location, url).toString(); // 相対 Location を現在 URL 基準で解決
      // 中間ホップも通信ログに載せる(リダイレクト途中で撒かれた Cookie の証跡が HAR に残る)
      onRecord?.({
        method,
        url,
        status,
        statusText: res.statusText(),
        requestHeaders: headers,
        postData: data,
        responseHeaders: headersRecord(res),
      });
      res.dispose().catch(() => {});
      const after = methodAfterRedirect(status, method);
      method = after.method;
      if (after.dropBody) {
        data = undefined;
        headers = stripBodyHeaders(headers);
      }
      url = next;
      continue;
    }
    return await buildResult(res, Date.now() - started, opts, hops, { onRecord, method, headers, data });
  }
}

/**
 * ブラウザの context.request で HTTP リクエストを送る(ページ非依存のミニ REST クライアント)。
 * Cookie はブラウザと共有され(Set-Cookie も反映される)、プロキシ設定も同じものを使う。
 */
export async function httpRequest(
  context: BrowserContext,
  opts: HttpRequestOptions,
  onRecord?: ExchangeRecorder,
): Promise<HttpResult> {
  const started = Date.now();
  // JSON に見えるボディで Content-Type 未指定なら application/json を補う(明示ヘッダ優先)
  const inferred = inferJsonContentType(opts.data, opts.headers);
  const headersToSend = inferred ? { ...(opts.headers ?? {}), 'content-type': inferred } : opts.headers;
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_SEC * 1000;

  // --follow-verbose はリダイレクトを追う設定のときだけ意味を持つ(--no-follow とは併用しない)。
  if (opts.verbose && opts.follow !== false) {
    return followVerbose(context, opts, headersToSend, timeout, started, onRecord);
  }

  const method = (opts.method ?? 'GET').toUpperCase();
  const res = await context.request.fetch(normalizeUrl(opts.url), {
    method,
    headers: headersToSend,
    data: opts.data,
    timeout,
    maxRedirects: opts.follow === false ? 0 : undefined,
    failOnStatusCode: false,
  });
  return buildResult(res, Date.now() - started, opts, undefined, {
    onRecord,
    method,
    headers: headersToSend,
    data: opts.data,
  });
}

/**
 * Verify 済みページと同じ Chromium の fetch 経路で HTTP リクエストを送る。
 * Cookie / TLS / User-Agent / Origin をページと揃えるための明示モードであり、CORS を迂回する機能ではない。
 * 応答ヘッダの Set-Cookie は Fetch API から読めないが、ブラウザの cookie jar には通常どおり反映される。
 */
export async function browserHttpRequest(
  page: Page,
  opts: HttpRequestOptions,
  onRecord?: ExchangeRecorder,
): Promise<HttpResult> {
  if (opts.follow === false || opts.verbose) {
    throw new Error('--via-browser は --no-follow / --follow-verbose と併用できません(ブラウザ fetch は redirect chain のヘッダを公開しません)');
  }

  const url = normalizeUrl(opts.url);
  let pageOrigin: string;
  let targetOrigin: string;
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    throw new Error('--via-browser を使うには、先に対象 origin のページを kb open で開いてください');
  }
  try {
    targetOrigin = new URL(url).origin;
  } catch {
    throw new Error(`URL として解釈できません: ${opts.url}`);
  }
  if (pageOrigin === 'null' || pageOrigin !== targetOrigin) {
    throw new Error(
      `--via-browser は active tab と同一 origin の URL に限定されます (tab=${pageOrigin}, request=${targetOrigin})。` +
        `先に kb open ${targetOrigin} を実行するか、通常の kb request を使ってください`,
    );
  }

  const method = (opts.method ?? 'GET').toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && opts.data !== undefined) {
    throw new Error(`--via-browser の ${method} には request body を指定できません`);
  }

  // Fetch が上書き禁止にしている browser-managed header は黙って欠落させず、先に説明可能な形で拒否する。
  const forbidden = Object.keys(opts.headers ?? {}).filter((name) =>
    /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|proxy-.*|referer|sec-.*|te|trailer|transfer-encoding|upgrade|user-agent|via)$/i.test(
      name,
    ),
  );
  if (forbidden.length) {
    throw new Error(
      `--via-browser ではブラウザ管理ヘッダを指定できません: ${forbidden.join(', ')}。` +
        'Cookie / User-Agent / Origin は Verify 済みタブの値を自動で使用します',
    );
  }

  const inferred = inferJsonContentType(opts.data, opts.headers);
  const headersToSend = inferred ? { ...(opts.headers ?? {}), 'content-type': inferred } : opts.headers;
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_SEC * 1000;
  const started = Date.now();
  const raw = await page.evaluate(
    async ({ target, requestMethod, headers, data, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(target, {
          method: requestMethod,
          headers,
          body: data,
          credentials: 'include',
          redirect: 'follow',
          signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          responseHeaders[name.toLowerCase()] = value;
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        // apply/spread は大きなレスポンスで call stack を超えるため、小さい chunk ごとに base64 化する。
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: responseHeaders,
          bodyBase64: btoa(binary),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(controller.signal.aborted ? `browser fetch timeout (${timeoutMs}ms)` : `browser fetch failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
    {
      target: url,
      requestMethod: method,
      headers: headersToSend,
      data: opts.data,
      timeoutMs: timeout,
    },
  );
  const ms = Date.now() - started;
  const body = Buffer.from(raw.bodyBase64, 'base64');
  // Fetch API は Set-Cookie を公開しない契約だが、ページ側の monkey patch 等があっても
  // Cookie 値を CLI / journal へ流さないよう Node 側でも防御する。
  delete raw.headers['set-cookie'];
  delete raw.headers['set-cookie2'];
  onRecord?.({
    method,
    url: raw.url,
    status: raw.status,
    statusText: raw.statusText,
    requestHeaders: headersToSend,
    postData: opts.data,
    responseHeaders: raw.headers,
    body,
    ms,
  });
  return buildBufferedResult(
    {
      status: raw.status,
      statusText: raw.statusText,
      url: raw.url,
      headers: raw.headers,
      body,
      ms,
    },
    opts,
  );
}
