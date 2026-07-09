import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { connectViaProxy } from '../daemon/relay';
import type { ProxyProfile } from '../shared/proxyStore';

/**
 * kb proxy trust-ca の実装。上流の MITM デバッグプロキシ(Charles / Fiddler / mitmproxy 等)が
 * HTTPS を終端するために使うルート CA を、プロキシ経由の TLS ハンドシェイクから抽出し、
 * OS の証明書ストアに導入する。ツール固有の magic URL(chls.pro/ssl 等)に依存せず、
 * 提示された証明書チェーンを自己署名ルートまで辿ることで、どの MITM ツールでも同じ経路で取れる。
 */

/** 証明書チェーンから抽出したルート CA の情報。 */
export interface ExtractedCa {
  /** PEM(-----BEGIN CERTIFICATE-----)。ファイル保存・OS 導入に使う。 */
  pem: string;
  /** DER バイト列。 */
  der: Buffer;
  /** サブジェクト(人間向け表示、例: "CN=Charles Proxy CA, O=..."). */
  subject: string;
  /** 発行者。自己署名ルートなら subject と一致する。 */
  issuer: string;
  /** SHA-256 fingerprint(コロン区切り大文字 hex、確認表示用)。 */
  fingerprint256: string;
  /** SHA-1 thumbprint(コロンなし大文字 hex)。certutil -delstore の識別子。 */
  thumbprint: string;
  /** SubjectPublicKeyInfo の SHA-256(base64)。--ignore-certificate-errors-spki-list 用。 */
  spki: string;
  validFrom: string;
  validTo: string;
  /**
   * 提示チェーンが公的に既知の CA(Node バンドルのルート)まで繋がったか。
   * true = プロキシが当該ホストを傍受していない(実 CA を素通し)か、既知の公的 CA。
   *        → 導入すべき私設 MITM ルートではない(誤導入を防ぐための警告材料)。
   * false = 未知の自己署名ルート = 今から信頼させたい MITM ルートである可能性が高い。
   */
  chainsToPublicCa: boolean;
}

/** DER を PEM(CERTIFICATE アーマー、64 文字改行)に変換する。 */
export function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Node の fingerprint 文字列("AB:CD:...")からコロンを除いた大文字 thumbprint。 */
export function toThumbprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toUpperCase();
}

/**
 * 証明書(PEM or DER)から SubjectPublicKeyInfo の SHA-256 を base64 で返す。
 * これが Chromium の --ignore-certificate-errors-spki-list に渡すハッシュ形式。
 */
export function spkiSha256Base64(cert: string | Buffer): string {
  const x509 = new crypto.X509Certificate(cert);
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spkiDer).digest('base64');
}

/** ファイル(PEM or DER)から CA を読み、SPKI ハッシュとサブジェクトを取り出す。 */
export function loadCaFromFile(filePath: string): { spki: string; subject: string; pem: string } {
  const raw = fs.readFileSync(filePath);
  const looksPem = raw.includes('-----BEGIN');
  const x509 = new crypto.X509Certificate(raw);
  const der = looksPem ? x509.raw : raw;
  return {
    spki: spkiSha256Base64(x509.raw),
    subject: x509.subject.replace(/\n/g, ', '),
    pem: derToPem(der),
  };
}

/** 証明書の DN オブジェクト({ CN, O, ... })を "CN=..., O=..." 形式の文字列にする。 */
export function formatDN(dn: tls.PeerCertificate['subject'] | string | undefined): string {
  if (dn == null) return '';
  if (typeof dn === 'string') return dn;
  return Object.entries(dn)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/**
 * peer 証明書チェーンを自己署名ルートまで辿る。Node は最上位で issuerCertificate が
 * 自分自身を指す(root sentinel)ため、それをルートとみなす。チェーンが途中までしか
 * 提示されない場合は、辿れた最上位の証明書を返す。循環・自己参照のガード付き。
 */
export function walkToRoot(leaf: tls.DetailedPeerCertificate): tls.DetailedPeerCertificate {
  let cert = leaf;
  const seen = new Set<string>();
  while (
    cert.issuerCertificate &&
    cert.issuerCertificate.raw && // 実データを持つ(空オブジェクトでない)
    cert.issuerCertificate !== cert && // root sentinel(自分自身)ではない
    cert.issuerCertificate.fingerprint256 !== cert.fingerprint256 // 同一証明書ではない
  ) {
    const fp = cert.issuerCertificate.fingerprint256 ?? '';
    if (seen.has(fp)) break; // 循環ガード
    seen.add(fp);
    cert = cert.issuerCertificate;
  }
  return cert;
}

/**
 * profile 経由で probeHost:probePort に TLS 接続し、提示された証明書チェーンの
 * ルートを抽出する。証明書検証は無効化(rejectUnauthorized:false)して未信頼ルートでも
 * ハンドシェイクを完了させ、socket.authorized で「公的 CA に繋がったか」を判定する。
 */
export function extractProxyRootCa(
  profile: ProxyProfile,
  probeHost: string,
  probePort = 443,
  timeoutMs = 10_000,
): Promise<ExtractedCa> {
  return new Promise<ExtractedCa>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    connectViaProxy(profile, probeHost, probePort, timeoutMs).then((raw) => {
      const socket = tls.connect({ socket: raw, servername: probeHost, rejectUnauthorized: false }, () => {
        try {
          const leaf = socket.getPeerCertificate(true);
          if (!leaf || !leaf.raw || Object.keys(leaf).length === 0) {
            socket.destroy();
            return finish(() => reject(new Error('プロキシ経由の TLS 応答から証明書を取得できませんでした')));
          }
          const root = walkToRoot(leaf);
          const der = root.raw;
          const result: ExtractedCa = {
            pem: derToPem(der),
            der,
            subject: formatDN(root.subject),
            issuer: formatDN(root.issuer),
            fingerprint256: root.fingerprint256,
            thumbprint: toThumbprint(root.fingerprint ?? ''),
            spki: spkiSha256Base64(der),
            validFrom: root.valid_from,
            validTo: root.valid_to,
            chainsToPublicCa: socket.authorized,
          };
          socket.destroy();
          finish(() => resolve(result));
        } catch (err) {
          socket.destroy();
          finish(() => reject(err));
        }
      });
      const timer = setTimeout(() => {
        socket.destroy();
        finish(() => reject(new Error('TLS ハンドシェイクがタイムアウトしました')));
      }, timeoutMs);
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        finish(() => reject(err));
      });
    }, (err) => finish(() => reject(err)));
  });
}

/** OS 証明書ストアへの導入がこの OS では未対応であることを表す(CLI 側が手動手順を案内する)。 */
export class CaStoreUnsupportedError extends Error {
  constructor(public readonly platform: string) {
    super(`この OS (${platform}) では証明書ストアへの自動導入に未対応です`);
    this.name = 'CaStoreUnsupportedError';
  }
}

/**
 * PEM を OS の信頼ルートストアに導入する。Windows は certutil の *user* Root ストア
 * (管理者不要・GUI プロンプトなし)。macOS / Linux は未対応で CaStoreUnsupportedError を投げる
 * (CLI 側が証明書と手動コマンドを提示する)。
 */
export function installCaToStore(pem: string, thumbprint: string): { store: string } {
  if (process.platform === 'win32') {
    const tmp = path.join(os.tmpdir(), `kb-ca-${thumbprint.slice(0, 16) || 'cert'}.crt`);
    fs.writeFileSync(tmp, pem);
    try {
      // -user: 現在ユーザの Root ストア(管理者不要)。-f: 既存を上書き。
      execFileSync('certutil', ['-addstore', '-user', '-f', 'Root', tmp], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`certutil による導入に失敗しました: ${certutilError(err)}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { store: 'windows-user-root' };
  }
  throw new CaStoreUnsupportedError(process.platform);
}

/** thumbprint を指定して OS ストアから証明書を削除する(Windows: certutil -delstore -user Root)。 */
export function removeCaFromStore(thumbprint: string): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('certutil', ['-delstore', '-user', 'Root', thumbprint], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`certutil による削除に失敗しました: ${certutilError(err)}`);
    }
    return;
  }
  throw new CaStoreUnsupportedError(process.platform);
}

/** execFileSync のエラーから certutil の stderr/stdout を取り出して 1 行にする。 */
function certutilError(err: unknown): string {
  const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
  const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message || String(err)).trim();
  return detail.split(/\r?\n/).filter(Boolean)[0] ?? String(err);
}
