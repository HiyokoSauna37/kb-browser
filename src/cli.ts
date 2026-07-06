#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { DAEMON_LOG_PATH, removeDaemonInfo } from './shared/paths';
import { pingDaemon, rpc, rpcRaw, spawnDaemon, waitForDaemon } from './shared/client';
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
  if (jsonOutput || !human) {
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

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith('about:')) return input;
  return `https://${input}`;
}

// ---- コマンド定義 ----

program
  .name('kb')
  .description('CLI-operable browser (Playwright + Chromium)')
  .version('0.1.0')
  .option('--json', 'JSON 形式で出力する')
  .hook('preAction', (cmd) => {
    jsonOutput = !!cmd.optsWithGlobals().json;
  });

const daemon = program.command('daemon').description('デーモンの管理');

daemon
  .command('start')
  .description('デーモン(ブラウザ)を起動する')
  .option('--headless', 'ヘッドレスで起動する')
  .option('--profile <name>', 'ブラウザプロファイル', 'default')
  .action(
    run(async (opts: { headless?: boolean; profile: string }) => {
      const running = await pingDaemon();
      if (running) {
        print({ alreadyRunning: true, pid: running.pid }, (r) => `既に起動しています (pid=${r.pid})`);
        return;
      }
      spawnDaemon(opts);
      const info = await waitForDaemon();
      const status = await rpcRaw(info, 'daemon.status');
      print(status, (s) => `起動しました (pid=${s.pid}, channel=${s.channel}, headless=${s.headless})`);
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
        `running (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}, tabs=${s.tabs}, proxy=${s.proxy})`,
      );
    }),
  );

program
  .command('open <url>')
  .description('URL を開く(デーモン未起動なら自動起動)')
  .option('-n, --new', '新しいタブで開く')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (url: string, opts: { new?: boolean; tab?: number }) => {
      const result = await rpc('open', { url: normalizeUrl(url), new: opts.new, tab: opts.tab });
      print(result, (r) => `tab ${r.tab}: ${r.url}`);
    }),
  );

const tabs = program.command('tabs').description('タブの一覧・操作');

tabs
  .command('list', { isDefault: true })
  .description('タブ一覧を表示する')
  .action(
    run(async () => {
      const result = await rpc('tabs.list');
      print(result, (list: any[]) =>
        list.length
          ? list.map((t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(no title)'} — ${t.url}`).join('\n')
          : 'タブはありません',
      );
    }),
  );

tabs
  .command('close <id>')
  .description('タブを閉じる')
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
  .command('screenshot')
  .description('スクリーンショットを保存する')
  .option('-o, --out <path>', '出力先', 'kb-screenshot.png')
  .option('-f, --full', 'ページ全体を撮る')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { out: string; full?: boolean; tab?: number }) => {
      const outPath = path.resolve(opts.out);
      const result = await rpc('screenshot', { path: outPath, full: opts.full, tab: opts.tab });
      print({ path: result }, (r) => r.path);
    }),
  );

program
  .command('text')
  .description('ページ本文のテキストを取得する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('text', { tab: opts.tab });
      print(result, (r) => `# ${r.title}\n# ${r.url}\n\n${r.text}`);
    }),
  );

program
  .command('html')
  .description('ページの HTML を取得する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { tab?: number }) => {
      const result = await rpc('html', { tab: opts.tab });
      print({ html: result }, (r) => r.html);
    }),
  );

program
  .command('eval <expression>')
  .description('ページ内で JavaScript を実行する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (expression: string, opts: { tab?: number }) => {
      const result = await rpc('eval', { expression, tab: opts.tab });
      print({ result }, (r) => JSON.stringify(r.result, null, 2));
    }),
  );

program
  .command('click <selector>')
  .description('要素をクリックする')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (selector: string, opts: { tab?: number }) => {
      await rpc('click', { selector, tab: opts.tab });
      print({ clicked: selector }, () => 'clicked');
    }),
  );

program
  .command('fill <selector> <value>')
  .description('フォーム要素に入力する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (selector: string, value: string, opts: { tab?: number }) => {
      await rpc('fill', { selector, value, tab: opts.tab });
      print({ filled: selector }, () => 'filled');
    }),
  );

program
  .command('press <key>')
  .description('キーを押す (例: Enter, Control+A)')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (key: string, opts: { tab?: number }) => {
      await rpc('press', { key, tab: opts.tab });
      print({ pressed: key }, () => 'pressed');
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
  .command('clear')
  .description('すべての Cookie を削除する')
  .action(
    run(async () => {
      await rpc('cookies.clear');
      print({ cleared: true }, () => 'cleared');
    }),
  );

// ---- mode / wait / emulate ----

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
      print(result, (r) => `${r.headless ? 'headless' : 'headed'} に切り替えました(タブ ${r.restoredTabs} 件復元)`);
    }),
  );

program
  .command('wait')
  .description('条件を満たすまで待機する(手動ログイン等の完了待ちに使う)')
  .option('--url <glob>', 'URL がこの glob に一致するまで (例: "**/dashboard**")')
  .option('--selector <sel>', 'この CSS セレクタが現れるまで')
  .option('--timeout <sec>', 'タイムアウト秒数 (最大 280)', (v: string) => parseInt(v, 10), 120)
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (opts: { url?: string; selector?: string; timeout: number; tab?: number }) => {
      const timeoutMs = Math.min(opts.timeout, 280) * 1000;
      const result = await rpc('wait', { url: opts.url, selector: opts.selector, timeoutMs, tab: opts.tab });
      print(result, (r) => `OK — ${r.url}`);
    }),
  );

const emulate = program.command('emulate').description('UA / viewport / タイムゾーン / 位置情報のエミュレーション');

emulate
  .command('ua <userAgent>')
  .description('User-Agent を上書きする')
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
  .option('--mobile', 'モバイルとして扱う')
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
  return `${fmtTime(e.ts)} [${e.tab}] ${String(e.method).padEnd(6)} ${String(status).padEnd(4)} ${e.resourceType.padEnd(10)} ${e.url}`;
}

function fmtConsoleEntry(e: any): string {
  return `${fmtTime(e.ts)} [${e.tab}] [${e.kind}] ${e.text}`;
}

/** since カーソルでポーリングしながら新着エントリを流し続ける (Ctrl+C で終了)。 */
async function followLog(
  cmd: 'net.log' | 'console.log',
  baseArgs: Record<string, unknown>,
  format: (e: any) => string,
): Promise<void> {
  let since = 0;
  let first = true;
  for (;;) {
    const { entries, seq } = await rpc(cmd, { ...baseArgs, since, limit: first ? (baseArgs.limit ?? 20) : undefined });
    for (const e of entries) console.log(jsonOutput ? JSON.stringify(e) : format(e));
    since = seq;
    first = false;
    await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
  }
}

const net = program.command('net').description('ネットワークの監視・改変 (DevTools Network 相当)');

net
  .command('log', { isDefault: true })
  .description('ネットワークログを表示する')
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .option('--filter <regex>', 'URL を正規表現で絞り込む')
  .option('-n, --limit <n>', '表示件数', (v: string) => parseInt(v, 10), 50)
  .option('-f, --follow', '新着を流し続ける (Ctrl+C で終了)')
  .action(
    run(async (opts: { tab?: number; filter?: string; limit: number; follow?: boolean }) => {
      const baseArgs = { tab: opts.tab, filter: opts.filter, limit: opts.limit };
      if (opts.follow) return followLog('net.log', baseArgs, fmtNetEntry);
      const { entries } = await rpc('net.log', baseArgs);
      print(entries, (list: any[]) => (list.length ? list.map(fmtNetEntry).join('\n') : 'ログはありません'));
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
  .description('パターンに一致するリクエストへ固定レスポンスを返す')
  .requiredOption('--body <file>', 'レスポンス本文のファイル')
  .option('--status <n>', 'ステータスコード', (v: string) => parseInt(v, 10), 200)
  .option('--content-type <ct>', 'Content-Type (省略時は拡張子から推定)')
  .action(
    run(async (pattern: string, opts: { body: string; status: number; contentType?: string }) => {
      const body = fs.readFileSync(path.resolve(opts.body), 'utf8');
      const contentType = opts.contentType ?? guessContentType(opts.body);
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
  .command('unroute <id>')
  .description('ルールを解除する')
  .action(
    run(async (id: string) => {
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
  .option('-n, --limit <n>', '表示件数', (v: string) => parseInt(v, 10), 50)
  .option('-f, --follow', '新着を流し続ける (Ctrl+C で終了)')
  .option('--clear', 'ログを消去する')
  .action(
    run(async (opts: { tab?: number; limit: number; follow?: boolean; clear?: boolean }) => {
      if (opts.clear) {
        await rpc('console.clear');
        return print({ cleared: true }, () => 'cleared');
      }
      const baseArgs = { tab: opts.tab, limit: opts.limit };
      if (opts.follow) return followLog('console.log', baseArgs, fmtConsoleEntry);
      const { entries } = await rpc('console.log', baseArgs);
      print(entries, (list: any[]) => (list.length ? list.map(fmtConsoleEntry).join('\n') : 'ログはありません'));
    }),
  );

// ---- dom (DevTools Elements 相当) ----

const dom = program.command('dom').description('DOM の検査');

dom
  .command('query <selector>')
  .description('CSS セレクタに一致する要素を表示する')
  .option('--html', 'outerHTML も表示する')
  .option('--attr <name>', '指定属性の値も表示する')
  .option('-n, --limit <n>', '最大件数', (v: string) => parseInt(v, 10), 20)
  .option('-t, --tab <id>', '対象タブ ID', tabOpt)
  .action(
    run(async (selector: string, opts: { html?: boolean; attr?: string; limit: number; tab?: number }) => {
      const result = await rpc('dom.query', {
        selector,
        html: opts.html,
        attr: opts.attr,
        limit: opts.limit,
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

/** active の切替を proxies.json に保存し、デーモンが起動中なら無再起動で即時適用する。 */
async function applyProxy(name: string): Promise<void> {
  const cfg = loadProxyConfig();
  resolveProfile(cfg, name); // 存在チェック
  cfg.active = name;
  saveProxyConfig(cfg);
  const info = await pingDaemon();
  if (info) {
    await rpcRaw(info, 'proxy.use', { name });
    print({ active: name, applied: 'live' }, () => `"${name}" に切り替えました(無再起動で適用済み)`);
  } else {
    print({ active: name, applied: 'next-start' }, () => `"${name}" に設定しました(次回デーモン起動時に適用)`);
  }
}

proxy
  .command('add <name>')
  .description('プロファイルを追加する')
  .requiredOption('--type <type>', 'http | socks5')
  .requiredOption('--host <host>', 'プロキシのホスト/IP')
  .requiredOption('--port <port>', 'プロキシのポート', (v: string) => parseInt(v, 10))
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
      cfg.profiles[name] = profile;
      saveProxyConfig(cfg);
      print({ added: name, profile }, () => `"${name}" を追加しました (${opts.type}://${opts.host}:${opts.port})`);
    }),
  );

proxy
  .command('rm <name>')
  .description('プロファイルを削除する')
  .action(
    run(async (name: string) => {
      const cfg = loadProxyConfig();
      if (!cfg.profiles[name]) throw new Error(`プロファイル "${name}" は存在しません`);
      delete cfg.profiles[name];
      if (cfg.active === name) cfg.active = 'direct';
      saveProxyConfig(cfg);
      const info = await pingDaemon();
      if (info && cfg.active === 'direct') await rpcRaw(info, 'proxy.use', { name: 'direct' });
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

const rule = proxy.command('rule').description('ホスト別のパターン振り分けルール(先勝ち。一致しなければ active を使う)');

/** ルール変更をデーモンに即時反映する(未起動なら次回起動時に適用)。 */
async function reloadProxyIfRunning(): Promise<void> {
  const info = await pingDaemon();
  if (info) await rpcRaw(info, 'proxy.reload');
}

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
