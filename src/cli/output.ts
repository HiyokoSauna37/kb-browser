/** CLI 共通の出力・整形ヘルパー。--json フラグの状態もここで一元管理する。 */

import { truncSpan } from '../shared/format';

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

/** commander の小数オプション用パーサ(dpr / 緯度経度など)。 */
export const floatOpt = (v: string) => parseFloat(v);

/** click / fill 等の操作結果(移動後の URL / タイトル)を短く表示する。 */
export function fmtAction(verb: string): (r: any) => string {
  return (r) => {
    if (r.dialog) {
      const d = r.dialog;
      return `${verb} → ${d.type} ダイアログ「${d.message}」が応答待ちです (tab ${d.tab})。kb dialog accept / kb dialog dismiss で応答してください(headed ならウィンドウ上でも応答できます)`;
    }
    const heal = r.reResolvedRef ? `\n(ref ${r.reResolvedRef.from} は失効していたため ${r.reResolvedRef.to} に自動再解決して操作しました)` : '';
    return `${verb} → ${r.url}${r.title ? ` "${r.title}"` : ''}${heal}`;
  };
}

/** 切り詰め情報の注記。続きの取得方法を含める(範囲計算は MCP 側と共有)。 */
export function truncNote(r: { totalChars: number; offset: number; truncated: boolean }, shownChars: number): string {
  if (!r.truncated) return '';
  const { from, next, total } = truncSpan(r, shownChars);
  return `\n\n… (${from}〜${next}/${total} 文字を表示。続きは --offset ${next}、全文は --max-chars 0)`;
}

/** タブ一覧の整形(tabs list / mode 切替後の表示に共用)。 */
export function fmtTabs(list: any[]): string {
  return list.length
    ? list.map((t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(no title)'} — ${t.url}`).join('\n')
    : 'タブはありません';
}
