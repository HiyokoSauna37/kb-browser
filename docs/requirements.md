# kb 要件仕様書

- 対象バージョン: **v0.13.1**
- 最終更新: 2026-10-26
- ステータス: 実装済み機能の規範仕様

この文書は、kb（CLIBrowser）が満たすべき外部挙動、安全条件、互換性、および受入基準を定める。コマンド、引数、既定値、MCP 入力スキーマの完全な一覧は [CLI / MCP 完全リファレンス](CLI_REFERENCE.ja.md) を正とし、実装構造と開発・保守手順は [CLAUDE.md](../CLAUDE.md) を正とする。

## 1. 目的と対象範囲

kb は Playwright + Chromium を常駐デーモンとして保持し、GUI ブラウザの閲覧・操作・状態管理・通信観測を CLI または MCP から再現可能にする。

必須の目的は次のとおり。

1. AI エージェントが、短命な CLI プロセスから同じブラウザセッションを継続操作できること。
2. headed ブラウザを人とエージェントが共有し、ログイン、OTP、CAPTCHA、目視確認などを人が引き継げること。
3. Cookie、localStorage、タブ、プロファイル、および調査ログを明示的に保存・復元・確認できること。
4. HTTP / WebSocket / Console / DOM を観測し、許可された対象のデバッグやセキュリティ検証に利用できること。
5. FoxyProxy 相当の名前付きプロキシ、ホスト別ルール、無再起動切替、および検査プロキシ CA の管理を提供すること。
6. 人が通常ブラウザで完了した signup 状態を、プロファイル破損や劣化状態の checkpoint 化を防ぎながら kb へ引き継げること。

### 非目的

- Firefox / WebKit など Chromium 以外のエンジン対応。
- Chromium DevTools の全 API をそのまま公開すること。kb が公開する機能範囲は完全リファレンスに記載したものに限る。
- Cloudflare Turnstile 等の対話型 challenge を自動突破すること、または検知回避を保証すること。
- 対象サイトの許可範囲を超えた自動走査、攻撃、レート制限回避。
- Playwright のブラウザ・ドライバ資産を含む単一 exe 配布。
- 1 デーモン内で複数の独立プロファイルを同時稼働させること。

## 2. 実行環境と配布

- 実装言語は TypeScript、実行環境は Node.js **18 以上**、ブラウザ制御は Playwright とする。
- ブラウザエンジンは Chromium 系とし、インストール済み Google Chrome、Microsoft Edge、または Playwright 同梱 Chromium を使用する。
- Windows を主要な実運用環境とし、パス、プロセス探索、終了処理は Windows / macOS / Linux の差異を吸収する。
- 配布単位は npm package とする。開発・ローカル配置は `npm link` を正規経路とし、ビルド済み `dist/` を実行する。
- Playwright はブラウザ実体とドライバ資産をディスク上に必要とするため、単一 exe 化は採用しない。
- 状態ルートは `KB_HOME`（既定 `~/.kb`）である。異なる `KB_HOME` は相互に独立した kb インスタンスとして扱う。

## 3. 確定アーキテクチャ

```text
CLI (`kb`) ─┐
             ├─ shared client ── HTTP/JSON + session token ── Daemon
MCP (`kb-mcp`)┘                    127.0.0.1 only                 │
                                                               ├─ BrowserHost
                                                               │   └─ Playwright persistent context
                                                               ├─ network / dialog / download / session collaborators
                                                               ├─ operation journal
                                                               └─ authenticated local relay ── upstream proxy/direct
```

### 3.1 プロセス境界

- CLI / MCP とブラウザを保持するデーモンは別プロセスとする。CLI が終了してもブラウザセッションは維持される。
- デーモン RPC は `127.0.0.1` のランダムポートへ bind し、起動ごとのランダムトークンで認証する。
- RPC は HTTP/JSON である。ページ上の WebSocket 観測・送受信機能は RPC transport とは別の機能である。
- CLI と MCP は同じデーモンと型付き RPC 契約を共有する。`src/shared/rpc.ts` の schema を RPC コマンド名と入力形状の単一の情報源とする。
- デーモンは受信境界で入力を検証し、未定義コマンドや不正引数をブラウザ処理へ渡してはならない。

### 3.2 ブラウザホスト

- 1 デーモンは 1 persistent browser context と 1 profile を所有する。
- タブは同じ context 内の `Page` として ID 管理する。複数ウィンドウも同じ context に属する。
- BrowserHost は RPC 向け facade とし、起動、タブ、ダイアログ、ダウンロード、HTTP、翻訳、セッション診断などの自己完結した責務を collaborator へ分離できる構造を維持する。
- CDP は Playwright 標準 API で不足する機能に限定して使用する。

### 3.3 ローカル中継プロキシ

- kb が所有するブラウザは、デーモン内のローカル relay を固定の接続先とする。
- relay は上流の direct / HTTP / SOCKS5 を選択し、アクティブプロファイルやホスト別ルールをブラウザ再起動なしで反映する。
- relay 自体もセッション固有の Basic 認証で保護する。`KB_RELAY_NOAUTH=1` はテスト・デバッグ専用の例外とする。

### 3.4 CLI が所有する処理

CLI は単なる表示層に限定しない。ファイル入出力、proxy 設定、操作ログの表示・export、signup のライフサイクル調整など、ブラウザ外の処理を担ってよい。ただしブラウザ状態を変更する処理は共通 RPC を経由し、CLI と MCP で実処理を重複させない。

## 4. 外部契約

### 4.1 出力と終了状態

- CLI の action はグローバル `--json` を受け付ける。Commander が action 実行前に検出する構文エラーや必須引数不足は stderr のテキストと終了コード 1 で返す。
- action 実行後の JSON 成功応答は `{ "ok": true, "result": ... }`、失敗応答は `{ "ok": false, "error": "..." }` とする。
- 人向け出力を変更しても、JSON の意味、終了コード、RPC schema の互換性を意図せず壊してはならない。
- follow 系の JSON は 1 行 1 イベントのストリームとする。
- `text` / `html` / `snapshot` / `eval` 等の長文出力は既定 20,000 文字で切り詰め、offset による継続取得と無制限指定を提供する。

### 4.2 デーモンの起動と寿命

- デーモンが未起動なら、通常コマンドは前回設定を引き継いで自動起動し、その事実を stderr に通知する。
- 明示的な `daemon start` は、指定がなければ headed で起動する。
- 起動時は二重 spawn を lock で防ぎ、子プロセスが早期終了した場合はタイムアウトを待たず daemon log を含む診断を返す。
- 既定の idle timeout は 30 分とし、実行中 RPC を終了させてはならない。0 で無効化できる。
- `daemon restart` は前回の安全な起動設定を引き継ぎ、旧デーモンと子 Chromium の終了を待ってから再起動する。デーモンをまたぐタブ URL の復元は保証しない。
- build ID の不一致を CLI が警告し、status から running / disk の一致を確認できること。
- 通常停止は journal 等を flush する graceful shutdown とする。孤児回収では対象 `KB_HOME` の所有プロセスだけを停止する。

### 4.3 操作対象

- 要素は CSS / Playwright selector、snapshot の ref、または frame + selector で指定できる。
- ref は DOM 変化や navigation で失効し得る。同じ role/name の候補が一意な場合だけ安全に再解決し、曖昧なら失敗させる。
- タブ省略時はアクティブタブを使用する。並列操作で呼び出し側がタブを共有しない場合は tab ID を明示できること。
- mode / profile / auth の変更で context を再起動した場合は、新しい tab ID を応答で返す。

### 4.4 後方互換性

- 内部リファクタリングでは、明示しない限り CLI コマンド、引数、既定値、help、MCP ツール名・説明・入力、RPC の意味、および永続化形式を維持する。
- 外部契約を変更する場合は、完全リファレンス、README、architecture 文書、および回帰テストを同じ変更で更新する。
- 読み込み側は、安全に可能な範囲で旧状態を受理する。状態 migration なしに既存 profile、checkpoint、操作ログを破壊してはならない。

## 5. 機能要件

正確なコマンド構文と既定値は [CLI / MCP 完全リファレンス](CLI_REFERENCE.ja.md) を参照する。

### 5.1 閲覧と操作

- URL の open、タブ一覧・切替・閉鎖、履歴移動、reload、scroll を提供する。
- text、HTML、アクセシビリティ snapshot、スクリーンショット、PDF、ページ内 JavaScript 評価を提供する。
- click、fill、select、check、hover、upload、press を selector / ref / frame に対して実行できる。
- 最後のタブを CLI で閉じても空タブへ置換し、デーモンを不意に終了させない。
- タブ分離は指定タブを 1 つの新規ウィンドウへまとめる。CDP に既存タブの window 間移動がないため、URL で再作成し、ページ内状態を保持するとは保証しない。

### 5.2 人による介入

- headed を既定とし、同じウィンドウを人と CLI / MCP が常時併用できる。
- login は headed 化、URL open、URL / selector / selector 消失または Enter による完了、必要に応じた storage 保存を一連で扱う。
- alert / confirm / prompt は既定で hold し、CLI / MCP または画面上の人が応答するまで意図せず dismiss しない。
- production challenge の自動突破を成功条件にしない。人が Verify する場合は同じ実 browser、profile、UA、proxy/IP を維持し、通過後も session check で再評価する。

### 5.3 プロファイル、状態、ダウンロード

- profile は persistent user-data-dir とし、ブラウザ再起動後も永続 Cookie と localStorage を維持する。
- storage dump / restore の対象は Playwright storageState の Cookie と localStorage とする。replace は既存の両者を可能な範囲で checkpoint と一致させる。
- Cookie は JSON export / import、Netscape export、Cookie header export を提供する。Netscape 形式の import は要件に含めない。
- HttpOnly Cookie も管理・export の対象とする。
- download は `KB_HOME/downloads` へ保存し、状態を一覧できる。

### 5.4 Network、HTTP、WebSocket、Console、DOM

- ページの request / response を連番付きリングバッファで観測し、フィルタ、全 header、捕捉済み text body、block、mock を提供する。
- 捕捉済みログからの遡及 HAR export と、事前に開始する高精度な live HAR 記録を区別する。
- `request` の既定経路はブラウザ context の Cookie jar と proxy を共有するページ非依存 HTTP とし、redirect、Set-Cookie、任意 header、body、ファイル保存を扱う。
- Verify 済みページと通信経路を揃える明示モードでは、指定タブ内の同一 origin fetch を使い、Cookie、TLS、UA、Origin、継続セッションをブラウザへ委ねる。CORS を迂回せず、browser-managed header の偽装、redirect chain の中間 header、Set-Cookie 値の読み出しを要件にしない。
- WebSocket は、ページ自身の接続を観測する経路と、ページ context 内で kb が接続・送受信する経路を分離する。後者はページの Origin、Cookie、TLS、proxy を共有する。
- Console / page error の取得と、DOM selector による text / HTML / property の検査を提供する。
- UA、viewport、timezone、geolocation、network condition の emulation を提供する。

### 5.5 翻訳

- ページ text の取得専用翻訳と、DOM を置換する in-place 翻訳を提供する。
- in-place 翻訳は原文の restore と翻訳表示の toggle ができ、SPA の実質的なページ遷移で古い node を誤操作しない。
- 翻訳結果をプロセス内で再利用し、巨大ページでは外部 endpoint への request 数を制限して partial を明示する。

### 5.6 操作ログ

- デーモン起動時から command と対象範囲の network / console イベントをセッション別 journal に記録する。
- command 境界、短周期 timer、正常停止で buffer を flush し、直近の重要 command を durable にする。
- list、show、steps、再実行、スクリーンショット付き記録、共有 bundle export を提供する。
- bundle は観測した net event を調査用の best-effort curl として残す。browser 経路の command event は、browser-managed な Cookie / UA / Origin / TLS を忠実に再現する経路として、同じ `kb request --via-browser` も別途書き出す。
- 共有向け表示・export では秘密情報を既定で mask する。生 journal は再実行可能性のため無加工であり、秘密情報として扱う。

### 5.7 プロキシと CA

- direct、HTTP、SOCKS5 の名前付き profile、認証、bypass、ホスト別の先勝ち routing rule を保存する。
- routing に使う profile / rule / active の変更は設定へ永続化し、稼働中デーモンへ再起動なしで反映する。
- status は HTTPS CONNECT tunnel と平文 HTTP request を区別し、直近の接続失敗を確認できる。
- proxy test は疎通と TLS 信頼状態を混同せずに表示する。
- 検査 proxy の CA は、Windows では確認付きの CurrentUser OS store 登録、全 platform では kb に限定した SPKI allowlist で信頼できる。scoped SPKI 設定の反映には daemon restart を必要とする。macOS / Linux の OS store 登録は手順を表示して利用者に委ねる。全証明書無検証は明示 opt-in の escape hatch とする。

### 5.8 CDP attach と拡張機能

- 専用 `--user-data-dir` と remote debugging 付きで利用者が起動した Chrome / Edge に attach できる。
- attach 中の stop は接続を切るだけで対象ブラウザを終了してはならない。
- attach 先の起動条件を変更する profile、channel、stealth、extension 等の操作は拒否する。proxy 設定の保存・relay 更新は許可するが、すでに起動済みの attach 先ブラウザの通信経路は変更できない。
- kb 所有ブラウザでは profile に導入済みの extension と unpacked extension を扱える。Chrome の制約上、unpacked extension の自動 channel 選択は同梱 Chromium を使用する。

## 6. signup 引き継ぎの安全不変条件

signup は challenge の自動突破機能ではない。許可された対象で、人が通常ブラウザを使って正規に完了した登録状態を kb へ安全に引き継ぐ機能である。

### 6.1 bootstrap

1. kb デーモンが停止している場合だけ実行する。
2. インストール済み Chrome または Edge を専用 profile で起動する。同梱 Chromium は使用しない。
3. Playwright、CDP、remote debugging、automation、および stealth 用の引数や script を使用しない。
4. 接続は既定 direct とし、明示指定時だけ OS の system proxy を使用する。
5. 同名 signup の再利用、既存 profile の再利用、origin の変更は明示的に検証する。既存状態は `--reuse-profile` なしに上書きしない。
6. process 一覧と `--user-data-dir` を用いて profile 利用中のブラウザを検出し、同じ profile の二重起動を拒否する。

### 6.2 adopt

1. 通常ブラウザと、その profile を保持する子プロセスがすべて終了してから実行する。PID だけを安全性の根拠にしてはならない。
2. signup page 自身の 200 応答を登録成功の根拠にしない。dashboard / account 等の login 後 check URL を必須とする。
3. 最初の診断は常に direct で行い、登録時の network fingerprint と無関係な検査 proxy を混ぜない。
4. check URL の最終到達先、challenge、session verdict、および任意の期待 selector / Cookie 名をすべて評価する。login page への redirect、未観測、期待値欠落を成功扱いしない。
5. Cookie の値を status や診断要約へ記録・表示しない。
6. すべての条件が正常なときだけ Cookie + localStorage を checkpoint へ昇格する。失敗した再 adopt / checkpoint は以前の正常 checkpoint を上書きしない。

### 6.3 proxy 復帰と rollback

1. `--restore-proxy` は direct での adopt 成功後にだけ元 proxy を復帰し、同じ条件でもう一度診断する。
2. proxy 経路が正常なら、その経路で更新された storageState を checkpoint へ反映できる。
3. proxy 経路で challenge、redirect、到達不能、期待値欠落が起きた場合は direct へ戻し、直前の正常 storageState を replace restore する。
4. rollback 後も direct で再診断する。rollback の検証まで成功しなければ最終状態を failed とし、利用可能と報告しない。

### 6.4 データ保護上の条件

- signup state と既定 checkpoint は `KB_HOME/signups/<name>` に保存する。明示した checkpoint 出力先を含め、private permission と一時ファイルからの atomic rename を適用する。
- checkpoint は認証秘密情報であり、共有・commit の対象外とする。
- 通常 Chrome 終了時に失われる session Cookie は引き継ぎを保証しない。必要なら期限付き Cookie の発行と `--expect-cookie` により消失を検出する。

## 7. 永続状態

`KB_HOME` 配下の主要状態は次のとおり。

| パス | 要件 |
|---|---|
| `daemon.json` | 稼働中 daemon の port、token、pid、build ID。所有 pid だけが削除する |
| `last-run.json` | 自動起動・restart で引き継ぐ安全な起動設定。明示 reset を保持できること |
| `daemon.spawn.lock` | 並行 CLI による二重 spawn を防ぐ。stale lock は回収可能にする |
| `profiles/<name>/` | Chromium user-data-dir。別 process との同時利用を避ける |
| `signups/<name>/` | signup state と正常確認済み checkpoint。秘密情報として扱う |
| `proxies.json` | proxy profile、rule、active。認証情報を含み得る |
| `logs/<session>/` | 生 journal、metadata、自動 screenshot。生データは秘密情報を含み得る |
| `downloads/` | ブラウザが保存した download |
| `cookie-seen.json` | Cookie 値そのものではなく hash と最初の観測時刻 |
| `daemon.log` | 起動・relay・runtime 診断ログ |

永続 JSON の書き込みは、更新途中の切断で既存の正常状態を壊さない方法を優先する。形式を変更する場合は versioning または後方互換読み込みを用意する。

## 8. セキュリティとプライバシー

- daemon と relay は loopback のみに公開し、既定で認証を必須とする。
- token 比較は timing attack に耐える方法を使用する。
- profile、proxy credential、storageState、signup checkpoint、生 journal、download は機微データとして扱う。
- 操作ログ export は password / token / secret / signature / auth / session / JWT / CSRF 系の key・header・URL query を既定 mask する。URL path 内の不透明 token など自動判別不能な値には利用者が deny 指定できること。
- `--no-mask`、JWT mask 無効化、全証明書無検証、relay 無認証などの危険な指定は明示 opt-in とし、既定にしない。
- OS CA store 変更は fingerprint を表示して確認を挟み、導入した証明書を同定して取り消せること。
- `eval`、upload、request、proxy、CDP attach は利用者権限で対象環境へ作用する。kb は許可範囲を自動判定しないため、利用者が authorization と rules of engagement を確認する。
- stealth は既定で `navigator.webdriver` の露出を抑えるが、TLS / JA3、HTTP/2、IP reputation、CDP leak、対話型 challenge の回避を保証しない。禁止対象では `--no-stealth` を使用できること。
- hotkey binding は page world に識別可能な binding を追加するため opt-in とし、厳密な stealth の既定経路へ注入しない。

## 9. 信頼性、資源上限、互換性

### 9.1 エラーと回復

- 外部 process、page、network、filesystem の失敗を未処理 rejection のまま残さず、利用者が次の操作を判断できる error にする。
- RPC handler の例外はリクエスト境界で捕捉し、個別 RPC の失敗として返す。process 全体の uncaught exception / unhandled rejection は記録して即時終了を避けるが、その後の状態整合性は保証しない。
- mode / profile / auth の内部切替では保存可能なタブ URL と profile 状態を復元する。別 process を起動する `daemon restart` ではタブ URL の復元を保証しない。
- daemon / relay の graceful stop は keep-alive や CONNECT socket が残っていても無期限に待たず、所有 socket を閉じて完了する。
- process 生存判定は権限不足を死亡と誤認しない。Windows の launcher PID が実 browser process へ処理を引き渡す挙動を考慮する。
- 状態復元で処理できない origin は成功数と skipped origin を区別して返す。
- session check は実効 UA、UA Client Hints、設定済み UA の major / 形状の不整合と使用中 proxy を診断し、Cookie 値を出さずに challenge loop の切り分け材料を返す。

### 9.2 上限の明示

- memory を無制限に増加させる log、body、WebSocket frame、HAR、download metadata、translation cache を持たない。
- ring buffer や body cap により欠落・切り詰めが起きた場合は、件数、cursor、truncated flag、HAR comment 等で観測可能にする。
- 長時間 command は CLI / MCP の timeout と整合する設定を持つ。follow command は明示時間または利用者の停止まで継続することを help に示す。

### 9.3 platform と browser の互換性

- path の生成には platform API を使い、Windows / POSIX の path separator に依存した文字列連結を避ける。
- process 探索、signal、tree kill は platform 別に実装し、別 `KB_HOME` や無関係 process を停止しない。
- 実 Chrome / Edge がない場合は bundled Chromium へ fallback できるが、検知特性や extension 対応の差を警告する。
- Chrome の CDP / extension 制限により実現不能な組合せは、黙って無視せず起動前に拒否または警告する。

## 10. 受入基準

変更は少なくとも次を満たした時点で完了とする。

1. `npm run build` が TypeScript error なしで完了する。
2. `npm test` が unit / regression test を全件通過する。
3. browser を利用できる対象環境で `npm run test:e2e` が隔離 `KB_HOME` を使って通過する。browser 未導入による skip と回帰による未実行を区別する。
4. daemon の auto start、open、snapshot、操作、storage、proxy、network、graceful stop の主要経路が smoke test で確認される。
5. signup 変更では、設定再利用、profile process 検出、成功条件、checkpoint 非上書き、proxy rollback を unit または e2e で確認する。
6. browser 経由 HTTP の変更では、同一 origin、Cookie / UA の browser 管理、CORS 境界、禁止 header、redirect 制約を unit と実 browser e2e で確認する。
7. 対象 platform で `npm link` または既存 link から `kb --version`、関連 `--help`、daemon restart、status を確認する。
8. CLI / MCP の表面を変更しない refactor では、変更前後の root と関連 subcommand の help、および MCP tool 名・説明・schema に意図しない差分がないことを確認する。
9. CLI、MCP、永続化、security、workflow、architecture への影響を documentation gate に従って確認し、必要な文書を同じ変更で更新する。
10. repository の tracked source だけで clean install と build を再現でき、生成物や秘密情報を commit しない。

## 11. 既知の制約

- 1 デーモン 1 persistent context / profile。複数アカウントの同時利用は `KB_HOME` を分ける。
- storage dump / restore は Cookie + localStorage。sessionStorage / IndexedDB の一般的な移送は対象外。
- tab detach は URL のみを引き継ぎ、history、scroll、form、page 内 JavaScript state、POST navigation を保持しない。
- ref の自動再解決は role/name が一意な場合だけである。
- `eval` の最後の式検出は parser ではなく構文検査付き heuristic であり、ASI 依存の記述に制約がある。
- network body と遡及 HAR は捕捉対象、件数、本文 size、timing 精度に上限がある。完全な本文は必要に応じて `request -o`、正確な timing は live HAR を使う。
- WebSocket client は page navigation で失われ、送受信 payload と buffer size に上限がある。
- translation は非公式の外部 endpoint に依存し、rate limit、仕様変更、partial translation が起こり得る。
- unpacked extension は Chromium / Chrome の version と channel 制約を受ける。
- session Cookie は通常 browser の終了で消えることがあり、signup handoff や再起動をまたいだ維持を保証しない。
- session challenge 判定は既知 marker に基づく heuristic であり、未知 vendor の偽陰性や通常ページの偽陽性を完全には排除できない。
- production challenge は UA、IP、TLS、端末、継続挙動等で再評価され得る。人が取得した clearance Cookie の存在や stealth 設定だけで将来の通過を保証しない。
- browser 経由 HTTP は active tab と同一 origin に限定し、ページの CSP / CORS / Fetch 制約を受ける。中間 redirect と Set-Cookie 値の観測が必要なら通常の `request` を使う。
- 操作 log replay は成功 command の順次再実行であり、multi-tab concurrency や巨大で切り詰められた引数の完全再現を保証しない。
- CLI の人向け文言は日本語と英語が混在する。機械処理は `--json` を使用する。
