import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DAEMON_INFO_PATH,
  DAEMON_LOG_PATH,
  SPAWN_LOCK_PATH,
  ensureKbHome,
  readDaemonInfo,
  readLastRun,
  removeDaemonInfo,
  type DaemonInfo,
} from './paths';

/** デーモンへの RPC クライアント。CLI と MCP サーバの両方から使う。 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function rpcRaw(info: DaemonInfo, cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kb-token': info.token },
    body: JSON.stringify({ cmd, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'unknown daemon error');
  return body.result;
}

let warnedStaleBuild = false;

/** デーモンが再ビルド前の古い dist で動いている場合に一度だけ警告する。 */
function warnIfStaleBuild(info: DaemonInfo): void {
  if (warnedStaleBuild || !info.buildId) return;
  try {
    const current = Math.floor(fs.statSync(path.join(__dirname, '..', 'daemon', 'main.js')).mtimeMs);
    if (current !== info.buildId) {
      warnedStaleBuild = true;
      console.error('警告: デーモンは再ビルド前の古いコードで動作しています。`kb daemon stop` 後に再実行すると反映されます。');
    }
  } catch {
    /* 警告用の補助チェックにすぎない */
  }
}

/**
 * デーモンの生存確認。
 * - 応答あり → 接続情報を返す
 * - 応答なし + pid 死亡 → stale と判断して daemon.json を削除し null
 * - 応答なし + pid 生存 → 一時的な無応答の可能性があるためリトライし、それでもだめならエラー
 *   (生きているデーモンの daemon.json を消して二重起動を招かないため)
 */
export async function pingDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      await rpcRaw(info, 'daemon.status');
      warnIfStaleBuild(info);
      return info;
    } catch {
      if (!isPidAlive(info.pid)) {
        removeDaemonInfo();
        return null;
      }
      if (attempt >= 1) {
        throw new Error(
          `デーモン (pid=${info.pid}) が応答しません。プロセスを終了するか、${DAEMON_INFO_PATH} を削除してから再実行してください。`,
        );
      }
      await sleep(500);
    }
  }
}

/**
 * 二重 spawn 防止ロックを取る。既に別プロセスが新鮮なロックを持っていれば false
 * (その場合は spawn せず waitForDaemon で相手のデーモンを待てばよい)。
 */
function acquireSpawnLock(): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(SPAWN_LOCK_PATH, 'utf8')) as { pid: number; ts: number };
    if (Date.now() - lock.ts < 30_000 && lock.pid !== process.pid && isPidAlive(lock.pid)) return false;
  } catch {
    /* ロックなし or 壊れている → 取得へ */
  }
  try {
    ensureKbHome();
    fs.writeFileSync(SPAWN_LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    /* ロックが書けなくても spawn 自体は続行する */
  }
  return true;
}

export function releaseSpawnLock(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(SPAWN_LOCK_PATH, 'utf8')) as { pid: number };
    if (lock.pid === process.pid) fs.unlinkSync(SPAWN_LOCK_PATH);
  } catch {
    /* already gone */
  }
}

/**
 * デーモンを起動する。オプション未指定の項目は前回起動時の値 (last-run.json) を引き継ぐ
 * (自動 spawn で default プロファイル・headed に化けるのを防ぐ)。
 * 別プロセスが spawn 中ならスキップして待つだけにする。
 */
export function spawnDaemon(
  opts: { headless?: boolean; profile?: string; channel?: string; userAgent?: string; cdpUrl?: string } = {},
): void {
  const last = readLastRun();
  const merged = {
    headless: opts.headless ?? last?.headless ?? false,
    profile: opts.profile ?? last?.profile ?? 'default',
    channel: opts.channel ?? last?.channel,
    userAgent: opts.userAgent ?? last?.userAgent,
  };
  if (!acquireSpawnLock()) return;
  const daemonJs = path.join(__dirname, '..', 'daemon', 'main.js');
  const args = [daemonJs];
  if (merged.headless) args.push('--headless');
  args.push('--profile', merged.profile);
  if (merged.channel) args.push('--channel', merged.channel);
  if (merged.userAgent) args.push('--ua', merged.userAgent);
  // アタッチは明示起動 (kb daemon start --cdp) のみ。last-run からは継承しない
  if (opts.cdpUrl) args.push('--cdp', opts.cdpUrl);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function daemonLogTail(lines = 12): string {
  try {
    const raw = fs.readFileSync(DAEMON_LOG_PATH, 'utf8');
    return raw.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(ログなし)';
  }
}

export async function waitForDaemon(): Promise<DaemonInfo> {
  const deadline = Date.now() + 30_000; // 初回はブラウザ起動が遅いことがある
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      const info = await pingDaemon();
      if (info) return info;
    } catch {
      /* 起動待ちの間は無応答を許容してポーリングを続ける */
    }
  }
  throw new Error(
    `デーモンの起動がタイムアウトしました。デーモンログの末尾:\n${daemonLogTail()}\n(全文: ${DAEMON_LOG_PATH})`,
  );
}

/** デーモンに RPC を送る。未起動なら自動起動して待つ。 */
export async function rpc(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  let info = await pingDaemon();
  if (!info) {
    try {
      spawnDaemon();
      info = await waitForDaemon();
    } finally {
      releaseSpawnLock();
    }
  }
  return rpcRaw(info, cmd, args);
}
