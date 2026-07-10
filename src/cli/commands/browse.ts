import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { rpc } from '../../shared/client';
import { REQUEST_TIMEOUT_SEC } from '../../shared/constants';
import { headersWithSetCookie, redirectHopLines, setCookieLines } from '../../shared/format';
import { parseHeaderArgs } from '../../shared/util';
import { fmtTabs, intOpt, print, run, truncNote } from '../output';

/** kb open / tabs / screenshot / text / html / snapshot / eval / request — ページの閲覧・取得系。 */
export function registerBrowseCommands(program: Command): void {
  program
    .command('open <url>')
    .description('URL を開く(デーモン未起動なら自動起動。スキーム省略時は https)')
    .option('-n, --new', '新しいタブで開く')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--wait <state>', '待機条件: dcl | load | idle (SPA は idle 推奨)', 'dcl')
    .action(
      run(async (url: string, opts: { new?: boolean; tab?: number; wait: string }) => {
        const waitMap: Record<string, 'domcontentloaded' | 'load' | 'networkidle'> = {
          dcl: 'domcontentloaded',
          load: 'load',
          idle: 'networkidle',
        };
        const waitUntil = waitMap[opts.wait];
        if (!waitUntil) throw new Error('--wait は dcl | load | idle を指定してください');
        const result = await rpc('open', { url, new: opts.new, tab: opts.tab, waitUntil });
        print(result, (r) => `tab ${r.tab}: ${r.url}${r.title ? ` "${r.title}"` : ''}`);
      }),
    );

  const tabs = program.command('tabs').description('タブの一覧・操作');

  tabs
    .command('list', { isDefault: true })
    .description('タブ一覧を表示する')
    .action(
      run(async () => {
        const result = await rpc('tabs.list');
        print(result, fmtTabs);
      }),
    );

  tabs
    .command('close <id>')
    .description('タブを閉じる(最後のタブは空タブに置き換わる)')
    .action(
      run(async (id: string) => {
        await rpc('tabs.close', { tab: intOpt(id) });
        print({ closed: intOpt(id) }, () => `タブ ${id} を閉じました`);
      }),
    );

  tabs
    .command('switch <id>')
    .description('アクティブタブを切り替える(前面に出す)')
    .action(
      run(async (id: string) => {
        await rpc('tabs.activate', { tab: intOpt(id) });
        print({ active: intOpt(id) }, () => `タブ ${id} をアクティブにしました`);
      }),
    );

  program
    .command('screenshot [selector]')
    .description('スクリーンショットを保存する(selector か --ref を指定すると要素単位で撮る)')
    .option('-o, --out <path>', '出力先', 'kb-screenshot.png')
    .option('-f, --full', 'ページ全体を撮る')
    .option('--ref <ref>', 'kb snapshot の要素 ref (例: e12)')
    .option('--frame <selector>', 'iframe の CSS セレクタ(この中で selector を解決)')
    .option('--timeout <sec>', '安定待ち(フォント読み込み等)のタイムアウト秒。重い SPA でタイムアウトするときに延ばす(既定 30)', intOpt)
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(
        async (
          selector: string | undefined,
          opts: { out: string; full?: boolean; ref?: string; frame?: string; timeout?: number; tab?: number },
        ) => {
          if (opts.full && (selector || opts.ref)) throw new Error('--full と要素指定 (selector / --ref) は同時に使えません');
          const outPath = path.resolve(opts.out);
          const result = await rpc('screenshot', {
            path: outPath,
            full: opts.full,
            selector,
            ref: opts.ref,
            frame: opts.frame,
            timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
            tab: opts.tab,
          });
          print({ path: result }, (r) => r.path);
        },
      ),
    );

  program
    .command('text')
    .description('ページ本文のテキストを取得する(既定 20000 文字で切り詰め)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--max-chars <n>', '最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置(続きを読むとき用)', intOpt)
    .action(
      run(async (opts: { tab?: number; maxChars?: number; offset?: number }) => {
        const result = await rpc('text', { tab: opts.tab, maxChars: opts.maxChars, offset: opts.offset });
        print(result, (r) => `# ${r.title}\n# ${r.url}\n\n${r.text}${truncNote(r, r.text.length)}`);
      }),
    );

  program
    .command('html')
    .description('ページの HTML を取得する(既定 20000 文字で切り詰め)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--max-chars <n>', '最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置', intOpt)
    .action(
      run(async (opts: { tab?: number; maxChars?: number; offset?: number }) => {
        const result = await rpc('html', { tab: opts.tab, maxChars: opts.maxChars, offset: opts.offset });
        print(result, (r) => `${r.html}${truncNote(r, r.html.length)}`);
      }),
    );

  program
    .command('snapshot')
    .description('アクセシビリティスナップショットを取得する(要素 ref 付き。click/fill の --ref に使える)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--max-chars <n>', '最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置', intOpt)
    .action(
      run(async (opts: { tab?: number; maxChars?: number; offset?: number }) => {
        const result = await rpc('snapshot', { tab: opts.tab, maxChars: opts.maxChars, offset: opts.offset });
        print(result, (r) => `# ${r.title}\n# ${r.url}\n\n${r.snapshot}${truncNote(r, r.snapshot.length)}`);
      }),
    );

  program
    .command('eval [expression]')
    .description('ページ内で JavaScript を実行する(await・複数行も可。最後の式または return の値が返る。結果は既定 20000 文字で切り詰め)')
    .option('--file <path>', '式の代わりにスクリプトファイルを読み込んで実行する')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--max-chars <n>', '結果の最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置(切り詰められた続きを読むとき用)', intOpt)
    .action(
      run(async (expression: string | undefined, opts: { file?: string; tab?: number; maxChars?: number; offset?: number }) => {
        if (opts.file && expression !== undefined) throw new Error('式と --file は同時に指定できません');
        if (opts.file) expression = fs.readFileSync(path.resolve(opts.file), 'utf8');
        if (expression === undefined) throw new Error('実行する式か --file <path> を指定してください');
        const result = await rpc('eval', { expression, tab: opts.tab, maxChars: opts.maxChars, offset: opts.offset });
        print(result, (r) => {
          const body = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
          return `${body}${r.truncated ? truncNote(r, body.length) : ''}`;
        });
      }),
    );

  program
    .command('request <url>')
    .description('ページを開かずに HTTP リクエストを送る(Cookie とプロキシ設定はブラウザと共有。ミニ REST クライアント)')
    .option('-X, --method <method>', 'HTTP メソッド', 'GET')
    .option('-H, --header <header>', '"Name: value" 形式のヘッダ(複数指定可)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('-d, --data <body>', 'リクエストボディ')
    .option('--data-file <path>', 'ボディをファイルから読み込む')
    .option('--no-follow', 'リダイレクトを追わない')
    .option('--follow-verbose', 'リダイレクトを追いつつ各ホップの status / Location / Set-Cookie を表示する')
    .option('--timeout <sec>', 'タイムアウト秒数', intOpt, REQUEST_TIMEOUT_SEC)
    .option('-o, --out <file>', 'レスポンス本文をファイルに保存する(バイナリ向け)')
    .option('-i, --include', 'レスポンスヘッダも表示する')
    .option('--max-chars <n>', '本文の最大文字数 (0 = 無制限)', intOpt)
    .option('--offset <n>', '取得開始位置', intOpt)
    .action(
      run(
        async (
          url: string,
          opts: {
            method: string;
            header: string[];
            data?: string;
            dataFile?: string;
            follow: boolean;
            followVerbose?: boolean;
            timeout: number;
            out?: string;
            include?: boolean;
            maxChars?: number;
            offset?: number;
          },
        ) => {
          if (opts.data !== undefined && opts.dataFile) throw new Error('--data と --data-file は同時に指定できません');
          if (opts.followVerbose && !opts.follow) throw new Error('--follow-verbose と --no-follow は同時に指定できません');
          const data = opts.dataFile ? fs.readFileSync(path.resolve(opts.dataFile), 'utf8') : opts.data;
          const headers = parseHeaderArgs(opts.header);
          const r = await rpc('request', {
            url,
            method: opts.method,
            headers: Object.keys(headers).length ? headers : undefined,
            data,
            timeoutMs: opts.timeout * 1000,
            follow: opts.follow,
            verbose: opts.followVerbose,
            savePath: opts.out ? path.resolve(opts.out) : undefined,
            maxChars: opts.maxChars,
            offset: opts.offset,
          });
          print(r, () => {
            // --follow-verbose: 中間ホップを先に並べ、最終レスポンス行に解決後 URL を添える。
            const hops = r.hops ?? [];
            const chain = hops.length ? redirectHopLines(hops) + '\n' : '';
            const finalUrl = hops.length ? `  ${r.url}` : '';
            let out = `${chain}HTTP ${r.status} ${r.statusText}${finalUrl} (${r.ms}ms${hops.length ? ' total' : ''}, ${r.bytes} bytes${r.contentType ? `, ${r.contentType}` : ''})`;
            if (!hops.length && r.url !== url) out += `\n→ ${r.url}`;
            const setCookies: string[] = r.setCookies ?? [];
            if (opts.include) {
              out += headersWithSetCookie(r.headers, setCookies);
            } else if (setCookies.length) {
              // -i なしでも Set-Cookie はブラウザ context に反映される副作用なので常に見せる
              out += setCookieLines(setCookies);
            }
            if (r.savedTo) return `${out}\n本文を保存しました: ${r.savedTo}`;
            if (r.binary) return `${out}\n(バイナリ本文のため表示しません。-o <file> で保存できます)`;
            return `${out}\n\n${r.body}${truncNote(r, r.body.length)}`;
          });
        },
      ),
    );
}
