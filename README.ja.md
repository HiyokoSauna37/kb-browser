# kb — CLI Browser

**すべての操作を CLI から行えるブラウザ。** Playwright + Chromium (CDP) ベース。

English version: [README.md](README.md)

GUI ブラウザが持つ機能 — ページのレンダリング、Cookie 管理、DevTools 操作(Network / Console / Elements)— を `kb` コマンドで扱えます。FoxyProxy 風のプロキシプロファイル管理(**ブラウザ無再起動の即時切替**、ホスト別振り分けルール)を内蔵。Claude Code などの AI エージェントから Bash / MCP 経由で操作することを想定しつつ、ウィンドウは本物の Chrome なので人間の手動操作といつでも併用できます。

## 特徴

- **デーモン常駐** — ブラウザは起動しっぱなし。各 CLI コマンドは数十 ms で返る
- **本物の Chrome** — インストール済み Chrome/Edge を使用(DRM も有効)。なければ同梱 Chromium にフォールバック
- **エージェント最適化** — `kb snapshot` が要素 ref 付きアクセシビリティツリーを返し、`kb click --ref e12` で確実に操作(iframe 内も対応)。再レンダで ref が失効しても同じ role/name の要素へ**自動再解決**。text / html / snapshot は既定 20000 文字で切り詰め、`--offset` で続きを取得。`kb eval` は await・複数行コードもそのまま実行可
- **ターミナルから DevTools** — ネットワークログ / レスポンス本文の取得 (`kb net body`) / リクエスト遮断 / レスポンスモック / HAR 記録 / コンソール / DOM 検査
- **ミニ REST クライアント** — `kb request` でページを開かずに API を直接叩ける。Cookie とプロキシ設定はブラウザと共有(ログイン済みの API をそのまま呼べる)
- **プロキシプロファイル** — `host:port`(+認証)を名前付きで保存、無再起動で即時切替。特定ホストだけ特定プロキシへ(FoxyProxy 風ルール)。Chromium 非対応の SOCKS5 認証は内蔵中継が代行(中継自体もトークン認証で保護)
- **headed ⇄ headless / プロファイル切替** — タブと Cookie は復元される
- **ログイン状態の永続化** — 一度サインインすればプロファイルに自動保存され、次回以降も維持。`kb login` で手動サインインの流れをコマンド一つに。`kb storage dump / restore` でファイルへの持ち出しも可
- **人間との協調** — 自動操作中でもログインや CAPTCHA はユーザーがウィンドウで直接操作し、`kb wait` で完了を検知して再開
- **MCP サーバ** — `kb-mcp` が 22 ツールを公開(スクリーンショットは画像で返る)
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
kb snapshot                # 要素 ref 付きのページ構造(操作対象を探す)
kb click --ref e6          # ref で確実にクリック
kb screenshot -o s.png     # スクリーンショット
kb daemon stop             # ブラウザごと終了
```

デフォルトは headed(ウィンドウ表示)。Cookie・ログイン状態は `~/.kb/profiles/` に永続化されます。

## コマンド一覧

| 分類 | コマンド |
|---|---|
| デーモン | `kb daemon start [--headless] [--profile <n>] / stop / status` |
| ページ | `kb open <url> [-n] [--wait idle]` / `kb tabs [close/switch <id>]` / `kb text` / `kb html` / `kb snapshot` / `kb screenshot [<sel>\|--ref e12] [-f] [--timeout <sec>]`(要素単位も可)/ `kb pdf`(headless のみ) |
| ナビゲーション | `kb back` / `kb forward` / `kb reload` / `kb scroll [--to <sel>/--bottom]` |
| 操作 | `kb click` / `kb fill` / `kb select [--label]` / `kb check` / `kb uncheck` / `kb hover` / `kb upload <sel> <ローカルファイルパス...>` / `kb press <key>` / `kb eval <js> [--file f.js]`(await・複数行可、最後の式の値が返る)— 対象は CSS セレクタ、`--ref e12`(snapshot の ref)、`--frame <sel>`(iframe 内)で指定 |
| HTTP | `kb request <url> [-X POST] [-H "Name: value"] [-d body \| --data-file f] [-o file]`(ページ非依存。Cookie・プロキシはブラウザと共有) |
| ログイン | `kb login [url] [--until <glob>] [--save <file>]`(手動サインイン → 状態はプロファイルに自動保存) |
| Cookie / セッション | `kb cookies [list/get/set/rm/clear/export/import]` / `kb storage dump/restore` |
| ダウンロード | `kb downloads [list/clear]`(`~/.kb/downloads/` に自動保存) |
| Network | `kb net log [-f] [--filter re]` / `kb net body <seq>`(レスポンス本文)/ `kb net block <glob>` / `kb net mock <glob> --body f` / `kb net har start/stop` |
| Console | `kb console [-f]` |
| DOM | `kb dom query <sel> [--html] [--attr name] [--frame <sel>]` |
| プロキシ | `kb proxy add/rm/list/use/off/status/test` / `kb proxy rule add/rm/list` |
| モード / プロファイル | `kb mode headed\|headless` / `kb profile list/use <n>`(タブ・Cookie は復元) |
| 認証 | `kb auth set <user> <pass>` / `kb auth clear`(対象サイトの Basic 認証) |
| 待機 | `kb wait [--url <glob>] [--selector <sel>] [--idle] [--any]`(複数条件は既定 AND、`--any` で OR) |
| エミュレーション | `kb emulate ua/viewport/tz/geo/net/reset`(net: offline/slow3g/fast3g) |

長文出力(text / html / snapshot)は既定 20000 文字で切り詰められ、`--offset <n>` で続き、`--max-chars 0` で全文を取得できます。

## ログイン状態の維持

**サインインは一度だけ。** kb は永続プロファイル(`~/.kb/profiles/`)でブラウザを起動するため、Cookie・localStorage はデーモンを再起動しても残ります。よく使うサービスへの初回サインインは `kb login` で:

```bash
kb login github.com          # headed に切り替えて開く → ウィンドウでサインイン → Enter で完了確認
kb login myapp.example.com --until "**/dashboard**"   # URL で完了を自動検知(エージェント向け)
kb login github.com --save gh-state.json              # ついでにファイルへバックアップ
```

以降のセッションでは何もしなくてもログイン済みの状態で始まります。`--save` したファイルは `kb storage restore <file>` で別プロファイルや別マシンに持ち込めます。

注意: 有効期限のない session cookie だけを使うサイトは、ブラウザの再起動でサインアウトされます(通常のブラウザと同じ挙動)。その場合も `kb storage dump / restore` で状態を引き継げます。

## API デバッグ

自作サイトの API が想定外の値を返したときは、HAR を回さなくてもその場で本文を読めます:

```bash
kb net log --filter "api"    # 行頭の #seq を確認
kb net body 42               # そのレスポンス本文を表示(JSON もそのまま読める)
```

本文はテキスト系(JSON / HTML / JS / XML 等)の XHR / fetch / document レスポンスについて自動で捕捉されます。捕捉は **1 件 256KB で切り詰め**(全体 32MB / 500 件、古い順に破棄)。`--offset` は捕捉済みの範囲内のページングで、256KB を超えた部分は後から取り戻せません — 大きなレスポンスの全文が必要なときは `kb request <url> -o <file>` で取り直してください。

開発中のエンドポイントを直接叩くには `kb request`(ミニ REST クライアント):

```bash
kb request localhost:3000/api/users                    # GET
kb request localhost:3000/api/users -X POST \
  -H "Content-Type: application/json" -d '{"name":"a"}'
kb request api.example.com/v2/me -H "Accept: application/vnd.api+json" -H "X-Api-Version: 2"
```

ページを開く必要はなく、**Cookie とプロキシ設定はブラウザと共有**されます — ブラウザでログイン済みなら認証付き API もそのまま呼べ、レスポンスの Set-Cookie もブラウザに反映されます。バイナリは `-o <file>` で保存できます。

## プロキシプロファイル (FoxyProxy 風)

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 --user u --pass p --bypass "*.internal"
kb proxy use work                              # ブラウザ無再起動で即時切替
kb proxy rule add "*.corp.example.com" work    # このホストだけ work 経由(先勝ち)
kb proxy test                                  # 外部 IP と応答時間で疎通確認
kb proxy status                                # デーモンに実際に適用中の状態
```

仕組み: Chromium は常にデーモン内のローカル中継プロキシを向き、切替時は中継の上流だけを差し替えます。このため再起動不要で、Chromium が非対応の SOCKS5 認証も中継層が代行できます。中継自体もセッション毎のトークンで認証され、他のローカルプロセスからは利用できません。

よくある上流の繋ぎ方の実例:

```bash
# 会社プロキシ配下で作業する(認証付き、社内ホストは直結)
kb proxy add corp --type http --host proxy.corp.example.com --port 8080 \
  --user myuser --pass mypass --bypass "*.internal,localhost"
kb proxy use corp

# ローカルの mitmproxy / モックサーバ越しに開発する
kb proxy add local --type http --host 127.0.0.1 --port 8081
kb proxy use local     # 無再起動で即時切替
kb proxy off           # 直結に戻す(これも無再起動)
```

## AI エージェントから使う

**Claude Code からは MCP 経由を推奨** — ネイティブツールとして呼べるため、Bash 出力のパースが不要になります:

```bash
claude mcp add kb -- kb-mcp
```

`kb_snapshot` `kb_open` `kb_text` `kb_screenshot`(画像で返る)`kb_click` `kb_fill` `kb_select` `kb_eval` `kb_request` `kb_net_log` `kb_net_body` `kb_proxy_use` など 22 ツールを公開。

**Bash 経由**でも全機能を使えます(全コマンド `--json` 対応、成功 `{ok:true,result}` / 失敗 `{ok:false,error}` の対称形)。推奨ループ:

```bash
kb open example.com --wait idle   # SPA は idle 待ち
kb snapshot                       # ref 付きで構造を把握
kb click --ref e12                # ref で操作(操作後の URL/タイトルが返る)
kb text                           # 結果を読む
```

**往復を減らす一発操作**: 対象がテキストで特定できるなら snapshot を挟まず Playwright のセレクタエンジンをそのまま使えます:

```bash
kb click "text=保存"                       # テキスト一致で 1 コマンド
kb click "role=button[name='Save']"        # ロール + アクセシブルネーム
```

ref 使用時も、ページの再レンダで ref が失効した場合は同じ role/name の要素へ自動再解決されるため、snapshot の取り直しは失敗時だけで済みます。

**手動介入との連携**: ログインや CAPTCHA はユーザーがウィンドウで直接操作し、エージェントは `kb wait --url "**dashboard**"` で完了を検知して再開できます。初回サインインの段取りは `kb login` にまとまっています。

## アーキテクチャ

```
kb (CLI) ──HTTP+token──▶ デーモン ── Playwright persistent context ──▶ Chrome/Edge/Chromium
kb-mcp (MCP stdio) ──┘      └─ ローカル中継プロキシ(token 認証)──▶ 上流プロキシ (profiles/rules)
```

状態は `~/.kb/`(daemon.json / proxies.json / profiles/ / downloads/ / daemon.log)。

## 開発

```bash
npm test    # ビルド + ユニットテスト (node:test)
```

## License

MIT
