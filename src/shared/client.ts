import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  DAEMON_LOG_PATH,
  readDaemonInfo,
  removeDaemonInfo,
  type DaemonInfo,
} from './paths';

/** デーモンへの RPC クライアント。CLI と MCP サーバの両方から使う。 */

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

export async function pingDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  try {
    await rpcRaw(info, 'daemon.status');
    return info;
  } catch {
    removeDaemonInfo(); // 接続できない = 情報が古い
    return null;
  }
}

export function spawnDaemon(opts: { headless?: boolean; profile?: string } = {}): void {
  const daemonJs = path.join(__dirname, '..', 'daemon', 'main.js');
  const args = [daemonJs];
  if (opts.headless) args.push('--headless');
  if (opts.profile) args.push('--profile', opts.profile);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export async function waitForDaemon(): Promise<DaemonInfo> {
  const deadline = Date.now() + 30_000; // 初回はブラウザ起動が遅いことがある
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = await pingDaemon();
    if (info) return info;
  }
  throw new Error(`デーモンの起動がタイムアウトしました。ログを確認してください: ${DAEMON_LOG_PATH}`);
}

/** デーモンに RPC を送る。未起動なら自動起動して待つ。 */
export async function rpc(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  let info = await pingDaemon();
  if (!info) {
    spawnDaemon();
    info = await waitForDaemon();
  }
  return rpcRaw(info, cmd, args);
}
