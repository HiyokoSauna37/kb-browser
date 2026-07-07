import type { Command } from 'commander';
import { pingDaemon, rpc, rpcRaw } from '../../shared/client';
import {
  loadProxyConfig,
  resolveProfile,
  saveProxyConfig,
  type ProxyProfile,
} from '../../shared/proxyStore';
import { intOpt, print, run } from '../output';

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

/** kb proxy — プロキシプロファイルと振り分けルールの管理 (FoxyProxy 風)。 */
export function registerProxyCommands(program: Command): void {
  const proxy = program.command('proxy').description('プロキシプロファイルの管理 (FoxyProxy 風)');

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
}
