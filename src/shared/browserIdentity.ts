/** ブラウザが公開する User-Agent Client Hints の低エントロピー部分。 */
export interface BrowserUserAgentData {
  brands: { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
}

export type BrowserIdentityIssue =
  | 'user-agent-unavailable'
  | 'ua-major-mismatch'
  | 'configured-ua-not-effective'
  | 'nonstandard-configured-ua';

/** session.check が返す、秘密情報を含まないブラウザ identity 診断。 */
export interface BrowserIdentityDiagnostic {
  userAgent: string;
  userAgentData?: BrowserUserAgentData;
  userAgentChromeMajor?: number;
  userAgentDataChromeMajor?: number;
  configuredUserAgent?: string;
  overridden: boolean;
  coherent: boolean;
  issues: BrowserIdentityIssue[];
}

function chromeMajorFromUserAgent(userAgent: string): number | undefined {
  const raw = /\b(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/.exec(userAgent)?.[1];
  if (!raw) return undefined;
  const major = Number(raw);
  return Number.isSafeInteger(major) ? major : undefined;
}

function chromeMajorFromBrands(brands?: BrowserUserAgentData['brands']): number | undefined {
  if (!brands?.length) return undefined;
  // Chromium 系派生ブラウザでも Chrome token と同じ engine major を比較できるよう、
  // 製品 brand を優先し、無ければ Chromium brand を使う。GREASE brand は選ばない。
  const preferred = ['Google Chrome', 'Microsoft Edge', 'Chromium'];
  for (const name of preferred) {
    const raw = brands.find((entry) => entry.brand === name)?.version;
    const major = raw == null ? NaN : Number(/^\d+/.exec(raw)?.[0]);
    if (Number.isSafeInteger(major)) return major;
  }
  return undefined;
}

/**
 * 一般的な Chromium UA の形かを保守的に確認する。任意 suffix や curl 等を
 * 「非標準 override」として診断するためで、ブラウザの真正性を保証する判定ではない。
 */
function looksLikeStandardChromiumUserAgent(userAgent: string): boolean {
  return /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) .*(?:Chrome|Chromium)\/\d+\.\d+\.\d+\.\d+.*(?:Mobile )?Safari\/537\.36(?: (?:Edg|OPR)\/\d+\.\d+\.\d+\.\d+)?$/.test(
    userAgent,
  );
}

/** UA 文字列・UA-CH・明示 override が互いに矛盾していないかを純粋に判定する。 */
export function diagnoseBrowserIdentity(
  effective: { userAgent: string; userAgentData?: BrowserUserAgentData },
  configuredUserAgent?: string,
): BrowserIdentityDiagnostic {
  const userAgentChromeMajor = chromeMajorFromUserAgent(effective.userAgent);
  const userAgentDataChromeMajor = chromeMajorFromBrands(effective.userAgentData?.brands);
  const issues: BrowserIdentityIssue[] = [];

  if (!effective.userAgent) issues.push('user-agent-unavailable');
  if (
    userAgentChromeMajor != null &&
    userAgentDataChromeMajor != null &&
    userAgentChromeMajor !== userAgentDataChromeMajor
  ) {
    issues.push('ua-major-mismatch');
  }
  if (configuredUserAgent != null) {
    if (configuredUserAgent !== effective.userAgent) issues.push('configured-ua-not-effective');
    if (!looksLikeStandardChromiumUserAgent(configuredUserAgent)) {
      issues.push('nonstandard-configured-ua');
    }
  }

  return {
    userAgent: effective.userAgent,
    userAgentData: effective.userAgentData,
    ...(userAgentChromeMajor != null ? { userAgentChromeMajor } : {}),
    ...(userAgentDataChromeMajor != null ? { userAgentDataChromeMajor } : {}),
    ...(configuredUserAgent != null ? { configuredUserAgent } : {}),
    overridden: configuredUserAgent != null,
    coherent: issues.length === 0,
    issues,
  };
}
