import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headersWithSetCookie, hhmmss, setCookieLines, truncSpan } from './format';

test('hhmmss: ISO タイムスタンプから時刻部を取り出す', () => {
  assert.equal(hhmmss('2026-07-10T12:34:56.789Z'), '12:34:56');
});

test('truncSpan: offset 0 のとき from=1', () => {
  assert.deepEqual(truncSpan({ totalChars: 100, offset: 0, truncated: true }, 10), { from: 1, next: 10, total: 100 });
});

test('truncSpan: offset 付きの続き読み', () => {
  assert.deepEqual(truncSpan({ totalChars: 100, offset: 40, truncated: true }, 20), { from: 41, next: 60, total: 100 });
});

test('setCookieLines: 各 Set-Cookie を個別行にする', () => {
  assert.equal(setCookieLines(['a=1; Path=/', 'b=2']), '\nset-cookie: a=1; Path=/\nset-cookie: b=2');
  assert.equal(setCookieLines([]), '');
});

test('headersWithSetCookie: set-cookie を除いた全ヘッダ + 個別 set-cookie 行', () => {
  const headers = { 'content-type': 'text/html', 'set-cookie': 'a=1, b=2', server: 'x' };
  assert.equal(
    headersWithSetCookie(headers, ['a=1', 'b=2']),
    '\ncontent-type: text/html\nserver: x\nset-cookie: a=1\nset-cookie: b=2',
  );
});

test('headersWithSetCookie: headers が undefined でも壊れない', () => {
  assert.equal(headersWithSetCookie(undefined, ['a=1']), '\n\nset-cookie: a=1');
});
