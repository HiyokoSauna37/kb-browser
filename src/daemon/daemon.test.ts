import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './daemon';

const argv = (...flags: string[]) => ['node', 'main.js', ...flags];

test('parseArgs: 既定値(フラグなし)', () => {
  const c = parseArgs(argv(), {});
  assert.equal(c.headless, false);
  assert.equal(c.profile, 'default');
  assert.equal(c.channel, undefined);
  assert.equal(c.userAgent, undefined);
  assert.equal(c.cdpUrl, undefined);
  assert.equal(c.stealth, false);
  assert.equal(c.ignoreHttpsErrors, false);
  assert.equal(c.extensions, undefined);
  assert.equal(c.idleMs, 30 * 60_000); // 既定 30 分
  assert.equal(c.idleTimeoutSec, 1800);
  assert.equal(c.idleLastRunSec, undefined); // 既定は last-run に焼かない
});

test('parseArgs: 各フラグを解決する', () => {
  const c = parseArgs(argv('--headless', '--profile', 'work', '--channel', 'chrome', '--ua', 'MyUA', '--stealth', '--ignore-https-errors'), {});
  assert.equal(c.headless, true);
  assert.equal(c.profile, 'work');
  assert.equal(c.channel, 'chrome');
  assert.equal(c.userAgent, 'MyUA');
  assert.equal(c.stealth, true);
  assert.equal(c.ignoreHttpsErrors, true);
});

test('parseArgs: --cdp(アタッチ)', () => {
  const c = parseArgs(argv('--cdp', 'http://127.0.0.1:9222'), {});
  assert.equal(c.cdpUrl, 'http://127.0.0.1:9222');
});

test('parseArgs: --extensions on は空配列、csv は分解', () => {
  assert.deepEqual(parseArgs(argv('--extensions', 'on'), {}).extensions, []);
  assert.deepEqual(parseArgs(argv('--extensions', '/a,/b'), {}).extensions, ['/a', '/b']);
});

test('parseArgs: --idle-timeout(秒)は last-run に焼く', () => {
  const c = parseArgs(argv('--idle-timeout', '60'), {});
  assert.equal(c.idleMs, 60_000);
  assert.equal(c.idleTimeoutSec, 60);
  assert.equal(c.idleLastRunSec, 60); // 明示指定なので焼く
});

test('parseArgs: env KB_IDLE_TIMEOUT は使うが last-run には焼かない', () => {
  const c = parseArgs(argv(), { KB_IDLE_TIMEOUT: '120' });
  assert.equal(c.idleMs, 120_000);
  assert.equal(c.idleTimeoutSec, 120);
  assert.equal(c.idleLastRunSec, undefined); // env 由来は焼かない(次回 spawn で env を潰さないため)
});

test('parseArgs: --idle-timeout は env より優先される', () => {
  const c = parseArgs(argv('--idle-timeout', '30'), { KB_IDLE_TIMEOUT: '120' });
  assert.equal(c.idleTimeoutSec, 30);
  assert.equal(c.idleLastRunSec, 30);
});

test('parseArgs: --idle-timeout 0 は無効(idleMs 0)だが明示なので焼く', () => {
  const c = parseArgs(argv('--idle-timeout', '0'), {});
  assert.equal(c.idleMs, 0);
  assert.equal(c.idleTimeoutSec, 0);
  assert.equal(c.idleLastRunSec, 0);
});
