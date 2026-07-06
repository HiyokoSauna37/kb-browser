# kb — CLI Browser

**すべての操作を CLI から行えるブラウザ。** Playwright + Chromium (CDP) ベース。

English version: [README.md](README.md)

GUI ブラウザが持つ機能 — ページのレンダリング、Cookie 管理、DevTools 操作(Network / Console / Elements)— を `kb` コマンドで扱えます。FoxyProxy 風のプロキシプロファイル管理(**ブラウザ無再起動の即時切替**、ホスト別振り分けルール)を内蔵。Claude Code などの AI エージェントから Bash / MCP 経由で操作することを想定しつつ、ウィンドウは本物の Chrome なので人間の手動操作といつでも併用できます。

## 特徴

- **デーモン常駐** — ブラウザは起動しっぱなし。各 CLI コマンドは数十 ms で返る
- **本物の Chrome** — インストール済み Chrome/Edge を使用(DRM も有効)。なければ同梱 Chromium にフォールバック
- **ターミナルから DevTools** — ネットワークログ / リクエスト遮断 / レスポンスモック / HAR 記録 / コンソール / DOM 検査
- **プロキシプロファイル** — `host:port`(+認証)を名前付きで保存、無再起動で即時切替。特定ホストだけ特定プロキシへ(FoxyProxy 風ルール)。Chromium 非対応の SOCKS5 認証は内蔵中継が代行
- **headed ⇄ headless 切替** — タブと Cookie は復元される
- **人間との協調** — 自動操作中でもログインや CAPTCHA はユーザーがウィンドウで直接操作し、`kb wait` で完了を検知して再開
- **MCP サーバ** — `kb-mcp` が 18 ツールを公開(スクリーンショットは画像で返る)
- **全コマンド `--json`** — スクリプト・エージェント向けの機械可読出力

## インストール

```bash
npm install
npm run build
npm link        # kb / kb-mcp をグローバルに
```

ブラウザ実体はインストール済みの Chrome → Edge → Playwright 同梱 Chromium の順で自動選択されます(同梱版を使う場合のみ `npx playwright install chromium`)。

## クイックスタート

```bash
kb open example.com        # デーモン(ブラウザ)が自動起動して開く
kb text                    # 本文をテキストで読む
kb screenshot -o s.png     # スクリーンショット
kb daemon stop             # ブラウザごと終了
```

デフォルトは headed(ウィンドウ表示)。Cookie・ログイン状態は `~/.kb/profiles/` に永続化されます。

## コマンド一覧

| 分類 | コマンド |
|---|---|
| デーモン | `kb daemon start [--headless] / stop / status` |
| ページ | `kb open <url> [-n]` / `kb tabs [close/switch <id>]` / `kb text` / `kb html` / `kb screenshot [-f]` |
| 操作 | `kb click <sel>` / `kb fill <sel> <val>` / `kb press <key>` / `kb eval <js>` |
| Cookie | `kb cookies [list/set/clear]` |
| Network | `kb net log [-f] [--filter re]` / `kb net block <glob>` / `kb net mock <glob> --body f` / `kb net har start/stop` |
| Console | `kb console [-f]` |
| DOM | `kb dom query <sel> [--html] [--attr name]` |
| プロキシ | `kb proxy add/rm/list/use/off/test` / `kb proxy rule add/rm/list` |
| モード | `kb mode headed\|headless`(タブ・Cookie は復元) |
| 待機 | `kb wait [--url <glob>] [--selector <sel>]` |
| エミュレーション | `kb emulate ua/viewport/tz/geo/reset` |

## プロキシプロファイル (FoxyProxy 風)

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 --user u --pass p --bypass "*.internal"
kb proxy use work                              # ブラウザ無再起動で即時切替
kb proxy rule add "*.corp.example.com" work    # このホストだけ work 経由(先勝ち)
kb proxy test                                  # 外部 IP と応答時間で疎通確認
```

仕組み: Chromium は常にデーモン内のローカル中継プロキシを向き、切替時は中継の上流だけを差し替えます。このため再起動不要で、Chromium が非対応の SOCKS5 認証も中継層が代行できます。

## AI エージェントから使う

**Bash 経由**: デーモン常駐のため各コマンドは高速に返ります。`kb text` で読み、`kb screenshot` で見て、`kb click / fill` で操作するループ。

**MCP 経由**:

```bash
claude mcp add kb -- kb-mcp
```

`kb_open` `kb_text` `kb_screenshot`(画像で返る)`kb_eval` `kb_click` `kb_net_log` `kb_proxy_use` など 18 ツールを公開。

**手動介入との連携**: ログインや CAPTCHA はユーザーがウィンドウで直接操作し、エージェントは `kb wait --url "**dashboard**"` で完了を検知して再開できます。

## アーキテクチャ

```
kb (CLI) ──HTTP+token──▶ デーモン ── Playwright persistent context ──▶ Chrome/Edge/Chromium
kb-mcp (MCP stdio) ──┘      └─ ローカル中継プロキシ ──▶ 上流プロキシ (profiles/rules)
```

状態は `~/.kb/`(daemon.json / proxies.json / profiles/ / daemon.log)。

## License

MIT
