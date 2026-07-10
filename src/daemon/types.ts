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
   * HTTPS 証明書エラーを無視する (context の ignoreHTTPSErrors)。自己署名証明書のローカル環境や、
   * CA を信頼させていない MITM デバッグプロキシ(Charles / Fiddler 等)の escape hatch。
   * 自前起動時のみ有効(アタッチ先の context 生成条件は変更できない)。
   */
  ignoreHttpsErrors?: boolean;
  /**
   * OS ストアを触らずに信頼する CA の SPKI ハッシュ(SHA-256/DER の base64)一覧。
   * Chromium の --ignore-certificate-errors-spki-list に渡され、**該当証明書だけ**の
   * 証明書エラーを許可する(ignoreHTTPSErrors のような全無検証ではない)。
   * proxies.json の各プロファイルの caSpki から起動時に収集する。
   */
  ignoreCertErrorsSpkiList?: string[];
  /**
   * ステルスモード。`--disable-blink-features=AutomationControlled` を付けて
   * navigator.webdriver を実 Chrome 同様に消し、最小限の init script で JS レベルの
   * 綻びを均す。自前起動時のみ有効(アタッチは元から実ブラウザなので不要)。
   */
  stealth?: boolean;
  /**
   * Chrome 拡張機能。指定時は Playwright 既定の --disable-extensions を外して
   * プロファイルにインストール済みの拡張を有効化し、配列の各ディレクトリ(解凍済み拡張)を
   * --load-extension でロードする。空配列 = 有効化のみ(ストア等から入れた拡張を使う)。
   * 自前起動時のみ有効。
   */
  extensions?: string[];
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
  /** 操作で JS ダイアログが開いて応答待ちになった場合に入る。kb dialog accept / dismiss で応答する。 */
  dialog?: DialogInfo;
}

/** 応答待ち(または応答済み)の JS ダイアログ (alert / confirm / prompt / beforeunload)。 */
export interface DialogInfo {
  tab: number;
  type: string;
  message: string;
  /** prompt のデフォルト入力値。 */
  defaultValue?: string;
  ts: string;
}

/**
 * JS ダイアログへの応答ポリシー。
 * - hold: 保留して応答を待つ(headed ならネイティブダイアログが表示され、ウィンドウ上でも応答できる)
 * - accept / dismiss: 表示せず即座に自動応答する(dismiss が従来の Playwright 既定挙動)
 */
export type DialogPolicy = 'hold' | 'accept' | 'dismiss';

// 調整定数は CLI / MCP とも共有するため shared/constants.ts へ移動した。
// デーモン内の既存 import 先として従来どおりここからも参照できるようにする。
export { LOG_CAP, TEXT_CAP, TEXT_CONTENT_RE } from '../shared/constants';
