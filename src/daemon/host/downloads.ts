import path from 'node:path';
import type { Download } from 'playwright';
import { DOWNLOADS_DIR } from '../../shared/paths';
import type { DownloadInfo } from '../types';

/** downloads 配列の保持上限(古いものから evict。ファイル実体は消さない)。 */
const DOWNLOADS_CAP = 1_000;

/**
 * ダウンロードのディスク保存と履歴管理。タブの page.on('download') から handle() を呼ぶ。
 * 上限を超えたら古いエントリから捨てる(ダウンロード済みファイルの実体は残す)。
 */
export class DownloadManager {
  private downloads: DownloadInfo[] = [];
  private nextId = 1;

  /** ダウンロードを DOWNLOADS_DIR に保存し、履歴に記録する(保存の成否は info.state に反映)。 */
  handle(dl: Download, tabId: number): void {
    const id = this.nextId++;
    const safeName = (dl.suggestedFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
    const file = path.join(DOWNLOADS_DIR, `${id}-${safeName}`);
    const info: DownloadInfo = { id, ts: new Date().toISOString(), tab: tabId, url: dl.url(), file, state: 'saving' };
    this.downloads.push(info);
    // 上限を超えたら古いエントリから捨てる(ダウンロード済みファイルの実体は残す)。
    if (this.downloads.length > DOWNLOADS_CAP) this.downloads.splice(0, this.downloads.length - DOWNLOADS_CAP);
    dl.saveAs(file).then(
      () => {
        info.state = 'saved';
      },
      (err) => {
        info.state = 'failed';
        info.error = String(err instanceof Error ? err.message : err).split('\n')[0];
      },
    );
  }

  list(): DownloadInfo[] {
    return this.downloads;
  }

  clear(): { cleared: number } {
    const n = this.downloads.length;
    this.downloads = [];
    return { cleared: n };
  }

  get count(): number {
    return this.downloads.length;
  }
}
