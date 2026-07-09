# kb — CLI Browser

Playwright + Chromium (CDP) ベースの CLI 操作型ブラウザ。デーモンがブラウザを常駐保持し、`kb` コマンドが localhost RPC で命令を送る 2 プロセス構成。

## ビルドと実行

```bash
npm run build          # tsc → dist/
npm test               # ビルド + ユニットテスト (node:test, dist/**/*.test.js)
kb <cmd>               # npm link 済み(グローバル)。開発中は node dist/cli.js <cmd>
```

注意: デーモンは起動時の dist/ を保持し続けるため、**ビルド後は再起動しないと新コードが反映されない**(CLI が buildId 不一致を検知して stderr に警告を出す)。**`kb daemon restart`** が前回の構成(channel / profile / UA / headless / stealth / extensions / ignore-https-errors、`--cdp` アタッチ先も)を last-run から引き継いで再起動する(ビルド反映にも使える。旧 pid とその子 Chromium の消滅を待ってから起動して ProcessSingleton 競合を避ける)。`kb daemon status` が running/disk のビルド時刻と match/MISMATCH を併記するので、警告が本物か(コード同一で mtime だけ変わった等)を確認できる。

## アーキテクチャ

- `src/cli.ts` — CLI エントリ(bin)。コマンド定義はグループ別に `src/cli/commands/`(daemon / browse / actions / state / log / env / net / proxy)にあり、登録順 = ヘルプの表示順。全コマンド `--json` 対応(成功 `{ok:true,result}` / 失敗 `{ok:false,error}`)。
- `src/cli/output.ts` — CLI 共通の出力ヘルパ(print / run / truncNote / fmtTabs)と `--json` 状態の一元管理(setJsonOutput / isJsonOutput)。
- `src/mcp.ts` — MCP stdio サーバ (`kb-mcp`)。デーモンの機能を 23 ツールとして公開。`claude mcp add kb -- kb-mcp` で登録。**SDK の zod ジェネリクスは tsc をメモリ爆発させるため、型消去した `tool()` ラッパ経由で登録している(server.tool を直接呼ばないこと)。**
- `src/shared/version.ts` — `KB_VERSION`。package.json を単一の情報源として実行時に読む(バージョン文字列をコードに書かないこと)。
- `src/shared/client.ts` — デーモンへの RPC クライアント(CLI / MCP 共用)。未起動時は自動 spawn(前回の headless/profile/channel/ua を last-run.json から引き継ぎ、spawn ロックで二重起動を防止。**起動内容を stderr に 1 行通知**)。pid 生存確認付きの stale 判定。**明示的な `kb daemon start` はフラグなし = headed**(last-run 継承は自動 spawn のみ)。`waitForDaemon(child)` は spawn 直後の子プロセス死亡を検知して 30 秒待たずに daemon.log 付きで即エラー(--cdp 接続失敗などの fail-fast)。`--ua ""` / `--channel auto` は last-run 継承をクリアする明示リセット。
- `src/shared/util.ts` — 純粋関数(normalizeUrl / clip / LogBuffer / prepareEval)。テスト対象。**prepareEval は eval コードの自動 async ラップ**(await 入りの式・複数文を async IIFE 化し、最後の式を構文チェック付きで return に書き換える)。
- `src/daemon/main.ts` — HTTP サーバ (127.0.0.1 ランダムポート + timing-safe トークン認証)。RPC を host にディスパッチ。uncaughtException でデーモンを落とさない。
- `src/daemon/host.ts` — BrowserHost(facade。RPC から呼ばれるメソッド名はここに揃う)。`launchPersistentContext` で Chromium を保持、タブを ID 管理。channel は chrome → msedge → 同梱 chromium の順にフォールバック(`--channel` 明示時はフォールバックせず strict)。`--ua` で context 全体の UA 上書き。**`--extensions`** は Playwright 既定の `--disable-extensions` を ignoreDefaultArgs で外し(プロファイルにインストール済みの拡張が有効になる)、ディレクトリ指定時は `--load-extension` で未パック拡張を読み込む。**未パック拡張指定時のチャネル自動選択は同梱 Chromium のみ**(Chrome 137+ stable は --load-extension を削除済みのため chrome/msedge を飛ばす)。かつ「同梱 Chromium」を undefined でなく明示 channel 'chromium' として渡す — undefined + headless だと旧 headless(headless shell)になり拡張がロードされないため(channel 'chromium' は同一バイナリで拡張が動く新 headless を使う)。**`--stealth`** は自前起動時のみ起動 args に `--disable-blink-features=AutomationControlled` を付けて `navigator.webdriver` を実 Chrome 同様に消す。計測上、chrome チャネルではこのフラグ**だけ**で plugins/languages/WebGL/permissions まで実 Chrome と一致するため、**JS パッチ(init script)は入れていない**(過剰パッチ自体が新たな検知痕跡になる — 以前 permissions シムを入れて `query.toString()` 非ネイティブ化等の綻びを増やしたため撤去した)。残る綻びは headless の "HeadlessChrome" UA だけなので `--ua` と併用するか headed を使う。**JA3/TLS・HTTP2・IP レピュテーション等のサーバ側判定は別レイヤで、client 側では潰せない**(Cloudflare Managed Challenge 突破は保証しない)。アタッチ(`--cdp`)時は start() で stealth を無効に正規化(status が嘘をつかないため)。mode/profile/auth 切替は共通の `restart()` でタブ URL を復元(stealth も維持)。**アタッチモード**(`--cdp <url>` → `connectOverCDP`)では既存ブラウザの既定 context に接続する: stop は `browser.close()` で切断のみ(対象ブラウザは殺さない)、mode/profile/auth と proxy 切替は `assertNotAttached()` でエラー、last-run に cdp は残さない(自動 spawn は常に通常起動)。Chrome 136+ は既定プロファイルで CDP 不可(専用 --user-data-dir 必須)。
- `src/daemon/netMonitor.ts` — NetMonitor。通信ログのリングバッファ、テキスト系レスポンス本文・全ヘッダの捕捉(`kb net body/headers`。request seq → response seq の自動読み替え含む)、block/mock ルール(再起動時は `reapplyRoutes()` で新 context に引き継ぐ)、HAR 記録、ジャーナル向け net イベント通知。
- `src/daemon/targets.ts` — TargetResolver。selector / ref / frame → Locator の解決と、失効 ref の自動再解決(タブ毎の直近 snapshot キャッシュで role/name 照合。実装は `act()` / `reResolveRef()`)。
- **JS ダイアログ (alert/confirm/prompt)** — host.ts の `page.on('dialog')` が既定ポリシー **hold** で保留する(Playwright はリスナーなしだと表示前に自動 dismiss してしまい、`confirm` が常に false → 「ボタンを押しても反応しない」ように見えるのが元バグ)。保留中は該当タブの JS が止まるため、`click`/`fill`/`press`/`check`/`select` は `actOrDialog()` で操作完了を待たずに `{dialog}` を返し、`getPage()` が他操作をガードする(`kb dialog accept/dismiss` で応答するまで)。閉鎖検知はタブ毎の自前 CDPSession `Page.javascriptDialogClosed`(Playwright の Dialog に閉鎖イベントがなく、headed でユーザーがウィンドウ上で応答した場合の保留残りを解除するため)。ポリシーは `kb dialog policy hold|accept|dismiss` で切替(accept/dismiss は表示せず即応答)。CLI は `kb dialog [show|accept|dismiss|policy]`、MCP は `kb_dialog`。
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
- 操作系: click / fill / select(--label)/ check / uncheck / hover / upload(ローカルのファイルパスをそのまま渡す)/ press / scroll / back / forward / reload。**操作で `confirm`/`alert`/`prompt` が開くと応答に `dialog` が入り、そのタブは応答待ちになる → `kb dialog accept [text]` / `kb dialog dismiss` で応答**(詳細はアーキテクチャの JS ダイアログ節)。
- `kb request <url> [-X POST] [-H "Name: value"] [-d body] [-o file]` — **ページ非依存の HTTP リクエスト**(context.request 経由)。Cookie・プロキシはブラウザと共有され、Set-Cookie も反映される。テキスト系は本文がそのまま返り(既定 20000 文字切り詰め)、バイナリは `-o` で保存。**JSON に見えるボディで Content-Type 未指定なら application/json を自動付与**(`inferJsonContentType`。明示 -H が常に優先)。
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
- `kb daemon stop --all` — daemon.json に登録されていない**孤児デーモン**(SIGKILL/OOM で登録が外れた等)も含め、**この KB_HOME の**デーモンを子 Chromium ごと停止する。登録済みデーモンにはまず graceful 停止を送り、最大 5 秒その終了を待ってから残りをツリーキルする(即 /F でジャーナル最終書き込みを中断しないため)。子 Chromium の `--user-data-dir` がこの KB_HOME の profiles 配下のものだけを所有とみなすため(`src/daemon/procscan.ts` の `findOwnedDaemons`)、他 KB_HOME の正常デーモンや自プロセスは誤爆しない。`--dry-run` で対象確認のみ。Windows は `taskkill /T /F`、POSIX はプロセスグループ kill でツリー停止する。

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
- `kb daemon start --stealth [--ua "<実Chrome UA>"]` — 自動化の痕跡(navigator.webdriver 等)を実 Chrome 相当に均す。認可されたテスト向け。明示 start では `--stealth` を付けたときだけ有効(headless と同じく last-run は自動 spawn のみ継承)。`--cdp` アタッチとは排他(アタッチ先は元から実ブラウザ)。webdriver 消しは効くが JA3/IP 等のサーバ側判定は別レイヤなので、Cloudflare Managed Challenge 突破の保証はない(そこが要るときは `--cdp` で自分が起動した実 Chrome に繋ぐのが確実)。
- 手動介入の運用: headed のままユーザーがウィンドウを直接操作 → agent は `kb wait --url ...` で完了を検知して再開。ログイン済み状態は `kb storage dump` で保存できる。
- `kb login [url] [--until <glob>] [--until-selector <sel>] [--until-gone <sel>] [--save <file>]` — 手動サインイン**または bot 検出チャレンジ通過**の段取りを 1 コマンド化(headless なら headed へ切替 → URL を開く → 完了条件のどれか 1 つ、または Enter 押下で完了 → 保存状態を確認)。完了条件: `--until`(URL glob)/ `--until-selector`(ログイン後にだけ出る要素)/ `--until-gone`(Cloudflare 等のチャレンジ iframe が**消える** = 通過)。**Managed Challenge の通し方**: headed で `kb login <url>`(チャレンジを人が解く)→ URL や要素の変化で自動完了、または Enter。通過 Cookie(cf_clearance 等)もプロファイルに永続化され次回以降維持される。CDP/JA3/IP 等のサーバ側判定は client では潰せないため、確実なのは人手介入 + この永続化(自動突破は追わない設計)。ログイン状態はプロファイル(user-data-dir)に自動永続化。非 TTY では完了条件(`--until` / `--until-selector` / `--until-gone`)必須。
- エミュレーションはタブ単位(geo のみ context 全体)。CDP セッションを detach するとオーバーライドが消えるため、host が CDPSession をタブ毎に保持し続ける実装になっている。UA 上書き時は Client Hints メタデータも追随、mobile viewport はタッチも有効化。

## DevTools 系コマンド

```bash
kb net log [--filter <regex>] [--responses] [-f] [-n 50]   # Network タブ相当。行頭に #seq。--responses で完了相のみ。-f で追従
kb net body <seq>                             # 捕捉済みレスポンス本文(seq は net log の行頭番号)
kb net headers <seq>                          # 全リクエスト/レスポンスヘッダ(allHeaders、直近 2000 件。relay の内部認証ヘッダは除去)
kb net block "*://*.doubleclick.net/*"        # glob パターンで遮断
kb net mock "*://api.example/**" [--body mock.json | --text '{"error":1}'] [--status 500]   # 既存エンドポイントのエラー差し替えにも使える(本文省略可)
kb net rules / kb net unroute <id> | --all
kb net har start / stop -o out.har            # HAR 記録(本文含む、256KB/エントリ上限。二重 start はエラー。10000 entries / 128MB で記録打ち切り→ log.comment と stderr 警告で明示)
kb console [-f] [--clear]                     # console.log / pageerror
kb dom query "h1" [--html] [--attr href] [--frame iframe]
```

ログはデーモン内のリングバッファ(3000 件)に seq 付きで蓄積され、`-f` は since カーソルのポーリング(700ms)で追従する。レスポンス本文はテキスト系 Content-Type の XHR / fetch / document / other について自動捕捉される(実装は `captureNetBody()` + `BodyStore`)。**捕捉は 1 件 256KB(NET_BODY_CAP)で切り詰め**、全体 32MB / 500 件で古いものから破棄。`--offset` は捕捉済み範囲内のページングであり、256KB を超えた部分は後から取得できない(全文が要るときは `kb request -o` で取り直す)。request 行の seq を渡しても対応する response に自動で読み替える。

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

docs/requirements.md 参照。M1(骨格)/ M2(プロキシプロファイル)/ M3(DevTools 系)/ M4(モード切替・wait・エミュレーション)/ M5(振り分けルール・MCP・npm link 配布)/ M6(エージェント最適化: snapshot+ref、出力上限、堅牢化、セッション保存、ダウンロード、PDF 他)/ M7(利用者フィードバック反映: `kb net body`・`kb request`・`kb login`・screenshot `--timeout`、2026-07)/ M8(第 2 次フィードバック: CDP アタッチ・`--channel`/`--ua`・`kb net headers`・mock 拡張・JSON 推定・relay エラー可視化、2026-07)/ M9(操作記録: `kb log` ジャーナル・レポート・マスク付き export バンドル・curl 単体再実行。仕様は ../kb-feature-request.md P8 + ../operation-log.md、2026-07)/ M10(v0.5.0 検証フィードバック対応: cdp fail-fast・自動起動通知・URL クエリマスク・`--ua ""`/`--channel auto` リセット・`unroute --all`・ログ prune・`log replay`・`--shots`・`net log --responses`。../kb-v0.5.0-feedback.md 参照、2026-07)/ v0.7.1(**JS ダイアログ対応**: `kb dialog` で alert/confirm/prompt を保留・応答。ポップアップ付きボタンが無反応に見えるバグの修正、2026-07)/ v0.8.0(**デーモン寿命管理**: アイドル自動終了 `--idle-timeout`/`KB_IDLE_TIMEOUT`・in-flight ガード・MCP 切断時の自動起動デーモン後片付け・孤児回収 `kb daemon stop --all`・HAR/downloads の上限。常駐ブラウザの堆積(実測で 12 個・計 322MB)対策、2026-07)/ v0.9.0(**Chrome 拡張機能**: `--extensions <dirs|on|off>` で未パック拡張の読み込みとプロファイル拡張の有効化、2026-07)/ v0.10.0(**検査プロキシ連携 + 細かな要望**: `--ignore-https-errors`、`kb proxy trust-ca`/`untrust-ca`(OS ストア導入 certutil)+ `--ca`/`--scoped`(OS ストア非経由 SPKI allowlist)、`kb login --until-selector`/`--until-gone` と `kb wait --selector-gone`(managed challenge 通過検知)、`kb daemon restart`、`proxy test` の TLS 偽陰性修正、`proxy status` の HTTPS/HTTP 計上明示。../kb-feature-request.md P10-P13 ほか、2026-07)完了。**見送り**: `kb session import --from-chrome`(実 Chrome をコピー起動して復号する案)は、稼働中ユーザ Chrome とのセッション合流でプロファイル状態を破壊するリスク + Windows の cookie DB 排他ロック + App-Bound Encryption により破棄。既存 Chrome の再利用は `--cdp` アタッチ(P1、実装済み)を使う。

単一バイナリ(exe)化は見送り: Playwright はブラウザ実体とドライバ資産をディスク上に必要とするため bundler と相性が悪い。配布は npm パッケージ(`npm link` / `npm pack`)を正とする。

## 残課題(バックログ)

- Linux: ユニットテストは WSL Ubuntu 24.04 + node22 で全パス確認済み(2026-07)。コードに OS 依存なし(パスは path.join、spawn/lock/pid 判定も POSIX 互換)。ブラウザ実起動の E2E は未実施 — 素の環境では `npx playwright install chromium --with-deps` で依存ライブラリ(libnss3 等)の導入が必要。
- eval の「最後の式」判定はパーサでなく構文チェック付きヒューリスティック。`x = 1\n+2` のような ASI 依存の書き方では誤分割しうる(1 文 1 行推奨)。
- ref 自動再解決は「同じ role/name が一意」の場合のみ。同名ボタンが複数あるページでは再解決されずエラーになる(安全側)。
- `kb net mock` はテキスト本文のみ(バイナリ未対応)。
- `--extensions` の未パック拡張は同梱 Chromium 専用(Chrome 137+ stable は --load-extension 削除済み。msedge が追随しているかは未計測 — 明示チャネル + ディレクトリ指定時は CLI が警告を出す)。ロードされたかの実確認は `kb open chrome://extensions` + snapshot が確実。
- UA エミュレーションの reset は空文字セット頼みで、完全に戻すにはタブを開き直すのが確実。
- `kb net body` の捕捉対象はテキスト系の xhr/fetch/document/other のみで、256KB/件で truncate(HAR も同様にテキスト系・256KB 以下のみ本文を含める)。バイナリや 256KB 超の全文は `kb request -o <file>` で取り直すのが唯一の経路。
- storage restore の localStorage 復元はオリジンごとに一時ページを開く方式(遷移不可のオリジンはスキップされる)。
- 複数サインインセッションの同時併用(要望 P5)は未対応。persistent context は 1 プロセス 1 context のため、現状は `KB_HOME` を分けた 2 デーモン併走が回避策(docs 記載済み)。対応するならマルチ BrowserHost 化の大改修になる。
- `kb log replay` は生ジャーナルの成功コマンドのみ再実行し、tab 指定をアクティブタブに読み替える(マルチタブの並行操作の忠実な再現は非対応)。summarizeArgs で 2000 文字超に切り詰められた引数(巨大 eval 等)は再実行が壊れる。
- CLI 出力は日英混在(操作結果の一部が英語)。i18n 統一は見送り中。
- 操作ログの通信記録は xhr/fetch/document/other のみ(画像・静的アセットは対象外)。`kb request` は command イベントとして記録され、requests/ の curl にも含まれる(context.request はページイベントに乗らないため net イベントにはならない)。
