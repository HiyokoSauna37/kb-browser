# kb — CLI Browser

Playwright + Chromium (CDP) ベースの CLI 操作型ブラウザ。デーモンがブラウザを常駐保持し、`kb` コマンドが localhost RPC で命令を送る 2 プロセス構成。

## ビルドと実行

```bash
npm run build          # tsc → dist/
npm test               # ビルド + ユニットテスト (node:test, dist/**/*.test.js)
kb <cmd>               # npm link 済み(グローバル)。開発中は node dist/cli.js <cmd>
```

注意: デーモンは起動時の dist/ を保持し続けるため、**ビルド後は `kb daemon stop` で再起動しないと新コードが反映されない**(CLI が buildId 不一致を検知して stderr に警告を出す)。`kb daemon status` が running/disk のビルド時刻と match/MISMATCH を併記するので、警告が本物か(コード同一で mtime だけ変わった等)を確認できる。

## アーキテクチャ

- `src/cli.ts` — CLI エントリ(bin)。コマンド定義はグループ別に `src/cli/commands/`(daemon / browse / actions / state / log / env / net / proxy)にあり、登録順 = ヘルプの表示順。全コマンド `--json` 対応(成功 `{ok:true,result}` / 失敗 `{ok:false,error}`)。
- `src/cli/output.ts` — CLI 共通の出力ヘルパ(print / run / truncNote / fmtTabs)と `--json` 状態の一元管理(setJsonOutput / isJsonOutput)。
- `src/mcp.ts` — MCP stdio サーバ (`kb-mcp`)。デーモンの機能を 23 ツールとして公開。`claude mcp add kb -- kb-mcp` で登録。**SDK の zod ジェネリクスは tsc をメモリ爆発させるため、型消去した `tool()` ラッパ経由で登録している(server.tool を直接呼ばないこと)。**
- `src/shared/version.ts` — `KB_VERSION`。package.json を単一の情報源として実行時に読む(バージョン文字列をコードに書かないこと)。
- `src/shared/client.ts` — デーモンへの RPC クライアント(CLI / MCP 共用)。未起動時は自動 spawn(前回の headless/profile/channel/ua を last-run.json から引き継ぎ、spawn ロックで二重起動を防止。**起動内容を stderr に 1 行通知**)。pid 生存確認付きの stale 判定。**明示的な `kb daemon start` はフラグなし = headed**(last-run 継承は自動 spawn のみ)。`waitForDaemon(child)` は spawn 直後の子プロセス死亡を検知して 30 秒待たずに daemon.log 付きで即エラー(--cdp 接続失敗などの fail-fast)。`--ua ""` / `--channel auto` は last-run 継承をクリアする明示リセット。
- `src/shared/util.ts` — 純粋関数(normalizeUrl / clip / LogBuffer / prepareEval)。テスト対象。**prepareEval は eval コードの自動 async ラップ**(await 入りの式・複数文を async IIFE 化し、最後の式を構文チェック付きで return に書き換える)。
- `src/daemon/main.ts` — HTTP サーバ (127.0.0.1 ランダムポート + timing-safe トークン認証)。RPC を host にディスパッチ。uncaughtException でデーモンを落とさない。
- `src/daemon/host.ts` — BrowserHost(facade。RPC から呼ばれるメソッド名はここに揃う)。`launchPersistentContext` で Chromium を保持、タブを ID 管理。channel は chrome → msedge → 同梱 chromium の順にフォールバック(`--channel` 明示時はフォールバックせず strict)。`--ua` で context 全体の UA 上書き。**`--stealth`** は自前起動時のみ起動 args に `--disable-blink-features=AutomationControlled` を付けて `navigator.webdriver` を実 Chrome 同様に消す。計測上、chrome チャネルではこのフラグ**だけ**で plugins/languages/WebGL/permissions まで実 Chrome と一致するため、**JS パッチ(init script)は入れていない**(過剰パッチ自体が新たな検知痕跡になる — 以前 permissions シムを入れて `query.toString()` 非ネイティブ化等の綻びを増やしたため撤去した)。残る綻びは headless の "HeadlessChrome" UA だけなので `--ua` と併用するか headed を使う。**JA3/TLS・HTTP2・IP レピュテーション等のサーバ側判定は別レイヤで、client 側では潰せない**(Cloudflare Managed Challenge 突破は保証しない)。アタッチ(`--cdp`)時は start() で stealth を無効に正規化(status が嘘をつかないため)。mode/profile/auth 切替は共通の `restart()` でタブ URL を復元(stealth も維持)。**アタッチモード**(`--cdp <url>` → `connectOverCDP`)では既存ブラウザの既定 context に接続する: stop は `browser.close()` で切断のみ(対象ブラウザは殺さない)、mode/profile/auth と proxy 切替は `assertNotAttached()` でエラー、last-run に cdp は残さない(自動 spawn は常に通常起動)。Chrome 136+ は既定プロファイルで CDP 不可(専用 --user-data-dir 必須)。
- `src/daemon/netMonitor.ts` — NetMonitor。通信ログのリングバッファ、テキスト系レスポンス本文・全ヘッダの捕捉(`kb net body/headers`。request seq → response seq の自動読み替え含む)、block/mock ルール(再起動時は `reapplyRoutes()` で新 context に引き継ぐ)、HAR 記録、ジャーナル向け net イベント通知。
- `src/daemon/targets.ts` — TargetResolver。selector / ref / frame → Locator の解決と、失効 ref の自動再解決(タブ毎の直近 snapshot キャッシュで role/name 照合。実装は `act()` / `reResolveRef()`)。
- `src/daemon/emulation.ts` — Emulator。UA / viewport / tz / 回線の CDP エミュレーション。CDP セッションを detach するとオーバーライドが消えるため、タブ毎に CDPSession を保持し続ける。
- `src/daemon/types.ts` — デーモン内共有の型(HostOptions / Target / NetEntry 等)と調整定数(LOG_CAP / TEXT_CAP / TEXT_CONTENT_RE)。host.ts から re-export される。
- `src/daemon/relay.ts` — ローカル中継プロキシ。Chromium は常にここを向き、上流(http/socks5/direct)だけ差し替えることで**無再起動のプロキシ切替**を実現。SOCKS5 認証代行・bypass パターン・接続タイムアウト(10s)もこの層。**中継自体もセッション毎トークンの Basic 認証**で他ローカルプロセスの相乗りを防ぐ(KB_RELAY_NOAUTH=1 で無効化)。
- `src/shared/oplog.ts` — 操作ログの純関数層(イベント型 / マスキング / report.md / steps / curl 生成)。テスト対象。**マスクは export/show 時のみ適用し、生ジャーナルは無改変**が原則。fill 値・eval 戻り値・機微ヘッダ・ボディ内の password/token 系キー・**URL クエリの機微キー**(net.url / args.url / 結果 payload の url / Location・Referer ヘッダ / **HTTP/2 の :path 擬似ヘッダ** / 本文中の URL。クエリ値が URL の場合は再帰マスク、深さ 4 まで)・request の結果要約(set-cookie / 反射トークン)を既定マスク。マスクマーカーは percent-encode 耐性のある ASCII `[MASKED]`。**URL パスセグメントの値(/verify/<値>)はキー名がなく検出不能** → --deny で潰す(docs 明記済み)。curl 生成は Content-Type 未記録の JSON ボディに application/json を補完する。
- `src/daemon/journal.ts` — セッション別ジャーナル。`~/.kb/logs/<session>/events.jsonl` + meta.json に逐次追記。デーモン起動で自動開始(既定常時 ON)+ **古いセッションを prune**(既定 直近 20、KB_LOG_KEEP で変更)。main.ts が dispatch をラップして command イベントを記録(JOURNAL_EXCLUDE で読み取り系を除外)、host のフック(onJournalNet / onJournalConsole)が通信(xhr/fetch/document/other、allHeaders+postData 付き)とコンソールを記録。`kb log start --shots` で操作(AUTO_SHOT_CMDS)直後の自動スクショを `shots/auto-N.png` に保存しイベントの `shot` に紐付け。`kb log replay` は生ジャーナルの command イベント(REPLAY_CMDS、tab 指定はアクティブタブに読み替え)を順に RPC 再実行する。
- `src/shared/paths.ts` — `~/.kb/` 配下のパス定義と daemon.json / last-run.json の読み書き。
- `src/shared/proxyStore.ts` — proxies.json(プロファイル + active)の読み書き。

## 状態ファイル (`~/.kb/`)

- `daemon.json` — port / token / pid / buildId(デーモン起動中のみ存在。削除は所有 pid のみ)
- `last-run.json` — 前回起動時の headless / profile。自動 spawn が引き継ぐ。
- `daemon.spawn.lock` — 二重 spawn 防止ロック(30 秒で失効)。
- `profiles/<name>/` — Chromium user-data-dir(Cookie 等が永続化される)
- `downloads/` — `kb downloads` が保存するダウンロードファイル。
- `proxies.json` — プロキシプロファイルと active。CLI が直接編集し、デーモンには RPC で live 適用。
- `logs/<session>/` — 操作ログ(events.jsonl + meta.json)。`kb log list/show/steps/export/rm` は CLI がここを直接読む(デーモン不要)。
- `daemon.log` — デーモンのログ。デバッグはまずここを見る(起動タイムアウト時は CLI が末尾を表示する)。

## エージェント操作の推奨ループ

```bash
kb open <url> [--wait idle]     # SPA は idle(networkidle)待ち
kb snapshot                     # 要素 ref 付きアクセシビリティツリー(iframe 内は f1e3 形式)
kb click --ref e12              # ref で操作。操作系は移動後の URL/タイトルを返す
kb text                         # 結果を読む(既定 20000 文字、--offset で続き)
```

- 操作対象は 3 通り: CSS セレクタ / `--ref e12`(snapshot の ref。iframe 横断可)/ `--frame <sel>` + セレクタ。CSS セレクタ欄には Playwright のセレクタエンジンがそのまま使えるため、`kb click "text=保存"` や `kb click "role=button[name='Save']"` で snapshot を挟まない一発操作もできる。
- `kb text` / `kb html` / `kb snapshot` / `kb eval` は既定 20000 文字で切り詰め。`--offset <n>` で続き、`--max-chars 0` で全文。
- `kb eval` は **await・複数行コードをそのまま実行できる**(自動 async ラップ。最後の式または return の値が返る)。長いスクリプトは `--file <script.js>`。複数文は 1 文 1 行か `;` 区切りで書くと最後の式の判定が確実。
- `kb screenshot <sel>` / `kb screenshot --ref e12` で**要素単位のスクリーンショット**(`--full` とは併用不可)。重い SPA で安定待ちがタイムアウトするときは `--timeout <sec>` で延ばす。
- 操作系: click / fill / select(--label)/ check / uncheck / hover / upload(ローカルのファイルパスをそのまま渡す)/ press / scroll / back / forward / reload。
- `kb request <url> [-X POST] [-H "Name: value"] [-d body] [-o file]` — **ページ非依存の HTTP リクエスト**(context.request 経由)。Cookie・プロキシはブラウザと共有され、Set-Cookie も反映される。テキスト系は本文がそのまま返り(既定 20000 文字切り詰め)、バイナリは `-o` で保存。**JSON に見えるボディで Content-Type 未指定なら application/json を自動付与**(`inferJsonContentType`。明示 -H が常に優先)。
- `kb dom query --attr <name>` は属性がなければ**同名 DOM プロパティにフォールバック**(`<select>` の value / checked 等)。
- 最後のタブを `kb tabs close` しても空タブに置き換わりデーモンは生存する(ウィンドウを手動で閉じた場合は終了)。

## エージェント運用の注意(Claude Code から使うとき)

- **ref はページ遷移・DOM 変化で失効する。** 操作やナビゲーションの後は `kb snapshot` を取り直す。失効した ref は**同じ role/name の要素が一意に見つかれば自動で新 ref に再解決して操作される**(応答の `reResolvedRef` で分かる)。一意に決まらない場合はヒント付きエラーが返るので snapshot を取り直す。直近 snapshot をタブ毎にキャッシュして照合している(実装は `src/daemon/targets.ts` の `act()` / `reResolveRef()`)。
- **Bash ツールのタイムアウトに注意。** `kb wait`(既定 90 秒)や `--wait idle` を使うときは、Bash 側の timeout をそれより長く設定する(Bash 既定は 120 秒)。
- **`-f`(follow)は終了しないコマンド。** エージェントは `-f` 単体を使わず、`-n <件数>` での取得か `-f --for <sec>`(指定秒数で自動終了)を使う。
- **並列実行時はタブを明示する。** タブ省略時は「アクティブタブ」を共有するため、独立コマンドを並列に投げるときは各コマンドに `-t <id>` を付ける。
- **mode / profile / auth の切替後はタブ ID が変わる。** 応答に新しいタブ一覧が含まれるので、それを使って `-t` を振り直す。
- **`--json` の形は成功 `{ok:true, result}` / 失敗 `{ok:false, error}` で対称**(exit code でも判定可)。follow の JSON は 1 行 1 エントリのストリーム。

## モード・プロファイル・待機・エミュレーション

```bash
kb mode [headed|headless]        # 切替は再起動を伴うがタブ URL と Cookie は復元
kb profile list / use <name>     # user-data-dir 切替(再起動 + タブ復元)
kb auth set <user> <pass>        # 対象サイトの Basic 認証(再起動 + タブ復元)
kb wait [--url "**dashboard**"] [--selector h1] [--idle] [--any] [--timeout 120]   # 複数条件は既定 AND、--any で OR(満たした条件が matched で返る)
kb emulate ua "<UA>" / viewport 390x844 [--dpr 3 --mobile] / tz America/New_York / geo 35.68 139.76 / net slow3g / reset
```

- `kb daemon start --stealth [--ua "<実Chrome UA>"]` — 自動化の痕跡(navigator.webdriver 等)を実 Chrome 相当に均す。認可されたテスト向け。明示 start では `--stealth` を付けたときだけ有効(headless と同じく last-run は自動 spawn のみ継承)。`--cdp` アタッチとは排他(アタッチ先は元から実ブラウザ)。webdriver 消しは効くが JA3/IP 等のサーバ側判定は別レイヤなので、Cloudflare Managed Challenge 突破の保証はない(そこが要るときは `--cdp` で自分が起動した実 Chrome に繋ぐのが確実)。
- 手動介入の運用: headed のままユーザーがウィンドウを直接操作 → agent は `kb wait --url ...` で完了を検知して再開。ログイン済み状態は `kb storage dump` で保存できる。
- `kb login [url] [--until <glob>] [--save <file>]` — 手動サインインの段取りを 1 コマンド化(headless なら headed へ切替 → URL を開く → `--until` の URL glob 一致か Enter 押下で完了 → 保存状態を確認)。ログイン状態はプロファイル(user-data-dir)に自動永続化されるので、次回以降のセッションは何もしなくてもログイン済みで始まる。非 TTY では `--until` 必須。
- エミュレーションはタブ単位(geo のみ context 全体)。CDP セッションを detach するとオーバーライドが消えるため、host が CDPSession をタブ毎に保持し続ける実装になっている。UA 上書き時は Client Hints メタデータも追随、mobile viewport はタッチも有効化。

## DevTools 系コマンド

```bash
kb net log [--filter <regex>] [--responses] [-f] [-n 50]   # Network タブ相当。行頭に #seq。--responses で完了相のみ。-f で追従
kb net body <seq>                             # 捕捉済みレスポンス本文(seq は net log の行頭番号)
kb net headers <seq>                          # 全リクエスト/レスポンスヘッダ(allHeaders、直近 2000 件。relay の内部認証ヘッダは除去)
kb net block "*://*.doubleclick.net/*"        # glob パターンで遮断
kb net mock "*://api.example/**" [--body mock.json | --text '{"error":1}'] [--status 500]   # 既存エンドポイントのエラー差し替えにも使える(本文省略可)
kb net rules / kb net unroute <id> | --all
kb net har start / stop -o out.har            # HAR 記録(本文含む、256KB/エントリ上限。二重 start はエラー)
kb console [-f] [--clear]                     # console.log / pageerror
kb dom query "h1" [--html] [--attr href] [--frame iframe]
```

ログはデーモン内のリングバッファ(3000 件)に seq 付きで蓄積され、`-f` は since カーソルのポーリング(700ms)で追従する。レスポンス本文はテキスト系 Content-Type の XHR / fetch / document / other について自動捕捉される(実装は `captureNetBody()` + `BodyStore`)。**捕捉は 1 件 256KB(NET_BODY_CAP)で切り詰め**、全体 32MB / 500 件で古いものから破棄。`--offset` は捕捉済み範囲内のページングであり、256KB を超えた部分は後から取得できない(全文が要るときは `kb request -o` で取り直す)。request 行の seq を渡しても対応する response に自動で読み替える。

## プロキシ操作

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 [--user u --pass p] [--bypass "*.internal,localhost"]
kb proxy list          # * = アクティブ
kb proxy use work      # デーモン起動中なら無再起動で即時切替
kb proxy off           # direct に戻す
kb proxy status        # デーモンに実際に適用中の状態(stats 含む)
kb proxy test [work]   # 外部 IP と応答時間で疎通確認
kb proxy rule add "*.corp.example.com" work   # ホスト別振り分け(先勝ち、FoxyProxy 相当)
kb proxy rule list / kb proxy rule rm <index>
```

add / rm / use / rule の変更はすべて proxies.json 書き込み + `proxy.reload` RPC で live 反映される(アクティブプロファイルの上書きも即時)。中継の接続失敗(ブラウザ側 `ERR_TUNNEL_CONNECTION_FAILED`)は `relay.recordError()` が stats・直近 20 件リスト(`proxy status` の lastErrors)・daemon.log の 3 か所へ記録する。TCP 接続は `autoSelectFamily: true`(happy eyeballs)で IPv6/IPv4 片系死にに耐える。

## 動作確認の基本ループ

```bash
node dist/cli.js open example.com
node dist/cli.js snapshot        # 構造を見る
node dist/cli.js text            # 本文をテキストで読む
node dist/cli.js screenshot -o s.png   # 画像は Read ツールで確認
node dist/cli.js daemon stop     # ブラウザごと終了
```

デフォルトは headed(ウィンドウ表示)。ユーザーはウィンドウを直接操作でき、CLI 操作と常時併用可能。隔離テストは `KB_HOME=<tmpdir>` を指定して実デーモンと分離する。

## ロードマップ

docs/requirements.md 参照。M1(骨格)/ M2(プロキシプロファイル)/ M3(DevTools 系)/ M4(モード切替・wait・エミュレーション)/ M5(振り分けルール・MCP・npm link 配布)/ M6(エージェント最適化: snapshot+ref、出力上限、堅牢化、セッション保存、ダウンロード、PDF 他)/ M7(利用者フィードバック反映: `kb net body`・`kb request`・`kb login`・screenshot `--timeout`、2026-07)/ M8(第 2 次フィードバック: CDP アタッチ・`--channel`/`--ua`・`kb net headers`・mock 拡張・JSON 推定・relay エラー可視化、2026-07)/ M9(操作記録: `kb log` ジャーナル・レポート・マスク付き export バンドル・curl 単体再実行。仕様は ../kb-feature-request.md P8 + ../operation-log.md、2026-07)/ M10(v0.5.0 検証フィードバック対応: cdp fail-fast・自動起動通知・URL クエリマスク・`--ua ""`/`--channel auto` リセット・`unroute --all`・ログ prune・`log replay`・`--shots`・`net log --responses`。../kb-v0.5.0-feedback.md 参照、2026-07)完了。

単一バイナリ(exe)化は見送り: Playwright はブラウザ実体とドライバ資産をディスク上に必要とするため bundler と相性が悪い。配布は npm パッケージ(`npm link` / `npm pack`)を正とする。

## 残課題(バックログ)

- Linux: ユニットテストは WSL Ubuntu 24.04 + node22 で全パス確認済み(2026-07)。コードに OS 依存なし(パスは path.join、spawn/lock/pid 判定も POSIX 互換)。ブラウザ実起動の E2E は未実施 — 素の環境では `npx playwright install chromium --with-deps` で依存ライブラリ(libnss3 等)の導入が必要。
- eval の「最後の式」判定はパーサでなく構文チェック付きヒューリスティック。`x = 1\n+2` のような ASI 依存の書き方では誤分割しうる(1 文 1 行推奨)。
- ref 自動再解決は「同じ role/name が一意」の場合のみ。同名ボタンが複数あるページでは再解決されずエラーになる(安全側)。
- `kb net mock` はテキスト本文のみ(バイナリ未対応)。
- UA エミュレーションの reset は空文字セット頼みで、完全に戻すにはタブを開き直すのが確実。
- `kb net body` の捕捉対象はテキスト系の xhr/fetch/document/other のみで、256KB/件で truncate(HAR も同様にテキスト系・256KB 以下のみ本文を含める)。バイナリや 256KB 超の全文は `kb request -o <file>` で取り直すのが唯一の経路。
- storage restore の localStorage 復元はオリジンごとに一時ページを開く方式(遷移不可のオリジンはスキップされる)。
- 複数サインインセッションの同時併用(要望 P5)は未対応。persistent context は 1 プロセス 1 context のため、現状は `KB_HOME` を分けた 2 デーモン併走が回避策(docs 記載済み)。対応するならマルチ BrowserHost 化の大改修になる。
- `kb log replay` は生ジャーナルの成功コマンドのみ再実行し、tab 指定をアクティブタブに読み替える(マルチタブの並行操作の忠実な再現は非対応)。summarizeArgs で 2000 文字超に切り詰められた引数(巨大 eval 等)は再実行が壊れる。
- CLI 出力は日英混在(操作結果の一部が英語)。i18n 統一は見送り中。
- 操作ログの通信記録は xhr/fetch/document/other のみ(画像・静的アセットは対象外)。`kb request` は command イベントとして記録され、requests/ の curl にも含まれる(context.request はページイベントに乗らないため net イベントにはならない)。
