import type { Page } from 'playwright';
import { LogBuffer } from '../shared/util';
import { LOG_CAP, type WsEntry } from './types';

/**
 * WebSocket の**観測**(kb ws log)。DevTools の Messages タブ相当で、
 * ページ自身が張ったソケット(socket.io 等)のフレームをそのまま覗ける。
 * `kb ws connect` で kb が張ったソケットもページコンテキストで動くのでここに載る。
 *
 * 送信は Playwright の WebSocket API では不可能(観測専用)なので、
 * 送受信は host/wsClient.ts(ページ内 WebSocket)側が担当する。
 */

/** 1 フレームあたりの保持サイズ上限(socket.io の framing 解析には十分な大きさ)。 */
const WS_FRAME_CAP = 8 * 1024;

export class WsMonitor {
  private log = new LogBuffer<WsEntry>(LOG_CAP);

  /** タブの WebSocket を購読する(タブ登録時に呼ぶ)。 */
  watchPage(page: Page, tabId: number): void {
    page.on('websocket', (ws) => {
      const url = ws.url();
      this.push({ tab: tabId, url, event: 'open' });
      ws.on('framesent', (d) => this.pushFrame(tabId, url, 'sent', d.payload));
      ws.on('framereceived', (d) => this.pushFrame(tabId, url, 'received', d.payload));
      ws.on('socketerror', (e) => this.push({ tab: tabId, url, event: 'error', error: String(e) }));
      ws.on('close', () => this.push({ tab: tabId, url, event: 'close' }));
    });
  }

  private push(entry: Omit<WsEntry, 'seq' | 'ts'>): void {
    this.log.push({ ts: new Date().toISOString(), ...entry });
  }

  private pushFrame(tab: number, url: string, event: 'sent' | 'received', payload: string | Buffer): void {
    if (typeof payload === 'string') {
      this.push({
        tab,
        url,
        event,
        payload: payload.length > WS_FRAME_CAP ? payload.slice(0, WS_FRAME_CAP) : payload,
        truncated: payload.length > WS_FRAME_CAP,
      });
      return;
    }
    const clipped = payload.length > WS_FRAME_CAP ? payload.subarray(0, WS_FRAME_CAP) : payload;
    this.push({ tab, url, event, payload: clipped.toString('base64'), binary: true, truncated: payload.length > WS_FRAME_CAP });
  }

  query(opts: { tab?: number; since?: number; filter?: string; limit?: number }): {
    entries: WsEntry[];
    seq: number;
    dropped: number;
  } {
    const re = opts.filter ? new RegExp(opts.filter, 'i') : null;
    return this.log.query({
      since: opts.since,
      limit: opts.limit,
      filter: (e) => (opts.tab == null || e.tab === opts.tab) && (re == null || re.test(e.url)),
    });
  }

  clear(): void {
    this.log.clear();
  }
}
