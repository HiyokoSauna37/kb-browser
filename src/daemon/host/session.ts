import crypto from 'node:crypto';
import type { BrowserContext, Page, Response } from 'playwright';
import {
  detectChallenge,
  judgeSession,
  type ChallengeVendor,
  type ProbeOutcome,
  type SessionVerdict,
} from '../../shared/challenge';
import { readCookieSeen, writeCookieSeen, type CookieSeenStore } from '../../shared/paths';
import type { SignupSessionCheck, SignupSessionProbe } from '../../shared/signup';
import {
  diagnoseBrowserIdentity,
  type BrowserIdentityDiagnostic,
  type BrowserUserAgentData,
} from '../../shared/browserIdentity';

/**
 * `kb session check` の実装。
 *
 * **プローブは必ず実タブ(Chromium)から撃つ**。`context.request` は Playwright 側の HTTP
 * スタックでブラウザの TCP/TLS を通らないため、Cloudflare 等の相手だと「ブラウザでは 200 なのに
 * プローブだけ 403」という *新しい偽陰性* を作ってしまう。ここで測りたいのはまさに
 * 「ブラウザのセッションが生きているか」なので、経路を変えてはいけない。
 */

/** チャレンジ判定に使う本文の先頭サイズ(チャレンジページは小さい)。 */
const BODY_SNIFF = 8_000;
/** チャレンジを検出したあと「自動で通過するか」を見る猶予。 */
const SETTLE_MS = 6_000;
const SETTLE_POLL_MS = 500;
/** cookie-seen ストアの保持件数。 */
const SEEN_MAX = 1_000;

export interface SessionProbe extends SignupSessionProbe {
  label: 'root' | 'target' | 'api';
  url: string;
  /** リダイレクト後に実際に表示された URL。ログイン画面へ戻された等の判定材料。 */
  finalUrl?: string;
  /** 呼び出し側が指定した「ログイン済みページにだけある要素」の可視性。target probe のみ。 */
  expectSelector?: string;
  selectorMatched?: boolean;
  selectorError?: string;
  /** navigate = 実タブのナビゲーション / fetch = ページ内 fetch(アプリと同じ経路)。 */
  via: 'navigate' | 'fetch';
  status?: number;
  challenged: boolean;
  vendor?: ChallengeVendor;
  /** チャレンジと判定した根拠。 */
  marker?: string;
  title?: string;
  ms: number;
  /** チャレンジが出たが猶予内に自動通過した場合、その所要 ms。 */
  settledAfterMs?: number;
  error?: string;
}

export interface SessionCookieInfo {
  name: string;
  domain: string;
  /** 期限までの秒数。セッション Cookie は null。 */
  expiresIn: number | null;
  /** kb がこの値を最初に観測してからの秒数(今回が初観測なら 0)。 */
  ageSeen: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface SessionCheckResult extends SignupSessionCheck {
  host: string;
  probes: SessionProbe[];
  cookies: SessionCookieInfo[];
  cookieCount: number;
  verdict: SessionVerdict;
  hint: string;
  identity: BrowserIdentityDiagnostic;
}

/** セッション性を持つ(= 劣化診断に効く)Cookie 名。値は決して出力しない。 */
const SESSIONISH_RE = /^(cf_clearance|__cf_bm|_cfuvid|.*(session|sess|sid|token|auth|jwt|login|csrf|xsrf).*)$/i;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

/** 値そのものは保存せず、変化検知のための短いハッシュだけを持つ。 */
function valueHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * cookie-seen ストアを更新し、各 Cookie の「kb が最初にこの値を見てからの経過秒」を返す(純関数)。
 * 値が変われば firstSeen をリセットする(= 新しい cf_clearance が発行された、を検出できる)。
 */
export function mergeCookieSeen(
  store: CookieSeenStore,
  profile: string,
  cookies: { name: string; domain: string; value: string }[],
  nowMs: number,
): { store: CookieSeenStore; ages: Map<string, number> } {
  const next: CookieSeenStore = { ...store };
  const ages = new Map<string, number>();
  for (const c of cookies) {
    const key = `${profile}|${c.domain}|${c.name}`;
    const hash = valueHash(c.value);
    const prev = next[key];
    if (prev && prev.hash === hash) {
      ages.set(key, Math.max(0, Math.round((nowMs - Date.parse(prev.firstSeen)) / 1000)) || 0);
    } else {
      next[key] = { hash, firstSeen: new Date(nowMs).toISOString() };
      ages.set(key, 0);
    }
  }
  // 保持件数を超えたら firstSeen が古いものから捨てる(診断用の付加情報なので失っても害はない)
  const keys = Object.keys(next);
  if (keys.length > SEEN_MAX) {
    keys
      .sort((a, b) => Date.parse(next[a].firstSeen) - Date.parse(next[b].firstSeen))
      .slice(0, keys.length - SEEN_MAX)
      .forEach((k) => delete next[k]);
  }
  return { store: next, ages };
}

/** 実タブでナビゲートして status とチャレンジ有無を測る。 */
async function navigateProbe(
  page: Page,
  label: SessionProbe['label'],
  url: string,
  timeout: number,
  expectSelector?: string,
): Promise<SessionProbe> {
  const started = Date.now();
  // チャレンジが自動通過するとページは別ドキュメントへ遷移するため、
  // goto の戻り値ではなく「最後に見たメインフレームの document レスポンス」を採用する。
  // (コールバック内の代入は TS の制御フロー解析に見えないので holder に入れる)
  const doc: { last: { status: number; headers: Record<string, string> } | null } = { last: null };
  const capture = (res: Response) => {
    try {
      if (res.request().resourceType() === 'document' && res.frame() === page.mainFrame()) {
        doc.last = { status: res.status(), headers: res.headers() };
      }
    } catch {
      /* 遷移中に frame が消えることがある */
    }
  };
  page.on('response', capture);
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      // Chromium は本文のない 4xx/5xx を net::ERR_HTTP_RESPONSE_CODE_FAILURE として投げる。
      // レスポンス自体は受け取っているので、捕捉済みのものがあれば「到達不能」にせず続行する
      // (ここで諦めると 403 が unreachable に化けて、判定の土台が崩れる)。
      if (!doc.last) throw e;
    }
    const read = async () => ({
      title: await page.title().catch(() => ''),
      body: (await page.content().catch(() => '')).slice(0, BODY_SNIFF),
    });
    let { title, body } = await read();
    let sig = detectChallenge({ status: doc.last?.status, headers: doc.last?.headers, title, body });
    let settledAfterMs: number | undefined;

    // チャレンジを検出したら、猶予内に自動通過しないかを見る(通過するなら劣化ではない)
    if (sig.challenged) {
      const deadline = Date.now() + SETTLE_MS;
      while (Date.now() < deadline) {
        await page.waitForTimeout(SETTLE_POLL_MS);
        ({ title, body } = await read());
        const again = detectChallenge({ status: doc.last?.status, headers: doc.last?.headers, title, body });
        if (!again.challenged) {
          settledAfterMs = Date.now() - started;
          sig = again;
          break;
        }
      }
    }
    let selectorMatched: boolean | undefined;
    let selectorError: string | undefined;
    if (expectSelector) {
      try {
        await page.locator(expectSelector).first().waitFor({ state: 'visible', timeout });
        selectorMatched = true;
      } catch (e) {
        selectorMatched = false;
        selectorError = errMsg(e);
      }
    }
    return {
      label,
      url,
      finalUrl: page.url(),
      via: 'navigate',
      status: doc.last?.status,
      challenged: sig.challenged,
      vendor: sig.vendor,
      marker: sig.marker,
      title,
      ms: Date.now() - started,
      ...(expectSelector ? { expectSelector, selectorMatched, ...(selectorError ? { selectorError } : {}) } : {}),
      ...(settledAfterMs != null ? { settledAfterMs } : {}),
    };
  } catch (e) {
    return { label, url, via: 'navigate', challenged: false, ms: Date.now() - started, error: errMsg(e) };
  } finally {
    page.off('response', capture);
  }
}

/**
 * ページ内 fetch で API を叩く(アプリ自身と同じ経路 = Cookie・TLS・ヘッダがブラウザのもの)。
 * 同一オリジンならレスポンスヘッダも全部読める。
 */
async function fetchProbe(page: Page, url: string, timeout: number): Promise<SessionProbe> {
  const started = Date.now();
  try {
    const r = await page.evaluate(
      async ([target, timeoutMs]) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs));
        try {
          const res = await fetch(String(target), { credentials: 'include', signal: ctrl.signal });
          const text = await res.text().catch(() => '');
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });
          return { status: res.status, headers, body: text.slice(0, 8_000) };
        } catch (e) {
          return { error: String(e) };
        } finally {
          clearTimeout(timer);
        }
      },
      [url, timeout] as [string, number],
    );
    if ('error' in r && r.error) return { label: 'api', url, via: 'fetch', challenged: false, ms: Date.now() - started, error: r.error };
    const ok = r as { status: number; headers: Record<string, string>; body: string };
    const sig = detectChallenge({ status: ok.status, headers: ok.headers, body: ok.body });
    return {
      label: 'api',
      url,
      via: 'fetch',
      status: ok.status,
      challenged: sig.challenged,
      vendor: sig.vendor,
      marker: sig.marker,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { label: 'api', url, via: 'fetch', challenged: false, ms: Date.now() - started, error: errMsg(e) };
  }
}

/**
 * セッション状態を診断する。root(対照)→ target →(あれば)api の順に実タブで撃ち、
 * 対比で判決を出す。プローブ用のタブは使い捨て(ユーザーのタブ ID は動かさない)。
 */
export async function checkSession(
  context: BrowserContext,
  opts: {
    url: string;
    apiUrl?: string;
    expectSelector?: string;
    timeoutMs: number;
    profile: string;
    configuredUserAgent?: string;
  },
): Promise<SessionCheckResult> {
  const target = new URL(opts.url);
  const rootUrl = `${target.origin}/`;
  const page = await context.newPage();
  const probes: SessionProbe[] = [];
  let identity = diagnoseBrowserIdentity({ userAgent: '' }, opts.configuredUserAgent);
  try {
    probes.push(await navigateProbe(page, 'root', rootUrl, opts.timeoutMs));
    // Chromium は low-entropy UA Client Hints を secure context でだけ公開するため、
    // about:blank ではなく root probe の遷移後に読む。診断取得の失敗だけで check 本体は止めない。
    const effectiveIdentity = await page
      .evaluate(() => {
        const nav = navigator as Navigator & {
          userAgentData?: {
            brands?: { brand: string; version: string }[];
            mobile?: boolean;
            platform?: string;
          };
        };
        const data = nav.userAgentData;
        const userAgentData: BrowserUserAgentData | undefined = data
          ? {
              brands: Array.isArray(data.brands)
                ? data.brands.map(({ brand, version }) => ({ brand, version }))
                : [],
              mobile: data.mobile,
              platform: data.platform,
            }
          : undefined;
        return { userAgent: nav.userAgent, ...(userAgentData ? { userAgentData } : {}) };
      })
      .catch(() => undefined);
    if (effectiveIdentity) {
      identity = diagnoseBrowserIdentity(effectiveIdentity, opts.configuredUserAgent);
    }
    probes.push(await navigateProbe(page, 'target', opts.url, opts.timeoutMs, opts.expectSelector));
    if (opts.apiUrl) {
      const sameOrigin = (() => {
        try {
          return new URL(opts.apiUrl!).origin === target.origin;
        } catch {
          return false;
        }
      })();
      // 同一オリジンならアプリと同じ経路(ページ内 fetch)、別オリジンはナビゲーションで測る
      probes.push(sameOrigin ? await fetchProbe(page, opts.apiUrl, opts.timeoutMs) : await navigateProbe(page, 'api', opts.apiUrl, opts.timeoutMs));
    }
  } finally {
    await page.close().catch(() => {});
  }

  // 対象 URL に実際に送られる Cookie(Playwright が domain/path/secure を考慮して返す)
  const jar = await context.cookies(opts.url).catch(() => []);
  const now = Date.now();
  const { store, ages } = mergeCookieSeen(readCookieSeen(), opts.profile, jar, now);
  writeCookieSeen(store);
  const cookies: SessionCookieInfo[] = jar
    .filter((c) => SESSIONISH_RE.test(c.name))
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      expiresIn: c.expires > 0 ? Math.round(c.expires - now / 1000) : null,
      ageSeen: ages.get(`${opts.profile}|${c.domain}|${c.name}`) ?? 0,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }));

  const outcomes: ProbeOutcome[] = probes.map((p) => ({ label: p.label, status: p.status, challenged: p.challenged, error: p.error }));
  let { verdict, hint } = judgeSession(outcomes, { hasCookies: jar.length > 0 });
  const targetProbe = probes.find((probe) => probe.label === 'target');
  if (opts.expectSelector && verdict === 'ok' && targetProbe?.selectorMatched !== true) {
    verdict = 'expectation-failed';
    hint = `対象の HTTP 応答は正常ですが、期待したログイン済み要素 (${opts.expectSelector}) が visible ではありません。ログイン画面・権限不足・SPA の描画失敗を確認してください。`;
  }
  return { host: target.hostname, probes, cookies, cookieCount: jar.length, verdict, hint, identity };
}
