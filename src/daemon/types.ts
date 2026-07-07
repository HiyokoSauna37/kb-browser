/** デーモン内で共有する型定義と調整用定数。 */

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
  /**
   * ステルスモード。`--disable-blink-features=AutomationControlled` を付けて
   * navigator.webdriver を実 Chrome 同様に消し、最小限の init script で JS レベルの
   * 綻びを均す。自前起動時のみ有効(アタッチは元から実ブラウザなので不要)。
   */
  stealth?: boolean;
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

/** リングバッファ(net / console ログ)の上限。超えた分は古いものから捨てる。 */
export const LOG_CAP = 3000;

/** text / html / snapshot などのデフォルト出力上限(コンテキスト溢れ防止)。--max-chars 0 で無制限。 */
export const TEXT_CAP = 20_000;

/** 本文を捕捉・表示するテキスト系 Content-Type。 */
export const TEXT_CONTENT_RE = /text|json|javascript|xml|html|css|svg|form-urlencoded/;
