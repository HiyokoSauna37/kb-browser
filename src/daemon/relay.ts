import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { SocksClient } from 'socks';
import { DIRECT, type ProxyProfile } from '../shared/proxyStore';

/** 上流(プロキシ/接続先)への接続タイムアウト。死んだプロキシでブラウザが固まるのを防ぐ。 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * ローカル中継プロキシ。
 * Chromium は常にこの中継 (127.0.0.1:port) を向き、上流だけを差し替えることで
 * ブラウザ無再起動のプロキシ切替を実現する。SOCKS5 認証の代行もここで行う。
 * setAuth() を呼ぶと Proxy-Authorization (Basic) を要求し、他ローカルプロセスの相乗りを防ぐ。
 */
export class RelayProxy {
  private server = http.createServer();
  private upstreamName = 'direct';
  private upstream: ProxyProfile = DIRECT;
  private rules: { pattern: string; name: string; profile: ProxyProfile }[] = [];
  private stats = { tunnels: 0, requests: 0, errors: 0, authRejects: 0 };
  /** 直近の接続エラー(proxy status で原因を確認できるようにする)。 */
  private lastErrors: { ts: string; target: string; profile: string; error: string }[] = [];
  /** 期待する Proxy-Authorization ヘッダ値。null なら認証なし。 */
  private expectedAuth: string | null = null;

  /** 接続エラー発生時に呼ばれる(デーモンログへの出力用)。 */
  onError: (message: string) => void = () => {};

  /** 接続エラーを記録する(stats / 直近リスト / ログの 3 か所へ)。 */
  private recordError(target: string, profileName: string, err: unknown): void {
    this.stats.errors++;
    const error = String(err instanceof Error ? err.message : err).split('\n')[0];
    this.lastErrors.push({ ts: new Date().toISOString(), target, profile: profileName, error });
    if (this.lastErrors.length > 20) this.lastErrors.shift();
    this.onError(`relay: ${target} への接続に失敗 (via ${profileName}): ${error}`);
  }

  /** ホストに適用されるプロファイル名(エラー記録用)。 */
  private profileNameFor(host: string): string {
    for (const rule of this.rules) if (matchHost(rule.pattern, host)) return rule.name;
    return this.upstreamName;
  }

  setUpstream(name: string, profile: ProxyProfile): void {
    this.upstreamName = name;
    this.upstream = profile;
  }

  /** FoxyProxy 風のパターン振り分けルール(解決済みプロファイル付き)。 */
  setRules(rules: { pattern: string; name: string; profile: ProxyProfile }[]): void {
    this.rules = rules;
  }

  /** 中継プロキシ自体の認証を有効化する(ブラウザ以外のローカルプロセスからの相乗り防止)。 */
  setAuth(username: string, password: string): void {
    this.expectedAuth = basicAuth({ username, password });
  }

  status() {
    return {
      active: this.upstreamName,
      auth: this.expectedAuth != null,
      rules: this.rules.map((r) => ({ pattern: r.pattern, profile: r.name })),
      ...this.stats,
      lastErrors: this.lastErrors,
    };
  }

  async start(): Promise<number> {
    this.server.on('connect', (req, clientSocket, head) => {
      // ブラウザ側の切断(407 後のリセット等)で unhandled 'error' にならないよう先に握っておく
      (clientSocket as net.Socket).on('error', () => {});
      void this.handleConnect(req, clientSocket as net.Socket, head);
    });
    this.server.on('request', (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});
      void this.handleRequest(req, res);
    });
    this.server.on('clientError', (_err, socket) => {
      socket.destroy();
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address == null || typeof address === 'string') return reject(new Error('no relay address'));
        resolve(address.port);
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authOk(req: http.IncomingMessage): boolean {
    if (!this.expectedAuth) return true;
    return req.headers['proxy-authorization'] === this.expectedAuth;
  }

  /**
   * ホストに適用するプロファイルを決める。
   * 1. 振り分けルール(先勝ち) 2. アクティブプロファイル 3. 選ばれたプロファイルの bypass 判定。
   */
  private effectiveProfile(host: string): ProxyProfile {
    let profile = this.upstream;
    for (const rule of this.rules) {
      if (matchHost(rule.pattern, host)) {
        profile = rule.profile;
        break;
      }
    }
    if (profile.type !== 'direct' && profile.bypass?.some((pat) => matchHost(pat, host))) return DIRECT;
    return profile;
  }

  // ---- HTTPS (CONNECT トンネル) ----

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    if (!this.authOk(req)) {
      this.stats.authRejects++;
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="kb-relay"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    this.stats.tunnels++;
    const { host, port } = splitHostPort(req.url ?? '', 443);
    try {
      const remote = await this.connectVia(this.effectiveProfile(host), host, port);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(clientSocket);
      clientSocket.pipe(remote);
      remote.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => remote.destroy());
    } catch (err) {
      // ブラウザ側には ERR_TUNNEL_CONNECTION_FAILED として見える。原因は kb proxy status / daemon.log で確認できる
      this.recordError(`${host}:${port}`, this.profileNameFor(host), err);
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    }
  }

  // ---- 平文 HTTP (絶対 URI 形式) ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authOk(req)) {
      this.stats.authRejects++;
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="kb-relay"' });
      return void res.end();
    }
    this.stats.requests++;
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      return void res.end('kb relay: absolute-form request required');
    }

    const profile = this.effectiveProfile(url.hostname);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    // 中継自体の認証情報を上流へ漏らさない
    delete headers['proxy-authorization'];

    let options: http.RequestOptions;
    if (profile.type === 'http') {
      // 上流が HTTP プロキシなら絶対 URI のまま転送し、認証ヘッダを付与する
      if (profile.username) headers['proxy-authorization'] = basicAuth(profile);
      options = { host: profile.host, port: profile.port, method: req.method, path: req.url, headers };
    } else {
      const port = url.port ? Number(url.port) : 80;
      options = {
        method: req.method,
        headers,
        host: url.hostname,
        port,
        path: url.pathname + url.search,
        createConnection: (_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
          this.connectVia(profile, url.hostname, port).then(
            (socket) => cb(null, socket),
            (err) => cb(err instanceof Error ? err : new Error(String(err))),
          );
          return undefined as unknown as net.Socket;
        },
      } as http.RequestOptions;
    }

    const upstreamReq = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.setTimeout(CONNECT_TIMEOUT_MS, () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (err) => {
      this.recordError(url.hostname, this.profileNameFor(url.hostname), err);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamReq);
  }

  // ---- 上流への接続 ----

  /** profile 経由で host:port への生 TCP ソケットを確立する。 */
  async connectVia(profile: ProxyProfile, host: string, port: number): Promise<net.Socket> {
    switch (profile.type) {
      case 'direct':
        return connectTcp(port, host, CONNECT_TIMEOUT_MS);
      case 'http': {
        const socket = await connectTcp(profile.port, profile.host, CONNECT_TIMEOUT_MS);
        let header = `CONNECT ${hostHeader(host)}:${port} HTTP/1.1\r\nHost: ${hostHeader(host)}:${port}\r\n`;
        if (profile.username) header += `Proxy-Authorization: ${basicAuth(profile)}\r\n`;
        socket.write(header + '\r\n');
        await readConnectResponse(socket, CONNECT_TIMEOUT_MS);
        return socket;
      }
      case 'socks5': {
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: profile.host,
            port: profile.port,
            type: 5,
            userId: profile.username,
            password: profile.password,
          },
          command: 'connect',
          destination: { host, port },
          timeout: CONNECT_TIMEOUT_MS,
        });
        return socket;
      }
    }
  }

  /** 外部 IP 確認サイトに profile 経由でアクセスして疎通確認する。 */
  async testUpstream(profile: ProxyProfile): Promise<{ ip: string; latencyMs: number }> {
    const HOST = 'api.ipify.org';
    const started = Date.now();
    const raw = await this.connectVia(profile, HOST, 443);
    const socket = tls.connect({ socket: raw, servername: HOST });
    await once(socket, 'secureConnect');
    socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    await once(socket, 'end');
    socket.destroy();
    const body = Buffer.concat(chunks).toString('utf8');
    const ip = /(\d{1,3}\.){3}\d{1,3}/.exec(body)?.[0] ?? body.split('\r\n\r\n')[1]?.trim() ?? '';
    if (!ip) throw new Error('疎通確認に失敗しました(レスポンスを解析できません)');
    return { ip, latencyMs: Date.now() - started };
  }
}

// ---- helpers ----

/** タイムアウト付き TCP 接続。IPv6/IPv4 両対応ホストで片側が死んでいても繋がるよう happy eyeballs を有効化。 */
function connectTcp(port: number, host: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host, autoSelectFamily: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`接続がタイムアウトしました: ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** IPv6 リテラルは CONNECT 行や Host ヘッダで [] 付きにする。 */
function hostHeader(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function basicAuth(p: { username?: string; password?: string }): string {
  return 'Basic ' + Buffer.from(`${p.username ?? ''}:${p.password ?? ''}`).toString('base64');
}

/** "host:port" を分解する。"[::1]:443" 形式の IPv6 リテラルにも対応。 */
export function splitHostPort(input: string, defaultPort: number): { host: string; port: number } {
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end > 0) {
      const host = input.slice(1, end);
      const rest = input.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) || defaultPort : defaultPort;
      return { host, port };
    }
  }
  const idx = input.lastIndexOf(':');
  // ':' がない、または複数ある(裸の IPv6)場合は全体をホストとして扱う
  if (idx < 0 || input.indexOf(':') !== idx) return { host: input, port: defaultPort };
  return { host: input.slice(0, idx), port: Number(input.slice(idx + 1)) || defaultPort };
}

/**
 * ワイルドカードパターンとホスト名を照合する。
 * "*.example.com" はサブドメインと apex ("example.com") の両方に一致する。
 */
export function matchHost(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.') && host === pattern.slice(2)) return true;
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$', 'i');
  return regex.test(host);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CONNECT のレスポンスヘッダを読み、200 を確認する。ヘッダ後の余剰データは socket に戻す。 */
export function readConnectResponse(socket: net.Socket, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('CONNECT レスポンスがタイムアウトしました')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', fail);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > 16 * 1024) fail(new Error('CONNECT レスポンスが大きすぎます'));
        return;
      }
      cleanup();
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length) socket.unshift(rest);
      if (/^HTTP\/1\.[01] 200/.test(header)) resolve();
      else reject(new Error(`上流プロキシが CONNECT を拒否しました: ${header.split('\r\n')[0]}`));
    };
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    socket.on('data', onData);
    socket.once('error', fail);
  });
}
