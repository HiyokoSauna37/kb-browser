import fs from 'node:fs';
import type { APIResponse, BrowserContext } from 'playwright';
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

/** ブラウザ既定と同じ上限。ここに達したら最後のレスポンスをそのまま返す(追従を打ち切る)。 */
const MAX_REDIRECTS = 20;

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

/** APIResponse から HttpResult を組み立てる(本文の保存 / バイナリ判定 / 切り詰めを含む)。 */
async function buildResult(res: APIResponse, ms: number, opts: HttpRequestOptions, hops?: RedirectHop[]): Promise<HttpResult> {
  const buf = await res.body().catch(() => Buffer.alloc(0)); // 204 等の空レスポンス
  const headers = res.headers();
  const setCookies = extractSetCookies(res);
  const contentType = headers['content-type'] ?? '';
  const base = {
    status: res.status(),
    statusText: res.statusText(),
    url: res.url(),
    headers,
    contentType,
    ms,
    bytes: buf.length,
    // 空配列のときは結果要約に載せない(ヘッダ系レスポンスのノイズを抑える)
    ...(setCookies.length ? { setCookies } : {}),
    ...(hops && hops.length ? { hops } : {}),
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
    return await buildResult(res, Date.now() - started, opts, hops);
  }
}

/**
 * ブラウザの context.request で HTTP リクエストを送る(ページ非依存のミニ REST クライアント)。
 * Cookie はブラウザと共有され(Set-Cookie も反映される)、プロキシ設定も同じものを使う。
 */
export async function httpRequest(context: BrowserContext, opts: HttpRequestOptions): Promise<HttpResult> {
  const started = Date.now();
  // JSON に見えるボディで Content-Type 未指定なら application/json を補う(明示ヘッダ優先)
  const inferred = inferJsonContentType(opts.data, opts.headers);
  const headersToSend = inferred ? { ...(opts.headers ?? {}), 'content-type': inferred } : opts.headers;
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_SEC * 1000;

  // --follow-verbose はリダイレクトを追う設定のときだけ意味を持つ(--no-follow とは併用しない)。
  if (opts.verbose && opts.follow !== false) {
    return followVerbose(context, opts, headersToSend, timeout, started);
  }

  const res = await context.request.fetch(normalizeUrl(opts.url), {
    method: (opts.method ?? 'GET').toUpperCase(),
    headers: headersToSend,
    data: opts.data,
    timeout,
    maxRedirects: opts.follow === false ? 0 : undefined,
    failOnStatusCode: false,
  });
  return buildResult(res, Date.now() - started, opts);
}
