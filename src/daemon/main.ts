import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { BrowserHost } from './host';
import { RelayProxy } from './relay';
import { loadProxyConfig, resolveProfile } from '../shared/proxyStore';
import {
  DAEMON_LOG_PATH,
  ensureKbHome,
  removeDaemonInfo,
  writeDaemonInfo,
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

async function main(): Promise<void> {
  ensureKbHome();

  const headless = process.argv.includes('--headless');
  const profileArgIdx = process.argv.indexOf('--profile');
  const profile = profileArgIdx >= 0 ? process.argv[profileArgIdx + 1] : 'default';

  const host = new BrowserHost();
  const relay = new RelayProxy();
  const token = crypto.randomBytes(16).toString('hex');
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    removeDaemonInfo();
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

    if (req.headers['x-kb-token'] !== token) {
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

    try {
      const result = await dispatch(rpc);
      respond(200, { ok: true, result });
      if (rpc.cmd === 'daemon.stop') void shutdown('stop command');
    } catch (err) {
      respond(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
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
        return host.open(args.url, !!args.new, args.tab);
      case 'tabs.list':
        return host.listTabs();
      case 'tabs.close':
        return host.closeTab(args.tab);
      case 'tabs.activate':
        return host.activateTab(args.tab);
      case 'screenshot':
        return host.screenshot(args.path, !!args.full, args.tab);
      case 'text':
        return host.text(args.tab);
      case 'html':
        return host.html(args.tab);
      case 'eval':
        return host.eval(args.expression, args.tab);
      case 'click':
        return host.click(args.selector, args.tab);
      case 'fill':
        return host.fill(args.selector, args.value, args.tab);
      case 'press':
        return host.press(args.key, args.tab);
      case 'cookies.list':
        return host.cookies(args.domain);
      case 'cookies.set':
        return host.setCookie(args.cookie);
      case 'cookies.clear':
        return host.clearCookies();
      case 'net.log':
        return host.netLogQuery(args);
      case 'net.clear':
        return host.netClear();
      case 'net.block':
        return host.addBlock(args.pattern);
      case 'net.mock':
        return host.addMock(args.pattern, args.status, args.contentType, args.body);
      case 'net.rules':
        return host.listRoutes();
      case 'net.unroute':
        return host.removeRoute(args.id);
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
        log(`mode switched: headless=${result.headless} (restored ${result.restoredTabs} tabs)`);
        return result;
      }
      case 'wait':
        return host.waitFor({ url: args.url, selector: args.selector, timeoutMs: args.timeoutMs ?? 120_000 }, args.tab);
      case 'emulate':
        return host.emulate(args, args.tab);
      case 'emulate.geo':
        return host.setGeolocation(args.latitude, args.longitude);
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
  const relayPort = await relay.start();

  log(`starting (headless=${headless}, profile=${profile}, proxy=${relay.status().active}, relayPort=${relayPort})`);
  await host.start({ headless, profile, proxyServer: `http://127.0.0.1:${relayPort}` });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address == null || typeof address === 'string') {
      log('failed to get listen address');
      process.exit(1);
    }
    writeDaemonInfo({ port: address.port, token, pid: process.pid });
    log(`listening on 127.0.0.1:${address.port} (pid=${process.pid}, channel=${host.channel})`);
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  removeDaemonInfo();
  process.exit(1);
});
