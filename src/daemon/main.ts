import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { BrowserHost, type DialogPolicy } from './host';
import { IdleReaper, resolveIdleTimeoutMs } from './idle';
import { Journal, pruneLogSessions } from './journal';
import { RelayProxy } from './relay';
import { loadProxyConfig, resolveProfile } from '../shared/proxyStore';
import { clipStr, summarizeArgs } from '../shared/oplog';
import { isRpcCommand, rpcSchemas, type RpcArgs, type RpcCommand } from '../shared/rpc';
import { splitExtensionsArg } from '../shared/util';
import {
  DAEMON_LOG_PATH,
  ensureKbHome,
  readDiskBuildId,
  removeDaemonInfoIfOwned,
  writeDaemonInfo,
  writeLastRun,
} from '../shared/paths';
import { KB_VERSION } from '../shared/version';

interface RpcRequest {
  cmd: string;
  args: Record<string, any>;
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.appendFileSync(DAEMON_LOG_PATH, line);
  } catch {
    /* logging must never kill the daemon */
  }
}

function tokenMatches(given: unknown, expected: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function main(): Promise<void> {
  ensureKbHome();

  const argValue = (name: string): string | undefined => {
    const idx = process.argv.indexOf(name);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  const headless = process.argv.includes('--headless');
  const profile = argValue('--profile') ?? 'default';
  const channel = argValue('--channel') as 'chrome' | 'msedge' | 'chromium' | undefined;
  const userAgent = argValue('--ua');
  const cdpUrl = argValue('--cdp');
  const stealth = process.argv.includes('--stealth');
  const ignoreHttpsErrors = process.argv.includes('--ignore-https-errors');
  // 拡張機能: 'on' = プロファイル拡張の有効化のみ、csv = 未パック拡張ディレクトリ(絶対パス)
  const extensionsArg = argValue('--extensions');
  const extensions = extensionsArg == null ? undefined : splitExtensionsArg(extensionsArg);
  // アイドル自動終了の閾値(ms)。0 なら無効。--idle-timeout(秒)> KB_IDLE_TIMEOUT(秒)> 既定 30 分。
  const idleArgSec = argValue('--idle-timeout');
  const idleMs = resolveIdleTimeoutMs(idleArgSec, process.env.KB_IDLE_TIMEOUT);
  const idleTimeoutSec = Math.round(idleMs / 1000); // status 用(0 = 無効)
  // last-run には明示指定(argv)だけを記録する(channel/ua と同じ扱い)。env/既定から解決した値を
  // 焼き込むと、以後の spawn で last-run が引数として最優先になり KB_IDLE_TIMEOUT が二度と効かなくなる。
  const idleLastRunSec = idleArgSec != null && idleArgSec !== '' ? idleTimeoutSec : undefined;

  const host = new BrowserHost();
  const relay = new RelayProxy();
  const journal = new Journal();
  const token = crypto.randomBytes(16).toString('hex');
  let shuttingDown = false;
  let reaper: IdleReaper | null = null;
  /** 実行中の RPC 数。0 でない間は idle reaper の発火を保留する(wait 等の長時間 RPC 保護)。 */
  let inflightRpcs = 0;

  /** 操作ジャーナルに記録しない読み取り系・ログ操作系コマンド。 */
  const JOURNAL_EXCLUDE = new Set([
    'daemon.status', 'daemon.stop',
    'tabs.list', 'downloads.list', 'cookies.list', 'storage.dump',
    'net.log', 'net.body', 'net.headers', 'net.rules', 'net.har.status',
    'console.log', 'proxy.status', 'proxy.test',
    'log.start', 'log.stop', 'log.status',
    'dialog.info',
  ]);

  /** 自動スクリーンショット(kb log start --shots)の対象になる操作コマンド。 */
  const AUTO_SHOT_CMDS = new Set([
    'open', 'click', 'fill', 'press', 'hover', 'check', 'select', 'upload', 'scroll',
    'back', 'forward', 'reload', 'dialog.respond',
  ]);

  /** RPC 1 回分をジャーナルへ記録する。 */
  function journalCommand(rpc: RpcRequest, ok: boolean, durationMs: number, result?: unknown, error?: string, shot?: string): void {
    if (JOURNAL_EXCLUDE.has(rpc.cmd)) return;
    const summary = result === undefined ? undefined : clipStr(JSON.stringify(result) ?? '', 500);
    journal.append({
      type: 'command',
      cmd: rpc.cmd,
      args: summarizeArgs(rpc.cmd, rpc.args ?? {}),
      ok,
      durationMs,
      ...(summary !== undefined ? { result: summary } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(shot !== undefined ? { shot } : {}),
    });
  }

  /** --shots 有効時、操作直後の画面をセッションフォルダに保存する(失敗しても操作は成功扱い)。 */
  async function autoShot(rpc: RpcRequest): Promise<string | undefined> {
    if (!journal.autoShots || !AUTO_SHOT_CMDS.has(rpc.cmd)) return undefined;
    const dest = journal.nextShotPath();
    if (!dest) return undefined;
    try {
      await host.screenshot(dest.abs, {}, rpc.args?.tab);
      return dest.rel;
    } catch {
      return undefined;
    }
  }

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    reaper?.stop();
    journal.stop();
    removeDaemonInfoIfOwned(process.pid);
    await host.stop();
    await relay.stop();
    server.close();
    // close() はアクティブな keep-alive 接続を待つことがあるため確実に終了する
    setTimeout(() => process.exit(0), 200).unref();
  };

  host.onClosed = () => void shutdown('browser window closed');

  const server = http.createServer(async (req, res) => {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!tokenMatches(req.headers['x-kb-token'], token)) {
      return respond(401, { ok: false, error: 'unauthorized' });
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      return respond(404, { ok: false, error: 'not found' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let rpc: RpcRequest;
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return respond(400, { ok: false, error: 'invalid JSON body' });
    }

    // 任意の RPC 受信を「活動」としてアイドルタイマーをリセットする(クライアント生存の証)。
    // 実行中は inflightRpcs>0 が idle 発火を保留し、完了時にも touch してそこを新たな起点にする
    // (wait 等の「閾値より長い単一 RPC」が実行中に刈り取られないように)。
    reaper?.touch();
    inflightRpcs++;

    const startedMs = Date.now();
    try {
      const result = await dispatch(rpc);
      const shot = await autoShot(rpc);
      journalCommand(rpc, true, Date.now() - startedMs, result, undefined, shot);
      respond(200, { ok: true, result });
      if (rpc.cmd === 'daemon.stop') void shutdown('stop command');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      journalCommand(rpc, false, Date.now() - startedMs, undefined, message);
      respond(200, { ok: false, error: message });
    } finally {
      inflightRpcs--;
      reaper?.touch();
    }
  });

  /** click / fill 等の操作対象 (selector / ref / frame / tab) を組み立てる。 */
  const target = (a: { selector?: string; ref?: string; frame?: string; tab?: number }) => ({
    selector: a.selector,
    ref: a.ref,
    frame: a.frame,
    tab: a.tab,
  });

  /**
   * コマンド名 → ハンドラの対応表。mapped type `{ [C in RpcCommand]: ... }` により
   * 「全コマンドにハンドラがある」ことがコンパイル時に強制される(漏れ・余剰はエラー)。
   * 各ハンドラの引数は shared/rpc.ts のスキーマから導いた `RpcArgs<C>` で型付けされる。
   */
  type RpcHandler<C extends RpcCommand> = (args: RpcArgs<C>) => unknown | Promise<unknown>;
  const handlers: { [C in RpcCommand]: RpcHandler<C> } = {
    'daemon.status': () => ({ ...host.status(), proxy: relay.status().active, idleTimeoutSec }),
    'daemon.stop': () => ({ stopping: true }),
    'proxy.use': () => {
      applyProxyConfig();
      log(`proxy config reloaded (active=${relay.status().active})`);
      return relay.status();
    },
    'proxy.reload': () => {
      applyProxyConfig();
      log(`proxy config reloaded (active=${relay.status().active})`);
      return relay.status();
    },
    'proxy.status': () => relay.status(),
    'proxy.test': async (a) => {
      const cfg = loadProxyConfig();
      const name = a.name ?? relay.status().active;
      const result = await relay.testUpstream(resolveProfile(cfg, name));
      return { profile: name, ...result };
    },
    'open': (a) => host.open(a.url, !!a.new, a.tab, a.waitUntil),
    'tabs.list': () => host.listTabs(),
    'tabs.close': (a) => host.closeTab(a.tab),
    'tabs.activate': (a) => host.activateTab(a.tab),
    'screenshot': (a) =>
      host.screenshot(
        a.path,
        { full: !!a.full, selector: a.selector, ref: a.ref, frame: a.frame, timeoutMs: a.timeoutMs },
        a.tab,
      ),
    'text': (a) => host.text(a.tab, { maxChars: a.maxChars, offset: a.offset }),
    'html': (a) => host.html(a.tab, { maxChars: a.maxChars, offset: a.offset }),
    'snapshot': (a) => host.snapshot(a.tab, { maxChars: a.maxChars, offset: a.offset }),
    'eval': (a) => host.eval(a.expression, a.tab, { maxChars: a.maxChars, offset: a.offset }),
    'click': (a) => host.click(target(a)),
    'fill': (a) => host.fill(target(a), a.value),
    'press': (a) => host.press(a.key, a.tab),
    'hover': (a) => host.hover(target(a)),
    'check': (a) => host.setChecked(target(a), a.checked !== false),
    'select': (a) => host.select(target(a), a.values ?? [], !!a.byLabel),
    'upload': (a) => host.upload(target(a), a.files ?? []),
    'scroll': (a) => host.scroll({ by: a.by, to: a.to, top: a.top, bottom: a.bottom }, a.tab),
    'back': (a) => host.goBack(a.tab),
    'forward': (a) => host.goForward(a.tab),
    'reload': (a) => host.reload(a.tab),
    'pdf': (a) => host.pdf(a.path, a.tab),
    'downloads.list': () => host.listDownloads(),
    'downloads.clear': () => host.clearDownloads(),
    'cookies.list': (a) => host.cookies(a.domain),
    'cookies.set': (a) => host.setCookie(a.cookie),
    'cookies.rm': (a) => host.removeCookie(a.name, a.domain),
    'cookies.clear': () => host.clearCookies(),
    'cookies.import': (a) => host.importCookies(a.cookies ?? []),
    'storage.dump': () => host.storageDump(),
    'storage.restore': (a) => host.storageRestore(a.state ?? {}),
    'net.log': (a) => host.netLogQuery(a),
    'net.body': (a) => host.netBody(a.seq, { maxChars: a.maxChars, offset: a.offset }),
    'net.headers': (a) => host.netHeadersQuery(a.seq),
    'log.start': (a) => journal.start(a.name, sessionMeta(), { shots: !!a.shots }),
    'log.stop': () => journal.stop(),
    'log.status': () => journal.status(),
    'request': (a) =>
      host.httpRequest({
        url: a.url,
        method: a.method,
        headers: a.headers,
        data: a.data,
        timeoutMs: a.timeoutMs,
        follow: a.follow,
        savePath: a.savePath,
        maxChars: a.maxChars,
        offset: a.offset,
      }),
    'net.clear': () => host.netClear(),
    'net.block': (a) => host.addBlock(a.pattern),
    'net.mock': (a) => host.addMock(a.pattern, a.status, a.contentType, a.body),
    'net.rules': () => host.listRoutes(),
    'net.unroute': (a) => (a.all ? host.removeAllRoutes() : host.removeRoute(a.id!)),
    'net.har.start': () => host.harStart(),
    'net.har.stop': () => host.harStop(),
    'net.har.status': () => host.harStatus(),
    'console.log': (a) => host.consoleQuery(a),
    'console.clear': () => host.consoleClear(),
    'dom.query': (a) => host.domQuery(a.selector, a, a.tab),
    'dialog.info': (a) => host.dialogInfo(a.tab),
    'dialog.respond': (a) => host.dialogRespond(!!a.accept, a.text, a.tab),
    'dialog.policy': (a) => host.setDialogPolicy(a.policy as DialogPolicy | undefined),
    'mode.set': async (a) => {
      const result = await host.setMode(!!a.headless);
      writeLastRun({ headless: host.headless, profile: host.profile, channel, userAgent, stealth, idleTimeoutSec: idleLastRunSec, extensions, ignoreHttpsErrors });
      log(`mode switched: headless=${result.headless} (restored ${result.restoredTabs} tabs)`);
      return result;
    },
    'profile.set': async (a) => {
      const result = await host.setProfile(a.name);
      writeLastRun({ headless: host.headless, profile: host.profile, channel, userAgent, stealth, idleTimeoutSec: idleLastRunSec, extensions, ignoreHttpsErrors });
      log(`profile switched: ${result.profile} (restored ${result.restoredTabs} tabs)`);
      return result;
    },
    'auth.set': async (a) => {
      const result = await host.setAuth(a.credentials ?? null);
      log(`http credentials ${result.auth ? 'set' : 'cleared'}`);
      return result;
    },
    'wait': (a) =>
      host.waitFor(
        { url: a.url, selector: a.selector, selectorGone: a.selectorGone, idle: !!a.idle, any: !!a.any, timeoutMs: a.timeoutMs ?? 120_000 },
        a.tab,
      ),
    'emulate': (a) => host.emulate(a, a.tab),
    'emulate.geo': (a) => host.setGeolocation(a.latitude, a.longitude),
    'emulate.net': (a) => host.emulateNetwork(a.preset, a.tab),
  };

  /**
   * RPC を検証してハンドラへ振り分ける。受信境界でスキーマ検証(非 strict なので未知キーは
   * 落とす)し、検証済みの引数をハンドラに渡す。コマンド名とその引数は実行時インデックスなので
   * 型システムでは相関できず、境界の 1 箇所だけ unknown に消去する(検証済みのため安全)。
   */
  async function dispatch({ cmd, args }: RpcRequest): Promise<unknown> {
    if (!isRpcCommand(cmd)) throw new Error(`unknown command: ${cmd}`);
    let parsed: unknown;
    try {
      parsed = rpcSchemas[cmd].parse(args ?? {});
    } catch (err) {
      if (err instanceof z.ZodError) {
        const detail = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new Error(`引数が不正です (${cmd}): ${detail}`);
      }
      throw err;
    }
    return (handlers[cmd] as (a: unknown) => unknown)(parsed);
  }

  /** proxies.json を読み直し、active と振り分けルールを relay に反映する。 */
  function applyProxyConfig(): void {
    const cfg = loadProxyConfig();
    try {
      relay.setUpstream(cfg.active, resolveProfile(cfg, cfg.active));
    } catch (err) {
      log(`proxy profile "${cfg.active}" が解決できないため direct を使います: ${String(err)}`);
      relay.setUpstream('direct', resolveProfile(cfg, 'direct'));
    }
    const rules: { pattern: string; name: string; profile: ReturnType<typeof resolveProfile> }[] = [];
    for (const rule of cfg.rules) {
      try {
        rules.push({ pattern: rule.pattern, name: rule.profile, profile: resolveProfile(cfg, rule.profile) });
      } catch (err) {
        log(`rule "${rule.pattern}" のプロファイルが解決できないためスキップ: ${String(err)}`);
      }
    }
    relay.setRules(rules);
  }

  applyProxyConfig();

  // 中継プロキシ自体にも認証をかけ、他ローカルプロセスの相乗り(認証代行の悪用)を防ぐ。
  // KB_RELAY_NOAUTH=1 で無効化できる(トラブルシュート用)。
  const relayAuth = process.env.KB_RELAY_NOAUTH
    ? null
    : { username: 'kb', password: crypto.randomBytes(12).toString('hex') };
  if (relayAuth) relay.setAuth(relayAuth.username, relayAuth.password);
  relay.onError = (msg) => log(msg);

  const relayPort = await relay.start();

  log(
    `starting (headless=${headless}, profile=${profile}, channel=${channel ?? 'auto'}, ua=${userAgent ? 'custom' : 'default'}, ` +
      `stealth=${stealth}, ignoreHttpsErrors=${ignoreHttpsErrors}, extensions=${extensions ? (extensions.length || 'on') : 'no'}, attach=${cdpUrl ?? 'no'}, proxy=${relay.status().active}, relayPort=${relayPort}, relayAuth=${!!relayAuth})`,
  );
  // OS ストア非経由で信頼する CA(proxy add --ca / trust-ca --scoped で各プロファイルに保存した SPKI)を
  // 全プロファイルから収集し、Chromium の --ignore-certificate-errors-spki-list へ渡す(該当証明書のみ許可)。
  const caSpkiList = Object.values(loadProxyConfig().profiles)
    .map((p) => (p.type !== 'direct' ? p.caSpki : undefined))
    .filter((s): s is string => !!s);
  await host.start({
    headless,
    profile,
    channel,
    userAgent,
    cdpUrl,
    stealth,
    extensions,
    ignoreHttpsErrors,
    ignoreCertErrorsSpkiList: caSpkiList,
    // アタッチ先ブラウザのプロキシは変更できないため、通常起動時のみ中継を向ける
    proxy: cdpUrl ? undefined : { server: `http://127.0.0.1:${relayPort}`, ...(relayAuth ?? {}) },
  });
  // アタッチは明示起動のみの契約(自動 spawn が存在しない Chrome への接続で失敗しないよう last-run に残さない)
  if (!cdpUrl) writeLastRun({ headless, profile, channel, userAgent, stealth, idleTimeoutSec: idleLastRunSec, extensions, ignoreHttpsErrors });

  /** 操作ログセッションの meta(log.start でも使う)。 */
  const sessionMeta = () => ({
    profile: host.profile,
    headless: host.headless,
    channel: host.channel,
    ...(cdpUrl ? { attach: cdpUrl } : {}),
    kbVersion: KB_VERSION,
  });

  // 生ジャーナルには機微な値が平文で残るため、古いセッションは自動削除する(既定: 直近 20)
  const keep = Number(process.env.KB_LOG_KEEP ?? 20);
  const { pruned } = pruneLogSessions(Number.isFinite(keep) ? keep : 20);
  if (pruned.length) log(`journal pruned: ${pruned.length} old session(s) removed`);

  // 操作ログは既定で常時 ON(セッション = デーモンの一生。kb log start --name で明示分割できる)
  host.onJournalNet = (ev) => journal.append({ type: 'net', ...ev });
  host.onJournalConsole = (ev) => journal.append({ type: 'console', ...ev });
  const session = journal.start(undefined, sessionMeta());
  log(`journal started: ${session.name}`);

  // アイドル自動終了。RPC 受信(上の handler)とページのネット/コンソール活動(host.onActivity)を
  // 「活動」として記録し、idleMs 無活動なら既存の shutdown 経路で自ら graceful に落ちる。
  // タイマーは unref 済みなので他の shutdown 経路(SIGINT / ウィンドウ手動クローズ)を阻害しない。
  host.onActivity = () => reaper?.touch();
  reaper = new IdleReaper(idleMs, () => void shutdown('idle timeout'));
  reaper.isBusy = () => inflightRpcs > 0;
  reaper.start();
  log(idleMs > 0 ? `idle reaper enabled: timeout=${idleTimeoutSec}s` : 'idle reaper disabled');

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address == null || typeof address === 'string') {
      log('failed to get listen address');
      process.exit(1);
    }
    // buildId は警告用の補助情報にすぎない(読めなければ undefined のまま)
    writeDaemonInfo({ port: address.port, token, pid: process.pid, buildId: readDiskBuildId() ?? undefined });
    log(`listening on 127.0.0.1:${address.port} (pid=${process.pid}, channel=${host.channel})`);
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ソケットの散発的なエラー等でデーモン(=ブラウザセッション)を道連れにしない
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  removeDaemonInfoIfOwned(process.pid);
  process.exit(1);
});
