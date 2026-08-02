import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHar, buildHarEntry, inferHttpVersion, parseQueryString, parseRequestCookies, parseSetCookies, type HarSourceEntry } from './har';

function src(extra: Partial<HarSourceEntry> = {}): HarSourceEntry {
  return {
    seq: 12,
    ts: '2026-08-03T00:00:00.000Z',
    tab: 1,
    method: 'POST',
    url: 'https://api.example.com/v1/login?next=/home',
    resourceType: 'xhr',
    status: 200,
    statusText: 'OK',
    requestHeaders: { 'content-type': 'application/json', cookie: 'sid=abc; theme=dark' },
    responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'sid=new; Path=/; HttpOnly\nflag=1; Path=/x' },
    postData: '{"user":"a"}',
    body: { text: '{"ok":true}', fullBytes: 11, contentType: 'application/json', truncated: false },
    timings: { wait: 120, receive: 30 },
    ...extra,
  };
}

test('inferHttpVersion: 擬似ヘッダの有無で HTTP/2 を判別する', () => {
  assert.equal(inferHttpVersion({ ':method': 'GET', 'accept': '*/*' }), 'HTTP/2');
  assert.equal(inferHttpVersion({ accept: '*/*' }), 'HTTP/1.1');
  assert.equal(inferHttpVersion(undefined), 'unknown');
});

test('parseQueryString: クエリを name/value にする(壊れた URL は空)', () => {
  assert.deepEqual(parseQueryString('https://x/a?b=1&c=2'), [
    { name: 'b', value: '1' },
    { name: 'c', value: '2' },
  ]);
  assert.deepEqual(parseQueryString('not a url'), []);
});

test('parseRequestCookies: Cookie ヘッダを分解する', () => {
  assert.deepEqual(parseRequestCookies('sid=abc; theme=dark'), [
    { name: 'sid', value: 'abc' },
    { name: 'theme', value: 'dark' },
  ]);
  assert.deepEqual(parseRequestCookies(undefined), []);
});

test('parseSetCookies: 改行で畳まれた複数 Set-Cookie を個別に属性付きで復元する', () => {
  const parsed = parseSetCookies('sid=new; Path=/; HttpOnly; Secure\nflag=1; Path=/x; Domain=.example.com');
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { name: 'sid', value: 'new', path: '/', httpOnly: true, secure: true });
  assert.deepEqual(parsed[1], { name: 'flag', value: '1', path: '/x', domain: '.example.com' });
});

test('buildHarEntry: 捕捉済みの情報が HAR の各フィールドに載る', () => {
  const e = buildHarEntry(src()) as any;
  assert.equal(e.startedDateTime, '2026-08-03T00:00:00.000Z');
  assert.equal(e.time, 150);
  assert.equal(e.request.method, 'POST');
  assert.equal(e.request.postData.text, '{"user":"a"}');
  assert.equal(e.request.postData.mimeType, 'application/json');
  assert.deepEqual(e.request.queryString, [{ name: 'next', value: '/home' }]);
  assert.equal(e.request.cookies.length, 2);
  assert.equal(e.response.status, 200);
  assert.equal(e.response.content.text, '{"ok":true}');
  assert.equal(e.response.content.size, 11);
  assert.equal(e.response.cookies.length, 2);
  // seq は kb net body <seq> に渡せる相互参照キー
  assert.equal(e._kbSeq, 12);
  assert.equal(e._kbResourceType, 'xhr');
});

test('buildHarEntry: レスポンスに擬似ヘッダが残らなくても、リクエストが HTTP/2 なら HTTP/2 と記録する', () => {
  const e = buildHarEntry(src({ requestHeaders: { ':method': 'GET' }, responseHeaders: { 'content-type': 'text/html' } })) as any;
  assert.equal(e.request.httpVersion, 'HTTP/2');
  assert.equal(e.response.httpVersion, 'HTTP/2');
});

test('buildHarEntry: ヘッダ・本文が無い(捕捉上限超え / 失敗)エントリでも壊れない', () => {
  const e = buildHarEntry({
    seq: 3,
    ts: '2026-08-03T00:00:00.000Z',
    tab: 1,
    method: 'GET',
    url: 'https://x/y',
    resourceType: 'document',
    failure: 'net::ERR_TUNNEL_CONNECTION_FAILED',
  }) as any;
  assert.equal(e.response.status, 0);
  assert.equal(e.response.statusText, 'Failed');
  assert.equal(e._kbFailure, 'net::ERR_TUNNEL_CONNECTION_FAILED');
  assert.equal(e.response.content.text, undefined);
  assert.deepEqual(e.request.headers, []);
  assert.equal(e._kbTimingsUnavailable, true);
});

test('buildHarEntry: 切り詰められた本文には欠落を示す comment が付く', () => {
  const e = buildHarEntry(src({ body: { text: 'abc', fullBytes: 900_000, contentType: 'text/html', truncated: true } })) as any;
  assert.match(e.response.content.comment, /切り詰め/);
  assert.equal(e.response.content.size, 900_000);
});

test('buildHar: HAR 1.2 の外枠と comment', () => {
  const har = buildHar([src()], { creatorVersion: '0.12.0', comment: 'note' });
  assert.equal(har.log.version, '1.2');
  assert.deepEqual(har.log.creator, { name: 'kb-browser', version: '0.12.0' });
  assert.equal((har.log.entries as unknown[]).length, 1);
  assert.equal(har.log.comment, 'note');
});
