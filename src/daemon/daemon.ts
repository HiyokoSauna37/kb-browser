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
import {
  AUTO_SHOT_CMDS,
  JOURNAL_EXCLUDE,
  isRpcCommand,
  rpcSchemas,
  type RpcArgs,
  type RpcCommand,
} from '../shared/rpc';
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

/** デーモンのログファイルへ 1 行追記する(失敗してもデーモンは落とさない)。 */
export function log(message: string): void {
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

/** click / fill 等の操作対象 (selector / ref / frame / tab) を組み立てる。 */
function target(a: { selector?: string; ref?: string; frame?: string; tab?: number }) {
  return { selector: a.selector, ref: a.ref, frame: a.frame, tab: a.tab };
}

/** デーモンの起動構成(argv + env から解決した不変値)。 */
export interface DaemonConfig {
  headless: boolean;
  profile: string;
  channel?: 'chrome' | 'msedge' | 'chromium';
  userAgent?: string;
  cdpUrl?: string;
  stealth: boolean;
  ignoreHttpsErrors: boolean;
  extensions?: string[];
  /** アイドル自動終了の閾値(ms)。0 で無効。 */
  idleMs: number;
  /** status 表示用の閾値(秒。0 = 無効)。 */
  idleTimeoutSec: number;
  /**
   * last-run に記録する閾値(秒)。明示 `--idle-timeout` のときだけ値を持つ。
   * env/既定から解決した値を焼き込むと、以後の spawn で last-run が最優先になり
   * KB_IDLE_TIMEOUT が二度と効かなくなるため undefined にする。
   */
  idleLastRunSec?: number;
}

/** argv と env からデーモン構成を解決する(純関数。テスト可能)。 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): DaemonConfig {
  const argValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  // 拡張機能: 'on' = プロファイル拡張の有効化のみ、csv = 未パック拡張ディレクトリ(絶対パス)
  const extensionsArg = argValue('--extensions');
  // アイドル自動終了の閾値(ms)。0 なら無効。--idle-timeout(秒)> KB_IDLE_TIMEOUT(秒)> 既定 30 分。
  const idleArgSec = argValue('--idle-timeout');
  const idleMs = resolveIdleTimeoutMs(idleArgSec, env['KB_IDLE_TIMEOUT']);
  const idleTimeoutSec = Math.round(idleMs / 1000);
  return {
    headless: argv.includes('--headless'),
    profile: argValue('--profile') ?? 'default',
    channel: argValue('--channel') as 'chrome' | 'msedge' | 'chromium' | undefined,
    userAgent: argValue('--ua'),
    cdpUrl: argValue('--cdp'),
    stealth: argv.includes('--stealth'),
    ignoreHttpsErrors: argv.includes('--ignore-https-errors'),
    extensions: extensionsArg == null ? undefined : splitExtensionsArg(extensionsArg),
    idleMs,
    idleTimeoutSec,
    idleLastRunSec: idleArgSec != null && idleArgSec !== '' ? idleTimeoutSec : undefined,
  };
}

/**
 * ブラウザを常駐保持し、localhost RPC を受け付けるデーモン本体。
 * 起動構成は DaemonConfig(parseArgs で argv/env から解決)で受け取り、
 * RPC は shared/rpc.ts のスキーマで検証してから型付き handler map へ振り分ける。
 */
export class Daemon {
  private readonly host = new BrowserHost();
  private readonly relay = new RelayProxy();
  private readonly journal = new Journal();
  private readonly token = crypto.randomBytes(16).toString('hex');
  private readonly server: http.Server;
  private readonly handlers: { [C in RpcCommand]: (args: RpcArgs<C>) => unknown | Promise<unknown> };
  private reaper: IdleReaper | null = null;
  private shuttingDown = false;
  /** 実行中の RPC 数。0 でない間は idle reaper の発火を保留する(wait 等の長時間 RPC 保護)。 */
  private inflightRpcs = 0;

  constructor(private readonly config: DaemonConfig) {
    this.handlers = this.buildHandlers();
    this.server = http.createServer((req, res) => void this.handleRequest(req, res));
    this.host.onClosed = () => void this.shutdown('browser window closed');
  }

  /** 起動シーケンス(プロキシ反映 → 中継起動 → ブラウザ起動 → ジャーナル → reaper → listen)。 */
  async start(): Promise<void> {
    ensureKbHome();
    const { config } = this;
    this.applyProxyConfig();

    // 中継プロキシ自体にも認証をかけ、他ローカルプロセスの相乗り(認証代行の悪用)を防ぐ。
    // KB_RELAY_NOAUTH=1 で無効化できる(トラブルシュート用)。
    const relayAuth = process.env.KB_RELAY_NOAUTH
      ? null
      : { username: 'kb', password: crypto.randomBytes(12).toString('hex') };
    if (relayAuth) this.relay.setAuth(relayAuth.username, relayAuth.password);
    this.relay.onError = (msg) => log(msg);

    const relayPort = await this.relay.start();

    log(
      `starting (headless=${config.headless}, profile=${config.profile}, channel=${config.channel ?? 'auto'}, ua=${config.userAgent ? 'custom' : 'default'}, ` +
        `stealth=${config.stealth}, ignoreHttpsErrors=${config.ignoreHttpsErrors}, extensions=${config.extensions ? (config.extensions.length || 'on') : 'no'}, attach=${config.cdpUrl ?? 'no'}, proxy=${this.relay.status().active}, relayPort=${relayPort}, relayAuth=${!!relayAuth})`,
    );
    // OS ストア非経由で信頼する CA(proxy add --ca / trust-ca --scoped で各プロファイルに保存した SPKI)を
    // 全プロファイルから収集し、Chromium の --ignore-certificate-errors-spki-list へ渡す(該当証明書のみ許可)。
    const caSpkiList = Object.values(loadProxyConfig().profiles)
      .map((p) => (p.type !== 'direct' ? p.caSpki : undefined))
      .filter((s): s is string => !!s);
    await this.host.start({
      headless: config.headless,
      profile: config.profile,
      channel: config.channel,
      userAgent: config.userAgent,
      cdpUrl: config.cdpUrl,
      stealth: config.stealth,
      extensions: config.extensions,
      ignoreHttpsErrors: config.ignoreHttpsErrors,
      ignoreCertErrorsSpkiList: caSpkiList,
      // アタッチ先ブラウザのプロキシは変更できないため、通常起動時のみ中継を向ける
      proxy: config.cdpUrl ? undefined : { server: `http://127.0.0.1:${relayPort}`, ...(relayAuth ?? {}) },
    });
    // アタッチは明示起動のみの契約(自動 spawn が存在しない Chrome への接続で失敗しないよう last-run に残さない)
    if (!config.cdpUrl) this.writeLastRun();

    // 生ジャーナルには機微な値が平文で残るため、古いセッションは自動削除する(既定: 直近 20)
    const keep = Number(process.env.KB_LOG_KEEP ?? 20);
    const { pruned } = pruneLogSessions(Number.isFinite(keep) ? keep : 20);
    if (pruned.length) log(`journal pruned: ${pruned.length} old session(s) removed`);

    // 操作ログは既定で常時 ON(セッション = デーモンの一生。kb log start --name で明示分割できる)
    this.host.onJournalNet = (ev) => this.journal.append({ type: 'net', ...ev });
    this.host.onJournalConsole = (ev) => this.journal.append({ type: 'console', ...ev });
    const session = this.journal.start(undefined, this.sessionMeta());
    log(`journal started: ${session.name}`);

    // アイドル自動終了。RPC 受信とページのネット/コンソール活動(host.onActivity)を「活動」として
    // 記録し、idleMs 無活動なら既存の shutdown 経路で自ら graceful に落ちる。タイマーは unref 済み
    // なので他の shutdown 経路(SIGINT / ウィンドウ手動クローズ)を阻害しない。
    this.host.onActivity = () => this.reaper?.touch();
    this.reaper = new IdleReaper(config.idleMs, () => void this.shutdown('idle timeout'));
    this.reaper.isBusy = () => this.inflightRpcs > 0;
    this.reaper.start();
    log(config.idleMs > 0 ? `idle reaper enabled: timeout=${config.idleTimeoutSec}s` : 'idle reaper disabled');

    this.server.listen(0, '127.0.0.1', () => {
      const address = this.server.address();
      if (address == null || typeof address === 'string') {
        log('failed to get listen address');
        process.exit(1);
      }
      // buildId は警告用の補助情報にすぎない(読めなければ undefined のまま)
      writeDaemonInfo({ port: address.port, token: this.token, pid: process.pid, buildId: readDiskBuildId() ?? undefined });
      log(`listening on 127.0.0.1:${address.port} (pid=${process.pid}, channel=${this.host.channel})`);
    });

    process.on('SIGINT', () => void this.shutdown('SIGINT'));
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    // ソケットの散発的なエラー等でデーモン(=ブラウザセッション)を道連れにしない
    process.on('uncaughtException', (err) => {
      log(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
    process.on('unhandledRejection', (reason) => {
      log(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    });
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log(`shutdown: ${reason}`);
    this.reaper?.stop();
    this.journal.stop();
    removeDaemonInfoIfOwned(process.pid);
    await this.host.stop();
    await this.relay.stop();
    this.server.close();
    // close() はアクティブな keep-alive 接続を待つことがあるため確実に終了する
    setTimeout(() => process.exit(0), 200).unref();
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!tokenMatches(req.headers['x-kb-token'], this.token)) {
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
    this.reaper?.touch();
    this.inflightRpcs++;

    const startedMs = Date.now();
    try {
      const result = await this.dispatch(rpc);
      const shot = await this.autoShot(rpc);
      this.journalCommand(rpc, true, Date.now() - startedMs, result, undefined, shot);
      respond(200, { ok: true, result });
      if (rpc.cmd === 'daemon.stop') void this.shutdown('stop command');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.journalCommand(rpc, false, Date.now() - startedMs, undefined, message);
      respond(200, { ok: false, error: message });
    } finally {
      this.inflightRpcs--;
      this.reaper?.touch();
    }
  }

  /**
   * RPC を検証してハンドラへ振り分ける。受信境界でスキーマ検証(非 strict なので未知キーは
   * 落とす)し、検証済みの引数をハンドラに渡す。コマンド名とその引数は実行時インデックスなので
   * 型システムでは相関できず、境界の 1 箇所だけ unknown に消去する(検証済みのため安全)。
   */
  private async dispatch({ cmd, args }: RpcRequest): Promise<unknown> {
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
    return (this.handlers[cmd] as (a: unknown) => unknown)(parsed);
  }

  /**
   * コマンド名 → ハンドラの対応表。mapped type により「全コマンドにハンドラがある」ことが
   * コンパイル時に強制される(漏れ・余剰はエラー)。各ハンドラの引数は shared/rpc.ts の
   * スキーマから導いた `RpcArgs<C>` で型付けされる。
   */
  private buildHandlers(): { [C in RpcCommand]: (args: RpcArgs<C>) => unknown | Promise<unknown> } {
    const { host, relay, journal, config } = this;
    return {
      'daemon.status': () => ({ ...host.status(), proxy: relay.status().active, idleTimeoutSec: config.idleTimeoutSec }),
      'daemon.stop': () => ({ stopping: true }),
      'proxy.use': () => {
        this.applyProxyConfig();
        log(`proxy config reloaded (active=${relay.status().active})`);
        return relay.status();
      },
      'proxy.reload': () => {
        this.applyProxyConfig();
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
      'log.start': (a) => journal.start(a.name, this.sessionMeta(), { shots: !!a.shots }),
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
        this.writeLastRun();
        log(`mode switched: headless=${result.headless} (restored ${result.restoredTabs} tabs)`);
        return result;
      },
      'profile.set': async (a) => {
        const result = await host.setProfile(a.name);
        this.writeLastRun();
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
  }

  /** RPC 1 回分をジャーナルへ記録する。 */
  private journalCommand(rpc: RpcRequest, ok: boolean, durationMs: number, result?: unknown, error?: string, shot?: string): void {
    if (JOURNAL_EXCLUDE.has(rpc.cmd as RpcCommand)) return;
    const summary = result === undefined ? undefined : clipStr(JSON.stringify(result) ?? '', 500);
    this.journal.append({
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
  private async autoShot(rpc: RpcRequest): Promise<string | undefined> {
    if (!this.journal.autoShots || !AUTO_SHOT_CMDS.has(rpc.cmd as RpcCommand)) return undefined;
    const dest = this.journal.nextShotPath();
    if (!dest) return undefined;
    try {
      await this.host.screenshot(dest.abs, {}, rpc.args?.tab);
      return dest.rel;
    } catch {
      return undefined;
    }
  }

  /** proxies.json を読み直し、active と振り分けルールを relay に反映する。 */
  private applyProxyConfig(): void {
    const cfg = loadProxyConfig();
    try {
      this.relay.setUpstream(cfg.active, resolveProfile(cfg, cfg.active));
    } catch (err) {
      log(`proxy profile "${cfg.active}" が解決できないため direct を使います: ${String(err)}`);
      this.relay.setUpstream('direct', resolveProfile(cfg, 'direct'));
    }
    const rules: { pattern: string; name: string; profile: ReturnType<typeof resolveProfile> }[] = [];
    for (const rule of cfg.rules) {
      try {
        rules.push({ pattern: rule.pattern, name: rule.profile, profile: resolveProfile(cfg, rule.profile) });
      } catch (err) {
        log(`rule "${rule.pattern}" のプロファイルが解決できないためスキップ: ${String(err)}`);
      }
    }
    this.relay.setRules(rules);
  }

  /** mode/profile 切替後の last-run 書き出し(明示構成 = config を維持、実際の headless/profile は host から)。 */
  private writeLastRun(): void {
    const { config } = this;
    writeLastRun({
      headless: this.host.headless,
      profile: this.host.profile,
      channel: config.channel,
      userAgent: config.userAgent,
      stealth: config.stealth,
      idleTimeoutSec: config.idleLastRunSec,
      extensions: config.extensions,
      ignoreHttpsErrors: config.ignoreHttpsErrors,
    });
  }

  /** 操作ログセッションの meta(log.start でも使う)。 */
  private sessionMeta() {
    return {
      profile: this.host.profile,
      headless: this.host.headless,
      channel: this.host.channel,
      ...(this.config.cdpUrl ? { attach: this.config.cdpUrl } : {}),
      kbVersion: KB_VERSION,
    };
  }
}
