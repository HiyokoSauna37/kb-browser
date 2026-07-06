import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { SocksClient } from 'socks';
import { DIRECT, type ProxyProfile } from '../shared/proxyStore';

/**
 * ローカル中継プロキシ。
 * Chromium は常にこの中継 (127.0.0.1:port) を向き、上流だけを差し替えることで
 * ブラウザ無再起動のプロキシ切替を実現する。SOCKS5 認証の代行もここで行う。
 */
export class RelayProxy {
  private server = http.createServer();
  private upstreamName = 'direct';
  private upstream: ProxyProfile = DIRECT;
  private rules: { pattern: string; name: string; profile: ProxyProfile }[] = [];
  private stats = { tunnels: 0, requests: 0, errors: 0 };

  setUpstream(name: string, profile: ProxyProfile): void {
    this.upstreamName = name;
    this.upstream = profile;
  }

  /** FoxyProxy 風のパターン振り分けルール(解決済みプロファイル付き)。 */
  setRules(rules: { pattern: string; name: string; profile: ProxyProfile }[]): void {
    this.rules = rules;
  }

  status() {
    return {
      active: this.upstreamName,
      rules: this.rules.map((r) => ({ pattern: r.pattern, profile: r.name })),
      ...this.stats,
    };
  }

  async start(): Promise<number> {
    this.server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head);
    });
    this.server.on('request', (req, res) => {
      void this.handleRequest(req, res);
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
      this.stats.errors++;
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    }
  }

  // ---- 平文 HTTP (絶対 URI 形式) ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    upstreamReq.on('error', () => {
      this.stats.errors++;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamReq);
  }

  // ---- 上流への接続 ----

  /** profile 経由で host:port への生 TCP ソケットを確立する。 */
  async connectVia(profile: ProxyProfile, host: string, port: number): Promise<net.Socket> {
    switch (profile.type) {
      case 'direct': {
        const socket = net.connect(port, host);
        await once(socket, 'connect');
        return socket;
      }
      case 'http': {
        const socket = net.connect(profile.port, profile.host);
        await once(socket, 'connect');
        let header = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
        if (profile.username) header += `Proxy-Authorization: ${basicAuth(profile)}\r\n`;
        socket.write(header + '\r\n');
        await readConnectResponse(socket);
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

function basicAuth(p: { username?: string; password?: string }): string {
  return 'Basic ' + Buffer.from(`${p.username ?? ''}:${p.password ?? ''}`).toString('base64');
}

function splitHostPort(input: string, defaultPort: number): { host: string; port: number } {
  const idx = input.lastIndexOf(':');
  if (idx < 0) return { host: input, port: defaultPort };
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
function readConnectResponse(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > 16 * 1024) fail(new Error('CONNECT レスポンスが大きすぎます'));
        return;
      }
      socket.off('data', onData);
      socket.off('error', fail);
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length) socket.unshift(rest);
      if (/^HTTP\/1\.[01] 200/.test(header)) resolve();
      else reject(new Error(`上流プロキシが CONNECT を拒否しました: ${header.split('\r\n')[0]}`));
    };
    const fail = (err: Error) => {
      socket.off('data', onData);
      socket.destroy();
      reject(err);
    };
    socket.on('data', onData);
    socket.once('error', fail);
  });
}
