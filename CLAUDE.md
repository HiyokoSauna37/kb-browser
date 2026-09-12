# kb — CLI Browser

Playwright + Chromium (CDP) ベースの CLI 操作型ブラウザ。デーモンがブラウザを常駐保持し、`kb` コマンドが localhost RPC で命令を送る 2 プロセス構成。

## ビルドと実行

```bash
npm run build          # tsc → dist/
npm test               # ビルド + ユニットテスト (node:test, dist/**/*.test.js。ブラウザ不要)
npm run test:e2e       # 実ブラウザ e2e スモーク (dist/e2e/**/*.e2e.js。隔離 KB_HOME で実デーモンを起動。
                       #                          ブラウザ未導入なら自動 skip)
npm run test:all       # test + test:e2e
kb <cmd>               # npm link 済み(グローバル)。開発中は node dist/cli.js <cmd>
```

注意: デーモンは起動時の dist/ を保持し続けるため、**ビルド後は再起動しないと新コードが反映されない**(CLI が buildId 不一致を検知して stderr に警告を出す)。**`kb daemon restart`** が前回の構成(channel / profile / UA / headless / stealth / extensions / ignore-https-errors、`--cdp` アタッチ先も)を last-run から引き継いで再起動する(ビルド反映にも使える。旧 pid とその子 Chromium の消滅を待ってから起動して ProcessSingleton 競合を避ける)。`kb daemon status` が running/disk のビルド時刻と match/MISMATCH を併記するので、警告が本物か(コード同一で mtime だけ変わった等)を確認できる。

## ドキュメント更新ゲート

コード、設定、CLI、MCP、永続化形式、またはユーザーから見える挙動を変更したら、完了前にドキュメントへの影響を必ず確認する。

- CLI コマンド、引数、オプション、既定値: <code>--help</code> と <code>docs/CLI_REFERENCE.ja.md</code>
- MCP ツール名、入力スキーマ、説明: 実装上の説明、リファレンスの MCP 節、README のツール数
- インストール、代表的な使い方、セキュリティ上の注意、ユーザー向けワークフロー: <code>README.ja.md</code> と <code>README.md</code>
- アーキテクチャ、状態ファイル、開発・保守手順: このファイル
- 更新不要の場合: 最終報告に影響確認済みであることと理由を記載

関連する CLI の <code>--help</code> と実装を文書に照合するところまでを完了条件とする。この規則はルートの <code>AGENTS.md</code> にも記載している。

## アーキテクチャ

- `src/cli.ts` — CLI エントリ(bin)。コマンド定義はグループ別に `src/cli/commands/`(daemon / browse / actions / signup / state / log / env / net / proxy)にあり、登録順 = ヘルプの表示順。全コマンド `--json` 対応(成功 `{ok:true,result}` / 失敗 `{ok:false,error}`)。`log` コマンドの生ジャーナル読み取りは `src/cli/commands/logStore.ts`(readline ストリーム: countEvents / readEventsTail / readEventsAll)に分離。
- `src/cli/output.ts` — CLI 共通の出力ヘルパ(print / run / truncNote / fmtTabs / intOpt / floatOpt)と `--json` 状態の一元管理(setJsonOutput / isJsonOutput)。
- `src/shared/rpc.ts` — **RPC の単一の情報源**。全コマンドの引数を zod スキーマで一元定義(`rpcSchemas`)し、`RpcCommand` 型・`RpcArgs<C>`・`isRpcCommand` を導出。client の `rpc<C>(cmd, args)` はこれで引数を型検査し、daemon は受信境界で `parse` してから型付き handler map へ渡す(かつては CLI/MCP/dispatch の 3 箇所に手書きされていた引数形状を集約)。**MCP SDK の `tool()` にこのスキーマを渡さないこと**(下記メモリ地雷)。ジャーナル分類の `JOURNAL_EXCLUDE` / `AUTO_SHOT_CMDS` もここに置き RpcCommand 型で typo を弾く。
- `src/shared/constants.ts` — 層をまたぐ調整定数(LOG_CAP / TEXT_CAP / TEXT_CONTENT_RE / WAIT_*_SEC / REQUEST_TIMEOUT_SEC / NET_LOG・CONSOLE のデフォルト件数)。`daemon/types.ts` は後方互換のため LOG_CAP 等をここから re-export する。
- `src/shared/format.ts` — CLI / MCP 共通の表示整形(hhmmss / 切り詰め注記の範囲計算 truncSpan / Set-Cookie 個別行整形)。文言は各層が持ち、計算だけを共有。
- `src/shared/version.ts` — `KB_VERSION`。package.json を単一の情報源として実行時に読む(バージョン文字列をコードに書かないこと)。
- `src/mcp.ts` — MCP stdio サーバ (`kb-mcp`)。デーモンの機能を 34 ツールとして公開。`claude mcp add kb -- kb-mcp` で登録。各ツールは `rpc()` の薄いラッパ(実処理は daemon 側に一元化)。**SDK の zod ジェネリクスは tsc をメモリ爆発させるため、型消去した `tool()` ラッパ経由で登録している(server.tool を直接呼ばないこと。shared/rpc.ts のスキーマもここには渡さない)。**
- `src/shared/client.ts` — デーモンへの RPC クライアント(CLI / MCP 共用)。`rpc<C>(cmd, args)` はリテラルコマンド名なら引数を `RpcArgs<C>` で型検査、動的 cmd(replay/follow)は緩いオーバーロードにフォールバック。未起動時は自動 spawn(前回の headless/profile/channel/ua を last-run.json から引き継ぎ、spawn ロックで二重起動を防止。**起動内容を stderr に 1 行通知**)。pid 生存確認(`isPidAlive`。EPERM=生存)+ `waitForPidDeath` で stale/再起動を判定。**明示的な `kb daemon start` はフラグなし = headed**(last-run 継承は自動 spawn のみ)。`waitForDaemon(child)` は spawn 直後の子プロセス死亡を検知して 30 秒待たずに daemon.log 付きで即エラー(--cdp 接続失敗などの fail-fast)。`--ua ""` / `--channel auto` は last-run 継承をクリアする明示リセット。
- `src/shared/util.ts` — 純粋関数(normalizeUrl / clip / LogBuffer / prepareEval)。テスト対象。**prepareEval は eval コードの自動 async ラップ**(await 入りの式・複数文を async IIFE 化し、最後の式を構文チェック付きで return に書き換える)。
- `src/cli/commands/signup.ts` + `src/shared/signup.ts` — `kb signup bootstrap/adopt/status/checkpoint`。Cloudflare 等でアカウント作成自体が止まる対象向けに、bootstrap はインストール済み Chrome/Edge を Playwright/CDP/remote-debugging/automation フラグなし + 専用 profile + 既定 direct で起動する。人が登録・OTPを完了してブラウザを正常終了した後、adopt が同じ profile を kb に引き継ぐ。成功条件は必須 check URL + challenge/verdict/**最終 URL**、任意 `--expect-selector` / `--expect-cookie`。全条件が正常なときだけ storageState checkpoint を保存し、checkpoint 更新時も再診断する。`--restore-proxy` は元の上流 proxy で再診断し、劣化時は direct + 正常 checkpoint へ rollback して再確認。PID だけでなく `procscan.findProfileProcesses` で `--user-data-dir` を持つ子も検出し、通常ブラウザと kb の同時 profile 利用を拒否する。Windows Chrome が launcher PID を exit=0 で別 main process へ引き渡す挙動も profile process で追跡する。session Cookie は通常 Chrome 終了で消えるため引き継げず、期限付き Cookie が前提(`--expect-cookie` で消失を検出)。
- `src/daemon/main.ts` — デーモンのエントリ(`parseArgs(argv, env)` → `new Daemon(config).start()`)。
- `src/daemon/daemon.ts` — **Daemon クラス**。HTTP サーバ (127.0.0.1 ランダムポート + timing-safe トークン認証)、RPC を shared/rpc.ts のスキーマで検証してから**型付き handler map**(`{ [C in RpcCommand]: ... }` で全コマンド網羅をコンパイル時強制)へディスパッチ、操作ジャーナル記録、idle reaper、shutdown を担う。`parseArgs` は純関数でテスト対象。uncaughtException でデーモンを落とさない。
- `src/daemon/host.ts` — BrowserHost(facade。RPC から呼ばれるメソッド名はここに揃う)。状態と自己完結ロジックは `src/daemon/host/` のコラボレータに分割:**launcher.ts**(launchOwned の channel フォールバック + attachOverCdp)/ **tabs.ts**(TabRegistry: Map + 採番 + アクティブタブ)/ **dialogs.ts**(DialogManager: 保留・応答・actOrDialog)/ **downloads.ts**(DownloadManager)/ **httpClient.ts**(kb request の無状態 HTTP クライアント)。イベント配線(registerTab)とオーケストレーションは facade が持つ。`launchPersistentContext` で Chromium を保持、タブを ID 管理。channel は chrome → msedge → 同梱 chromium の順にフォールバック(`--channel` 明示時はフォールバックせず strict)。`--ua` で context 全体の UA 上書き。**`--extensions`** は Playwright 既定の `--disable-extensions` を ignoreDefaultArgs で外し(プロファイルにインストール済みの拡張が有効になる)、ディレクトリ指定時は `--load-extension` で未パック拡張を読み込む。**未パック拡張指定時のチャネル自動選択は同梱 Chromium のみ**(Chrome 137+ stable は --load-extension を削除済みのため chrome/msedge を飛ばす)。かつ「同梱 Chromium」を undefined でなく明示 channel 'chromium' として渡す — undefined + headless だと旧 headless(headless shell)になり拡張がロードされないため(channel 'chromium' は同一バイナリで拡張が動く新 headless を使う)。**ステルス(`--stealth`)は既定 ON**(v0.11.0〜)。自前起動時のみ起動 args に `--disable-blink-features=AutomationControlled` を付けて `navigator.webdriver` を実 Chrome 同様に消し、「自動化されたブラウザに見える」せいで Cloudflare 等のボット判定に弾かれるのを防ぐ。`--no-stealth` で無効化(`navigator.webdriver=true` のまま。ボット挙動そのものをテストしたいとき用)。計測上、chrome チャネルではこのフラグ**だけ**で plugins/languages/WebGL/permissions まで実 Chrome と一致するため、**JS パッチ(init script)は入れていない**(過剰パッチ自体が新たな検知痕跡になる — 以前 permissions シムを入れて `query.toString()` 非ネイティブ化等の綻びを増やしたため撤去した)。残る綻びは headless の "HeadlessChrome" UA だけなので `--ua` と併用するか headed を使う。実 Chrome/Edge が無く同梱 Chromium にフォールバックしたら CLI が警告する(同梱 Chromium は実 Chrome より検知されやすい)。**JA3/TLS・HTTP2・IP レピュテーション・CDP の Runtime.enable リーク等のサーバ側/プロトコル層の判定は client では潰せない**(Cloudflare Turnstile / Managed Challenge の自動突破は保証しない。硬いチャレンジは `kb login`〔人が 1 回解く → cf_clearance がプロファイルに永続化〕か `--cdp` で自分が起動した実 Chrome にアタッチするのが確実)。`--stealth`/`--no-stealth` の明示指定は `getOptionValueSource` で判別し、`--cdp`(アタッチ)との排他は**明示 `--stealth` のときだけ**(既定 ON は自動で off に正規化)。アタッチ(`--cdp`)時は start() で stealth を無効に正規化(status が嘘をつかないため)。mode/profile/auth 切替は共通の `restart()` でタブ URL を復元(stealth も維持)。**アタッチモード**(`--cdp <url>` → `connectOverCDP`)では既存ブラウザの既定 context に接続する: stop は `browser.close()` で切断のみ(対象ブラウザは殺さない)、mode/profile/auth と proxy 切替は `assertNotAttached()` でエラー、last-run に cdp は残さない(自動 spawn は常に通常起動)。Chrome 136+ は既定プロファイルで CDP 不可(専用 --user-data-dir 必須)。
- `src/daemon/wsMonitor.ts` — WsMonitor。WebSocket の**観測**(`kb ws log`)。`page.on('websocket')` でフレームをリングバッファに溜める(1 フレーム 8KB 上限、バイナリは base64)。Playwright の WebSocket API は観測専用で送信できないため、送受信は下の wsClient が持つ。
- `src/daemon/host/wsClient.ts` — kb 自身が張る WebSocket(`kb ws connect/send/recv/close`)。**ページコンテキストで `new WebSocket()` する**のが要点で、Cookie・Origin・TLS 指紋・プロキシがそのページのものになる(Node 側から張り直すと調べたい相手のセッションと別物になる)。`window.__kbWs` に受信リングバッファ(500 件 / 1 件 64KB)を持ち、`recv --since` はカーソル読み(バッファを消費しない)。**ページ遷移でソケットは失われる**(その旨のエラーを返す)。
- `src/daemon/host/session.ts` + `src/shared/challenge.ts` — `kb session check`(セッション診断)。判定ロジック(`detectChallenge` / `judgeSession`)は純関数で shared 側、実プローブは daemon 側。navigate probe はリダイレクト後の `finalUrl` と、任意 `expectSelector` の visible 判定も返す(signup adopt がログイン画面への退避や認証要素欠落を成功扱いしないため)。
- `src/daemon/netMonitor.ts` — NetMonitor。通信ログのリングバッファ、テキスト系レスポンス本文・全ヘッダの捕捉(`kb net body/headers`。request seq → response seq の自動読み替え含む)、block/mock ルール(再起動時は `reapplyRoutes()` で新 context に引き継ぐ)、HAR 記録、ジャーナル向け net イベント通知。
- `src/daemon/targets.ts` — TargetResolver。selector / ref / frame → Locator の解決と、失効 ref の自動再解決(タブ毎の直近 snapshot キャッシュで role/name 照合。実装は `act()` / `reResolveRef()`)。
- **JS ダイアログ (alert/confirm/prompt)** — host.ts の `page.on('dialog')` が既定ポリシー **hold** で保留する(Playwright はリスナーなしだと表示前に自動 dismiss してしまい、`confirm` が常に false → 「ボタンを押しても反応しない」ように見えるのが元バグ)。保留中は該当タブの JS が止まるため、`click`/`fill`/`press`/`check`/`select` は `actOrDialog()` で操作完了を待たずに `{dialog}` を返し、`getPage()` が他操作をガードする(`kb dialog accept/dismiss` で応答するまで)。閉鎖検知はタブ毎の自前 CDPSession `Page.javascriptDialogClosed`(Playwright の Dialog に閉鎖イベントがなく、headed でユーザーがウィンドウ上で応答した場合の保留残りを解除するため)。ポリシーは `kb dialog policy hold|accept|dismiss` で切替(accept/dismiss は表示せず即応答)。CLI は `kb dialog [show|accept|dismiss|policy]`、MCP は `kb_dialog`。
- `src/daemon/emulation.ts` — Emulator。UA / viewport / tz / 回線の CDP エミュレーション。CDP セッションを detach するとオーバーライドが消えるため、タブ毎に CDPSession を保持し続ける。
- `src/daemon/types.ts` — デーモン内共有の型(HostOptions / Target / NetEntry 等)。調整定数(LOG_CAP / TEXT_CAP / TEXT_CONTENT_RE)は `shared/constants.ts` へ移動し、後方互換のためここから re-export する。host.ts から参照される。
- `src/daemon/relay.ts` — ローカル中継プロキシ。Chromium は常にここを向き、上流(http/socks5/direct)だけ差し替えることで**無再起動のプロキシ切替**を実現。SOCKS5 認証代行・bypass パターン・接続タイムアウト(10s)もこの層。**中継自体もセッション毎トークンの Basic 認証**で他ローカルプロセスの相乗りを防ぐ(KB_RELAY_NOAUTH=1 で無効化)。
- `src/shared/oplog.ts` — 操作ログの純関数層(イベント型 / マスキング / report.md / steps / curl 生成)。テスト対象。**マスクは export/show 時のみ適用し、生ジャーナルは無改変**が原則。fill 値・eval 戻り値・機微ヘッダ・ボディ内の password/token 系キー・**URL クエリの機微キー**(net.url / args.url / 結果 payload の url / Location・Referer ヘッダ / **HTTP/2 の :path 擬似ヘッダ** / 本文中の URL。クエリ値が URL の場合は再帰マスク、深さ 4 まで)・request の結果要約(set-cookie / 反射トークン)を既定マスク。マスクマーカーは percent-encode 耐性のある ASCII `[MASKED]`。**URL パスセグメントの値(/verify/<値>)はキー名がなく検出不能** → --deny で潰す(docs 明記済み)。curl 生成は Content-Type 未記録の JSON ボディに application/json を補完する。
  **機微ヘッダ名は語幹で拾う**(v0.12.0〜): `x-<なにか>-token` / `-key` / `-secret` / `-signature` / `-auth` / `-session` / `-jwt` / `-csrf` 系にマッチするので、サイト固有の `X-Validation-Token` や `X-Request-Signature`、`X-Amz-Security-Token` も既定でマスクされる(`X-Trace-Id` のような非機微ヘッダは残る)。
  **JWT は名前でなく値の形状で拾う**(`maskJwts`): キー名が機微でない `{"assertion":"eyJ…"}` や URL パスセグメントに埋まった JWT も検出し、**既定は署名部だけを潰す**(`eyJhdr.eyJclaims.[MASKED]`)。クレーム(sub/exp/iss/aud)はレポートの証拠そのもので、再利用を可能にしているのは署名部だけ、という考え方。`kb log show/steps/export --mask-jwt full`(全体)/ `off`(形状マスクを止める。ヘッダ名による既定マスクは効いたまま)で切替。`--no-mask` では形状マスクも止まる。マスク済み文字列を再度通しても `[MASKED]` が増えない(否定先読みで冪等)。
- `src/daemon/journal.ts` — セッション別ジャーナル。`~/.kb/logs/<session>/events.jsonl` + meta.json に記録。デーモン起動で自動開始(既定常時 ON)+ **古いセッションを prune**(既定 直近 20、KB_LOG_KEEP で変更)。Daemon が dispatch をラップして command イベントを記録(JOURNAL_EXCLUDE で読み取り系を除外)、host のフック(onJournalNet / onJournalConsole)が通信(xhr/fetch/document/other、allHeaders+postData 付き)とコンソールを記録。**書き込みはバッファ方式**: 高頻度の net/console は溜め、replay/report に効く **command イベント境界で同期 flush**(+ 500ms unref タイマ + stop() で flush)。ハードクラッシュ時の喪失は「直近 command 以降の net/console」に限定される(command は常に即 durable)。`kb log start --shots` で操作(AUTO_SHOT_CMDS)直後の自動スクショを `shots/auto-N.png` に保存しイベントの `shot` に紐付け。`kb log replay` は生ジャーナルの command イベント(REPLAY_CMDS、tab 指定はアクティブタブに読み替え)を順に RPC 再実行する。
- `src/shared/paths.ts` — `~/.kb/` 配下のパス定義と daemon.json / last-run.json の読み書き。
- `src/shared/proxyStore.ts` — proxies.json(プロファイル + active)の読み書き。

## 状態ファイル (`~/.kb/`)

- `daemon.json` — port / token / pid / buildId(デーモン起動中のみ存在。削除は所有 pid のみ)
- `last-run.json` — 前回起動時の headless / profile。自動 spawn が引き継ぐ。
- `daemon.spawn.lock` — 二重 spawn 防止ロック(30 秒で失効)。
- `profiles/<name>/` — Chromium user-data-dir(Cookie 等が永続化される)
- `signups/<name>/` — signup bootstrap/adopt の state.json + 正常確認済み storage-state.json(ログイン秘密情報を含むため非共有)。
- `downloads/` — `kb downloads` が保存するダウンロードファイル。
- `proxies.json` — プロキシプロファイルと active。CLI が直接編集し、デーモンには RPC で live 適用。
- `logs/<session>/` — 操作ログ(events.jsonl + meta.json)。`kb log list/show/steps/export/rm` は CLI がここを直接読む(デーモン不要)。
- `cookie-seen.json` — `kb session check` が使う「その Cookie 値を kb が最初に観測した時刻」(値ではなくハッシュ + 時刻)。Cookie に発行時刻が無いための代用。
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
- 操作系: click / fill / select(--label)/ check / uncheck / hover / upload(ローカルのファイルパスをそのまま渡す)/ press / scroll / back / forward / reload。**操作で `confirm`/`alert`/`prompt` が開くと応答に `dialog` が入り、そのタブは応答待ちになる → `kb dialog accept [text]` / `kb dialog dismiss` で応答**(詳細はアーキテクチャの JS ダイアログ節)。
- `kb request <url> [-X POST] [-H "Name: value"] [-d body] [-o file]` — **ページ非依存の HTTP リクエスト**(context.request 経由)。Cookie・プロキシはブラウザと共有され、Set-Cookie も反映される。テキスト系は本文がそのまま返り(既定 20000 文字切り詰め)、バイナリは `-o` で保存。**JSON に見えるボディで Content-Type 未指定なら application/json を自動付与**(`inferJsonContentType`。明示 -H が常に優先)。**レスポンスの Set-Cookie は既定で個別行表示**(`-i`/MCP `includeHeaders` で全ヘッダも表示)。Playwright の `res.headers()` は複数 Set-Cookie を 1 つに畳んで parse 不能になるため、`res.headersArray()` から個別に取り出した `setCookies` を別途返す(`--json` の result.setCookies。export バンドルでは機微ヘッダ同様マスク)。**`--no-follow`** は 3xx で止めて最終リダイレクト先に行かない。**`--follow-verbose`**(MCP `kb_request` は `followVerbose`)は `maxRedirects:0` で 1 ホップずつ手動追従し、各ホップの status / Location / Set-Cookie を表示する(実装は httpClient の `followVerbose`。Cookie jar 共有によりリダイレクト途中で撒かれた Cookie も次ホップに反映され、`--json` の result.hops に配列で載る)。メソッド/ボディの引き継ぎはブラウザ準拠(`methodAfterRedirect`: 303 は GET 化、301/302 は POST を GET 化、307/308 は維持)。`--no-follow` とは排他。
- `kb dom query --attr <name>` は属性がなければ**同名 DOM プロパティにフォールバック**(`<select>` の value / checked 等)。
- 最後のタブを `kb tabs close` しても空タブに置き換わりデーモンは生存する(ウィンドウを手動で閉じた場合は終了)。ただしデーモンはアイドル自動終了の対象で、無活動が続けば自ら終了する(下記「デーモンの寿命」節)。

## エージェント運用の注意(Claude Code から使うとき)

- **ref はページ遷移・DOM 変化で失効する。** 操作やナビゲーションの後は `kb snapshot` を取り直す。失効した ref は**同じ role/name の要素が一意に見つかれば自動で新 ref に再解決して操作される**(応答の `reResolvedRef` で分かる)。一意に決まらない場合はヒント付きエラーが返るので snapshot を取り直す。直近 snapshot をタブ毎にキャッシュして照合している(実装は `src/daemon/targets.ts` の `act()` / `reResolveRef()`)。
- **Bash ツールのタイムアウトに注意。** `kb wait`(既定 90 秒)や `--wait idle` を使うときは、Bash 側の timeout をそれより長く設定する(Bash 既定は 120 秒)。
- **`-f`(follow)は終了しないコマンド。** エージェントは `-f` 単体を使わず、`-n <件数>` での取得か `-f --for <sec>`(指定秒数で自動終了)を使う。
- **並列実行時はタブを明示する。** タブ省略時は「アクティブタブ」を共有するため、独立コマンドを並列に投げるときは各コマンドに `-t <id>` を付ける。
- **mode / profile / auth の切替後はタブ ID が変わる。** 応答に新しいタブ一覧が含まれるので、それを使って `-t` を振り直す。
- **`--json` の形は成功 `{ok:true, result}` / 失敗 `{ok:false, error}` で対称**(exit code でも判定可)。follow の JSON は 1 行 1 エントリのストリーム。

## デーモンの寿命(アイドル自動終了・後片付け・孤児回収)

- デーモンは常駐側(ブラウザ本体を保持)で最初の RPC により自動起動し、以後常駐する。放置による堆積を防ぐため **アイドル自動終了** を持つ: 最後の活動(RPC 受信 / ページのネットワーク・コンソール活動)から一定時間なにも無ければデーモン自身が既存の shutdown 経路で graceful に終了する(実装は `src/daemon/idle.ts` の `IdleReaper`。タイマーは unref 済みで SIGINT やウィンドウ手動クローズなど他の終了経路を阻害しない)。**実行中の RPC がある間は閾値を超えても発火しない**(in-flight ガード。`kb wait` 等の「閾値より長い単一 RPC」が実行中に刈り取られないため。RPC 完了時にも touch され、そこが新たな起点になる)。
- 閾値は `kb daemon start --idle-timeout <分>`(0 で無効)、または環境変数 `KB_IDLE_TIMEOUT`(**秒**単位。テストで短い値を使いやすいよう秒)で設定する。優先順は `--idle-timeout` > `KB_IDLE_TIMEOUT` > 既定 **30 分**。last-run に記録・継承されるのは**明示 `--idle-timeout` のみ**(channel/ua と同じ扱い)。env・既定から解決した値は焼き込まない — 焼き込むと以後の spawn で last-run が引数として最優先になり、`KB_IDLE_TIMEOUT` が二度と効かなくなるため。`kb daemon status` に `idle=<秒>`(無効時は `idle=off`)が出る。
- headed でユーザーがウィンドウを直接操作している間はページ活動(ナビゲーション等)が出るため延命される。逆に裏で定期ポーリングし続けるページは延命され得るが、これは「読んでいるユーザーを殺さない」ための保守的なトレードオフ(既定 30 分は長め)。
- **MCP サーバ (`kb-mcp`) は切断時に後片付けする**: このプロセスが自動起動したデーモンだけを、stdin クローズ / SIGINT / SIGTERM で停止する(`src/shared/client.ts` の `spawnedDaemonHere()` で所有判定)。既に走っていたデーモンに相乗りしただけなら止めない(CLI 併用を壊さないため)。SIGKILL 等でこの片付けが走らなくても、上のアイドル自動終了が最終的な安全網になる。
- `kb daemon stop --all` — daemon.json に登録されていない**孤児デーモン**(SIGKILL/OOM で登録が外れた等)も含め、**この KB_HOME の**デーモンを子 Chromium ごと停止する。登録済みデーモンにはまず graceful 停止を送り、最大 5 秒その終了を待ってから残りをツリーキルする(即 /F でジャーナル最終書き込みを中断しないため)。所有判定(`src/daemon/procscan.ts` の `findOwnedDaemons`)は 2 経路: **(1) デーモン argv の `--home <KB_HOME>` マーカーで直接同定**(client.ts の spawnDaemon が焼く。パス解決は env KB_HOME が正で、この値は識別専用)。子 Chromium の生死に依存しないため、**Chromium が先に死んで node だけ残った孤児**も掴める。**(2) 後方互換**: マーカーのない旧バージョン起動のデーモンは、子 Chromium の `--user-data-dir` がこの KB_HOME の profiles 配下のものから祖先を辿って特定する。いずれも他 KB_HOME の正常デーモンや自プロセスは誤爆しない。`--dry-run` で対象確認のみ。Windows は `taskkill /T /F`、POSIX はプロセスグループ kill でツリー停止する。

## モード・プロファイル・待機・エミュレーション

```bash
kb mode [headed|headless]        # 切替は再起動を伴うがタブ URL と Cookie は復元
kb profile list / use <name>     # user-data-dir 切替(再起動 + タブ復元)
kb auth set <user> <pass>        # 対象サイトの Basic 認証(再起動 + タブ復元)
kb wait [--url "**dashboard**"] [--selector h1] [--selector-gone ".challenge"] [--idle] [--any] [--timeout 120]   # 複数条件は既定 AND、--any で OR(満たした条件が matched で返る)。--selector-gone は要素が消える(非表示/DOM 除去)まで待つ
kb emulate ua "<UA>" / viewport 390x844 [--dpr 3 --mobile] / tz America/New_York / geo 35.68 139.76 / net slow3g / reset
```

- `kb daemon start --extensions <拡張dir,...|on|off>` — Chrome 拡張機能。ディレクトリ指定で解凍済み拡張を読み込み(CLI が絶対パス化 + manifest.json を検証)、`on` はプロファイル拡張の有効化のみ(ストア拡張は headed + chrome チャネルでウィンドウから普通にインストール)、`off` で解除。channel/ua と同じく last-run 継承(明示 start でも未指定なら引き継ぐ)。`--cdp` とは排他。
- `kb daemon start --ignore-https-errors` — HTTPS 証明書エラーを全無視する(context の `ignoreHTTPSErrors`)。自己署名のローカル環境や、CA を信頼させていない MITM デバッグプロキシの escape hatch。`kb request` も context 設定を継承する。**全証明書を無検証にするので、特定 1 枚だけ許す `kb proxy trust-ca --scoped` / `--ca`(上記プロキシ節)の方が安全**。`--cdp` アタッチとは排他(context 生成条件を変えられないため)。last-run 継承 + status に `ignore-https-errors=on` を表示。
- **ステルスは既定 ON**(navigator.webdriver 等を実ブラウザ相当に均す)。`kb daemon start --no-stealth` で無効化(webdriver=true のまま)。`--ua "<実Chrome UA>"` は headless で "HeadlessChrome" を隠すのに併用する。`--cdp` アタッチとの排他は**明示 `--stealth` のときだけ**(既定 ON なら自動で off に正規化して繋ぐ)。webdriver 消しは効くが JA3/IP/Runtime.enable 等のサーバ側・プロトコル層判定は別レイヤなので、Cloudflare Turnstile / Managed Challenge の自動突破は保証しない(そこが要るときは下記 `kb login` で人が 1 回解いて cf_clearance を永続化するか、`--cdp` で自分が起動した実 Chrome に繋ぐのが確実)。
- `kb translate [--to ja] [--restore|--toggle|--text]` — ページ内容を翻訳する(Chrome の「このページを翻訳」相当。実装は `host.translate` + `host/translate.ts`)。既定は **in-place**: 本文のテキストノードを走査して訳文で置換し、原文を `window.__kbTrans`(nodes/original/translated/detected/shown)に退避する。`--restore` で原文へ、`--toggle` で翻訳⇄原文を切替(再翻訳・復元はキャッシュ利用でネットワークを叩き直さない)。`--text` は置換せず翻訳テキストを返す(エージェントが外国語ページを読む用)。翻訳は無料の gtx エンドポイント(`translate.googleapis.com/translate_a/single?client=gtx`。非公式・鍵不要)を **context.request 経由**(ブラウザのプロキシ共有)で叩き、小セグメントは改行連結で 1 リクエストにまとめ(gtx は改行境界を保つので split で復元)、行数がずれたバッチだけ 1 件ずつ翻訳し直す。前後の空白を保ってインライン要素間の隙間を壊さない。`maxRequests`(既定 80)で巨大ページの叩きすぎを防ぎ、超過分は原文のまま `partial=true` で返す。`--translate-key [combo]`(既定 Alt+Shift+T)で **翻訳⇄原文をキーでトグル**(下記ホットキー節)。**SPA のソフト遷移対策**: `__kbTrans` は pushState 遷移では消えず旧 DOM の Text 参照を抱えたまま残るため、toggle/restore の前に必ず現 DOM と突き合わせ(旧ノード全滅 or 現ノードの 1/3 以上が新ノード = 「実質別ページ」)、別ページ扱いなら shown フラグを信用せず新規翻訳へフォールバックする(かつては遷移後のトグルが切り離された旧ノードへの復元/再適用を空振りし続け「翻訳が効かなくなる」バグだった)。復元・再適用・訳の適用はいずれも `isConnected` なノードだけに書く。新規翻訳の収集前には画面に残る旧訳を原文へ戻してから収集する(訳文を「原文」として再収集して二重翻訳・原文喪失しない)。加えて `host/translate.ts` に**プロセス全域の訳文メモ(LRU 10,000 件、キー = from/to/原文)**を持ち、ページ遷移を重ねてもサイト共通のヘッダ等は gtx を叩き直さない(429/5xx は 1 回だけ再試行)。
- `kb tabs detach <id...>` — 指定タブ(複数可)を新しい **1 枚のウィンドウ**へ分離する。CDP には既存タブの window 間移動 API が無いため、各タブの現在 URL で新ウィンドウにタブを作り直し(先頭 `Target.createTarget({newWindow:true})`、以降は新ウィンドウを activate してから `createTarget` = 同ウィンドウにタブ追加)、元タブを閉じる実装(`host.detachTabs`)。**引き継ぐのは URL のみ**(ページ内 JS 状態・履歴・スクロール位置・フォーム入力・POST専用ページは失われる)。応答は旧→新のタブ ID 対応 + 現在のタブ一覧。全タブ分離でも新ウィンドウを先に作ってから元を閉じるのでデーモンは落ちない。`browser CDP session`(`context.browser().newBrowserCDPSession()`。persistent context でも非 null)を都度作って detach するので常駐痕跡は残さない。
- **ホットキー(ヘッド有りウィンドウ向け・opt-in・既定無効・`off` で解除・`--cdp` と排他・アタッチには非注入)**: 共通実装は `host.installHotkey(bindingName, combo, handler)` — `context.exposeBinding(bindingName)` + `context.addInitScript` で全ページ(以後のナビ含む)に capture フェーズの keydown リスナーを注入し、押下で対応する binding をデーモンで実行する。`util.parseHotkey`(+テスト)がコンボ解析(Ctrl/Alt/Shift/Meta 別名 + 主キー)。
  - `--detach-key [combo]`(opt-in。初回は無効、オプションの値省略時は Alt+Shift+D、前回値を継承、`off` で解除)→ `__kbDetachTab` → `detachTabs([currentTab])`(現タブを単独で別ウィンドウへ)。複数タブは `kb tabs detach <id...>`(1 キーに複数選択の概念が無いため)。
  - `--translate-key [combo]`(opt-in。初回は無効、オプションの値省略時は Alt+Shift+T、前回値を継承、`off` で解除)→ `__kbTranslate` → `translate({toggle:true, to:'ja'})`(**翻訳⇄原文をトグル**。初回=日本語化、以降はキャッシュで再翻訳/復元)。
  - **注意**: exposeBinding が全ページに `window.__kb*` を生やすため、厳密なステルス目的の閲覧とは併用しない方がよい(検知面が増える)。
- 手動介入の運用: headed のままユーザーがウィンドウを直接操作 → agent は `kb wait --url ...` で完了を検知して再開。ログイン済み状態は `kb storage dump` で保存できる。
- `kb login [url] [--until <glob>] [--until-selector <sel>] [--until-gone <sel>] [--save <file>]` — 手動サインイン**または bot 検出チャレンジ通過**の段取りを 1 コマンド化(headless なら headed へ切替 → URL を開く → 完了条件のどれか 1 つ、または Enter 押下で完了 → 保存状態を確認)。完了条件: `--until`(URL glob)/ `--until-selector`(ログイン後にだけ出る要素)/ `--until-gone`(Cloudflare 等のチャレンジ iframe が**消える** = 通過)。**Managed Challenge / Turnstile の通し方**: headed で `kb login <url>`(チャレンジを人が解く)→ URL や要素の変化で自動完了、または Enter。Cloudflare のチャレンジ iframe を待つなら `kb login <url> --until-gone "iframe[src*='challenges.cloudflare.com']"`(または本文の "Just a moment" が消えるまで)。通過 Cookie(cf_clearance 等)もプロファイルに永続化され次回以降維持される(ステルス既定 ON で軽いボット判定は素通りしやすくなったが、Turnstile 等はこの人手 1 回 + 永続化が確実路)。CDP/JA3/IP 等のサーバ側判定は client では潰せないため、確実なのは人手介入 + この永続化(自動突破は追わない設計)。ログイン状態はプロファイル(user-data-dir)に自動永続化。非 TTY では完了条件(`--until` / `--until-selector` / `--until-gone`)必須。
- エミュレーションはタブ単位(geo のみ context 全体)。CDP セッションを detach するとオーバーライドが消えるため、host が CDPSession をタブ毎に保持し続ける実装になっている。UA 上書き時は Client Hints メタデータも追随、mobile viewport はタッチも有効化。

## DevTools 系コマンド

```bash
kb net log [--filter <regex>] [--responses] [-f] [-n 50]   # Network タブ相当。行頭に #seq。--responses で完了相のみ。-f で追従
kb net body <seq>                             # 捕捉済みレスポンス本文(seq は net log の行頭番号)
kb net headers <seq>                          # 全リクエスト/レスポンスヘッダ(allHeaders、直近 2000 件。relay の内部認証ヘッダは除去)
kb net block "*://*.doubleclick.net/*"        # glob パターンで遮断
kb net mock "*://api.example/**" [--body mock.json | --text '{"error":1}'] [--status 500]   # 既存エンドポイントのエラー差し替えにも使える(本文省略可)
kb net rules / kb net unroute <id> | --all
kb net export --format har -o cap.har [--filter <regex>] [-t <tab>] [-n <件数>]   # 捕捉済みログを遡及的に HAR 化(事前準備不要)
kb net har start / stop -o out.har            # HAR 記録(本文含む、256KB/エントリ上限。二重 start はエラー。10000 entries / 128MB で記録打ち切り→ log.comment と stderr 警告で明示)
kb console [-f] [--clear]                     # console.log / pageerror
kb dom query "h1" [--html] [--attr href] [--frame iframe]
```

ログはデーモン内のリングバッファ(3000 件)に seq 付きで蓄積され、`-f` は since カーソルのポーリング(700ms)で追従する。レスポンス本文はテキスト系 Content-Type の XHR / fetch / document / other について自動捕捉される(実装は `captureNetBody()` + `BodyStore`)。**捕捉は 1 件 256KB(NET_BODY_CAP)で切り詰め**、全体 32MB / 500 件で古いものから破棄。`--offset` は捕捉済み範囲内のページングであり、256KB を超えた部分は後から取得できない(全文が要るときは `kb request -o` で取り直す)。request 行の seq を渡しても対応する response に自動で読み替える。

**`kb net export`(遡及 HAR)と `kb net har`(ライブ記録)は別物**。前者は「今バッファにあるもの」を HAR 1.2 に合成するので事前準備が要らない(外部ツールへの受け渡しはこちらが本命。Burp / Caido / HAR 入力を取るスキャナに読ませる)。合成は `shared/har.ts`(純関数・テスト対象)、供給側は `NetMonitor.exportHar()`。捕捉時の上限がそのまま制約になる: **ヘッダ・postData は直近 2000 レスポンス分**(`netMeta`。この付帯情報は `kb net headers` と共用)、**本文はテキスト系のみ 1 件 256KB まで**、**timing は取れた分だけ**(response イベント時点では `responseEnd` が未確定になり得るので receive=0 になることがある)。欠落は `log.comment` と各エントリの `_kbTimingsUnavailable` で明示し、エントリには `_kbSeq`(= `kb net body <seq>` に渡せる)/ `_kbTab` / `_kbResourceType` を付ける。送信相(request イベント)は完了相と重複するため除外。完全な timing が要る調査は先に `kb net har start` を回す。

**`kb request` の通信も net ログに載る**(v0.12.0〜)。`context.request` はページイベントに乗らないため、`host.httpRequest` が `NetMonitor.recordExternalRequest()` へ明示的に記録する。表示上は `resourceType=kb-request`・タブ欄 `[-]`(タブ ID は -1)で、`kb net body <seq>` も HAR エクスポートも対象になる。`--follow-verbose` の中間ホップも 1 エントリずつ載る。ただし**リクエストヘッダは kb が渡した分のみ**(APIRequestContext が自動付与する Cookie / User-Agent は取得手段がないため HAR にも出ない)。ジャーナルには command イベントとして既に記録されるので、こちらでは `onJournalNet` を呼ばない(二重記録の回避)。

## WebSocket

```bash
kb ws log [--filter <regex>] [-n 50] [-f --for <sec>] [--clear]   # ページ自身の WS フレーム(DevTools の Messages 相当)
kb ws connect wss://host/socket.io/?EIO=4&transport=websocket     # 現在のタブのコンテキストで張る → ソケット id
kb ws send <id> '42["subscribe",{...}]' [--file <path>] [--base64]
kb ws recv <id> [--since <seq>] [-n 50] [-f --for <sec>]
kb ws list / kb ws close <id>
```

**観測(`ws log`)と送受信(`connect`/`send`/`recv`)は別経路**。観測は Playwright の `page.on('websocket')` で、ページ自身のソケット(socket.io 等)のフレームがそのまま見える — 独自クライアントを書く前に framing(`40`/`42[...]`)を読むのに使う。送受信は**ページの中で `new WebSocket()` する**ので、Cookie・Origin・TLS・プロキシはそのページのものがそのまま乗る(トークンを取り直して手で組み直す必要がない)。kb が張ったソケットのフレームは観測側にも載る(向きは `→ sent` / `← received`)。

- **対象サイトのページを開いた状態で使う**(Origin と Cookie がそのページのものになるため)。`kb open <url>` してから `kb ws connect`
- **ページ遷移でソケットは失われる**(`window.__kbWs` ごと消える)。`kb ws list` で確認して張り直す
- `recv` はバッファを消費しない。`--since <seq>` で続きから読む(応答の `seq` を次の `--since` に渡す)
- バイナリは受信が base64(`binary: true`)、送信は `--base64`
- ソケットの受信活動はアイドル自動終了の延命材料に**ならない**(RPC が来なければ閾値で終了する)。長時間張るときは `kb ws recv` のポーリングか `--idle-timeout 0`
- `ws.connect` / `ws.send` / `ws.close` は操作ジャーナルに記録され、`ws.send` の本文はマスク対象(WS フレームは認証トークンを運ぶことが多い)。フレームそのもの(`ws log`)はジャーナルには入らない

## セッション診断(403 を誤読しないために)

```bash
kb session check <url> [--api <url>] [--expect-selector <sel>] [--timeout <sec>]
```

「この 403 は**対象パスが保護されている**のか、**自分のセッションが切れただけ**なのか」を対照付きで判定する。単独の URL を 1 回撃つだけでは原理的に区別できないので、**トップページ(対照)→ 対象 →(あれば)API** の順にプローブして突き合わせる。

**プローブは必ず実タブから撃つ**(`page.goto` / ページ内 `fetch`)。`context.request` は Playwright 側の HTTP スタックでブラウザの TCP/TLS を通らないため、Cloudflare 等の相手では「ブラウザは 200 なのにプローブだけ 403」という新しい偽陰性を作る。プローブ用タブは使い捨てなのでユーザーのタブ ID は動かない。

判決(`verdict`):

| verdict | 意味 |
|---|---|
| `ok` | 対象は正常。応答をそのまま証拠にしてよい |
| `degraded` | 対照も弾かれている / 対象にチャレンジが出ている = **クライアント側の問題**。403 を「保護されている証拠」に使わない |
| `degraded-html-only` | HTML はチャレンジだが API は 200(**ルールセットが別**)。HTML の 403 で「このパスは保護されている」と結論しない |
| `target-protected` | 対照は正常で対象だけがブロック = 対象パスの性質として読める |
| `no-session` | そのホストの Cookie が 0 件で、かつクライアント側が疑わしい。`kb login <url>` へ誘導 |
| `unreachable` | 対象が測れていない(**測定失敗を「問題なし」に化けさせない**ための独立した判決) |

- **status と challenge を分けて扱う**: bot 対策の中間ページはマーカー(`cf-mitigated` ヘッダ / "Just a moment" / `cf_chl_opt` / Turnstile iframe / DataDome / Incapsula 等)で判定し、**ステータスだけではチャレンジ扱いにしない**(アプリ由来の 403 と混ざるため)
- チャレンジを検出したら最大 6 秒待って**自動通過するか**を見る(通過したら劣化ではない。`settledAfterMs` で報告)
- `--api` 省略時は、このセッションで観測した**同ホストの直近 xhr/fetch** を自動で対照に使う(応答に `apiAuto`)。同一オリジンならページ内 `fetch`(アプリと同じ経路)、別オリジンならナビゲーションで測る
- Cookie は**名前・期限・kb が初めてその値を見てからの経過時間**だけを出す(値は出さない)。Cookie は発行時刻を持たないため、経過時間は kb 自身の観測記録(`~/.kb/cookie-seen.json`、値ではなくハッシュを保存)で代用する。値が変わると起点がリセットされる = cf_clearance の再発行を検出できる
- Chromium は本文のない 4xx/5xx で `net::ERR_HTTP_RESPONSE_CODE_FAILURE` を投げるが、捕捉済みレスポンスがあれば status を採用して続行する(403 が unreachable に化けるのを防ぐ)

## Cookie・セッションの受け渡し

```bash
kb cookies export [--format json|netscape|header] [--url <url>] [-d <domain>] [-o <file>]
```

`json`(既定)は Playwright 形式のまま。**`netscape`** は curl / wget の cookies.txt(httpOnly は curl 互換の `#HttpOnly_` プレフィックス、セッション Cookie は expires=0)、**`header`** はリクエストの `Cookie:` ヘッダ 1 行。header 形式は `--url` を付けるとその URL に実際に送られる Cookie だけに絞る(ドメイン/パス/Secure 判定 + 同名はパスの長い方を優先)。`-o` 省略時は netscape / header とも標準出力に出るのでパイプで他ツールに渡せる。整形は `shared/cookies.ts`(純関数・テスト対象)。

**httpOnly Cookie も `kb cookies list` / `export` に出る**(`context.cookies()` は httpOnly を含む)。DevTools の Application タブから手でコピーする必要はない。

## プロキシ操作

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 [--user u --pass p] [--bypass "*.internal,localhost"]
kb proxy list          # * = アクティブ。CA 信頼済みは trusted-ca(os) / trusted-ca(scoped) 表示
kb proxy use work      # デーモン起動中なら無再起動で即時切替
kb proxy off           # direct に戻す
kb proxy status        # デーモンに実際に適用中の状態(HTTPS/CONNECTトンネル と 平文HTTPリクエスト を明示計上)
kb proxy test [work]   # 外部 IP と応答時間で疎通確認。証明書エラーで落とさず [TLS: 信頼済み/未検証] を注記
kb proxy rule add "*.corp.example.com" work   # ホスト別振り分け(先勝ち、FoxyProxy 相当)
kb proxy rule list / kb proxy rule rm <index>
```

add / rm / use / rule の変更はすべて proxies.json 書き込み + `proxy.reload` RPC で live 反映される(アクティブプロファイルの上書きも即時)。中継の接続失敗(ブラウザ側 `ERR_TUNNEL_CONNECTION_FAILED`)は `relay.recordError()` が stats・直近 20 件リスト(`proxy status` の lastErrors)・daemon.log の 3 か所へ記録する。TCP 接続は `autoSelectFamily: true`(happy eyeballs)で IPv6/IPv4 片系死にに耐える。**`proxy status` の計上**: HTTPS は CONNECT トンネル(tunnels)、平文 HTTP は requests に乗る。HTTPS のみのブラウジングで requests=0 を「通信なし」と誤読しないようラベルで明示している。**`proxy test` の TLS 判定**: ブラウザは OS ストア / 信頼させた CA で MITM 検査プロキシの証明書を通すため、test も `rejectUnauthorized:false` で疎通(外部 IP)を測り、証明書の信頼状況は `tlsTrusted`/注記で返す(「ブラウジングは成功するのに test だけ失敗」という偽陰性を出さない。実装は `relay.testUpstream`)。

### 検査プロキシ(Charles / Fiddler / mitmproxy 等)の CA 信頼

HTTPS を復号する上流プロキシを使うと、その MITM 証明書を信頼させないとブラウザが `ERR_CERT_AUTHORITY_INVALID` になる。2 系統を用意している(実装は `src/cli/caTrust.ts`):

```bash
# (A) OS ストアに導入(永続・全ブラウザに効く。proxy test など Node 側にも効く)
kb proxy trust-ca work [--ca-probe example.com] [--yes]   # プロキシ経由で TLS し、提示チェーンの自己署名ルートを抽出 → certutil で CurrentUser Root に導入
kb proxy untrust-ca work                                   # 取り消し(thumbprint 指定で削除)

# (B) OS ストア非経由・kb だけで信頼(CI / 共有マシン向け。scope が狭く安全)
kb proxy add work ... --ca <cert.pem>          # 証明書ファイルの SPKI をプロファイルに記録
kb proxy trust-ca work --scoped                # プロキシ経由で抽出した CA の SPKI を記録
# → デーモン起動時に全プロファイルの caSpki を集めて Chromium の --ignore-certificate-errors-spki-list へ渡す
#   (その 1 枚だけ証明書エラーを許可。全無検証の ignoreHTTPSErrors より安全)。適用に kb daemon restart が要る。
```

CA 抽出はツール固有の magic URL に依らず、プロキシ経由で提示された証明書チェーンを自己署名ルートまで辿る(どの MITM ツールでも同経路)。`socket.authorized` で「公的 CA に繋がった(= 傍受されていない/実 CA)」を判定し、その場合は導入を拒否して誤導入を防ぐ。**MITM ルートを OS ストアに入れるのは、その CA の秘密鍵保有者に HTTPS 傍受を許す行為**のため、(A) は fingerprint 表示 + 確認(`--yes` で省略)を挟む。全無検証の escape hatch は `kb daemon start --ignore-https-errors`(下記)。

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

docs/requirements.md 参照。M1(骨格)/ M2(プロキシプロファイル)/ M3(DevTools 系)/ M4(モード切替・wait・エミュレーション)/ M5(振り分けルール・MCP・npm link 配布)/ M6(エージェント最適化: snapshot+ref、出力上限、堅牢化、セッション保存、ダウンロード、PDF 他)/ M7(利用者フィードバック反映: `kb net body`・`kb request`・`kb login`・screenshot `--timeout`、2026-07)/ M8(第 2 次フィードバック: CDP アタッチ・`--channel`/`--ua`・`kb net headers`・mock 拡張・JSON 推定・relay エラー可視化、2026-07)/ M9(操作記録: `kb log` ジャーナル・レポート・マスク付き export バンドル・curl 単体再実行。仕様は ../kb-feature-request.md P8 + ../operation-log.md、2026-07)/ M10(v0.5.0 検証フィードバック対応: cdp fail-fast・自動起動通知・URL クエリマスク・`--ua ""`/`--channel auto` リセット・`unroute --all`・ログ prune・`log replay`・`--shots`・`net log --responses`。../kb-v0.5.0-feedback.md 参照、2026-07)/ v0.7.1(**JS ダイアログ対応**: `kb dialog` で alert/confirm/prompt を保留・応答。ポップアップ付きボタンが無反応に見えるバグの修正、2026-07)/ v0.8.0(**デーモン寿命管理**: アイドル自動終了 `--idle-timeout`/`KB_IDLE_TIMEOUT`・in-flight ガード・MCP 切断時の自動起動デーモン後片付け・孤児回収 `kb daemon stop --all`・HAR/downloads の上限。常駐ブラウザの堆積(実測で 12 個・計 322MB)対策、2026-07)/ v0.9.0(**Chrome 拡張機能**: `--extensions <dirs|on|off>` で未パック拡張の読み込みとプロファイル拡張の有効化、2026-07)/ v0.10.0(**検査プロキシ連携 + 細かな要望**: `--ignore-https-errors`、`kb proxy trust-ca`/`untrust-ca`(OS ストア導入 certutil)+ `--ca`/`--scoped`(OS ストア非経由 SPKI allowlist)、`kb login --until-selector`/`--until-gone` と `kb wait --selector-gone`(managed challenge 通過検知)、`kb daemon restart`、`proxy test` の TLS 偽陰性修正、`proxy status` の HTTPS/HTTP 計上明示。../kb-feature-request.md P10-P13 ほか、2026-07)/ v0.10.1(**`kb request` の Set-Cookie/レスポンスヘッダ可視化**: `res.headers()` が複数 Set-Cookie を 1 行に畳んで parse 不能だった問題を、`res.headersArray()` から個別抽出した `setCookies[]` で解消。CLI は Set-Cookie を既定で個別行表示(`-i` で全レスポンスヘッダ)、MCP `kb_request` は `includeHeaders` を追加(従来レスポンスヘッダを一切返さなかった穴も塞ぐ)。`setCookies` は export バンドルで機微ヘッダ同様マスク。フィードバック対応、2026-07)完了。/ **v0.10.2(内部リファクタリング + 実バグ 3 件修正。CLI コマンド/フラグ/ヘルプ文・MCP ツール名/説明は不変、2026-07)**: ①型付き共有 RPC スキーマ(`shared/rpc.ts`)で CLI/MCP/dispatch の引数三重定義を解消(daemon は網羅性がコンパイル時強制される型付き handler map + 受信境界 zod 検証、client は `rpc<C>` で引数型検査)②`host.ts`(1165 行の god object)を facade + 5 コラボレータ(launcher / tabs / dialogs / downloads / httpClient)に分割 ③`main()` を `Daemon` クラス + 純関数 `parseArgs` に再構成 ④調整定数(`shared/constants.ts`)と表示整形(`shared/format.ts`)の集約、実バグ 2 件修正(HAR の content-type 正規表現が form-urlencoded を落としていた・`kb eval` の切り詰め注記がオブジェクト結果で誤範囲)⑤pid 生存判定の EPERM 漏れ修正(`isPidAlive`/`waitForPidDeath` に統一)⑥ジャーナルをバッファ書き込み化(command 境界で同期 flush)+ `kb log` 読み取りを readline ストリーム化 ⑦実ブラウザ e2e スモーク(`npm run test:e2e`)を安全網として追加。CLI のコマンド/フラグ/ヘルプ文・MCP のツール名/説明は完全不変(全 `--help` + ツール説明の diff ゼロで検証済み)。**見送り**: `kb session import --from-chrome`(実 Chrome をコピー起動して復号する案)は、稼働中ユーザ Chrome とのセッション合流でプロファイル状態を破壊するリスク + Windows の cookie DB 排他ロック + App-Bound Encryption により破棄。既存 Chrome の再利用は `--cdp` アタッチ(P1、実装済み)を使う。/ **v0.10.3(第 N 次フィードバック対応、2026-07)**: ①**孤児デーモン検出の強化**: デーモン argv に `--home <KB_HOME>` 識別マーカーを焼き、`kb daemon stop --all` が子 Chromium の生死に依存せずデーモン本体を同定できるようにした(Chromium が先に死んで node だけ残った孤児を回収できなかった穴を塞ぐ。マーカーのない旧デーモンは従来の子 Chromium 経路で後方互換)。②**`kb request --follow-verbose`**(MCP `followVerbose`): リダイレクトを 1 ホップずつ手動追従し各ホップの status/Location/Set-Cookie を表示(リダイレクト途中で撒かれる Cookie の分析用。`--json` の result.hops)。実装時に daemon の request ハンドラが新引数 `verbose` を host へ渡していなかった取りこぼしも修正。**既に実装済みで見送った要望**: `kb request` の応答時間(`(142ms)`)は CLI/MCP とも既定出力に表示済み・oplog の `:path` 擬似ヘッダマスクは v0.6.2 から適用済み・MCP `includeHeaders` の既定は「status + Set-Cookie は常時、他ヘッダはオプトイン」で要望者の代替案どおりのため据え置き。/ **v0.11.0(タブの別ウィンドウ分離 + ページ翻訳 + ステルス既定 ON、2026-07)**: ④**`kb translate`**(RPC `translate` / MCP `kb_translate` / `host.translate` + `host/translate.ts`): Chrome の「このページを翻訳」相当。既定 in-place で本文テキストノードを日本語化(`--restore` 原文へ / `--toggle` 翻訳⇄原文 / `--text` テキスト出力 / `--to`/`--from`)。無料 gtx エンドポイントを context.request で叩き、改行バッチ + ミスマッチ時 per-segment フォールバックで訳文を 1:1 整合。原文は `window.__kbTrans` に退避しトグル/復元はキャッシュ利用。`--translate-key`(既定 Alt+Shift+T)でキー・トグル。実機で text/in-place/restore/toggle/hotkey を検証済み。①**`kb tabs detach <id...>`**(RPC `tabs.detach` / MCP `kb_tabs_detach` / `host.detachTabs`): 指定タブ(複数可)を新しい 1 枚のウィンドウへ分離する。CDP に window 間移動 API が無いため「各タブの現在 URL で新ウィンドウにタブを作り直し(先頭 `createTarget({newWindow:true})`、以降 `activateTarget`+`createTarget` で同ウィンドウにタブ追加)→ 元タブを閉じる」実装(URL のみ引き継ぎ、ページ内状態・履歴は失われる)。`context.browser().newBrowserCDPSession()` を都度作って detach(persistent context でも browser() は非 null と実測確認)。faithful 実機検証で「分離タブが 1 ウィンドウに集約 + 残タブと別ウィンドウ」を確認。②**`--detach-key [combo]`**(opt-in): ヘッド有りウィンドウで指定キー押下 → 現在タブを別ウィンドウへ分離。`exposeBinding('__kbDetachTab')` + `addInitScript` の capture keydown リスナーで実装。`off` で解除・`--cdp` と排他・アタッチ先には非注入。`util.parseHotkey`(+テスト)でコンボ解析。③**ステルス既定 ON 化**: `navigator.webdriver=true` で「信用されないブラウザ」に見え Cloudflare 等の軽いボット判定に弾かれる主因を、既定で `--disable-blink-features=AutomationControlled` により解消。`--no-stealth` で従来挙動。`--cdp` 排他は明示 `--stealth` のときのみ(`getOptionValueSource` 判別)。実 Chrome/Edge 不在で同梱 Chromium にフォールバックしたら警告。Turnstile/Managed Challenge・JA3・Runtime.enable 等の硬い判定は依然 client では潰せず、`kb login`(人手 1 回 + cf_clearance 永続化)か `--cdp` が確実路(ドキュメントに明記)。CLI/MCP のコマンド追加以外の既存挙動は不変(status に stealth=on/off・detach-key を表示するようになった点のみ表示変更)。 / **v0.12.0(bug bounty ワークフロー連携: HAR エクスポート + Cookie 受け渡し形式 + マスク拡張、2026-08)**: ①**`kb net export --format har`**(RPC `net.export` / MCP `kb_net_export` / `NetMonitor.exportHar` + 純関数 `shared/har.ts`): 捕捉済みの通信ログを事前準備なしで HAR 1.2 に**遡及合成**する(ライブ記録の `kb net har start/stop` とは別物)。標準形式なので Burp / Caido / HAR 入力を取るスキャナにそのまま渡せる — 独自形式は増やさない判断。HAR 化に必要な **postData / statusText / timing を `netMeta` に保持するよう捕捉側を拡張**(従来は journal に渡すだけで保存していなかったため、POST ボディが HAR に載らなかった)。エントリに `_kbSeq`(= `kb net body <seq>`)/ `_kbTab` / `_kbResourceType` を付け、捕捉上限による欠落は `log.comment` と `_kbTimingsUnavailable` で明示。②**`kb request` を通信ログに載せた**(`recordExternalRequest`): `context.request` はページイベントに乗らず HAR に穴が空いていた。`resourceType=kb-request` / タブ `-1` で記録し、`--follow-verbose` の中間ホップも 1 件ずつ載る(リクエストヘッダは kb が渡した分のみ = APIRequestContext の自動付与ヘッダは取得不能)。③**`kb cookies export --format netscape|header`**(+ `--url` スコープ、`shared/cookies.ts`): 外部ツールが必要とする cookies.txt / `Cookie:` ヘッダ 1 行を kb 側で作る(JSON 配列だと利用側に毎回変換が要った)。`-o` 省略で標準出力。httpOnly Cookie は元から `context.cookies()` に載るため、DevTools から手でコピーする運用は不要。④**マスク拡張**: 機微ヘッダ名を語幹マッチにして `X-Validation-Token` / `X-Request-Signature` 等のサイト固有ヘッダを既定で捕捉(従来は `x-auth*` プレフィックスのみで素通りしていた)。加えて **JWT を値の形状で検出**し既定で**署名部だけ**を潰す(`--mask-jwt full|off` で切替)。クレームは証拠として残し、再利用可能にしている署名部だけを落とす方針。マスクは冪等(二重適用しても `[MASKED]` が増えない)。⑤**`kb session check <url>`**(RPC `session.check` / MCP `kb_session_check` / `host/session.ts` + 純関数 `shared/challenge.ts`): 「この 403 は対象パスが保護されているのか、自分のセッションが切れただけか」を**トップページ(対照)との対比**で判定する。単独 URL の 1 回のプローブでは原理的に区別できない、という前提から設計した。**プローブは実タブから撃つ**(`context.request` はブラウザの TCP/TLS を通らず、Cloudflare 相手に新しい偽陰性を作るため)。status(ブロック)と challenge(bot 対策の中間ページ)を分けて扱い、チャレンジ検出後は最大 6 秒「自動通過するか」を観測する。`--api` 省略時は観測済みの同ホスト xhr/fetch を自動で対照に使い、同一オリジンならページ内 fetch(アプリと同じ経路)で撃つ。Cookie は名前・期限・kb 初観測からの経過時間のみ出力(値は出さない。経過時間は `~/.kb/cookie-seen.json` にハッシュで記録)。⑥**`kb ws`**(RPC `ws.*` / MCP `kb_ws_*` / `wsMonitor.ts` + `host/wsClient.ts`): 観測(`ws log` = `page.on('websocket')` で DevTools の Messages 相当)と送受信(`connect`/`send`/`recv`/`list`/`close` = **ページコンテキストで `new WebSocket()`**)の 2 本立て。ページで張るので Cookie・Origin・TLS・プロキシがそのまま乗り、bullet token を取り直して framing を手で組む作業が要らなくなる。`recv` はバッファ非消費の `--since` カーソル。ページ遷移でソケットは失われる(明示エラー)。`ws.send` の本文はジャーナルでマスク。実機検証: 実サイト(example.com)上から `wss://ws.postman-echo.com/raw` へ connect/send/recv/log/close を往復、`session check` は httpbin の 403 とローカルの疑似チャレンジで判決を確認。e2e スモークに手書きの最小 WS エコーサーバを足して connect→send→recv→観測→close と 2 種類の verdict を常時検証する。**実機検証で見つけて直したバグ 2 件**: (a) Chromium は本文のない 403 を `net::ERR_HTTP_RESPONSE_CODE_FAILURE` として投げるため target プローブがエラー扱いになり、(b) その結果 `judgeSession` が「対象が bad でない」と読んで **verdict=ok**(測定失敗が「問題なし」に化ける — この機能が防ぐべき誤報そのもの)。捕捉済みレスポンスでの続行と、target が測れていないときの独立した `unreachable` 判定で修正し、両方に回帰テストを追加。

単一バイナリ(exe)化は見送り: Playwright はブラウザ実体とドライバ資産をディスク上に必要とするため bundler と相性が悪い。配布は npm パッケージ(`npm link` / `npm pack`)を正とする。

## 残課題(バックログ)

- Linux: ユニットテストは WSL Ubuntu 24.04 + node22 で全パス確認済み(2026-07)。コードに OS 依存なし(パスは path.join、spawn/lock/pid 判定も POSIX 互換)。ブラウザ実起動の e2e スモーク(`npm run test:e2e`、隔離 KB_HOME で実デーモンを起動)を追加済みだが、素の Linux 環境では `npx playwright install chromium --with-deps` で依存ライブラリ(libnss3 等)の導入が必要(未導入ならスイートは自動 skip)。
- eval の「最後の式」判定はパーサでなく構文チェック付きヒューリスティック。`x = 1\n+2` のような ASI 依存の書き方では誤分割しうる(1 文 1 行推奨)。
- ref 自動再解決は「同じ role/name が一意」の場合のみ。同名ボタンが複数あるページでは再解決されずエラーになる(安全側)。
- `kb net mock` はテキスト本文のみ(バイナリ未対応)。
- `--extensions` の未パック拡張は同梱 Chromium 専用(Chrome 137+ stable は --load-extension 削除済み。msedge が追随しているかは未計測 — 明示チャネル + ディレクトリ指定時は CLI が警告を出す)。ロードされたかの実確認は `kb open chrome://extensions` + snapshot が確実。
- UA エミュレーションの reset は空文字セット頼みで、完全に戻すにはタブを開き直すのが確実。
- `kb net body` の捕捉対象はテキスト系の xhr/fetch/document/other のみで、256KB/件で truncate(HAR も同様にテキスト系・256KB 以下のみ本文を含める)。バイナリや 256KB 超の全文は `kb request -o <file>` で取り直すのが唯一の経路。
- `kb net export`(遡及 HAR)の制約: ①ヘッダ・postData は直近 2000 レスポンス分のみ(それ以前は URL/status だけのエントリになり、件数を `log.comment` に出す)②timing は response イベント時点の値なので `receive` が 0 になることがある(正確な timing が要るなら `kb net har start`)③`kb request` 由来エントリのリクエストヘッダは kb が渡した分のみ(APIRequestContext が自動付与する Cookie / UA は Playwright API から取得できない)。
- マスクの JWT 検出は 3 セグメントの `eyJ…` 形状に限る。不透明なランダム文字列のトークン(`sk_live_…` 等)は依然キー名・ヘッダ名頼りなので、独自形式のトークンは `--deny` で潰す。
- `kb cookies export --format header` は `--url` 省略時に jar 全体を 1 行にする(複数ドメインが混ざる)。外部ツールに渡す用途では `--url` を付けるのが正しい。
- `kb ws` の制約: ①ページ内ソケットなので**ページ遷移で失われる**(タブを保ったまま操作する)②送信はテキストか `--base64` のみ(任意のバイナリ構築は未対応)③観測ログは 1 フレーム 8KB で切り詰め、リングバッファ 3000 件④WS の受信活動はアイドル自動終了の延命材料にならない⑤`kb log replay` の対象外(ソケット id はセッション限りのため)。
- `kb session check` のチャレンジ判定はマーカー(ヘッダ・本文の既知パターン)ベースのヒューリスティック。未知のベンダや、マーカーを出さないサイレントブロックは `challenged=false` になり、status だけで判定される(その場合の判決は `target-protected` に寄る)。逆に「チャレンジ文言を含む普通のページ」は誤検知しうる。
- `kb session check` の Cookie 経過時間は **kb が観測した時刻**が起点で、実際の発行時刻ではない(Cookie に発行時刻が無いため)。プロファイルを消すと起点も消える。
- `kb session check` は対象を 1 回ずつしか撃たない(レート制限起因の間欠的な 403 は「たまたま」を拾いうる)。連続で判定したいときは間を空けて複数回実行する。
- storage restore の localStorage 復元はオリジンごとに一時ページを開く方式(遷移不可のオリジンはスキップされる)。
- 複数サインインセッションの同時併用(要望 P5)は未対応。persistent context は 1 プロセス 1 context のため、現状は `KB_HOME` を分けた 2 デーモン併走が回避策(docs 記載済み)。対応するならマルチ BrowserHost 化の大改修になる。
- `kb log replay` は生ジャーナルの成功コマンドのみ再実行し、tab 指定をアクティブタブに読み替える(マルチタブの並行操作の忠実な再現は非対応)。summarizeArgs で 2000 文字超に切り詰められた引数(巨大 eval 等)は再実行が壊れる。
- CLI 出力は日英混在(操作結果の一部が英語)。i18n 統一は見送り中。
- 操作ログの通信記録は xhr/fetch/document/other のみ(画像・静的アセットは対象外)。`kb request` は command イベントとして記録され、requests/ の curl にも含まれる(context.request はページイベントに乗らないため net イベントにはならない)。
