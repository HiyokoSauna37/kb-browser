import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IDLE_MINUTES, IdleReaper, resolveIdleTimeoutMs } from './idle';

test('resolveIdleTimeoutMs: 未指定は既定(分)', () => {
  assert.equal(resolveIdleTimeoutMs(undefined, undefined), DEFAULT_IDLE_MINUTES * 60_000);
  assert.equal(resolveIdleTimeoutMs('', ''), DEFAULT_IDLE_MINUTES * 60_000); // 空文字は未指定扱い
});

test('resolveIdleTimeoutMs: 引数(秒)を ms にする', () => {
  assert.equal(resolveIdleTimeoutMs('60', undefined), 60_000);
  assert.equal(resolveIdleTimeoutMs('2', undefined), 2_000);
});

test('resolveIdleTimeoutMs: 引数がなければ環境変数(秒)を使う', () => {
  assert.equal(resolveIdleTimeoutMs(undefined, '3'), 3_000);
});

test('resolveIdleTimeoutMs: 引数が環境変数より優先される', () => {
  assert.equal(resolveIdleTimeoutMs('5', '2'), 5_000);
});

test('resolveIdleTimeoutMs: 0 は無効(自動終了しない)', () => {
  assert.equal(resolveIdleTimeoutMs('0', undefined), 0);
  assert.equal(resolveIdleTimeoutMs(undefined, '0'), 0);
});

test('resolveIdleTimeoutMs: 負値・非数は既定へフォールバック', () => {
  assert.equal(resolveIdleTimeoutMs('-1', undefined), DEFAULT_IDLE_MINUTES * 60_000);
  assert.equal(resolveIdleTimeoutMs('abc', undefined), DEFAULT_IDLE_MINUTES * 60_000);
});

test('resolveIdleTimeoutMs: 既定分数は差し替え可能', () => {
  assert.equal(resolveIdleTimeoutMs(undefined, undefined, 10), 600_000);
});

test('IdleReaper.isIdle: 閾値到達で idle 判定になる', () => {
  const r = new IdleReaper(5_000, () => {}, 1_000);
  assert.equal(r.isIdle(1_000 + 4_999), false);
  assert.equal(r.isIdle(1_000 + 5_000), true); // 境界は idle 扱い(>=)
});

test('IdleReaper.touch: 活動でタイマーがリセットされる', () => {
  const r = new IdleReaper(5_000, () => {}, 1_000);
  assert.equal(r.isIdle(1_000 + 5_000), true);
  r.touch(10_000);
  assert.equal(r.isIdle(10_000 + 4_999), false);
  assert.equal(r.isIdle(10_000 + 5_000), true);
});

test('IdleReaper: timeoutMs<=0 は無効(常に非 idle)', () => {
  const r = new IdleReaper(0, () => {}, 0);
  assert.equal(r.enabled, false);
  assert.equal(r.isIdle(1_000_000_000), false);
  r.start(); // 何も起きない(タイマーを作らない)
  r.stop();
});

test('IdleReaper: start→無活動で onIdle が一度だけ呼ばれる(実タイマー)', async () => {
  let calls = 0;
  const r = new IdleReaper(40, () => calls++); // 閾値 40ms、確認間隔は 250ms 下限にクランプ
  r.start();
  await new Promise((res) => setTimeout(res, 600));
  r.stop();
  assert.equal(calls, 1);
});

test('IdleReaper: isBusy の間は閾値超過でも発火しない(実行中 RPC の保護)', async () => {
  let calls = 0;
  const r = new IdleReaper(40, () => calls++);
  let busy = true;
  r.isBusy = () => busy;
  r.start();
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(calls, 0); // busy 中は発火しない
  busy = false;
  r.touch(); // 契約: busy 解除側(RPC 完了)が touch して起点し直す
  await new Promise((res) => setTimeout(res, 600));
  r.stop();
  assert.equal(calls, 1); // 解除+無活動で通常どおり一度だけ発火
});

test('IdleReaper: touch で延命され onIdle が呼ばれない', async () => {
  let calls = 0;
  const r = new IdleReaper(300, () => calls++);
  r.start();
  // 確認間隔(clamp 後 250ms)より短く touch し続けて延命する
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 120));
    r.touch();
  }
  assert.equal(calls, 0);
  r.stop();
});
