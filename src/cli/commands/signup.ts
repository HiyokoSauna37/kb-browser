import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { pingDaemon, rpcRaw } from '../../shared/client';
import { loadProxyConfig } from '../../shared/proxyStore';
import {
  bootstrapBrowserArgs,
  listSignupStates,
  normalizeSignupUrl,
  readSignupState,
  resolveBrowserExecutable,
  resolveSignupBootstrapSettings,
  signupCheckpointPath,
  signupProfilePath,
  validateExpectedCookie,
  validateExpectedSelector,
  validateSignupName,
  writeSignupCheckpoint,
  writeSignupState,
  type SignupState,
} from '../../shared/signup';
import { intOpt, print, run } from '../output';
import {
  launchSignupBrowser,
  requireSignupDaemonStopped,
  signupProfileProcessPids,
} from '../signup/browser';
import {
  refreshSignupBrowserPhase,
  signupStatusResult,
} from '../signup/status';
import {
  AdoptionWorkflowError,
  configureAdoptLastRun,
  evaluateAdoption,
  runAdoptionWorkflow,
  setSignupProxyActive,
} from '../signup/workflow';

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 500);
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
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
        await requireSignupDaemonStopped();

        const existing = readSignupState(name);
        const settings = resolveSignupBootstrapSettings(name, url, existing, {
          ...opts,
          activeProxy: loadProxyConfig().active,
        });
        const { profile, channel, checkUrl, expectSelector, expectCookie, direct, proxyBefore } = settings;

        const runningPids = signupProfileProcessPids(profile, existing?.bootstrapPid);
        if (runningPids.length) {
          throw new Error(`signup "${name}" の通常 Chrome は既に起動中です(pid=${runningPids.join(',')})`);
        }
        const profileDir = signupProfilePath(profile);
        if (isNonEmptyDir(profileDir) && !opts.reuseProfile) {
          throw new Error(`profile "${profile}" は既に存在します。既存状態を続ける場合だけ --reuse-profile を付けてください`);
        }
        fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

        const browserPath = resolveBrowserExecutable(channel, settings.browserPathHint);
        const pid = await launchSignupBrowser(browserPath, bootstrapBrowserArgs(profileDir, url, { direct }), profile);
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
        print(signupStatusResult(state), (r) =>
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
        state = refreshSignupBrowserPhase(state);
        const runningPids = signupProfileProcessPids(state.profile, state.bootstrapPid);
        if (runningPids.length) {
          throw new Error(`通常 Chrome がまだ profile を使用中です(pid=${runningPids.join(',')})。登録完了後にそのウィンドウを閉じてから adopt してください`);
        }
        await requireSignupDaemonStopped();
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
        setSignupProxyActive('direct');
        configureAdoptLastRun(state, opts.stealth);
        state = { ...state, checkUrl, expectSelector, expectCookie, phase: 'adopting', error: undefined };
        writeSignupState(state);

        try {
          state = await runAdoptionWorkflow(state, {
            checkUrl,
            api,
            timeoutMs,
            expectSelector,
            expectCookie,
            checkpointPath: path.resolve(opts.checkpoint ?? signupCheckpointPath(name)),
            restoreProxy: !!opts.restoreProxy,
          });
          print(signupStatusResult(state), (r) => {
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
          const failedState = err instanceof AdoptionWorkflowError ? err.state : state;
          state = { ...failedState, phase: 'failed', error: errorText(err) };
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
          const result = signupStatusResult(refreshSignupBrowserPhase(state));
          return print(result, (r) =>
            `${r.name}: ${r.phase} (profile=${r.profile}, browser=${r.browserRunning ? `running pid=${r.browserPids.join(',')}` : 'closed'}, proxy-before=${r.proxyBefore})\n` +
            `signup: ${r.url}${r.checkUrl ? `\ncheck: ${r.checkUrl}` : ''}` +
            `${r.expectSelector ? `\nexpect-selector: ${r.expectSelector}` : ''}${r.expectCookie ? `\nexpect-cookie: ${r.expectCookie}` : ''}` +
            `${r.error ? `\nerror: ${r.error}` : ''}\n` +
            `next: ${r.nextAction}`,
          );
        }
        const list = listSignupStates().map(refreshSignupBrowserPhase).map(signupStatusResult);
        print(list, (items: ReturnType<typeof signupStatusResult>[]) =>
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
