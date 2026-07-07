import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASK,
  maskBody,
  redactEvent,
  reportMarkdown,
  requestFiles,
  stepsMarkdown,
  summarizeArgs,
  toCliString,
  toCurlCommand,
  type CommandEvent,
  type NetEvent,
  type OpEvent,
} from './oplog';

const M = { mask: true };
const NO_M = { mask: false };

function cmdEvent(cmd: string, args: Record<string, unknown>, extra: Partial<CommandEvent> = {}): CommandEvent {
  return { seq: 1, ts: '2026-07-07T00:00:00.000Z', type: 'command', cmd, args, ok: true, durationMs: 10, ...extra };
}

function netEvent(extra: Partial<NetEvent> = {}): NetEvent {
  return {
    seq: 2,
    ts: '2026-07-07T00:00:01.000Z',
    type: 'net',
    method: 'POST',
    url: 'https://api.example.com/v1/login',
    status: 200,
    resourceType: 'xhr',
    tab: 1,
    ...extra,
  };
}

test('redactEvent: fill の入力値は既定でマスク、--no-mask で残る', () => {
  const e = cmdEvent('fill', { selector: '#pw', value: 'hunter2' });
  assert.equal((redactEvent(e, M) as CommandEvent).args.value, MASK);
  assert.equal((redactEvent(e, NO_M) as CommandEvent).args.value, 'hunter2');
  assert.equal((e.args as any).value, 'hunter2'); // 元イベントは無改変
});

test('redactEvent: eval の戻り値は既定でマスク、式は残る', () => {
  const e = cmdEvent('eval', { expression: 'document.title' }, { result: '"secret page"' });
  const r = redactEvent(e, M) as CommandEvent;
  assert.equal(r.result, MASK);
  assert.equal(r.args.expression, 'document.title');
});

test('redactEvent: request の結果要約もヘッダ・本文がマスクされる', () => {
  const result = JSON.stringify({
    status: 200,
    headers: { 'set-cookie': 'sid=abc', 'content-type': 'application/json' },
    body: '{"token":"tok123","data":"ok"}',
  });
  const e = cmdEvent('request', { url: 'https://a/b' }, { result });
  const r = JSON.parse((redactEvent(e, M) as CommandEvent).result!);
  assert.equal(r.headers['set-cookie'], MASK);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body).token, MASK);
  assert.equal(JSON.parse(r.body).data, 'ok');
});

test('redactEvent: request の結果要約が解析不能(切り詰め)なら全体マスク', () => {
  const e = cmdEvent('request', { url: 'https://a/b' }, { result: '{"status":200,"body":"{\\"tok…(全 511 文字)' });
  assert.equal((redactEvent(e, M) as CommandEvent).result, MASK);
});

test('redactEvent: 機微ヘッダのみマスクされ、他ヘッダは残る', () => {
  const e = netEvent({ requestHeaders: { authorization: 'Bearer xyz', accept: 'application/json', cookie: 'sid=1' } });
  const r = redactEvent(e, M) as NetEvent;
  assert.equal(r.requestHeaders!.authorization, MASK);
  assert.equal(r.requestHeaders!.cookie, MASK);
  assert.equal(r.requestHeaders!.accept, 'application/json');
});

test('redactEvent: allow で名前指定したものはマスクされない', () => {
  const e = netEvent({ requestHeaders: { authorization: 'Bearer xyz', cookie: 'sid=1' } });
  const r = redactEvent(e, { mask: true, allow: /^cookie$/i }) as NetEvent;
  assert.equal(r.requestHeaders!.cookie, 'sid=1');
  assert.equal(r.requestHeaders!.authorization, MASK);
});

test('redactEvent: deny は --no-mask でも適用される', () => {
  const e = cmdEvent('open', { url: 'https://internal.corp.example/secret' });
  const r = redactEvent(e, { mask: false, deny: /internal\.corp/ }) as CommandEvent;
  assert.equal(r.args.url, MASK);
});

test('maskBody: JSON は機微キーの値だけマスクし再現性を保つ', () => {
  const body = JSON.stringify({ user: 'alice', password: 'p@ss', nested: { apiKey: 'k', keep: 'x' } });
  const masked = JSON.parse(maskBody(body, M));
  assert.equal(masked.user, 'alice');
  assert.equal(masked.password, MASK);
  assert.equal(masked.nested.apiKey, MASK);
  assert.equal(masked.nested.keep, 'x');
});

test('maskBody: form-urlencoded は機微キーのペアだけマスク', () => {
  const masked = maskBody('user=alice&password=p%40ss&keep=1', M);
  assert.equal(masked, `user=alice&password=${MASK}&keep=1`);
});

test('summarizeArgs: storage.restore の state は件数に置き換わる', () => {
  const out = summarizeArgs('storage.restore', { state: { cookies: [1, 2], origins: [] } });
  assert.deepEqual(out.state, { cookies: 2, origins: 0 });
});

test('toCliString: 主要コマンドが再現可能な形になる', () => {
  assert.equal(toCliString(cmdEvent('open', { url: 'https://example.com', waitUntil: 'networkidle' })), "kb open https://example.com --wait idle");
  assert.equal(toCliString(cmdEvent('click', { ref: 'e12' })), 'kb click --ref e12');
  assert.equal(toCliString(cmdEvent('fill', { selector: '#q', value: 'hello world' })), "kb fill #q 'hello world'");
  assert.equal(toCliString(cmdEvent('request', { url: 'https://a/b', method: 'POST', data: '{"a":1}' })), `kb request https://a/b -X POST -d '{"a":1}'`);
});

test('toCurlCommand: ノイズヘッダを除き、ボディとカスタムヘッダを含む', () => {
  const e = netEvent({
    requestHeaders: { 'content-type': 'application/json', host: 'api.example.com', 'sec-fetch-mode': 'cors', 'x-api-version': '2' },
    postData: '{"a":1}',
  });
  const curl = toCurlCommand(e);
  assert.match(curl, /curl -sS -X POST/);
  assert.match(curl, /content-type: application\/json/);
  assert.match(curl, /x-api-version: 2/);
  assert.match(curl, /--data '\{"a":1\}'/);
  assert.doesNotMatch(curl, /host:/);
  assert.doesNotMatch(curl, /sec-fetch/);
});

test('requestFiles: net イベントと kb request コマンドから .sh が生成される', () => {
  const files = requestFiles([
    netEvent(),
    cmdEvent('open', { url: 'x' }),
    cmdEvent('request', { url: 'https://a.example/api', method: 'put', headers: { 'x-k': 'v' }, data: '{"a":1}' }, { seq: 9 }),
  ]);
  assert.equal(files.length, 2);
  assert.match(files[0].name, /^0002-POST-api\.example\.com_v1_login\.sh$/);
  assert.match(files[0].content, /^#!\/bin\/sh/);
  assert.match(files[1].name, /^0009-PUT-a\.example_api\.sh$/);
  assert.match(files[1].content, /-H 'x-k: v'/);
  assert.match(files[1].content, /--data '\{"a":1\}'/);
});

test('reportMarkdown / stepsMarkdown: コマンドがステップ化され通信がぶら下がる', () => {
  const events: OpEvent[] = [
    cmdEvent('open', { url: 'https://example.com' }, { seq: 1, result: '{"tab":1}' }),
    netEvent({ seq: 2 }),
    { seq: 3, ts: '2026-07-07T00:00:02.000Z', type: 'console', kind: 'log', text: 'loaded', tab: 1 },
    cmdEvent('click', { ref: 'e5' }, { seq: 4 }),
  ];
  const meta = { name: 'test-session', startedAt: '2026-07-07T00:00:00Z' };
  const report = reportMarkdown(events, meta);
  assert.match(report, /### Step 1 — `kb open https:\/\/example\.com`/);
  assert.match(report, /通信: `POST https:\/\/api\.example\.com\/v1\/login` → 200/);
  assert.match(report, /コンソール \[log\]: loaded/);
  assert.match(report, /### Step 2 — `kb click --ref e5`/);
  const steps = stepsMarkdown(events, meta);
  assert.match(steps, /1\. `kb open https:\/\/example\.com`/);
  assert.match(steps, /2\. `kb click --ref e5`/);
});
