#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import { LOGS_DIR, PROFILES_DIR, readLastRun, removeDaemonInfo, writeLastRun } from './shared/paths';
import { pingDaemon, releaseSpawnLock, rpc, rpcRaw, spawnDaemon, waitForDaemon } from './shared/client';
import { inferJsonContentType, parseHeaderArgs } from './shared/util';
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
} from './shared/oplog';
import {
  loadProxyConfig,
  resolveProfile,
  saveProxyConfig,
  type ProxyProfile,
} from './shared/proxyStore';

const program = new Command();
let jsonOutput = false;

// ---- 出力ヘルパー ----

function print(result: unknown, human?: (r: any) => string): void {
  if (jsonOutput) {
    // 失敗時の {ok:false, error} と対称にし、機械側が常に .ok で判定できるようにする
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } else if (!human) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(human(result));
  }
}

/** action ハンドラを共通のエラー処理でラップする。 */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => void {
  return (...args) => {
    fn(...args).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonOutput) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(`error: ${message}`);
      process.exitCode = 1;
    });
  };
}

const tabOpt = (v: string) => parseInt(v, 10);
const intOpt = (v: string) => parseInt(v, 10);

/** click / fill 等の操作結果(移動後の URL / タイトル)を短く表示する。 */
function fmtAction(verb: string): (r: any) => string {
  return (r) => {
    const heal = r.reResolvedRef ? `\n(ref ${r.reResolvedRef.from} は失効していたため ${r.reResolvedRef.to} に自動再解決して操作しました)` : '';
    return `${verb} → ${r.url}${r.title ? ` "${r.title}"` : ''}${heal}`;
  };
}

/** 切り詰め情報の注記。続きの取得方法を含める。 */
function truncNote(r: { totalChars: number; offset: number; truncated: boolean }, shownChars: number): string {
  if (!r.truncated) return '';
  const next = r.offset + shownChars;
  return `\n\n… (${r.offset + 1}〜${next}/${r.totalChars} 文字を表示。続きは --offset ${next}、全文は --max-chars 0)`;
}

/** タブ一覧の整形(tabs list / mode 切替後の表示に共用)。 */
function fmtTabs(list: any[]): string {
  return list.length
    ? list.map((t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(no title)'} — ${t.url}`).join('\n')
    : 'タブはありません';
}

// ---- コマンド定義 ----

program
  .name('kb')
  .description('CLI-operable browser (Playwright + Chromium)')
  .version('0.6.0')
  .option('--json', 'JSON 形式で出力する')
  .hook('preAction', (cmd) => {
    jsonOutput = !!cmd.optsWithGlobals().json;
  });

const daemon = program.command('daemon').description('デーモンの管理');

daemon
  .command('start')
  .description('デーモン(ブラウザ)を起動する(フラグなしは headed。プロファイルは前回値を引き継ぐ)')
  .option('--headless', 'ヘッドレスで起動する')
  .option('--headed', 'ウィンドウ表示で起動する(既定)')
  .option('--profile <name>', 'ブラウザプロファイル')
  .option('--channel <channel>', '起動チャネルを明示する (chrome | msedge | chromium。"auto" で自動選択に戻す)')
  .option('--ua <string>', 'User-Agent を全タブで上書きする(headless の "HeadlessChrome" 対策)。--ua "" で解除')
  .option('--cdp <url>', '起動済みブラウザにアタッチする (例: http://127.0.0.1:9222)。--remote-debugging-port 付きで起動した Chrome/Edge に接続し、そのサインイン状態をそのまま使う')
  .action(
    run(async (opts: { headless?: boolean; headed?: boolean; profile?: string; channel?: string; ua?: string; cdp?: string }) => {
      if (opts.headless && opts.headed) throw new Error('--headless と --headed は同時に指定できません');
      if (opts.channel && !['chrome', 'msedge', 'chromium', 'auto'].includes(opts.channel)) {
        throw new Error('--channel は chrome | msedge | chromium | auto を指定してください');
      }
      if (opts.cdp && (opts.channel || opts.ua != null || opts.profile || opts.headless || opts.headed)) {
        throw new Error('--cdp(アタッチ)は接続先ブラウザの起動条件を変更できないため、--channel / --ua / --profile / --headless とは併用できません');
      }
      const running = await pingDaemon();
      if (running) {
        print({ alreadyRunning: true, pid: running.pid }, (r) => `既に起動しています (pid=${r.pid})`);
        return;
      }
      try {
        // 明示起動は「フラグなし = headed」の契約を守る(last-run を継承するのは自動 spawn のみ)
        const child = spawnDaemon({ headless: !!opts.headless, profile: opts.profile, channel: opts.channel, userAgent: opts.ua, cdpUrl: opts.cdp });
        // child を渡すと、起動に失敗して即終了した場合に 30 秒待たずエラーになる
        const info = await waitForDaemon(child);
        const status = await rpcRaw(info, 'daemon.status');
        print(status, (s) =>
          s.attached
            ? `起動しました (pid=${s.pid}, attach=${s.attached}, tabs=${s.tabs})`
            : `起動しました (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile})`,
        );
      } finally {
        releaseSpawnLock();
      }
    }),
  );

daemon
  .command('stop')
  .description('デーモンを停止する')
  .action(
    run(async () => {
      const info = await pingDaemon();
      if (!info) {
        print({ running: false }, () => 'デーモンは起動していません');
        return;
      }
      await rpcRaw(info, 'daemon.stop');
      removeDaemonInfo();
      print({ stopped: true }, () => '停止しました');
    }),
  );

daemon
  .command('status')
  .description('デーモンの状態を表示する')
  .action(
    run(async () => {
      const info = await pingDaemon();
      if (!info) {
        print({ running: false }, () => 'デーモンは起動していません');
        return;
      }
      const status = await rpcRaw(info, 'daemon.status');
      print({ running: true, ...status }, (s) =>
        `running (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}, tabs=${s.tabs}, proxy=${s.proxy}${s.attached ? `, attach=${s.attached}` : ''})`,
      );
    }),
  );

program
  .command('open <url>')
  .description('URL を開く(デーモン未起動なら自動起動。スキーム省略時は https)')
  .option('-n, --new', '新しいタブで開く')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .option('--wait <state>', '待機条件: dcl | load | idle (SPA は idle 推奨)', 'dcl')
  .action(
    run(async (url: string, opts: { new?: boolean; tab?: number; wait: string }) => {
      const waitUntil = { dcl: 'domcontentloaded', load: 'load', idle: 'networkidle' }[opts.wait];
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
      await rpc('tabs.close', { tab: tabOpt(id) });
      print({ closed: tabOpt(id) }, () => `タブ ${id} を閉じました`);
    }),
  );

tabs
  .command('switch <id>')
  .description('アクティブタブを切り替える(前面に出す)')
  .action(
    run(async (id: string) => {
      await rpc('tabs.activate', { tab: tabOpt(id) });
      print({ active: tabOpt(id) }, () => `タブ ${id} をアクティブにしました`);
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
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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
        return `${body}${r.truncated ? truncNote(r, String(r.result).length) : ''}`;
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
  .option('--timeout <sec>', 'タイムアウト秒数', intOpt, 30)
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
          timeout: number;
          out?: string;
          include?: boolean;
          maxChars?: number;
          offset?: number;
        },
      ) => {
        if (opts.data !== undefined && opts.dataFile) throw new Error('--data と --data-file は同時に指定できません');
        const data = opts.dataFile ? fs.readFileSync(path.resolve(opts.dataFile), 'utf8') : opts.data;
        const headers = parseHeaderArgs(opts.header);
        const r = await rpc('request', {
          url,
          method: opts.method,
          headers: Object.keys(headers).length ? headers : undefined,
          data,
          timeoutMs: opts.timeout * 1000,
          follow: opts.follow,
          savePath: opts.out ? path.resolve(opts.out) : undefined,
          maxChars: opts.maxChars,
          offset: opts.offset,
        });
        print(r, () => {
          let out = `HTTP ${r.status} ${r.statusText} (${r.ms}ms, ${r.bytes} bytes${r.contentType ? `, ${r.contentType}` : ''})`;
          if (r.url !== url) out += `\n→ ${r.url}`;
          if (opts.include) out += '\n' + Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
          if (r.savedTo) return `${out}\n本文を保存しました: ${r.savedTo}`;
          if (r.binary) return `${out}\n(バイナリ本文のため表示しません。-o <file> で保存できます)`;
          return `${out}\n\n${r.body}${truncNote(r, r.body.length)}`;
        });
      },
    ),
  );

// ---- 要素操作 (selector または --ref。--frame で iframe 内を指定) ----

interface TargetCliOpts {
  tab?: number;
  ref?: string;
  frame?: string;
}

function targetArgs(selector: string | undefined, opts: TargetCliOpts) {
  return { selector, ref: opts.ref, frame: opts.frame, tab: opts.tab };
}

/** 操作系コマンドに共通の対象指定オプションを付ける。 */
function withTargetOpts(cmd: Command): Command {
  return cmd
    .option('-t, --tab <id>', '対象タブ ID', tabOpt)
    .option('--ref <ref>', 'kb snapshot の要素 ref (例: e12。iframe 内は f1e3)')
    .option('--frame <selector>', 'iframe の CSS セレクタ(この中で selector を解決)');
}

withTargetOpts(program.command('click [selector]').description('要素をクリックする'))
  .action(
    run(async (selector: string | undefined, opts: TargetCliOpts) => {
      const result = await rpc('click', targetArgs(selector, opts));
      print(result, fmtAction('clicked'));
    }),
  );

withTargetOpts(
  program
    .command('fill [selector] [value]')
    .description('フォーム要素に入力する (--ref 使用時は kb fill --ref e5 <value>)'),
)
  .action(
    run(async (selector: string | undefined, value: string | undefined, opts: TargetCliOpts) => {
      // --ref 指定時は最初の位置引数が value になる
      if (opts.ref && value === undefined) {
        value = selector;
        selector = undefined;
      }
      if (value === undefined) throw new Error('入力する値を指定してください');
      const result = await rpc('fill', { ...targetArgs(selector, opts), value });
      print(result, fmtAction('filled'));
    }),
  );

program
  .command('press <key>')
  .description('キーを押す (例: Enter, Control+A)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (key: string, opts: { tab?: number }) => {
      const result = await rpc('press', { key, tab: opts.tab });
      print(result, fmtAction('pressed'));
    }),
  );

withTargetOpts(program.command('hover [selector]').description('要素にマウスホバーする'))
  .action(
    run(async (selector: string | undefined, opts: TargetCliOpts) => {
      const result = await rpc('hover', targetArgs(selector, opts));
      print(result, fmtAction('hovered'));
    }),
  );

withTargetOpts(program.command('check [selector]').description('チェックボックスを ON にする'))
  .action(
    run(async (selector: string | undefined, opts: TargetCliOpts) => {
      const result = await rpc('check', { ...targetArgs(selector, opts), checked: true });
      print(result, fmtAction('checked'));
    }),
  );

withTargetOpts(program.command('uncheck [selector]').description('チェックボックスを OFF にする'))
  .action(
    run(async (selector: string | undefined, opts: TargetCliOpts) => {
      const result = await rpc('check', { ...targetArgs(selector, opts), checked: false });
      print(result, fmtAction('unchecked'));
    }),
  );

withTargetOpts(
  program
    .command('select [selector] [values...]')
    .description('<select> の項目を選ぶ(既定は value で照合、--label でラベル照合)')
    .option('--label', 'value ではなく表示ラベルで照合する'),
)
  .action(
    run(async (selector: string | undefined, values: string[], opts: TargetCliOpts & { label?: boolean }) => {
      if (opts.ref && selector !== undefined) {
        values = [selector, ...(values ?? [])];
        selector = undefined;
      }
      if (!values?.length) throw new Error('選択する値を指定してください');
      const result = await rpc('select', { ...targetArgs(selector, opts), values, byLabel: opts.label });
      print(result, (r) => `selected [${r.selected.join(', ')}] → ${r.url}`);
    }),
  );

withTargetOpts(
  program.command('upload [selector] [files...]').description('ファイル入力 (<input type=file>) にファイルをセットする'),
)
  .action(
    run(async (selector: string | undefined, files: string[], opts: TargetCliOpts) => {
      if (opts.ref && selector !== undefined) {
        files = [selector, ...(files ?? [])];
        selector = undefined;
      }
      if (!files?.length) throw new Error('アップロードするファイルを指定してください');
      const resolved = files.map((f) => path.resolve(f));
      for (const f of resolved) if (!fs.existsSync(f)) throw new Error(`ファイルが見つかりません: ${f}`);
      const result = await rpc('upload', { ...targetArgs(selector, opts), files: resolved });
      print(result, (r) => `uploaded ${r.files} file(s) → ${r.url}`);
    }),
  );

program
  .command('scroll')
  .description('ページをスクロールする(既定: 600px 下へ)')
  .option('--down <px>', '下へスクロール', intOpt)
  .option('--up <px>', '上へスクロール', intOpt)
  .option('--to <selector>', 'この要素が見えるまでスクロール')
  .option('--top', '最上部へ')
  .option('--bottom', '最下部へ')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { down?: number; up?: number; to?: string; top?: boolean; bottom?: boolean; tab?: number }) => {
      const by = opts.up != null ? -opts.up : opts.down;
      const result = await rpc('scroll', { by, to: opts.to, top: opts.top, bottom: opts.bottom, tab: opts.tab });
      print(result, (r) => `scrollY = ${r.scrollY}`);
    }),
  );

program
  .command('back')
  .description('ブラウザ履歴を戻る')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('back', { tab: opts.tab });
      print(result, (r) => (r.navigated ? `back → ${r.url}` : '戻れる履歴がありません'));
    }),
  );

program
  .command('forward')
  .description('ブラウザ履歴を進む')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('forward', { tab: opts.tab });
      print(result, (r) => (r.navigated ? `forward → ${r.url}` : '進める履歴がありません'));
    }),
  );

program
  .command('reload')
  .description('ページを再読み込みする')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('reload', { tab: opts.tab });
      print(result, fmtAction('reloaded'));
    }),
  );

program
  .command('pdf')
  .description('ページを PDF に出力する(headless モードのみ)')
  .option('-o, --out <path>', '出力先', 'kb.pdf')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { out: string; tab?: number }) => {
      const outPath = path.resolve(opts.out);
      const result = await rpc('pdf', { path: outPath, tab: opts.tab });
      print({ path: result }, (r) => r.path);
    }),
  );

const downloads = program.command('downloads').description('ダウンロードの管理 (~/.kb/downloads/ に保存)');

downloads
  .command('list', { isDefault: true })
  .description('ダウンロード一覧を表示する')
  .action(
    run(async () => {
      const result = await rpc('downloads.list');
      print(result, (list: any[]) =>
        list.length
          ? list
              .map((d) => `[${d.id}] ${d.state.padEnd(6)} ${d.file}${d.error ? ` (${d.error})` : ''}\n      from ${d.url}`)
              .join('\n')
          : 'ダウンロードはありません',
      );
    }),
  );

downloads
  .command('clear')
  .description('ダウンロード履歴を消去する(ファイルは残る)')
  .action(
    run(async () => {
      const result = await rpc('downloads.clear');
      print(result, (r) => `${r.cleared} 件消去しました`);
    }),
  );

// ---- cookies ----

const cookies = program.command('cookies').description('Cookie の管理');

cookies
  .command('list', { isDefault: true })
  .description('Cookie 一覧を表示する')
  .option('-d, --domain <domain>', 'ドメインで絞り込む')
  .action(
    run(async (opts: { domain?: string }) => {
      const result = await rpc('cookies.list', { domain: opts.domain });
      print(result, (list: any[]) =>
        list.length
          ? list
              .map((c) => `${c.domain}\t${c.name}=${c.value.length > 40 ? c.value.slice(0, 40) + '…' : c.value}`)
              .join('\n')
          : 'Cookie はありません',
      );
    }),
  );

cookies
  .command('get <name>')
  .description('名前で Cookie を取得する')
  .option('-d, --domain <domain>', 'ドメインで絞り込む')
  .action(
    run(async (name: string, opts: { domain?: string }) => {
      const all = await rpc('cookies.list', { domain: opts.domain });
      const matched = (all as any[]).filter((c) => c.name === name);
      if (!matched.length) throw new Error(`Cookie "${name}" は見つかりません`);
      print(matched, (list: any[]) => list.map((c) => `${c.domain}\t${c.name}=${c.value}`).join('\n'));
    }),
  );

cookies
  .command('set <name> <value>')
  .description('Cookie を設定する')
  .requiredOption('-d, --domain <domain>', '対象ドメイン')
  .option('-p, --path <path>', 'パス', '/')
  .action(
    run(async (name: string, value: string, opts: { domain: string; path: string }) => {
      await rpc('cookies.set', { cookie: { name, value, domain: opts.domain, path: opts.path } });
      print({ set: name }, () => 'set');
    }),
  );

cookies
  .command('rm <name>')
  .description('Cookie を削除する')
  .option('-d, --domain <domain>', 'ドメインで絞り込む')
  .action(
    run(async (name: string, opts: { domain?: string }) => {
      await rpc('cookies.rm', { name, domain: opts.domain });
      print({ removed: name }, () => 'removed');
    }),
  );

cookies
  .command('export')
  .description('全 Cookie を JSON ファイルに書き出す')
  .option('-o, --out <path>', '出力先', 'kb-cookies.json')
  .action(
    run(async (opts: { out: string }) => {
      const all = await rpc('cookies.list', {});
      const outPath = path.resolve(opts.out);
      fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
      print({ path: outPath, cookies: all.length }, (r) => `${r.path} (${r.cookies} cookies)`);
    }),
  );

cookies
  .command('import <file>')
  .description('JSON ファイルから Cookie を取り込む(export 形式 / storageState 形式)')
  .action(
    run(async (file: string) => {
      const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.cookies;
      if (!Array.isArray(list)) throw new Error('Cookie の配列、または { cookies: [...] } 形式のファイルを指定してください');
      const result = await rpc('cookies.import', { cookies: list });
      print(result, (r) => `${r.imported} 件取り込みました`);
    }),
  );

cookies
  .command('clear')
  .description('すべての Cookie を削除する')
  .action(
    run(async () => {
      await rpc('cookies.clear');
      print({ cleared: true }, () => 'cleared');
    }),
  );

// ---- storage (Cookie + localStorage の一括保存・復元) ----

const storage = program.command('storage').description('セッション状態の保存・復元 (Cookie + localStorage)');

storage
  .command('dump')
  .description('ログイン状態などを storageState 形式でファイルに保存する')
  .option('-o, --out <path>', '出力先', 'kb-state.json')
  .action(
    run(async (opts: { out: string }) => {
      const state = await rpc('storage.dump');
      const outPath = path.resolve(opts.out);
      fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
      print(
        { path: outPath, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 },
        (r) => `${r.path} (cookies=${r.cookies}, origins=${r.origins})`,
      );
    }),
  );

storage
  .command('restore <file>')
  .description('storageState 形式のファイルからセッション状態を復元する')
  .action(
    run(async (file: string) => {
      const state = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const result = await rpc('storage.restore', { state });
      print(result, (r) => {
        let out = `復元しました (cookies=${r.cookies}, origins=${r.origins})`;
        if (r.skippedOrigins?.length) out += `\nスキップ: ${r.skippedOrigins.join(', ')}`;
        return out;
      });
    }),
  );

// ---- log (操作記録: ジャーナル / レポート / マスク付きエクスポート) ----

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

function readEvents(dir: string): OpEvent[] {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const events: OpEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 壊れた行はスキップ */
    }
  }
  return events;
}

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
      const sessions = listSessionDirs().map((s) => ({
        name: s.name,
        startedAt: s.meta?.startedAt,
        endedAt: s.meta?.endedAt,
        events: readEvents(s.dir).length,
      }));
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
      const events = readEvents(dir).map((e) => redactEvent(e, mask)).slice(-opts.limit);
      print(events, (list: OpEvent[]) =>
        list.length
          ? list
              .map((e) => {
                if (e.type === 'command') return `#${e.seq} ${e.ts.slice(11, 19)} $ ${toCliString(e)}${e.ok ? '' : `  ← 失敗: ${e.error ?? ''}`}`;
                if (e.type === 'net') return `#${e.seq} ${e.ts.slice(11, 19)}   ↳ ${e.method} ${e.url} → ${e.status ?? '?'}`;
                return `#${e.seq} ${e.ts.slice(11, 19)}   ↳ console[${e.kind}] ${e.text.slice(0, 150)}`;
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
      const events = readEvents(dir).map((e) => redactEvent(e, mask));
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
      const raw = readEvents(dir);
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

/** replay で再実行する状態変更系コマンド(観測系や環境切替系は対象外)。 */
const REPLAY_CMDS = new Set([
  'open', 'click', 'fill', 'press', 'hover', 'check', 'select', 'upload', 'scroll',
  'back', 'forward', 'reload', 'eval', 'request', 'wait', 'screenshot',
  'net.block', 'net.mock', 'net.unroute', 'emulate', 'emulate.geo', 'emulate.net',
]);

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
        const cmds = readEvents(dir)
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
          if (!jsonOutput) console.error(`▶ ${i + 1}/${cmds.length} #${e.seq} ${label}`);
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

// ---- profile ----

const profileCmd = program.command('profile').description('ブラウザプロファイル (user-data-dir) の管理');

profileCmd
  .command('list', { isDefault: true })
  .description('プロファイル一覧を表示する(* = 使用中)')
  .action(
    run(async () => {
      let current: string | null = null;
      const info = await pingDaemon().catch(() => null);
      if (info) current = (await rpcRaw(info, 'daemon.status')).profile;
      else current = readLastRun()?.profile ?? null;
      const names = new Set<string>(['default']);
      try {
        for (const e of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name);
      } catch {
        /* まだ何もない */
      }
      if (current) names.add(current);
      const list = [...names].sort().map((name) => ({ name, active: name === current }));
      print(list, (l: any[]) => l.map((p) => `${p.active ? '*' : ' '} ${p.name}`).join('\n'));
    }),
  );

profileCmd
  .command('use <name>')
  .description('プロファイルを切り替える(デーモン起動中はブラウザ再起動・タブ復元を伴う)')
  .action(
    run(async (name: string) => {
      const info = await pingDaemon();
      if (info) {
        const result = await rpcRaw(info, 'profile.set', { name });
        print(result, (r) =>
          `プロファイル "${r.profile}" に切り替えました(タブ ${r.restoredTabs} 件復元。ID は変わっています)\n${fmtTabs(r.tabs)}`,
        );
      } else {
        const last = readLastRun();
        writeLastRun({ headless: last?.headless ?? false, profile: name });
        print({ profile: name, applied: 'next-start' }, () => `"${name}" に設定しました(次回デーモン起動時に適用)`);
      }
    }),
  );

// ---- mode / wait / auth / emulate ----

program
  .command('mode [mode]')
  .description('表示モードの確認・切替 (headed | headless)。切替はブラウザ再起動を伴うがタブと Cookie は復元される')
  .action(
    run(async (mode?: string) => {
      if (!mode) {
        const status = await rpc('daemon.status');
        return print({ headless: status.headless }, (r) => (r.headless ? 'headless' : 'headed'));
      }
      if (mode !== 'headed' && mode !== 'headless') throw new Error('headed か headless を指定してください');
      const result = await rpc('mode.set', { headless: mode === 'headless' });
      print(result, (r) =>
        `${r.headless ? 'headless' : 'headed'} に切り替えました(タブ ${r.restoredTabs} 件復元。ID は変わっています)\n${fmtTabs(r.tabs)}`,
      );
    }),
  );

program
  .command('wait')
  .description('条件を満たすまで待機する(手動ログイン等の完了待ちに使う)。注意: 呼び出し側のシェルタイムアウトはこれより長く取ること')
  .option('--url <glob>', 'URL がこの glob に一致するまで (例: "**/dashboard**")')
  .option('--selector <sel>', 'この CSS セレクタが現れるまで')
  .option('--idle', 'ネットワークが落ち着くまで (SPA の描画待ちに)')
  .option('--any', '複数条件のどれか 1 つで待機を終える(既定はすべて満たすまで待つ AND)')
  .option('--timeout <sec>', 'タイムアウト秒数 (既定 90、最大 280)', intOpt, 90)
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { url?: string; selector?: string; idle?: boolean; any?: boolean; timeout: number; tab?: number }) => {
      const timeoutMs = Math.min(opts.timeout, 280) * 1000;
      const result = await rpc('wait', {
        url: opts.url,
        selector: opts.selector,
        idle: opts.idle,
        any: opts.any,
        timeoutMs,
        tab: opts.tab,
      });
      print(result, (r) => `OK (${r.matched.join(', ')}) — ${r.url}`);
    }),
  );

/** stdin から Enter を待つ(メッセージは stderr に出し、--json の標準出力を汚さない)。 */
function promptEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

program
  .command('login [url]')
  .description(
    'サービスに手動でサインインする: headed に切り替えて URL を開き、完了を待って保存状態を確認する。' +
      'ログイン状態はプロファイルに自動保存され、次回以降のセッションでも維持される',
  )
  .option('--until <glob>', 'この URL glob に一致したら完了とみなす (例: "**/dashboard**")。省略時は Enter 押下で完了')
  .option('--timeout <sec>', '--until の待機タイムアウト秒 (既定 280)', intOpt, 280)
  .option('--save <file>', '完了後に storage dump をこのファイルにも保存する(別プロファイル/別マシンへの持ち出し用)')
  .action(
    run(async (url: string | undefined, opts: { until?: string; timeout: number; save?: string }) => {
      const before = await rpc('daemon.status');
      if (before.headless) {
        await rpc('mode.set', { headless: false });
        console.error('(headless だったため headed に切り替えました)');
      }
      if (url) await rpc('open', { url });
      if (opts.until) {
        await rpc('wait', { url: opts.until, timeoutMs: Math.min(opts.timeout, 280) * 1000 });
      } else {
        if (!process.stdin.isTTY) {
          throw new Error('対話端末ではないため Enter 待ちができません。--until "<URL glob>" で完了条件を指定してください (例: --until "**/dashboard**")');
        }
        await promptEnter('ブラウザでサインインを完了したら Enter を押してください... ');
      }
      const state = await rpc('storage.dump');
      const profile = (await rpc('daemon.status')).profile;
      let savedTo: string | undefined;
      if (opts.save) {
        savedTo = path.resolve(opts.save);
        fs.writeFileSync(savedTo, JSON.stringify(state, null, 2));
      }
      print(
        { profile, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0, savedTo },
        (r) =>
          `ログイン状態を確認しました (cookies=${r.cookies}, origins=${r.origins})\n` +
          `プロファイル "${r.profile}" に自動保存されており、次回以降のセッションでも維持されます。` +
          (r.savedTo ? `\nバックアップ: ${r.savedTo}(kb storage restore で復元できます)` : ''),
      );
    }),
  );

const auth = program.command('auth').description('対象サイトの Basic 認証設定(ブラウザ再起動を伴う)');

auth
  .command('set <username> <password>')
  .description('Basic 認証の資格情報を設定する')
  .action(
    run(async (username: string, password: string) => {
      const result = await rpc('auth.set', { credentials: { username, password } });
      print(result, (r) => `Basic 認証を設定しました(タブ ${r.restoredTabs} 件復元。ID は変わっています)\n${fmtTabs(r.tabs)}`);
    }),
  );

auth
  .command('clear')
  .description('Basic 認証の資格情報を解除する')
  .action(
    run(async () => {
      const result = await rpc('auth.set', { credentials: null });
      print(result, (r) => `Basic 認証を解除しました(タブ ${r.restoredTabs} 件復元。ID は変わっています)\n${fmtTabs(r.tabs)}`);
    }),
  );

const emulate = program.command('emulate').description('UA / viewport / タイムゾーン / 位置情報 / 回線速度のエミュレーション');

emulate
  .command('ua <userAgent>')
  .description('User-Agent を上書きする (Client Hints も追随)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (userAgent: string, opts: { tab?: number }) => {
      const result = await rpc('emulate', { ua: userAgent, tab: opts.tab });
      print(result, () => 'UA を上書きしました(リロード後に完全反映)');
    }),
  );

emulate
  .command('viewport <size>')
  .description('画面サイズを上書きする (例: 390x844)')
  .option('--dpr <n>', 'devicePixelRatio', (v: string) => parseFloat(v), 1)
  .option('--mobile', 'モバイルとして扱う(タッチも有効化)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (size: string, opts: { dpr: number; mobile?: boolean; tab?: number }) => {
      const m = /^(\d+)x(\d+)$/.exec(size);
      if (!m) throw new Error('サイズは 390x844 の形式で指定してください');
      const result = await rpc('emulate', {
        viewport: { width: +m[1], height: +m[2], dpr: opts.dpr, mobile: opts.mobile },
        tab: opts.tab,
      });
      print(result, () => `viewport を ${size} にしました`);
    }),
  );

emulate
  .command('tz <timezoneId>')
  .description('タイムゾーンを上書きする (例: America/New_York)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (timezoneId: string, opts: { tab?: number }) => {
      const result = await rpc('emulate', { timezone: timezoneId, tab: opts.tab });
      print(result, () => `タイムゾーンを ${timezoneId} にしました`);
    }),
  );

emulate
  .command('geo <lat> <lng>')
  .description('位置情報をモックする(全タブに適用)')
  .action(
    run(async (lat: string, lng: string) => {
      await rpc('emulate.geo', { latitude: parseFloat(lat), longitude: parseFloat(lng) });
      print({ latitude: parseFloat(lat), longitude: parseFloat(lng) }, () => `位置情報を ${lat}, ${lng} にしました`);
    }),
  );

emulate
  .command('net <preset>')
  .description('回線速度をエミュレートする (offline | slow3g | fast3g | reset)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (preset: string, opts: { tab?: number }) => {
      const result = await rpc('emulate.net', { preset, tab: opts.tab });
      print(result, (r) => `回線プリセット: ${r.preset}`);
    }),
  );

emulate
  .command('reset')
  .description('エミュレーションを解除する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('emulate', { reset: true, tab: opts.tab });
      print(result, () => 'エミュレーションを解除しました');
    }),
  );

// ---- net (DevTools Network 相当) ----

const FOLLOW_INTERVAL_MS = 700;

function fmtTime(ts: string): string {
  return ts.slice(11, 19);
}

function fmtNetEntry(e: any): string {
  const status = e.event === 'requestfailed' ? `FAIL(${e.failure ?? '?'})` : (e.status ?? '…');
  // 行頭の #seq は kb net body <seq> に渡せる(本文は response 行に対して捕捉される)
  return `#${String(e.seq).padEnd(5)} ${fmtTime(e.ts)} [${e.tab}] ${String(e.method).padEnd(6)} ${String(status).padEnd(4)} ${e.resourceType.padEnd(10)} ${e.url}`;
}

function fmtConsoleEntry(e: any): string {
  return `${fmtTime(e.ts)} [${e.tab}] [${e.kind}] ${e.text}`;
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
    for (const e of entries) console.log(jsonOutput ? JSON.stringify(e) : format(e));
    since = seq;
    first = false;
    if (deadline && Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
  }
}

const net = program.command('net').description('ネットワークの監視・改変 (DevTools Network 相当)');

net
  .command('log', { isDefault: true })
  .description('ネットワークログを表示する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .option('--filter <regex>', 'URL を正規表現で絞り込む')
  .option('-n, --limit <n>', '表示件数', intOpt, 50)
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
      const seq = parseInt(seqStr.replace(/^#/, ''), 10);
      if (!Number.isFinite(seq)) throw new Error('seq は kb net log の行頭に表示される番号で指定してください (例: kb net body 123)');
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
      const seq = parseInt(seqStr.replace(/^#/, ''), 10);
      if (!Number.isFinite(seq)) throw new Error('seq は kb net log の行頭に表示される番号で指定してください (例: kb net headers 123)');
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
      await rpc('net.unroute', { id: parseInt(id, 10) });
      print({ removed: parseInt(id, 10) }, () => `ルール ${id} を解除しました`);
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
      print({ path: outPath, entries: harData.log.entries.length }, (r) => `${r.path} (${r.entries} entries)`);
    }),
  );

har
  .command('status')
  .description('HAR 記録の状態を表示する')
  .action(
    run(async () => {
      const result = await rpc('net.har.status');
      print(result, (r) => (r.recording ? `記録中 (${r.entries} entries)` : '記録していません'));
    }),
  );

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

// ---- console (DevTools Console 相当) ----

program
  .command('console')
  .description('ページのコンソールログ・エラーを表示する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .option('-n, --limit <n>', '表示件数', intOpt, 50)
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

// ---- dom (DevTools Elements 相当) ----

const dom = program.command('dom').description('DOM の検査');

dom
  .command('query <selector>')
  .description('CSS セレクタに一致する要素を表示する')
  .option('--html', 'outerHTML も表示する(要素あたり 2000 文字まで)')
  .option('--attr <name>', '指定属性の値も表示する')
  .option('-n, --limit <n>', '最大件数', intOpt, 20)
  .option('--frame <selector>', 'iframe の CSS セレクタ(この中を検索)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
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

// ---- proxy ----

const proxy = program.command('proxy').description('プロキシプロファイルの管理 (FoxyProxy 風)');

/** 設定変更をデーモンに即時反映する(未起動なら次回起動時に適用)。 */
async function reloadProxyIfRunning(): Promise<boolean> {
  const info = await pingDaemon().catch(() => null);
  if (!info) return false;
  await rpcRaw(info, 'proxy.reload');
  return true;
}

/** active の切替を proxies.json に保存し、デーモンが起動中なら無再起動で即時適用する。 */
async function applyProxy(name: string): Promise<void> {
  const cfg = loadProxyConfig();
  resolveProfile(cfg, name); // 存在チェック
  cfg.active = name;
  saveProxyConfig(cfg);
  if (await reloadProxyIfRunning()) {
    print({ active: name, applied: 'live' }, () => `"${name}" に切り替えました(無再起動で適用済み)`);
  } else {
    print({ active: name, applied: 'next-start' }, () => `"${name}" に設定しました(次回デーモン起動時に適用)`);
  }
}

proxy
  .command('add <name>')
  .description('プロファイルを追加・更新する(アクティブなプロファイルは即時反映)')
  .requiredOption('--type <type>', 'http | socks5')
  .requiredOption('--host <host>', 'プロキシのホスト/IP')
  .requiredOption('--port <port>', 'プロキシのポート', intOpt)
  .option('--user <username>', '認証ユーザー名')
  .option('--pass <password>', '認証パスワード')
  .option('--bypass <patterns>', 'プロキシを通さないホスト(カンマ区切り、例: "*.internal,localhost")')
  .action(
    run(async (name: string, opts: any) => {
      if (name === 'direct') throw new Error('"direct" は組み込みプロファイルのため使用できません');
      if (opts.type !== 'http' && opts.type !== 'socks5') throw new Error('--type は http か socks5 を指定してください');
      const profile: ProxyProfile = {
        type: opts.type,
        host: opts.host,
        port: opts.port,
        username: opts.user,
        password: opts.pass,
        bypass: opts.bypass ? String(opts.bypass).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
      };
      const cfg = loadProxyConfig();
      const updated = !!cfg.profiles[name];
      cfg.profiles[name] = profile;
      saveProxyConfig(cfg);
      await reloadProxyIfRunning();
      print({ [updated ? 'updated' : 'added']: name, profile }, () =>
        `"${name}" を${updated ? '更新' : '追加'}しました (${opts.type}://${opts.host}:${opts.port})`,
      );
    }),
  );

proxy
  .command('rm <name>')
  .description('プロファイルを削除する(参照しているルールは無効になる)')
  .action(
    run(async (name: string) => {
      const cfg = loadProxyConfig();
      if (!cfg.profiles[name]) throw new Error(`プロファイル "${name}" は存在しません`);
      delete cfg.profiles[name];
      if (cfg.active === name) cfg.active = 'direct';
      saveProxyConfig(cfg);
      await reloadProxyIfRunning();
      print({ removed: name }, () => `"${name}" を削除しました`);
    }),
  );

proxy
  .command('list', { isDefault: true })
  .description('プロファイル一覧を表示する(* = アクティブ)')
  .action(
    run(async () => {
      const cfg = loadProxyConfig();
      const entries = [
        { name: 'direct', profile: { type: 'direct' } as ProxyProfile },
        ...Object.entries(cfg.profiles).map(([name, profile]) => ({ name, profile })),
      ];
      const result = entries.map((e) => ({ ...e, active: e.name === cfg.active }));
      print(result, (list: any[]) =>
        list
          .map((e) => {
            const p = e.profile;
            const target = p.type === 'direct' ? '(プロキシなし)' : `${p.type}://${p.host}:${p.port}`;
            const auth = p.username ? ' auth' : '';
            const bypass = p.bypass?.length ? ` bypass=[${p.bypass.join(', ')}]` : '';
            return `${e.active ? '*' : ' '} ${e.name.padEnd(12)} ${target}${auth}${bypass}`;
          })
          .join('\n'),
      );
    }),
  );

proxy
  .command('use <name>')
  .description('プロファイルを切り替える(デーモン起動中なら無再起動で即時適用)')
  .action(run(async (name: string) => applyProxy(name)));

proxy
  .command('off')
  .description('プロキシを無効にする (= direct)')
  .action(run(async () => applyProxy('direct')));

proxy
  .command('status')
  .description('デーモンに実際に適用されているプロキシ状態を表示する')
  .action(
    run(async () => {
      const info = await pingDaemon();
      if (!info) {
        const cfg = loadProxyConfig();
        return print(
          { running: false, configured: cfg.active },
          (r) => `デーモンは起動していません(設定上の active: ${r.configured})`,
        );
      }
      const status = await rpcRaw(info, 'proxy.status');
      print(status, (s) => {
        const rules = s.rules.length ? s.rules.map((r: any) => `\n  ${r.pattern} → ${r.profile}`).join('') : '';
        const errs = s.lastErrors?.length
          ? `\n最近の接続エラー:` +
            s.lastErrors
              .slice(-5)
              .map((e: any) => `\n  ${e.ts.slice(11, 19)} ${e.target} (via ${e.profile}) — ${e.error}`)
              .join('')
          : '';
        return `active: ${s.active} (tunnels=${s.tunnels}, requests=${s.requests}, errors=${s.errors})${rules}${errs}`;
      });
    }),
  );

const rule = proxy.command('rule').description('ホスト別のパターン振り分けルール(先勝ち。一致しなければ active を使う)');

rule
  .command('add <pattern> <profile>')
  .description('ルールを追加する (例: kb proxy rule add "*.corp.example.com" work)')
  .action(
    run(async (pattern: string, profileName: string) => {
      const cfg = loadProxyConfig();
      resolveProfile(cfg, profileName); // 存在チェック
      cfg.rules.push({ pattern, profile: profileName });
      saveProxyConfig(cfg);
      await reloadProxyIfRunning();
      print({ added: { pattern, profile: profileName } }, () => `rule: ${pattern} → ${profileName}`);
    }),
  );

rule
  .command('rm <index>')
  .description('ルールを削除する(kb proxy rule list の番号で指定)')
  .action(
    run(async (indexStr: string) => {
      const index = parseInt(indexStr, 10);
      const cfg = loadProxyConfig();
      if (!(index >= 0 && index < cfg.rules.length)) throw new Error(`ルール ${index} は存在しません`);
      const [removed] = cfg.rules.splice(index, 1);
      saveProxyConfig(cfg);
      await reloadProxyIfRunning();
      print({ removed }, () => `削除しました: ${removed.pattern} → ${removed.profile}`);
    }),
  );

rule
  .command('list', { isDefault: true })
  .description('ルール一覧を表示する')
  .action(
    run(async () => {
      const cfg = loadProxyConfig();
      print(cfg.rules, (list: any[]) =>
        list.length
          ? list.map((r, i) => `[${i}] ${r.pattern.padEnd(30)} → ${r.profile}`).join('\n')
          : 'ルールはありません(すべて active プロファイルを使用)',
      );
    }),
  );

proxy
  .command('test [name]')
  .description('疎通確認する(外部 IP と応答時間を表示。省略時はアクティブなプロファイル)')
  .action(
    run(async (name?: string) => {
      const result = await rpc('proxy.test', { name });
      print(result, (r) => `${r.profile}: OK — 外部 IP ${r.ip} (${r.latencyMs}ms)`);
    }),
  );

program.parse();
