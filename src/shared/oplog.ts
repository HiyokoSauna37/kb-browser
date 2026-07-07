import { inferJsonContentType } from './util';

/**
 * 操作ログ(kb log)の共有ロジック。すべて純関数。
 * - イベント型(JSONL の 1 行 = 1 イベント)
 * - マスキング(既定 deny 寄り。export / show 時に適用し、生ジャーナルは無改変)
 * - レポート(report.md)/ 再現手順(steps)/ 単体再実行コマンド(curl)の生成
 */

export interface OpEventBase {
  seq: number;
  ts: string;
  type: 'command' | 'net' | 'console';
}

/** kb コマンド(RPC)1 回分。 */
export interface CommandEvent extends OpEventBase {
  type: 'command';
  cmd: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  /** 結果の JSON 要約(500 文字で切り詰め)。 */
  result?: string;
  error?: string;
  /** --shots 有効時の操作直後スクリーンショット(セッションフォルダ相対パス)。 */
  shot?: string;
}

/** 発生した通信(xhr / fetch / document / other のみ)。 */
export interface NetEvent extends OpEventBase {
  type: 'net';
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  tab: number;
  requestHeaders?: Record<string, string>;
  postData?: string;
  contentType?: string;
}

export interface ConsoleEvent extends OpEventBase {
  type: 'console';
  kind: string;
  text: string;
  tab: number;
}

export type OpEvent = CommandEvent | NetEvent | ConsoleEvent;

export interface SessionMeta {
  name: string;
  startedAt: string;
  endedAt?: string;
  profile?: string;
  headless?: boolean;
  channel?: string;
  attach?: string;
  kbVersion?: string;
}

// ---- マスキング ----

export const MASK = '«masked»';

export interface MaskOptions {
  /** 既定 true。false(--no-mask)でも deny 指定は常に適用される。 */
  mask: boolean;
  /** この正規表現に一致する名前(ヘッダ名 / フィールド名)はマスクしない。 */
  allow?: RegExp;
  /** この正規表現に一致する名前・値は追加でマスクする(全文字列が対象)。 */
  deny?: RegExp;
}

/** 既定でマスクするヘッダ名。 */
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth[\w-]*|x-csrf[\w-]*|x-xsrf[\w-]*)$/i;
/** ボディ内で値をマスクするキー名。 */
const SENSITIVE_KEY_RE = /pass(word)?|token|secret|otp|api[-_]?key|credential|session|auth/i;

/** 名前付きの値をマスク方針に従って処理する。allow > deny > 既定マスクの順で判定。 */
function maskValue(name: string, value: string, o: MaskOptions): string {
  if (o.allow?.test(name)) return value;
  if (o.deny && (o.deny.test(name) || o.deny.test(value))) return MASK;
  return o.mask ? MASK : value;
}

/**
 * URL のクエリ値のうち機微キー(password / token 等)のものをマスクする。
 * クエリ値自体が URL の場合(リダイレクト先の ?next=https%3A%2F%2F… など)は
 * 内側のクエリにも再帰適用する。
 * 既知の限界: キー名のないパスセグメント(/verify/<値> 等)は検出できない。
 */
export function maskUrl(url: string, o: MaskOptions, depth = 0): string {
  if ((!o.mask && !o.deny) || depth > 4) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (o.allow?.test(k)) continue;
      const sensitive = (o.mask && SENSITIVE_KEY_RE.test(k)) || o.deny?.test(k) || o.deny?.test(v);
      if (sensitive && v !== MASK) {
        u.searchParams.set(k, MASK);
        changed = true;
      } else if (/^https?:\/\//i.test(v)) {
        // 入れ子 URL(percent-encode されていても searchParams がデコード済みの値をくれる)
        const inner = maskUrl(v, o, depth + 1);
        if (inner !== v) {
          u.searchParams.set(k, inner);
          changed = true;
        }
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** テキスト中に現れる URL のクエリ値をマスクする(Location / Referer ヘッダや本文中の URL 用)。 */
export function maskUrlsInText(text: string, o: MaskOptions): string {
  if (!o.mask && !o.deny) return text;
  return text.replace(/https?:\/\/[^\s"'<>\\)\]}]+/g, (m) => maskUrl(m, o));
}

/** ヘッダのマスク: 既定は機微なヘッダのみ。deny は全ヘッダの名前・値に適用。URL を運ぶヘッダはクエリ値もマスク。 */
function redactHeaders(headers: Record<string, string>, o: MaskOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(name)) out[name] = maskValue(name, value, o);
    else if (o.deny && (o.deny.test(name) || o.deny.test(value))) out[name] = MASK;
    else if (/^(location|referer|refresh)$/i.test(name)) out[name] = maskUrlsInText(value, o);
    else out[name] = value;
  }
  return out;
}

/**
 * リクエストボディのマスク。JSON なら機微キーの値だけを、
 * form-urlencoded なら機微キーのペアだけをマスクし、再現性を保つ。
 */
export function maskBody(data: string, o: MaskOptions): string {
  if (!o.mask && !o.deny) return data;
  try {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) {
          out[k] =
            typeof val === 'string' && SENSITIVE_KEY_RE.test(k) ? maskValue(k, val, o)
            : typeof val === 'string' && o.deny?.test(val) ? MASK
            : walk(val);
        }
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(JSON.parse(data)));
  } catch {
    /* JSON でない */
  }
  if (/^[^=\s&]+=[^&]*(&[^=\s&]+=[^&]*)*$/.test(data.trim())) {
    return data
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const k = pair.slice(0, eq);
        const v = pair.slice(eq + 1);
        return SENSITIVE_KEY_RE.test(k) || o.deny?.test(v) ? `${k}=${maskValue(k, v, o)}` : pair;
      })
      .join('&');
  }
  return o.deny?.test(data) ? MASK : data;
}

/** イベント 1 件にマスクを適用する(元オブジェクトは変更しない)。 */
export function redactEvent(event: OpEvent, o: MaskOptions): OpEvent {
  const e = JSON.parse(JSON.stringify(event)) as OpEvent;
  if (e.type === 'net') {
    e.url = maskUrl(e.url, o);
    if (e.requestHeaders) e.requestHeaders = redactHeaders(e.requestHeaders, o);
    if (e.postData != null) e.postData = maskUrlsInText(maskBody(e.postData, o), o);
    return e;
  }
  if (e.type === 'console') {
    if (o.deny?.test(e.text)) e.text = MASK;
    else e.text = maskUrlsInText(e.text, o);
    return e;
  }
  const args = e.args as Record<string, any>;
  switch (e.cmd) {
    case 'fill':
      if (typeof args.value === 'string') args.value = maskValue('fill.value', args.value, o);
      break;
    case 'auth.set':
      if (args.credentials) {
        args.credentials = {
          username: maskValue('username', String(args.credentials.username ?? ''), o),
          password: maskValue('password', String(args.credentials.password ?? ''), o),
        };
      }
      break;
    case 'cookies.set':
      if (args.cookie?.value != null) args.cookie.value = maskValue('cookie.value', String(args.cookie.value), o);
      break;
    case 'eval':
      if (e.result != null) e.result = maskValue('eval.result', e.result, o);
      break;
    case 'request':
      if (args.headers) args.headers = redactHeaders(args.headers, o);
      if (typeof args.data === 'string') args.data = maskBody(args.data, o);
      // 結果(レスポンス要約)にも set-cookie 等の機微ヘッダや本文中のトークンが含まれ得る
      if (e.result != null && (o.mask || o.deny)) {
        try {
          const parsed = JSON.parse(e.result) as Record<string, any>;
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.url === 'string') parsed.url = maskUrl(parsed.url, o);
            if (parsed.headers) parsed.headers = redactHeaders(parsed.headers, o);
            if (typeof parsed.body === 'string') parsed.body = maskUrlsInText(maskBody(parsed.body, o), o);
            e.result = JSON.stringify(parsed);
          }
        } catch {
          // 切り詰め等で解析できない要約は安全側で全体をマスクする
          e.result = o.mask ? MASK : e.result;
        }
      }
      break;
  }
  // URL を持つ引数はクエリ値をマスクする(open / request など)
  if (typeof args.url === 'string') args.url = maskUrl(args.url, o);
  // 結果 payload の url も同様にマスクする(open / click 等の {"url":…,"title":…}。request は上で処理済み)
  if (e.cmd !== 'request' && e.result != null && (o.mask || o.deny)) {
    try {
      const parsed = JSON.parse(e.result) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string') {
        const masked = maskUrl(parsed.url, o);
        if (masked !== parsed.url) {
          parsed.url = masked;
          e.result = JSON.stringify(parsed);
        }
      }
    } catch {
      /* JSON でない・切り詰め済みの結果はそのまま(url を含まない) */
    }
  }
  // deny はコマンドイベントの全文字列引数にも適用する
  if (o.deny) {
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && o.deny.test(v)) args[k] = MASK;
    }
    if (e.result && o.deny.test(e.result)) e.result = MASK;
  }
  return e;
}

// ---- ジャーナル記録用の引数要約(巨大・機微な引数を保存前に圧縮する) ----

const ARG_CLIP = 2_000;

export function clipStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `…(全 ${s.length} 文字)` : s;
}

/**
 * コマンド引数をジャーナル保存用に要約する。マスクではない(生ジャーナルは無改変の方針)が、
 * storage.restore の Cookie 全量などジャーナルを肥大化させるものだけ件数に置き換える。
 */
export function summarizeArgs(cmd: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? clipStr(v, ARG_CLIP) : v;
  }
  if (cmd === 'storage.restore' && out.state) {
    const state = out.state as { cookies?: unknown[]; origins?: unknown[] };
    out.state = { cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 };
  }
  if (cmd === 'cookies.import' && Array.isArray(out.cookies)) out.cookies = { count: (out.cookies as unknown[]).length };
  return out;
}

// ---- 再現手順(kb コマンド文字列)の再構成 ----

function q(s: unknown): string {
  const str = String(s);
  return /[\s"'$&|<>;]/.test(str) ? `'${str.replace(/'/g, `'\\''`)}'` : str;
}

/** 操作対象(selector / ref / frame / tab)の共通オプション文字列。 */
function targetOpts(a: Record<string, any>): string {
  let s = '';
  if (a.selector) s += ` ${q(a.selector)}`;
  if (a.ref) s += ` --ref ${a.ref}`;
  if (a.frame) s += ` --frame ${q(a.frame)}`;
  if (a.tab != null) s += ` -t ${a.tab}`;
  return s;
}

/** command イベントを再現用の kb コマンド文字列にする。 */
export function toCliString(e: CommandEvent): string {
  const a = e.args as Record<string, any>;
  switch (e.cmd) {
    case 'open':
      return `kb open ${q(a.url)}${a.new ? ' -n' : ''}${a.waitUntil === 'networkidle' ? ' --wait idle' : ''}`;
    case 'click':
      return `kb click${targetOpts(a)}`;
    case 'fill':
      return `kb fill${targetOpts(a)} ${q(a.value)}`;
    case 'press':
      return `kb press ${q(a.key)}`;
    case 'hover':
      return `kb hover${targetOpts(a)}`;
    case 'check':
      return `kb ${a.checked === false ? 'uncheck' : 'check'}${targetOpts(a)}`;
    case 'select':
      // --label は値の前に置く(値の後ろだとフラグに値が続くように見えて紛らわしい)
      return `kb select${targetOpts(a)}${a.byLabel ? ' --label' : ''} ${(a.values ?? []).map(q).join(' ')}`;
    case 'upload':
      return `kb upload${targetOpts(a)} ${(a.files ?? []).map(q).join(' ')}`;
    case 'scroll':
      return `kb scroll${a.to ? ` --to ${q(a.to)}` : ''}${a.top ? ' --top' : ''}${a.bottom ? ' --bottom' : ''}${a.by != null ? ` --down ${a.by}` : ''}`;
    case 'back':
      return 'kb back';
    case 'forward':
      return 'kb forward';
    case 'reload':
      return 'kb reload';
    case 'eval':
      return `kb eval ${q(a.expression)}`;
    case 'request': {
      let s = `kb request ${q(a.url)}`;
      if (a.method && String(a.method).toUpperCase() !== 'GET') s += ` -X ${String(a.method).toUpperCase()}`;
      for (const [k, v] of Object.entries((a.headers as Record<string, string>) ?? {})) s += ` -H ${q(`${k}: ${v}`)}`;
      if (a.data != null) s += ` -d ${q(a.data)}`;
      return s;
    }
    case 'screenshot':
      return `kb screenshot${a.selector ? ` ${q(a.selector)}` : ''}${a.ref ? ` --ref ${a.ref}` : ''}${a.full ? ' -f' : ''} -o ${q(a.path)}`;
    case 'pdf':
      return `kb pdf -o ${q(a.path)}`;
    case 'wait':
      return `kb wait${a.url ? ` --url ${q(a.url)}` : ''}${a.selector ? ` --selector ${q(a.selector)}` : ''}${a.idle ? ' --idle' : ''}${a.any ? ' --any' : ''}`;
    case 'text':
      return 'kb text';
    case 'html':
      return 'kb html';
    case 'snapshot':
      return 'kb snapshot';
    case 'dom.query':
      return `kb dom query ${q(a.selector)}${a.attr ? ` --attr ${q(a.attr)}` : ''}${a.html ? ' --html' : ''}`;
    case 'tabs.close':
      return `kb tabs close ${a.tab}`;
    case 'tabs.activate':
      return `kb tabs switch ${a.tab}`;
    case 'mode.set':
      return `kb mode ${a.headless ? 'headless' : 'headed'}`;
    case 'profile.set':
      return `kb profile use ${q(a.name)}`;
    case 'auth.set':
      return a.credentials ? `kb auth set ${q(a.credentials.username)} ${q(a.credentials.password)}` : 'kb auth clear';
    case 'proxy.use':
    case 'proxy.reload':
      return 'kb proxy use <profile>  # (設定切替)';
    case 'cookies.set':
      return `kb cookies set ${q(a.cookie?.name)} ${q(a.cookie?.value)} -d ${q(a.cookie?.domain)}`;
    case 'cookies.rm':
      return `kb cookies rm ${q(a.name)}`;
    case 'cookies.clear':
      return 'kb cookies clear';
    case 'storage.restore':
      return 'kb storage restore <file>';
    case 'net.block':
      return `kb net block ${q(a.pattern)}`;
    case 'net.mock':
      return `kb net mock ${q(a.pattern)} --status ${a.status}${a.body ? ` --text ${q(clipStr(String(a.body), 100))}` : ''}`;
    case 'net.unroute':
      return a.all ? 'kb net unroute --all' : `kb net unroute ${a.id}`;
    default:
      return `kb ${e.cmd.replace('.', ' ')}  # args: ${clipStr(JSON.stringify(e.args), 200)}`;
  }
}

// ---- 単体再実行(curl) ----

/** curl に含めない自動付与ヘッダ(再現に不要なノイズ)。 */
const CURL_SKIP_HEADER_RE = /^(host|connection|content-length|accept-encoding|proxy-connection|sec-ch-.*|sec-fetch-.*|upgrade-insecure-requests|pragma|cache-control|referer|origin|user-agent)$/i;

/** net イベントを kb 非依存で再実行できる curl コマンドにする。 */
export function toCurlCommand(e: NetEvent): string {
  const lines: string[] = [`curl -sS -X ${e.method} ${q(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders ?? {})) {
    if (k.startsWith(':') || CURL_SKIP_HEADER_RE.test(k)) continue;
    lines.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (e.postData != null && e.postData !== '') {
    // Content-Type が記録されていない JSON ボディは補完する(curl 既定の form-urlencoded で再実行されるのを防ぐ)
    const inferred = inferJsonContentType(e.postData, e.requestHeaders);
    if (inferred) lines.push(`-H ${q(`content-type: ${inferred}`)}`);
    lines.push(`--data ${q(e.postData)}`);
  }
  return lines.join(' \\\n  ');
}

function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'request';
  } catch {
    return 'request';
  }
}

/**
 * requests/ に書き出すファイル群を生成する(マスク適用済みイベントを渡すこと)。
 * ページが発行した通信(net イベント)に加え、kb request コマンドも curl 化する。
 */
export function requestFiles(events: OpEvent[]): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  for (const e of events) {
    let net: NetEvent | null = null;
    if (e.type === 'net') {
      net = e;
    } else if (e.type === 'command' && e.cmd === 'request' && typeof (e.args as any).url === 'string') {
      const a = e.args as Record<string, any>;
      net = {
        seq: e.seq,
        ts: e.ts,
        type: 'net',
        method: String(a.method ?? 'GET').toUpperCase(),
        url: String(a.url),
        resourceType: 'kb-request',
        tab: -1,
        requestHeaders: a.headers,
        postData: typeof a.data === 'string' ? a.data : undefined,
      };
    }
    if (!net) continue;
    const name = `${String(net.seq).padStart(4, '0')}-${net.method}-${urlSlug(net.url)}.sh`;
    const content = `#!/bin/sh\n# ${net.ts}  ${net.method} ${net.url} → ${net.status ?? '?'} (${net.resourceType})\n${toCurlCommand(net)}\n`;
    out.push({ name, content });
  }
  return out;
}

// ---- レポート / 手順の生成 ----

function shortUrl(url: string): string {
  return url.length > 100 ? url.slice(0, 100) + '…' : url;
}

/** 番号付き再現手順(kb コマンド列)。 */
export function stepsMarkdown(events: OpEvent[], meta: SessionMeta): string {
  const cmds = events.filter((e): e is CommandEvent => e.type === 'command');
  const lines = [`# 再現手順: ${meta.name}`, ''];
  cmds.forEach((e, i) => {
    lines.push(`${i + 1}. \`${toCliString(e)}\`${e.ok ? '' : `  ← 失敗: ${e.error ?? ''}`}`);
  });
  if (!cmds.length) lines.push('(コマンドは記録されていません)');
  return lines.join('\n') + '\n';
}

/**
 * 人間可読レポート。コマンドをステップとして並べ、直後に発生した通信・コンソール出力を
 * そのステップ配下にぶら下げる。
 */
export function reportMarkdown(events: OpEvent[], meta: SessionMeta, shotFiles?: Map<number, string>): string {
  const lines: string[] = [
    `# kb セッションレポート: ${meta.name}`,
    '',
    `- 開始: ${meta.startedAt}${meta.endedAt ? ` / 終了: ${meta.endedAt}` : ''}`,
    `- プロファイル: ${meta.profile ?? '-'} / channel: ${meta.channel ?? '-'} / headless: ${meta.headless ?? '-'}${meta.attach ? ` / attach: ${meta.attach}` : ''}`,
    `- kb バージョン: ${meta.kbVersion ?? '-'} / イベント数: ${events.length}`,
    '',
    '## 手順',
    '',
  ];
  let step = 0;
  let pendingNet: NetEvent[] = [];
  let pendingConsole: ConsoleEvent[] = [];
  const flush = () => {
    for (const n of pendingNet) lines.push(`  - 通信: \`${n.method} ${shortUrl(n.url)}\` → ${n.status ?? '?'} (${n.resourceType})`);
    for (const c of pendingConsole) lines.push(`  - コンソール [${c.kind}]: ${clipStr(c.text, 200)}`);
    pendingNet = [];
    pendingConsole = [];
  };
  for (const e of events) {
    if (e.type === 'net') {
      pendingNet.push(e);
      continue;
    }
    if (e.type === 'console') {
      pendingConsole.push(e);
      continue;
    }
    step++;
    lines.push('', `### Step ${step} — \`${toCliString(e)}\``, '');
    lines.push(`- ${e.ts} / ${e.durationMs}ms / ${e.ok ? 'OK' : `**失敗**: ${e.error ?? ''}`}`);
    if (e.result) lines.push(`- 結果: \`${clipStr(e.result, 300)}\``);
    // コマンドイベントは完了時に書かれるため、直前に溜まった通信・コンソールは
    // このコマンドの実行中に発生したもの = このステップに帰属させる
    flush();
    const shot = shotFiles?.get(e.seq);
    if (shot) lines.push('', `![step ${step}](${shot})`);
  }
  if (pendingNet.length || pendingConsole.length) {
    lines.push('', '### (最後のコマンド以降の通信・コンソール)', '');
    flush();
  }
  if (!step) lines.push('(コマンドは記録されていません)');
  return lines.join('\n') + '\n';
}
