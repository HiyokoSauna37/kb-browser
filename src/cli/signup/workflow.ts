import { rpc } from '../../shared/client';
import { readLastRun, writeLastRun } from '../../shared/paths';
import { loadProxyConfig, resolveProfile, saveProxyConfig } from '../../shared/proxyStore';
import {
  classifyAdoption,
  summarizeSignupCheck,
  writeSignupCheckpoint,
  writeSignupState,
  type AdoptionCheckPhase,
  type SignupCheckSummary,
  type SignupSessionCheck,
  type SignupState,
} from '../../shared/signup';

export interface AdoptionEvaluation {
  check: SignupSessionCheck;
  phase: AdoptionCheckPhase;
  summary: SignupCheckSummary;
  storageState: unknown;
}

export interface AdoptionWorkflowOptions {
  checkUrl: string;
  api?: string;
  timeoutMs: number;
  expectSelector?: string;
  expectCookie?: string;
  checkpointPath: string;
  restoreProxy: boolean;
}

interface StorageRestoreResult {
  skippedOrigins?: string[];
}

export interface AdoptionWorkflowDependencies {
  evaluate(
    checkUrl: string,
    opts: {
      api?: string;
      timeoutMs: number;
      expectSelector?: string;
      expectCookie?: string;
      proxy: string;
    },
  ): Promise<AdoptionEvaluation>;
  activateProxy(name: string): void;
  reloadProxy(): Promise<void>;
  restoreStorage(state: unknown): Promise<StorageRestoreResult>;
  saveCheckpoint(file: string, storageState: unknown): void;
  saveState(state: SignupState): void;
  now(): string;
}

const SESSION_VERDICTS = new Set<SignupSessionCheck['verdict']>([
  'ok',
  'degraded',
  'degraded-html-only',
  'target-protected',
  'no-session',
  'expectation-failed',
  'unreachable',
]);

function firstErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 500);
}

/** 失敗時点までに確定した診断情報を CLI 側の failed 状態へ引き継ぐ。 */
export class AdoptionWorkflowError extends Error {
  constructor(
    readonly state: SignupState,
    readonly originalError: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'AdoptionWorkflowError';
  }
}

function parseSessionCheck(value: unknown): SignupSessionCheck {
  if (!value || typeof value !== 'object') {
    throw new Error('session.check から不正な応答を受け取りました');
  }
  const result = value as { verdict?: unknown; probes?: unknown };
  if (
    typeof result.verdict !== 'string' ||
    !SESSION_VERDICTS.has(result.verdict as SignupSessionCheck['verdict']) ||
    (result.probes != null && !Array.isArray(result.probes))
  ) {
    throw new Error('session.check から不正な応答を受け取りました');
  }
  return value as SignupSessionCheck;
}

function cookieNamesFromStorage(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const cookies = (value as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return [];
  return cookies
    .map((cookie) =>
      cookie && typeof cookie === 'object' ? (cookie as { name?: unknown }).name : undefined,
    )
    .filter((name): name is string => typeof name === 'string');
}

function parseStorageRestoreResult(value: unknown): StorageRestoreResult {
  if (!value || typeof value !== 'object') {
    throw new Error('storage.restore から不正な応答を受け取りました');
  }
  const skippedOrigins = (value as { skippedOrigins?: unknown }).skippedOrigins;
  if (!Array.isArray(skippedOrigins) || skippedOrigins.some((origin) => typeof origin !== 'string')) {
    throw new Error('storage.restore から不正な応答を受け取りました');
  }
  return { skippedOrigins };
}

/** session.check と storage.dump を同じ時点で採取し、採用可否を 1 つの結果へ束ねる。 */
export async function evaluateAdoption(
  checkUrl: string,
  opts: {
    api?: string;
    timeoutMs: number;
    expectSelector?: string;
    expectCookie?: string;
    proxy: string;
  },
): Promise<AdoptionEvaluation> {
  const rawCheck: unknown = await rpc('session.check', {
    url: checkUrl,
    api: opts.api,
    expectSelector: opts.expectSelector,
    timeoutMs: opts.timeoutMs,
  });
  const check = parseSessionCheck(rawCheck);
  const storageState: unknown = await rpc('storage.dump');
  const expectations = {
    selector: opts.expectSelector,
    cookie: opts.expectCookie,
    cookieNames: cookieNamesFromStorage(storageState),
  };
  return {
    check,
    phase: classifyAdoption(check, checkUrl, expectations),
    summary: summarizeSignupCheck(check, checkUrl, opts.proxy, expectations),
    storageState,
  };
}

/** proxies.json の active を検証付きで切り替える。daemon への反映は呼び出し側が行う。 */
export function setSignupProxyActive(name: string): void {
  const cfg = loadProxyConfig();
  resolveProfile(cfg, name);
  cfg.active = name;
  saveProxyConfig(cfg);
}

/** 通常ブラウザから引き継いだ fingerprint を不用意に変えない起動設定へ揃える。 */
export function configureAdoptLastRun(state: SignupState, stealth: boolean): void {
  const last = readLastRun();
  writeLastRun({
    ...last,
    headless: false,
    profile: state.profile,
    channel: state.channel,
    // bootstrap は通常 Chrome の既定 UA。以前の別 target 用上書きを引き継ぐと
    // cf_clearance と UA が食い違うため明示的に消す。
    userAgent: undefined,
    stealth,
    // 未パック拡張や init script 系ホットキーは signup 引き継ぎ直後の指紋を変えるので外す。
    extensions: undefined,
    detachKey: undefined,
    translateKey: undefined,
    ignoreHttpsErrors: false,
  });
}

const defaultDependencies: AdoptionWorkflowDependencies = {
  evaluate: evaluateAdoption,
  activateProxy: setSignupProxyActive,
  reloadProxy: async () => {
    await rpc('proxy.reload');
  },
  restoreStorage: async (state) =>
    parseStorageRestoreResult(await rpc('storage.restore', { state, replace: true })),
  saveCheckpoint: writeSignupCheckpoint,
  saveState: writeSignupState,
  now: () => new Date().toISOString(),
};

/**
 * direct での採用判定から、任意の proxy 復帰と失敗時 rollback までを一続きで実行する。
 * 呼び出し前に active proxy を direct にし、state.phase を adopting として保存しておく。
 */
export async function runAdoptionWorkflow(
  initialState: SignupState,
  opts: AdoptionWorkflowOptions,
  deps: AdoptionWorkflowDependencies = defaultDependencies,
): Promise<SignupState> {
  const directEvaluation = await deps.evaluate(opts.checkUrl, {
    api: opts.api,
    timeoutMs: opts.timeoutMs,
    expectSelector: opts.expectSelector,
    expectCookie: opts.expectCookie,
    proxy: 'direct',
  });
  const directAdopted = directEvaluation.phase === 'adopted';

  // 正常確認できた状態だけ checkpoint に昇格する。再 adopt が失敗しても
  // 以前の正常 checkpoint をチャレンジ状態で上書きしない。
  if (directAdopted) deps.saveCheckpoint(opts.checkpointPath, directEvaluation.storageState);
  let state: SignupState = {
    ...initialState,
    phase: directEvaluation.phase,
    adoptedAt: directAdopted ? deps.now() : initialState.adoptedAt,
    checkpointPath: directAdopted ? opts.checkpointPath : initialState.checkpointPath,
    lastCheck: directEvaluation.summary,
    postProxyCheck: undefined,
    rollbackCheck: undefined,
  };
  try {
    deps.saveState(state);

    if (!opts.restoreProxy || !directAdopted || state.proxyBefore === 'direct') return state;

    let postEvaluation: AdoptionEvaluation | undefined;
    let proxyError: string | undefined;
    try {
      deps.activateProxy(state.proxyBefore);
      await deps.reloadProxy();
      postEvaluation = await deps.evaluate(opts.checkUrl, {
        api: opts.api,
        timeoutMs: opts.timeoutMs,
        expectSelector: opts.expectSelector,
        expectCookie: opts.expectCookie,
        proxy: state.proxyBefore,
      });
    } catch (err) {
      proxyError = firstErrorLine(err);
    }

    if (postEvaluation?.phase === 'adopted') {
      state = {
        ...state,
        phase: 'adopted-proxy',
        postProxyCheck: postEvaluation.summary,
        rollbackCheck: undefined,
        error: undefined,
      };
      // proxy 経路で発行・更新された Cookie も正常 checkpoint に含める。
      deps.saveCheckpoint(opts.checkpointPath, postEvaluation.storageState);
    } else {
      state = {
        ...state,
        phase: postEvaluation?.phase === 'challenge-after-adopt' ? 'proxy-challenge' : 'proxy-degraded',
        postProxyCheck: postEvaluation?.summary,
        error: proxyError ? `proxy validation: ${proxyError}` : undefined,
      };
      deps.activateProxy('direct');
      await deps.reloadProxy();

      // proxy 側のチャレンジが Cookie を更新・削除していても direct の正常状態へ戻す。
      // signup 専用 profile なので全 Cookie を checkpoint へ正確に戻してよい。
      const restored = await deps.restoreStorage(directEvaluation.storageState);
      if (restored.skippedOrigins?.length) {
        throw new Error(
          `checkpoint rollback で localStorage を復元できませんでした: ${restored.skippedOrigins.join(', ')}`,
        );
      }
      const rollbackEvaluation = await deps.evaluate(opts.checkUrl, {
        api: opts.api,
        timeoutMs: opts.timeoutMs,
        expectSelector: opts.expectSelector,
        expectCookie: opts.expectCookie,
        proxy: 'direct',
      });
      state = { ...state, rollbackCheck: rollbackEvaluation.summary };
      if (rollbackEvaluation.phase === 'adopted') {
        // rollback の確認通信で更新された direct 側 Cookie も checkpoint に反映する。
        deps.saveCheckpoint(opts.checkpointPath, rollbackEvaluation.storageState);
      } else {
        state = {
          ...state,
          phase: 'failed',
          error: [state.error, `direct rollback verification: ${rollbackEvaluation.phase}`]
            .filter(Boolean)
            .join('; '),
        };
      }
    }
    deps.saveState(state);
    return state;
  } catch (err) {
    throw new AdoptionWorkflowError(state, err);
  }
}
