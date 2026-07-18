import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { browserAvailable, rpc as rawRpc, startDaemon, stopDaemon, type E2EDaemon } from './harness';

/**
 * e2e スモーク: 実デーモン + headless ブラウザで主要 RPC 経路を往復する。
 * ネットワーク非依存(data: URL + ローカル http サーバのみ)。
 * ブラウザが無い環境ではスイートごと skip する。
 */

const html = String.raw;

/** テスト用フォームページ(data: URL)。 */
const PAGE = html`<!doctype html>
<html>
  <head><title>kb-e2e</title></head>
  <body>
    <h1>Hello E2E</h1>
    <p id="out">initial</p>
    <input id="name" type="text" aria-label="Name" />
    <select id="sel" aria-label="Pick">
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </select>
    <button id="btn" onclick="document.getElementById('out').textContent='clicked'">Go</button>
    <button id="confirmBtn" onclick="window.confirmResult = confirm('sure?')">Ask</button>
  </body>
</html>`;

const dataUrl = (body: string) => 'data:text/html,' + encodeURIComponent(body);

const available = browserAvailable();

describe('kb e2e smoke', { skip: available ? false : 'ブラウザ(chromium/chrome/edge)が見つからないため skip' }, () => {
  let d: E2EDaemon;
  let server: http.Server;
  let origin: string; // ローカル http サーバ (request / net.log 用)
  const rpc = (cmd: string, args: Record<string, unknown> = {}) => rawRpc(d, cmd, args);

  before(async () => {
    server = http
      .createServer((req, res) => {
        if (req.url === '/page.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            html`<!doctype html><html><head><title>kb-e2e-http</title></head><body>
              <p id="api">loading</p>
              <script>
                fetch('/api/data').then((r) => r.text()).then((t) => (document.getElementById('api').textContent = t));
              </script>
            </body></html>`,
          );
        } else if (req.url === '/api/data') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"hello":"kb"}');
        } else if (req.url === '/cookies') {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Set-Cookie': ['e2e1=v1; Path=/', 'e2e2=v2; Path=/'],
          });
          res.end('cookie ok');
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      })
      .listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (addr == null || typeof addr === 'string') throw new Error('ローカルサーバの port が取得できません');
    origin = `http://127.0.0.1:${addr.port}`;

    d = await startDaemon();
  });

  after(async () => {
    if (d) await stopDaemon(d);
    server?.close();
  });

  test('daemon.status', async () => {
    const r = await rpc('daemon.status');
    assert.equal(r.pid, d.pid);
    assert.equal(r.headless, true);
    assert.equal(r.profile, 'default');
  });

  test('open + text', { timeout: 30_000 }, async () => {
    const r = await rpc('open', { url: dataUrl(PAGE) });
    assert.equal(typeof r.tab, 'number');
    assert.equal(r.title, 'kb-e2e');
    const t = await rpc('text', {});
    assert.match(t.text, /Hello E2E/);
    assert.match(t.text, /initial/);
    assert.equal(t.truncated, false);
  });

  test('snapshot has refs', async () => {
    const r = await rpc('snapshot', {});
    assert.match(r.snapshot, /\[ref=/);
    assert.match(r.snapshot, /textbox/);
  });

  test('fill via ref (from snapshot)', async () => {
    const snap = await rpc('snapshot', {});
    const m = /textbox[^\n[]*\[ref=(\w+)\]/.exec(snap.snapshot);
    assert.ok(m, `snapshot に textbox の ref がありません:\n${snap.snapshot}`);
    await rpc('fill', { ref: m![1], value: 'from-ref' });
    const v = await rpc('eval', { expression: `document.getElementById('name').value` });
    assert.equal(v.result, 'from-ref');
  });

  test('fill + click + press via selector', async () => {
    await rpc('fill', { selector: '#name', value: 'hello' });
    const v = await rpc('eval', { expression: `document.getElementById('name').value` });
    assert.equal(v.result, 'hello');

    const c = await rpc('click', { selector: '#btn' });
    assert.equal(typeof c.url, 'string');
    assert.equal(c.dialog, undefined);
    const out = await rpc('eval', { expression: `document.getElementById('out').textContent` });
    assert.equal(out.result, 'clicked');

    const p = await rpc('press', { key: 'End' });
    assert.equal(typeof p.url, 'string');
  });

  test('select', async () => {
    const r = await rpc('select', { selector: '#sel', values: ['b'] });
    assert.deepEqual(r.selected, ['b']);
    const v = await rpc('eval', { expression: `document.getElementById('sel').value` });
    assert.equal(v.result, 'b');
  });

  test('eval: object result and truncation shape', async () => {
    const obj = await rpc('eval', { expression: `({ a: 1, b: 'x' })` });
    assert.deepEqual(obj.result, { a: 1, b: 'x' });
    assert.equal(obj.truncated, false);

    const long = await rpc('eval', { expression: `'x'.repeat(100)`, maxChars: 10 });
    assert.equal(long.result, 'xxxxxxxxxx');
    assert.equal(long.truncated, true);
    assert.equal(long.totalChars, 100);
    assert.equal(long.offset, 0);
  });

  test('screenshot writes a PNG', async () => {
    const out = path.join(os.tmpdir(), `kb-e2e-shot-${process.pid}.png`);
    try {
      await rpc('screenshot', { path: out });
      const buf = fs.readFileSync(out);
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG マジック
    } finally {
      fs.rmSync(out, { force: true });
    }
  });

  test('dialog: confirm is held, then accepted', { timeout: 30_000 }, async () => {
    const c = await rpc('click', { selector: '#confirmBtn' });
    assert.ok(c.dialog, 'click の応答に dialog が入るはず');
    assert.equal(c.dialog.type, 'confirm');
    assert.match(c.dialog.message, /sure\?/);

    const info = await rpc('dialog.info', {});
    assert.equal(info.pending?.type, 'confirm');
    assert.equal(info.policy, 'hold');

    const resp = await rpc('dialog.respond', { accept: true });
    assert.equal(resp.responded, 'accept');

    // 応答後、ブロックされていたページ JS が再開して confirm の戻り値が入る(少し待って確認)
    let result: unknown;
    for (let i = 0; i < 20; i++) {
      const r = await rpc('eval', { expression: 'window.confirmResult' });
      result = r.result;
      if (result === true) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.equal(result, true);
  });

  test('wait --selector (element appears later)', { timeout: 30_000 }, async () => {
    await rpc('eval', {
      expression: `setTimeout(() => { const el = document.createElement('div'); el.id = 'late'; el.textContent = 'late'; document.body.appendChild(el); }, 300); 'scheduled'`,
    });
    const r = await rpc('wait', { selector: '#late', timeoutMs: 10_000 });
    assert.deepEqual(r.matched, ['selector=#late']);
  });

  test('tabs: open new / list / close', { timeout: 30_000 }, async () => {
    const initial = await rpc('tabs.list');
    const opened = await rpc('open', { url: dataUrl('<title>tab2</title><p>second</p>'), new: true });
    const listed = await rpc('tabs.list');
    assert.equal(listed.length, initial.length + 1);
    const active = listed.find((t: { active: boolean }) => t.active);
    assert.equal(active.id, opened.tab);
    await rpc('tabs.close', { tab: opened.tab });
    const afterList = await rpc('tabs.list');
    assert.equal(afterList.length, initial.length);
  });

  test('tabs.detach: タブを新しいウィンドウへ分離する(旧 id は消え新 id が付く)', { timeout: 30_000 }, async () => {
    const a = await rpc('open', { url: dataUrl('<title>detach-a</title><p>a</p>'), new: true });
    const b = await rpc('open', { url: dataUrl('<title>detach-b</title><p>b</p>'), new: true });
    const before = await rpc('tabs.list');
    const r = await rpc('tabs.detach', { tabs: [a.tab, b.tab] });
    // 旧 id → 新 id の対応が返る。URL は引き継がれ、新 id は元と別。
    assert.equal(r.detached.length, 2);
    assert.deepEqual(
      r.detached.map((d: { from: number }) => d.from),
      [a.tab, b.tab],
    );
    for (const d of r.detached) assert.notEqual(d.to, d.from);
    // タブ総数は不変(作り直して元を閉じるため)。旧 id は消え、新 id が居る。
    const after = await rpc('tabs.list');
    assert.equal(after.length, before.length);
    const ids = after.map((t: { id: number }) => t.id);
    assert.ok(!ids.includes(a.tab) && !ids.includes(b.tab), '分離元の旧タブ id は消えるはず');
    for (const d of r.detached) assert.ok(ids.includes(d.to), '分離先の新タブ id が一覧に居るはず');
    // 後片付け(以降のテストのタブ数前提を汚さない)
    for (const d of r.detached) await rpc('tabs.close', { tab: d.to });
  });

  test('net.log + net.body capture fetch response', { timeout: 30_000 }, async () => {
    await rpc('open', { url: `${origin}/page.html` });
    // ページ内 fetch が捕捉されるまでポーリング
    let seq: number | undefined;
    for (let i = 0; i < 25 && seq == null; i++) {
      const log = await rpc('net.log', { filter: '/api/data' });
      const resp = log.entries.find((e: { event: string; status?: number }) => e.event === 'response');
      seq = resp?.seq;
      if (seq == null) await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(seq != null, '/api/data の response がログに現れるはず');
    const body = await rpc('net.body', { seq });
    assert.match(body.contentType, /json/);
    assert.deepEqual(JSON.parse(body.body), { hello: 'kb' });
  });

  test('request: Set-Cookie is extracted individually', async () => {
    const r = await rpc('request', { url: `${origin}/cookies` });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'cookie ok');
    assert.deepEqual(r.setCookies, ['e2e1=v1; Path=/', 'e2e2=v2; Path=/']);
  });

  test('cookies.list includes cookies from request', async () => {
    const cookies = await rpc('cookies.list', {});
    const names = cookies.map((c: { name: string }) => c.name);
    assert.ok(names.includes('e2e1'), `e2e1 が cookie に載るはず: ${names.join(',')}`);
    assert.ok(names.includes('e2e2'), `e2e2 が cookie に載るはず: ${names.join(',')}`);
  });

  test('request: JSON body gets inferred content-type and echoes', async () => {
    const r = await rpc('request', {
      url: `${origin}/api/data`,
      method: 'POST',
      data: '{"ping":1}',
    });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /json/);
  });

  test('journal: command イベントは RPC 直後にディスクへ flush される', { timeout: 30_000 }, async () => {
    // 一意なマーカー URL を開き、その command が即座に events.jsonl に現れることを確認する
    // (journal のバッファ書き込みは command 境界で同期 flush する契約)。
    const marker = `data:text/html,<title>durability-${d.pid}</title>`;
    await rpc('open', { url: marker });
    const logsDir = path.join(d.home, 'logs');
    const sessions = fs.readdirSync(logsDir);
    assert.ok(sessions.length >= 1, 'セッションフォルダがあるはず');
    const found = sessions.some((s) => {
      const file = path.join(logsDir, s, 'events.jsonl');
      if (!fs.existsSync(file)) return false;
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          try {
            const e = JSON.parse(line);
            return e.type === 'command' && e.cmd === 'open';
          } catch {
            return false;
          }
        });
    });
    assert.ok(found, 'open の command イベントが RPC 直後に events.jsonl へ書かれているはず');
  });
});
