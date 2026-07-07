/** CLI 共通の出力・整形ヘルパー。--json フラグの状態もここで一元管理する。 */

let jsonOutput = false;

/** ルートの --json フラグを反映する(エントリの preAction hook から呼ぶ)。 */
export function setJsonOutput(value: boolean): void {
  jsonOutput = value;
}

export function isJsonOutput(): boolean {
  return jsonOutput;
}

export function print(result: unknown, human?: (r: any) => string): void {
  if (jsonOutput) {
    // 失敗時の {ok:false, error} と対称にし、機械側が常に .ok で判定できるようにする
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } else if (!human) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(human(result));
  }
}

/** action ハンドラを共通のエラー処理でラップする。 */
export function run<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => void {
  return (...args) => {
    fn(...args).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonOutput) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(`error: ${message}`);
      process.exitCode = 1;
    });
  };
}

/** commander の数値オプション用パーサ(タブ ID や件数など)。 */
export const intOpt = (v: string) => parseInt(v, 10);

/** click / fill 等の操作結果(移動後の URL / タイトル)を短く表示する。 */
export function fmtAction(verb: string): (r: any) => string {
  return (r) => {
    const heal = r.reResolvedRef ? `\n(ref ${r.reResolvedRef.from} は失効していたため ${r.reResolvedRef.to} に自動再解決して操作しました)` : '';
    return `${verb} → ${r.url}${r.title ? ` "${r.title}"` : ''}${heal}`;
  };
}

/** 切り詰め情報の注記。続きの取得方法を含める。 */
export function truncNote(r: { totalChars: number; offset: number; truncated: boolean }, shownChars: number): string {
  if (!r.truncated) return '';
  const next = r.offset + shownChars;
  return `\n\n… (${r.offset + 1}〜${next}/${r.totalChars} 文字を表示。続きは --offset ${next}、全文は --max-chars 0)`;
}

/** タブ一覧の整形(tabs list / mode 切替後の表示に共用)。 */
export function fmtTabs(list: any[]): string {
  return list.length
    ? list.map((t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(no title)'} — ${t.url}`).join('\n')
    : 'タブはありません';
}
