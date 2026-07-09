import { test } from 'node:test';
import assert from 'node:assert/strict';
import type tls from 'node:tls';
import { derToPem, formatDN, spkiSha256Base64, toThumbprint, walkToRoot } from './caTrust';

// 使い捨ての自己署名証明書と、openssl が独立に計算した SPKI(SHA256/base64)。
// これで Node 実装が Chromium の --ignore-certificate-errors-spki-list と同じハッシュを出すことを固定する。
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUboZLEXWBEq9LgB8HzROg6g1fpowwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMa2Itc3BraS10ZXN0MB4XDTI2MDcwOTE1NTAxOFoXDTI2
MDcxMDE1NTAxOFowFzEVMBMGA1UEAwwMa2Itc3BraS10ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEArnXaNG0/IMtKJ50TDcGrxV0xNlKrAlQMtBMU
Vb+YG6KHcHIsiKI3OuMIOGbyCijx+jbToNj8brM9p11ZZUuCn7HptOMtPavSeIFl
7GBROt1AiFCXaQJW8C7AObEQRDYg7gKVbZ9GxEXh6VZCyeHR82vQXsuGrEtRIrQs
xDWa5lz/4kq3Qjk0j1tchjEM1yBrsXb7u5FGAOdCayGJMknucjLjRrnosRQ5r6qI
NxVV+p0EXtiyVVxVs+F+zkn8rIfT0u3yFTS3q339beK5bosyqTO0WOe6s5a2MpkT
CbIx6ZQII158RE1DDRQ3XOqvyCStSWm7GT+iz+Pgzylw0LkUnwIDAQABo1MwUTAd
BgNVHQ4EFgQUXREwNrPpuq5DQoRlfGy6jHUsUm4wHwYDVR0jBBgwFoAUXREwNrPp
uq5DQoRlfGy6jHUsUm4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAbdDiGvMfGFVpn62xO36B6b52yrTQceFa6lwltY0DDjFK+5qITc4r4PLfAVOt
T59dSmcRk64O2Zg7gUy/3oUpK7AMYn/ws6mPKawWtJMMIrEBJlx2xzCI3DNxk4rn
GiHJP9lkQalQvBUDuOPYpnUFTopxtSNkPmEccgFnfywic7zbAGoJAQpoOAq+qONJ
W0zvKBFqdil4iJhVPCwDkSHd2usQfdXaehnm2xIBGhixcgY/AT4I8EKToKE106Dt
GvdUp6i0242l35EtOpIvua5E28UDVA5qeXeuI+faeWDqBM3y83yOOjqvo2yLNcd4
ArStUrLe1iZHpbCaBbIzHOGSuw==
-----END CERTIFICATE-----`;
const TEST_CERT_SPKI = 'dTdq+LB7oBW4GkiBQwokYmPDdwDILfYG/W/alSw9XNA=';

test('derToPem: PEM アーマーで包み、64 文字ごとに改行する', () => {
  const der = Buffer.from('x'.repeat(100));
  const pem = derToPem(der);
  const lines = pem.trimEnd().split('\n');
  assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(lines[lines.length - 1], '-----END CERTIFICATE-----');
  // 本文行はすべて 64 文字以下
  for (const line of lines.slice(1, -1)) assert.ok(line.length <= 64, `line too long: ${line.length}`);
  // 復元すると元の DER に戻る
  const body = lines.slice(1, -1).join('');
  assert.deepEqual(Buffer.from(body, 'base64'), der);
});

test('spkiSha256Base64: openssl と同じ SPKI ハッシュを出す(PEM 入力)', () => {
  assert.equal(spkiSha256Base64(TEST_CERT_PEM), TEST_CERT_SPKI);
});

test('spkiSha256Base64: DER 入力でも同じ結果、44 文字 base64', () => {
  const der = Buffer.from(TEST_CERT_PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  const h = spkiSha256Base64(der);
  assert.equal(h, TEST_CERT_SPKI);
  assert.equal(h.length, 44); // SHA-256(32B) の base64
});

test('toThumbprint: コロンを除いて大文字にする', () => {
  assert.equal(toThumbprint('ab:cd:ef:12:34'), 'ABCDEF1234');
  assert.equal(toThumbprint('AB:CD'), 'ABCD');
  assert.equal(toThumbprint(''), '');
});

test('formatDN: DN オブジェクトを "K=V, ..." にする', () => {
  assert.equal(formatDN({ CN: 'Charles Proxy CA', O: 'XK72' } as tls.PeerCertificate['subject']), 'CN=Charles Proxy CA, O=XK72');
  assert.equal(formatDN('already a string'), 'already a string');
  assert.equal(formatDN(undefined), '');
});

/** raw と fingerprint256 を持つ最小の証明書ノードを作る。issuer 未指定なら自己署名(root sentinel)。 */
function mockCert(fp: string, issuer?: unknown): tls.DetailedPeerCertificate {
  const cert = { fingerprint256: fp, raw: Buffer.from(fp), subject: { CN: fp } } as unknown as Record<string, unknown>;
  cert.issuerCertificate = issuer ?? cert; // root は自分自身を指す
  return cert as unknown as tls.DetailedPeerCertificate;
}

test('walkToRoot: leaf → intermediate → root を辿って自己署名ルートを返す', () => {
  const root = mockCert('ROOT');
  const inter = mockCert('INTER', root);
  const leaf = mockCert('LEAF', inter);
  assert.equal(walkToRoot(leaf).fingerprint256, 'ROOT');
});

test('walkToRoot: leaf 自身が自己署名ならそれを返す', () => {
  const selfSigned = mockCert('SELF');
  assert.equal(walkToRoot(selfSigned).fingerprint256, 'SELF');
});

test('walkToRoot: チェーンが途中までしか無い(issuer が空)なら辿れた最上位を返す', () => {
  const empty = {} as unknown as tls.DetailedPeerCertificate; // raw なし
  const leaf = mockCert('LEAF', empty);
  assert.equal(walkToRoot(leaf).fingerprint256, 'LEAF');
});

test('walkToRoot: 循環参照でも無限ループしない', () => {
  const a = mockCert('A');
  const b = mockCert('B', a);
  // a の issuer を b に差し替えて循環させる
  (a as unknown as Record<string, unknown>).issuerCertificate = b;
  const result = walkToRoot(mockCert('LEAF', a));
  assert.ok(['A', 'B'].includes(result.fingerprint256));
});
