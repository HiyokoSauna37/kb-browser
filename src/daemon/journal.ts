import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from '../shared/paths';
import type { OpEvent, SessionMeta } from '../shared/oplog';

/** ユニオン型の各メンバーに Omit を分配する(素の Omit はユニオンを潰してしまう)。 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * 古いセッションを削除して直近 keep 件だけ残す(生ジャーナルには機微な値が
 * 平文で残るため、無期限に溜め込まない)。デーモン起動時に呼ぶ。
 */
export function pruneLogSessions(keep: number): { pruned: string[] } {
  const pruned: string[] = [];
  let entries: { name: string; mtime: number }[] = [];
  try {
    entries = fs
      .readdirSync(LOGS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(LOGS_DIR, e.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, 'events.jsonl')).mtimeMs;
        } catch {
          try {
            mtime = fs.statSync(dir).mtimeMs;
          } catch {
            /* 読めないものは最古扱い */
          }
        }
        return { name: e.name, mtime };
      });
  } catch {
    return { pruned };
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(Math.max(0, keep))) {
    try {
      fs.rmSync(path.join(LOGS_DIR, old.name), { recursive: true, force: true });
      pruned.push(old.name);
    } catch {
      /* 消せないものは残す */
    }
  }
  return { pruned };
}

/**
 * 操作ログのセッション別ジャーナル。KB_HOME/logs/<session>/ に
 * events.jsonl(1 行 1 イベント、逐次追記)と meta.json を書く。
 * 生ジャーナルは無改変で保存し、マスクは export / show 時(CLI 側)に適用する。
 */
export class Journal {
  private dir: string | null = null;
  private seq = 0;
  private meta: SessionMeta | null = null;
  /** アクション実行後に自動スクリーンショットを撮るか(kb log start --shots)。 */
  autoShots = false;
  private shotCounter = 0;
  /**
   * 未書き込みのイベント行バッファ。net/console のような高頻度イベントは溜めておき、
   * replay/report に効く command イベント境界(と stop / 500ms タイマ)でまとめて
   * flush する。ハードクラッシュ時の喪失は「直近 command 以降の net/console」に限定される。
   */
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** セッションを開始する(既に開始済みなら閉じてから)。名前省略時はタイムスタンプ。 */
  start(
    name: string | undefined,
    base: Omit<SessionMeta, 'name' | 'startedAt'>,
    opts: { shots?: boolean } = {},
  ): { name: string; dir: string; shots: boolean } {
    if (this.dir) this.stop();
    this.autoShots = !!opts.shots;
    this.shotCounter = 0;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let n = (name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || `s-${stamp}`;
    // 既存セッションと衝突したら連番を振る(上書き防止)
    let dir = path.join(LOGS_DIR, n);
    for (let i = 2; fs.existsSync(dir); i++) {
      dir = path.join(LOGS_DIR, `${n}-${i}`);
      if (!fs.existsSync(dir)) n = `${n}-${i}`;
    }
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.seq = 0;
    this.meta = { name: n, startedAt: new Date().toISOString(), ...base };
    this.writeMeta();
    return { name: n, dir, shots: this.autoShots };
  }

  /** セッションを終了する(meta に endedAt を記録)。 */
  stop(): { name: string | null; events: number } {
    this.flush(); // dir を落とす前に未書き込みを吐き切る
    const result = { name: this.meta?.name ?? null, events: this.seq };
    if (this.meta) {
      this.meta.endedAt = new Date().toISOString();
      this.writeMeta();
    }
    this.dir = null;
    this.meta = null;
    this.seq = 0;
    this.autoShots = false;
    return result;
  }

  /** 自動スクリーンショットの保存先を発番する(セッション未開始なら null)。 */
  nextShotPath(): { abs: string; rel: string } | null {
    if (!this.dir) return null;
    try {
      fs.mkdirSync(path.join(this.dir, 'shots'), { recursive: true });
    } catch {
      return null;
    }
    const rel = `shots/auto-${++this.shotCounter}.png`;
    return { abs: path.join(this.dir, rel), rel };
  }

  /**
   * イベントをバッファに積む(seq / ts はここで付与)。command イベントは即 flush して
   * replay/report に必要な記録を durable にし、それ以外(net/console)は溜めて
   * command 境界・500ms タイマ・stop でまとめて書く。記録の失敗でデーモンは落とさない。
   */
  append(event: DistributiveOmit<OpEvent, 'seq' | 'ts'>): void {
    if (!this.dir) return;
    this.buffer.push(JSON.stringify({ seq: ++this.seq, ts: new Date().toISOString(), ...event }));
    if (event.type === 'command') {
      this.flush();
    } else if (!this.flushTimer) {
      // アイドル中でもいずれ吐き切るよう保険のタイマを 1 本だけ張る(unref でプロセスを延命しない)。
      this.flushTimer = setTimeout(() => this.flush(), 500);
      this.flushTimer.unref?.();
    }
  }

  /** バッファ済みのイベント行をまとめて 1 回で追記する。 */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dir || !this.buffer.length) return;
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    try {
      fs.appendFileSync(path.join(this.dir, 'events.jsonl'), chunk);
    } catch {
      /* logging must never kill the daemon */
    }
  }

  status(): { recording: boolean; name: string | null; events: number; dir: string | null; shots: boolean } {
    return { recording: this.dir != null, name: this.meta?.name ?? null, events: this.seq, dir: this.dir, shots: this.autoShots };
  }

  private writeMeta(): void {
    if (!this.dir || !this.meta) return;
    try {
      fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2));
    } catch {
      /* same as above */
    }
  }
}
