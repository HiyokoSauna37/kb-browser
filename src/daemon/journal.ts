import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from '../shared/paths';
import type { OpEvent, SessionMeta } from '../shared/oplog';

/** ユニオン型の各メンバーに Omit を分配する(素の Omit はユニオンを潰してしまう)。 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * 操作ログのセッション別ジャーナル。KB_HOME/logs/<session>/ に
 * events.jsonl(1 行 1 イベント、逐次追記)と meta.json を書く。
 * 生ジャーナルは無改変で保存し、マスクは export / show 時(CLI 側)に適用する。
 */
export class Journal {
  private dir: string | null = null;
  private seq = 0;
  private meta: SessionMeta | null = null;

  /** セッションを開始する(既に開始済みなら閉じてから)。名前省略時はタイムスタンプ。 */
  start(name: string | undefined, base: Omit<SessionMeta, 'name' | 'startedAt'>): { name: string; dir: string } {
    if (this.dir) this.stop();
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
    return { name: n, dir };
  }

  /** セッションを終了する(meta に endedAt を記録)。 */
  stop(): { name: string | null; events: number } {
    const result = { name: this.meta?.name ?? null, events: this.seq };
    if (this.meta) {
      this.meta.endedAt = new Date().toISOString();
      this.writeMeta();
    }
    this.dir = null;
    this.meta = null;
    this.seq = 0;
    return result;
  }

  /** イベントを追記する(seq / ts はここで付与)。記録の失敗でデーモンを落とさない。 */
  append(event: DistributiveOmit<OpEvent, 'seq' | 'ts'>): void {
    if (!this.dir) return;
    try {
      const line = JSON.stringify({ seq: ++this.seq, ts: new Date().toISOString(), ...event });
      fs.appendFileSync(path.join(this.dir, 'events.jsonl'), line + '\n');
    } catch {
      /* logging must never kill the daemon */
    }
  }

  status(): { recording: boolean; name: string | null; events: number; dir: string | null } {
    return { recording: this.dir != null, name: this.meta?.name ?? null, events: this.seq, dir: this.dir };
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
