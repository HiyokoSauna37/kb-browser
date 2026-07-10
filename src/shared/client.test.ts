import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { isPidAlive, waitForPidDeath } from './client';

test('isPidAlive: 自プロセスは生存', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('waitForPidDeath: すぐ終わる子プロセスの消滅を検知して true', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true });
  const dead = await waitForPidDeath(child.pid!, 5_000, 50);
  assert.equal(dead, true);
  assert.equal(isPidAlive(child.pid!), false);
});

test('waitForPidDeath: 生き続ける pid はタイムアウトで false', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const dead = await waitForPidDeath(child.pid!, 400, 50);
    assert.equal(dead, false);
    assert.equal(isPidAlive(child.pid!), true);
  } finally {
    child.kill();
  }
});
