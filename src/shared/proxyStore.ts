import fs from 'node:fs';
import path from 'node:path';
import { KB_HOME, ensureKbHome } from './paths';

export const PROXIES_PATH = path.join(KB_HOME, 'proxies.json');

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
