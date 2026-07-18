import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIRequestContext } from 'playwright';
import { translateSegments, clearTranslateMemo, retryConfig } from './translate';

/** gtx エンドポイントを模す偽 APIRequestContext。q の各行を訳す(既定: 大文字化)。 */
function fakeGtx(opts: { breakLines?: boolean; failFirst?: number } = {}): { request: APIRequestContext; calls: string[] } {
  const calls: string[] = [];
  let failRemaining = opts.failFirst ?? 0;
  const request = {
    async get(url: string) {
      const q = new URL(url).searchParams.get('q') ?? '';
      calls.push(q);
      if (failRemaining > 0) {
        failRemaining--;
        return { ok: () => false, status: () => 429, json: async () => null };
      }
      const lines = q.split('\n').map((l) => l.toUpperCase());
      // breakLines: 訳で改行境界が保たれなかったケース(行が潰れる)を再現する
      const text = opts.breakLines ? lines.join(' ') : lines.join('\n');
      return { ok: () => true, status: () => 200, json: async () => [[[text, q]], null, 'en'] };
    },
  };
  return { request: request as unknown as APIRequestContext, calls };
}

test('translateSegments: 小セグメントは 1 リクエストにまとまり 1:1 で戻る', async () => {
  clearTranslateMemo();
  const { request, calls } = fakeGtx();
  const r = await translateSegments(request, ['hello', ' ', 'world'], { to: 'ja' });
  assert.equal(r.requests, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(r.translations, ['HELLO', '', 'WORLD']);
  assert.equal(r.detected, 'en');
  assert.equal(r.truncated, false);
});

test('translateSegments: 一度訳した文はメモが効きネットワークを叩き直さない', async () => {
  clearTranslateMemo();
  const { request, calls } = fakeGtx();
  await translateSegments(request, ['alpha', 'beta'], { to: 'ja' });
  const r2 = await translateSegments(request, ['beta', 'alpha', 'gamma'], { to: 'ja' });
  assert.deepEqual(r2.translations, ['BETA', 'ALPHA', 'GAMMA']);
  assert.equal(r2.requests, 1); // 未訳の gamma のみ
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'gamma');
  assert.equal(r2.detected, 'en'); // メモ経由でも検出言語が伝わる
});

test('translateSegments: 行数が崩れたバッチは 1 セグメントずつ翻訳し直す', async () => {
  clearTranslateMemo();
  const { request, calls } = fakeGtx({ breakLines: true });
  const r = await translateSegments(request, ['one', 'two'], { to: 'ja' });
  assert.equal(r.requests, 3); // バッチ 1 + セグメント単位のやり直し 2
  assert.equal(calls.length, 3);
  assert.deepEqual(r.translations, ['ONE', 'TWO']);
});

test('translateSegments: 予算超過の長文セグメントは分割して連結される', async () => {
  clearTranslateMemo();
  const { request } = fakeGtx();
  const long = new Array(400).fill('word').join(' '); // 1999 文字 > 1500
  const r = await translateSegments(request, [long], { to: 'ja' });
  assert.ok(r.requests >= 2);
  assert.equal(r.translations[0], long.toUpperCase());
});

test('translateSegments: maxRequests 到達で truncated=true・残りは未翻訳のまま', async () => {
  clearTranslateMemo();
  const { request } = fakeGtx();
  const s1 = new Array(200).fill('one').join(' '); // 799 文字
  const s2 = new Array(200).fill('two').join(' '); // 同上(1 バッチに同居できない)
  const r = await translateSegments(request, [s1, s2], { to: 'ja', maxRequests: 1 });
  assert.equal(r.truncated, true);
  assert.equal(r.requests, 1);
  assert.equal(r.translations[0], s1.toUpperCase());
  assert.equal(r.translations[1], '');
});

test('translateSegments: 429 は 1 回だけ間を置いて再試行して成功する', async () => {
  clearTranslateMemo();
  const prev = retryConfig.delayMs;
  retryConfig.delayMs = 5;
  try {
    const { request, calls } = fakeGtx({ failFirst: 1 });
    const r = await translateSegments(request, ['hello'], { to: 'ja' });
    assert.deepEqual(r.translations, ['HELLO']);
    assert.equal(calls.length, 2); // 429 → 再試行で成功
    assert.equal(r.requests, 1); // 論理リクエストとしては 1
  } finally {
    retryConfig.delayMs = prev;
  }
});

test('translateSegments: 再試行も失敗したらエラーを投げる', async () => {
  clearTranslateMemo();
  const prev = retryConfig.delayMs;
  retryConfig.delayMs = 5;
  try {
    const { request } = fakeGtx({ failFirst: 5 });
    await assert.rejects(() => translateSegments(request, ['hello'], { to: 'ja' }), /HTTP 429/);
  } finally {
    retryConfig.delayMs = prev;
  }
});
