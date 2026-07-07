import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { BrowserHost } from './host';
import { Journal, pruneLogSessions } from './journal';
import { RelayProxy } from './relay';
import { loadProxyConfig, resolveProfile } from '../shared/proxyStore';
import { clipStr, summarizeArgs } from '../shared/oplog';
import {
  DAEMON_LOG_PATH,
  ensureKbHome,
  removeDaemonInfoIfOwned,
  writeDaemonInfo,
  writeLastRun,
} from '../shared/paths';

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

  const host = new BrowserHost();
  const relay = new RelayProxy();
  const journal = new Journal();
  const token = crypto.randomBytes(16).toString('hex');
  let shuttingDown = false;

  /** 操作ジャーナルに記録しない読み取り系・ログ操作系コマンド。 */
  const JOURNAL_EXCLUDE = new Set([
    'daemon.status', 'daemon.stop',
    'tabs.list', 'downloads.list', 'cookies.list', 'storage.dump',
    'net.log', 'net.body', 'net.headers', 'net.rules', 'net.har.status',
    'console.log', 'proxy.status', 'proxy.test',
    'log.start', 'log.stop', 'log.status',
  ]);

  /** 自動スクリーンショット(kb log start --shots)の対象になる操作コマンド。 */
  const AUTO_SHOT_CMDS = new Set([
    'open', 'click', 'fill', 'press', 'hover', 'check', 'select', 'upload', 'scroll',
    'back', 'forward', 'reload',
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
    }
  });

  /** click / fill 等の操作対象 (selector / ref / frame / tab) を組み立てる。 */
  const target = (args: Record<string, any>) => ({
    selector: args.selector,
    ref: args.ref,
    frame: args.frame,
    tab: args.tab,
  });

  async function dispatch({ cmd, args }: RpcRequest): Promise<unknown> {
    switch (cmd) {
      case 'daemon.status':
        return { ...host.status(), proxy: relay.status().active };
      case 'daemon.stop':
        return { stopping: true };
      case 'proxy.use':
      case 'proxy.reload':
        applyProxyConfig();
        log(`proxy config reloaded (active=${relay.status().active})`);
        return relay.status();
      case 'proxy.status':
        return relay.status();
      case 'proxy.test': {
        const cfg = loadProxyConfig();
        const name = args.name ?? relay.status().active;
        const result = await relay.testUpstream(resolveProfile(cfg, name));
        return { profile: name, ...result };
      }
      case 'open':
        return host.open(args.url, !!args.new, args.tab, args.waitUntil);
      case 'tabs.list':
        return host.listTabs();
      case 'tabs.close':
        return host.closeTab(args.tab);
      case 'tabs.activate':
        return host.activateTab(args.tab);
      case 'screenshot':
        return host.screenshot(
          args.path,
          { full: !!args.full, selector: args.selector, ref: args.ref, frame: args.frame, timeoutMs: args.timeoutMs },
          args.tab,
        );
      case 'text':
        return host.text(args.tab, { maxChars: args.maxChars, offset: args.offset });
      case 'html':
        return host.html(args.tab, { maxChars: args.maxChars, offset: args.offset });
      case 'snapshot':
        return host.snapshot(args.tab, { maxChars: args.maxChars, offset: args.offset });
      case 'eval':
        return host.eval(args.expression, args.tab, { maxChars: args.maxChars, offset: args.offset });
      case 'click':
        return host.click(target(args));
      case 'fill':
        return host.fill(target(args), args.value);
      case 'press':
        return host.press(args.key, args.tab);
      case 'hover':
        return host.hover(target(args));
      case 'check':
        return host.setChecked(target(args), args.checked !== false);
      case 'select':
        return host.select(target(args), args.values ?? [], !!args.byLabel);
      case 'upload':
        return host.upload(target(args), args.files ?? []);
      case 'scroll':
        return host.scroll({ by: args.by, to: args.to, top: args.top, bottom: args.bottom }, args.tab);
      case 'back':
        return host.goBack(args.tab);
      case 'forward':
        return host.goForward(args.tab);
      case 'reload':
        return host.reload(args.tab);
      case 'pdf':
        return host.pdf(args.path, args.tab);
      case 'downloads.list':
        return host.listDownloads();
      case 'downloads.clear':
        return host.clearDownloads();
      case 'cookies.list':
        return host.cookies(args.domain);
      case 'cookies.set':
        return host.setCookie(args.cookie);
      case 'cookies.rm':
        return host.removeCookie(args.name, args.domain);
      case 'cookies.clear':
        return host.clearCookies();
      case 'cookies.import':
        return host.importCookies(args.cookies ?? []);
      case 'storage.dump':
        return host.storageDump();
      case 'storage.restore':
        return host.storageRestore(args.state ?? {});
      case 'net.log':
        return host.netLogQuery(args);
      case 'net.body':
        return host.netBody(args.seq, { maxChars: args.maxChars, offset: args.offset });
      case 'net.headers':
        return host.netHeadersQuery(args.seq);
      case 'log.start':
        return journal.start(args.name, sessionMeta(), { shots: !!args.shots });
      case 'log.stop':
        return journal.stop();
      case 'log.status':
        return journal.status();
      case 'request':
        return host.httpRequest({
          url: args.url,
          method: args.method,
          headers: args.headers,
          data: args.data,
          timeoutMs: args.timeoutMs,
          follow: args.follow,
          savePath: args.savePath,
          maxChars: args.maxChars,
          offset: args.offset,
        });
      case 'net.clear':
        return host.netClear();
      case 'net.block':
        return host.addBlock(args.pattern);
      case 'net.mock':
        return host.addMock(args.pattern, args.status, args.contentType, args.body);
      case 'net.rules':
        return host.listRoutes();
      case 'net.unroute':
        return args.all ? host.removeAllRoutes() : host.removeRoute(args.id);
      case 'net.har.start':
        return host.harStart();
      case 'net.har.stop':
        return host.harStop();
      case 'net.har.status':
        return host.harStatus();
      case 'console.log':
        return host.consoleQuery(args);
      case 'console.clear':
        return host.consoleClear();
      case 'dom.query':
        return host.domQuery(args.selector, args, args.tab);
      case 'mode.set': {
        const result = await host.setMode(!!args.headless);
        writeLastRun({ headless: host.headless, profile: host.profile, channel, userAgent });
        log(`mode switched: headless=${result.headless} (restored ${result.restoredTabs} tabs)`);
        return result;
      }
      case 'profile.set': {
        const result = await host.setProfile(args.name);
        writeLastRun({ headless: host.headless, profile: host.profile, channel, userAgent });
        log(`profile switched: ${result.profile} (restored ${result.restoredTabs} tabs)`);
        return result;
      }
      case 'auth.set': {
        const result = await host.setAuth(args.credentials ?? null);
        log(`http credentials ${result.auth ? 'set' : 'cleared'}`);
        return result;
      }
      case 'wait':
        return host.waitFor(
          { url: args.url, selector: args.selector, idle: !!args.idle, any: !!args.any, timeoutMs: args.timeoutMs ?? 120_000 },
          args.tab,
        );
      case 'emulate':
        return host.emulate(args, args.tab);
      case 'emulate.geo':
        return host.setGeolocation(args.latitude, args.longitude);
      case 'emulate.net':
        return host.emulateNetwork(args.preset, args.tab);
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
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
      `attach=${cdpUrl ?? 'no'}, proxy=${relay.status().active}, relayPort=${relayPort}, relayAuth=${!!relayAuth})`,
  );
  await host.start({
    headless,
    profile,
    channel,
    userAgent,
    cdpUrl,
    // アタッチ先ブラウザのプロキシは変更できないため、通常起動時のみ中継を向ける
    proxy: cdpUrl ? undefined : { server: `http://127.0.0.1:${relayPort}`, ...(relayAuth ?? {}) },
  });
  // アタッチは明示起動のみの契約(自動 spawn が存在しない Chrome への接続で失敗しないよう last-run に残さない)
  if (!cdpUrl) writeLastRun({ headless, profile, channel, userAgent });

  /** 操作ログセッションの meta(log.start でも使う)。 */
  const sessionMeta = () => ({
    profile: host.profile,
    headless: host.headless,
    channel: host.channel,
    ...(cdpUrl ? { attach: cdpUrl } : {}),
    kbVersion: '0.6.1',
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

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address == null || typeof address === 'string') {
      log('failed to get listen address');
      process.exit(1);
    }
    let buildId: number | undefined;
    try {
      buildId = Math.floor(fs.statSync(__filename).mtimeMs);
    } catch {
      /* buildId は警告用の補助情報にすぎない */
    }
    writeDaemonInfo({ port: address.port, token, pid: process.pid, buildId });
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
