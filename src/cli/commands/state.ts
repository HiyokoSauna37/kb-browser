import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { rpc } from '../../shared/client';
import { print, run } from '../output';

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
