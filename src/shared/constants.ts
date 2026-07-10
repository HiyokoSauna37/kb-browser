/** 層をまたいで共有する調整定数(CLI / MCP / daemon)。デーモン内専用の定数は各モジュールに置く。 */

/** リングバッファ(net / console ログ)の上限。超えた分は古いものから捨てる。 */
export const LOG_CAP = 3000;

/** text / html / snapshot などのデフォルト出力上限(コンテキスト溢れ防止)。--max-chars 0 で無制限。 */
export const TEXT_CAP = 20_000;

/** 本文を捕捉・表示するテキスト系 Content-Type。 */
export const TEXT_CONTENT_RE = /text|json|javascript|xml|html|css|svg|form-urlencoded/;

/** kb wait のデフォルトタイムアウト秒(CLI / MCP 共通)。 */
export const WAIT_DEFAULT_SEC = 90;

/** kb wait / login のタイムアウト上限秒(呼び出し側シェルの既定タイムアウトより短く保つ)。 */
export const WAIT_MAX_SEC = 280;

/** kb request のデフォルトタイムアウト秒(CLI / MCP / host 共通)。 */
export const REQUEST_TIMEOUT_SEC = 30;

/** kb net log のデフォルト表示件数(CLI / MCP 共通)。 */
export const NET_LOG_DEFAULT_LIMIT = 50;

/** kb console のデフォルト表示件数(CLI / MCP 共通)。 */
export const CONSOLE_DEFAULT_LIMIT = 50;
