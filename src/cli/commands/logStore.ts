import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { OpEvent } from '../../shared/oplog';

/**
 * 操作ジャーナル(events.jsonl)のストリーミング読み取り。
 * 巨大なセッションでも全文を一度にメモリへ載せないよう readline で 1 行ずつ処理する:
 *   - countEvents: 件数だけ要る list 用(JSON.parse しない)
 *   - readEventsTail: 末尾 N 件だけ要る show -n 用(リングバッファで O(N) メモリ)
 *   - readEventsAll: 全件要る steps/export/replay 用
 */

function eventsPath(dir: string): string {
  return path.join(dir, 'events.jsonl');
}

/** events.jsonl を 1 行ずつ流す(ファイルが無ければ何も流さない)。 */
async function* readLines(dir: string): AsyncGenerator<string> {
  const file = eventsPath(dir);
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

/** イベント件数(非空行数)。全件を parse せずに数える(list 用)。 */
export async function countEvents(dir: string): Promise<number> {
  let n = 0;
  for await (const line of readLines(dir)) if (line.trim()) n++;
  return n;
}

/** 全イベントを読む(steps / export / replay 用)。壊れた行はスキップする。 */
export async function readEventsAll(dir: string): Promise<OpEvent[]> {
  const out: OpEvent[] = [];
  for await (const line of readLines(dir)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OpEvent);
    } catch {
      /* 壊れた行はスキップ */
    }
  }
  return out;
}

/** 末尾 limit 件だけ読む(show -n 用)。limit<=0 は全件。リングバッファで末尾のみ保持する。 */
export async function readEventsTail(dir: string, limit: number): Promise<OpEvent[]> {
  if (limit <= 0) return readEventsAll(dir);
  const ring: OpEvent[] = [];
  for await (const line of readLines(dir)) {
    if (!line.trim()) continue;
    try {
      ring.push(JSON.parse(line) as OpEvent);
      if (ring.length > limit) ring.shift();
    } catch {
      /* 壊れた行はスキップ */
    }
  }
  return ring;
}
