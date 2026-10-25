import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignupCheckSummary, SignupState } from '../../shared/signup';
import {
  AdoptionWorkflowError,
  runAdoptionWorkflow,
  type AdoptionEvaluation,
  type AdoptionWorkflowDependencies,
} from './workflow';

const CHECK_URL = 'https://example.com/account';
const CHECKPOINT = '/tmp/signup-checkpoint.json';

function state(proxyBefore = 'inspection'): SignupState {
  return {
    version: 1,
    name: 'target',
    profile: 'signup-target',
    url: 'https://example.com/signup',
    checkUrl: CHECK_URL,
    channel: 'chrome',
    browserPath: '/browser/chrome',
    direct: true,
    proxyBefore,
    bootstrapPid: 123,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'adopting',
  };
}

function summary(proxy: string, challenged = false): SignupCheckSummary {
  return {
    at: '2026-01-02T00:00:00.000Z',
    url: CHECK_URL,
    proxy,
    verdict: challenged ? 'degraded' : 'ok',
    cookieCount: 1,
    challenged,
  };
}

function evaluation(
  phase: AdoptionEvaluation['phase'],
  proxy: string,
  storageState: unknown,
): AdoptionEvaluation {
  const challenged = phase === 'challenge-after-adopt';
  return {
    check: { verdict: challenged ? 'degraded' : 'ok', cookieCount: 1 },
    phase,
    summary: summary(proxy, challenged),
    storageState,
  };
}

function harness(results: Array<AdoptionEvaluation | Error>) {
  const calls = {
    evaluations: [] as string[],
    proxies: [] as string[],
    reloads: 0,
    restores: [] as unknown[],
    checkpoints: [] as Array<{ file: string; state: unknown }>,
    states: [] as SignupState[],
  };
  const deps: AdoptionWorkflowDependencies = {
    evaluate: async (_url, opts) => {
      calls.evaluations.push(opts.proxy);
      const next = results.shift();
      if (!next) throw new Error('unexpected evaluation');
      if (next instanceof Error) throw next;
      return next;
    },
    activateProxy: (name) => calls.proxies.push(name),
    reloadProxy: async () => {
      calls.reloads++;
    },
    restoreStorage: async (storageState) => {
      calls.restores.push(storageState);
      return {};
    },
    saveCheckpoint: (file, storageState) => calls.checkpoints.push({ file, state: storageState }),
    saveState: (next) => calls.states.push({ ...next }),
    now: () => '2026-01-03T00:00:00.000Z',
  };
  return { calls, deps };
}

const options = {
  checkUrl: CHECK_URL,
  timeoutMs: 5_000,
  checkpointPath: CHECKPOINT,
  restoreProxy: true,
};

test('adopt workflow: direct 成功時だけ checkpoint を昇格する', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const { calls, deps } = harness([evaluation('adopted', 'direct', directStorage)]);
  const result = await runAdoptionWorkflow(state('direct'), options, deps);

  assert.equal(result.phase, 'adopted');
  assert.equal(result.adoptedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(result.checkpointPath, CHECKPOINT);
  assert.deepEqual(calls.evaluations, ['direct']);
  assert.deepEqual(calls.checkpoints, [{ file: CHECKPOINT, state: directStorage }]);
  assert.deepEqual(calls.proxies, []);
  assert.equal(calls.states.length, 1);
});

test('adopt workflow: direct 不合格では既存 checkpoint を上書きせず proxy にも戻さない', async () => {
  const initial = { ...state(), checkpointPath: '/previous/good.json' };
  const { calls, deps } = harness([
    evaluation('degraded-after-adopt', 'direct', { cookies: [] }),
  ]);
  const result = await runAdoptionWorkflow(initial, options, deps);

  assert.equal(result.phase, 'degraded-after-adopt');
  assert.equal(result.checkpointPath, '/previous/good.json');
  assert.deepEqual(calls.checkpoints, []);
  assert.deepEqual(calls.proxies, []);
});

test('adopt workflow: proxy でも正常なら proxy 側の最新状態を checkpoint にする', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const proxyStorage = { cookies: [{ name: 'sid', value: 'proxy' }] };
  const { calls, deps } = harness([
    evaluation('adopted', 'direct', directStorage),
    evaluation('adopted', 'inspection', proxyStorage),
  ]);
  const result = await runAdoptionWorkflow(state(), options, deps);

  assert.equal(result.phase, 'adopted-proxy');
  assert.equal(result.postProxyCheck?.proxy, 'inspection');
  assert.deepEqual(calls.evaluations, ['direct', 'inspection']);
  assert.deepEqual(calls.proxies, ['inspection']);
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.checkpoints.at(-1), { file: CHECKPOINT, state: proxyStorage });
  assert.deepEqual(calls.restores, []);
});

test('adopt workflow: proxy challenge は direct checkpoint へ rollback して再検証する', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const proxyStorage = { cookies: [{ name: 'sid', value: 'challenged' }] };
  const restoredStorage = { cookies: [{ name: 'sid', value: 'restored' }] };
  const { calls, deps } = harness([
    evaluation('adopted', 'direct', directStorage),
    evaluation('challenge-after-adopt', 'inspection', proxyStorage),
    evaluation('adopted', 'direct', restoredStorage),
  ]);
  const result = await runAdoptionWorkflow(state(), options, deps);

  assert.equal(result.phase, 'proxy-challenge');
  assert.equal(result.postProxyCheck?.challenged, true);
  assert.equal(result.rollbackCheck?.verdict, 'ok');
  assert.deepEqual(calls.evaluations, ['direct', 'inspection', 'direct']);
  assert.deepEqual(calls.proxies, ['inspection', 'direct']);
  assert.equal(calls.reloads, 2);
  assert.deepEqual(calls.restores, [directStorage]);
  assert.deepEqual(calls.checkpoints.at(-1), { file: CHECKPOINT, state: restoredStorage });
});

test('adopt workflow: proxy 例外後の direct 再検証も失敗したら failed にする', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const { calls, deps } = harness([
    evaluation('adopted', 'direct', directStorage),
    new Error('proxy refused\nsecret detail'),
    evaluation('degraded-after-adopt', 'direct', { cookies: [] }),
  ]);
  const result = await runAdoptionWorkflow(state(), options, deps);

  assert.equal(result.phase, 'failed');
  assert.equal(
    result.error,
    'proxy validation: proxy refused; direct rollback verification: degraded-after-adopt',
  );
  assert.deepEqual(calls.proxies, ['inspection', 'direct']);
  assert.deepEqual(calls.restores, [directStorage]);
  assert.equal(calls.states.length, 2);
});

test('adopt workflow: rollback 途中の例外にも直前の proxy 診断状態を保持する', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const { deps } = harness([
    evaluation('adopted', 'direct', directStorage),
    evaluation('challenge-after-adopt', 'inspection', { cookies: [] }),
  ]);
  deps.restoreStorage = async () => ({ skippedOrigins: ['https://example.com'] });

  await assert.rejects(
    () => runAdoptionWorkflow(state(), options, deps),
    (err: unknown) => {
      assert.ok(err instanceof AdoptionWorkflowError);
      assert.equal(err.state.phase, 'proxy-challenge');
      assert.equal(err.state.postProxyCheck?.challenged, true);
      assert.match(err.message, /localStorage を復元できません/);
      return true;
    },
  );
});

test('adopt workflow: rollback checkpoint 書込失敗時も再検証結果を保持する', async () => {
  const directStorage = { cookies: [{ name: 'sid', value: 'direct' }] };
  const { deps } = harness([
    evaluation('adopted', 'direct', directStorage),
    evaluation('challenge-after-adopt', 'inspection', { cookies: [] }),
    evaluation('adopted', 'direct', { cookies: [{ name: 'sid', value: 'restored' }] }),
  ]);
  let writes = 0;
  deps.saveCheckpoint = () => {
    if (++writes === 2) throw new Error('checkpoint disk full');
  };

  await assert.rejects(
    () => runAdoptionWorkflow(state(), options, deps),
    (err: unknown) => {
      assert.ok(err instanceof AdoptionWorkflowError);
      assert.equal(err.state.phase, 'proxy-challenge');
      assert.equal(err.state.rollbackCheck?.verdict, 'ok');
      assert.equal(err.message, 'checkpoint disk full');
      return true;
    },
  );
});
