/** CLI / デーモン共用の純粋関数ユーティリティ。 */

/** スキームがなければ https:// を補う。about: / data: 等のスキームはそのまま通す。 */
export function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  if (/^(about|data|chrome|view-source|file|javascript|blob):/i.test(input)) return input;
  return `https://${input}`;
}

/** src が構文的に妥当か(実行はしない)。 */
function parses(src: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    return true;
  } catch {
    return false;
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * --extensions 引数値の分解。'on' は「拡張の有効化のみ」を表す空配列、
 * それ以外はカンマ区切りの拡張ディレクトリとしてトリムして返す(空要素は除去)。
 * 'off'(明示リセット)は呼び出し側で先に処理する想定。
 */
export function splitExtensionsArg(value: string): string[] {
  if (value === 'on') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** キーコンボ (--detach-key) の解析結果。keydown イベントとの照合に使う。 */
export interface Hotkey {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  /** 主キー(1 文字キーは小文字化。F2 等の名前はそのまま)。event.key と大文字小文字を無視して照合する。 */
  key: string;
}

/**
 * "Alt+Shift+D" のようなキーコンボ文字列を解析する。修飾子は Ctrl/Control・Alt/Option・
 * Shift・Meta/Cmd/Command/Win/Super を受け付け(大文字小文字無視)、残る 1 トークンを主キーにする。
 * 主キーが無い / 2 つある / 空コンボはエラー(CLI が起動前に弾けるように投げる)。
 */
export function parseHotkey(combo: string): Hotkey {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const hk: Hotkey = { alt: false, ctrl: false, shift: false, meta: false, key: '' };
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'ctrl' || p === 'control') hk.ctrl = true;
    else if (p === 'alt' || p === 'option') hk.alt = true;
    else if (p === 'shift') hk.shift = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win' || p === 'super') hk.meta = true;
    else if (hk.key) throw new Error(`キーコンボに主キーが 2 つあります: "${combo}"`);
    else hk.key = raw.length === 1 ? raw.toLowerCase() : raw;
  }
  if (!hk.key) throw new Error(`キーコンボに主キーがありません(修飾子だけ、または空): "${combo}"`);
  return hk;
}

/**
 * kb eval のコードを page.evaluate に渡せる形に整える。
 * - await を含まないコードはそのまま(従来どおり eval の完了値が返る)。
 * - await を含む式は `(async () => (code))()` でラップして値を返す。
 * - await を含む複数文は `(async () => { ... })()` でラップ。`return` があればその値、
 *   なければ最後の式を `return` に書き換えて返す(書き換え候補は構文チェックで検証)。
 */
export function prepareEval(code: string): string {
  if (!/\bawait\b/.test(code)) return code; // 従来動作を維持(var の global 漏れ等も含めて)

  // 末尾の ; を落とすと「await fetch(...);」のような 1 文が式として扱える
  const trimmed = code.trim().replace(/;$/, '');
  if (parses(`return (async () => (\n${trimmed}\n));`)) {
    return `(async () => (\n${trimmed}\n))()`;
  }

  const wrapBody = (body: string) => `(async () => {\n${body}\n})()`;
  if (!/\breturn\b/.test(code)) {
    // 最後の式を return に書き換える。末尾に近い ; / 改行から順に分割を試し、
    // 前半・後半とも構文チェックが通る最初の分割を採用する。
    const points: number[] = [];
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === ';' || trimmed[i] === '\n') points.push(i);
    }
    for (const i of points) {
      const head = trimmed.slice(0, i);
      const tail = trimmed.slice(i + 1).trim();
      if (!tail || tail.startsWith('//')) continue;
      const candidate = `${head};\nreturn (\n${tail}\n);`;
      if (parses(`return (async () => {\n${candidate}\n});`)) return wrapBody(candidate);
    }
  }
  return wrapBody(trimmed);
}

export interface Clipped {
  text: string;
  /** 元テキストの全文字数。 */
  totalChars: number;
  offset: number;
  truncated: boolean;
}

/**
 * 長文をオフセット+上限で切り出す(エージェントのコンテキスト溢れ防止)。
 * maxChars が 0 以下なら無制限。
 */
export function clip(text: string, opts: { maxChars?: number; offset?: number } = {}): Clipped {
  const offset = Math.max(0, opts.offset ?? 0);
  const max = opts.maxChars ?? 0;
  const sliced = max > 0 ? text.slice(offset, offset + max) : text.slice(offset);
  return {
    text: sliced,
    totalChars: text.length,
    offset,
    truncated: offset > 0 || offset + sliced.length < text.length,
  };
}

/**
 * kb request のボディが JSON に見え、かつ Content-Type が未指定なら
 * "application/json" を返す(明示ヘッダが常に優先)。
 */
export function inferJsonContentType(
  data: string | undefined,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (data == null) return undefined;
  if (headers && Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) return undefined;
  const t = data.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    JSON.parse(t);
    return 'application/json';
  } catch {
    return undefined;
  }
}

/** "Name: value" 形式のヘッダ指定(-H)をオブジェクトに変換する。 */
export function parseHeaderArgs(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const idx = h.indexOf(':');
    if (idx <= 0) throw new Error(`ヘッダは "Name: value" の形式で指定してください: "${h}"`);
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

/**
 * seq キーのバイト列ストア(net body 捕捉用)。件数とバイト数の両方に上限を持ち、
 * 超えたら古いものから捨てる(Map の挿入順を利用)。
 */
export class BodyStore<V extends { body: Buffer }> {
  private items = new Map<number, V>();
  private totalBytes = 0;

  constructor(
    private readonly maxCount: number,
    private readonly maxBytes: number,
  ) {}

  set(seq: number, value: V): void {
    const prev = this.items.get(seq);
    if (prev) {
      this.totalBytes -= prev.body.length;
      this.items.delete(seq);
    }
    this.items.set(seq, value);
    this.totalBytes += value.body.length;
    for (const [key, item] of this.items) {
      if (this.items.size <= this.maxCount && this.totalBytes <= this.maxBytes) break;
      this.items.delete(key);
      this.totalBytes -= item.body.length;
    }
  }

  get(seq: number): V | undefined {
    return this.items.get(seq);
  }

  get size(): number {
    return this.items.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

/**
 * seq 付きリングバッファ。since カーソルでのポーリング取得と、
 * 容量あふれで読者が見る前に消えた件数 (dropped) の検出を行う。
 */
export class LogBuffer<T extends { seq: number }> {
  private items: T[] = [];
  private seq = 0;
  /** 容量あふれで捨てた中で最大の seq。clear() による削除は含めない。 */
  private evictedUpTo = 0;

  constructor(private readonly cap: number) {}

  push(item: Omit<T, 'seq'>): T {
    const entry = { ...(item as object), seq: ++this.seq } as T;
    this.items.push(entry);
    if (this.items.length > this.cap) {
      const removed = this.items.splice(0, this.items.length - this.cap);
      this.evictedUpTo = removed[removed.length - 1].seq;
    }
    return entry;
  }

  clear(): void {
    this.items = [];
  }

  get lastSeq(): number {
    return this.seq;
  }

  query(opts: { since?: number; limit?: number; filter?: (e: T) => boolean } = {}): {
    entries: T[];
    seq: number;
    dropped: number;
  } {
    const since = opts.since ?? 0;
    const dropped = since > 0 ? Math.max(0, this.evictedUpTo - since) : 0;
    let entries = since ? this.items.filter((e) => e.seq > since) : this.items.slice();
    if (opts.filter) entries = entries.filter(opts.filter);
    if (opts.limit && entries.length > opts.limit) entries = entries.slice(-opts.limit);
    return { entries, seq: this.seq, dropped };
  }
}
