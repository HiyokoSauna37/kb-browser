import type { Page } from 'playwright';

/**
 * kb 自身が張る WebSocket(kb ws connect / send / recv / close)。
 *
 * **ページコンテキストで `new WebSocket()` する**のが要点。Playwright の WebSocket API は
 * 観測専用でフレームを送れず、Node 側から張り直すと Cookie・Origin・TLS 指紋・プロキシを
 * 手で組み直すことになる(そこがズレると調べたい相手のセッションと別物になる)。
 * ページで張れば、そのページが持っているセッションがそのまま乗る。
 *
 * 制約: ソケットはページのドキュメントに紐づくため、**ページ遷移で失われる**
 * (registry ごと消えるので、その旨のエラーを返す)。
 */

/** ソケットごとの受信バッファ件数。超えたら古いものから捨てて dropped に数える。 */
const RECV_BUFFER_CAP = 500;
/** 1 メッセージあたりの保持サイズ上限。 */
const FRAME_CAP = 64 * 1024;
/** window に生やすレジストリ名(exposeBinding と同じく検知面になるので 1 つに集約する)。 */
const REGISTRY = '__kbWs';

export interface WsSocketInfo {
  id: number;
  url: string;
  state: 'connecting' | 'open' | 'closing' | 'closed';
  /** 受信バッファに残っている件数。 */
  buffered: number;
  /** バッファあふれで捨てた件数。 */
  dropped: number;
  /** 受信済みの最新 seq(kb ws recv --since に渡せる)。 */
  lastSeq: number;
}

export interface WsMessage {
  seq: number;
  ts: string;
  data: string;
  binary: boolean;
  truncated: boolean;
  kind: 'message' | 'close' | 'error';
}

/** ページ内 WebSocket を開き、受信バッファを仕掛ける。 */
export async function wsConnect(
  page: Page,
  args: { id: number; url: string; protocols?: string[]; timeoutMs: number },
): Promise<WsSocketInfo> {
  return page.evaluate(
    async ({ id, url, protocols, timeoutMs, registry, cap, frameCap }) => {
      const w = window as unknown as Record<string, any>;
      const reg = (w[registry] = w[registry] || { sockets: new Map<number, any>() });
      const ws = new WebSocket(url, protocols && protocols.length ? protocols : undefined);
      const st = { id, url, ws, buf: [] as any[], seq: 0, dropped: 0 };
      reg.sockets.set(id, st);

      const push = (entry: any) => {
        st.buf.push(entry);
        if (st.buf.length > cap) {
          st.buf.shift();
          st.dropped++;
        }
      };
      const toBase64 = (buf: ArrayBuffer, entry: any) => {
        const bytes = new Uint8Array(buf);
        const n = Math.min(bytes.length, frameCap);
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
        entry.truncated = bytes.length > frameCap;
        return btoa(s);
      };
      ws.addEventListener('message', (ev: MessageEvent) => {
        // seq とエントリは同期的に確保してから中身を埋める(Blob 変換の await で順序が乱れないように)
        const entry: any = { seq: ++st.seq, ts: new Date().toISOString(), data: '', binary: false, truncated: false, kind: 'message' };
        push(entry);
        const data = ev.data;
        if (typeof data === 'string') {
          entry.data = data.length > frameCap ? data.slice(0, frameCap) : data;
          entry.truncated = data.length > frameCap;
        } else if (data instanceof Blob) {
          entry.binary = true;
          void data.arrayBuffer().then((b) => {
            entry.data = toBase64(b, entry);
          });
        } else {
          entry.binary = true;
          entry.data = toBase64(data as ArrayBuffer, entry);
        }
      });
      ws.addEventListener('close', (ev: CloseEvent) => {
        push({ seq: ++st.seq, ts: new Date().toISOString(), data: `code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`, binary: false, truncated: false, kind: 'close' });
      });
      ws.addEventListener('error', () => {
        push({ seq: ++st.seq, ts: new Date().toISOString(), data: 'websocket error', binary: false, truncated: false, kind: 'error' });
      });

      try {
        await new Promise<void>((resolve, reject) => {
          if (ws.readyState === WebSocket.OPEN) return resolve();
          const timer = setTimeout(() => reject(new Error(`接続がタイムアウトしました (${timeoutMs}ms)`)), timeoutMs);
          ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('接続に失敗しました(URL / Origin / 認証 Cookie を確認してください)'));
          }, { once: true });
        });
      } catch (e) {
        reg.sockets.delete(id);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        throw e;
      }
      const states = ['connecting', 'open', 'closing', 'closed'] as const;
      return { id, url, state: states[ws.readyState], buffered: st.buf.length, dropped: st.dropped, lastSeq: st.seq };
    },
    { id: args.id, url: args.url, protocols: args.protocols, timeoutMs: args.timeoutMs, registry: REGISTRY, cap: RECV_BUFFER_CAP, frameCap: FRAME_CAP },
  );
}

/** ページ内で socket が見つからないときの共通メッセージ(ページ遷移で失われる)。 */
const NOT_FOUND = (id: number) =>
  `ソケット ${id} はこのタブにありません(ページ遷移でページ内のソケットは失われます)。kb ws list で確認し、必要なら kb ws connect し直してください。`;

export async function wsSend(page: Page, args: { id: number; data: string; base64?: boolean }): Promise<{ id: number; bytes: number; state: string }> {
  const r = await page.evaluate(
    ({ id, data, base64, registry }) => {
      const reg = (window as unknown as Record<string, any>)[registry];
      const st = reg?.sockets?.get(id);
      if (!st) return { missing: true } as const;
      if (st.ws.readyState !== WebSocket.OPEN) return { closed: true, state: st.ws.readyState } as const;
      let bytes: number;
      if (base64) {
        const bin = atob(data);
        const bytesArr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytesArr[i] = bin.charCodeAt(i);
        st.ws.send(bytesArr);
        bytes = bytesArr.length;
      } else {
        st.ws.send(data);
        bytes = new TextEncoder().encode(data).length;
      }
      return { bytes, state: 'open' } as const;
    },
    { id: args.id, data: args.data, base64: !!args.base64, registry: REGISTRY },
  );
  if ('missing' in r) throw new Error(NOT_FOUND(args.id));
  if ('closed' in r) throw new Error(`ソケット ${args.id} は open ではありません(readyState=${r.state})。kb ws connect し直してください。`);
  return { id: args.id, bytes: r.bytes, state: r.state };
}

/** 受信バッファを読む(since より後だけ)。バッファは消費しない(--since カーソルで進める)。 */
export async function wsRecv(
  page: Page,
  args: { id: number; since?: number; limit?: number },
): Promise<{ id: number; url: string; state: string; entries: WsMessage[]; seq: number; dropped: number }> {
  const r = await page.evaluate(
    ({ id, since, limit, registry }) => {
      const reg = (window as unknown as Record<string, any>)[registry];
      const st = reg?.sockets?.get(id);
      if (!st) return { missing: true } as const;
      let entries = st.buf.filter((e: any) => e.seq > (since ?? 0));
      if (limit && entries.length > limit) entries = entries.slice(-limit);
      const states = ['connecting', 'open', 'closing', 'closed'];
      return { url: st.url, state: states[st.ws.readyState], entries, seq: st.seq, dropped: st.dropped } as const;
    },
    { id: args.id, since: args.since, limit: args.limit, registry: REGISTRY },
  );
  if ('missing' in r) throw new Error(NOT_FOUND(args.id));
  return { id: args.id, url: r.url, state: r.state, entries: r.entries as WsMessage[], seq: r.seq, dropped: r.dropped };
}

export async function wsList(page: Page): Promise<WsSocketInfo[]> {
  return page.evaluate((registry) => {
    const reg = (window as unknown as Record<string, any>)[registry];
    if (!reg?.sockets) return [];
    const states = ['connecting', 'open', 'closing', 'closed'] as const;
    return [...reg.sockets.values()].map((st: any) => ({
      id: st.id,
      url: st.url,
      state: states[st.ws.readyState],
      buffered: st.buf.length,
      dropped: st.dropped,
      lastSeq: st.seq,
    }));
  }, REGISTRY);
}

export async function wsClose(page: Page, args: { id: number; code?: number; reason?: string }): Promise<{ id: number; closed: boolean }> {
  const r = await page.evaluate(
    ({ id, code, reason, registry }) => {
      const reg = (window as unknown as Record<string, any>)[registry];
      const st = reg?.sockets?.get(id);
      if (!st) return { missing: true } as const;
      try {
        st.ws.close(code ?? 1000, reason ?? '');
      } catch {
        /* already closed */
      }
      reg.sockets.delete(id);
      return { closed: true } as const;
    },
    { id: args.id, code: args.code, reason: args.reason, registry: REGISTRY },
  );
  if ('missing' in r) throw new Error(NOT_FOUND(args.id));
  return { id: args.id, closed: true };
}
