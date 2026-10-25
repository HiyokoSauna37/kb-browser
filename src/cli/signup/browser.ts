import { spawn } from 'node:child_process';
import { findProfileBrowserProcess, findProfileProcesses, listProcesses } from '../../daemon/procscan';
import { isPidAlive, pingDaemon, rpcRaw } from '../../shared/client';
import { signupProfilePath } from '../../shared/signup';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ProcessRows = ReturnType<typeof listProcesses>;

let processSnapshot: { at: number; rows: ProcessRows } | undefined;

function currentProcesses(): ProcessRows {
  const now = Date.now();
  if (!processSnapshot || now - processSnapshot.at > 500) {
    processSnapshot = { at: now, rows: listProcesses() };
  }
  return processSnapshot.rows;
}

/** signup 専用 profile を現在保持しているブラウザプロセスを返す。 */
export function signupProfileProcessPids(profile: string, bootstrapPid?: number): number[] {
  const rows = currentProcesses();
  const pids = findProfileProcesses(rows, signupProfilePath(profile), process.pid);
  if (bootstrapPid && isPidAlive(bootstrapPid) && !pids.includes(bootstrapPid)) {
    const row = rows.find((proc) => proc.pid === bootstrapPid);
    // プロセス一覧そのものが取れないか CommandLine が権限上読めない場合だけ、起動時 PID を
    // fallback に使う。PID が別の通常プロセスへ再利用された場合は profile 使用中と誤判定しない。
    if (rows.length === 0 || !row?.cmd) pids.unshift(bootstrapPid);
  }
  return pids;
}

/** 通常ブラウザと kb が同じ profile を同時利用しないための事前条件。 */
export async function requireSignupDaemonStopped(): Promise<void> {
  const info = await pingDaemon();
  if (!info) return;
  const status = await rpcRaw(info, 'daemon.status').catch(() => null);
  const detail = status ? ` (profile=${status.profile}, pid=${info.pid})` : ` (pid=${info.pid})`;
  throw new Error(
    `signup bootstrap/adopt は通常 Chrome と kb が profile を奪い合わないよう、デーモン停止中だけ実行できます${detail}。` +
      '`kb daemon stop` 後に再実行してください。',
  );
}

/** Playwright/CDP を介さず、ユーザーが操作する通常ブラウザを起動する。 */
export async function launchSignupBrowser(executable: string, args: string[], profile: string): Promise<number> {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    // signup は人が操作するブラウザなので、Windows でもウィンドウを隠さない。
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  // Windows Chrome は既存の Chrome プロセスへ起動要求を渡し、spawn した親自身は
  // exit=0 で即終了することがある。PID 生存ではなく user-data-dir の実利用を一次情報にする。
  await delay(700);
  let profilePids: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    processSnapshot = undefined;
    profilePids = signupProfileProcessPids(profile);
    if (profilePids.length || child.exitCode == null) break;
    await delay(300);
  }
  if (child.exitCode != null && profilePids.length === 0) {
    throw new Error(`通常ブラウザが起動直後に終了し、profile を保持するプロセスも見つかりませんでした(exit=${child.exitCode})`);
  }
  const pid =
    findProfileBrowserProcess(currentProcesses(), signupProfilePath(profile), process.pid) ??
    profilePids[0] ??
    child.pid;
  if (!pid) throw new Error('通常ブラウザの PID を取得できませんでした');
  child.unref();
  return pid;
}
