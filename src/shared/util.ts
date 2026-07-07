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
