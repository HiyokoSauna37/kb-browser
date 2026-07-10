import { spawnSync } from 'node:child_process';

/**
 * 孤児 kb デーモンの検出と停止(`kb daemon stop --all`)。
 *
 * daemon.json に登録された生存デーモンは通常の graceful stop で止まるが、SIGKILL/OOM や
 * KB_HOME の削除で登録が外れた「孤児デーモン」は `kb daemon stop` では止められない。
 * ここではプロセス一覧からコマンドライン(dist/daemon/main.js)で kb デーモンを列挙し、
 * その子 Chromium の `--user-data-dir` が **この KB_HOME の profiles ディレクトリ配下** で
 * あるものだけを「所有」とみなして子ごとツリーキルする(他 KB_HOME の正常デーモンや
 * 自プロセスを誤爆しない)。
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
}

/** node ... dist/daemon/main.js を指すデーモン本体のコマンドライン。 */
const DAEMON_RE = /daemon[\\/]main\.js/i;

function norm(s: string): string {
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * プロセス一覧から「この KB_HOME に属する kb デーモン」の pid を抽出する。
 *
 * 2 経路で同定する:
 *  (1) デーモン本体の argv に焼かれた `--home <KB_HOME>` マーカー(homeMarker)で直接一致させる。
 *      子 Chromium の生死に依存しないため、Chromium が先に死んで node だけ残った孤児も掴める
 *      (client.ts の spawnDaemon が付与。これがこのバージョンの主経路)。
 *  (2) マーカーを持たない旧バージョン起動のデーモン向けの後方互換: profilesDir を `--user-data-dir`
 *      に含む Chromium プロセスから祖先を辿ってデーモン本体を特定する(子が生きている場合のみ)。
 *
 * 所有を確認できないデーモン(他 KB_HOME / マーカーなし かつ 子を生成していない)は誤爆を避けて
 * 除外する。selfPid(および呼び出し元自身)は対象外。純関数なのでユニットテスト可能。
 */
export function findOwnedDaemons(procs: ProcInfo[], profilesDir: string, selfPid: number, homeMarker?: string): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const needle = norm(profilesDir);
  const isDaemon = (p: ProcInfo): boolean => p.pid !== selfPid && DAEMON_RE.test(p.cmd);
  const owned = new Set<number>();

  // (1) --home <KB_HOME> マーカーでデーモンを直接同定する(子 Chromium の有無に依存しない)。
  if (homeMarker) {
    const home = norm(homeMarker);
    for (const p of procs) if (isDaemon(p) && norm(p.cmd).includes(home)) owned.add(p.pid);
  }

  // (2) 後方互換: profilesDir を参照する Chromium(や子孫)から、祖先方向に最初のデーモンを探す。
  for (const p of procs) {
    if (!norm(p.cmd).includes(needle)) continue;
    let cur: ProcInfo | undefined = p;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      if (isDaemon(cur)) {
        owned.add(cur.pid);
        break;
      }
      cur = byPid.get(cur.ppid);
    }
  }

  return [...owned];
}

/** OS のプロセス一覧(pid / ppid / コマンドライン)を取得する。取得不能なら空配列。 */
export function listProcesses(): ProcInfo[] {
  return process.platform === 'win32' ? listWindows() : listPosix();
}

function listWindows(): ProcInfo[] {
  // WMIC は Win11 で廃止のため CIM を使う。CommandLine が null のプロセスもある(cmd="")。
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { ' +
    '[pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine } } | ' +
    'ConvertTo-Json -Compress';
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    const rows: any[] = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((r) => ({ pid: Number(r.pid), ppid: Number(r.ppid), cmd: String(r.cmd ?? '') }))
      .filter((r) => Number.isFinite(r.pid) && r.pid > 0);
  } catch {
    return [];
  }
}

function listPosix(): ProcInfo[] {
  const res = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return [];
  const out: ProcInfo[] = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

/** プロセスを子孫ごと停止する(Windows: taskkill /T /F、POSIX: プロセスグループ kill)。 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    // デーモンは detached 起動(pgid = pid)なので、グループごと落とせば子 Chromium も死ぬ。
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}
