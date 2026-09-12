# kb（CLIBrowser）CLI / MCP 完全リファレンス

この文書は、kb のコマンドラインインターフェース（CLI）、MCP ツール、環境変数、永続化ファイルを一覧化したリファレンスです。

- 通常の導入手順と代表例: [README.ja.md](../README.ja.md)
- 開発・内部構造: [CLAUDE.md](../CLAUDE.md)
- この文書の基準: リポジトリ内の実装と <code>kb --help</code>

## 基本

### コマンド形式

~~~powershell
kb [グローバルオプション] <コマンド> [サブコマンド] [引数] [オプション]
~~~

グローバルオプション:

| オプション | 説明 |
|---|---|
| <code>-V, --version</code> | バージョンを表示 |
| <code>--json</code> | 機械可読な JSON で結果を出力 |
| <code>-h, --help</code> | ヘルプを表示 |

<code>kb help [command]</code> でも指定コマンドのヘルプを表示できます。各階層で <code>kb &lt;command&gt; [subcommand] --help</code> も利用できます。

<code>--json</code> の成功時は <code>{"ok":true,"result":...}</code>、失敗時は <code>{"ok":false,"error":"..."}</code> の形です。追従表示では JSON Lines 形式になります。

### 自動起動と出力上限

ブラウザ操作コマンドは、デーモンが未起動なら前回の設定を使って自動起動します。URL のスキームを省略した場合は原則として <code>https://</code> が補われます。

<code>text</code>、<code>html</code>、<code>snapshot</code>、<code>eval</code>、<code>request</code>、<code>net body</code> などの長い出力は、既定で先頭 20,000 文字までです。<code>--offset</code> の既定は <code>0</code>、<code>--max-chars 0</code> で無制限にできます。

コマンド表記の <code>&lt;value&gt;</code> は必須の位置引数、<code>[value]</code> は任意の位置引数です。オプションの <code>--name &lt;value&gt;</code> は、そのオプションを指定した場合に値が必要という意味です。

### タブ指定

多くのコマンドで <code>-t, --tab &lt;id&gt;</code> を指定できます。省略時はアクティブタブが対象です。タブ ID は <code>kb tabs</code> で確認します。

### 要素指定

要素を操作するコマンドでは、次のいずれかを使います。

- CSS セレクター: <code>kb click "button[type=submit]"</code>
- スナップショット参照: <code>kb snapshot</code> で得た参照を <code>kb click --ref e5</code> のように指定
- iframe: <code>--frame &lt;selector&gt;</code> で対象フレームを指定

## デーモン

### <code>kb daemon start</code>

ブラウザと制御デーモンを起動します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--headless</code> | — | ヘッドレスで起動 |
| <code>--headed</code> | 明示起動の既定 | 画面表示ありで起動 |
| <code>--profile &lt;name&gt;</code> | 前回値、初回 <code>default</code> | 使用する kb プロファイル |
| <code>--channel &lt;channel&gt;</code> | 前回値、初回は自動選択 | <code>chrome</code> / <code>msedge</code> / <code>chromium</code>。<code>auto</code> で自動選択へ戻す |
| <code>--ua &lt;string&gt;</code> | 前回値、初回はブラウザ既定 | User-Agent を上書き。空文字で解除 |
| <code>--stealth</code> | 既定で有効 | <code>navigator.webdriver</code> を隠すステルス補助を有効化 |
| <code>--no-stealth</code> | — | ステルス補助を無効化 |
| <code>--detach-key [combo]</code> | 初回は無効。値省略時 <code>Alt+Shift+D</code> | タブを新しいウィンドウへ分離するキー。前回値を継承し、<code>off</code> で無効化 |
| <code>--translate-key [combo]</code> | 初回は無効。値省略時 <code>Alt+Shift+T</code> | ページ翻訳のキー。前回値を継承し、<code>off</code> で無効化 |
| <code>--ignore-https-errors</code> | 既定は無効 | HTTPS 証明書エラーを無視 |
| <code>--extensions &lt;dirs&#124;on&#124;off&gt;</code> | 前回値、初回は無効 | カンマ区切りの unpacked 拡張ディレクトリ、<code>on</code>、<code>off</code> |
| <code>--cdp &lt;url&gt;</code> | — | 既存ブラウザの CDP エンドポイントへ接続 |
| <code>--idle-timeout &lt;min&gt;</code> | 前回値、環境変数、30 分の順 | 無操作終了までの分数。<code>0</code> で無効 |

例:

~~~powershell
kb daemon start --headed --channel chrome --profile work
kb daemon start --headless --idle-timeout 0
~~~

<code>--cdp</code> は接続先ブラウザの起動条件を変更できないため、channel、UA、profile、表示モード、stealth、HTTPS エラー無視、拡張機能、ホットキーの指定とは併用できません。

### <code>kb daemon restart</code>

現在の設定を使ってデーモンを再起動します。オプションはありません。

### <code>kb daemon stop</code>

| オプション | 説明 |
|---|---|
| <code>--all</code> | 現在の <code>KB_HOME</code> に属する孤児を含む kb デーモンをすべて停止 |
| <code>--dry-run</code> | <code>--all</code> の対象を停止せず表示 |

### <code>kb daemon status</code>

デーモン、ブラウザ、タブ、モード、プロファイルなどの状態を表示します。オプションはありません。

## ページとタブ

### <code>kb open &lt;url&gt;</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-n, --new</code> | — | 新しいタブで開く |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |
| <code>--wait &lt;state&gt;</code> | <code>dcl</code> | <code>dcl</code> / <code>load</code> / <code>idle</code> まで待機 |

### <code>kb tabs [subcommand]</code>

| 形式 | 説明 |
|---|---|
| <code>kb tabs</code> / <code>kb tabs list</code> | タブ一覧 |
| <code>kb tabs close &lt;id&gt;</code> | タブを閉じる |
| <code>kb tabs switch &lt;id&gt;</code> | アクティブタブを切り替える |
| <code>kb tabs detach &lt;ids...&gt;</code> | 指定タブをまとめて新しい kb ウィンドウへ分離 |

タブ分離は新しいウィンドウで現在の URL を開き直して元タブを閉じます。引き継がれるのは URL だけで、ページ内 JavaScript 状態、フォーム入力、スクロール位置、履歴は失われます。返された対応表で新しいタブ ID を確認してください。

### <code>kb text</code>

ページの可視テキストを取得します。

| オプション | 説明 |
|---|---|
| <code>-t, --tab &lt;id&gt;</code> | 対象タブ |
| <code>--max-chars &lt;n&gt;</code> | 最大文字数。既定 20,000、<code>0</code> で無制限 |
| <code>--offset &lt;n&gt;</code> | 取得開始位置。既定 <code>0</code> |

### <code>kb html</code>

ページ HTML を取得します。オプションは <code>kb text</code> と同じです。

### <code>kb snapshot</code>

アクセシビリティスナップショットと操作用参照を取得します。オプションは <code>kb text</code> と同じです。

### <code>kb screenshot [selector]</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-o, --out &lt;path&gt;</code> | <code>kb-screenshot.png</code> | 保存先 |
| <code>-f, --full</code> | — | ページ全体を撮影 |
| <code>--ref &lt;ref&gt;</code> | — | スナップショット参照の要素を撮影 |
| <code>--frame &lt;selector&gt;</code> | — | iframe を指定 |
| <code>--timeout &lt;sec&gt;</code> | 30 秒 | タイムアウト |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |

### <code>kb translate</code>

ページまたはテキストを翻訳します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--to &lt;lang&gt;</code> | <code>ja</code> | 翻訳先言語 |
| <code>--from &lt;lang&gt;</code> | <code>auto</code> | 翻訳元言語 |
| <code>--restore</code> | — | 原文へ戻す |
| <code>--toggle</code> | — | 翻訳と原文を切り替える |
| <code>--text</code> | 無効 | ページを書き換えず、ページ本文の翻訳結果をテキスト出力 |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |
| <code>--max-chars &lt;n&gt;</code> | 20,000 | <code>--text</code> 出力の最大文字数。<code>0</code> で無制限 |
| <code>--offset &lt;n&gt;</code> | <code>0</code> | <code>--text</code> 出力の取得開始位置 |

### <code>kb eval [expression]</code>

ページ内で JavaScript を評価します。

| オプション | 説明 |
|---|---|
| <code>--file &lt;path&gt;</code> | 式をファイルから読み込む |
| <code>-t, --tab &lt;id&gt;</code> | 対象タブ |
| <code>--max-chars &lt;n&gt;</code> | 出力の最大文字数 |
| <code>--offset &lt;n&gt;</code> | 出力開始位置 |

### <code>kb request &lt;url&gt;</code>

ブラウザコンテキストの Cookie を利用して HTTP リクエストを送ります。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-X, --method &lt;method&gt;</code> | <code>GET</code> | HTTP メソッド |
| <code>-H, --header &lt;header&gt;</code> | 複数指定可 | リクエストヘッダー |
| <code>-d, --data &lt;body&gt;</code> | — | リクエスト本文 |
| <code>--data-file &lt;path&gt;</code> | — | 本文をファイルから読む |
| <code>--no-follow</code> | — | リダイレクトを追跡しない |
| <code>--follow-verbose</code> | — | リダイレクト履歴も表示 |
| <code>--timeout &lt;sec&gt;</code> | 30 秒 | タイムアウト |
| <code>-o, --out &lt;file&gt;</code> | — | レスポンス本文の保存先。バイナリ取得にも使用 |
| <code>-i, --include</code> | — | レスポンスヘッダーを含める |
| <code>--max-chars &lt;n&gt;</code> | 20,000 | 表示する最大文字数。<code>0</code> で無制限 |
| <code>--offset &lt;n&gt;</code> | <code>0</code> | 表示開始位置 |

リダイレクトは既定で追跡します。レスポンスの <code>Set-Cookie</code> は常に表示され、<code>--include</code> を付けると全レスポンスヘッダーを表示します。

## ページ操作

<code>click</code>、<code>fill</code>、<code>hover</code>、<code>check</code>、<code>uncheck</code>、<code>select</code>、<code>upload</code> は、CSS セレクターまたは <code>--ref</code>、必要に応じて <code>--frame</code> と <code>-t, --tab</code> を受け取ります。

| コマンド | 固有の引数・オプション | 説明 |
|---|---|---|
| <code>kb click [selector]</code> | — | 要素をクリック |
| <code>kb fill [selector] [value]</code> | <code>value</code> | 入力欄を置換入力。参照指定時は <code>kb fill --ref e5 value</code> |
| <code>kb hover [selector]</code> | — | 要素へマウスを移動 |
| <code>kb check [selector]</code> | — | チェックする |
| <code>kb uncheck [selector]</code> | — | チェックを外す |
| <code>kb select [selector] [values...]</code> | <code>--label</code> | select 要素を値または表示ラベルで選択 |
| <code>kb upload [selector] [files...]</code> | ファイル列 | ファイルをアップロード |
| <code>kb press &lt;key&gt;</code> | <code>-t, --tab</code> | キーを送信 |

<code>select</code> の値と <code>upload</code> のファイルは実行時には1件以上必要です。<code>--ref</code> を使う場合は、先頭の位置引数が値またはファイルとして解釈されます。

### <code>kb scroll</code>

| オプション | 説明 |
|---|---|
| <code>--down &lt;px&gt;</code> | 下へスクロール。方向未指定時は 600 px |
| <code>--up &lt;px&gt;</code> | 上へスクロール |
| <code>--to &lt;selector&gt;</code> | 要素までスクロール |
| <code>--top</code> | ページ先頭へ移動 |
| <code>--bottom</code> | ページ末尾へ移動 |
| <code>-t, --tab &lt;id&gt;</code> | 対象タブ |

### 履歴と再読み込み

<code>kb back</code>、<code>kb forward</code>、<code>kb reload</code> は、それぞれ戻る、進む、再読み込みです。いずれも <code>-t, --tab &lt;id&gt;</code> を指定できます。

### <code>kb dialog</code>

| 形式 | 説明 |
|---|---|
| <code>kb dialog</code> / <code>kb dialog show [-t id]</code> | 保留中ダイアログを表示 |
| <code>kb dialog accept [text] [-t id]</code> | alert / confirm を承認。prompt の入力も指定可能 |
| <code>kb dialog dismiss [-t id]</code> | ダイアログを拒否 |
| <code>kb dialog policy [policy]</code> | <code>hold</code> / <code>accept</code> / <code>dismiss</code> を表示または変更。既定 <code>hold</code> |

### <code>kb pdf</code>

ヘッドレスモードで PDF を生成します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-o, --out &lt;path&gt;</code> | <code>kb.pdf</code> | 保存先 |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |

## Cloudflare などでのサインアップ引き継ぎ

自動操作ブラウザが bot 判定される場合、通常の Chrome または Edge で人間が認証・登録し、そのセッションを kb に引き継げます。これは判定の回避を保証する機能ではなく、サイトの規約と許可された範囲で使用してください。

### 基本フロー

~~~powershell
kb signup bootstrap cloudflare https://dash.cloudflare.com/sign-up --channel chrome --check-url https://dash.cloudflare.com/
kb signup adopt cloudflare
kb signup status cloudflare
kb signup checkpoint cloudflare
~~~

<code>bootstrap</code> が起動した通常ブラウザで登録・ログインを完了してから、そのブラウザを終了し、<code>adopt</code> を実行します。
<code>bootstrap</code> と <code>adopt</code> の実行時は kb デーモンが停止している必要があります。<code>adopt</code> には、bootstrap で保存するか adopt 時に渡すログイン後の <code>--check-url</code> が必須です。

### <code>kb signup bootstrap &lt;name&gt; &lt;url&gt;</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--profile &lt;name&gt;</code> | <code>signup-&lt;name&gt;</code> | 引き継ぎ後に使う kb プロファイル |
| <code>--check-url &lt;url&gt;</code> | — | 引き継ぎ後の検証 URL |
| <code>--expect-selector &lt;sel&gt;</code> | — | セッション成立時に visible であるべき要素 |
| <code>--expect-cookie &lt;name&gt;</code> | — | セッション成立時に存在すべき Cookie |
| <code>--channel &lt;channel&gt;</code> | 初回は <code>chrome</code> | <code>chrome</code> または <code>msedge</code> |
| <code>--browser-path &lt;path&gt;</code> | — | ブラウザ実行ファイルを明示 |
| <code>--system-proxy</code> | — | OS のプロキシ設定を利用 |
| <code>--direct</code> | 初回の既定 | プロキシを使わず直接接続。再開時の設定も direct に戻す |
| <code>--reuse-profile</code> | — | 既存の bootstrap 用ブラウザプロファイルを再利用 |

<code>--system-proxy</code> と <code>--direct</code> は同時指定できません。既存プロファイルは、意図した再利用であることを明示する <code>--reuse-profile</code> がない限り拒否されます。

### <code>kb signup adopt &lt;name&gt;</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--check-url &lt;url&gt;</code> | bootstrap 設定 | 検証 URL |
| <code>--expect-selector &lt;sel&gt;</code> | bootstrap 設定 | 成立を確認する visible 要素 |
| <code>--expect-cookie &lt;name&gt;</code> | bootstrap 設定 | 成立を確認する Cookie |
| <code>--api &lt;url&gt;</code> | — | HTML ではなく API として検証 |
| <code>--timeout &lt;sec&gt;</code> | 20 秒 | 検証タイムアウト |
| <code>--restore-proxy</code> | — | 引き継ぎ前に使用していたプロキシ設定を復元 |
| <code>--no-stealth</code> | — | 引き継ぎ後の起動でステルス補助を無効化 |
| <code>--checkpoint &lt;path&gt;</code> | <code>~/.kb/signups/&lt;name&gt;/storage-state.json</code> | 保存する状態ファイル |

### <code>kb signup</code> / <code>kb signup status [name]</code>

bootstrap / adopt の進行状況と保存情報を表示します。名前を省略すると一覧を表示し、対象サイトへの通信は行いません。

### <code>kb signup checkpoint &lt;name&gt;</code>

現在のセッションを再利用可能な状態ファイルとして保存します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-o, --out &lt;path&gt;</code> | signup ごとの既定パス | 保存先 |
| <code>--api &lt;url&gt;</code> | — | 保存前に検証する API |
| <code>--timeout &lt;sec&gt;</code> | 20 秒 | 検証タイムアウト |

## セッション、Cookie、Storage

### <code>kb downloads</code>

| 形式 | 説明 |
|---|---|
| <code>kb downloads</code> / <code>kb downloads list</code> | ダウンロード履歴を表示 |
| <code>kb downloads clear</code> | 履歴だけを削除。ダウンロード済みファイルは残る |

### <code>kb cookies</code>

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb cookies</code> / <code>kb cookies list</code> | <code>-d, --domain &lt;domain&gt;</code> | Cookie 一覧 |
| <code>kb cookies get &lt;name&gt;</code> | <code>-d, --domain</code> | Cookie を取得 |
| <code>kb cookies set &lt;name&gt; &lt;value&gt;</code> | 必須 <code>-d, --domain &lt;domain&gt;</code>、<code>-p, --path &lt;path&gt;</code>（既定 <code>/</code>） | Cookie を設定 |
| <code>kb cookies rm &lt;name&gt;</code> | <code>-d, --domain</code> | Cookie を削除 |
| <code>kb cookies export</code> | 下表 | Cookie を出力 |
| <code>kb cookies import &lt;file&gt;</code> | — | Cookie を読み込む |
| <code>kb cookies clear</code> | — | Cookie を消去 |

<code>cookies export</code> のオプション:

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--format &lt;fmt&gt;</code> | <code>json</code> | <code>json</code> / <code>netscape</code> / <code>header</code> |
| <code>--url &lt;url&gt;</code> | — | 対象 URL |
| <code>-d, --domain &lt;domain&gt;</code> | — | ドメインで絞り込み |
| <code>-o, --out &lt;path&gt;</code> | JSON は <code>kb-cookies.json</code>、他形式は標準出力 | 保存先 |

### <code>kb session check &lt;url&gt;</code>

HTTP 応答、遷移先、HTML、Cookie、期待要素を使ってセッション状態を診断します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--api &lt;url&gt;</code> | — | API エンドポイントも検証 |
| <code>--expect-selector &lt;sel&gt;</code> | — | 成立時に visible であるべき要素 |
| <code>--timeout &lt;sec&gt;</code> | 15 秒 | タイムアウト |

代表的な判定値は <code>ok</code>、<code>degraded</code>、<code>degraded-html-only</code>、<code>target-protected</code>、<code>no-session</code>、<code>expectation-failed</code>、<code>unreachable</code> です。

### <code>kb storage</code>

| 形式 | 説明 |
|---|---|
| <code>kb storage dump [-o path]</code> | Cookie と origin storage を保存。既定は <code>kb-state.json</code> |
| <code>kb storage restore &lt;file&gt; [--replace]</code> | 保存状態を復元。<code>--replace</code> は既存状態を消してから復元 |

状態ファイルには認証情報が含まれる可能性があります。共有やコミットを避け、不要になったら安全に破棄してください。

## プロファイル、モード、待機、ログイン

### <code>kb profile</code>

| 形式 | 説明 |
|---|---|
| <code>kb profile</code> / <code>kb profile list</code> | プロファイル一覧 |
| <code>kb profile use &lt;name&gt;</code> | プロファイルを切り替え。起動中はブラウザを再起動してタブ URL を復元するため、タブ ID は変わる |

### <code>kb mode [mode]</code>

引数省略時は現在のモードを表示します。<code>headed</code> または <code>headless</code> を指定するとブラウザを再起動してタブ URL と Cookie を復元するため、タブ ID は変わります。

### <code>kb wait</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--url &lt;glob&gt;</code> | — | URL が glob に一致するまで待つ |
| <code>--selector &lt;sel&gt;</code> | — | 要素が現れるまで待つ |
| <code>--selector-gone &lt;sel&gt;</code> | — | 要素が消えるまで待つ |
| <code>--idle</code> | — | ネットワークアイドルまで待つ |
| <code>--any</code> | — | 複数条件のいずれかで完了。未指定時はすべて |
| <code>--timeout &lt;sec&gt;</code> | 90 秒、最大 280 秒 | タイムアウト |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |

### <code>kb login [url]</code>

画面表示ありブラウザで人間によるログイン完了を待ちます。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--until &lt;glob&gt;</code> | — | 完了とみなす URL |
| <code>--until-selector &lt;sel&gt;</code> | — | 完了とみなす要素 |
| <code>--until-gone &lt;sel&gt;</code> | — | 消えたら完了とみなす要素 |
| <code>--timeout &lt;sec&gt;</code> | 280 秒 | タイムアウト |
| <code>--save &lt;file&gt;</code> | — | 自動保存されるプロファイルとは別に、状態を指定ファイルへ書き出す |

完了条件を1つでも指定すると、最初に満たした条件で完了します。条件を指定しない場合は対話端末で Enter 入力を待ちます。非対話環境では <code>--until</code>、<code>--until-selector</code>、<code>--until-gone</code> のいずれかが必要です。

例:

~~~powershell
kb login https://example.com/login --until "https://example.com/app/**" --save example-state.json
~~~

### <code>kb auth</code>

| 形式 | 説明 |
|---|---|
| <code>kb auth set &lt;username&gt; &lt;password&gt;</code> | HTTP Basic 認証情報を設定。ブラウザ再起動とタブ URL の復元を伴う |
| <code>kb auth clear</code> | 認証情報を解除 |

## エミュレーション

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb emulate ua &lt;userAgent&gt;</code> | <code>-t, --tab</code> | User-Agent を変更 |
| <code>kb emulate viewport &lt;size&gt;</code> | <code>--dpr &lt;n&gt;</code>（既定 1）、<code>--mobile</code>、<code>-t, --tab</code> | <code>WxH</code> 形式で画面サイズと端末種別を変更 |
| <code>kb emulate tz &lt;timezoneId&gt;</code> | <code>-t, --tab</code> | タイムゾーンを変更 |
| <code>kb emulate geo &lt;lat&gt; &lt;lng&gt;</code> | — | 位置情報を変更 |
| <code>kb emulate net &lt;preset&gt;</code> | <code>-t, --tab</code> | <code>offline</code> / <code>slow3g</code> / <code>fast3g</code> / <code>reset</code> |
| <code>kb emulate reset</code> | <code>-t, --tab</code> | エミュレーションを解除 |

## 操作ログとリプレイ

### 記録

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb log start</code> | <code>--name &lt;name&gt;</code>（既定はタイムスタンプ）、<code>--shots</code> | 新しい操作記録を開始。<code>--shots</code> で各ステップを撮影 |
| <code>kb log stop</code> | — | 記録を終了 |
| <code>kb log status</code> | — | 記録状態 |
| <code>kb log</code> / <code>kb log list</code> | — | セッション一覧 |

### 表示と出力

<code>kb log show</code> と <code>kb log steps</code>:

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--session &lt;name&gt;</code> | 最新 | 対象セッション |
| <code>-n, --limit &lt;n&gt;</code> | 50 | 最大件数（<code>show</code>） |
| <code>--no-mask</code> | — | 秘密情報のマスクを無効化 |
| <code>--allow &lt;regex&gt;</code> | — | マスク対象から除外するパターン |
| <code>--deny &lt;regex&gt;</code> | — | 強制的にマスクするパターン |
| <code>--mask-jwt &lt;mode&gt;</code> | <code>signature</code> | <code>signature</code> / <code>full</code> / <code>off</code> |

<code>kb log export</code> は同じマスク関連オプションと <code>--session &lt;name&gt;</code> に加え、<code>-o, --out &lt;dir&gt;</code> で出力先を指定します。出力先の既定は <code>./kb-log-&lt;session&gt;</code> です。

### <code>kb log replay [session]</code>

セッションを省略すると最新の記録を再実行します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--from &lt;seq&gt;</code> | — | 開始シーケンス |
| <code>--to &lt;seq&gt;</code> | — | 終了シーケンス |
| <code>--delay &lt;ms&gt;</code> | 0 ms | ステップ間隔 |
| <code>--dry-run</code> | — | 実行せず内容を確認 |
| <code>--continue-on-error</code> | — | エラー後も続行 |

<code>kb log rm &lt;session&gt;</code> で記録セッションを削除します。

## HTTP ネットワーク

### <code>kb net</code> / <code>kb net log</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |
| <code>--filter &lt;regex&gt;</code> | — | URL などを絞り込み |
| <code>-n, --limit &lt;n&gt;</code> | 50 | 最大件数 |
| <code>--responses</code> | — | request / response の二重表示を避け、response / FAIL の完了行だけにする |
| <code>-f, --follow</code> | — | 追従表示 |
| <code>--for &lt;sec&gt;</code> | — | 追従時間 |

### 詳細と出力

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb net body &lt;seq&gt;</code> | <code>--max-chars</code>（既定 20,000、<code>0</code> で無制限）、<code>--offset</code>（既定 0） | レスポンス本文。seq は <code>123</code> と <code>#123</code> の両形式に対応 |
| <code>kb net headers &lt;seq&gt;</code> | — | ヘッダー |
| <code>kb net export</code> | <code>--format &lt;fmt&gt;</code>（既定・現在唯一の値 <code>har</code>）、<code>-o, --out &lt;path&gt;</code>（既定 <code>kb-net.har</code>）、<code>--filter</code>、<code>-t, --tab</code>、<code>-n, --limit</code> | 捕捉済みバッファからネットワークログを出力 |
| <code>kb net clear</code> | — | ログを消去 |

### ルーティング

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb net block &lt;pattern&gt;</code> | — | 一致するリクエストを遮断 |
| <code>kb net mock &lt;pattern&gt;</code> | 任意の <code>--body &lt;file&gt;</code> または <code>--text &lt;body&gt;</code>、<code>--status &lt;n&gt;</code>（既定 200）、<code>--content-type &lt;ct&gt;</code> | 模擬レスポンスを返す |
| <code>kb net rules</code> | — | ルール一覧 |
| <code>kb net unroute [id]</code> | <code>--all</code> | 指定または全ルールを解除 |

<code>net mock</code> の <code>--body</code> と <code>--text</code> は同時指定できません。両方を省略すると空本文になり、Content-Type はファイル拡張子または本文から推定されます。

### HAR 記録

| 形式 | 説明 |
|---|---|
| <code>kb net har start</code> | HAR 記録を開始 |
| <code>kb net har stop [-o path]</code> | 記録を停止して保存。既定は <code>kb.har</code> |
| <code>kb net har status</code> | HAR 記録状態 |

## WebSocket、Console、DOM

### WebSocket

<code>kb ws</code> は <code>kb ws log</code> と同じです。<code>ws connect</code> で作った接続は対象タブのページコンテキストに属し、ページ遷移すると失われます。

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb ws log</code> | <code>-t, --tab</code>、<code>--filter</code>、<code>-n, --limit</code>（既定 50）、<code>-f, --follow</code>、<code>--for &lt;sec&gt;</code>、<code>--clear</code> | ページ WebSocket ログ |
| <code>kb ws connect &lt;url&gt;</code> | <code>--protocol &lt;name...&gt;</code>、<code>--timeout &lt;sec&gt;</code>（既定 15）、<code>-t, --tab</code> | WebSocket 接続 |
| <code>kb ws send &lt;id&gt; [data]</code> | <code>--file &lt;path&gt;</code>、<code>--base64</code>、<code>-t, --tab</code> | データを送信 |
| <code>kb ws recv &lt;id&gt;</code> | <code>--since &lt;seq&gt;</code>、<code>-n, --limit</code>（既定 50）、<code>-f, --follow</code>、<code>--for &lt;sec&gt;</code>、<code>-t, --tab</code> | 受信データを表示 |
| <code>kb ws list</code> | <code>-t, --tab</code> | 接続一覧 |
| <code>kb ws close &lt;id&gt;</code> | <code>--code &lt;n&gt;</code>、<code>--reason &lt;text&gt;</code>、<code>-t, --tab</code> | 接続を閉じる |

### <code>kb console</code>

ページの console 出力を表示します。

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |
| <code>-n, --limit &lt;n&gt;</code> | 50 | 最大件数 |
| <code>-f, --follow</code> | — | 追従 |
| <code>--for &lt;sec&gt;</code> | — | 追従時間 |
| <code>--clear</code> | — | ログを消去 |

### <code>kb dom query &lt;selector&gt;</code>

| オプション | 値・既定値 | 説明 |
|---|---|---|
| <code>--html</code> | — | outerHTML を返す。1要素あたり最大 2,000 文字 |
| <code>--attr &lt;name&gt;</code> | — | 指定属性を返す |
| <code>-n, --limit &lt;n&gt;</code> | 20 | 最大件数 |
| <code>--frame &lt;selector&gt;</code> | — | iframe を指定 |
| <code>-t, --tab &lt;id&gt;</code> | — | 対象タブ |

## プロキシ

### <code>kb proxy add &lt;name&gt;</code>

| オプション | 説明 |
|---|---|
| 必須 <code>--type &lt;type&gt;</code> | <code>http</code> または <code>socks5</code> |
| 必須 <code>--host &lt;host&gt;</code> | プロキシホスト |
| 必須 <code>--port &lt;port&gt;</code> | ポート |
| <code>--user &lt;username&gt;</code> | ユーザー名 |
| <code>--pass &lt;password&gt;</code> | パスワード |
| <code>--bypass &lt;patterns&gt;</code> | カンマ区切りの除外パターン |
| <code>--ca &lt;path&gt;</code> | PEM / DER CA 証明書を OS ストアへ入れず、このプロファイルだけで SPKI 信頼 |
| <code>--trust-ca</code> | MITM プロキシのルート CA を抽出して OS の信頼ルートへ導入 |
| <code>--ca-probe &lt;host&gt;</code> | CA 検出用ホスト。既定 <code>example.com</code> |
| <code>--yes</code> | 確認を省略 |

### その他のプロキシコマンド

| 形式 | オプション | 説明 |
|---|---|---|
| <code>kb proxy</code> / <code>kb proxy list</code> | — | 登録一覧 |
| <code>kb proxy use &lt;name&gt;</code> | — | 使用するプロキシを選択 |
| <code>kb proxy off</code> | — | プロキシを解除 |
| <code>kb proxy rm &lt;name&gt;</code> | — | 登録を削除 |
| <code>kb proxy trust-ca &lt;name&gt;</code> | <code>--scoped</code>、<code>--ca-probe &lt;host&gt;</code>（既定 <code>example.com</code>）、<code>--yes</code> | CA を信頼。<code>--scoped</code> は OS ストアを変更せず、反映にデーモン再起動が必要 |
| <code>kb proxy untrust-ca &lt;name&gt;</code> | — | CA の信頼設定を解除 |
| <code>kb proxy status</code> | — | 現在の設定 |
| <code>kb proxy test [name]</code> | — | 接続をテスト。名前省略時は現在アクティブなプロファイル |

### プロキシルール

| 形式 | 説明 |
|---|---|
| <code>kb proxy rule add &lt;pattern&gt; &lt;profile&gt;</code> | URL パターンにプロキシプロファイルを割り当て |
| <code>kb proxy rule rm &lt;index&gt;</code> | インデックスでルールを削除 |
| <code>kb proxy rule</code> / <code>kb proxy rule list</code> | ルール一覧 |

## MCP サーバー

<code>kb-mcp</code> は stdio MCP サーバーを起動します。CLI 全機能ではなく、ブラウザ操作で頻用する次の 34 ツールを公開します。<code>kb-mcp</code> 自体にオプションはありません。型名の後ろの <code>?</code> は省略可能、付かないものは必須です。

MCP の主な既定値:

- <code>tab</code> 省略時はアクティブタブ
- <code>maxChars</code> は 20,000、<code>offset</code> は 0。<code>maxChars: 0</code> で無制限
- <code>kb_open.waitUntil</code> は <code>domcontentloaded</code>、<code>newTab</code> は <code>false</code>
- <code>kb_translate</code> は <code>to: ja</code>、<code>from: auto</code>、<code>inPlace: true</code>
- <code>kb_net_log.limit</code>、<code>kb_ws_log.limit</code>、<code>kb_ws_recv.limit</code>、<code>kb_console_log.limit</code> は 50、<code>kb_dom_query.limit</code> は 20
- <code>kb_ws_connect.timeoutSec</code> は 15、<code>kb_request.timeoutSec</code> は 30、<code>kb_wait.timeoutSec</code> は 90（最大 280）
- <code>kb_request.method</code> は <code>GET</code>。<code>includeHeaders</code> と <code>followVerbose</code> は <code>false</code>
- そのほかの省略可能な boolean は、特記がない限り <code>false</code>

| ツール | 用途 | パラメーター |
|---|---|---|
| <code>kb_open</code> | URLを開く | <code>url: string</code>, <code>newTab?: boolean</code>, <code>waitUntil?: domcontentloaded&#124;load&#124;networkidle</code>, <code>tab?: number</code> |
| <code>kb_tabs</code> | タブ一覧 | なし |
| <code>kb_tab_close</code> | タブを閉じる | <code>tab: number</code> |
| <code>kb_tabs_detach</code> | 複数タブを新規ウィンドウへ分離 | <code>tabs: number[]</code> |
| <code>kb_text</code> | ページ本文を取得 | <code>tab?: number</code>, <code>maxChars?: number</code>, <code>offset?: number</code> |
| <code>kb_translate</code> | ページを翻訳、復元、切替 | <code>to?: string</code>, <code>from?: string</code>, <code>inPlace?: boolean</code>, <code>restore?: boolean</code>, <code>toggle?: boolean</code>, <code>maxChars?: number</code>, <code>offset?: number</code>, <code>tab?: number</code> |
| <code>kb_snapshot</code> | 操作用ref付きアクセシビリティスナップショット | <code>tab?: number</code>, <code>maxChars?: number</code>, <code>offset?: number</code> |
| <code>kb_screenshot</code> | スクリーンショットを画像として返す | <code>tab?: number</code>, <code>fullPage?: boolean</code>, <code>selector?: string</code>, <code>ref?: string</code>, <code>frame?: string</code> |
| <code>kb_eval</code> | ページ内JavaScriptを評価 | <code>expression: string</code>, <code>maxChars?: number</code>, <code>offset?: number</code>, <code>tab?: number</code> |
| <code>kb_click</code> | 要素をクリック | <code>selector?: string</code>, <code>ref?: string</code>, <code>frame?: string</code>, <code>tab?: number</code> |
| <code>kb_fill</code> | 入力欄へ値を設定 | <code>value: string</code>, <code>selector?: string</code>, <code>ref?: string</code>, <code>frame?: string</code>, <code>tab?: number</code> |
| <code>kb_select</code> | select項目を選択 | <code>values: string[]</code>, <code>byLabel?: boolean</code>, <code>selector?: string</code>, <code>ref?: string</code>, <code>frame?: string</code>, <code>tab?: number</code> |
| <code>kb_press</code> | キー入力 | <code>key: string</code>, <code>tab?: number</code> |
| <code>kb_dialog</code> | alert、confirm、promptの確認と応答 | <code>action?: info&#124;accept&#124;dismiss</code>, <code>text?: string</code>, <code>tab?: number</code> |
| <code>kb_cookies_list</code> | Cookie一覧 | <code>domain?: string</code> |
| <code>kb_net_log</code> | HTTP通信ログを取得 | <code>filter?: string</code>, <code>limit?: number</code>, <code>tab?: number</code> |
| <code>kb_net_body</code> | 捕捉済みレスポンス本文を取得 | <code>seq: number</code>, <code>maxChars?: number</code>, <code>offset?: number</code> |
| <code>kb_net_headers</code> | 捕捉済み通信の全ヘッダーを取得 | <code>seq: number</code> |
| <code>kb_net_export</code> | 捕捉済み通信をHARへ保存 | <code>path: string</code>, <code>filter?: string</code>, <code>limit?: number</code>, <code>tab?: number</code> |
| <code>kb_session_check</code> | セッション劣化やchallengeを対照診断 | <code>url: string</code>, <code>api?: string</code>, <code>expectSelector?: string</code>, <code>timeoutSec?: number</code> |
| <code>kb_ws_log</code> | ページWebSocketフレームを観測 | <code>filter?: string</code>, <code>limit?: number</code>, <code>tab?: number</code> |
| <code>kb_ws_connect</code> | ページコンテキストでWebSocket接続 | <code>url: string</code>, <code>protocols?: string[]</code>, <code>timeoutSec?: number</code>, <code>tab?: number</code> |
| <code>kb_ws_send</code> | WebSocketフレームを送信 | <code>id: number</code>, <code>data: string</code>, <code>base64?: boolean</code>, <code>tab?: number</code> |
| <code>kb_ws_recv</code> | WebSocket受信バッファをカーソル読み | <code>id: number</code>, <code>since?: number</code>, <code>limit?: number</code>, <code>tab?: number</code> |
| <code>kb_ws_list</code> | kbが開いたWebSocket一覧 | <code>tab?: number</code> |
| <code>kb_ws_close</code> | WebSocketを閉じる | <code>id: number</code>, <code>code?: number</code>, <code>reason?: string</code>, <code>tab?: number</code> |
| <code>kb_request</code> | Cookie・プロキシ共有のHTTPリクエスト | <code>url: string</code>, <code>method?: string</code>, <code>headers?: Record&lt;string,string&gt;</code>, <code>data?: string</code>, <code>timeoutSec?: number</code>, <code>includeHeaders?: boolean</code>, <code>followVerbose?: boolean</code>, <code>maxChars?: number</code>, <code>offset?: number</code> |
| <code>kb_console_log</code> | ページconsoleログを取得 | <code>limit?: number</code>, <code>tab?: number</code> |
| <code>kb_dom_query</code> | CSSセレクターでDOMを検査 | <code>selector: string</code>, <code>html?: boolean</code>, <code>attr?: string</code>, <code>limit?: number</code>, <code>frame?: string</code>, <code>tab?: number</code> |
| <code>kb_wait</code> | URL、要素、network idleを待機 | <code>url?: string</code>, <code>selector?: string</code>, <code>selectorGone?: string</code>, <code>idle?: boolean</code>, <code>any?: boolean</code>, <code>timeoutSec?: number</code>, <code>tab?: number</code> |
| <code>kb_proxy_list</code> | プロキシプロファイルとルール一覧 | なし |
| <code>kb_proxy_use</code> | プロキシを無再起動で切替 | <code>name: string</code>。直接接続は <code>direct</code> |
| <code>kb_mode_set</code> | headed / headlessを切替 | <code>mode: headed&#124;headless</code> |
| <code>kb_status</code> | デーモン状態を取得 | なし |

MCP クライアント設定例:

~~~json
{
  "mcpServers": {
    "kb": {
      "command": "kb-mcp"
    }
  }
}
~~~

## 環境変数

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| <code>KB_HOME</code> | <code>~/.kb</code> | 状態、プロファイル、ログなどのルート |
| <code>KB_IDLE_TIMEOUT</code> | 30 分相当 | デーモンの無操作終了時間を秒で指定。CLI の <code>--idle-timeout</code> は分 |
| <code>KB_LOG_KEEP</code> | 20 | 保持する操作ログセッション数 |
| <code>KB_RELAY_NOAUTH</code> | 未設定 | <code>1</code> で relay 認証を無効化。テスト・デバッグ専用 |

## 保存場所

<code>KB_HOME</code> 配下の主なファイルとディレクトリ:

| パス | 内容 |
|---|---|
| <code>daemon.json</code> | 実行中デーモンへの接続情報 |
| <code>last-run.json</code> | 前回の起動設定 |
| <code>daemon.spawn.lock</code> | デーモンの二重起動防止ロック |
| <code>profiles/</code> | ブラウザプロファイル |
| <code>signups/</code> | signup 引き継ぎ情報と checkpoint |
| <code>proxies.json</code> | プロキシ設定 |
| <code>logs/</code> | 操作ログ |
| <code>downloads/</code> | ダウンロード |
| <code>cookie-seen.json</code> | Cookie 観測情報 |
| <code>daemon.log</code> | デーモンログ |

## よく使う組み合わせ

### 画面を見ながら操作

~~~powershell
kb daemon start --headed --channel chrome
kb open https://example.com
kb snapshot
kb click --ref e3
kb fill --ref e5 "sample"
~~~

### ログインを保存して再利用

~~~powershell
kb login https://example.com/login --until "https://example.com/app/**" --save example-state.json
kb session check https://example.com/app --expect-selector "main"
kb storage dump -o example-state.json
~~~

### ネットワーク調査

~~~powershell
kb net clear
kb open https://example.com
kb net log --responses --limit 100
kb net export -o example.har
~~~

## 保守ルール

CLI コマンド、オプション、既定値、MCP ツール、環境変数、状態ファイル、またはユーザー操作手順を変更した場合は、この文書への影響を確認します。詳細はリポジトリルートの [AGENTS.md](../AGENTS.md) と [CLAUDE.md](../CLAUDE.md) を参照してください。
