import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { browserHttpRequest, methodAfterRedirect, type RecordedExchange } from './httpClient';

test('methodAfterRedirect: 303 See Other は常に GET 化してボディを落とす', () => {
  assert.deepEqual(methodAfterRedirect(303, 'POST'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(303, 'GET'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(303, 'PUT'), { method: 'GET', dropBody: true });
});

test('methodAfterRedirect: 301/302 は POST を GET 化(ブラウザ準拠)', () => {
  assert.deepEqual(methodAfterRedirect(301, 'POST'), { method: 'GET', dropBody: true });
  assert.deepEqual(methodAfterRedirect(302, 'POST'), { method: 'GET', dropBody: true });
});

test('methodAfterRedirect: 301/302 でも GET/HEAD はそのまま維持', () => {
  assert.deepEqual(methodAfterRedirect(301, 'GET'), { method: 'GET', dropBody: false });
  assert.deepEqual(methodAfterRedirect(302, 'HEAD'), { method: 'HEAD', dropBody: false });
});

test('methodAfterRedirect: 307/308 はメソッドとボディを維持', () => {
  assert.deepEqual(methodAfterRedirect(307, 'POST'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(308, 'POST'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(307, 'PUT'), { method: 'PUT', dropBody: false });
});

test('methodAfterRedirect: メソッドは大文字に正規化される', () => {
  assert.deepEqual(methodAfterRedirect(307, 'post'), { method: 'POST', dropBody: false });
  assert.deepEqual(methodAfterRedirect(301, 'get'), { method: 'GET', dropBody: false });
});

function fakePage(
  currentUrl: string,
  response: {
    status?: number;
    statusText?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): { page: Page; calls: unknown[] } {
  const calls: unknown[] = [];
  const page = {
    url: () => currentUrl,
    evaluate: async (_fn: unknown, args: unknown) => {
      calls.push(args);
      return {
        status: response.status ?? 200,
        statusText: response.statusText ?? 'OK',
        url: response.url ?? 'https://example.com/api',
        headers: response.headers ?? { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(response.body ?? '{"ok":true}').toString('base64'),
      };
    },
  } as unknown as Page;
  return { page, calls };
}

test('browserHttpRequest: 同一 origin の page fetch 引数と HttpResult / journal を揃える', async () => {
  const { page, calls } = fakePage('https://example.com/account');
  const exchanges: RecordedExchange[] = [];
  const result = await browserHttpRequest(
    page,
    {
      url: 'https://example.com/api',
      method: 'post',
      data: '{"hello":"kb"}',
      headers: { 'x-test': 'yes' },
      timeoutMs: 1234,
    },
    (exchange) => exchanges.push(exchange),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: 'https://example.com/api',
    requestMethod: 'POST',
    headers: { 'x-test': 'yes', 'content-type': 'application/json' },
    data: '{"hello":"kb"}',
    timeoutMs: 1234,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(result.bytes, 11);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].method, 'POST');
  assert.equal(exchanges[0].postData, '{"hello":"kb"}');
});

test('browserHttpRequest: active tab と異なる origin は送信前に拒否する', async () => {
  const { page, calls } = fakePage('https://example.com/account');
  await assert.rejects(
    () => browserHttpRequest(page, { url: 'https://api.example.net/private' }),
    /同一 origin/,
  );
  assert.equal(calls.length, 0);
});

test('browserHttpRequest: Cookie / User-Agent 等の browser-managed header は拒否する', async () => {
  const { page, calls } = fakePage('https://example.com/account');
  await assert.rejects(
    () =>
      browserHttpRequest(page, {
        url: 'https://example.com/api',
        headers: { Cookie: 'sid=secret', 'X-Test': 'ok' },
      }),
    /ブラウザ管理ヘッダ.*Cookie/,
  );
  await assert.rejects(
    () =>
      browserHttpRequest(page, {
        url: 'https://example.com/api',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Proxy-Authorization': 'secret' },
      }),
    /Sec-Fetch-Site.*Proxy-Authorization/,
  );
  assert.equal(calls.length, 0);
});

test('browserHttpRequest: Set-Cookie は defensive に結果と journal から除く', async () => {
  const { page } = fakePage('https://example.com/account', {
    headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=secret' },
    body: 'ok',
  });
  const exchanges: RecordedExchange[] = [];
  const result = await browserHttpRequest(page, { url: 'https://example.com/api' }, (exchange) =>
    exchanges.push(exchange),
  );
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.setCookies, undefined);
  assert.equal(exchanges[0].responseHeaders['set-cookie'], undefined);
});

test('browserHttpRequest: redirect 観測 option と GET body は明示的に拒否する', async () => {
  const { page } = fakePage('https://example.com/account');
  await assert.rejects(
    () => browserHttpRequest(page, { url: 'https://example.com/api', follow: false }),
    /--no-follow/,
  );
  await assert.rejects(
    () => browserHttpRequest(page, { url: 'https://example.com/api', verbose: true }),
    /--follow-verbose/,
  );
  await assert.rejects(
    () => browserHttpRequest(page, { url: 'https://example.com/api', data: 'body' }),
    /GET.*request body/,
  );
});
