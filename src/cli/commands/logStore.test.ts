import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countEvents, readEventsAll, readEventsTail } from './logStore';

/** 一時ディレクトリに events.jsonl を書いてコールバックへ渡す。 */
function withFixture(lines: string[], fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-logstore-'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const ev = (seq: number, cmd: string) => JSON.stringify({ seq, ts: '2026-07-10T00:00:00.000Z', type: 'command', cmd, ok: true });

test('countEvents: 非空行を数える(空行・末尾改行は無視)', () =>
  withFixture([ev(1, 'open'), '', ev(2, 'click'), ev(3, 'text')], async (dir) => {
    assert.equal(await countEvents(dir), 3);
  }));

test('countEvents: ファイルが無ければ 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-logstore-empty-'));
  try {
    assert.equal(await countEvents(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventsAll: 全件を順序どおり読む', () =>
  withFixture([ev(1, 'open'), ev(2, 'click')], async (dir) => {
    const all = await readEventsAll(dir);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((e: any) => e.cmd), ['open', 'click']);
  }));

test('readEventsAll: 壊れた行はスキップする', () =>
  withFixture([ev(1, 'open'), '{壊れたJSON', ev(2, 'click')], async (dir) => {
    const all = await readEventsAll(dir);
    assert.deepEqual(all.map((e: any) => e.cmd), ['open', 'click']);
  }));

test('readEventsTail: 末尾 N 件だけ返す(全件 slice(-N) と等価)', () =>
  withFixture([ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(5, 'e')], async (dir) => {
    const tail = await readEventsTail(dir, 2);
    assert.deepEqual(tail.map((e: any) => e.cmd), ['d', 'e']);
    const all = await readEventsAll(dir);
    assert.deepEqual(tail, all.slice(-2));
  }));

test('readEventsTail: limit が件数以上なら全件', () =>
  withFixture([ev(1, 'a'), ev(2, 'b')], async (dir) => {
    assert.deepEqual((await readEventsTail(dir, 10)).map((e: any) => e.cmd), ['a', 'b']);
  }));

test('readEventsTail: limit<=0 は全件', () =>
  withFixture([ev(1, 'a'), ev(2, 'b')], async (dir) => {
    assert.equal((await readEventsTail(dir, 0)).length, 2);
  }));
