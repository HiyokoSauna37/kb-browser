import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type net from 'node:net';
import { matchHost, readConnectResponse, splitHostPort } from './relay';

test('matchHost: 完全一致とワイルドカード', () => {
  assert.equal(matchHost('*', 'anything.example.com'), true);
  assert.equal(matchHost('example.com', 'example.com'), true);
  assert.equal(matchHost('example.com', 'evil-example.com'), false);
});

test('matchHost: *.example.com はサブドメインと apex に一致', () => {
  assert.equal(matchHost('*.example.com', 'www.example.com'), true);
  assert.equal(matchHost('*.example.com', 'a.b.example.com'), true);
  assert.equal(matchHost('*.example.com', 'example.com'), true);
  assert.equal(matchHost('*.example.com', 'evil-example.com'), false);
  assert.equal(matchHost('*.example.com', 'example.com.evil.net'), false);
});

test('matchHost: 大文字小文字を無視する', () => {
  assert.equal(matchHost('*.Example.COM', 'www.example.com'), true);
});

test('splitHostPort: 通常のホスト名', () => {
  assert.deepEqual(splitHostPort('example.com:8443', 443), { host: 'example.com', port: 8443 });
  assert.deepEqual(splitHostPort('example.com', 443), { host: 'example.com', port: 443 });
});

test('splitHostPort: IPv6 リテラル', () => {
  assert.deepEqual(splitHostPort('[::1]:8443', 443), { host: '::1', port: 8443 });
  assert.deepEqual(splitHostPort('[2001:db8::1]', 443), { host: '2001:db8::1', port: 443 });
  // 裸の IPv6(コロン複数)は全体をホストとして扱う
  assert.deepEqual(splitHostPort('2001:db8::1', 443), { host: '2001:db8::1', port: 443 });
});

test('splitHostPort: 不正なポートはデフォルトに落ちる', () => {
  assert.deepEqual(splitHostPort('example.com:abc', 443), { host: 'example.com', port: 443 });
});

function mockSocket(): PassThrough & { destroyed: boolean } {
  const s = new PassThrough() as PassThrough & { destroyed: boolean };
  return s;
}

test('readConnectResponse: 200 で解決し、余剰データを socket に戻す', async () => {
  const socket = mockSocket();
  const done = readConnectResponse(socket as unknown as net.Socket, 1000);
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\nEXTRA');
  await done;
  const rest = socket.read();
  assert.equal(String(rest), 'EXTRA');
});

test('readConnectResponse: ヘッダ分割チャンクでも解決する', async () => {
  const socket = mockSocket();
  const done = readConnectResponse(socket as unknown as net.Socket, 1000);
  socket.write('HTTP/1.1 200 Connection');
  socket.write(' Established\r\n\r\n');
  await done;
});

test('readConnectResponse: 407 拒否は reject', async () => {
  const socket = mockSocket();
  const done = readConnectResponse(socket as unknown as net.Socket, 1000);
  socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  await assert.rejects(done, /407/);
});

test('readConnectResponse: タイムアウトで reject', async () => {
  const socket = mockSocket();
  await assert.rejects(readConnectResponse(socket as unknown as net.Socket, 50), /タイムアウト/);
});
