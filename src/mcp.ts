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

const server = new McpServer({ name: 'kb-browser', version: '0.1.0' });

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

function text(result: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
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

tool(
  'kb_open',
  'URL をブラウザで開く。デーモン未起動なら自動起動する。',
  { url: z.string().describe('開く URL'), newTab: z.boolean().optional().describe('新しいタブで開く'), tab },
  safe(async ({ url, newTab, tab }) => text(await rpc('open', { url, new: newTab, tab }))),
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
  'ページ本文のテキストを取得する(ページを読むときはまずこれ)。',
  { tab },
  safe(async ({ tab }) => text(await rpc('text', { tab }))),
);

tool(
  'kb_screenshot',
  'ページのスクリーンショットを撮り、画像として返す。',
  { tab, fullPage: z.boolean().optional().describe('ページ全体を撮る') },
  safe(async ({ tab, fullPage }) => {
    const tmp = path.join(os.tmpdir(), `kb-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
    try {
      await rpc('screenshot', { path: tmp, full: fullPage, tab });
      const data = fs.readFileSync(tmp).toString('base64');
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }),
);

tool(
  'kb_eval',
  'ページ内で JavaScript 式を実行し結果を返す。',
  { expression: z.string().describe('実行する JavaScript 式'), tab },
  safe(async ({ expression, tab }) => text(await rpc('eval', { expression, tab }))),
);

tool(
  'kb_click',
  'CSS セレクタに一致する要素をクリックする。',
  { selector: z.string(), tab },
  safe(async ({ selector, tab }) => text(await rpc('click', { selector, tab }).then(() => 'clicked'))),
);

tool(
  'kb_fill',
  'フォーム要素に値を入力する。',
  { selector: z.string(), value: z.string(), tab },
  safe(async ({ selector, value, tab }) => text(await rpc('fill', { selector, value, tab }).then(() => 'filled'))),
);

tool(
  'kb_press',
  'キーを押す(例: Enter, Control+A)。',
  { key: z.string(), tab },
  safe(async ({ key, tab }) => text(await rpc('press', { key, tab }).then(() => 'pressed'))),
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
    html: z.boolean().optional().describe('outerHTML も含める'),
    attr: z.string().optional().describe('取得する属性名'),
    limit: z.number().int().optional(),
    tab,
  },
  safe(async ({ selector, html, attr, limit, tab }) => text(await rpc('dom.query', { selector, html, attr, limit, tab }))),
);

tool(
  'kb_wait',
  '条件を満たすまで待機する(手動ログインの完了待ちなど)。',
  {
    url: z.string().optional().describe('URL glob (例: "**dashboard**")'),
    selector: z.string().optional().describe('現れるまで待つ CSS セレクタ'),
    timeoutSec: z.number().optional().describe('タイムアウト秒(既定 120、最大 280)'),
    tab,
  },
  safe(async ({ url, selector, timeoutSec, tab }) =>
    text(await rpc('wait', { url, selector, timeoutMs: Math.min(timeoutSec ?? 120, 280) * 1000, tab })),
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
