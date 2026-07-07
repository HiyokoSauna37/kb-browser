import type { BrowserContext, CDPSession, Page } from 'playwright';

const NETWORK_PRESETS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  offline: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  slow3g: { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
  fast3g: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  reset: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

/**
 * UA / viewport / タイムゾーン / 回線速度のエミュレーション (DevTools Device Toolbar 相当)。
 * CDP セッションを detach するとオーバーライドが解除されるため、タブ毎に保持し続ける。
 */
export class Emulator {
  private sessions = new Map<number, CDPSession>();

  dropTab(tabId: number): void {
    this.sessions.delete(tabId);
  }

  clear(): void {
    this.sessions.clear();
  }

  private async sessionFor(context: BrowserContext, tabId: number, page: Page): Promise<CDPSession> {
    const existing = this.sessions.get(tabId);
    if (existing) return existing;
    const session = await context.newCDPSession(page);
    this.sessions.set(tabId, session);
    return session;
  }

  async apply(
    context: BrowserContext,
    tabId: number,
    page: Page,
    opts: {
      ua?: string;
      viewport?: { width: number; height: number; dpr?: number; mobile?: boolean };
      timezone?: string;
      reset?: boolean;
    },
  ): Promise<{ applied: string[] }> {
    const cdp = await this.sessionFor(context, tabId, page);
    const applied: string[] = [];
    if (opts.reset) {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await cdp.send('Emulation.clearGeolocationOverride').catch(() => {});
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      applied.push('reset');
    }
    if (opts.ua) {
      // Sec-CH-UA (Client Hints) と矛盾しないよう UA 文字列からメタデータも導出する
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: opts.ua,
        userAgentMetadata: uaMetadataFrom(opts.ua),
      });
      applied.push('ua');
    }
    if (opts.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: opts.viewport.width,
        height: opts.viewport.height,
        deviceScaleFactor: opts.viewport.dpr ?? 1,
        mobile: !!opts.viewport.mobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: !!opts.viewport.mobile,
        maxTouchPoints: opts.viewport.mobile ? 5 : 1,
      });
      applied.push('viewport');
    }
    if (opts.timezone) {
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone });
      applied.push('timezone');
    }
    return { applied };
  }

  /** ネットワーク速度エミュレーション (offline | slow3g | fast3g | reset)。タブ単位。 */
  async applyNetworkPreset(context: BrowserContext, tabId: number, page: Page, preset: string): Promise<{ preset: string }> {
    const conditions = NETWORK_PRESETS[preset];
    if (!conditions) {
      throw new Error(`不明なプリセット "${preset}"。offline | slow3g | fast3g | reset から選んでください。`);
    }
    const cdp = await this.sessionFor(context, tabId, page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', conditions);
    return { preset };
  }
}

/** UA 文字列から Client Hints 用メタデータをおおまかに導出する。 */
function uaMetadataFrom(ua: string):
  | {
      brands: { brand: string; version: string }[];
      fullVersion: string;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
    }
  | undefined {
  const chromeVer = /Chrom(?:e|ium)\/(\d+)/.exec(ua)?.[1];
  if (!chromeVer) return undefined;
  const mobile = /Android|iPhone|Mobile/i.test(ua);
  let platform = 'Windows';
  if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad/.test(ua)) platform = 'iOS';
  else if (/Mac OS X/.test(ua)) platform = 'macOS';
  else if (/Linux/.test(ua)) platform = 'Linux';
  return {
    brands: [
      { brand: 'Chromium', version: chromeVer },
      { brand: 'Google Chrome', version: chromeVer },
      { brand: 'Not-A.Brand', version: '99' },
    ],
    fullVersion: `${chromeVer}.0.0.0`,
    platform,
    platformVersion: '',
    architecture: mobile ? '' : 'x86',
    model: '',
    mobile,
  };
}
