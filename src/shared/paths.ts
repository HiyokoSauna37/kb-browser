import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** kb のホームディレクトリ。KB_HOME 環境変数で上書き可能(テスト用)。 */
export const KB_HOME = process.env.KB_HOME ?? path.join(os.homedir(), '.kb');

/** デーモンの接続情報ファイル(port / token / pid / buildId)。 */
export const DAEMON_INFO_PATH = path.join(KB_HOME, 'daemon.json');

/** ブラウザプロファイル(user-data-dir)の置き場。 */
export const PROFILES_DIR = path.join(KB_HOME, 'profiles');

/**
 * Cloudflare 等を通常 Chrome で人が通過してから kb へ引き継ぐ signup bootstrap の状態。
 * 状態 JSON と storageState checkpoint を signup 名ごとのディレクトリに置く。
 */
export const SIGNUPS_DIR = path.join(KB_HOME, 'signups');

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

/**
 * kb が Cookie の値を最初に観測した時刻(kb session check の「セッションの古さ」表示用)。
 * Cookie は発行時刻を持たないため、kb 自身の観測時刻で代用する。
 * **値そのものは保存せず、変化検知のための短いハッシュだけ**を持つ。
 */
export const COOKIE_SEEN_PATH = path.join(KB_HOME, 'cookie-seen.json');

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
  /** アイドル自動終了の閾値(秒)。0 は無効。自動 spawn が引き継ぐ。 */
  idleTimeoutSec?: number;
  /** Chrome 拡張機能。空配列 = プロファイル拡張の有効化のみ、要素 = 未パック拡張の絶対パス。 */
  extensions?: string[];
  /** タブ分離ホットキーのキーコンボ(例 "Alt+Shift+D")。自動 spawn が引き継ぐ。 */
  detachKey?: string;
  /** 翻訳トグルホットキーのキーコンボ(例 "Alt+Shift+T")。自動 spawn が引き継ぐ。 */
  translateKey?: string;
  /** HTTPS 証明書エラーを無視する。自動 spawn が引き継ぐ。 */
  ignoreHttpsErrors?: boolean;
}

export function ensureKbHome(): void {
  fs.mkdirSync(KB_HOME, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(SIGNUPS_DIR, { recursive: true });
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
    return {
      headless: !!raw.headless,
      profile: raw.profile || 'default',
      channel: raw.channel,
      userAgent: raw.userAgent,
      stealth: !!raw.stealth,
      idleTimeoutSec: typeof raw.idleTimeoutSec === 'number' ? raw.idleTimeoutSec : undefined,
      extensions: Array.isArray(raw.extensions) ? raw.extensions.filter((x) => typeof x === 'string') : undefined,
      detachKey: typeof raw.detachKey === 'string' && raw.detachKey ? raw.detachKey : undefined,
      translateKey: typeof raw.translateKey === 'string' && raw.translateKey ? raw.translateKey : undefined,
      ignoreHttpsErrors: !!raw.ignoreHttpsErrors,
    };
  } catch {
    return null;
  }
}

/** Cookie 値の初観測記録(キー: "<profile>|<domain>|<name>")。 */
export type CookieSeenStore = Record<string, { hash: string; firstSeen: string }>;

export function readCookieSeen(): CookieSeenStore {
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_SEEN_PATH, 'utf8')) as CookieSeenStore;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function writeCookieSeen(store: CookieSeenStore): void {
  ensureKbHome();
  try {
    fs.writeFileSync(COOKIE_SEEN_PATH, JSON.stringify(store, null, 2));
  } catch {
    /* 診断用の付加情報なので、書けなくても致命的ではない */
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
