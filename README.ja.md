<p align="center">
  <img src="assets/banner.png" alt="kb — CLI Browser" width="760">
</p>

<p align="center">
  <b>すべての操作を CLI から行えるブラウザ。</b> Playwright + Chromium (CDP) ベース。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3ddc97.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-3ddc97.svg" alt="Node >= 18">
  <img src="https://img.shields.io/badge/Playwright-Chromium-2a3244.svg" alt="Playwright + Chromium">
  <img src="https://img.shields.io/badge/MCP-24%20tools-2a3244.svg" alt="MCP · 24 tools">
</p>

English version: [README.md](README.md)

GUI ブラウザが持つ機能 — ページのレンダリング、Cookie 管理、DevTools 操作(Network / Console / Elements)— を `kb` コマンドで扱えます。FoxyProxy 風のプロキシプロファイル管理(**ブラウザ無再起動の即時切替**、ホスト別振り分けルール)を内蔵。Claude Code などの AI エージェントから Bash / MCP 経由で操作することを想定しつつ、ウィンドウは本物の Chrome なので人間の手動操作といつでも併用できます。

> **想定している 2 つの使い方:**
> - **AI エージェントから操作** — Claude Code などのエージェントが **MCP(24 ツール)** または **Bash**(全コマンド `--json` 対応)で kb を駆動。アクセシビリティ snapshot + `--ref` のループは低トークンで確実な自動操作に最適化され、常駐デーモンにより各操作は数十 ms で返る。
> - **セキュリティ調査・バグバウンティの recon**(認可されたテスト限定)— セッション共有 HTTP、ネットワークのライブ監視/改変、認証済み SPA での生 `eval`、Burp/Caido への proxy チェーン、プロファイルによる 2 アカウント IDOR、機微値マスク済みの共有可能な証跡バンドル。詳細は [セキュリティ調査・バグバウンティの recon](#セキュリティ調査バグバウンティの-recon) を参照。

## 特徴

- **デーモン常駐** — ブラウザは起動しっぱなし。各 CLI コマンドは数十 ms で返る
- **本物の Chrome** — インストール済み Chrome/Edge を使用(DRM も有効)。なければ同梱 Chromium にフォールバック。`--channel` で明示選択、`--ua` で User-Agent 上書き、`--stealth` で(認可テスト向けに)自動化の痕跡を消して通常ブラウザとして振る舞うことも可
- **起動済みブラウザへのアタッチ** — `kb daemon start --cdp http://127.0.0.1:9222` で、`--remote-debugging-port` 付きで起動した Chrome/Edge にそのまま接続し、そのサインイン状態を再利用できる
- **Chrome 拡張機能** — `kb daemon start --extensions <拡張dir,...>` で解凍済み拡張を読み込む(`on` でプロファイルにインストール済みの拡張を有効化、`off` で解除)。詳細は [Chrome 拡張機能](#chrome-拡張機能) を参照
- **エージェント最適化** — `kb snapshot` が要素 ref 付きアクセシビリティツリーを返し、`kb click --ref e12` で確実に操作(iframe 内も対応)。再レンダで ref が失効しても同じ role/name の要素へ**自動再解決**。text / html / snapshot は既定 20000 文字で切り詰め、`--offset` で続きを取得。`kb eval` は await・複数行コードもそのまま実行可
- **ターミナルから DevTools** — ネットワークログ / レスポンス本文 (`kb net body`) / 全ヘッダ (`kb net headers`) / リクエスト遮断 / レスポンスモック(既存リクエストのエラー差し替えも)/ HAR 記録 / コンソール / DOM 検査
- **ミニ REST クライアント** — `kb request` でページを開かずに API を直接叩ける。Cookie とプロキシ設定はブラウザと共有(ログイン済みの API をそのまま呼べる)
- **プロキシプロファイル** — `host:port`(+認証)を名前付きで保存、無再起動で即時切替。特定ホストだけ特定プロキシへ(FoxyProxy 風ルール)。Chromium 非対応の SOCKS5 認証は内蔵中継が代行(中継自体もトークン認証で保護)
- **headed ⇄ headless / プロファイル切替** — タブと Cookie は復元される
- **ログイン状態の永続化** — 一度サインインすればプロファイルに自動保存され、次回以降も維持。`kb login` で手動サインインの流れをコマンド一つに。`kb storage dump / restore` でファイルへの持ち出しも可
- **操作記録** — 実行した操作・通信・コンソールを既定で常時記録。`kb log export` で「レポート + 再現手順 + curl 単体再実行 + スクショ」の自己完結バンドルを生成(機微な値は既定でマスク)
- **人間との協調** — 自動操作中でもログインや CAPTCHA はユーザーがウィンドウで直接操作し、`kb wait` で完了を検知して再開
- **MCP サーバ** — `kb-mcp` が 24 ツールを公開(スクリーンショットは画像で返る)
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
| デーモン | `kb daemon start [--headless] [--profile <n>] [--channel chrome\|msedge\|chromium] [--ua <s>] [--stealth] [--extensions <dirs\|on\|off>] [--cdp <url>] / stop / status` |
| ページ | `kb open <url> [-n] [--wait idle]` / `kb tabs [close/switch <id>]` / `kb text` / `kb html` / `kb snapshot` / `kb screenshot [<sel>\|--ref e12] [-f] [--timeout <sec>]`(要素単位も可)/ `kb pdf`(headless のみ) |
| ナビゲーション | `kb back` / `kb forward` / `kb reload` / `kb scroll [--to <sel>/--bottom]` |
| 操作 | `kb click` / `kb fill` / `kb select [--label]` / `kb check` / `kb uncheck` / `kb hover` / `kb upload <sel> <ローカルファイルパス...>` / `kb press <key>` / `kb eval <js> [--file f.js]`(await・複数行可、最後の式の値が返る)— 対象は CSS セレクタ、`--ref e12`(snapshot の ref)、`--frame <sel>`(iframe 内)で指定 |
| ダイアログ | `kb dialog [show]` / `kb dialog accept [text]` / `kb dialog dismiss` / `kb dialog policy [hold\|accept\|dismiss]`(`alert`/`confirm`/`prompt` を保留してから応答。既定 `hold`) |
| HTTP | `kb request <url> [-X POST] [-H "Name: value"] [-d body \| --data-file f] [-o file] [--no-follow \| --follow-verbose]`(ページ非依存。Cookie・プロキシはブラウザと共有) |
| ログイン | `kb login [url] [--until <glob>] [--save <file>]`(手動サインイン → 状態はプロファイルに自動保存) |
| Cookie / セッション | `kb cookies [list/get/set/rm/clear/export/import]` / `kb storage dump/restore` |
| ダウンロード | `kb downloads [list/clear]`(`~/.kb/downloads/` に自動保存) |
| Network | `kb net log [-f] [--filter re] [--responses]` / `kb net body <seq>`(レスポンス本文)/ `kb net headers <seq>`(全ヘッダ)/ `kb net block <glob>` / `kb net mock <glob> [--body f\|--text s] [--status n]` / `kb net unroute <id>\|--all` / `kb net har start/stop` |
| Console | `kb console [-f]` |
| 操作記録 | `kb log [list]` / `kb log start [--name n] [--shots] / stop / status` / `kb log show/steps [--no-mask]` / `kb log export [-o dir]` / `kb log replay [n] [--dry-run]` / `kb log rm <n>` |
| DOM | `kb dom query <sel> [--html] [--attr name] [--frame <sel>]`(属性がなければ value/checked 等の同名プロパティにフォールバック) |
| プロキシ | `kb proxy add/rm/list/use/off/status/test` / `kb proxy rule add/rm/list` |
| モード / プロファイル | `kb mode headed\|headless` / `kb profile list/use <n>`(タブ・Cookie は復元) |
| 認証 | `kb auth set <user> <pass>` / `kb auth clear`(対象サイトの Basic 認証) |
| 待機 | `kb wait [--url <glob>] [--selector <sel>] [--idle] [--any]`(複数条件は既定 AND、`--any` で OR) |
| エミュレーション | `kb emulate ua/viewport/tz/geo/net/reset`(net: offline/slow3g/fast3g) |

長文出力(text / html / snapshot)は既定 20000 文字で切り詰められ、`--offset <n>` で続き、`--max-chars 0` で全文を取得できます。

## JS ダイアログ (alert / confirm / prompt)

クリック等で `confirm` / `alert` / `prompt` が開くページでも操作できます。kb はダイアログを**保留**して表示したまま応答を待つため(既定 `hold`)、操作の応答には `dialog` が含まれます:

```bash
kb click "#delete"
# → clicked → confirm ダイアログ「本当に削除しますか?」が応答待ちです (tab 1)。
#    kb dialog accept / kb dialog dismiss で応答してください

kb dialog                 # 応答待ちのダイアログを確認
kb dialog accept          # OK(confirm は true、prompt は既定値で確定)
kb dialog accept "田中"   # prompt に値を入れて OK
kb dialog dismiss         # キャンセル
```

保留中はそのタブの他操作(`snapshot` / `text` / `click` など)がガードされ、先にダイアログへ応答するよう促されます。headed では画面にネイティブダイアログが出るので、ウィンドウ上で直接 OK / キャンセルしても構いません(kb 側の保留も自動で解除されます)。

一律に自動応答したいときはポリシーを変えられます:

```bash
kb dialog policy accept    # 以降すべて自動で OK(表示せず即応答)
kb dialog policy dismiss   # 以降すべて自動でキャンセル(従来の挙動)
kb dialog policy hold      # 既定に戻す(保留して応答を待つ)
```

> 以前は Playwright の既定でダイアログが即 dismiss され、`confirm` を伴うボタンが「押しても反応しない」ように見えていました。`hold` はこれを解消し、ダイアログを人にも見せ、応答も選べるようにします。

## ログイン状態の維持

**サインインは一度だけ。** kb は永続プロファイル(`~/.kb/profiles/`)でブラウザを起動するため、Cookie・localStorage はデーモンを再起動しても残ります。よく使うサービスへの初回サインインは `kb login` で:

```bash
kb login github.com          # headed に切り替えて開く → ウィンドウでサインイン → Enter で完了確認
kb login myapp.example.com --until "**/dashboard**"   # URL で完了を自動検知(エージェント向け)
kb login github.com --save gh-state.json              # ついでにファイルへバックアップ
```

以降のセッションでは何もしなくてもログイン済みの状態で始まります。`--save` したファイルは `kb storage restore <file>` で別プロファイルや別マシンに持ち込めます。

注意: 有効期限のない session cookie だけを使うサイトは、ブラウザの再起動でサインアウトされます(通常のブラウザと同じ挙動)。その場合も `kb storage dump / restore` で状態を引き継げます。`storage dump` は **HttpOnly を含む全 Cookie** + localStorage を書き出します(Playwright storageState 形式)。

複数アカウントを同時に使いたい場合は、`KB_HOME` を分けてデーモンを 2 つ立てるのが現状の方法です(1 デーモン 1 プロファイル):

```bash
KB_HOME=~/.kb-alt kb daemon start --profile account2   # 2 つ目は独立したデーモンとして併走
```

## 起動済みブラウザへのアタッチ

`--remote-debugging-port` 付きで起動した Chrome / Edge に、新しくブラウザを立てずに接続できます。そのブラウザのサインイン状態・拡張機能・設定をそのまま使って自動操作できます:

```bash
# 1. 対象ブラウザを CDP 付きで起動(専用プロファイル)
chrome --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\kb-attach"

# 2. kb をアタッチモードで起動
kb daemon start --cdp http://127.0.0.1:9222
kb tabs                    # 開いているタブがそのまま見える
kb open myapp.example.com  # 以降は通常どおり操作できる
kb daemon stop             # 切断のみ。対象ブラウザは閉じない
```

制約:

- **Chrome 136 以降、普段使いの既定プロファイルではリモートデバッグが無効化されています**(セキュリティ変更)。上の例のように専用の `--user-data-dir` を指定して起動し、そこで必要なサービスにサインインしておいてください。一度サインインすればそのプロファイルに残ります。
- アタッチ先の起動条件は変更できないため、`kb mode` / `kb profile` / `kb auth` と、kb のプロキシプロファイル切替はアタッチ中は使えません(エラーになります)。
- open / click / snapshot / eval / screenshot / net log / net body / cookies / storage などの操作系・観測系はすべて使えます。

## Chrome 拡張機能

Playwright は既定で拡張機能を無効化(`--disable-extensions`)して起動しますが、`--extensions` でこれを外して拡張を使えます:

```bash
kb daemon start --extensions "C:\dev\my-extension"      # 解凍済み拡張を読み込む(カンマ区切りで複数可)
kb daemon start --extensions on                         # 有効化のみ(プロファイルにインストール済みの拡張を使う)
kb daemon start --extensions off                        # 無効に戻す(既定)
```

- **解凍済み(unpacked)拡張** — `manifest.json` を含むディレクトリを指定します(`.crx` は不可)。自作拡張の開発・検証に便利です。
- **ストアの拡張** — `--extensions on` + headed で起動し、ウィンドウ上で Chrome Web Store から普通にインストールします(chrome チャネル推奨)。プロファイルに永続化されるので、以降は `--extensions on` だけでロードされます。
- 設定は `--channel` / `--ua` と同様に次回の自動起動へ引き継がれます。解除は `--extensions off`。

制約:

- **未パック拡張の読み込みは同梱 Chromium で行われます**(ディレクトリ指定時はチャネル自動選択が同梱 Chromium になる)。Chrome 137 以降の stable Chrome は `--load-extension` フラグを削除したため、実 Chrome チャネルでは読み込めません(`--extensions on` によるインストール済み拡張の有効化はどのチャネルでも動きます)。
- headless でも動作します(拡張が動く新 headless を自動選択)。
- `--cdp`(アタッチ)とは併用不可 — アタッチ先ブラウザに直接インストールされた拡張はそのまま使えます。

## API デバッグ

自作サイトの API が想定外の値を返したときは、HAR を回さなくてもその場で本文を読めます:

```bash
kb net log --filter "api"    # 行頭の #seq を確認
kb net body 42               # そのレスポンス本文を表示(JSON もそのまま読める)
kb net headers 42            # 全リクエスト/レスポンスヘッダ(Cookie・キャッシュ制御の確認に)
```

エラー時の画面を確認したいときは、既存のエンドポイントをそのまま差し替えられます:

```bash
kb net mock "**/api/users" --status 500 --text '{"error":"internal"}'   # 以降の一致リクエストが 500 に
kb reload                                                               # エラー画面を確認
kb net unroute 1                                                        # 元に戻す
```

本文はテキスト系(JSON / HTML / JS / XML 等)の XHR / fetch / document レスポンスについて自動で捕捉されます。捕捉は **1 件 256KB で切り詰め**(全体 32MB / 500 件、古い順に破棄)。`--offset` は捕捉済みの範囲内のページングで、256KB を超えた部分は後から取り戻せません — 大きなレスポンスの全文が必要なときは `kb request <url> -o <file>` で取り直してください。

開発中のエンドポイントを直接叩くには `kb request`(ミニ REST クライアント):

```bash
kb request localhost:3000/api/users                    # GET
kb request localhost:3000/api/users -X POST -d '{"name":"a"}'   # JSON ボディは Content-Type: application/json を自動付与
kb request api.example.com/v2/me -H "Accept: application/vnd.api+json" -H "X-Api-Version: 2"
```

`-H` で明示したヘッダが常に優先されます(JSON 自動付与は Content-Type 未指定のときだけ)。

ページを開く必要はなく、**Cookie とプロキシ設定はブラウザと共有**されます — ブラウザでログイン済みなら認証付き API もそのまま呼べ、レスポンスの Set-Cookie もブラウザに反映されます。バイナリは `-o <file>` で保存できます。

レスポンスの **Set-Cookie は既定で個別行表示**され(複数個でも 1 行に潰れず parse できます)、`-i` で全レスポンスヘッダも表示できます(MCP は `includeHeaders`)。`--json` では `result.setCookies` に個別の Set-Cookie 値が配列で入ります(`kb log export` のバンドルでは機微ヘッダ同様マスクされます)。

```bash
kb request localhost:3000/api/login -X POST -d '{"user":"a"}'   # Set-Cookie: sid=… が本文の前に表示される
kb request localhost:3000/api/me -i                              # 全レスポンスヘッダ + 個別 Set-Cookie
```

リダイレクトは既定で追従します。`--no-follow` で 3xx の時点で止め、**`--follow-verbose`** で追従しつつ各ホップの status / `Location` / `Set-Cookie` を表示します(リダイレクト先の確認や、途中で撒かれる Cookie の分析に。メソッド処理はブラウザ準拠で 303 と 301/302 の POST は GET 化、307/308 は維持)。`--json` では中間ホップが `result.hops` に入ります。

```bash
kb request example.com/login --follow-verbose      # 302 → 301 → 200。各ホップの Set-Cookie も表示
kb request example.com/old-path --no-follow         # 最終遷移先でなく 3xx 自体を表示
```

## 操作記録と共有バンドル

デーモンは**既定で操作を常時記録**します(コマンド・xhr/fetch/document の通信・コンソール出力)。作業後に 1 コマンドで、**kb を持たない第三者がそのまま読んで追試できる**自己完結バンドルを生成できます:

```bash
kb log export                 # ./kb-log-<session>/ を生成
kb log export -o out --no-mask --allow "^cookie$" --deny "internal\.corp"
```

```
kb-log-<session>/
├─ report.md      # 連番ステップ + 各ステップの通信/コンソール + スクショ(まずこれを読む)
├─ steps.md       # 再現手順(kb コマンド列)
├─ events.jsonl   # マスク済みジャーナル(機械可読)
├─ requests/      # 各通信を curl 単体で再実行できる .sh
├─ shots/         # スクリーンショット
└─ meta.json      # セッション情報
```

**機微な値は既定でマスク**されます(`[MASKED]`): 入力値(fill)、eval の戻り値、Authorization / Cookie 等のヘッダ、ボディ内の password / token 系キー、**URL クエリの機微キー**(`?api_key=…` 等。Location / Referer ヘッダや本文中の URL も対象)。解除は明示 `--no-mask`、微調整は `--allow` / `--deny`(正規表現)。**手元の生ジャーナル(`~/.kb/logs/`)は無改変**で、マスクは export / show 時にだけ適用されます — レポートはいつでも再生成できます。

注意: `eval` の式や `net mock --text` の引数は「あなたが書いたコード」として逐語記録されます(マスクは値に対して働く)。引数に機微な値を直書きした場合は `--deny <regex>` で潰してから共有してください。また**生ジャーナルには機微な値が平文で残る**ため、共有には必ず export を使ってください。古いセッションはデーモン起動時に自動削除されます(既定: 直近 20。`KB_LOG_KEEP` で変更)。

既知の限界: URL の**パスセグメントに埋まった値**(`/verify/<値>` のようにキー名がないもの)は自動検出できません(クエリの入れ子 URL は再帰的にマスクされます)。該当する場合は `--deny <regex>` で明示的に潰してください。

セッションはデーモンの起動ごとに自動分割され、`kb log start --name <n>` で明示的に区切ることもできます(`--shots` を付けると操作のたびに自動スクリーンショットが記録され、report.md に載ります)。`kb log show` で直近イベント、`kb log steps` で番号付き再現手順を確認できます。

記録した操作は**そのまま再実行**できます:

```bash
kb log replay              # 最新セッションの操作を順に再実行(タブ指定はアクティブタブに読み替え)
kb log replay mysession --dry-run          # 何が実行されるかだけ確認
kb log replay mysession --from 5 --continue-on-error
```

replay はタブ指定を現在のアクティブタブに読み替えるため、**複数タブに跨る記録は完全には再現されない**ことがあります(単一タブのフローが対象)。

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

接続に失敗したとき(ブラウザ側では `ERR_TUNNEL_CONNECTION_FAILED`)は、`kb proxy status` に直近の接続エラー(相手ホスト・経由プロファイル・原因)が表示され、`~/.kb/daemon.log` にも記録されます。

## AI エージェントから使う

**Claude Code からは MCP 経由を推奨** — ネイティブツールとして呼べるため、Bash 出力のパースが不要になります:

```bash
claude mcp add kb -- kb-mcp
```

`kb_snapshot` `kb_open` `kb_text` `kb_screenshot`(画像で返る)`kb_click` `kb_fill` `kb_select` `kb_eval` `kb_dialog`(alert/confirm/prompt への応答)`kb_request` `kb_net_log` `kb_net_body` `kb_net_headers` `kb_proxy_use` など 24 ツールを公開。

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

## セキュリティ調査・バグバウンティの recon

kb は**認可された**セキュリティテスト・バグバウンティの偵察に使える駆動系です — すべて上記のコマンドの組み合わせで実現できます:

- **認証付き API テスト / IDOR** — `kb request` はブラウザの Cookie とプロキシを共有するので、ログイン済みユーザーとして認可保護されたエンドポイントを検証できる。プロファイル(または `KB_HOME` を分けた 2 デーモン)で 2 アカウントを並走させ、オブジェクトアクセスの差分を取る。
- **SPA のランタイム recon** — `kb eval` はページ context で任意 JS を実行し、Cookie・トークン・クライアント側のルート表などを redaction なしの生値で返す。DOM XSS の確認やクライアント設定の抽出に。
- **通信の監視・改変** — `kb net log / body / headers` で捕捉済みのリクエスト/レスポンスを読み、`kb net mock / block` でその場で書き換えてエラーハンドリングやクライアント側の信頼を検証。
- **プロキシチェーン** — kb の上流を Burp や Caido に向け、全トラフィックを傍受プロキシ経由に(無再起動で切替可)。
- **実サインイン済みセッションへのアタッチ** — `--cdp` で手動サインイン(SSO / 2FA / passkey)済みの Chrome を再利用でき、real-auth な対象も再ログインなしで扱える。
- **再現可能な証跡** — `kb log export` が**機微値マスク済み**のバンドル(レポート + 手順 + curl 単体 + スクショ)を生成し、報告にそのまま添付できる。
- **エージェント駆動・headless** — サブエージェントが常駐デーモンに対して並列で recon を回せる。

> **認可された対象のみをテストしてください。** 各プログラムの rules of engagement に従うこと — 多くのバグバウンティは自動スキャン・過剰なリクエストレート・anti-bot / WAF の回避を禁止しています。kb は駆動系であって許可ではありません。scope とポリシーを先に確認してください。

## アーキテクチャ

```
kb (CLI) ──HTTP+token──▶ デーモン ── Playwright persistent context ──▶ Chrome/Edge/Chromium
kb-mcp (MCP stdio) ──┘      └─ ローカル中継プロキシ(token 認証)──▶ 上流プロキシ (profiles/rules)
```

状態は `~/.kb/`(daemon.json / proxies.json / profiles/ / downloads/ / daemon.log)。

## 開発

```bash
npm test        # ビルド + ユニットテスト (node:test、ブラウザ不要)
npm run test:e2e  # ビルド + ブラウザ e2e スモーク(隔離 KB_HOME で実デーモンを起動。ブラウザ未導入なら自動 skip)
npm run test:all  # 両方
```

## License

MIT
