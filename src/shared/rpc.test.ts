import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRpcCommand, rpcSchemas } from './rpc';

test('isRpcCommand: 既知コマンドは true、未知は false', () => {
  assert.equal(isRpcCommand('open'), true);
  assert.equal(isRpcCommand('net.har.start'), true);
  assert.equal(isRpcCommand('bogus'), false);
  assert.equal(isRpcCommand(''), false);
  assert.equal(isRpcCommand('__proto__'), false); // hasOwnProperty で継承プロパティを弾く
});

test('コマンド数が想定どおり(意図しない削除の検知)', () => {
  assert.equal(Object.keys(rpcSchemas).length, 64);
});

test('全スキーマが空引数 {} を parse できる(必須フィールドのあるものは除く)', () => {
  const requiresArgs = new Set([
    'open', 'tabs.close', 'tabs.activate', 'screenshot', 'eval', 'fill', 'press', 'pdf',
    'cookies.set', 'cookies.rm', 'net.body', 'net.headers', 'net.block', 'net.mock',
    'dom.query', 'request', 'profile.set', 'emulate.geo', 'emulate.net',
  ]);
  for (const [name, schema] of Object.entries(rpcSchemas)) {
    if (requiresArgs.has(name)) continue;
    assert.doesNotThrow(() => schema.parse({}), `${name} は {} を受け付けるはず`);
  }
});

test('必須フィールドの欠落は reject する', () => {
  assert.throws(() => rpcSchemas['open'].parse({}));
  assert.throws(() => rpcSchemas['eval'].parse({}));
  assert.throws(() => rpcSchemas['fill'].parse({ selector: '#x' })); // value 必須
  assert.throws(() => rpcSchemas['emulate.geo'].parse({ latitude: 1 })); // longitude 必須
});

test('代表的な正常ペイロードが通る', () => {
  assert.deepEqual(rpcSchemas['open'].parse({ url: 'https://example.com', new: true, waitUntil: 'load' }), {
    url: 'https://example.com',
    new: true,
    waitUntil: 'load',
  });
  assert.deepEqual(rpcSchemas['cookies.set'].parse({ cookie: { name: 'a', value: 'b', domain: 'x.com' } }), {
    cookie: { name: 'a', value: 'b', domain: 'x.com' },
  });
  assert.deepEqual(rpcSchemas['emulate'].parse({ viewport: { width: 390, height: 844, mobile: true } }), {
    viewport: { width: 390, height: 844, mobile: true },
  });
});

test('非 strict: 未知キーは黙って落とす(新旧クライアント混在の後方互換)', () => {
  const parsed = rpcSchemas['open'].parse({ url: 'https://x', unknownField: 123 });
  assert.deepEqual(parsed, { url: 'https://x' });
  assert.equal('unknownField' in parsed, false);
});

test('waitUntil の enum 外の値は reject する', () => {
  assert.throws(() => rpcSchemas['open'].parse({ url: 'https://x', waitUntil: 'bogus' }));
});
