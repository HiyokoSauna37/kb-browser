import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOwnedDaemons, type ProcInfo } from './procscan';

// テストは win32(norm が lowercase)/ posix(norm が identity)双方で通るよう、
// profilesDir と cmd 内の user-data-dir を同一表記(小文字・forward slash)で書く。
const PROFILES = '/home/u/.kb/profiles';

test('findOwnedDaemons: 子 Chromium が profilesDir 配下ならデーモンを所有と判定', () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, cmd: 'node /app/dist/daemon/main.js --profile default --headless' },
    { pid: 101, ppid: 100, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/default --headless' },
    { pid: 102, ppid: 101, cmd: 'chrome --type=renderer' }, // renderer は user-data-dir 無し
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), [100]);
});

test('findOwnedDaemons: 別 KB_HOME の子を持つデーモンは所有しない', () => {
  const procs: ProcInfo[] = [
    { pid: 200, ppid: 1, cmd: 'node /app/dist/daemon/main.js' },
    { pid: 201, ppid: 200, cmd: 'chrome --user-data-dir=/other/.kb/profiles/default' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), []);
});

test('findOwnedDaemons: 子をまだ持たないデーモンは(所有確認できないので)除外', () => {
  const procs: ProcInfo[] = [{ pid: 300, ppid: 1, cmd: 'node /app/dist/daemon/main.js' }];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), []);
});

test('findOwnedDaemons: selfPid は対象外(自プロセス誤爆防止)', () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, cmd: 'node /app/dist/daemon/main.js' },
    { pid: 101, ppid: 100, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/default' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 100), []);
});

test('findOwnedDaemons: 孫(gpu/renderer)から祖先のデーモンへ辿れる', () => {
  const procs: ProcInfo[] = [
    { pid: 300, ppid: 1, cmd: 'node /app/dist/daemon/main.js' },
    { pid: 301, ppid: 300, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/p1' }, // browser
    { pid: 302, ppid: 301, cmd: 'chrome --type=gpu-process --user-data-dir=/home/u/.kb/profiles/p1' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), [300]);
});

test('findOwnedDaemons: 複数デーモンのうち自 KB_HOME のものだけ返す', () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, cmd: 'node /app/dist/daemon/main.js' },
    { pid: 101, ppid: 100, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/default' },
    { pid: 200, ppid: 1, cmd: 'node /app/dist/daemon/main.js' },
    { pid: 201, ppid: 200, cmd: 'chrome --user-data-dir=/other/.kb/profiles/default' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), [100]);
});

test('findOwnedDaemons: バックスラッシュ区切りのデーモン cmd も一致する', () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, cmd: 'node c:/app/dist\\daemon\\main.js' },
    { pid: 101, ppid: 100, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/default' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), [100]);
});

test('findOwnedDaemons: kb 以外の node プロセスは無視する', () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, cmd: 'node /app/server.js' },
    { pid: 101, ppid: 100, cmd: 'chrome --user-data-dir=/home/u/.kb/profiles/default' },
  ];
  assert.deepEqual(findOwnedDaemons(procs, PROFILES, 999), []);
});
