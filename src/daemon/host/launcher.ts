import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { PROFILES_DIR } from '../../shared/paths';
import type { HostOptions } from '../types';

export interface LaunchResult {
  context: BrowserContext;
  /** connectOverCDP でアタッチした場合のみ(stop 時は切断のみでブラウザを閉じない)。 */
  browser: Browser | null;
  channel: string;
  attached: boolean;
}

/**
 * 自前でブラウザを起動する(通常モード)。channel は chrome → msedge → 同梱 chromium の順に
 * フォールバックする(`--channel` 明示時はフォールバックせず strict)。
 */
export async function launchOwned(opts: HostOptions): Promise<LaunchResult> {
  const userDataDir = path.join(PROFILES_DIR, opts.profile);
  const hasExt = opts.extensions != null;
  // 拡張機能ロード時、「同梱 Chromium」は undefined でなく明示 channel 'chromium' として渡す。
  // undefined + headless だと Playwright は旧 headless(headless shell)を選び拡張が一切
  // ロードされないため(channel 'chromium' は同一バイナリで新 headless を使う)。
  const bundled = hasExt ? 'chromium' : undefined;
  const candidates: (string | undefined)[] = opts.channel
    ? [opts.channel === 'chromium' ? bundled : opts.channel]
    : opts.extensions?.length
      ? // 未パック拡張の --load-extension は Chrome 137+ の stable では無視される(サイドロード
        // マルウェア対策で削除)ため、自動選択では chrome/msedge を飛ばして同梱 Chromium を使う。
        [bundled]
      : ['chrome', 'msedge', bundled];
  const errors: string[] = [];
  for (const channel of candidates) {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: opts.headless,
        channel,
        viewport: null,
        proxy: opts.proxy,
        httpCredentials: opts.httpCredentials,
        userAgent: opts.userAgent,
        // HTTPS 証明書エラーを無視する(自己署名 / 未信頼 CA の MITM プロキシ向け escape hatch)。
        // context.request(kb request)も context の設定を継承するため同じく無視される。
        ignoreHTTPSErrors: opts.ignoreHttpsErrors,
        // ステルス: navigator.webdriver を実 Chrome 同様に消す(JS で defineProperty するより
        // フラグで生やさない方が痕跡が残らない)。計測上、これだけで chrome チャネルの
        // JS レベルの自動化シグナルはほぼ実 Chrome と一致する。
        args: [
          ...(opts.stealth ? ['--disable-blink-features=AutomationControlled'] : []),
          ...(opts.extensions?.length ? [`--load-extension=${opts.extensions.join(',')}`] : []),
          // OS ストア非経由の CA 信頼: この SPKI の証明書だけエラーを許可する(全無検証ではない)
          ...(opts.ignoreCertErrorsSpkiList?.length
            ? [`--ignore-certificate-errors-spki-list=${opts.ignoreCertErrorsSpkiList.join(',')}`]
            : []),
        ],
        // 拡張機能有効時は Playwright 既定の --disable-extensions を外す。これで
        // プロファイルにインストール済みの拡張(ストア由来)もロードされる。
        ignoreDefaultArgs: hasExt ? ['--disable-extensions'] : undefined,
      });
      return { context, browser: null, channel: channel ?? 'bundled chromium', attached: false };
    } catch (err) {
      const firstLine = String(err instanceof Error ? err.message : err).split('\n')[0];
      errors.push(`${channel ?? 'bundled chromium'}: ${firstLine}`);
    }
  }
  const detail = errors.map((e) => `  - ${e}`).join('\n');
  const hint = errors.some((e) => /ProcessSingleton|already in use|SingletonLock/i.test(e))
    ? `プロファイル "${opts.profile}" が別の Chromium プロセスに使用されています。既存の kb デーモンや孤児プロセスを終了してください。`
    : 'Chrome/Edge が見つからない場合は "npx playwright install chromium" を実行してください。';
  throw new Error(`ブラウザを起動できません。${hint}\n候補ごとの失敗理由:\n${detail}`);
}

/**
 * 起動済みブラウザへ connectOverCDP でアタッチする。対象は
 * `--remote-debugging-port` 付きで起動した Chrome / Edge / Chromium。
 * proxy / UA / Basic 認証などの起動時オプションは適用できない。
 * ブラウザ切断時のフック(onClosed)は呼び出し側で browser に張る。
 */
export async function attachOverCdp(cdpUrl: string): Promise<LaunchResult> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  } catch (err) {
    throw new Error(
      `CDP エンドポイント ${cdpUrl} に接続できません。対象ブラウザを --remote-debugging-port 付きで起動してください` +
        `(例: chrome --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\kb-attach")。` +
        `Chrome 136 以降は普段使いの既定プロファイルではリモートデバッグが無効化されているため、専用の --user-data-dir が必要です。\n` +
        `(${String(err instanceof Error ? err.message : err).split('\n')[0]})`,
    );
  }
  const contexts = browser.contexts();
  if (!contexts.length) {
    await browser.close().catch(() => {});
    throw new Error('アタッチ先にブラウザコンテキストが見つかりません(ウィンドウが 1 つも開いていない可能性があります)');
  }
  return { context: contexts[0], browser, channel: `cdp:${cdpUrl}`, attached: true };
}
