import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  bootstrapBrowserArgs,
  browserExecutableCandidates,
  classifyAdoption,
  normalizeSignupUrl,
  resolveBrowserExecutable,
  resolveSignupBootstrapSettings,
  sameSignupDestination,
  validateExpectedCookie,
  validateExpectedSelector,
  validateProfileName,
  validateSignupName,
  type SignupState,
} from './signup';

test('signup 名と profile 名はパストラバーサルを許さない', () => {
  assert.equal(validateSignupName('target-a_1.2'), 'target-a_1.2');
  assert.equal(validateProfileName('signup-target-a'), 'signup-target-a');
  assert.throws(() => validateSignupName('../outside'), /signup 名/);
  assert.throws(() => validateProfileName('a/b'), /profile 名/);
  assert.throws(() => validateSignupName(''), /signup 名/);
});

test('signup の追加成功条件は空値・不正 Cookie 名を拒否する', () => {
  assert.equal(validateExpectedSelector('  #account-menu  '), '#account-menu');
  assert.equal(validateExpectedCookie('__Host-session'), '__Host-session');
  assert.throws(() => validateExpectedSelector('   '), /expect-selector/);
  assert.throws(() => validateExpectedCookie('sid;other'), /Cookie 名/);
});

test('normalizeSignupUrl は http(s) のみを許可する', () => {
  assert.equal(normalizeSignupUrl('example.com/signup'), 'https://example.com/signup');
  assert.equal(normalizeSignupUrl('http://localhost:3000/a'), 'http://localhost:3000/a');
  assert.throws(() => normalizeSignupUrl('file:///tmp/profile'), /http:\/\/ または https:\/\//);
  assert.throws(() => normalizeSignupUrl('javascript:alert(1)'), /http:\/\/ または https:\/\//);
});

test('bootstrap の通常ブラウザ引数に CDP / automation / stealth / headless 痕跡を入れない', () => {
  const args = bootstrapBrowserArgs(path.resolve('profile'), 'https://example.com/signup', { direct: true });
  assert.ok(args.includes('--no-proxy-server'));
  assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.equal(args.at(-1), 'https://example.com/signup');
  const joined = args.join(' ').toLowerCase();
  for (const forbidden of ['remote-debugging', 'enable-automation', 'automationcontrolled', 'webdriver', 'headless']) {
    assert.equal(joined.includes(forbidden), false, `${forbidden} を通常ブラウザへ渡してはいけない`);
  }
});

test('bootstrap --system-proxy 相当では direct 強制フラグを外す', () => {
  const args = bootstrapBrowserArgs(path.resolve('profile'), 'https://example.com/', { direct: false });
  assert.equal(args.includes('--no-proxy-server'), false);
});

test('browserExecutableCandidates は Playwright 同梱 Chromium を候補にしない', () => {
  const candidates = browserExecutableCandidates(
    'chrome',
    { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'C:\\bin;D:\\tools' },
    'win32',
  );
  assert.ok(candidates.some((candidate) => candidate.toLowerCase().endsWith('chrome.exe')));
  assert.equal(candidates.some((candidate) => /playwright|chromium/i.test(candidate)), false);
});

test('resolveBrowserExecutable は明示パスを絶対化し、不在なら失敗する', () => {
  const explicit = path.join('relative', 'chrome.exe');
  assert.equal(resolveBrowserExecutable('chrome', explicit, () => true), path.resolve(explicit));
  assert.throws(() => resolveBrowserExecutable('chrome', explicit, () => false), /見つかりません/);
});

function existingSignup(): SignupState {
  return {
    version: 1,
    name: 'target',
    profile: 'custom-profile',
    url: 'https://example.com/signup',
    checkUrl: 'https://example.com/account',
    expectSelector: '#account-menu',
    expectCookie: 'sid',
    channel: 'msedge',
    browserPath: '/browser/msedge',
    direct: false,
    proxyBefore: 'inspection',
    bootstrapPid: 123,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'ready-to-adopt',
    checkpointPath: '/checkpoint.json',
  };
}

test('resolveSignupBootstrapSettings: 再開時は custom profile/channel・元 proxy・成功条件を保持する', () => {
  const resolved = resolveSignupBootstrapSettings('target', 'https://example.com/signup-again', existingSignup(), {
    reuseProfile: true,
    activeProxy: 'direct', // adopt が変更した現在値ではなく元値を残す
  });
  assert.deepEqual(resolved, {
    profile: 'custom-profile',
    channel: 'msedge',
    checkUrl: 'https://example.com/account',
    expectSelector: '#account-menu',
    expectCookie: 'sid',
    browserPathHint: '/browser/msedge',
    direct: false,
    proxyBefore: 'inspection',
  });
});

test('resolveSignupBootstrapSettings: 初回既定は専用 chrome profile + direct', () => {
  const resolved = resolveSignupBootstrapSettings('target', 'https://example.com/signup', null, { activeProxy: 'inspection' });
  assert.equal(resolved.profile, 'signup-target');
  assert.equal(resolved.channel, 'chrome');
  assert.equal(resolved.direct, true);
  assert.equal(resolved.proxyBefore, 'inspection');
});

test('resolveSignupBootstrapSettings: 再開時の origin/profile/channel 変更と proxy 指定衝突を拒否する', () => {
  const existing = existingSignup();
  assert.throws(
    () => resolveSignupBootstrapSettings('target', 'https://other.example/signup', existing, { reuseProfile: true, activeProxy: 'direct' }),
    /別 origin/,
  );
  assert.throws(
    () => resolveSignupBootstrapSettings('target', existing.url, existing, { reuseProfile: true, profile: 'other', activeProxy: 'direct' }),
    /変更できません/,
  );
  assert.throws(
    () => resolveSignupBootstrapSettings('target', existing.url, existing, { reuseProfile: true, channel: 'chrome', activeProxy: 'direct' }),
    /変更できません/,
  );
  assert.throws(
    () => resolveSignupBootstrapSettings('new', 'https://example.com/signup', null, { systemProxy: true, direct: true, activeProxy: 'direct' }),
    /同時に指定できません/,
  );
});

test('sameSignupDestination は canonical 差を許すが login へのリダイレクトを拒否する', () => {
  assert.equal(sameSignupDestination('https://example.com/account', 'https://example.com/account/'), true);
  assert.equal(sameSignupDestination('https://example.com/account?a=1', 'https://example.com/account?fresh=1#top'), true);
  assert.equal(sameSignupDestination('https://example.com/account', 'https://example.com/login?next=%2Faccount'), false);
  assert.equal(sameSignupDestination('https://example.com/account', 'https://id.example.net/login'), false);
  assert.equal(sameSignupDestination('https://example.com/account', undefined), false);
});

test('classifyAdoption は challenge・login redirect・非 ok を成功扱いしない', () => {
  const expected = 'https://example.com/account';
  assert.equal(
    classifyAdoption({ verdict: 'ok', probes: [{ label: 'target', finalUrl: expected, challenged: false }] }, expected),
    'adopted',
  );
  assert.equal(
    classifyAdoption({ verdict: 'ok', probes: [{ label: 'target', finalUrl: 'https://example.com/login', challenged: false }] }, expected),
    'degraded-after-adopt',
  );
  assert.equal(
    classifyAdoption({ verdict: 'ok', probes: [{ label: 'target', finalUrl: expected, challenged: true }] }, expected),
    'challenge-after-adopt',
  );
  assert.equal(
    classifyAdoption({ verdict: 'target-protected', probes: [{ label: 'target', finalUrl: expected, challenged: false }] }, expected),
    'degraded-after-adopt',
  );
  assert.equal(classifyAdoption({ verdict: 'ok', probes: [{ label: 'target', challenged: false }] }, expected), 'degraded-after-adopt');
});

test('classifyAdoption は指定した selector / Cookie の存在を成功条件に加える', () => {
  const expected = 'https://example.com/account';
  const base = { verdict: 'ok', probes: [{ label: 'target', finalUrl: expected, challenged: false, selectorMatched: true }] };
  assert.equal(
    classifyAdoption(base, expected, { selector: '#account', cookie: 'sid', cookieNames: ['sid'] }),
    'adopted',
  );
  assert.equal(
    classifyAdoption({ ...base, probes: [{ ...base.probes[0], selectorMatched: false }] }, expected, { selector: '#account' }),
    'degraded-after-adopt',
  );
  assert.equal(classifyAdoption(base, expected, { cookie: 'sid', cookieNames: ['other'] }), 'degraded-after-adopt');
});
