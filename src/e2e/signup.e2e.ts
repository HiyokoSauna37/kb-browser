import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findProfileProcesses, killTree, listProcesses } from '../daemon/procscan';
import { isPidAlive } from '../shared/client';
import { resolveBrowserExecutable, type SignupChannel } from '../shared/signup';

/**
 * signup の実経路を、外部通信なしで検証する:
 * 通常 Chrome 起動 → profile Cookie 永続化 → CLI adopt → session 証拠 → checkpoint。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function installedBrowser(): { channel: SignupChannel; executable: string } | null {
  if (process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return { channel, executable: resolveBrowserExecutable(channel) };
    } catch {
      /* 次の channel */
    }
  }
  return null;
}

const browser = installedBrowser();
const ownedBrowserPids = new Set<number>();

process.on('exit', () => {
  for (const pid of ownedBrowserPids) if (isPidAlive(pid)) killTree(pid);
});

interface CliResult<T = any> {
  ok: boolean;
  result?: T;
  error?: string;
}

function runCli(home: string, args: string[], timeoutMs = 90_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const cliJs = path.join(__dirname, '..', 'cli.js');
    const child = spawn(process.execPath, [cliJs, '--json', ...args], {
      env: { ...process.env, KB_HOME: home, KB_IDLE_TIMEOUT: '0', KB_RELAY_NOAUTH: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      reject(new Error(`kb ${args.join(' ')} timed out\n${stderr}`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim()) as CliResult;
        if (code !== 0 && parsed.ok !== false) throw new Error(`exit=${code}: ${stdout}\n${stderr}`);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`kb ${args.join(' ')} returned invalid JSON (exit=${code})\nstdout: ${stdout}\nstderr: ${stderr}\n${String(err)}`));
      }
    });
  });
}

async function stopOwnedBrowser(pid: number, profileDir: string): Promise<void> {
  // 人がウィンドウを閉じる本番経路と同じく、まず main window へ graceful close を送る。
  // Cookie DB の正常 flush を検証するため、即 /F kill は最終手段に限定する。
  if (isPidAlive(pid)) {
    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CloseMainWindow()`],
        { windowsHide: true, stdio: 'ignore' },
      );
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const users = findProfileProcesses(listProcesses(), profileDir, process.pid);
    if (!isPidAlive(pid) && users.length === 0) break;
    await sleep(250);
  }
  const lingering = findProfileProcesses(listProcesses(), profileDir, process.pid);
  for (const livePid of lingering) killTree(livePid);
  for (let i = 0; i < 20 && findProfileProcesses(listProcesses(), profileDir, process.pid).length; i++) await sleep(250);
  ownedBrowserPids.delete(pid);
  assert.equal(findProfileProcesses(listProcesses(), profileDir, process.pid).length, 0, '通常 Chrome が profile を解放するはず');
}

describe(
  'kb signup handoff e2e',
  { skip: browser ? false : 'headed のインストール済み Chrome/Edge が利用できないため skip' },
  () => {
    let home: string;
    let server: http.Server;
    let origin: string;
    let profileDir: string;
    let signedInAccountHits = 0;

    before(async () => {
      // Windows の process CommandLine が空白入り --user-data-dir を引数全体で quote する
      // 実経路も通し、profile の同時利用ガードが表記差で抜けないことを確認する。
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb signup e2e-'));
      profileDir = path.join(home, 'profiles', 'custom-signup-e2e');
      fs.mkdirSync(home, { recursive: true });
      // bootstrap 前の upstream を記録し、adopt が direct に切り替えた後の再開でも失わないことを検証する。
      fs.writeFileSync(
        path.join(home, 'proxies.json'),
        JSON.stringify({ profiles: { inspection: { type: 'http', host: '127.0.0.1', port: 9 } }, active: 'inspection', rules: [] }),
      );
      server = http
        .createServer((req, res) => {
          if (req.url === '/signup') {
            res.writeHead(302, {
              Location: '/account',
              'Set-Cookie': [
                'e2e_signup=ready; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
                'e2e_session=temporary; Path=/; HttpOnly; SameSite=Lax',
              ],
            });
            res.end();
          } else if (req.url === '/account') {
            if (!String(req.headers.cookie ?? '').includes('e2e_signup=ready')) {
              res.writeHead(302, { Location: '/login' });
              res.end();
            } else {
              signedInAccountHits++;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><head><title>Account</title></head><body><nav id="account-menu">signed in</nav></body></html>');
            }
          } else if (req.url === '/login') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><head><title>Login</title></head><body>login required</body></html>');
          } else if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><head><title>Root</title></head><body>root</body></html>');
          } else {
            res.writeHead(404);
            res.end('not found');
          }
        })
        .listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('signup e2e server port unavailable');
      origin = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      for (const pid of ownedBrowserPids) if (isPidAlive(pid)) killTree(pid);
      ownedBrowserPids.clear();
      if (home) await runCli(home, ['daemon', 'stop']).catch(() => undefined);
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      if (home) {
        try {
          fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {
          /* 一時 profile のロック解除が遅い環境では残してもテスト結果には影響しない */
        }
      }
    });

    test('ordinary Chrome profile を adopt・検証・checkpoint・再開できる', { timeout: 180_000 }, async () => {
      const first = await runCli(home, [
        'signup',
        'bootstrap',
        'local-target',
        `${origin}/signup`,
        '--profile',
        'custom-signup-e2e',
        '--check-url',
        `${origin}/account`,
        '--expect-selector',
        '#account-menu',
        '--expect-cookie',
        'e2e_signup',
        '--channel',
        browser!.channel,
        '--browser-path',
        browser!.executable,
      ]);
      assert.equal(first.ok, true, first.error);
      const firstState = first.result as any;
      ownedBrowserPids.add(firstState.bootstrapPid);
      assert.equal(firstState.browserRunning, true);
      assert.equal(firstState.proxyBefore, 'inspection');
      for (let i = 0; i < 30 && signedInAccountHits === 0; i++) await sleep(100);
      assert.ok(signedInAccountHits > 0, '通常 Chrome が signup→account を Cookie 付きで表示するはず');
      // 保存 PID に頼らず、空白入り user-data-dir を持つ実プロセスから同時利用を拒否する。
      const liveStatePath = path.join(home, 'signups', 'local-target', 'state.json');
      const liveState = JSON.parse(fs.readFileSync(liveStatePath, 'utf8'));
      fs.writeFileSync(liveStatePath, JSON.stringify({ ...liveState, bootstrapPid: 2_147_483_000 }));
      const guarded = await runCli(home, ['signup', 'adopt', 'local-target', '--timeout', '1']);
      assert.equal(guarded.ok, false);
      assert.match(guarded.error ?? '', /profile を使用中/);
      await sleep(500); // Cookie DB の永続化を待つ
      await stopOwnedBrowser(firstState.bootstrapPid, profileDir);

      const ready = await runCli(home, ['signup', 'status', 'local-target']);
      assert.equal(ready.ok, true, ready.error);
      assert.equal((ready.result as any).phase, 'ready-to-adopt');

      const adopted = await runCli(home, ['signup', 'adopt', 'local-target', '--timeout', '5', '--restore-proxy'], 120_000);
      assert.equal(adopted.ok, true, adopted.error);
      const adoptedState = adopted.result as any;
      assert.equal(adoptedState.phase, 'proxy-degraded', JSON.stringify(adoptedState, null, 2));
      assert.equal(adoptedState.profile, 'custom-signup-e2e');
      assert.equal(adoptedState.lastCheck.selectorMatched, true);
      assert.equal(adoptedState.lastCheck.cookieMatched, true);
      assert.equal(adoptedState.lastCheck.finalUrl, `${origin}/account`);
      assert.ok(
        adoptedState.postProxyCheck.verdict === 'unreachable' ||
          adoptedState.postProxyCheck.finalUrl !== `${origin}/account` ||
          adoptedState.postProxyCheck.cookieMatched === false ||
          adoptedState.postProxyCheck.selectorMatched === false,
        JSON.stringify(adoptedState.postProxyCheck, null, 2),
      );
      assert.equal(adoptedState.rollbackCheck.verdict, 'ok');
      assert.equal(adoptedState.rollbackCheck.cookieMatched, true);
      assert.equal(adoptedState.checkpointExists, true);

      const checkpoint = JSON.parse(fs.readFileSync(adoptedState.checkpointPath, 'utf8'));
      assert.ok(checkpoint.cookies.some((cookie: any) => cookie.name === 'e2e_signup' && cookie.value === 'ready'));
      assert.equal(
        checkpoint.cookies.some((cookie: any) => cookie.name === 'e2e_session'),
        false,
        '通常 Chrome の正常終了では session Cookie は引き継げないことを明示的に固定する',
      );
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'proxies.json'), 'utf8')).active, 'direct');

      const refreshed = await runCli(home, ['signup', 'checkpoint', 'local-target', '--timeout', '5'], 120_000);
      assert.equal(refreshed.ok, true, refreshed.error);
      assert.equal((refreshed.result as any).check.selectorMatched, true);
      assert.equal((refreshed.result as any).check.cookieMatched, true);

      const stopped = await runCli(home, ['daemon', 'stop']);
      assert.equal(stopped.ok, true, stopped.error);

      // adopt が active proxy を direct に変えた後でも、元の proxyBefore と custom profile、
      // 成功条件、checkpoint を --reuse-profile が保持する。
      const resumed = await runCli(home, [
        'signup',
        'bootstrap',
        'local-target',
        `${origin}/signup`,
        '--reuse-profile',
      ]);
      assert.equal(resumed.ok, true, resumed.error);
      const resumedState = resumed.result as any;
      ownedBrowserPids.add(resumedState.bootstrapPid);
      assert.equal(resumedState.profile, 'custom-signup-e2e');
      assert.equal(resumedState.channel, browser!.channel);
      assert.equal(resumedState.proxyBefore, 'inspection');
      assert.equal(resumedState.expectSelector, '#account-menu');
      assert.equal(resumedState.expectCookie, 'e2e_signup');
      assert.equal(resumedState.checkpointPath, adoptedState.checkpointPath);
      await stopOwnedBrowser(resumedState.bootstrapPid, profileDir);

      const wrongOrigin = await runCli(home, [
        'signup',
        'bootstrap',
        'local-target',
        'http://localhost:1/signup',
        '--reuse-profile',
      ]);
      assert.equal(wrongOrigin.ok, false);
      assert.match(wrongOrigin.error ?? '', /別 origin/);

      const noCheckState = {
        ...JSON.parse(fs.readFileSync(path.join(home, 'signups', 'local-target', 'state.json'), 'utf8')),
        name: 'no-check-target',
        profile: 'no-check-profile',
        checkUrl: undefined,
        expectSelector: undefined,
        expectCookie: undefined,
        bootstrapPid: 2_147_483_000,
        phase: 'ready-to-adopt',
      };
      const noCheckDir = path.join(home, 'signups', 'no-check-target');
      fs.mkdirSync(noCheckDir, { recursive: true });
      fs.writeFileSync(path.join(noCheckDir, 'state.json'), JSON.stringify(noCheckState));
      const noCheck = await runCli(home, ['signup', 'adopt', 'no-check-target']);
      assert.equal(noCheck.ok, false);
      assert.match(noCheck.error ?? '', /--check-url.+必須/);
    });
  },
);
