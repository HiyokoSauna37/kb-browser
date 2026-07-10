import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { LOGS_DIR } from '../../shared/paths';
import { rpc } from '../../shared/client';
import {
  redactEvent,
  reportMarkdown,
  requestFiles,
  stepsMarkdown,
  toCliString,
  type CommandEvent,
  type MaskOptions,
  type OpEvent,
  type SessionMeta,
} from '../../shared/oplog';
import { hhmmss } from '../../shared/format';
import { countEvents, readEventsAll, readEventsTail } from './logStore';
import { intOpt, isJsonOutput, print, run } from '../output';

interface MaskCliOpts {
  /** commander の --no-mask で false になる(既定 true = マスク適用)。 */
  mask?: boolean;
  allow?: string;
  deny?: string;
}

function maskOptions(opts: MaskCliOpts): MaskOptions {
  return {
    mask: opts.mask !== false,
    allow: opts.allow ? new RegExp(opts.allow, 'i') : undefined,
    deny: opts.deny ? new RegExp(opts.deny, 'i') : undefined,
  };
}

/** マスク関連の共通オプションを付ける。 */
function withMaskOpts(cmd: Command): Command {
  return cmd
    .option('--no-mask', '機微な値のマスクを解除する(既定はマスク)')
    .option('--allow <regex>', 'この正規表現に一致する名前はマスクしない')
    .option('--deny <regex>', 'この正規表現に一致する名前・値を追加でマスクする');
}

function listSessionDirs(): { name: string; dir: string; meta: SessionMeta | null }[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(LOGS_DIR).filter((e) => fs.existsSync(path.join(LOGS_DIR, e, 'events.jsonl')) || fs.existsSync(path.join(LOGS_DIR, e, 'meta.json')));
  } catch {
    return [];
  }
  return entries.map((name) => {
    const dir = path.join(LOGS_DIR, name);
    let meta: SessionMeta | null = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      /* meta なしでも一覧には出す */
    }
    return { name, dir, meta };
  }).sort((a, b) => (a.meta?.startedAt ?? '').localeCompare(b.meta?.startedAt ?? ''));
}

/** セッションを解決する(省略時は最新)。 */
function resolveSession(name?: string): { name: string; dir: string; meta: SessionMeta } {
  const sessions = listSessionDirs();
  if (!sessions.length) throw new Error('操作ログのセッションがありません(デーモン起動中は自動で記録されます)');
  const found = name ? sessions.find((s) => s.name === name) : sessions[sessions.length - 1];
  if (!found) throw new Error(`セッション "${name}" は存在しません。kb log list で確認してください。`);
  return { name: found.name, dir: found.dir, meta: found.meta ?? { name: found.name, startedAt: '' } };
}

/** replay で再実行する状態変更系コマンド(観測系や環境切替系は対象外)。 */
const REPLAY_CMDS = new Set([
  'open', 'click', 'fill', 'press', 'hover', 'check', 'select', 'upload', 'scroll',
  'back', 'forward', 'reload', 'eval', 'request', 'wait', 'screenshot',
  'net.block', 'net.mock', 'net.unroute', 'emulate', 'emulate.geo', 'emulate.net',
  'dialog.respond',
]);

/** kb log — 操作記録(ジャーナル)の管理・レポート生成・再実行。 */
export function registerLogCommands(program: Command): void {
  const logCmd = program.command('log').description('操作記録の管理(既定で常時記録。レポート/再現手順/マスク付きバンドルを生成)');

  logCmd
    .command('start')
    .description('新しい記録セッションを開始する(現在のセッションは閉じる)')
    .option('--name <name>', 'セッション名(省略時はタイムスタンプ)')
    .option('--shots', '操作(open / click / fill 等)のたびに自動でスクリーンショットを記録する(report.md に載る)')
    .action(
      run(async (opts: { name?: string; shots?: boolean }) => {
        const result = await rpc('log.start', { name: opts.name, shots: opts.shots });
        print(result, (r) => `セッション "${r.name}" の記録を開始しました (${r.dir}${r.shots ? '、自動スクショ ON' : ''})`);
      }),
    );

  logCmd
    .command('stop')
    .description('現在の記録セッションを終了する')
    .action(
      run(async () => {
        const result = await rpc('log.stop');
        print(result, (r) => (r.name ? `セッション "${r.name}" を終了しました (${r.events} イベント)` : '記録中のセッションはありません'));
      }),
    );

  logCmd
    .command('status')
    .description('現在の記録状態を表示する')
    .action(
      run(async () => {
        const result = await rpc('log.status');
        print(result, (r) => (r.recording ? `記録中: ${r.name} (${r.events} イベント${r.shots ? '、自動スクショ ON' : ''})` : '記録していません'));
      }),
    );

  logCmd
    .command('list', { isDefault: true })
    .description('記録セッションの一覧を表示する')
    .action(
      run(async () => {
        const sessions = await Promise.all(
          listSessionDirs().map(async (s) => ({
            name: s.name,
            startedAt: s.meta?.startedAt,
            endedAt: s.meta?.endedAt,
            events: await countEvents(s.dir),
          })),
        );
        print(sessions, (list: any[]) =>
          list.length
            ? list
                .map((s) => `${s.name.padEnd(20)} ${s.events} イベント  ${s.startedAt ?? ''}${s.endedAt ? ` 〜 ${s.endedAt}` : ' (記録中の可能性)'}`)
                .join('\n')
            : 'セッションはありません',
        );
      }),
    );

  withMaskOpts(
    logCmd
      .command('show')
      .description('記録イベントを表示する(既定はマスク済み・最新セッション)')
      .option('--session <name>', '対象セッション(省略時は最新)')
      .option('-n, --limit <n>', '末尾から表示する件数', intOpt, 50),
  )
    .action(
      run(async (opts: MaskCliOpts & { session?: string; limit: number }) => {
        const { dir } = resolveSession(opts.session);
        const mask = maskOptions(opts);
        // 末尾 limit 件だけ読む(redact は要素毎の純関数なので全件 redact→slice と等価)。
        const events = (await readEventsTail(dir, opts.limit)).map((e) => redactEvent(e, mask));
        print(events, (list: OpEvent[]) =>
          list.length
            ? list
                .map((e) => {
                  if (e.type === 'command') return `#${e.seq} ${hhmmss(e.ts)} $ ${toCliString(e)}${e.ok ? '' : `  ← 失敗: ${e.error ?? ''}`}`;
                  if (e.type === 'net') return `#${e.seq} ${hhmmss(e.ts)}   ↳ ${e.method} ${e.url} → ${e.status ?? '?'}`;
                  return `#${e.seq} ${hhmmss(e.ts)}   ↳ console[${e.kind}] ${e.text.slice(0, 150)}`;
                })
                .join('\n')
            : 'イベントはありません',
        );
      }),
    );

  withMaskOpts(
    logCmd
      .command('steps')
      .description('番号付きの再現手順(kb コマンド列)を生成する')
      .option('--session <name>', '対象セッション(省略時は最新)'),
  )
    .action(
      run(async (opts: MaskCliOpts & { session?: string }) => {
        const { dir, meta } = resolveSession(opts.session);
        const mask = maskOptions(opts);
        const events = (await readEventsAll(dir)).map((e) => redactEvent(e, mask));
        const md = stepsMarkdown(events, meta);
        print({ steps: md }, () => md);
      }),
    );

  withMaskOpts(
    logCmd
      .command('export')
      .description('自己完結バンドル(report.md + events.jsonl + requests/ + shots/ + meta.json)を生成する。機微な値は既定でマスク')
      .option('--session <name>', '対象セッション(省略時は最新)')
      .option('-o, --out <dir>', '出力先フォルダ(省略時は ./kb-log-<session>)'),
  )
    .action(
      run(async (opts: MaskCliOpts & { session?: string; out?: string }) => {
        const { name, dir, meta } = resolveSession(opts.session);
        const mask = maskOptions(opts);
        const outDir = path.resolve(opts.out ?? `kb-log-${name}`);
        if (/\.zip$/i.test(outDir)) throw new Error('出力先はフォルダを指定してください(zip が必要な場合は生成後に Compress-Archive 等で圧縮)');
        const raw = await readEventsAll(dir);
        const events = raw.map((e) => redactEvent(e, mask));

        fs.mkdirSync(outDir, { recursive: true });
        fs.mkdirSync(path.join(outDir, 'requests'), { recursive: true });
        fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });

        // スクリーンショットをバンドルへコピー:
        //  - --shots の自動スクショ(event.shot、セッションフォルダ相対)
        //  - kb screenshot コマンドの出力(記録されたパスのファイルが残っていれば)
        const shotMap = new Map<number, string>();
        for (const e of events) {
          if (e.type !== 'command' || !e.ok) continue;
          let src: string | undefined;
          if (e.shot) src = path.join(dir, e.shot);
          else if (e.cmd === 'screenshot') src = String((e.args as any).path ?? '');
          if (!src || !fs.existsSync(src)) continue;
          const rel = `shots/step-${e.seq}${path.extname(src) || '.png'}`;
          fs.copyFileSync(src, path.join(outDir, rel));
          shotMap.set(e.seq, rel);
        }

        fs.writeFileSync(path.join(outDir, 'report.md'), reportMarkdown(events, meta, shotMap));
        fs.writeFileSync(path.join(outDir, 'steps.md'), stepsMarkdown(events, meta));
        fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
        fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
        const reqs = requestFiles(events);
        for (const f of reqs) fs.writeFileSync(path.join(outDir, 'requests', f.name), f.content);

        print(
          { out: outDir, events: events.length, requests: reqs.length, shots: shotMap.size, masked: mask.mask ? true : false },
          (r) =>
            `${r.out}\n(events=${r.events}, requests=${r.requests}, shots=${r.shots}, マスク=${r.masked ? '適用' : '解除'})\nreport.md から読み始めてください`,
        );
      }),
    );

  logCmd
    .command('replay [session]')
    .description('記録セッションの操作を順に再実行する(ローカルの生ジャーナルを使用。タブ指定は現在のアクティブタブに読み替え)')
    .option('--from <seq>', 'この seq のイベントから再実行する', intOpt)
    .option('--to <seq>', 'この seq のイベントまで再実行する', intOpt)
    .option('--delay <ms>', '各ステップ間の待機ミリ秒', intOpt, 0)
    .option('--dry-run', '実行せず、再実行されるコマンド列だけ表示する')
    .option('--continue-on-error', 'ステップが失敗しても続行する(既定は失敗で停止)')
    .action(
      run(
        async (
          session: string | undefined,
          opts: { from?: number; to?: number; delay: number; dryRun?: boolean; continueOnError?: boolean },
        ) => {
          const { name, dir } = resolveSession(session);
          const cmds = (await readEventsAll(dir))
            .filter((e): e is CommandEvent => e.type === 'command' && e.ok && REPLAY_CMDS.has(e.cmd))
            .filter((e) => (opts.from == null || e.seq >= opts.from) && (opts.to == null || e.seq <= opts.to));
          if (!cmds.length) throw new Error('再実行できるコマンドがありません(観測系のみのセッション、または --from/--to の範囲外)');
          if (opts.dryRun) {
            return print(
              cmds.map((e) => ({ seq: e.seq, cmd: toCliString(e) })),
              (list: any[]) => list.map((s, i) => `${i + 1}. #${s.seq} ${s.cmd}`).join('\n'),
            );
          }
          let replayed = 0;
          const failures: { seq: number; cmd: string; error: string }[] = [];
          for (const [i, e] of cmds.entries()) {
            const label = toCliString(e);
            if (!isJsonOutput()) console.error(`▶ ${i + 1}/${cmds.length} #${e.seq} ${label}`);
            // 記録時のタブ ID は現在のデーモンでは通用しないため、アクティブタブで実行する
            const args = { ...e.args };
            delete args.tab;
            try {
              await rpc(e.cmd, args);
              replayed++;
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              failures.push({ seq: e.seq, cmd: label, error });
              if (!opts.continueOnError) {
                throw new Error(
                  `ステップ ${i + 1} (#${e.seq} ${label}) で失敗: ${error.split('\n')[0]}\n` +
                    `(--continue-on-error で続行、--from ${e.seq} で途中から再開できます)`,
                );
              }
            }
            if (opts.delay > 0) await new Promise((r) => setTimeout(r, opts.delay));
          }
          print(
            { session: name, replayed, total: cmds.length, failures },
            (r) =>
              `再実行 ${r.replayed}/${r.total} 完了 (セッション "${r.session}")` +
              (r.failures.length ? `\n失敗:\n${r.failures.map((f: any) => `  #${f.seq} ${f.cmd} — ${f.error.split('\n')[0]}`).join('\n')}` : ''),
          );
        },
      ),
    );

  logCmd
    .command('rm <session>')
    .description('記録セッションを削除する')
    .action(
      run(async (session: string) => {
        const { name, dir } = resolveSession(session);
        const status = await rpc('log.status').catch(() => null);
        if (status?.recording && status.name === name) throw new Error(`セッション "${name}" は記録中です。kb log stop してから削除してください。`);
        fs.rmSync(dir, { recursive: true, force: true });
        print({ removed: name }, () => `セッション "${name}" を削除しました`);
      }),
    );
}
