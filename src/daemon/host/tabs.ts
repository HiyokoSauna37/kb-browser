import type { Page } from 'playwright';

/**
 * タブの ID 管理(Map + 採番 + アクティブタブ)を担う状態コンテナ。
 * ページイベントの配線は facade(BrowserHost.registerTab)が持ち、ここは純粋な状態操作だけを行う。
 */
export class TabRegistry {
  private tabs = new Map<number, Page>();
  private nextId = 1;
  private activeId: number | null = null;

  /** 既に登録済みのページなら その id、未登録なら undefined。 */
  find(page: Page): number | undefined {
    for (const [id, p] of this.tabs) if (p === page) return id;
    return undefined;
  }

  /** 新しいタブを採番して登録する。アクティブ未設定なら これをアクティブにする。 */
  add(page: Page): number {
    const id = this.nextId++;
    this.tabs.set(id, page);
    // ポップアップ等がアクティブタブを奪わないよう、未設定のときだけアクティブにする
    // (明示的な open / activate は呼び出し側で active を設定する)
    if (this.activeId == null) this.activeId = id;
    return id;
  }

  /** タブを登録解除する。アクティブだったら残りの末尾を新しいアクティブにする(close ハンドラから)。 */
  remove(id: number): void {
    this.tabs.delete(id);
    if (this.activeId === id) {
      const remaining = [...this.tabs.keys()];
      this.activeId = remaining.length ? remaining[remaining.length - 1] : null;
    }
  }

  get(id: number): Page | undefined {
    return this.tabs.get(id);
  }

  has(id: number): boolean {
    return this.tabs.has(id);
  }

  get size(): number {
    return this.tabs.size;
  }

  /** アクティブタブ ID(なければ null)。 */
  get active(): number | null {
    return this.activeId;
  }

  set active(id: number | null) {
    this.activeId = id;
  }

  entries(): [number, Page][] {
    return [...this.tabs];
  }

  pages(): Page[] {
    return [...this.tabs.values()];
  }

  /** 全タブを破棄しアクティブを解除する(再起動時)。 */
  clear(): void {
    this.tabs.clear();
    this.activeId = null;
  }
}
