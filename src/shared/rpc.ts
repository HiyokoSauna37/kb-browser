import { z } from 'zod';

/**
 * デーモン RPC の単一の情報源: コマンド名 → 引数スキーマ。
 *
 * これまで 1 コマンドの引数形状が (1) CLI の commander 定義、(2) MCP の zod、
 * (3) daemon の dispatch switch の untyped な `args.*` 展開、の 3 箇所に散っていた。
 * ここに引数スキーマを一元化し、
 *   - daemon 側: 受信境界で `rpcSchemas[cmd].parse()` して型付き handler map に渡す
 *   - client 側: `rpc<C>(cmd, args)` の引数を `RpcArgs<C>` で型検査する
 * ことで、dispatch の手書き展開を消し、CLI/MCP の呼び出しミスをコンパイルエラーにする。
 *
 * 注意(既知の地雷): MCP SDK の `server.tool()` は zod ジェネリクスを深く推論して tsc の
 * メモリを食い潰すため、**このスキーマを SDK の tool() に渡してはいけない**(mcp.ts は
 * 従来どおり型消去ラッパと inline zod を使う)。ここでは 1 階層の z.object と、コマンド単位で
 * 遅延評価される `z.infer` だけを使い、巨大なユニオンを事前計算しない。
 *
 * 後方互換: object は非 strict(未知キーは黙って落とす)。新旧クライアントが混在する
 * npm-link 開発で、片方に無いフィールドが来ても弾かないため。デフォルト値はスキーマに
 * 入れず handler / host 側に残し、挙動をバイト単位で保つ。
 */

// ---- 再利用する引数フラグメント ----
const tab = z.number().int().optional();
const paging = { maxChars: z.number().optional(), offset: z.number().optional() };
const target = { selector: z.string().optional(), ref: z.string().optional(), frame: z.string().optional(), tab };
const empty = z.object({});

export const rpcSchemas = {
  // --- デーモン制御 ---
  'daemon.status': empty,
  'daemon.stop': empty,

  // --- プロキシ ---
  'proxy.use': empty,
  'proxy.reload': empty,
  'proxy.status': empty,
  'proxy.test': z.object({ name: z.string().optional() }),

  // --- ページ閲覧・取得 ---
  'open': z.object({
    url: z.string(),
    new: z.boolean().optional(),
    tab,
    waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
  }),
  'tabs.list': empty,
  'tabs.close': z.object({ tab: z.number().int() }),
  'tabs.activate': z.object({ tab: z.number().int() }),
  'screenshot': z.object({
    path: z.string(),
    full: z.boolean().optional(),
    selector: z.string().optional(),
    ref: z.string().optional(),
    frame: z.string().optional(),
    timeoutMs: z.number().optional(),
    tab,
  }),
  'text': z.object({ tab, ...paging }),
  'html': z.object({ tab, ...paging }),
  'snapshot': z.object({ tab, ...paging }),
  'eval': z.object({ expression: z.string(), tab, ...paging }),

  // --- 要素操作 ---
  'click': z.object(target),
  'fill': z.object({ ...target, value: z.string() }),
  'press': z.object({ key: z.string(), tab }),
  'hover': z.object(target),
  'check': z.object({ ...target, checked: z.boolean().optional() }),
  'select': z.object({ ...target, values: z.array(z.string()).optional(), byLabel: z.boolean().optional() }),
  'upload': z.object({ ...target, files: z.array(z.string()).optional() }),
  'scroll': z.object({
    by: z.number().optional(),
    to: z.string().optional(),
    top: z.boolean().optional(),
    bottom: z.boolean().optional(),
    tab,
  }),
  'back': z.object({ tab }),
  'forward': z.object({ tab }),
  'reload': z.object({ tab }),
  'pdf': z.object({ path: z.string(), tab }),

  // --- ダウンロード ---
  'downloads.list': empty,
  'downloads.clear': empty,

  // --- Cookie / ストレージ ---
  'cookies.list': z.object({ domain: z.string().optional() }),
  'cookies.set': z.object({
    cookie: z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string().optional() }),
  }),
  'cookies.rm': z.object({ name: z.string(), domain: z.string().optional() }),
  'cookies.clear': empty,
  'cookies.import': z.object({ cookies: z.array(z.unknown()).optional() }),
  'storage.dump': empty,
  // storageState はブラウザ由来の外部 JSON をそのまま渡すため any(host が防御的に扱う)。
  'storage.restore': z.object({ state: z.any() }),

  // --- ネットワーク監視・改変 ---
  'net.log': z.object({
    tab,
    since: z.number().optional(),
    filter: z.string().optional(),
    limit: z.number().optional(),
    responsesOnly: z.boolean().optional(),
  }),
  'net.body': z.object({ seq: z.number(), ...paging }),
  'net.headers': z.object({ seq: z.number() }),
  'net.clear': empty,
  'net.block': z.object({ pattern: z.string() }),
  'net.mock': z.object({
    pattern: z.string(),
    status: z.number().optional(),
    contentType: z.string().optional(),
    body: z.string().optional(),
  }),
  'net.rules': empty,
  'net.unroute': z.object({ all: z.boolean().optional(), id: z.number().optional() }),
  'net.har.start': empty,
  'net.har.stop': empty,
  'net.har.status': empty,

  // --- コンソール / DOM ---
  'console.log': z.object({ tab, since: z.number().optional(), limit: z.number().optional() }),
  'console.clear': empty,
  'dom.query': z.object({
    selector: z.string(),
    html: z.boolean().optional(),
    attr: z.string().optional(),
    limit: z.number().optional(),
    frame: z.string().optional(),
    tab,
  }),

  // --- HTTP リクエスト ---
  'request': z.object({
    url: z.string(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    data: z.string().optional(),
    timeoutMs: z.number().optional(),
    follow: z.boolean().optional(),
    savePath: z.string().optional(),
    ...paging,
  }),

  // --- 操作ログ ---
  'log.start': z.object({ name: z.string().optional(), shots: z.boolean().optional() }),
  'log.stop': empty,
  'log.status': empty,

  // --- JS ダイアログ ---
  // policy は不正値を host が日本語エラーで弾くため、ここでは enum で先に潰さず string で通す。
  'dialog.info': z.object({ tab }),
  'dialog.respond': z.object({ accept: z.boolean().optional(), text: z.string().optional(), tab }),
  'dialog.policy': z.object({ policy: z.string().optional() }),

  // --- モード / プロファイル / 認証 ---
  'mode.set': z.object({ headless: z.boolean().optional() }),
  'profile.set': z.object({ name: z.string() }),
  'auth.set': z.object({
    credentials: z.object({ username: z.string(), password: z.string() }).nullable().optional(),
  }),

  // --- 待機 / エミュレーション ---
  'wait': z.object({
    url: z.string().optional(),
    selector: z.string().optional(),
    selectorGone: z.string().optional(),
    idle: z.boolean().optional(),
    any: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    tab,
  }),
  'emulate': z.object({
    ua: z.string().optional(),
    viewport: z
      .object({ width: z.number(), height: z.number(), dpr: z.number().optional(), mobile: z.boolean().optional() })
      .optional(),
    timezone: z.string().optional(),
    reset: z.boolean().optional(),
    tab,
  }),
  'emulate.geo': z.object({ latitude: z.number(), longitude: z.number() }),
  'emulate.net': z.object({ preset: z.string(), tab }),
};

export type RpcCommand = keyof typeof rpcSchemas;

/** コマンド C の検証済み引数型(z.infer はコマンド単位で遅延評価する)。 */
export type RpcArgs<C extends RpcCommand> = z.infer<(typeof rpcSchemas)[C]>;

/** 文字列が既知の RPC コマンドか(dispatch の入口ガード)。 */
export function isRpcCommand(cmd: string): cmd is RpcCommand {
  return Object.prototype.hasOwnProperty.call(rpcSchemas, cmd);
}

// ---- コマンドのカテゴリ(名前の隣に置いて typo をコンパイルエラーにする) ----

/** 操作ジャーナルに記録しない読み取り系・ログ操作系コマンド(daemon が dispatch をラップする際に除外)。 */
export const JOURNAL_EXCLUDE: ReadonlySet<RpcCommand> = new Set<RpcCommand>([
  'daemon.status', 'daemon.stop',
  'tabs.list', 'downloads.list', 'cookies.list', 'storage.dump',
  'net.log', 'net.body', 'net.headers', 'net.rules', 'net.har.status',
  'console.log', 'proxy.status', 'proxy.test',
  'log.start', 'log.stop', 'log.status',
  'dialog.info',
]);

/** 自動スクリーンショット(kb log start --shots)の対象になる操作コマンド。 */
export const AUTO_SHOT_CMDS: ReadonlySet<RpcCommand> = new Set<RpcCommand>([
  'open', 'click', 'fill', 'press', 'hover', 'check', 'select', 'upload', 'scroll',
  'back', 'forward', 'reload', 'dialog.respond',
]);
