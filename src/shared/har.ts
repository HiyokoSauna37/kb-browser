/**
 * HAR 1.2 の組み立て(純関数)。
 *
 * ライブ記録(NetMonitor の captureHarEntry)とは別物で、こちらは **既に捕捉済みの**
 * ログ・ヘッダ・本文から遡及的に HAR を合成する `kb net export --format har` 用。
 * 「捕捉済みのものから作る」性質上いくつか欠けるフィールドがあるので、
 * 欠落は log.comment とエントリの `_kb*` 拡張フィールドで明示する
 * (HAR の慣習として、標準外フィールドは `_` 始まりの名前で足してよい)。
 */

/** 捕捉済みレスポンス本文。 */
export interface HarBody {
  text: string;
  /** 切り詰め前の実バイト数。 */
  fullBytes: number;
  contentType: string;
  /** 捕捉時に上限で切り詰めたか。 */
  truncated: boolean;
}

/** HAR 1 エントリ分の入力(NetMonitor のリングバッファ + メタ + 本文ストアから組む)。 */
export interface HarSourceEntry {
  seq: number;
  ts: string;
  tab: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  /** requestfailed の理由(net::ERR_… など)。 */
  failure?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  body?: HarBody;
  /** ms 単位。捕捉時に取れなかった場合は undefined。 */
  timings?: { wait: number; receive: number };
}

/** HTTP/2 は擬似ヘッダ(:method / :path / :authority)の有無で判別できる。 */
export function inferHttpVersion(headers?: Record<string, string>): string {
  if (!headers) return 'unknown';
  return Object.keys(headers).some((k) => k.startsWith(':')) ? 'HTTP/2' : 'HTTP/1.1';
}

function toNameValue(headers?: Record<string, string>): { name: string; value: string }[] {
  if (!headers) return [];
  // allHeaders() は複数値ヘッダ(Set-Cookie 等)を改行で畳むため、個別行に戻す
  return Object.entries(headers).flatMap(([name, value]) =>
    value.split('\n').map((v) => ({ name, value: v })),
  );
}

/** URL のクエリを HAR の queryString 配列にする(壊れた URL では空配列)。 */
export function parseQueryString(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** リクエストの Cookie ヘッダを HAR の cookies 配列にする。 */
export function parseRequestCookies(cookieHeader?: string): { name: string; value: string }[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0 ? { name: pair, value: '' } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
}

/** Set-Cookie ヘッダ(改行で複数畳まれている場合あり)を HAR の cookies 配列にする。 */
export function parseSetCookies(setCookieHeader?: string): Record<string, unknown>[] {
  if (!setCookieHeader) return [];
  return setCookieHeader
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nv, ...attrs] = line.split(';');
      const eq = nv.indexOf('=');
      const cookie: Record<string, unknown> = {
        name: eq < 0 ? nv.trim() : nv.slice(0, eq).trim(),
        value: eq < 0 ? '' : nv.slice(eq + 1).trim(),
      };
      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split('=');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join('=').trim();
        if (key === 'path') cookie.path = value;
        else if (key === 'domain') cookie.domain = value;
        else if (key === 'expires') cookie.expires = value;
        else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'secure') cookie.secure = true;
      }
      return cookie;
    });
}

/** 捕捉済みの 1 リクエストを HAR エントリにする。 */
export function buildHarEntry(src: HarSourceEntry): Record<string, unknown> {
  const reqContentType = src.requestHeaders?.['content-type'] ?? '';
  const resContentType = src.body?.contentType ?? src.responseHeaders?.['content-type'] ?? '';
  const wait = Math.max(src.timings?.wait ?? 0, 0);
  const receive = Math.max(src.timings?.receive ?? 0, 0);
  const reqVersion = inferHttpVersion(src.requestHeaders);
  // レスポンス側は :status 擬似ヘッダが残らないことがあるので、HTTP/2 判定はリクエスト側にも従う
  const resVersion = reqVersion === 'HTTP/2' ? 'HTTP/2' : inferHttpVersion(src.responseHeaders);
  return {
    startedDateTime: src.ts,
    time: wait + receive,
    request: {
      method: src.method,
      url: src.url,
      httpVersion: reqVersion,
      headers: toNameValue(src.requestHeaders),
      queryString: parseQueryString(src.url),
      cookies: parseRequestCookies(src.requestHeaders?.['cookie']),
      headersSize: -1,
      bodySize: src.postData != null ? Buffer.byteLength(src.postData) : -1,
      ...(src.postData != null ? { postData: { mimeType: reqContentType, text: src.postData } } : {}),
    },
    response: {
      status: src.status ?? 0,
      statusText: src.statusText ?? (src.failure ? 'Failed' : ''),
      httpVersion: resVersion,
      headers: toNameValue(src.responseHeaders),
      cookies: parseSetCookies(src.responseHeaders?.['set-cookie']),
      redirectURL: src.responseHeaders?.['location'] ?? '',
      content: {
        size: src.body?.fullBytes ?? -1,
        mimeType: resContentType,
        ...(src.body ? { text: src.body.text } : {}),
        ...(src.body?.truncated
          ? { comment: `kb: 本文は捕捉時に切り詰められています(全 ${src.body.fullBytes} bytes)。全文は kb request <url> -o <file> で取り直せます。` }
          : {}),
      },
      headersSize: -1,
      bodySize: src.body?.fullBytes ?? -1,
    },
    cache: {},
    timings: { send: 0, wait, receive },
    // kb 固有の相互参照用フィールド(HAR の標準外フィールドは "_" 始まりで足す慣習)
    _kbSeq: src.seq,
    _kbTab: src.tab,
    _kbResourceType: src.resourceType,
    ...(src.failure ? { _kbFailure: src.failure } : {}),
    ...(src.timings ? {} : { _kbTimingsUnavailable: true }),
  };
}

/** エントリ群を HAR ファイルの形にまとめる。 */
export function buildHar(
  entries: HarSourceEntry[],
  opts: { creatorVersion: string; comment?: string },
): { log: Record<string, unknown> } {
  const log: Record<string, unknown> = {
    version: '1.2',
    creator: { name: 'kb-browser', version: opts.creatorVersion },
    pages: [],
    entries: entries.map(buildHarEntry),
  };
  if (opts.comment) log.comment = opts.comment;
  return { log };
}
