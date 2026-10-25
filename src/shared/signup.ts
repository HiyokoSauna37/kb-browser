import fs from 'node:fs';
import path from 'node:path';
import type { ChallengeVendor, SessionVerdict } from './challenge';
import { normalizeUrl } from './util';
import { PROFILES_DIR, SIGNUPS_DIR, ensureKbHome } from './paths';

export type SignupChannel = 'chrome' | 'msedge';
export type SignupPhase =
  | 'browser-running'
  | 'ready-to-adopt'
  | 'adopting'
  | 'adopted'
  | 'adopted-proxy'
  | 'challenge-after-adopt'
  | 'degraded-after-adopt'
  | 'proxy-challenge'
  | 'proxy-degraded'
  | 'failed';

export interface SignupCheckSummary {
  at: string;
  url: string;
  proxy: string;
  verdict: SessionVerdict;
  cookieCount: number;
  challenged: boolean;
  vendor?: ChallengeVendor;
  marker?: string;
  finalUrl?: string;
  expectSelector?: string;
  selectorMatched?: boolean;
  expectCookie?: string;
  cookieMatched?: boolean;
}

/** signup が session.check から利用する最小の共有応答契約。 */
export interface SignupSessionProbe {
  label?: 'root' | 'target' | 'api';
  challenged?: boolean;
  finalUrl?: string;
  selectorMatched?: boolean;
  vendor?: ChallengeVendor;
  marker?: string;
}

export interface SignupSessionCheck {
  verdict: SessionVerdict;
  cookieCount?: number;
  probes?: SignupSessionProbe[];
}

export type AdoptionCheckPhase = Extract<
  SignupPhase,
  'adopted' | 'challenge-after-adopt' | 'degraded-after-adopt'
>;

export interface SignupState {
  version: 1;
  name: string;
  profile: string;
  url: string;
  checkUrl?: string;
  expectSelector?: string;
  expectCookie?: string;
  channel: SignupChannel;
  browserPath: string;
  direct: boolean;
  proxyBefore: string;
  bootstrapPid: number;
  startedAt: string;
  updatedAt: string;
  phase: SignupPhase;
  adoptedAt?: string;
  checkpointPath?: string;
  lastCheck?: SignupCheckSummary;
  postProxyCheck?: SignupCheckSummary;
  rollbackCheck?: SignupCheckSummary;
  error?: string;
}

export interface SignupBootstrapSettings {
  profile: string;
  channel: SignupChannel;
  checkUrl?: string;
  expectSelector?: string;
  expectCookie?: string;
  browserPathHint?: string;
  direct: boolean;
  proxyBefore: string;
}

export function validateSignupName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error('signup 名は英数字で始まる 1〜64 文字の英数字 / . / _ / - にしてください');
  }
  return name;
}

export function validateProfileName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error('profile 名は英数字で始まる 1〜64 文字の英数字 / . / _ / - にしてください');
  }
  return name;
}

export function validateExpectedSelector(selector: string): string {
  const value = selector.trim();
  if (!value || value.length > 2_000) throw new Error('--expect-selector は 1〜2000 文字で指定してください');
  return value;
}

export function validateExpectedCookie(name: string): string {
  const value = name.trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(value)) {
    throw new Error('--expect-cookie は有効な Cookie 名を指定してください');
  }
  return value;
}

export function normalizeSignupUrl(input: string): string {
  const normalized = normalizeUrl(input);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`URL が不正です: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('signup URL は http:// または https:// を指定してください');
  }
  return url.toString();
}

/** 再開時に target 固有の profile/経路/成功条件を失わないための純粋な設定解決。 */
export function resolveSignupBootstrapSettings(
  name: string,
  url: string,
  existing: SignupState | null,
  opts: {
    reuseProfile?: boolean;
    profile?: string;
    channel?: string;
    checkUrl?: string;
    expectSelector?: string;
    expectCookie?: string;
    browserPath?: string;
    systemProxy?: boolean;
    direct?: boolean;
    activeProxy: string;
  },
): SignupBootstrapSettings {
  if (existing && !opts.reuseProfile) {
    throw new Error(`signup "${name}" は既に存在します。既存の登録状態を続ける場合だけ --reuse-profile を付けてください`);
  }
  if (existing) {
    if (new URL(existing.url).origin !== new URL(url).origin) {
      throw new Error(`signup "${name}" は ${new URL(existing.url).origin} 用です。別 origin には新しい signup 名を使ってください`);
    }
    if (opts.profile && opts.profile !== existing.profile) {
      throw new Error(`signup "${name}" の profile は "${existing.profile}" です。再開時に変更できません`);
    }
    if (opts.channel && opts.channel !== existing.channel) {
      throw new Error(`signup "${name}" の channel は "${existing.channel}" です。再開時に変更できません`);
    }
  }
  if (opts.systemProxy && opts.direct) throw new Error('--system-proxy と --direct は同時に指定できません');
  const rawChannel = opts.channel ?? existing?.channel ?? 'chrome';
  if (rawChannel !== 'chrome' && rawChannel !== 'msedge') throw new Error('--channel は chrome | msedge を指定してください');
  return {
    profile: validateProfileName(opts.profile ?? existing?.profile ?? `signup-${name}`),
    channel: rawChannel,
    checkUrl: opts.checkUrl ? normalizeSignupUrl(opts.checkUrl) : existing?.checkUrl,
    expectSelector: opts.expectSelector ? validateExpectedSelector(opts.expectSelector) : existing?.expectSelector,
    expectCookie: opts.expectCookie ? validateExpectedCookie(opts.expectCookie) : existing?.expectCookie,
    browserPathHint: opts.browserPath ?? (opts.reuseProfile ? existing?.browserPath : undefined),
    direct: opts.direct ? true : opts.systemProxy ? false : opts.reuseProfile && existing ? existing.direct : true,
    proxyBefore: opts.reuseProfile && existing ? existing.proxyBefore : opts.activeProxy,
  };
}

export function signupDir(name: string): string {
  return path.join(SIGNUPS_DIR, validateSignupName(name));
}

export function signupStatePath(name: string): string {
  return path.join(signupDir(name), 'state.json');
}

export function signupCheckpointPath(name: string): string {
  return path.join(signupDir(name), 'storage-state.json');
}

export function signupProfilePath(profile: string): string {
  return path.join(PROFILES_DIR, validateProfileName(profile));
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeSignupState(state: SignupState): void {
  ensureKbHome();
  state.updatedAt = new Date().toISOString();
  writePrivateJson(signupStatePath(state.name), state);
}

export function writeSignupCheckpoint(file: string, storageState: unknown): void {
  ensureKbHome();
  writePrivateJson(file, storageState);
}

export function readSignupState(name: string): SignupState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(signupStatePath(name), 'utf8')) as SignupState;
    if (raw?.version !== 1 || raw.name !== name) return null;
    return raw;
  } catch {
    return null;
  }
}

export function listSignupStates(): SignupState[] {
  try {
    return fs
      .readdirSync(SIGNUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSignupState(e.name))
      .filter((s): s is SignupState => s != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** 通常 Chrome に渡す最小引数。CDP / automation / stealth 用フラグは意図的に一切含めない。 */
export function bootstrapBrowserArgs(profileDir: string, url: string, opts: { direct: boolean }): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...(opts.direct ? ['--no-proxy-server'] : []),
    url,
  ];
}

function pathCandidates(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const out: string[] = [];
  for (const dir of dirs) for (const name of names) for (const ext of exts) out.push(path.join(dir, name + ext));
  return out;
}

/** channel に対応する通常ブラウザの候補。Playwright の executablePath は使わない。 */
export function browserExecutableCandidates(
  channel: SignupChannel,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((x): x is string => !!x);
    const rel = channel === 'chrome' ? path.join('Google', 'Chrome', 'Application', 'chrome.exe') : path.join('Microsoft', 'Edge', 'Application', 'msedge.exe');
    return [...roots.map((root) => path.join(root, rel)), ...pathCandidates(channel === 'chrome' ? ['chrome', 'google-chrome'] : ['msedge'], env, platform)];
  }
  if (platform === 'darwin') {
    return channel === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...pathCandidates(['google-chrome', 'chrome'], env, platform)]
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', ...pathCandidates(['microsoft-edge', 'msedge'], env, platform)];
  }
  return channel === 'chrome'
    ? ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', ...pathCandidates(['google-chrome-stable', 'google-chrome'], env, platform)]
    : ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', ...pathCandidates(['microsoft-edge-stable', 'microsoft-edge'], env, platform)];
}

export function resolveBrowserExecutable(
  channel: SignupChannel,
  explicit?: string,
  exists: (file: string) => boolean = fs.existsSync,
): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!exists(resolved)) throw new Error(`ブラウザ実行ファイルが見つかりません: ${resolved}`);
    return resolved;
  }
  const found = browserExecutableCandidates(channel).find(exists);
  if (!found) {
    throw new Error(
      `${channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} が見つかりません。` +
        `インストールするか --browser-path <実行ファイル> を指定してください(同梱 Chromium は signup bootstrap では使いません)。`,
    );
  }
  return found;
}

/**
 * check URL の同一ページに着地したかを保守的に見る。
 * `/account` → `/account/` と hash/query の付加は許すが、`/login` 等への退避は成功にしない。
 */
export function sameSignupDestination(expected: string, actual?: string): boolean {
  if (!actual) return false; // 最終到達先を観測できなかった状態を成功にしない
  try {
    const a = new URL(expected);
    const b = new URL(actual);
    const pathKey = (value: string) => (value.length > 1 ? value.replace(/\/+$/, '') : value);
    return a.origin === b.origin && pathKey(a.pathname) === pathKey(b.pathname);
  } catch {
    return false;
  }
}

export function classifyAdoption(
  check: SignupSessionCheck,
  expectedUrl?: string,
  expectations: { selector?: string; cookie?: string; cookieNames?: readonly string[] } = {},
): AdoptionCheckPhase {
  if (check.probes?.some((p) => p.challenged)) return 'challenge-after-adopt';
  const target = check.probes?.find((p) => p.label === 'target');
  if (expectedUrl && !sameSignupDestination(expectedUrl, target?.finalUrl)) return 'degraded-after-adopt';
  if (expectations.selector && target?.selectorMatched !== true) return 'degraded-after-adopt';
  if (expectations.cookie && !expectations.cookieNames?.includes(expectations.cookie)) return 'degraded-after-adopt';
  return check.verdict === 'ok' ? 'adopted' : 'degraded-after-adopt';
}

export function summarizeSignupCheck(
  check: SignupSessionCheck,
  url: string,
  proxy: string,
  expectations: { selector?: string; cookie?: string; cookieNames?: readonly string[] } = {},
): SignupCheckSummary {
  const challenge = check.probes?.find((probe) => probe.challenged);
  const target = check.probes?.find((probe) => probe.label === 'target');
  return {
    at: new Date().toISOString(),
    url,
    proxy,
    verdict: check.verdict,
    cookieCount: Number(check.cookieCount ?? 0),
    challenged: !!challenge,
    vendor: challenge?.vendor,
    marker: challenge?.marker,
    finalUrl: target?.finalUrl,
    expectSelector: expectations.selector,
    selectorMatched: expectations.selector ? target?.selectorMatched === true : undefined,
    expectCookie: expectations.cookie,
    cookieMatched: expectations.cookie ? expectations.cookieNames?.includes(expectations.cookie) === true : undefined,
  };
}
