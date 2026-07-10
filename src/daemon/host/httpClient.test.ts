import { test } from 'node:test';
import assert from 'node:assert/strict';
import { methodAfterRedirect } from './httpClient';

test('methodAfterRedirect: 303 See Other は常に GET 化してボディを落とす', () => {
  assert.deepEqual(methodAfterRedirect(303, 'POST'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(303, 'GET'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(303, 'PUT'), { method: 'GET', dropBody: true });
});

test('methodAfterRedirect: 301/302 は POST を GET 化(ブラウザ準拠)', () => {
  assert.deepEqual(methodAfterRedirect(301, 'POST'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(302, 'POST'), { method: 'GET', dropBody: true });
});

test('methodAfterRedirect: 301/302 でも GET/HEAD はそのまま維持', () => {
  assert.deepEqual(methodAfterRedirect(301, 'GET'), { method: 'GET', dropBody: false });
  assert.deepEqual(methodAfterRedirect(302, 'HEAD'), { method: 'HEAD', dropBody: false });
});

test('methodAfterRedirect: 307/308 はメソッドとボディを維持', () => {
  assert.deepEqual(methodAfterRedirect(307, 'POST'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(308, 'POST'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(307, 'PUT'), { method: 'PUT', dropBody: false });
});

test('methodAfterRedirect: メソッドは大文字に正規化される', () => {
  assert.deepEqual(methodAfterRedirect(307, 'post'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(301, 'get'), { method: 'GET', dropBody: false });
});
