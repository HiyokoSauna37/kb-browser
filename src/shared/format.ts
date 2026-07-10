/** CLI / MCP 共通の表示整形ヘルパ(純関数)。文言そのものは各層で維持し、計算だけを共有する。 */

/** ISO タイムスタンプから HH:MM:SS を取り出す。 */
export function hhmmss(ts: string): string {
  return ts.slice(11, 19);
}

export interface TruncatedResult {
  totalChars: number;
  offset: number;
  truncated: boolean;
}

/** 切り詰め注記の表示範囲(from〜next/total)を計算する。注記の文言は CLI / MCP 各層が持つ。 */
export function truncSpan(r: TruncatedResult, shownChars: number): { from: number; next: number; total: number } {
  return { from: r.offset + 1, next: r.offset + shownChars, total: r.totalChars };
}

/**
 * レスポンスの Set-Cookie を個別行で出す。res.headers() は複数の Set-Cookie を 1 行に
 * 畳んでしまい parse できないため、headersArray() 由来の setCookies を使う(v0.10.1)。
 */
export function setCookieLines(setCookies: string[]): string {
  return setCookies.map((c) => `\nset-cookie: ${c}`).join('');
}

/** 全レスポンスヘッダ + 個別 Set-Cookie 行のブロック(kb request -i / MCP includeHeaders 共通)。 */
export function headersWithSetCookie(headers: Record<string, string> | undefined, setCookies: string[]): string {
  const other = Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== 'set-cookie');
  return '\n' + other.map(([k, v]) => `${k}: ${v}`).join('\n') + setCookieLines(setCookies);
}
