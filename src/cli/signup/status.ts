import fs from 'node:fs';
import {
  signupProfilePath,
  writeSignupState,
  type SignupState,
} from '../../shared/signup';
import { signupProfileProcessPids } from './browser';

/** 通常ブラウザの終了を永続状態へ反映する。target への通信は行わない。 */
export function refreshSignupBrowserPhase(state: SignupState): SignupState {
  if (
    state.phase === 'browser-running' &&
    signupProfileProcessPids(state.profile, state.bootstrapPid).length === 0
  ) {
    const next = { ...state, phase: 'ready-to-adopt' as const };
    writeSignupState(next);
    return next;
  }
  return state;
}

function nextSignupAction(state: SignupState, browserRunning: boolean): string {
  if (browserRunning) {
    return `通常 Chrome で登録・Turnstile・OTP を完了し、ウィンドウを閉じてから kb signup adopt ${state.name}`;
  }
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

/** JSON / 人間向け表示の双方が使う signup status DTO。 */
export function signupStatusResult(state: SignupState) {
  const browserPids =
    state.phase === 'browser-running'
      ? signupProfileProcessPids(state.profile, state.bootstrapPid)
      : [];
  const browserRunning = browserPids.length > 0;
  return {
    ...state,
    browserRunning,
    browserPids,
    profilePath: signupProfilePath(state.profile),
    checkpointExists: !!state.checkpointPath && fs.existsSync(state.checkpointPath),
    nextAction: nextSignupAction(state, browserRunning),
  };
}

export type SignupStatusResult = ReturnType<typeof signupStatusResult>;
