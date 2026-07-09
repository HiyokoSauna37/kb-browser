import fs from 'node:fs';
import path from 'node:path';
import { KB_HOME, ensureKbHome } from './paths';

export const PROXIES_PATH = path.join(KB_HOME, 'proxies.json');

/**
 * kb proxy trust-ca で OS 証明書ストアに導入した、上流プロキシの MITM ルート CA の記録。
 * untrust-ca での削除(thumbprint 指定)と proxy list 表示に使う。証明書実体はストア側にあり、
 * ここには識別情報だけを持つ。
 */
export interface TrustedCaRecord {
  /** SHA-1 thumbprint(コロンなし大文字 hex)。certutil -delstore の識別子。 */
  thumbprint: string;
  /** 証明書のサブジェクト(人間向け表示)。 */
  subject: string;
  /** 導入した OS ストア (例: "windows-user-root")。 */
  store: string;
  /** 導入日時 (ISO)。 */
  installedAt: string;
}

export type ProxyProfile =
  | { type: 'direct' }
  | {
      type: 'http' | 'socks5';
      host: string;
      port: number;
      username?: string;
      password?: string;
      /** これらのパターンに一致するホストはプロキシを通さない (例: "*.internal.example", "localhost") */
      bypass?: string[];
      /** kb proxy trust-ca で信頼させた MITM ルート CA(untrust-ca で削除する識別情報)。 */
      trustedCa?: TrustedCaRecord;
      /**
       * OS ストアを触らずに信頼する CA の SPKI ハッシュ(SHA-256/DER の base64)。
       * デーモン起動時に Chromium の --ignore-certificate-errors-spki-list へ渡され、
       * **この証明書 1 枚だけ**の証明書エラーを許可する(他は通常どおり検証される)。
       * proxy add --ca / proxy trust-ca --scoped で設定。適用にはデーモン再起動が要る。
       */
      caSpki?: string;
      /** caSpki 元の CA のサブジェクト(proxy list 表示用)。 */
      caSubject?: string;
    };

export interface ProxyRule {
  /** ホスト名のワイルドカードパターン (例: "*.corp.example.com") */
  pattern: string;
  /** 適用するプロファイル名 ("direct" も可) */
  profile: string;
}

export interface ProxyConfig {
  profiles: Record<string, ProxyProfile>;
  active: string;
  /** パターン振り分けルール。上から順に最初に一致したものが優先され、どれにも一致しなければ active を使う。 */
  rules: ProxyRule[];
}

/** "direct" は常に存在する組み込みプロファイル。 */
export const DIRECT: ProxyProfile = { type: 'direct' };

export function loadProxyConfig(): ProxyConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) as ProxyConfig;
    cfg.profiles ??= {};
    cfg.active ??= 'direct';
    cfg.rules ??= [];
    return cfg;
  } catch {
    return { profiles: {}, active: 'direct', rules: [] };
  }
}

export function saveProxyConfig(cfg: ProxyConfig): void {
  ensureKbHome();
  fs.writeFileSync(PROXIES_PATH, JSON.stringify(cfg, null, 2));
}

export function resolveProfile(cfg: ProxyConfig, name: string): ProxyProfile {
  if (name === 'direct') return DIRECT;
  const profile = cfg.profiles[name];
  if (!profile) throw new Error(`プロキシプロファイル "${name}" は存在しません。kb proxy list で確認してください。`);
  return profile;
}
