import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import { PROFILES_DIR, readLastRun, writeLastRun } from '../../shared/paths';
import { pingDaemon, rpc, rpcRaw } from '../../shared/client';
import { WAIT_DEFAULT_SEC, WAIT_MAX_SEC } from '../../shared/constants';
import { floatOpt, fmtTabs, intOpt, print, run } from '../output';

/** stdin から Enter を待つ(メッセージは stderr に出し、--json の標準出力を汚さない)。 */
function promptEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

/** kb profile / mode / wait / login / auth / emulate — 実行環境の切替と待機。 */
export function registerEnvCommands(program: Command): void {
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
          // last の channel / userAgent / stealth を保持したまま profile だけ差し替える
          // (spread しないと次回自動 spawn がそれらを失う。stealth 永続化の契約もここで守る)
          writeLastRun({ ...last, headless: last?.headless ?? false, profile: name });
          print({ profile: name, applied: 'next-start' }, () => `"${name}" に設定しました(次回デーモン起動時に適用)`);
        }
      }),
    );

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
    .option('--selector-gone <sel>', 'この CSS セレクタが消える(非表示/DOM から除去)まで。ボット検出チャレンジの通過検知などに')
    .option('--idle', 'ネットワークが落ち着くまで (SPA の描画待ちに)')
    .option('--any', '複数条件のどれか 1 つで待機を終える(既定はすべて満たすまで待つ AND)')
    .option('--timeout <sec>', 'タイムアウト秒数 (既定 90、最大 280)', intOpt, WAIT_DEFAULT_SEC)
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (opts: { url?: string; selector?: string; selectorGone?: string; idle?: boolean; any?: boolean; timeout: number; tab?: number }) => {
        const timeoutMs = Math.min(opts.timeout, WAIT_MAX_SEC) * 1000;
        const result = await rpc('wait', {
          url: opts.url,
          selector: opts.selector,
          selectorGone: opts.selectorGone,
          idle: opts.idle,
          any: opts.any,
          timeoutMs,
          tab: opts.tab,
        });
        print(result, (r) => `OK (${r.matched.join(', ')}) — ${r.url}`);
      }),
    );

  program
    .command('login [url]')
    .description(
      'サービスに手動でサインイン(またはボット検出チャレンジを通過)する: headed に切り替えて URL を開き、' +
        '完了を待って保存状態を確認する。ログイン状態やチャレンジ通過 Cookie(cf_clearance 等)はプロファイルに' +
        '自動保存され、次回以降のセッションでも維持される',
    )
    .option('--until <glob>', 'この URL glob に一致したら完了 (例: "**/dashboard**")')
    .option('--until-selector <sel>', 'この CSS セレクタが現れたら完了(ログイン後にだけ出る要素など)')
    .option('--until-gone <sel>', 'この CSS セレクタが消えたら完了(Cloudflare 等のチャレンジ iframe が消える = 通過)')
    .option('--timeout <sec>', '完了条件の待機タイムアウト秒 (既定 280)。条件未指定時は Enter 押下で完了', intOpt, WAIT_MAX_SEC)
    .option('--save <file>', '完了後に storage dump をこのファイルにも保存する(別プロファイル/別マシンへの持ち出し用)')
    .action(
      run(async (url: string | undefined, opts: { until?: string; untilSelector?: string; untilGone?: string; timeout: number; save?: string }) => {
        const before = await rpc('daemon.status');
        if (before.headless) {
          await rpc('mode.set', { headless: false });
          console.error('(headless だったため headed に切り替えました)');
        }
        if (url) await rpc('open', { url });
        // url / selector / selector-gone のどれかが指定されていれば、最初に満たされた条件で完了する(any=true)。
        // どれも無ければ従来どおり Enter 押下(手動でサインイン/チャレンジ通過を見届けてもらう)。
        if (opts.until || opts.untilSelector || opts.untilGone) {
          await rpc('wait', {
            url: opts.until,
            selector: opts.untilSelector,
            selectorGone: opts.untilGone,
            any: true,
            timeoutMs: Math.min(opts.timeout, WAIT_MAX_SEC) * 1000,
          });
        } else {
          if (!process.stdin.isTTY) {
            throw new Error(
              '対話端末ではないため Enter 待ちができません。完了条件を指定してください: ' +
                '--until "<URL glob>" / --until-selector "<CSS>" / --until-gone "<CSS>"',
            );
          }
          await promptEnter('ブラウザでサインイン(またはチャレンジ通過)を完了したら Enter を押してください... ');
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (userAgent: string, opts: { tab?: number }) => {
        const result = await rpc('emulate', { ua: userAgent, tab: opts.tab });
        print(result, () => 'UA を上書きしました(リロード後に完全反映)');
      }),
    );

  emulate
    .command('viewport <size>')
    .description('画面サイズを上書きする (例: 390x844)')
    .option('--dpr <n>', 'devicePixelRatio', floatOpt, 1)
    .option('--mobile', 'モバイルとして扱う(タッチも有効化)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
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
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
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
        await rpc('emulate.geo', { latitude: floatOpt(lat), longitude: floatOpt(lng) });
        print({ latitude: floatOpt(lat), longitude: floatOpt(lng) }, () => `位置情報を ${lat}, ${lng} にしました`);
      }),
    );

  emulate
    .command('net <preset>')
    .description('回線速度をエミュレートする (offline | slow3g | fast3g | reset)')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (preset: string, opts: { tab?: number }) => {
        const result = await rpc('emulate.net', { preset, tab: opts.tab });
        print(result, (r) => `回線プリセット: ${r.preset}`);
      }),
    );

  emulate
    .command('reset')
    .description('エミュレーションを解除する')
    .option('-t, --tab <id>', '対象タブ ID', intOpt)
    .action(
      run(async (opts: { tab?: number }) => {
        const result = await rpc('emulate', { reset: true, tab: opts.tab });
        print(result, () => 'エミュレーションを解除しました');
      }),
    );
}
