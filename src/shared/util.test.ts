import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyStore, clip, inferJsonContentType, LogBuffer, normalizeUrl, parseHeaderArgs, prepareEval } from './util';

/** prepareEval の出力を Node 上で実行して結果を確かめる(page.evaluate の代わり)。 */
async function evalPrepared(code: string): Promise<unknown> {
  const prepared = prepareEval(code);
  // eslint-disable-next-line no-eval
  return (0, eval)(prepared);
}

test('prepareEval: await なしはそのまま(従来動作を維持)', () => {
  assert.equal(prepareEval('1 + 1'), '1 + 1');
  assert.equal(prepareEval('const a = 1; a + 1'), 'const a = 1; a + 1');
});

test('prepareEval: 文字列内の await は誤検知するがラップされても結果は変わらない', async () => {
  assert.equal(await evalPrepared('"await" + "x"'), 'awaitx');
});

test('prepareEval: await 入りの式は値が返る', async () => {
  assert.equal(await evalPrepared('await Promise.resolve(42)'), 42);
  assert.equal(await evalPrepared('await Promise.resolve(42);'), 42); // 末尾セミコロンも許容
  assert.equal(await evalPrepared('(await Promise.resolve(6)) * 7'), 42);
});

test('prepareEval: const x = await ... の複数文で最後の式が返る', async () => {
  assert.equal(await evalPrepared('const x = await Promise.resolve(40);\nx + 2'), 42);
  assert.equal(await evalPrepared('const x = await Promise.resolve(40); x + 2'), 42);
});

test('prepareEval: return を書いた複数文はその値が返る', async () => {
  assert.equal(await evalPrepared('const x = await Promise.resolve(1); if (x) { return "yes"; } return "no"'), 'yes');
});

test('prepareEval: 文字列内の ; や改行で誤分割しない', async () => {
  assert.equal(await evalPrepared('const s = "a;b";\nawait Promise.resolve(s)'), 'a;b');
});

test('prepareEval: 値を返さない複数文は undefined', async () => {
  assert.equal(await evalPrepared('const x = await Promise.resolve(1)'), undefined);
});

test('normalizeUrl: スキームなしは https を補う', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('example.com/path?q=1'), 'https://example.com/path?q=1');
});

test('normalizeUrl: スキームありはそのまま', () => {
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('data:text/html,<h1>x</h1>'), 'data:text/html,<h1>x</h1>');
  assert.equal(normalizeUrl('file:///c:/tmp/a.html'), 'file:///c:/tmp/a.html');
});

test('normalizeUrl: host:port をスキームと誤認しない', () => {
  assert.equal(normalizeUrl('localhost:8080'), 'https://localhost:8080');
  assert.equal(normalizeUrl('127.0.0.1:3000/app'), 'https://127.0.0.1:3000/app');
});

test('clip: 上限内はそのまま', () => {
  const r = clip('hello', { maxChars: 10 });
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
  assert.equal(r.totalChars, 5);
});

test('clip: 上限で切り詰め、offset で続きが取れる', () => {
  const src = 'abcdefghij';
  const first = clip(src, { maxChars: 4 });
  assert.equal(first.text, 'abcd');
  assert.equal(first.truncated, true);
  const second = clip(src, { maxChars: 4, offset: 4 });
  assert.equal(second.text, 'efgh');
  assert.equal(second.truncated, true);
  const last = clip(src, { maxChars: 4, offset: 8 });
  assert.equal(last.text, 'ij');
  assert.equal(last.truncated, true); // offset > 0 なので部分表示
});

test('clip: maxChars 0 は無制限', () => {
  const r = clip('abcdefghij', { maxChars: 0 });
  assert.equal(r.text, 'abcdefghij');
  assert.equal(r.truncated, false);
});

test('LogBuffer: seq が単調増加し since カーソルで新着だけ取れる', () => {
  const buf = new LogBuffer<{ seq: number; v: string }>(10);
  buf.push({ v: 'a' });
  buf.push({ v: 'b' });
  const first = buf.query();
  assert.deepEqual(first.entries.map((e) => e.v), ['a', 'b']);
  buf.push({ v: 'c' });
  const next = buf.query({ since: first.seq });
  assert.deepEqual(next.entries.map((e) => e.v), ['c']);
  assert.equal(next.dropped, 0);
});

test('LogBuffer: 容量あふれで dropped が報告される', () => {
  const buf = new LogBuffer<{ seq: number; v: number }>(3);
  buf.push({ v: 1 });
  const cursor = buf.query().seq; // seq=1 まで読了
  for (let i = 2; i <= 6; i++) buf.push({ v: i }); // cap=3 なので 1..3 が追い出される
  const r = buf.query({ since: cursor });
  assert.deepEqual(r.entries.map((e) => e.v), [4, 5, 6]);
  assert.equal(r.dropped, 2); // seq 2,3 は読まれる前に消えた
});

test('LogBuffer: limit は末尾から適用される', () => {
  const buf = new LogBuffer<{ seq: number; v: number }>(10);
  for (let i = 1; i <= 5; i++) buf.push({ v: i });
  const r = buf.query({ limit: 2 });
  assert.deepEqual(r.entries.map((e) => e.v), [4, 5]);
});

test('parseHeaderArgs: "Name: value" 形式をオブジェクトにする', () => {
  assert.deepEqual(parseHeaderArgs(['Accept: application/json', 'X-Api-Version:2']), {
    Accept: 'application/json',
    'X-Api-Version': '2',
  });
  assert.deepEqual(parseHeaderArgs([]), {});
});

test('parseHeaderArgs: 値内の : は保持される', () => {
  assert.deepEqual(parseHeaderArgs(['Authorization: Bearer a:b:c']), { Authorization: 'Bearer a:b:c' });
});

test('parseHeaderArgs: 不正な形式はエラー', () => {
  assert.throws(() => parseHeaderArgs(['no-colon']));
  assert.throws(() => parseHeaderArgs([': empty-name']));
});

test('inferJsonContentType: JSON ボディで Content-Type 未指定なら application/json', () => {
  assert.equal(inferJsonContentType('{"a":1}', undefined), 'application/json');
  assert.equal(inferJsonContentType('  [1,2,3]  ', {}), 'application/json');
});

test('inferJsonContentType: 明示ヘッダがあれば推定しない(大文字小文字を問わず)', () => {
  assert.equal(inferJsonContentType('{"a":1}', { 'Content-Type': 'text/plain' }), undefined);
  assert.equal(inferJsonContentType('{"a":1}', { 'content-type': 'application/xml' }), undefined);
});

test('inferJsonContentType: JSON でないボディは推定しない', () => {
  assert.equal(inferJsonContentType('a=1&b=2', undefined), undefined);
  assert.equal(inferJsonContentType('{broken json', undefined), undefined);
  assert.equal(inferJsonContentType(undefined, undefined), undefined);
  assert.equal(inferJsonContentType('true', undefined), undefined); // リテラルは対象外({ / [ のみ)
});

test('BodyStore: 件数上限で古いものから捨てる', () => {
  const store = new BodyStore<{ body: Buffer }>(2, 1000);
  store.set(1, { body: Buffer.from('a') });
  store.set(2, { body: Buffer.from('b') });
  store.set(3, { body: Buffer.from('c') });
  assert.equal(store.get(1), undefined);
  assert.equal(store.get(2)?.body.toString(), 'b');
  assert.equal(store.get(3)?.body.toString(), 'c');
  assert.equal(store.size, 2);
});

test('BodyStore: バイト数上限で古いものから捨てる', () => {
  const store = new BodyStore<{ body: Buffer }>(100, 10);
  store.set(1, { body: Buffer.alloc(6) });
  store.set(2, { body: Buffer.alloc(6) }); // 合計 12 > 10 → seq=1 を追い出す
  assert.equal(store.get(1), undefined);
  assert.notEqual(store.get(2), undefined);
  assert.equal(store.bytes, 6);
});

test('BodyStore: 同じ seq の上書きでバイト数が二重計上されない', () => {
  const store = new BodyStore<{ body: Buffer }>(100, 100);
  store.set(1, { body: Buffer.alloc(50) });
  store.set(1, { body: Buffer.alloc(30) });
  assert.equal(store.bytes, 30);
  assert.equal(store.size, 1);
});

test('LogBuffer: clear 後は空になり dropped は増えない', () => {
  const buf = new LogBuffer<{ seq: number; v: number }>(10);
  buf.push({ v: 1 });
  const cursor = buf.query().seq;
  buf.clear();
  buf.push({ v: 2 });
  const r = buf.query({ since: cursor });
  assert.deepEqual(r.entries.map((e) => e.v), [2]);
  assert.equal(r.dropped, 0);
});
