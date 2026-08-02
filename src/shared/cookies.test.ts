import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieMatchesUrl, domainMatches, pathMatches, toCookieHeader, toNetscape, type KbCookie } from './cookies';

const NOW = 1_800_000_000; // 固定の「現在」(UNIX 秒)

function cookie(extra: Partial<KbCookie> = {}): KbCookie {
  return {
    name: 'sid',
    value: 'abc',
    domain: '.example.com',
    path: '/',
    expires: NOW + 3600,
    httpOnly: true,
    secure: true,
    ...extra,
  };
}

test('domainMatches: 先頭ドット付きはサブドメインにもマッチ、ホスト限定は完全一致のみ', () => {
  assert.equal(domainMatches('.example.com', 'www.example.com'), true);
  assert.equal(domainMatches('.example.com', 'example.com'), true);
  assert.equal(domainMatches('.example.com', 'evil-example.com'), false);
  assert.equal(domainMatches('example.com', 'www.example.com'), false);
  assert.equal(domainMatches('example.com', 'EXAMPLE.com'), true);
});

test('pathMatches: 境界を見る(/a は /ab にマッチしない)', () => {
  assert.equal(pathMatches('/a', '/a'), true);
  assert.equal(pathMatches('/a', '/a/b'), true);
  assert.equal(pathMatches('/a', '/ab'), false);
  assert.equal(pathMatches('/', '/anything'), true);
});

test('cookieMatchesUrl: Secure は https のみ、期限切れは除外', () => {
  assert.equal(cookieMatchesUrl(cookie(), 'https://www.example.com/x', NOW), true);
  assert.equal(cookieMatchesUrl(cookie(), 'http://www.example.com/x', NOW), false);
  assert.equal(cookieMatchesUrl(cookie({ expires: NOW - 1 }), 'https://www.example.com/x', NOW), false);
  assert.equal(cookieMatchesUrl(cookie({ expires: -1 }), 'https://www.example.com/x', NOW), true); // セッション Cookie
  assert.equal(cookieMatchesUrl(cookie(), 'https://other.com/x', NOW), false);
  assert.equal(cookieMatchesUrl(cookie(), 'not a url', NOW), false);
});

test('toCookieHeader: URL に実際に送られる Cookie だけを 1 行にする', () => {
  const jar = [
    cookie(),
    cookie({ name: 'theme', value: 'dark', secure: false, httpOnly: false }),
    cookie({ name: 'other', value: 'x', domain: 'other.com' }),
  ];
  assert.equal(toCookieHeader(jar, 'https://www.example.com/', NOW), 'sid=abc; theme=dark');
  assert.equal(toCookieHeader(jar, 'http://www.example.com/', NOW), 'theme=dark'); // Secure は落ちる
});

test('toCookieHeader: 同名はパスの長い方を優先して 1 つに寄せる', () => {
  const jar = [cookie({ value: 'root', path: '/' }), cookie({ value: 'deep', path: '/api' })];
  assert.equal(toCookieHeader(jar, 'https://www.example.com/api/v1', NOW), 'sid=deep');
});

test('toCookieHeader: URL 省略時は期限切れだけ除いて全件', () => {
  const jar = [cookie(), cookie({ name: 'old', expires: NOW - 1 })];
  assert.equal(toCookieHeader(jar, undefined, NOW), 'sid=abc');
});

test('toNetscape: curl 互換の cookies.txt(httpOnly は #HttpOnly_ プレフィックス)', () => {
  const out = toNetscape([cookie(), cookie({ name: 'theme', value: 'dark', httpOnly: false, secure: false, domain: 'example.com', expires: -1 })], {
    version: '0.12.0',
  });
  const lines = out.trim().split('\n');
  assert.match(lines[0], /^# Netscape HTTP Cookie File/);
  const sid = lines.find((l) => l.includes('\tsid\t'))!;
  assert.equal(sid, `#HttpOnly_.example.com\tTRUE\t/\tTRUE\t${NOW + 3600}\tsid\tabc`);
  const theme = lines.find((l) => l.includes('\ttheme\t'))!;
  // ホスト限定 = includeSubdomains FALSE、セッション Cookie = expires 0
  assert.equal(theme, 'example.com\tFALSE\t/\tFALSE\t0\ttheme\tdark');
});
