import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASK,
  maskBody,
  maskUrl,
  maskUrlsInText,
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

test('maskUrl: クエリの機微キーだけマスクされ、他は保持', () => {
  const masked = maskUrl('https://api.example.com/v1/data?user=alice&api_key=sk123&page=2', M);
  const u = new URL(masked);
  assert.equal(u.searchParams.get('api_key'), MASK);
  assert.equal(u.searchParams.get('user'), 'alice');
  assert.equal(u.searchParams.get('page'), '2');
});

test('maskUrl: --no-mask では deny 指定分だけマスク', () => {
  const url = 'https://a/b?token=t1&keep=1';
  assert.equal(maskUrl(url, NO_M), url);
  const denied = maskUrl('https://a/b?foo=SECRETVAL&keep=1', { mask: false, deny: /SECRETVAL/ });
  assert.equal(new URL(denied).searchParams.get('foo'), MASK);
});

test('maskUrlsInText: 本文・ヘッダ内の URL のクエリ値もマスクされる', () => {
  const text = 'redirect to https://app.example.com/cb?code=abc&session_token=xyz please';
  const masked = maskUrlsInText(text, M);
  assert.match(masked, /session_token=%C2%ABmasked%C2%BB|session_token=«masked»/);
  assert.match(masked, /code=abc/);
});

test('redactEvent: net.url と open の args.url のクエリ値がマスクされる', () => {
  const n = redactEvent(netEvent({ url: 'https://a/b?apikey=k1&q=1' }), M) as NetEvent;
  assert.match(n.url, /apikey=/);
  assert.doesNotMatch(n.url, /k1/);
  const c = redactEvent(cmdEvent('open', { url: 'https://a/b?password=p1' }), M) as CommandEvent;
  assert.doesNotMatch(String(c.args.url), /p1/);
});

test('maskUrl: 入れ子 URL(リダイレクト先)の内側クエリも再帰マスクされる', () => {
  const inner = 'https://x.example/cb?token=tok123&keep=1';
  const url = `https://a.example/login?next=${encodeURIComponent(inner)}&page=2`;
  const masked = maskUrl(url, M);
  assert.doesNotMatch(masked, /tok123/);
  assert.match(masked, /keep%3D1|keep=1/); // 内側の非機微キーは保持
  assert.match(masked, /page=2/);
  const innerMasked = new URL(new URL(masked).searchParams.get('next')!);
  assert.equal(innerMasked.searchParams.get('token'), MASK);
});

test('redactEvent: open の結果 payload の url もマスクされる', () => {
  const e = cmdEvent(
    'open',
    { url: 'https://a/b?apikey=k1' },
    { result: JSON.stringify({ tab: 1, url: 'https://a/b?apikey=k1', title: 't' }) },
  );
  const r = redactEvent(e, M) as CommandEvent;
  assert.doesNotMatch(r.result!, /k1/);
  assert.match(r.result!, /"title":"t"/);
});

test('toCliString: net.unroute --all が正しく整形される', () => {
  assert.equal(toCliString(cmdEvent('net.unroute', { all: true })), 'kb net unroute --all');
  assert.equal(toCliString(cmdEvent('net.unroute', { id: 3 })), 'kb net unroute 3');
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

test('toCurlCommand: Content-Type 未記録の JSON ボディは application/json を補完', () => {
  const curl = toCurlCommand(netEvent({ requestHeaders: {}, postData: '{"a":1}' }));
  assert.match(curl, /-H 'content-type: application\/json'/);
  const withCt = toCurlCommand(netEvent({ requestHeaders: { 'content-type': 'text/plain' }, postData: '{"a":1}' }));
  assert.doesNotMatch(withCt, /application\/json/);
});

test('toCliString: select は --label が値の前に出る', () => {
  assert.equal(
    toCliString(cmdEvent('select', { selector: '#dropdown', values: ['Option 2'], byLabel: true })),
    "kb select #dropdown --label 'Option 2'",
  );
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
