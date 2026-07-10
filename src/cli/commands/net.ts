import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { rpc } from '../../shared/client';
import { CONSOLE_DEFAULT_LIMIT, NET_LOG_DEFAULT_LIMIT } from '../../shared/constants';
import { hhmmss } from '../../shared/format';
import { inferJsonContentType } from '../../shared/util';
import { intOpt, isJsonOutput, print, run, truncNote } from '../output';

const FOLLOW_INTERVAL_MS = 700;

function fmtNetEntry(e: any): string {
  const status = e.event === 'requestfailed' ? `FAIL(${e.failure ?? '?'})` : (e.status ?? '…');
  // 行頭の #seq は kb net body <seq> に渡せる(本文は response 行に対して捕捉される)
  return `#${String(e.seq).padEnd(5)} ${hhmmss(e.ts)} [${e.tab}] ${String(e.method).padEnd(6)} ${String(status).padEnd(4)} ${e.resourceType.padEnd(10)} ${e.url}`;
}

function fmtConsoleEntry(e: any): string {
  return `${hhmmss(e.ts)} [${e.tab}] [${e.kind}] ${e.text}`;
}

/**
 * since カーソルでポーリングしながら新着エントリを流し続ける (Ctrl+C で終了)。
 * forSec を指定すると指定秒数で自動終了する(エージェントはこちらを使う)。
 */
async function followLog(
  cmd: 'net.log' | 'console.log',
  baseArgs: Record<string, unknown>,
  format: (e: any) => string,
  forSec?: number,
): Promise<void> {
  const deadline = forSec ? Date.now() + forSec * 1000 : null;
  let since = 0;
  let first = true;
  for (;;) {
    const { entries, seq, dropped } = await rpc(cmd, { ...baseArgs, since, limit: first ? (baseArgs.limit ?? 20) : undefined });
    if (dropped) console.error(`(!) ${dropped} 件を取りこぼしました(バッファ超過)`);
    for (const e of entries) console.log(isJsonOutput() ? JSON.stringify(e) : format(e));
    since = seq;
    first = false;
    if (deadline && Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
  }
}

/** "#123" / "123" 形式の seq 引数をパースする(kb net body / headers 共通)。 */
function parseSeq(seqStr: string, example: string): number {
  const seq = parseInt(seqStr.replace(/^#/, ''), 10);
  if (!Number.isFinite(seq)) throw new Error(`seq は kb net log の行頭に表示される番号で指定してください (例: ${example})`);
  return seq;
}

function guessContentType(file: string): string {
  const map: Record<string, string> = {
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[path.extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8';
}

/** kb net / console / dom — ネットワーク監視・改変と DevTools 系の検査。 */
export function registerNetCommands(program: Command): void {
  const net = program.command('net').description('ネットワークの監視・改変 (DevTools Network 相当)');

  net
    .command('log', { isDefault: true })
    .description('ネットワークログを表示する')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--filter <regex>', 'URL を正規表現で絞り込む')
    .option('-n, --limit <n>', '表示件数', intOpt, NET_LOG_DEFAULT_LIMIT)
    .option('--responses', '完了相 (response / FAIL) の行だけ表示する(送信相との二重行を省く)')
    .option('-f, --follow', '新着を流し続ける (Ctrl+C で終了。エージェントは --for と併用)')
    .option('--for <sec>', 'follow を指定秒数で自動終了する', intOpt)
    .action(
      run(async (opts: { tab?: number; filter?: string; limit: number; responses?: boolean; follow?: boolean; for?: number }) => {
        const baseArgs = { tab: opts.tab, filter: opts.filter, limit: opts.limit, responsesOnly: opts.responses };
        if (opts.follow) return followLog('net.log', baseArgs, fmtNetEntry, opts.for);
        const { entries } = await rpc('net.log', baseArgs);
        print(entries, (list: any[]) => (list.length ? list.map(fmtNetEntry).join('\n') : 'ログはありません'));
      }),
    );

  net
    .command('body <seq>')
    .description('捕捉済みのレスポンス本文を表示する(seq は kb net log の行頭の # 番号。テキスト系の XHR/fetch/document が対象)')
    .option('--max-chars <n>', '最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置(続きを読むとき用)', intOpt)
    .action(
      run(async (seqStr: string, opts: { maxChars?: number; offset?: number }) => {
        const seq = parseSeq(seqStr, 'kb net body 123');
        const r = await rpc('net.body', { seq, maxChars: opts.maxChars, offset: opts.offset });
        print(r, () => {
          const cap = r.capturedTruncated
            ? `(先頭 ${r.totalChars} 文字のみ捕捉、全体 ${r.fullBytes} bytes。全文は kb request <url> -o <file> で取り直せます)`
            : '';
          return `# ${r.status} ${r.contentType} — ${r.url}${cap}\n\n${r.body}${truncNote(r, r.body.length)}`;
        });
      }),
    );

  net
    .command('headers <seq>')
    .description('リクエスト/レスポンスの全ヘッダを表示する(seq は kb net log の行頭の # 番号。Cookie 等の CDP 追加情報も含む)')
    .action(
      run(async (seqStr: string) => {
        const seq = parseSeq(seqStr, 'kb net headers 123');
        const r = await rpc('net.headers', { seq });
        print(r, () => {
          const fmt = (h: Record<string, string>) =>
            Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') || '(なし)';
          return `# ${r.method} ${r.url}\n\n── request headers ──\n${fmt(r.request)}\n\n── response headers (${r.status}) ──\n${fmt(r.response)}`;
        });
      }),
    );

  net
    .command('clear')
    .description('ネットワークログを消去する')
    .action(
      run(async () => {
        await rpc('net.clear');
        print({ cleared: true }, () => 'cleared');
      }),
    );

  net
    .command('block <pattern>')
    .description('パターンに一致するリクエストを遮断する (glob 例: "**/*.png", "*://*.doubleclick.net/*")')
    .action(
      run(async (pattern: string) => {
        const rule = await rpc('net.block', { pattern });
        print(rule, (r) => `rule ${r.id}: block ${r.pattern}`);
      }),
    );

  net
    .command('mock <pattern>')
    .description('パターンに一致するリクエストへ固定レスポンスを返す(ページが既に発行しているリクエストにも効く。エラー画面の確認などに)')
    .option('--body <file>', 'レスポンス本文のファイル')
    .option('--text <body>', 'レスポンス本文を直接指定する(--body の代わり)')
    .option('--status <n>', 'ステータスコード', intOpt, 200)
    .option('--content-type <ct>', 'Content-Type (省略時は拡張子または本文から推定)')
    .action(
      run(async (pattern: string, opts: { body?: string; text?: string; status: number; contentType?: string }) => {
        if (opts.body && opts.text !== undefined) throw new Error('--body と --text は同時に指定できません');
        // 本文なし(--status のみ)も許可する: 500 等のステータスだけ差し替える用途
        const body = opts.body ? fs.readFileSync(path.resolve(opts.body), 'utf8') : (opts.text ?? '');
        const contentType =
          opts.contentType ??
          (opts.body ? guessContentType(opts.body) : inferJsonContentType(body, undefined) ?? 'text/plain; charset=utf-8');
        const rule = await rpc('net.mock', { pattern, status: opts.status, contentType, body });
        print(rule, (r) => `rule ${r.id}: mock ${r.pattern} → ${r.status} ${r.contentType}`);
      }),
    );

  net
    .command('rules')
    .description('有効な block / mock ルールを表示する')
    .action(
      run(async () => {
        const rules = await rpc('net.rules');
        print(rules, (list: any[]) =>
          list.length
            ? list.map((r) => `[${r.id}] ${r.action}  ${r.pattern}${r.status ? ` → ${r.status}` : ''}`).join('\n')
            : 'ルールはありません',
        );
      }),
    );

  net
    .command('unroute [id]')
    .description('ルールを解除する(id は kb net rules の番号。--all で全解除)')
    .option('--all', 'すべての block / mock ルールを解除する')
    .action(
      run(async (id: string | undefined, opts: { all?: boolean }) => {
        if (opts.all) {
          const result = await rpc('net.unroute', { all: true });
          return print(result, (r) => `${r.removed} 件のルールを解除しました`);
        }
        if (id === undefined) throw new Error('解除するルールの id か --all を指定してください (id は kb net rules で確認)');
        await rpc('net.unroute', { id: intOpt(id) });
        print({ removed: intOpt(id) }, () => `ルール ${id} を解除しました`);
      }),
    );

  const har = net.command('har').description('HAR 記録 (DevTools の Save as HAR 相当)');

  har
    .command('start')
    .description('HAR 記録を開始する')
    .action(
      run(async () => {
        const result = await rpc('net.har.start');
        print(result, () => '記録を開始しました');
      }),
    );

  har
    .command('stop')
    .description('HAR 記録を終了しファイルに保存する')
    .option('-o, --out <path>', '出力先', 'kb.har')
    .action(
      run(async (opts: { out: string }) => {
        const harData = await rpc('net.har.stop');
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, JSON.stringify(harData, null, 2));
        // 上限で打ち切られた場合は不完全な旨を stderr で警告する(HAR ファイル自体は log.comment に記録)。
        if (harData.log.comment) console.error(`警告: ${harData.log.comment}`);
        print(
          { path: outPath, entries: harData.log.entries.length, truncated: !!harData.log.comment },
          (r) => `${r.path} (${r.entries} entries${r.truncated ? ', truncated' : ''})`,
        );
      }),
    );

  har
    .command('status')
    .description('HAR 記録の状態を表示する')
    .action(
      run(async () => {
        const result = await rpc('net.har.status');
        print(result, (r) =>
          r.recording ? `記録中 (${r.entries} entries${r.truncated ? ', 上限到達で打ち切り' : ''})` : '記録していません',
        );
      }),
    );

  program
    .command('console')
    .description('ページのコンソールログ・エラーを表示する')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('-n, --limit <n>', '表示件数', intOpt, CONSOLE_DEFAULT_LIMIT)
    .option('-f, --follow', '新着を流し続ける (Ctrl+C で終了。エージェントは --for と併用)')
    .option('--for <sec>', 'follow を指定秒数で自動終了する', intOpt)
    .option('--clear', 'ログを消去する')
    .action(
      run(async (opts: { tab?: number; limit: number; follow?: boolean; for?: number; clear?: boolean }) => {
        if (opts.clear) {
          await rpc('console.clear');
          return print({ cleared: true }, () => 'cleared');
        }
        const baseArgs = { tab: opts.tab, limit: opts.limit };
        if (opts.follow) return followLog('console.log', baseArgs, fmtConsoleEntry, opts.for);
        const { entries } = await rpc('console.log', baseArgs);
        print(entries, (list: any[]) => (list.length ? list.map(fmtConsoleEntry).join('\n') : 'ログはありません'));
      }),
    );

  const dom = program.command('dom').description('DOM の検査');

  dom
    .command('query <selector>')
    .description('CSS セレクタに一致する要素を表示する')
    .option('--html', 'outerHTML も表示する(要素あたり 2000 文字まで)')
    .option('--attr <name>', '指定属性の値も表示する')
    .option('-n, --limit <n>', '最大件数', intOpt, 20)
    .option('--frame <selector>', 'iframe の CSS セレクタ(この中を検索)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (selector: string, opts: { html?: boolean; attr?: string; limit: number; frame?: string; tab?: number }) => {
        const result = await rpc('dom.query', {
          selector,
          html: opts.html,
          attr: opts.attr,
          limit: opts.limit,
          frame: opts.frame,
          tab: opts.tab,
        });
        print(result, (r) => {
          if (!r.total) return '一致する要素はありません';
          const lines = r.matches.map((m: any) => {
            let line = `[${m.index}] <${m.tag}> ${m.text}`;
            if (opts.attr) line += `\n    ${opts.attr}=${JSON.stringify(m.attr)}`;
            if (opts.html) line += `\n    ${m.html}`;
            return line;
          });
          return `${r.total} 件一致\n` + lines.join('\n');
        });
      }),
    );
}
