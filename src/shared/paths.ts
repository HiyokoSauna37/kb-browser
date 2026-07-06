import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** kb のホームディレクトリ。KB_HOME 環境変数で上書き可能(テスト用)。 */
export const KB_HOME = process.env.KB_HOME ?? path.join(os.homedir(), '.kb');

/** デーモンの接続情報ファイル(port / token / pid)。 */
export const DAEMON_INFO_PATH = path.join(KB_HOME, 'daemon.json');

/** ブラウザプロファイル(user-data-dir)の置き場。 */
export const PROFILES_DIR = path.join(KB_HOME, 'profiles');

/** デーモンのログファイル。 */
export const DAEMON_LOG_PATH = path.join(KB_HOME, 'daemon.log');

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

export function ensureKbHome(): void {
  fs.mkdirSync(KB_HOME, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
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
