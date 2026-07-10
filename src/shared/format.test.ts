import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headersWithSetCookie, hhmmss, redirectHopLines, setCookieLines, truncSpan } from './format';

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

test('redirectHopLines: 各ホップを status/url → location 形式で整形', () => {
  const hops = [
    { status: 301, statusText: 'Moved Permanently', url: 'http://ex.com/', location: 'https://ex.com/' },
    { status: 302, statusText: 'Found', url: 'https://ex.com/', location: 'https://ex.com/home' },
  ];
  assert.equal(
    redirectHopLines(hops),
    'HTTP 301 Moved Permanently  http://ex.com/  →  https://ex.com/\nHTTP 302 Found  https://ex.com/  →  https://ex.com/home',
  );
});

test('redirectHopLines: ホップの Set-Cookie はインデントして配下に出す', () => {
  const hops = [
    { status: 302, statusText: 'Found', url: 'https://ex.com/login', location: '/home', setCookies: ['sid=abc; Path=/'] },
  ];
  assert.equal(
    redirectHopLines(hops),
    'HTTP 302 Found  https://ex.com/login  →  /home\n    set-cookie: sid=abc; Path=/',
  );
});

test('redirectHopLines: Location 欠落時も壊れない', () => {
  const hops = [{ status: 300, statusText: 'Multiple Choices', url: 'https://ex.com/' }];
  assert.equal(redirectHopLines(hops), 'HTTP 300 Multiple Choices  https://ex.com/  →  (Location なし)');
});
