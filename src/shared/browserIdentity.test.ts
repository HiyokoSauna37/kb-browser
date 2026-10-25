import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseBrowserIdentity, type BrowserUserAgentData } from './browserIdentity';

const chromeUa = (major: number, suffix = '') =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${suffix}`;

const uaData = (major: number): BrowserUserAgentData => ({
  brands: [
    { brand: 'Not;A=Brand', version: '99' },
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
  ],
  mobile: false,
  platform: 'Windows',
});

test('browser identity: browser 既定 UA と UA-CH の major が一致すれば coherent', () => {
  const result = diagnoseBrowserIdentity({ userAgent: chromeUa(156), userAgentData: uaData(156) });
  assert.equal(result.coherent, true);
  assert.equal(result.overridden, false);
  assert.equal(result.userAgentChromeMajor, 156);
  assert.equal(result.userAgentDataChromeMajor, 156);
  assert.deepEqual(result.issues, []);
});

test('browser identity: UA と UA-CH の Chrome major 不一致を検出する', () => {
  const result = diagnoseBrowserIdentity({ userAgent: chromeUa(140), userAgentData: uaData(156) });
  assert.equal(result.coherent, false);
  assert.deepEqual(result.issues, ['ua-major-mismatch']);
});

test('browser identity: HeadlessChrome も engine major として比較する', () => {
  const userAgent = chromeUa(156).replace('Chrome/', 'HeadlessChrome/');
  const result = diagnoseBrowserIdentity({ userAgent, userAgentData: uaData(156) });
  assert.equal(result.userAgentChromeMajor, 156);
  assert.equal(result.coherent, true);
});

test('browser identity: stale major + 独自 suffix の Windows 実測形を両方診断する', () => {
  const configured = chromeUa(140, ' kb-browser/1.0');
  const result = diagnoseBrowserIdentity(
    { userAgent: configured, userAgentData: uaData(156) },
    configured,
  );
  assert.deepEqual(result.issues, ['ua-major-mismatch', 'nonstandard-configured-ua']);
});

test('browser identity: 任意 suffix 付き configured UA を非標準 override として検出する', () => {
  const configured = chromeUa(156, ' kb-browser/1.0');
  const result = diagnoseBrowserIdentity(
    { userAgent: configured, userAgentData: uaData(156) },
    configured,
  );
  assert.equal(result.overridden, true);
  assert.equal(result.coherent, false);
  assert.deepEqual(result.issues, ['nonstandard-configured-ua']);
});

test('browser identity: 標準形で major も一致する configured UA は許容する', () => {
  const configured = chromeUa(156);
  const result = diagnoseBrowserIdentity(
    { userAgent: configured, userAgentData: uaData(156) },
    configured,
  );
  assert.equal(result.overridden, true);
  assert.equal(result.coherent, true);
  assert.deepEqual(result.issues, []);
});

test('browser identity: configured UA が effective UA へ反映されていない状態を検出する', () => {
  const configured = chromeUa(140);
  const result = diagnoseBrowserIdentity(
    { userAgent: chromeUa(156), userAgentData: uaData(156) },
    configured,
  );
  assert.equal(result.coherent, false);
  assert.deepEqual(result.issues, ['configured-ua-not-effective']);
});

test('browser identity: Chromium でない configured UA は非標準として扱う', () => {
  const result = diagnoseBrowserIdentity(
    { userAgent: 'kb-client/1.0' },
    'kb-client/1.0',
  );
  assert.deepEqual(result.issues, ['nonstandard-configured-ua']);
});
