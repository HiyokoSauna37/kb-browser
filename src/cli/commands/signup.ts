import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { findProfileBrowserProcess, findProfileProcesses, listProcesses } from '../../daemon/procscan';
import { isPidAlive, pingDaemon, rpc, rpcRaw } from '../../shared/client';
import { readLastRun, writeLastRun } from '../../shared/paths';
import { loadProxyConfig, resolveProfile, saveProxyConfig } from '../../shared/proxyStore';
import {
  bootstrapBrowserArgs,
  classifyAdoption,
  listSignupStates,
  normalizeSignupUrl,
  readSignupState,
  resolveBrowserExecutable,
  resolveSignupBootstrapSettings,
  signupCheckpointPath,
  signupProfilePath,
  summarizeSignupCheck,
  validateExpectedCookie,
  validateExpectedSelector,
  validateSignupName,
  writeSignupCheckpoint,
  writeSignupState,
  type SignupState,
} from '../../shared/signup';
import { intOpt, print, run } from '../output';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 500);
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

let processSnapshot: { at: number; rows: ReturnType<typeof listProcesses> } | undefined;

function currentProcesses(): ReturnType<typeof listProcesses> {
  const now = Date.now();
  if (!processSnapshot || now - processSnapshot.at > 500) processSnapshot = { at: now, rows: listProcesses() };
  return processSnapshot.rows;
}

function profileProcessPids(profile: string, bootstrapPid?: number): number[] {
  const rows = currentProcesses();
  const pids = findProfileProcesses(rows, signupProfilePath(profile), process.pid);
  if (bootstrapPid && isPidAlive(bootstrapPid) && !pids.includes(bootstrapPid)) {
    const row = rows.find((proc) => proc.pid === bootstrapPid);
    // プロセス一覧そのものが取れないか CommandLine が権限上読めない場合だけ、起動時 PID を
    // fallback に使う。PID が別の通常プロセスへ再利用された場合は profile 使用中と誤判定しない。
    if (rows.length === 0 || !row?.cmd) pids.unshift(bootstrapPid);
  }
  return pids;
}

async function requireDaemonStopped(): Promise<void> {
  const info = await pingDaemon();
  if (!info) return;
  const status = await rpcRaw(info, 'daemon.status').catch(() => null);
  const detail = status ? ` (profile=${status.profile}, pid=${info.pid})` : ` (pid=${info.pid})`;
  throw new Error(
    `signup bootstrap/adopt は通常 Chrome と kb が profile を奪い合わないよう、デーモン停止中だけ実行できます${detail}。` +
      '`kb daemon stop` 後に再実行してください。',
  );
}

async function launchUncontrolledBrowser(executable: string, args: string[], profile: string): Promise<number> {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    // signup は人が操作するブラウザなので、Windows でもウィンドウを隠さない。
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // Windows Chrome は既存の Chrome プロセスへ起動要求を渡し、spawn した親自身は
  // exit=0 で即終了することがある。PID 生存ではなく user-data-dir の実利用を一次情報にする。
  await delay(700);
  let profilePids: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    processSnapshot = undefined;
    profilePids = profileProcessPids(profile);
    if (profilePids.length || child.exitCode == null) break;
    await delay(300);
  }
  if (child.exitCode != null && profilePids.length === 0) {
    throw new Error(`通常ブラウザが起動直後に終了し、profile を保持するプロセスも見つかりませんでした(exit=${child.exitCode})`);
  }
  const pid = findProfileBrowserProcess(currentProcesses(), signupProfilePath(profile), process.pid) ?? profilePids[0] ?? child.pid;
  if (!pid) throw new Error('通常ブラウザの PID を取得できませんでした');
  child.unref();
  return pid;
}

function refreshBrowserPhase(state: SignupState): SignupState {
  if (state.phase === 'browser-running' && profileProcessPids(state.profile, state.bootstrapPid).length === 0) {
    const next = { ...state, phase: 'ready-to-adopt' as const };
    writeSignupState(next);
    return next;
  }
  return state;
}

function signupNextAction(state: SignupState, browserRunning: boolean): string {
  if (browserRunning) return `通常 Chrome で登録・Turnstile・OTP を完了し、ウィンドウを閉じてから kb signup adopt ${state.name}`;
  switch (state.phase) {
    case 'ready-to-adopt':
      return `kb signup adopt ${state.name}${state.checkUrl ? '' : ' --check-url <ログイン後URL>'}`;
    case 'adopting':
      return `前回の adopt が中断されました。kb daemon stop 後に kb signup adopt ${state.name} を再実行してください`;
    case 'challenge-after-adopt':
    case 'degraded-after-adopt':
      return `kb daemon stop 後、kb signup bootstrap ${state.name} ${state.url} --reuse-profile で通常 Chrome 側を確認`;
    case 'proxy-challenge':
    case 'proxy-degraded':
      return `direct への rollback は確認済みです。profile "${state.profile}" は使用可能ですが、proxy "${state.proxyBefore}" の経路・指紋を確認してください`;
    case 'failed':
      return `kb daemon stop 後、kb signup bootstrap ${state.name} ${state.url} --reuse-profile で通常 Chrome に戻して確認`;
    default:
      return `profile "${state.profile}" を kb で使用できます。必要なら kb signup checkpoint ${state.name}`;
  }
}

function statusResult(state: SignupState) {
  const browserPids = state.phase === 'browser-running' ? profileProcessPids(state.profile, state.bootstrapPid) : [];
  const browserRunning = browserPids.length > 0;
  return {
    ...state,
    browserRunning,
    browserPids,
    profilePath: signupProfilePath(state.profile),
    checkpointExists: !!state.checkpointPath && fs.existsSync(state.checkpointPath),
    nextAction: signupNextAction(state, browserRunning),
  };
}

interface AdoptionEvaluation {
  check: any;
  phase: SignupState['phase'];
  summary: ReturnType<typeof summarizeSignupCheck>;
  storageState: any;
}

async function evaluateAdoption(
  checkUrl: string,
  opts: { api?: string; timeoutMs: number; expectSelector?: string; expectCookie?: string; proxy: string },
): Promise<AdoptionEvaluation> {
  const check = await rpc('session.check', {
    url: checkUrl,
    api: opts.api,
    expectSelector: opts.expectSelector,
    timeoutMs: opts.timeoutMs,
  });
  const storageState = await rpc('storage.dump');
  const cookieNames = Array.isArray(storageState?.cookies)
    ? storageState.cookies.map((cookie: any) => cookie?.name).filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const expectations = { selector: opts.expectSelector, cookie: opts.expectCookie, cookieNames };
  return {
    check,
    phase: classifyAdoption(check, checkUrl, expectations),
    summary: summarizeSignupCheck(check, checkUrl, opts.proxy, expectations),
    storageState,
  };
}

function setProxyActive(name: string): void {
  const cfg = loadProxyConfig();
  resolveProfile(cfg, name);
  cfg.active = name;
  saveProxyConfig(cfg);
}

function configureAdoptLastRun(state: SignupState, stealth: boolean): void {
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

/** Cloudflare/Turnstile を通常 Chrome で人が通過し、その profile を kb へ引き継ぐ。 */
export function registerSignupCommands(program: Command): void {
  const signup = program
    .command('signup')
    .description('通常 Chrome でアカウント作成・bot challenge を人が完了し、同じ profile を kb へ引き継ぐ');

  signup
    .command('bootstrap <name> <url>')
    .description('Playwright/CDP を使わない通常 Chrome を専用 profile + direct 接続で起動する')
    .option('--profile <name>', 'kb profile 名(既定 signup-<name>)')
    .option('--check-url <url>', 'adopt 時にログイン済みか確認する URL(signup URL とは別の dashboard / account URL を推奨)')
    .option('--expect-selector <sel>', 'check URL のログイン済み画面にだけある visible 要素')
    .option('--expect-cookie <name>', '登録成功時に存在する Cookie 名(判定結果には値を記録・表示しない)')
    .option('--channel <channel>', '通常ブラウザ (chrome | msedge)。再開時は前回値、初回は chrome')
    .option('--browser-path <path>', '通常ブラウザ実行ファイルを明示')
    .option('--system-proxy', 'direct にせず OS の proxy 設定を使う(MITM proxy は challenge 成功率を下げ得る)')
    .option('--direct', '再開時も direct 接続へ明示的に戻す')
    .option('--reuse-profile', '既存 profile / 以前の signup 状態を再利用する')
    .action(
      run(async (rawName: string, rawUrl: string, opts: { profile?: string; checkUrl?: string; expectSelector?: string; expectCookie?: string; channel?: string; browserPath?: string; systemProxy?: boolean; direct?: boolean; reuseProfile?: boolean }) => {
        const name = validateSignupName(rawName);
        const url = normalizeSignupUrl(rawUrl);
        await requireDaemonStopped();

        const existing = readSignupState(name);
        const settings = resolveSignupBootstrapSettings(name, url, existing, {
          ...opts,
          activeProxy: loadProxyConfig().active,
        });
        const { profile, channel, checkUrl, expectSelector, expectCookie, direct, proxyBefore } = settings;

        const runningPids = profileProcessPids(profile, existing?.bootstrapPid);
        if (runningPids.length) {
          throw new Error(`signup "${name}" の通常 Chrome は既に起動中です(pid=${runningPids.join(',')})`);
        }
        const profileDir = signupProfilePath(profile);
        if (isNonEmptyDir(profileDir) && !opts.reuseProfile) {
          throw new Error(`profile "${profile}" は既に存在します。既存状態を続ける場合だけ --reuse-profile を付けてください`);
        }
        fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

        const browserPath = resolveBrowserExecutable(channel, settings.browserPathHint);
        const pid = await launchUncontrolledBrowser(browserPath, bootstrapBrowserArgs(profileDir, url, { direct }), profile);
        const now = new Date().toISOString();
        const state: SignupState = {
          ...existing,
          version: 1,
          name,
          profile,
          url,
          checkUrl,
          expectSelector,
          expectCookie,
          channel,
          browserPath,
          direct,
          proxyBefore,
          bootstrapPid: pid,
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
          phase: 'browser-running',
          error: undefined,
        };
        writeSignupState(state);
        print(statusResult(state), (r) =>
          `通常 ${channel === 'chrome' ? 'Chrome' : 'Edge'} を起動しました(pid=${pid}, profile=${profile}, ${direct ? 'direct' : 'system proxy'})\n` +
          'Playwright / CDP / remote debugging / automation フラグは使用していません。\n' +
          `登録・Turnstile・メール/SMS確認を人が完了し、ブラウザを閉じてから:\n  kb signup adopt ${name}` +
          (checkUrl ? `\n確認先: ${checkUrl}` : '\n注意: adopt には --check-url <dashboard/account URL> が必須です') +
          (expectSelector ? `\n期待 selector: ${expectSelector}` : '') +
          (expectCookie ? `\n期待 Cookie: ${expectCookie}` : ''),
        );
      }),
    );

  signup
    .command('adopt <name>')
    .description('通常 Chrome 終了後、同じ profile を kb で開き challenge/セッションを診断して checkpoint を保存する')
    .option('--check-url <url>', '診断するログイン後 URL(bootstrap 時の指定を上書き)')
    .option('--expect-selector <sel>', 'check URL のログイン済み画面にだけある visible 要素')
    .option('--expect-cookie <name>', '登録成功時に存在する Cookie 名(判定結果には値を記録・表示しない)')
    .option('--api <url>', 'session check の API 対照 URL')
    .option('--timeout <sec>', '各プローブのタイムアウト秒', intOpt, 20)
    .option('--restore-proxy', 'direct での診断成功後、bootstrap 前の proxy に戻して再診断する。劣化したら direct へ自動 rollback')
    .option('--no-stealth', 'adopt 後の kb で navigator.webdriver を隠さない(RoE 上 anti-detection 禁止の場合)')
    .option('--checkpoint <path>', 'storageState checkpoint の保存先(既定 ~/.kb/signups/<name>/storage-state.json)')
    .action(
      run(async (rawName: string, opts: { checkUrl?: string; expectSelector?: string; expectCookie?: string; api?: string; timeout: number; restoreProxy?: boolean; stealth: boolean; checkpoint?: string }) => {
        const name = validateSignupName(rawName);
        let state = readSignupState(name);
        if (!state) throw new Error(`signup "${name}" はありません。kb signup bootstrap ${name} <url> を先に実行してください`);
        state = refreshBrowserPhase(state);
        const runningPids = profileProcessPids(state.profile, state.bootstrapPid);
        if (runningPids.length) {
          throw new Error(`通常 Chrome がまだ profile を使用中です(pid=${runningPids.join(',')})。登録完了後にそのウィンドウを閉じてから adopt してください`);
        }
        await requireDaemonStopped();
        const rawCheckUrl = opts.checkUrl ?? state.checkUrl;
        if (!rawCheckUrl) {
          throw new Error('登録完了を signup ページの 200 だけで誤判定しないよう、adopt には --check-url <dashboard/account URL> が必須です');
        }
        const checkUrl = normalizeSignupUrl(rawCheckUrl);
        const expectSelector = opts.expectSelector
          ? validateExpectedSelector(opts.expectSelector)
          : state.expectSelector;
        const expectCookie = opts.expectCookie ? validateExpectedCookie(opts.expectCookie) : state.expectCookie;
        const api = opts.api ? normalizeSignupUrl(opts.api) : undefined;
        const timeoutMs = Math.max(1, opts.timeout) * 1000;

        // 引き継ぎの最初の判定は必ず direct。Caido/Burp の TLS/HTTP2 指紋を混ぜない。
        setProxyActive('direct');
        configureAdoptLastRun(state, opts.stealth);
        state = { ...state, checkUrl, expectSelector, expectCookie, phase: 'adopting', error: undefined };
        writeSignupState(state);

        try {
          const directEvaluation = await evaluateAdoption(checkUrl, {
            api,
            timeoutMs,
            expectSelector,
            expectCookie,
            proxy: 'direct',
          });
          const phase = directEvaluation.phase;
          const checkpointPath = path.resolve(opts.checkpoint ?? signupCheckpointPath(name));
          // 正常確認できた状態だけ checkpoint に昇格する。再 adopt が失敗しても
          // 以前の正常 checkpoint をチャレンジ状態で上書きしない。
          if (phase === 'adopted') writeSignupCheckpoint(checkpointPath, directEvaluation.storageState);
          state = {
            ...state,
            phase,
            adoptedAt: phase === 'adopted' ? new Date().toISOString() : state.adoptedAt,
            checkpointPath: phase === 'adopted' ? checkpointPath : state.checkpointPath,
            lastCheck: directEvaluation.summary,
            postProxyCheck: undefined,
            rollbackCheck: undefined,
          };
          writeSignupState(state);

          if (opts.restoreProxy && phase === 'adopted' && state.proxyBefore !== 'direct') {
            let postEvaluation: AdoptionEvaluation | undefined;
            let proxyError: string | undefined;
            try {
              setProxyActive(state.proxyBefore);
              await rpc('proxy.reload');
              postEvaluation = await evaluateAdoption(checkUrl, {
                api,
                timeoutMs,
                expectSelector,
                expectCookie,
                proxy: state.proxyBefore,
              });
            } catch (err) {
              proxyError = errText(err);
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
              writeSignupCheckpoint(checkpointPath, postEvaluation.storageState);
            } else {
              state = {
                ...state,
                phase: postEvaluation?.phase === 'challenge-after-adopt' ? 'proxy-challenge' : 'proxy-degraded',
                postProxyCheck: postEvaluation?.summary,
                error: proxyError ? `proxy validation: ${proxyError}` : undefined,
              };
              setProxyActive('direct');
              await rpc('proxy.reload');
              // proxy 側のチャレンジが Cookie を更新・削除していても direct の正常状態へ戻す。
              // signup 専用 profile なので全 Cookie を checkpoint へ正確に戻してよい。
              const restored = await rpc('storage.restore', { state: directEvaluation.storageState, replace: true });
              if (restored.skippedOrigins?.length) {
                throw new Error(`checkpoint rollback で localStorage を復元できませんでした: ${restored.skippedOrigins.join(', ')}`);
              }
              const rollbackEvaluation = await evaluateAdoption(checkUrl, {
                api,
                timeoutMs,
                expectSelector,
                expectCookie,
                proxy: 'direct',
              });
              state.rollbackCheck = rollbackEvaluation.summary;
              if (rollbackEvaluation.phase === 'adopted') {
                // rollback の確認通信で更新された direct 側 Cookie も checkpoint に反映する。
                writeSignupCheckpoint(checkpointPath, rollbackEvaluation.storageState);
              } else {
                state.phase = 'failed';
                state.error = [state.error, `direct rollback verification: ${rollbackEvaluation.phase}`].filter(Boolean).join('; ');
              }
            }
            writeSignupState(state);
          }

          print(statusResult(state), (r) => {
            const c = r.lastCheck;
            const p = r.postProxyCheck;
            const lines = [
              `adopt: ${r.phase} (profile=${r.profile}, stealth=${opts.stealth ? 'on' : 'off'})`,
              `direct: verdict=${c.verdict}, cookies=${c.cookieCount}${c.challenged ? `, challenge=${c.vendor ?? 'unknown'} (${c.marker ?? '-'})` : ''}`,
              `checkpoint: ${r.checkpointPath ?? '(not updated: adoption check failed)'}`,
            ];
            if (c.finalUrl && c.finalUrl !== c.url) lines.push(`direct final URL: ${c.finalUrl}`);
            if (c.expectSelector) lines.push(`selector(${c.expectSelector}): ${c.selectorMatched ? 'matched' : 'MISSING'}`);
            if (c.expectCookie) lines.push(`cookie(${c.expectCookie}): ${c.cookieMatched ? 'matched' : 'MISSING'}`);
            if (p) lines.push(`proxy(${p.proxy}): verdict=${p.verdict}${p.challenged ? `, challenge=${p.vendor ?? 'unknown'}` : ''}`);
            if (r.phase === 'proxy-challenge' || r.phase === 'proxy-degraded') lines.push('proxy 復帰で劣化したため direct へ自動で戻しました');
            else lines.push(`active proxy: ${loadProxyConfig().active}`);
            if (r.rollbackCheck) lines.push(`rollback(direct): verdict=${r.rollbackCheck.verdict}${r.rollbackCheck.challenged ? ', challenge remains' : ''}`);
            if (r.error) lines.push(`error: ${r.error}`);
            lines.push(`next: ${r.nextAction}`);
            return lines.join('\n');
          });
        } catch (err) {
          state = { ...state, phase: 'failed', error: errText(err) };
          writeSignupState(state);
          throw err;
        }
      }),
    );

  signup
    .command('status [name]', { isDefault: true })
    .description('signup bootstrap/adopt の状態を表示する(target には通信しない)')
    .action(
      run(async (rawName?: string) => {
        if (rawName) {
          const name = validateSignupName(rawName);
          const state = readSignupState(name);
          if (!state) throw new Error(`signup "${name}" はありません`);
          const result = statusResult(refreshBrowserPhase(state));
          return print(result, (r) =>
            `${r.name}: ${r.phase} (profile=${r.profile}, browser=${r.browserRunning ? `running pid=${r.browserPids.join(',')}` : 'closed'}, proxy-before=${r.proxyBefore})\n` +
            `signup: ${r.url}${r.checkUrl ? `\ncheck: ${r.checkUrl}` : ''}` +
            `${r.expectSelector ? `\nexpect-selector: ${r.expectSelector}` : ''}${r.expectCookie ? `\nexpect-cookie: ${r.expectCookie}` : ''}` +
            `${r.error ? `\nerror: ${r.error}` : ''}\n` +
            `next: ${r.nextAction}`,
          );
        }
        const list = listSignupStates().map(refreshBrowserPhase).map(statusResult);
        print(list, (items: ReturnType<typeof statusResult>[]) =>
          items.length
            ? items.map((r) => `${r.name.padEnd(20)} ${r.phase.padEnd(23)} profile=${r.profile}${r.browserRunning ? ` pid=${r.browserPids.join(',')}` : ''}`).join('\n')
            : 'signup bootstrap の状態はありません',
        );
      }),
    );

  signup
    .command('checkpoint <name>')
    .description('adopt 済み profile を再診断し、正常な Cookie + localStorage だけを checkpoint として保存する')
    .option('-o, --out <path>', '保存先')
    .option('--api <url>', 'session check の API 対照 URL')
    .option('--timeout <sec>', '各プローブのタイムアウト秒', intOpt, 20)
    .action(
      run(async (rawName: string, opts: { out?: string; api?: string; timeout: number }) => {
        const name = validateSignupName(rawName);
        let state = readSignupState(name);
        if (!state) throw new Error(`signup "${name}" はありません`);
        if (!state.checkUrl) throw new Error(`signup "${name}" には check URL がありません。adopt --check-url <dashboard/account URL> を先に実行してください`);
        const info = await pingDaemon();
        if (!info) throw new Error(`デーモンが起動していません。profile "${state.profile}" で adopt してから実行してください`);
        const status = await rpcRaw(info, 'daemon.status');
        if (status.profile !== state.profile) {
          throw new Error(`現在の profile は "${status.profile}" です。signup "${name}" の "${state.profile}" ではありません`);
        }
        const proxy = loadProxyConfig().active;
        const evaluation = await evaluateAdoption(state.checkUrl, {
          api: opts.api ? normalizeSignupUrl(opts.api) : undefined,
          timeoutMs: Math.max(1, opts.timeout) * 1000,
          expectSelector: state.expectSelector,
          expectCookie: state.expectCookie,
          proxy,
        });
        if (evaluation.phase !== 'adopted') {
          state = {
            ...state,
            phase:
              proxy === 'direct'
                ? evaluation.phase
                : evaluation.phase === 'challenge-after-adopt'
                  ? 'proxy-challenge'
                  : 'proxy-degraded',
            ...(proxy === 'direct' ? { lastCheck: evaluation.summary } : { postProxyCheck: evaluation.summary }),
            error: `checkpoint verification: ${evaluation.phase}`,
          };
          writeSignupState(state);
          throw new Error(`checkpoint は更新しません: ${evaluation.phase} (既存の正常 checkpoint は保持しました)`);
        }
        const out = path.resolve(opts.out ?? state.checkpointPath ?? signupCheckpointPath(name));
        writeSignupCheckpoint(out, evaluation.storageState);
        state = {
          ...state,
          checkpointPath: out,
          adoptedAt: new Date().toISOString(),
          phase: proxy === 'direct' ? 'adopted' : 'adopted-proxy',
          ...(proxy === 'direct' ? { lastCheck: evaluation.summary } : { postProxyCheck: evaluation.summary }),
          error: undefined,
        };
        writeSignupState(state);
        print(
          { name, profile: state.profile, proxy, checkpointPath: out, check: evaluation.summary },
          (r) => `${r.checkpointPath} (profile=${r.profile}, proxy=${r.proxy}, verification=ok)`,
        );
      }),
    );
}
