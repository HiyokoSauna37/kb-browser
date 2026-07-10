import fs from 'node:fs';
import type { BrowserContext } from 'playwright';
import { REQUEST_TIMEOUT_SEC, TEXT_CAP, TEXT_CONTENT_RE } from '../../shared/constants';
import { clip, inferJsonContentType, normalizeUrl } from '../../shared/util';

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string;
  timeoutMs?: number;
  follow?: boolean;
  savePath?: string;
  maxChars?: number;
  offset?: number;
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
  const res = await context.request.fetch(normalizeUrl(opts.url), {
    method: (opts.method ?? 'GET').toUpperCase(),
    headers: headersToSend,
    data: opts.data,
    timeout: opts.timeoutMs ?? REQUEST_TIMEOUT_SEC * 1000,
    maxRedirects: opts.follow === false ? 0 : undefined,
    failOnStatusCode: false,
  });
  const ms = Date.now() - started;
  const buf = await res.body().catch(() => Buffer.alloc(0)); // 204 等の空レスポンス
  const headers = res.headers();
  // res.headers() は複数の Set-Cookie を 1 つに畳んでしまい個々の cookie を parse できない。
  // headersArray() は各 Set-Cookie を別エントリで保持するので、そこから個別に取り出す。
  const setCookies = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
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
