import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** kb のホームディレクトリ。KB_HOME 環境変数で上書き可能(テスト用)。 */
export const KB_HOME = process.env.KB_HOME ?? path.join(os.homedir(), '.kb');

/** デーモンの接続情報ファイル(port / token / pid / buildId)。 */
export const DAEMON_INFO_PATH = path.join(KB_HOME, 'daemon.json');

/** ブラウザプロファイル(user-data-dir)の置き場。 */
export const PROFILES_DIR = path.join(KB_HOME, 'profiles');

/** ダウンロードファイルの保存先。 */
export const DOWNLOADS_DIR = path.join(KB_HOME, 'downloads');

/** 操作ログ(kb log)のセッション置き場。<session>/events.jsonl + meta.json。 */
export const LOGS_DIR = path.join(KB_HOME, 'logs');

/** デーモンのログファイル。 */
export const DAEMON_LOG_PATH = path.join(KB_HOME, 'daemon.log');

/** 最後にデーモンを起動したときのオプション。自動 spawn 時に引き継ぐ。 */
export const LAST_RUN_PATH = path.join(KB_HOME, 'last-run.json');

/** デーモンの二重 spawn 防止ロック。 */
export const SPAWN_LOCK_PATH = path.join(KB_HOME, 'daemon.spawn.lock');

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  /** dist/daemon/main.js の mtime(ms)。CLI 側の再ビルド検知に使う。 */
  buildId?: number;
}

export interface LastRunOptions {
  headless: boolean;
  profile: string;
  /** 起動チャネルの明示指定 (chrome | msedge | chromium)。未指定は自動選択。 */
  channel?: 'chrome' | 'msedge' | 'chromium';
  /** context 全体の User-Agent 上書き。 */
  userAgent?: string;
  /** ステルスモード(navigator.webdriver 消し + 最小 init script)。 */
  stealth?: boolean;
}

export function ensureKbHome(): void {
  fs.mkdirSync(KB_HOME, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/**
 * ディスク上の dist/daemon/main.js の mtime(ms)。デーモンの再ビルド検知
 * (daemon.json の buildId との照合)に使う。読めなければ null。
 */
export function readDiskBuildId(): number | null {
  try {
    return Math.floor(fs.statSync(path.join(__dirname, '..', 'daemon', 'main.js')).mtimeMs);
  } catch {
    return null;
  }
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_INFO_PATH, 'utf8')) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureKbHome();
  fs.writeFileSync(DAEMON_INFO_PATH, JSON.stringify(info, null, 2));
}

export function removeDaemonInfo(): void {
  try {
    fs.unlinkSync(DAEMON_INFO_PATH);
  } catch {
    /* already gone */
  }
}

/**
 * daemon.json が自分(pid)のものであるときだけ削除する。
 * 二重起動に負けたデーモンが、勝ったデーモンの接続情報を消してしまう事故を防ぐ。
 */
export function removeDaemonInfoIfOwned(pid: number): void {
  const info = readDaemonInfo();
  if (info && info.pid !== pid) return;
  removeDaemonInfo();
}

export function readLastRun(): LastRunOptions | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf8')) as LastRunOptions;
    return { headless: !!raw.headless, profile: raw.profile || 'default', channel: raw.channel, userAgent: raw.userAgent, stealth: !!raw.stealth };
  } catch {
    return null;
  }
}

export function writeLastRun(opts: LastRunOptions): void {
  ensureKbHome();
  try {
    fs.writeFileSync(LAST_RUN_PATH, JSON.stringify(opts, null, 2));
  } catch {
    /* 起動オプションの記録失敗は致命的ではない */
  }
}
