import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { rpc } from '../../shared/client';
import { fmtAction, intOpt, print, run } from '../output';

/** 操作系コマンド共通の対象指定 (selector または --ref。--frame で iframe 内を指定)。 */
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .option('--ref <ref>', 'kb snapshot の要素 ref (例: e12。iframe 内は f1e3)')
    .option('--frame <selector>', 'iframe の CSS セレクタ(この中で selector を解決)');
}

/** kb click / fill / press / … / pdf — 要素操作とページ操作。 */
export function registerActionCommands(program: Command): void {
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (opts: { tab?: number }) => {
        const result = await rpc('back', { tab: opts.tab });
        print(result, (r) => (r.navigated ? `back → ${r.url}` : '戻れる履歴がありません'));
      }),
    );

  program
    .command('forward')
    .description('ブラウザ履歴を進む')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (opts: { tab?: number }) => {
        const result = await rpc('forward', { tab: opts.tab });
        print(result, (r) => (r.navigated ? `forward → ${r.url}` : '進める履歴がありません'));
      }),
    );

  program
    .command('reload')
    .description('ページを再読み込みする')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (opts: { out: string; tab?: number }) => {
        const outPath = path.resolve(opts.out);
        const result = await rpc('pdf', { path: outPath, tab: opts.tab });
        print({ path: result }, (r) => r.path);
      }),
    );
}
