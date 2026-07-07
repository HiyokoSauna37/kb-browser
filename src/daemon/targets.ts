import type { Locator, Page } from 'playwright';
import { escapeRegExp } from '../shared/util';
import type { Target } from './types';

/**
 * 操作対象 (selector / ref / frame) の解決と、失効した ref の自動再解決。
 * kb snapshot が返した直近スナップショットをタブ毎にキャッシュしておき、
 * ref が失効しても同じ role/name の要素が一意に見つかれば新 ref に読み替える。
 */
export class TargetResolver {
  /** タブ毎の直近 snapshot(全文)。失効 ref の自動再解決(role/name 照合)に使う。 */
  private lastSnapshots = new Map<number, string>();

  /** kb snapshot 取得時に呼び、再解決用のキャッシュを更新する。 */
  cacheSnapshot(tabId: number, snapshot: string): void {
    this.lastSnapshots.set(tabId, snapshot);
  }

  dropTab(tabId: number): void {
    this.lastSnapshots.delete(tabId);
  }

  clear(): void {
    this.lastSnapshots.clear();
  }

  /** Target(selector / ref / frame)から Locator を解決する。 */
  loc(page: Page, t: Target): Locator {
    if (t.ref) return page.locator(`aria-ref=${t.ref}`);
    if (!t.selector) throw new Error('selector か --ref のどちらかを指定してください。ref は kb snapshot で取得できます。');
    if (t.frame) return page.frameLocator(t.frame).locator(t.selector).first();
    return page.locator(t.selector).first();
  }

  /**
   * 要素操作を実行する。ref 操作がタイムアウトした場合は、直近の snapshot から
   * 同じ role/name の要素を新しい snapshot で探し、新 ref で 1 回だけリトライする
   * (SPA の再レンダで ref が失効しても、要素自体が残っていれば操作が通る)。
   * それでも失敗したら、エージェントが次に取るべき行動をヒントとして付ける。
   */
  async act<T>(
    page: Page,
    tabId: number,
    t: Target,
    fn: (loc: Locator) => Promise<T>,
  ): Promise<{ value: T; reResolved?: { from: string; to: string } }> {
    let target = t;
    let reResolved: { from: string; to: string } | undefined;
    // ref が既に失効している(要素が見つからない)ならタイムアウトを待たずに即再解決する
    if (t.ref && (await this.loc(page, t).count().catch(() => 0)) === 0) {
      const newRef = await this.reResolveRef(page, tabId, t.ref).catch(() => null);
      if (!newRef) {
        // ref は snapshot 時点の要素インスタンスに紐づくため、待っても現れない。即エラーにする
        throw new Error(
          `ref "${t.ref}" の要素が見つかりません。ref はページ遷移や DOM 変化で失効します(自動再解決も一意に決まりませんでした)。kb snapshot を取り直して最新の ref を使ってください。`,
        );
      }
      target = { ...t, ref: newRef };
      reResolved = { from: t.ref, to: newRef };
    }
    try {
      return { value: await fn(this.loc(page, target)), reResolved };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timeout \d+ms exceeded/i.test(msg)) throw err;
      if (t.ref && !reResolved) {
        // count() では存在して見えたが操作はタイムアウトした場合の遅い再解決パス。
        // 再 snapshot は ref の紐付け自体を更新するため、同じ ref 番号が返っても再試行する価値がある
        const newRef = await this.reResolveRef(page, tabId, t.ref).catch(() => null);
        if (newRef) {
          try {
            const value = await fn(this.loc(page, { ...t, ref: newRef }));
            return { value, reResolved: { from: t.ref, to: newRef } };
          } catch {
            /* 再解決先でも失敗 → 下のヒント付きエラーへ */
          }
        }
      }
      const hint = t.ref
        ? `ref "${t.ref}" の要素が見つかりません。ref はページ遷移や DOM 変化で失効します(自動再解決も一意に決まりませんでした)。kb snapshot を取り直して最新の ref を使ってください。`
        : `要素が見つからないか操作できない状態です。kb snapshot でページ構造を確認してください。`;
      throw new Error(`${hint}\n(${msg.split('\n')[0]})`);
    }
  }

  /**
   * 失効した ref を再解決する。直近の snapshot キャッシュから旧 ref の行(role と
   * アクセシブルネーム)を取り出し、新しい snapshot で同じ role/name の行が
   * ちょうど 1 つのときだけ、その ref を返す(曖昧なら null)。
   */
  private async reResolveRef(page: Page, tabId: number, oldRef: string): Promise<string | null> {
    const prev = this.lastSnapshots.get(tabId);
    if (!prev) return null;
    const oldLine = prev.split('\n').find((l) => l.includes(`[ref=${oldRef}]`));
    if (!oldLine) return null;
    // 行の形式: `- button "Submit" [ref=e12]`。name のない要素は誤爆しやすいので対象外
    const parsed = /-\s+([a-zA-Z]+)\s+"([^"]+)"/.exec(oldLine);
    if (!parsed) return null;
    let snap: string;
    try {
      snap = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    } catch {
      return null;
    }
    this.lastSnapshots.set(tabId, snap);
    const lineRe = new RegExp(`-\\s+${escapeRegExp(parsed[1])}\\s+"${escapeRegExp(parsed[2])}".*\\[ref=([a-zA-Z0-9]+)\\]`);
    const hits = snap.split('\n').filter((l) => lineRe.test(l));
    if (hits.length !== 1) return null;
    return lineRe.exec(hits[0])![1];
  }
}
