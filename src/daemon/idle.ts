/**
 * アイドル自動終了(idle reaper)。
 *
 * デーモンは detached + unref で切り離し起動され、明示的な `kb daemon stop` まで死なない。
 * 常駐ブラウザ本体がメモリコストの大半なので、最後の活動から一定時間 RPC もページ活動も
 * なければデーモン自身が graceful shutdown してリークを防ぐ(MCP が SIGKILL されても、
 * KB_HOME 隔離のテストデーモンでも等しく効く、漏れない安全網)。
 *
 * 「活動」= RPC 受信 + ページのネットワーク/コンソール活動。headed でユーザーが直接
 * ウィンドウを操作(リンククリック等でナビゲーション)している間はページ活動が出るため
 * 延命される。逆に裏で定期ポーリングし続けるページは延命され得るが、これは「読んでいる
 * ユーザーを殺さない」ための保守的なトレードオフ(既定閾値は 30 分と長め)。
 */

/** 既定のアイドルタイムアウト(分)。headed で読んでいる最中に殺さないよう保守的に長め。 */
export const DEFAULT_IDLE_MINUTES = 30;

/** 最初に現れる非空文字列を返す(引数 → 環境変数の優先順で使う)。 */
function firstPresent(...values: (string | undefined)[]): string | undefined {
  for (const v of values) if (v != null && v !== '') return v;
  return undefined;
}

/**
 * アイドルタイムアウトを ms で解決する。返り値 0 は「無効(自動終了しない)」。
 * 優先順: `--idle-timeout` 引数(秒) > `KB_IDLE_TIMEOUT` 環境変数(秒) > 既定(分)。
 * どちらの値も単位は秒。明示 0 は無効化、負値・非数は既定へフォールバックする。
 */
export function resolveIdleTimeoutMs(
  argSec?: string,
  envSec?: string,
  defaultMinutes = DEFAULT_IDLE_MINUTES,
): number {
  const raw = firstPresent(argSec, envSec);
  if (raw == null) return defaultMinutes * 60_000;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec < 0) return defaultMinutes * 60_000;
  return Math.round(sec * 1000); // sec === 0 → 0(無効)
}

/**
 * 最後の活動からの経過を監視し、閾値超過でコールバックを一度だけ呼ぶ。
 * タイマーは unref するので、他の shutdown 経路(SIGINT / ウィンドウ手動クローズ等)を
 * 阻害しない。timeoutMs <= 0 のときは完全に無効(start は何もしない)。
 */
export class IdleReaper {
  private lastActivity: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = false;
  private readonly checkMs: number;

  /**
   * 使用中判定(main.ts が設定)。true の間は閾値を超えても発火を保留する。
   * `kb wait` 等の長時間 RPC は受信時にしか touch されないため、閾値がその実行時間より
   * 短いと実行中に刈り取られてしまう — それを in-flight RPC の存在で防ぐ。
   * 契約: busy 解除側(RPC 完了時)が touch してタイマーを起点し直すこと。
   */
  isBusy: () => boolean = () => false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
    now: number = Date.now(),
  ) {
    this.lastActivity = now;
    // タイムアウトの半分程度の間隔で確認する(短いテスト閾値でも素早く反応し、
    // 長い本番閾値でも過度にタイマーを回さない)。最小 250ms・最大 30 秒でクランプ。
    this.checkMs = Math.min(Math.max(Math.floor(timeoutMs / 2), 250), 30_000);
  }

  get enabled(): boolean {
    return this.timeoutMs > 0;
  }

  /** 何らかの活動を記録して idle 判定をリセットする。 */
  touch(now: number = Date.now()): void {
    this.lastActivity = now;
  }

  /** 純関数的な idle 判定(テスト用)。timeoutMs <= 0(無効)なら常に false。 */
  isIdle(now: number = Date.now()): boolean {
    return this.timeoutMs > 0 && now - this.lastActivity >= this.timeoutMs;
  }

  /** 監視を開始する。無効(timeoutMs <= 0)または開始済みなら何もしない。 */
  start(): void {
    if (this.timeoutMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (this.fired || this.isBusy() || !this.isIdle()) return;
      this.fired = true;
      this.stop();
      this.onIdle();
    }, this.checkMs);
    // Node のタイマーのみ unref を持つ(テストで差し替えても壊れないよう optional 呼び)
    this.timer.unref?.();
  }

  /** 監視を止める(shutdown 経路から呼んで多重発火を防ぐ)。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
