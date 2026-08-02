import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { rpc } from '../../shared/client';
import { toCookieHeader, toNetscape, type KbCookie } from '../../shared/cookies';
import { fmtDuration } from '../../shared/format';
import { KB_VERSION } from '../../shared/version';
import { intOpt, print, run } from '../output';

/** kb downloads / cookies / storage — ブラウザに蓄積される状態の管理。 */
export function registerStateCommands(program: Command): void {
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
    .description('Cookie を書き出す (json / netscape=cookies.txt / header=Cookie ヘッダ 1 行)')
    .option('--format <fmt>', '出力形式 (json | netscape | header)', 'json')
    .option('--url <url>', 'header 形式で、この URL に実際に送られる Cookie だけに絞る(ドメイン/パス/Secure を考慮)')
    .option('-d, --domain <domain>', 'ドメインで絞り込む')
    .option('-o, --out <path>', '出力先(json は既定 kb-cookies.json、他は省略時に標準出力)')
    .action(
      run(async (opts: { format: string; url?: string; domain?: string; out?: string }) => {
        const all = (await rpc('cookies.list', { domain: opts.domain })) as KbCookie[];
        if (opts.format === 'json') {
          const outPath = path.resolve(opts.out ?? 'kb-cookies.json');
          fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
          return print({ path: outPath, cookies: all.length, format: 'json' }, (r) => `${r.path} (${r.cookies} cookies)`);
        }
        let content: string;
        let count: number;
        if (opts.format === 'netscape') {
          content = toNetscape(all, { version: KB_VERSION });
          count = all.length;
        } else if (opts.format === 'header') {
          content = toCookieHeader(all, opts.url);
          count = content ? content.split('; ').length : 0;
          if (!count) {
            throw new Error(
              opts.url
                ? `${opts.url} に送られる Cookie はありません(kb cookies list -d <domain> で確認してください)`
                : 'Cookie はありません',
            );
          }
        } else {
          throw new Error(`未対応の形式です: ${opts.format}(json | netscape | header)`);
        }
        if (!opts.out) return print({ format: opts.format, cookies: count, content }, (r) => r.content);
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, opts.format === 'header' ? content + '\n' : content);
        print({ path: outPath, cookies: count, format: opts.format }, (r) => `${r.path} (${r.cookies} cookies, ${r.format})`);
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

  const session = program.command('session').description('セッション状態の診断');

  session
    .command('check <url>')
    .description('その URL の応答が「対象パスの性質」か「自分のセッション劣化」かを、トップページとの対照で判定する')
    .option('--api <url>', '対照に使う API の URL(省略時はこのセッションで観測した同ホストの xhr/fetch を自動選択)')
    .option('--timeout <sec>', '各プローブのタイムアウト秒', intOpt, 15)
    .action(
      run(async (url: string, opts: { api?: string; timeout: number }) => {
        const r = await rpc('session.check', { url, api: opts.api, timeoutMs: opts.timeout * 1000 });
        print(r, (x) => {
          const c = x.client;
          const lines = [
            `host: ${x.host}  (profile=${c.profile}, ${c.headless ? 'headless' : 'headed'}, channel=${c.channel}, stealth=${c.stealth ? 'on' : 'off'}${c.attached ? ', attached' : ''})`,
          ];
          for (const p of x.probes) {
            const status = p.error ? `ERR ${p.error}` : `${p.status ?? '?'}`;
            const challenge = p.challenged ? `  ⚠ challenge [${p.vendor}: ${p.marker}]` : '';
            const settled = p.settledAfterMs != null ? `  (チャレンジは ${p.settledAfterMs}ms で自動通過)` : '';
            const auto = p.label === 'api' && x.apiAuto ? '  ← 自動選択' : '';
            lines.push(`  ${p.label.padEnd(7)} ${String(status).padEnd(4)} ${p.via.padEnd(8)} ${p.url}${challenge}${settled}${auto}`);
          }
          const cookies = x.cookies.length
            ? x.cookies
                .map(
                  (ck: any) =>
                    `${ck.name}(${ck.expiresIn == null ? 'session' : `期限まで ${fmtDuration(ck.expiresIn)}`}, kb 観測 ${fmtDuration(ck.ageSeen)}前)`,
                )
                .join(', ')
            : '(セッション系 Cookie なし)';
          lines.push(`  cookies: ${cookies}  [この URL に送られる Cookie 計 ${x.cookieCount} 件]`);
          lines.push('', `verdict: ${x.verdict}`, `→ ${x.hint}`);
          return lines.join('\n');
        });
      }),
    );

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
}
