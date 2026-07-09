import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import { pingDaemon, rpc, rpcRaw } from '../../shared/client';
import {
  loadProxyConfig,
  resolveProfile,
  saveProxyConfig,
  type ProxyProfile,
} from '../../shared/proxyStore';
import {
  CaStoreUnsupportedError,
  extractProxyRootCa,
  installCaToStore,
  loadCaFromFile,
  removeCaFromStore,
} from '../caTrust';
import { intOpt, print, run } from '../output';

/** trust-ca が MITM ルート CA を抽出するために接続する既定の HTTPS ホスト。 */
const DEFAULT_CA_PROBE = 'example.com';

/** stdin から y/N を読む(メッセージは stderr に出し、--json の標準出力を汚さない)。 */
function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(message, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    }),
  );
}

/** OS 別の手動導入手順(自動導入未対応 OS 向け)。 */
function manualInstallHint(platform: string, pemPath: string): string {
  if (platform === 'darwin') {
    return `  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${pemPath}"`;
  }
  return [
    `  # システムストア (要 sudo):`,
    `  sudo cp "${pemPath}" /usr/local/share/ca-certificates/kb-proxy.crt && sudo update-ca-certificates`,
    `  # Chromium は NSS を使うため、加えて:`,
    `  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n kb-proxy -i "${pemPath}"`,
  ].join('\n');
}

/**
 * 上流プロキシの MITM ルート CA を抽出し、確認のうえ OS の信頼ルートストアに導入する。
 * proxy add --trust-ca と proxy trust-ca <name> の共通処理。
 */
async function trustCaFlow(
  name: string,
  profile: ProxyProfile,
  opts: { probe?: string; yes?: boolean; scoped?: boolean },
): Promise<void> {
  if (profile.type === 'direct') throw new Error('direct プロファイルには信頼させる CA がありません。');
  const probe = opts.probe || DEFAULT_CA_PROBE;
  console.error(`kb: "${name}" 経由で ${probe}:443 に接続し、MITM ルート CA を抽出しています...`);
  const ca = await extractProxyRootCa(profile, probe);
  if (ca.chainsToPublicCa) {
    throw new Error(
      `${probe} は公的に信頼された証明書を返しました(このプロキシは ${probe} を傍受していません)。\n` +
        `デバッグプロキシ側で対象ホストの SSL proxying(HTTPS 復号)を有効にするか、` +
        `--ca-probe <プロキシが傍受しているホスト> を指定してください。`,
    );
  }
  console.error(
    `\n信頼させようとしている MITM ルート CA:\n` +
      `  subject:    ${ca.subject}\n` +
      `  issuer:     ${ca.issuer}\n` +
      `  valid:      ${ca.validFrom} 〜 ${ca.validTo}\n` +
      `  SHA-256:    ${ca.fingerprint256}\n` +
      `  thumbprint: ${ca.thumbprint}\n` +
      `\n⚠ これを OS の信頼ルートに導入すると、この CA の秘密鍵を持つ者はあなたの HTTPS 通信を\n` +
      `  傍受できるようになります。信頼できる自分のデバッグプロキシに対してのみ実行してください。\n`,
  );
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('対話端末ではないため確認できません。内容を確認のうえ --yes を付けて実行してください。');
    }
    const q = opts.scoped ? 'この CA を kb に(OS ストア非経由で)信頼登録しますか? [y/N] ' : 'この CA を信頼ルートに導入しますか? [y/N] ';
    if (!(await promptConfirm(q))) {
      throw new Error('中止しました(CA は登録していません)。');
    }
  }
  // --scoped: OS ストアを触らず、SPKI をプロファイルに記録する(適用は daemon 再起動時)。
  if (opts.scoped) {
    const cfg = loadProxyConfig();
    const stored = cfg.profiles[name];
    if (stored && stored.type !== 'direct') {
      stored.caSpki = ca.spki;
      stored.caSubject = ca.subject;
      saveProxyConfig(cfg);
    }
    return print({ trustedScoped: name, spki: ca.spki, subject: ca.subject }, () =>
      `"${name}" の CA を OS ストア非経由で信頼登録しました(SPKI 限定・OS ストアは無変更)。\n` +
        `適用するには kb daemon restart を実行してください。取り消し: kb proxy untrust-ca ${name}`,
    );
  }
  let store: string;
  try {
    ({ store } = installCaToStore(ca.pem, ca.thumbprint));
  } catch (err) {
    if (err instanceof CaStoreUnsupportedError) {
      const outPath = path.resolve(`kb-${name}-ca.crt`);
      fs.writeFileSync(outPath, ca.pem);
      throw new Error(
        `この OS (${err.platform}) では証明書ストアへの自動導入に未対応です。証明書を ${outPath} に保存しました。\n` +
          `手動で導入してください:\n${manualInstallHint(err.platform, outPath)}`,
      );
    }
    throw err;
  }
  // untrust-ca / proxy list 用に thumbprint を記録する(証明書実体は OS ストア側)。
  const cfg = loadProxyConfig();
  const stored = cfg.profiles[name];
  if (stored && stored.type !== 'direct') {
    stored.trustedCa = { thumbprint: ca.thumbprint, subject: ca.subject, store, installedAt: new Date().toISOString() };
    saveProxyConfig(cfg);
  }
  print({ trusted: name, thumbprint: ca.thumbprint, store, subject: ca.subject }, () =>
    `"${name}" の MITM ルート CA を信頼しました (${store})。取り消し: kb proxy untrust-ca ${name}`,
  );
}

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
    .option('--ca <path>', 'このプロファイル用に信頼する CA 証明書ファイル(PEM/DER)。OS ストアを触らず SPKI 限定で信頼する')
    .option('--trust-ca', 'MITM デバッグプロキシ(Charles/Fiddler 等)のルート CA を抽出し OS の信頼ルートに導入する')
    .option('--ca-probe <host>', '--trust-ca が CA 抽出に接続するホスト(プロキシが傍受しているホスト。既定 example.com)')
    .option('--yes', '--trust-ca の確認プロンプトを省略する')
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
        const addedMsg = `"${name}" を${updated ? '更新' : '追加'}しました (${opts.type}://${opts.host}:${opts.port})`;
        // --trust-ca 指定時は add の確認を stderr に出し、stdout の結果(--json)は trustCaFlow に一本化する
        if (opts.trustCa) {
          console.error(addedMsg);
          await trustCaFlow(name, profile, { probe: opts.caProbe, yes: opts.yes });
          return;
        }
        // --ca <file>: OS ストア非経由で、ファイルの CA を SPKI 限定で信頼登録する(適用は daemon 再起動)
        if (opts.ca) {
          const { spki, subject } = loadCaFromFile(path.resolve(opts.ca));
          const cfg2 = loadProxyConfig();
          const stored = cfg2.profiles[name];
          if (stored && stored.type !== 'direct') {
            stored.caSpki = spki;
            stored.caSubject = subject;
            saveProxyConfig(cfg2);
          }
          return print({ added: name, profile, caSubject: subject, spki }, () =>
            `${addedMsg}\nCA "${subject}" を OS ストア非経由で信頼登録しました(SPKI 限定)。適用: kb daemon restart`,
          );
        }
        print({ [updated ? 'updated' : 'added']: name, profile }, () => addedMsg);
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
              const auth = p.type !== 'direct' && p.username ? ' auth' : '';
              const bypass = p.type !== 'direct' && p.bypass?.length ? ` bypass=[${p.bypass.join(', ')}]` : '';
              const ca =
                p.type !== 'direct'
                  ? (p.trustedCa ? ' trusted-ca(os)' : '') + (p.caSpki ? ' trusted-ca(scoped)' : '')
                  : '';
              return `${e.active ? '*' : ' '} ${e.name.padEnd(12)} ${target}${auth}${bypass}${ca}`;
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
    .command('trust-ca <name>')
    .description('上流プロキシの MITM ルート CA を抽出して信頼する(HTTPS 復号するデバッグプロキシ用)。既定は OS ストア導入、--scoped で OS ストア非経由')
    .option('--scoped', 'OS ストアを触らず kb だけで信頼する(SPKI 限定。適用に daemon 再起動が要る)')
    .option('--ca-probe <host>', 'CA 抽出に接続するホスト(プロキシが傍受しているホスト。既定 example.com)')
    .option('--yes', '確認プロンプトを省略する')
    .action(
      run(async (name: string, opts: { scoped?: boolean; caProbe?: string; yes?: boolean }) => {
        const cfg = loadProxyConfig();
        const profile = resolveProfile(cfg, name); // 存在チェック(direct は trustCaFlow が弾く)
        await trustCaFlow(name, profile, { probe: opts.caProbe, yes: opts.yes, scoped: opts.scoped });
      }),
    );

  proxy
    .command('untrust-ca <name>')
    .description('trust-ca / --ca で信頼させた CA を取り消す(OS ストア導入分は削除、スコープ分は SPKI 登録を解除)')
    .action(
      run(async (name: string) => {
        const cfg = loadProxyConfig();
        const p = cfg.profiles[name];
        if (!p) throw new Error(`プロファイル "${name}" は存在しません`);
        if (p.type === 'direct' || (!p.trustedCa && !p.caSpki)) {
          throw new Error(`"${name}" に信頼させた CA の記録がありません(trust-ca / --ca で登録したものだけ取り消せます)。`);
        }
        const done: string[] = [];
        // OS ストア導入分を削除する
        if (p.trustedCa) {
          try {
            removeCaFromStore(p.trustedCa.thumbprint);
          } catch (err) {
            if (err instanceof CaStoreUnsupportedError) {
              throw new Error(
                `この OS (${err.platform}) では OS ストアからの自動削除に未対応です。手動で thumbprint ${p.trustedCa.thumbprint} の証明書を削除してください。`,
              );
            }
            throw err;
          }
          done.push(`OS ストアから削除 (${p.trustedCa.thumbprint})`);
          delete p.trustedCa;
        }
        // スコープ(SPKI)分を解除する
        if (p.caSpki) {
          done.push('SPKI 登録を解除(反映に kb daemon restart)');
          delete p.caSpki;
          delete p.caSubject;
        }
        saveProxyConfig(cfg);
        print({ untrusted: name, done }, () => `"${name}" の CA 信頼を取り消しました: ${done.join(' / ')}`);
      }),
    );

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
          // HTTPS は CONNECT トンネルとして tunnels に、平文 HTTP は requests に計上される。
          // HTTPS のみのブラウジングで requests=0 を「通信なし」と誤読しないようラベルを明示する。
          const total = s.tunnels + s.requests;
          return (
            `active: ${s.active} — 通信 ${total} 件 ` +
            `(HTTPS/CONNECTトンネル=${s.tunnels}, 平文HTTPリクエスト=${s.requests}, errors=${s.errors})${rules}${errs}`
          );
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
    .description('疎通確認する(外部 IP と応答時間を表示。省略時はアクティブなプロファイル)。ブラウザ同様、証明書エラーでは落とさず信頼状況を注記する')
    .action(
      run(async (name?: string) => {
        const result = await rpc('proxy.test', { name });
        print(result, (r) => {
          const trust = r.tlsTrusted ? ' [TLS: 信頼済み]' : ' [TLS: 未検証]';
          let out = `${r.profile}: OK — 外部 IP ${r.ip} (${r.latencyMs}ms)${trust}`;
          if (r.tlsNote) out += `\n  ⚠ ${r.tlsNote}`;
          return out;
        });
      }),
    );
}
