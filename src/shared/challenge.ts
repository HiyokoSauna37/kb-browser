/**
 * bot 対策チャレンジの判定と、セッション状態の判決(いずれも純関数)。
 *
 * 目的は「403 を *対象パスが保護されている証拠* として読む」誤りを機械的に防ぐこと。
 * そのために **status(ブロックされたか)と challenge(bot 対策の中間ページか)を分けて**
 * 扱い、さらに対象 URL 単独ではなくトップページ(対照)と API の結果と突き合わせて判決する。
 */

export type ChallengeVendor = 'cloudflare' | 'datadome' | 'akamai' | 'perimeterx' | 'incapsula' | 'unknown';

export interface ChallengeSignal {
  challenged: boolean;
  vendor?: ChallengeVendor;
  /** そう判定した根拠(証拠としてそのまま出力する)。 */
  marker?: string;
}

/** ブロック相当のステータス(チャレンジとは区別する)。 */
export function isBlockedStatus(status?: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 503;
}

/**
 * レスポンスが bot 対策のチャレンジ/インタースティシャルかを判定する。
 * **ステータスだけでは challenged にしない**(アプリ由来の 403 と区別できなくなるため)。
 */
export function detectChallenge(input: {
  status?: number;
  headers?: Record<string, string>;
  title?: string;
  body?: string;
}): ChallengeSignal {
  const headers = input.headers ?? {};
  const header = (name: string) => headers[name] ?? headers[name.toLowerCase()];
  const hay = `${input.title ?? ''}\n${input.body ?? ''}`;

  // Cloudflare: cf-mitigated ヘッダは「チャレンジで止めた」の一次情報
  const cfMitigated = header('cf-mitigated');
  if (cfMitigated) return { challenged: true, vendor: 'cloudflare', marker: `cf-mitigated: ${cfMitigated}` };

  const patterns: { vendor: ChallengeVendor; re: RegExp; label: string }[] = [
    { vendor: 'cloudflare', re: /challenges\.cloudflare\.com/i, label: 'challenges.cloudflare.com (Turnstile iframe)' },
    { vendor: 'cloudflare', re: /Just a moment/i, label: '"Just a moment…" (Cloudflare interstitial)' },
    { vendor: 'cloudflare', re: /cf_chl_opt|__cf_chl|cf-challenge/i, label: 'cf_chl_* (Cloudflare challenge script)' },
    { vendor: 'cloudflare', re: /Attention Required!/i, label: '"Attention Required!" (Cloudflare block)' },
    { vendor: 'cloudflare', re: /Verifying you are human/i, label: '"Verifying you are human"' },
    { vendor: 'datadome', re: /datadome|dd_cookie|geo\.captcha-delivery\.com/i, label: 'DataDome captcha' },
    { vendor: 'perimeterx', re: /px-captcha|_pxhd|PerimeterX/i, label: 'PerimeterX captcha' },
    { vendor: 'incapsula', re: /Incapsula incident|_Incapsula_Resource/i, label: 'Imperva/Incapsula block' },
    { vendor: 'akamai', re: /Access Denied[\s\S]{0,200}Reference #/i, label: 'Akamai "Access Denied / Reference #"' },
  ];
  for (const p of patterns) {
    if (p.re.test(hay)) return { challenged: true, vendor: p.vendor, marker: p.label };
  }

  if (header('x-datadome')) return { challenged: true, vendor: 'datadome', marker: 'x-datadome ヘッダ' };
  if (header('x-iinfo')) return { challenged: true, vendor: 'incapsula', marker: 'x-iinfo ヘッダ' };

  return { challenged: false };
}

export type SessionVerdict =
  /** 対象は普通に見えている。 */
  | 'ok'
  /** クライアント側(Cookie / チャレンジ通過状態)の問題。対象の 403 を証拠にしてはいけない。 */
  | 'degraded'
  /** HTML はチャレンジされるが API は通る(ルールセットが別)。 */
  | 'degraded-html-only'
  /** 対照は正常で対象だけがブロック = 対象パスの性質として読める。 */
  | 'target-protected'
  /** そのホストの Cookie が 1 つもない(未ログイン / 未通過)。 */
  | 'no-session'
  /** HTTP は正常でも呼び出し側が要求したログイン済み要素が見つからない。 */
  | 'expectation-failed'
  /** そもそも到達できない。 */
  | 'unreachable';

export interface ProbeOutcome {
  label: 'root' | 'target' | 'api';
  status?: number;
  challenged: boolean;
  error?: string;
}

/**
 * プローブ結果から判決を出す。
 * root(トップページ = 対照)と target の**対比**が判定の中心で、
 * api は「HTML だけが弾かれている」ケースを切り分けるために使う。
 */
export function judgeSession(probes: ProbeOutcome[], opts: { hasCookies: boolean }): { verdict: SessionVerdict; hint: string } {
  const byLabel = (l: ProbeOutcome['label']) => probes.find((p) => p.label === l);
  const root = byLabel('root');
  const target = byLabel('target');
  const api = byLabel('api');
  const bad = (p?: ProbeOutcome) => !!p && (p.challenged || isBlockedStatus(p.status));
  const good = (p?: ProbeOutcome) => !!p && !p.error && !p.challenged && !isBlockedStatus(p.status);

  // 対象が測れていないなら、他の材料が何であれ判定しない(ここを素通りさせると
  // 「測れなかった」が「問題なし」に化ける — この機能が防ぎたい誤報そのもの)。
  if (!target || target.error) {
    const rootReachable = root && !root.error;
    return {
      verdict: 'unreachable',
      hint:
        `対象 URL に到達できませんでした(${target?.error ?? 'プローブなし'})。` +
        (rootReachable
          ? 'トップページには到達できているので、URL の綴りか対象固有の接続問題を疑ってください。'
          : 'プロキシ / DNS / ネットワークを確認してください。'),
    };
  }

  if (!bad(target)) {
    return { verdict: 'ok', hint: '対象は正常に応答しています。この応答はそのまま証拠として読めます。' };
  }

  // Cookie が皆無 = 「まだセッションを作っていない」。ただしこれを主判定にしてよいのは
  // クライアント側が疑わしいとき(対照も弾かれている / チャレンジが出ている)だけ。
  // Cookie を使わないサイトの素直な 403 まで no-session と言うと、無意味な kb login に誘導してしまう。
  const noSession = !opts.hasCookies && (bad(root) || target.challenged);
  if (noSession) {
    return {
      verdict: 'no-session',
      hint: 'このホストの Cookie が 1 つもありません。未ログイン、またはチャレンジを一度も通していない状態です。kb login <url> を実行してから測り直してください。',
    };
  }

  if (good(api) && !good(root)) {
    return {
      verdict: 'degraded-html-only',
      hint: 'HTML はチャレンジ/ブロックされていますが API は通っています(HTML と API でルールセットが別)。HTML 側の 403 を根拠に「このパスは保護されている」と結論しないでください。',
    };
  }

  if (bad(root)) {
    return {
      verdict: 'degraded',
      hint: 'トップページ(対照)も同じく弾かれています = クライアント側のセッション劣化です。対象の 403 を「保護されている証拠」として読まないでください。kb login <url> で人が 1 回チャレンジを通す(cf_clearance がプロファイルに永続化されます)か、--cdp で実 Chrome にアタッチしてください。',
    };
  }

  if (target.challenged) {
    return {
      verdict: 'degraded',
      hint: 'トップページは正常ですが、対象 URL で bot 対策のチャレンジが出ています(パス単位のルール or レート制限)。アプリの認可による 403 ではないため、権限の証拠には使えません。',
    };
  }

  return {
    verdict: 'target-protected',
    hint:
      `トップページ(対照)は正常で、対象だけが ${target.status ?? '?'} です。クライアント状態は正常なので、この応答は対象パスの性質として読めます。` +
      (opts.hasCookies
        ? ''
        : ' ただしこのホストの Cookie は 0 件(= 匿名アクセス)なので、単に未ログインで弾かれている可能性があります。ログイン後に測り直すと切り分けられます。'),
  };
}
