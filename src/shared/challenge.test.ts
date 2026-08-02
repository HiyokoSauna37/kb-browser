import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectChallenge, isBlockedStatus, judgeSession, type ProbeOutcome } from './challenge';

test('isBlockedStatus: 401/403/429/503 のみ', () => {
  assert.equal(isBlockedStatus(403), true);
  assert.equal(isBlockedStatus(429), true);
  assert.equal(isBlockedStatus(200), false);
  assert.equal(isBlockedStatus(404), false);
  assert.equal(isBlockedStatus(undefined), false);
});

test('detectChallenge: cf-mitigated ヘッダは一次情報として拾う', () => {
  const r = detectChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' } });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'cloudflare');
  assert.match(r.marker!, /cf-mitigated/);
});

test('detectChallenge: 本文・タイトルのマーカーでベンダを判別する', () => {
  assert.equal(detectChallenge({ title: 'Just a moment...' }).vendor, 'cloudflare');
  assert.equal(detectChallenge({ body: '<iframe src="https://challenges.cloudflare.com/x">' }).vendor, 'cloudflare');
  assert.equal(detectChallenge({ body: 'window._cf_chl_opt={}' }).vendor, 'cloudflare');
  assert.equal(detectChallenge({ body: 'geo.captcha-delivery.com' }).vendor, 'datadome');
  assert.equal(detectChallenge({ body: 'Incapsula incident ID' }).vendor, 'incapsula');
  assert.equal(detectChallenge({ headers: { 'x-datadome': 'protected' } }).vendor, 'datadome');
});

test('detectChallenge: ステータスだけではチャレンジ扱いにしない(アプリ由来の 403 と区別する)', () => {
  const r = detectChallenge({ status: 403, headers: { 'content-type': 'application/json' }, body: '{"error":"forbidden"}' });
  assert.equal(r.challenged, false);
  assert.equal(r.vendor, undefined);
});

function probe(label: ProbeOutcome['label'], extra: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return { label, status: 200, challenged: false, ...extra };
}

test('judgeSession: 対象が正常なら ok', () => {
  const r = judgeSession([probe('root'), probe('target')], { hasCookies: true });
  assert.equal(r.verdict, 'ok');
});

test('judgeSession: 対照(root)も弾かれていれば degraded — 403 を証拠にしない', () => {
  const r = judgeSession([probe('root', { status: 403, challenged: true }), probe('target', { status: 403, challenged: true })], {
    hasCookies: true,
  });
  assert.equal(r.verdict, 'degraded');
  assert.match(r.hint, /読まないでください/);
});

test('judgeSession: HTML はチャレンジだが API は 200 → degraded-html-only(ルールセットが別)', () => {
  const r = judgeSession(
    [probe('root', { status: 403, challenged: true }), probe('target', { status: 403, challenged: true }), probe('api', { status: 200 })],
    { hasCookies: true },
  );
  assert.equal(r.verdict, 'degraded-html-only');
  assert.match(r.hint, /ルールセットが別/);
});

test('judgeSession: root は 200 で対象だけ 403(チャレンジなし)なら target-protected', () => {
  const r = judgeSession([probe('root'), probe('target', { status: 403 })], { hasCookies: true });
  assert.equal(r.verdict, 'target-protected');
  assert.match(r.hint, /性質として読めます/);
});

test('judgeSession: root は 200 でも対象にチャレンジが出ていれば degraded(認可の証拠にはならない)', () => {
  const r = judgeSession([probe('root'), probe('target', { status: 403, challenged: true })], { hasCookies: true });
  assert.equal(r.verdict, 'degraded');
  assert.match(r.hint, /権限の証拠には使えません/);
});

test('judgeSession: 対照も弾かれていて Cookie も無ければ no-session', () => {
  const r = judgeSession([probe('root', { status: 403 }), probe('target', { status: 403 })], { hasCookies: false });
  assert.equal(r.verdict, 'no-session');
  assert.match(r.hint, /kb login/);
});

test('judgeSession: Cookie を使わないサイトの素直な 403 は no-session にせず、匿名である旨を注記する', () => {
  const r = judgeSession([probe('root'), probe('target', { status: 403 })], { hasCookies: false });
  assert.equal(r.verdict, 'target-protected');
  assert.match(r.hint, /匿名アクセス/);
});

test('judgeSession: 対象だけ測れなかったら ok にせず unreachable(測定失敗を「問題なし」に化けさせない)', () => {
  const r = judgeSession([probe('root'), probe('target', { status: undefined, error: 'net::ERR_ABORTED' })], { hasCookies: true });
  assert.equal(r.verdict, 'unreachable');
  assert.match(r.hint, /トップページには到達できている/);
});

test('judgeSession: 到達できなければ unreachable', () => {
  const r = judgeSession(
    [probe('root', { status: undefined, error: 'net::ERR_PROXY_CONNECTION_FAILED' }), probe('target', { status: undefined, error: 'net::ERR_PROXY_CONNECTION_FAILED' })],
    { hasCookies: true },
  );
  assert.equal(r.verdict, 'unreachable');
});
