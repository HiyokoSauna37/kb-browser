import type { Dialog, Page } from 'playwright';
import type { DialogInfo, DialogPolicy } from '../types';

/**
 * JS ダイアログ (alert/confirm/prompt) の保留・応答を担う。
 *
 * 既定 hold: リスナーなしの Playwright はダイアログを表示前に自動 dismiss してしまい
 * (confirm は常に false)、ユーザーには「ボタンが反応しない」ように見える。hold は保留して
 * ネイティブ表示を残し、ウィンドウ上または kb dialog accept / dismiss での応答を待つ。
 *
 * consoleLog / journal への記録は facade が持つため、表示は onLog コールバックへ委譲する。
 */
export class DialogManager {
  private policy: DialogPolicy = 'hold';
  /** タブ毎の応答待ちダイアログ。閉鎖は CDP の Page.javascriptDialogClosed で検知して消す。 */
  private pending = new Map<number, { dialog: Dialog; info: DialogInfo }>();
  /** 操作中にダイアログが開いたことを actOrDialog へ知らせるワンショット通知。 */
  private waiters = new Map<number, Set<(info: DialogInfo) => void>>();

  constructor(private readonly onLog: (tab: number, text: string) => void) {}

  /** page.on('dialog') の本体。hold なら保留、それ以外は表示せず即応答する。 */
  handle(dialog: Dialog, tabId: number): void {
    const info: DialogInfo = {
      tab: tabId,
      type: dialog.type(),
      message: dialog.message().slice(0, 500),
      ...(dialog.type() === 'prompt' ? { defaultValue: dialog.defaultValue() } : {}),
      ts: new Date().toISOString(),
    };
    if (this.policy === 'hold') {
      this.pending.set(tabId, { dialog, info });
      this.onLog(tabId, `${info.type}「${info.message}」が開き、応答待ちです (kb dialog accept / dismiss)`);
      for (const notify of this.waiters.get(tabId) ?? []) notify(info);
    } else {
      // 応答済みダイアログに accept/dismiss すると throw するため握りつぶす(閉鎖は CDP 側で記録される)
      void (this.policy === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => {});
      this.onLog(tabId, `${info.type}「${info.message}」に policy=${this.policy} で自動応答しました`);
    }
  }

  /**
   * ダイアログの閉鎖を CDP で監視する。Playwright の Dialog には閉鎖イベントがなく、
   * headed でユーザーがネイティブ UI から直接応答した場合に保留が残ってしまうため、
   * 自前の CDPSession で Page.javascriptDialogClosed を購読して解除する。
   */
  async watchClose(page: Page, tabId: number): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.javascriptDialogClosed', (e: { result: boolean }) => {
        const pending = this.pending.get(tabId);
        this.pending.delete(tabId);
        if (pending) {
          this.onLog(tabId, `${pending.info.type}「${pending.info.message}」が${e.result ? '承認' : 'キャンセル'}されました`);
        }
      });
      await cdp.send('Page.enable');
    } catch {
      // 購読できなくても保留解除は respond のエラー処理で自己修復する
    }
  }

  /**
   * 操作を実行しつつ、その操作で JS ダイアログが開いて保留になったら完了を待たずに
   * ダイアログ情報を返す(保留中はページの JS が止まるため、操作はタイムアウトまで
   * 完了しない)。操作自体は裏で継続し、ダイアログ応答後に完結する。
   */
  async actOrDialog<T>(tabId: number, run: () => Promise<T>, onDialog: (d: DialogInfo) => T): Promise<T> {
    if (this.policy !== 'hold') return run();
    let notify!: (info: DialogInfo) => void;
    const opened = new Promise<DialogInfo>((resolve) => (notify = resolve));
    const waiters = this.waiters.get(tabId) ?? new Set();
    waiters.add(notify);
    this.waiters.set(tabId, waiters);
    try {
      const action = run();
      action.catch(() => {}); // 早期リターン後にタイムアウトしても unhandled rejection にしない
      const winner = await Promise.race([
        action.then((value) => ({ value })),
        opened.then((dialog) => ({ dialog })),
      ]);
      return 'value' in winner ? winner.value : onDialog(winner.dialog);
    } finally {
      waiters.delete(notify);
    }
  }

  /** タブに応答待ちダイアログがあるか。 */
  has(tabId: number): boolean {
    return this.pending.has(tabId);
  }

  /** タブの応答待ちダイアログ情報(なければ undefined)。 */
  get(tabId: number): DialogInfo | undefined {
    return this.pending.get(tabId)?.info;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingTabs(): number[] {
    return [...this.pending.keys()];
  }

  get currentPolicy(): DialogPolicy {
    return this.policy;
  }

  /** タブが閉じたら保留と待機を破棄する。 */
  dropTab(tabId: number): void {
    this.pending.delete(tabId);
    this.waiters.delete(tabId);
  }

  /** 保留中ダイアログの解決。tab 省略時は保留が 1 件ならそれ、複数ならアクティブタブ。 */
  private resolve(tabId: number | undefined, activeTabId: number | null): { dialog: Dialog; info: DialogInfo } | null {
    if (tabId != null) return this.pending.get(tabId) ?? null;
    if (this.pending.size === 1) return [...this.pending.values()][0];
    if (activeTabId != null) return this.pending.get(activeTabId) ?? null;
    return null;
  }

  /** 保留中ダイアログの情報と現在のポリシー。 */
  info(tabId: number | undefined, activeTabId: number | null): { pending: DialogInfo | null; pendingTabs: number[]; policy: DialogPolicy } {
    return {
      pending: this.resolve(tabId, activeTabId)?.info ?? null,
      pendingTabs: [...this.pending.keys()],
      policy: this.policy,
    };
  }

  /** 保留中ダイアログに応答する。promptText は prompt の入力値(accept 時のみ)。 */
  async respond(
    accept: boolean,
    promptText: string | undefined,
    tabId: number | undefined,
    activeTabId: number | null,
  ): Promise<{ responded: 'accept' | 'dismiss'; dialog: DialogInfo }> {
    const pending = this.resolve(tabId, activeTabId);
    if (!pending) {
      const tabs = [...this.pending.keys()];
      throw new Error(
        tabs.length
          ? `保留中のダイアログが複数あります。-t でタブを指定してください (タブ: ${tabs.join(', ')})`
          : '応答待ちのダイアログはありません。',
      );
    }
    try {
      if (accept) await pending.dialog.accept(promptText);
      else await pending.dialog.dismiss();
    } catch {
      // ユーザーがウィンドウ上で先に応答済みなど。保留を確実に解除して分かるエラーにする
      this.pending.delete(pending.info.tab);
      throw new Error('ダイアログは既に閉じられています(ウィンドウ上で応答済みの可能性があります)。');
    }
    // 通常は watchClose が消すが、CDP 購読に失敗している環境向けの保険
    this.pending.delete(pending.info.tab);
    return { responded: accept ? 'accept' : 'dismiss', dialog: pending.info };
  }

  /** ダイアログの応答ポリシーを設定/取得する。 */
  setPolicy(policy?: DialogPolicy): { policy: DialogPolicy } {
    if (policy != null) {
      if (!['hold', 'accept', 'dismiss'].includes(policy)) {
        throw new Error(`不正なポリシーです: ${policy} (hold | accept | dismiss)`);
      }
      this.policy = policy;
    }
    return { policy: this.policy };
  }

  /** 保留ダイアログが操作をブロックしている可能性があるとき、エラーにその旨のヒントを付ける。 */
  withHint(tabId: number, err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    const pending = this.pending.get(tabId);
    if (!pending) return err instanceof Error ? err : new Error(message);
    return new Error(
      `${message}\n(タブ ${tabId} で ${pending.info.type} ダイアログ「${pending.info.message}」が応答待ちです。kb dialog accept / dismiss で応答できます)`,
    );
  }
}
