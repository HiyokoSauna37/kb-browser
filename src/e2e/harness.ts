import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree } from '../daemon/procscan';

/**
 * e2e スモークテスト用のデーモン起動ハーネス。
 *
 * shared/client.ts は KB_HOME をモジュールロード時に固定する(shared/paths.ts)ため、
 * テストからは client を経由せず、デーモンを隔離した KB_HOME の子プロセスとして直接
 * spawn し、daemon.json をポーリングして生 fetch で RPC を叩く。実デーモンの起動〜
 * RPC〜停止の経路をクライアント実装から独立に検証できる。
 */

export interface E2EDaemon {
  port: number;
  token: string;
  pid: number;
  home: string;
  child: ChildProcess;
}

/** 起動可能なブラウザがあるか。無い環境(CI 等)ではスイートごと skip する。 */
export function browserAvailable(): boolean {
  try {
    // eslint 不使用のため require で遅延ロード(playwright の型は不要)
    const { chromium } = require('playwright') as typeof import('playwright');
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return true;
  } catch {
    /* 同梱 chromium なし → システムブラウザを探す */
  }
  if (process.platform === 'win32') {
    const bases = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']];
    return bases.some(
      (b) =>
        b &&
        (fs.existsSync(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
          fs.existsSync(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))),
    );
  }
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/Google Chrome.app');
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some((p) => fs.existsSync(p));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** プロセス異常終了でも孤児 Chromium を残さないための最終保険(process 'exit' は同期処理のみ可)。 */
const spawnedPids = new Set<number>();
process.on('exit', () => {
  for (const pid of spawnedPids) {
    if (isPidAlive(pid)) killTree(pid);
  }
});

/** 隔離 KB_HOME でデーモンを起動し、接続情報が書かれるまで待つ。 */
export async function startDaemon(extraArgs: string[] = []): Promise<E2EDaemon> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  const daemonJs = path.join(__dirname, '..', 'daemon', 'main.js');
  const child = spawn(process.execPath, [daemonJs, '--headless', '--profile', 'default', ...extraArgs], {
    env: {
      ...process.env,
      KB_HOME: home,
      KB_IDLE_TIMEOUT: '0', // テスト中に idle reaper が発火しないように無効化
      KB_RELAY_NOAUTH: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  if (child.pid != null) spawnedPids.add(child.pid);

  const infoPath = path.join(home, 'daemon.json');
  const deadline = Date.now() + 60_000; // 初回はブラウザ起動が遅いことがある
  for (;;) {
    if (child.exitCode != null) {
      throw new Error(`デーモンが起動前に終了しました (exit=${child.exitCode})。ログ: ${daemonLogTail(home)}`);
    }
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { port: number; token: string; pid: number };
      if (info.port && info.token) return { ...info, home, child };
    } catch {
      /* まだ書かれていない */
    }
    if (Date.now() > deadline) {
      throw new Error(`デーモンの起動がタイムアウトしました。ログ: ${daemonLogTail(home)}`);
    }
    await sleep(200);
  }
}

function daemonLogTail(home: string, lines = 15): string {
  try {
    const raw = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8');
    return '\n' + raw.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(ログなし)';
  }
}

/** 生 fetch でデーモンに RPC を送る(client.ts 非依存)。 */
export async function rpc(d: E2EDaemon, cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${d.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kb-token': d.token },
    body: JSON.stringify({ cmd, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'unknown daemon error');
  return body.result;
}

/**
 * デーモンを停止し、プロセスツリーの消滅と一時 KB_HOME の削除まで面倒を見る。
 * graceful (daemon.stop) → pid 死亡待ち → 残っていれば killTree の 3 段構え。
 */
export async function stopDaemon(d: E2EDaemon): Promise<void> {
  try {
    await rpc(d, 'daemon.stop');
  } catch {
    /* 既に死んでいる場合など */
  }
  for (let i = 0; i < 50 && isPidAlive(d.pid); i++) await sleep(200);
  if (isPidAlive(d.pid)) killTree(d.pid);
  for (let i = 0; i < 25 && isPidAlive(d.pid); i++) await sleep(200);
  spawnedPids.delete(d.pid);
  // Chromium がプロファイルのロックを離すまで少し粘る(Windows のファイルロック対策)
  try {
    fs.rmSync(d.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* 一時ディレクトリの削除失敗は致命的ではない */
  }
}
