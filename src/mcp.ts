#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rpc } from './shared/client';
import { loadProxyConfig, saveProxyConfig } from './shared/proxyStore';

/**
 * kb デーモンの機能を MCP tools として公開する stdio サーバ。
 * デーモン未起動時は最初のツール呼び出しで自動起動する。
 * 登録例: claude mcp add kb -- kb-mcp
 */

const server = new McpServer({ name: 'kb-browser', version: '0.6.0' });

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

function text(result: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

/** 切り詰められた本文に続きの読み方を付記する。 */
function withTruncNote(body: string, r: { totalChars: number; offset: number; truncated: boolean }): string {
  if (!r.truncated) return body;
  const next = r.offset + body.length;
  return `${body}\n\n…(${r.offset + 1}〜${next}/${r.totalChars} 文字を表示。続きは offset=${next} で取得)`;
}

/**
 * server.tool() の薄いラッパ。SDK の zod ジェネリクス推論が tsc のメモリを
 * 食い潰すため、型推論を切って登録する(実行時の検証は SDK 側で行われる)。
 */
function tool(
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: any) => Promise<ToolResult>,
): void {
  (server as any).tool(name, description, shape, handler);
}

/** ハンドラのエラーを MCP のツールエラーとして返す。 */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  };
}

const tab = z.number().int().optional().describe('対象タブ ID(省略時はアクティブタブ)');
const ref = z.string().optional().describe('kb_snapshot の要素 ref (例: "e12"、iframe 内は "f1e3")。selector の代わりに使える');
const frame = z.string().optional().describe('iframe の CSS セレクタ(この中で selector を解決)');

tool(
  'kb_open',
  'URL をブラウザで開く。スキーム省略時は https を補う。デーモン未起動なら自動起動する。',
  {
    url: z.string().describe('開く URL'),
    newTab: z.boolean().optional().describe('新しいタブで開く'),
    waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional().describe('待機条件 (SPA は networkidle 推奨)'),
    tab,
  },
  safe(async ({ url, newTab, waitUntil, tab }) => text(await rpc('open', { url, new: newTab, waitUntil, tab }))),
);

tool('kb_tabs', 'タブ一覧を取得する。', {}, safe(async () => text(await rpc('tabs.list'))));

tool(
  'kb_tab_close',
  'タブを閉じる。',
  { tab: z.number().int().describe('閉じるタブ ID') },
  safe(async ({ tab }) => text(await rpc('tabs.close', { tab }))),
);

tool(
  'kb_text',
  'ページ本文のテキストを取得する(ページを読むときはまずこれ)。既定 20000 文字で切り詰め。',
  {
    tab,
    maxChars: z.number().int().optional().describe('最大文字数 (0 = 無制限)'),
    offset: z.number().int().optional().describe('取得開始位置(続きを読むとき用)'),
  },
  safe(async ({ tab, maxChars, offset }) => {
    const r = await rpc('text', { tab, maxChars, offset });
    return text(withTruncNote(`# ${r.title}\n# ${r.url}\n\n${r.text}`, r));
  }),
);

tool(
  'kb_snapshot',
  'アクセシビリティスナップショットを取得する。各要素に ref (例: [ref=e12]) が付き、kb_click / kb_fill の ref に渡せる。要素を探すときはまずこれ。iframe 内の要素も含む。',
  {
    tab,
    maxChars: z.number().int().optional().describe('最大文字数 (0 = 無制限)'),
    offset: z.number().int().optional().describe('取得開始位置'),
  },
  safe(async ({ tab, maxChars, offset }) => {
    const r = await rpc('snapshot', { tab, maxChars, offset });
    return text(withTruncNote(`# ${r.title}\n# ${r.url}\n\n${r.snapshot}`, r));
  }),
);

tool(
  'kb_screenshot',
  'スクリーンショットを撮り、画像として返す。selector / ref を指定すると要素単位で撮る。',
  {
    tab,
    fullPage: z.boolean().optional().describe('ページ全体を撮る(要素指定とは併用不可)'),
    selector: z.string().optional().describe('この要素だけを撮る CSS セレクタ'),
    ref,
    frame,
  },
  safe(async ({ tab, fullPage, selector, ref, frame }) => {
    const tmp = path.join(os.tmpdir(), `kb-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
    try {
      await rpc('screenshot', { path: tmp, full: fullPage, selector, ref, frame, tab });
      const data = fs.readFileSync(tmp).toString('base64');
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }),
);

tool(
  'kb_eval',
  'ページ内で JavaScript を実行し結果を返す。await や複数行のコードもそのまま書ける(最後の式または return の値が返る)。結果は既定 20000 文字で切り詰め。',
  {
    expression: z.string().describe('実行する JavaScript(await・複数行可)'),
    maxChars: z.number().int().optional().describe('結果の最大文字数 (0 = 無制限)'),
    offset: z.number().int().optional().describe('取得開始位置'),
    tab,
  },
  safe(async ({ expression, maxChars, offset, tab }) => {
    const r = await rpc('eval', { expression, maxChars, offset, tab });
    const body = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
    return text(r.truncated ? withTruncNote(body, r) : body);
  }),
);

tool(
  'kb_click',
  'CSS セレクタまたは ref に一致する要素をクリックする。操作後の URL とタイトルを返す。',
  { selector: z.string().optional(), ref, frame, tab },
  safe(async ({ selector, ref, frame, tab }) => text(await rpc('click', { selector, ref, frame, tab }))),
);

tool(
  'kb_fill',
  'フォーム要素に値を入力する。操作後の URL とタイトルを返す。',
  { selector: z.string().optional(), ref, frame, value: z.string(), tab },
  safe(async ({ selector, ref, frame, value, tab }) => text(await rpc('fill', { selector, ref, frame, value, tab }))),
);

tool(
  'kb_select',
  '<select> 要素の項目を選ぶ(value で照合。byLabel で表示ラベル照合)。',
  {
    selector: z.string().optional(),
    ref,
    frame,
    values: z.array(z.string()).describe('選択する値(複数選択は複数指定)'),
    byLabel: z.boolean().optional().describe('value ではなく表示ラベルで照合する'),
    tab,
  },
  safe(async ({ selector, ref, frame, values, byLabel, tab }) =>
    text(await rpc('select', { selector, ref, frame, values, byLabel, tab })),
  ),
);

tool(
  'kb_press',
  'キーを押す(例: Enter, Control+A)。',
  { key: z.string(), tab },
  safe(async ({ key, tab }) => text(await rpc('press', { key, tab }))),
);

tool(
  'kb_cookies_list',
  'Cookie 一覧を取得する。',
  { domain: z.string().optional().describe('ドメインで絞り込む') },
  safe(async ({ domain }) => text(await rpc('cookies.list', { domain }))),
);

tool(
  'kb_net_log',
  'ネットワークログ(DevTools Network 相当)を取得する。',
  {
    filter: z.string().optional().describe('URL の正規表現フィルタ'),
    limit: z.number().int().optional().describe('最大件数(既定 50)'),
    tab,
  },
  safe(async ({ filter, limit, tab }) => text((await rpc('net.log', { filter, limit: limit ?? 50, tab })).entries)),
);

tool(
  'kb_net_body',
  '捕捉済みのレスポンス本文を取得する。seq は kb_net_log のエントリの seq(テキスト系の XHR/fetch/document が対象)。',
  {
    seq: z.number().int().describe('kb_net_log エントリの seq(response エントリに対して本文が捕捉される)'),
    maxChars: z.number().int().optional().describe('最大文字数 (0 = 無制限)'),
    offset: z.number().int().optional().describe('取得開始位置'),
  },
  safe(async ({ seq, maxChars, offset }) => {
    const r = await rpc('net.body', { seq, maxChars, offset });
    return text(withTruncNote(`# ${r.status} ${r.contentType} — ${r.url}\n\n${r.body}`, r));
  }),
);

tool(
  'kb_net_headers',
  '指定リクエストの全リクエスト/レスポンスヘッダを取得する(Cookie 等の CDP 追加情報も含む)。seq は kb_net_log エントリの seq。',
  { seq: z.number().int().describe('kb_net_log エントリの seq') },
  safe(async ({ seq }) => text(await rpc('net.headers', { seq }))),
);

tool(
  'kb_request',
  'ページを開かずに HTTP リクエストを送る(ミニ REST クライアント)。Cookie とプロキシ設定はブラウザと共有され、Set-Cookie も反映される。',
  {
    url: z.string().describe('リクエスト先 URL(スキーム省略時は https)'),
    method: z.string().optional().describe('HTTP メソッド(既定 GET)'),
    headers: z.record(z.string()).optional().describe('リクエストヘッダ'),
    data: z.string().optional().describe('リクエストボディ'),
    timeoutSec: z.number().optional().describe('タイムアウト秒(既定 30)'),
    maxChars: z.number().int().optional().describe('本文の最大文字数 (0 = 無制限)'),
    offset: z.number().int().optional().describe('取得開始位置'),
  },
  safe(async ({ url, method, headers, data, timeoutSec, maxChars, offset }) => {
    const r = await rpc('request', {
      url,
      method,
      headers,
      data,
      timeoutMs: (timeoutSec ?? 30) * 1000,
      maxChars,
      offset,
    });
    const head = `HTTP ${r.status} ${r.statusText} (${r.ms}ms, ${r.bytes} bytes${r.contentType ? `, ${r.contentType}` : ''})`;
    if (r.binary) return text(`${head}\n(バイナリ本文のため省略)`);
    return text(withTruncNote(`${head}\n\n${r.body}`, r));
  }),
);

tool(
  'kb_console_log',
  'ページのコンソールログ・エラーを取得する。',
  { limit: z.number().int().optional().describe('最大件数(既定 50)'), tab },
  safe(async ({ limit, tab }) => text((await rpc('console.log', { limit: limit ?? 50, tab })).entries)),
);

tool(
  'kb_dom_query',
  'CSS セレクタで DOM を検査する。',
  {
    selector: z.string(),
    html: z.boolean().optional().describe('outerHTML も含める(要素あたり 2000 文字まで)'),
    attr: z.string().optional().describe('取得する属性名'),
    limit: z.number().int().optional(),
    frame,
    tab,
  },
  safe(async ({ selector, html, attr, limit, frame, tab }) =>
    text(await rpc('dom.query', { selector, html, attr, limit, frame, tab })),
  ),
);

tool(
  'kb_wait',
  '条件を満たすまで待機する(手動ログインの完了待ちなど)。複数条件は既定 AND、any=true で OR。',
  {
    url: z.string().optional().describe('URL glob (例: "**dashboard**")'),
    selector: z.string().optional().describe('現れるまで待つ CSS セレクタ'),
    idle: z.boolean().optional().describe('ネットワークが落ち着くまで待つ (SPA の描画待ち)'),
    any: z.boolean().optional().describe('複数条件のどれか 1 つで待機を終える (OR)'),
    timeoutSec: z.number().optional().describe('タイムアウト秒(既定 90、最大 280)'),
    tab,
  },
  safe(async ({ url, selector, idle, any, timeoutSec, tab }) =>
    text(await rpc('wait', { url, selector, idle, any, timeoutMs: Math.min(timeoutSec ?? 90, 280) * 1000, tab })),
  ),
);

tool(
  'kb_proxy_list',
  'プロキシプロファイルと振り分けルールの一覧を取得する。',
  {},
  safe(async () => text(loadProxyConfig())),
);

tool(
  'kb_proxy_use',
  'プロキシプロファイルを切り替える(ブラウザ無再起動で即時適用)。',
  { name: z.string().describe('プロファイル名 ("direct" でプロキシなし)') },
  safe(async ({ name }) => {
    const cfg = loadProxyConfig();
    if (name !== 'direct' && !cfg.profiles[name]) throw new Error(`プロファイル "${name}" は存在しません`);
    cfg.active = name;
    saveProxyConfig(cfg);
    return text(await rpc('proxy.reload'));
  }),
);

tool(
  'kb_mode_set',
  '表示モードを切り替える(headed = ウィンドウあり / headless)。タブと Cookie は復元される。',
  { mode: z.enum(['headed', 'headless']) },
  safe(async ({ mode }) => text(await rpc('mode.set', { headless: mode === 'headless' }))),
);

tool('kb_status', 'デーモンの状態を取得する。', {}, safe(async () => text(await rpc('daemon.status'))));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
