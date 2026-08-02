import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCookieSeen } from './session';

const T0 = Date.parse('2026-08-03T00:00:00.000Z');

test('mergeCookieSeen: 初観測は age 0 で firstSeen を記録する', () => {
  const { store, ages } = mergeCookieSeen({}, 'default', [{ name: 'cf_clearance', domain: '.x.com', value: 'v1' }], T0);
  assert.equal(ages.get('default|.x.com|cf_clearance'), 0);
  assert.equal(store['default|.x.com|cf_clearance'].firstSeen, '2026-08-03T00:00:00.000Z');
  // 値そのものは保存しない(ハッシュのみ)
  assert.equal(JSON.stringify(store).includes('v1'), false);
});

test('mergeCookieSeen: 同じ値なら firstSeen を保ち経過秒を返す', () => {
  const first = mergeCookieSeen({}, 'default', [{ name: 'cf_clearance', domain: '.x.com', value: 'v1' }], T0);
  const later = mergeCookieSeen(first.store, 'default', [{ name: 'cf_clearance', domain: '.x.com', value: 'v1' }], T0 + 8_040_000);
  assert.equal(later.ages.get('default|.x.com|cf_clearance'), 8040); // 2h14m
  assert.equal(later.store['default|.x.com|cf_clearance'].firstSeen, first.store['default|.x.com|cf_clearance'].firstSeen);
});

test('mergeCookieSeen: 値が変われば firstSeen をリセットする(新しい clearance の発行を検出)', () => {
  const first = mergeCookieSeen({}, 'default', [{ name: 'cf_clearance', domain: '.x.com', value: 'v1' }], T0);
  const rotated = mergeCookieSeen(first.store, 'default', [{ name: 'cf_clearance', domain: '.x.com', value: 'v2' }], T0 + 60_000);
  assert.equal(rotated.ages.get('default|.x.com|cf_clearance'), 0);
  assert.equal(rotated.store['default|.x.com|cf_clearance'].firstSeen, new Date(T0 + 60_000).toISOString());
});

test('mergeCookieSeen: プロファイルが違えば別エントリになる', () => {
  const a = mergeCookieSeen({}, 'default', [{ name: 'sid', domain: 'x.com', value: 'v' }], T0);
  const b = mergeCookieSeen(a.store, 'work', [{ name: 'sid', domain: 'x.com', value: 'v' }], T0 + 1000);
  assert.equal(Object.keys(b.store).length, 2);
  assert.equal(b.ages.get('work|x.com|sid'), 0);
});
