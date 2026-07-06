# CLI ブラウザ 技術検討・要件整理

作成日: 2026-07-07

## 0. ゴール

- 通常の GUI ブラウザが持つ機能(レンダリング、Cookie 管理、DevTools 相当の操作)を **すべて CLI から** 扱えるブラウザ。
- FoxyProxy 風の **プロキシプロファイル管理**(IP:PORT を名前付きで保存し切り替え)を必須要件とする。
- 基本は **Claude Code から Bash 経由で操作**。必要に応じて **ユーザーが手動操作できるモード** に切り替え可能。

---

## 1. エンジン選定: Chromium 系 vs Gecko 系

### 結論: **Chromium 系を採用する**(実質的に一択)

| 観点 | Chromium | Gecko (Firefox) |
|---|---|---|
| リモート制御プロトコル | **CDP (Chrome DevTools Protocol)** — DevTools そのものが使うプロトコルで、DevTools でできることは原理上すべて外部から実行可能 | WebDriver BiDi / Marionette。**CDP サポートは Firefox 129 前後(2024年)で廃止済み** |
| DevTools 操作の網羅性 | Network / Emulation / Fetch(リクエスト改変) / Tracing / Coverage / HAR 出力まで全部 CDP 経由で可能 | BiDi は標準化中で改善しているが、CDP 比でカバレッジに穴がある(細かいエミュレーション、トレーシング等) |
| 組み込み・配布 | Playwright / Puppeteer が動作保証済みバイナリを自動取得。システムの Chrome / Edge にもアタッチ可能 | **公式の組み込み API が存在しない**(GeckoView は Android 専用)。Playwright の Firefox は独自パッチ済みビルドで、素の Firefox ではない |
| headless 品質 | `--headless=new` 以降、headless = 通常ブラウザと同一コードパス(旧 headless の別実装問題は解消済み) | headless はあるが自動化プロトコル側の制約を受ける |
| プロキシ制御 | 起動フラグ + コンテキスト単位のプロキシ + CDP での制御が揃う | 可能だが選択肢が少ない |
| エコシステム | Playwright / Puppeteer / chrome-remote-interface など成熟 | 相対的に薄い |

Gecko を選ぶ理由があるとすれば「非 Chromium エンジンでの表示確認」というテスト用途だが、本プロジェクトの目的(CLI からの完全操作)では制御プロトコルの網羅性が生命線であり、**CDP を持つ Chromium が要件に直結する**。

> 補足: 「DevTools 操作を CLI で」という要件は、Chromium なら追加実装がほぼ不要。DevTools 自体が CDP のクライアントにすぎないため、CDP を叩ける時点で DevTools と同等の能力を持つ。

### 制御レイヤーの選定

| 選択肢 | 特徴 | 判定 |
|---|---|---|
| **Playwright (TypeScript)** | CDP の上に安定 API。persistent context(プロファイル永続化)、コンテキスト毎プロキシ、`CDPSession` で生 CDP にも降りられる | **推奨** |
| Puppeteer | Chromium 特化で軽いが、Playwright にできてこちらにできないことは少ない | 次点 |
| chrome-remote-interface(生 CDP) | 最軽量・完全制御だが、待機処理やライフサイクル管理を全部自作 | 部分利用(Playwright の CDPSession で足りる) |
| WebView2 (Karu の資産) | GUI 前提。headless 不可、CDP は `CoreWebView2.CallDevToolsProtocolMethodAsync` 経由で制約あり | 不採用(CLI 用途に不向き) |

---

## 2. 全体アーキテクチャ

```
┌─────────────┐  HTTP/WS (localhost:port)   ┌──────────────────────────┐
│ CLI クライアント │ ──────────────────────────→ │ デーモン (browser host)      │
│  `kb <cmd>`  │ ←────────────────────────── │  Playwright + Chromium    │
└─────────────┘        JSON レスポンス         │  ├ persistent context     │
      ↑                                      │  ├ ローカル中継プロキシ        │
 Claude Code (Bash)                          │  └ プロファイル/状態管理       │
                                             └──────────────────────────┘
```

**デーモン + 薄い CLI クライアント** の 2 プロセス構成が必須。理由:

1. ブラウザは起動が重い(数百 ms〜秒)。コマンド毎に起動していたら使い物にならない。
2. タブ・Cookie・ログイン状態を **セッションとして保持** し続ける必要がある。
3. Claude Code の Bash ツールは 1 コマンド 1 プロセスなので、状態はデーモン側に置くしかない。

- CLI は `kb open <url>` のように即時リターンし、デーモンに HTTP/WebSocket で命令を送る。
- デーモンは初回コマンド実行時に自動起動(`kb daemon start` 明示起動も可)。
- 通信は `127.0.0.1` バインド + トークン認証(localhost の他プロセスからの悪用防止)。

### 技術スタック(推奨)

- **TypeScript + Node.js + Playwright**(browser host / CLI とも)
- CLI フレームワーク: commander など。全コマンド `--json` フラグで機械可読出力
- 配布: `npm i -g` または pkg/bun compile で単一 exe 化

C# (.NET) + Playwright for .NET でも同じ構成は組める(Karu の資産・慣れを活かせる)が、CDP 周りのサンプル・ライブラリ量は TS 圧倒的優位。**新規なら TS を推奨**。

---

## 3. 機能要件 → 技術マッピング

| 機能 | 実現手段 (Playwright / CDP) |
|---|---|
| ページ表示・遷移 | `page.goto()`、タブ = `page`、ウィンドウ = `context` |
| レンダリング結果の取得 | `page.screenshot()`(全画面/要素単位)、`page.pdf()`、`page.content()`(DOM)、アクセシビリティツリー取得(テキストベース閲覧に有用) |
| Cookie 管理 | `context.cookies()` / `addCookies()` / `clearCookies()`。エクスポート/インポート(JSON, Netscape 形式)も CLI サブコマンド化 |
| ストレージ | localStorage/sessionStorage/IndexedDB は `page.evaluate()` + CDP `Storage.*`。`context.storageState()` で一括ダンプ/復元 |
| JS 実行(Console 相当) | `page.evaluate()`、`kb eval '<expr>'`。REPL モード(`kb repl`)も可 |
| ネットワーク監視(Network タブ相当) | `page.on('request'/'response')`、HAR 記録(`recordHar`)、`kb net log --follow` |
| リクエスト改変・ブロック | `page.route()` / CDP `Fetch.*`(ヘッダ書換、モック、広告ブロック) |
| コンソールログ・エラー取得 | `page.on('console')` / `page.on('pageerror')` → `kb console --follow` |
| DOM 検査(Elements タブ相当) | `page.locator()` / CDP `DOM.*`。`kb dom query 'selector'` |
| エミュレーション | UA / viewport / デバイス / geolocation / timezone / ネットワーク速度 — すべて Playwright 標準 |
| ダウンロード | `page.on('download')` → 保存先指定 |
| 認証ダイアログ / Basic 認証 | `context.setHTTPCredentials()` |
| プロファイル永続化 | `launchPersistentContext(userDataDir)` — Cookie・ログイン状態がブラウザ再起動をまたいで保持される |
| トレース / パフォーマンス | CDP `Tracing.*`、`context.tracing`(Playwright トレース) |

### CLI コマンド体系(案)

```
kb daemon start|stop|status
kb open <url> [--tab <id>] [--new]
kb tabs [list|close <id>|switch <id>]
kb screenshot [--tab <id>] [-o out.png] [--full]
kb text [--tab <id>]              # 本文テキスト抽出(Claude が読む用)
kb dom query '<selector>' [--html|--text|--attr name]
kb eval '<js>'
kb click '<selector>' / kb type '<selector>' '<text>' / kb press <key>
kb cookies list|get|set|rm|export|import [--domain d]
kb storage dump|restore [-o state.json]
kb net log [--follow] [--har out.har] [--filter <pattern>]
kb net block '<url-pattern>' / kb net mock '<pattern>' --body file.json
kb console [--follow]
kb proxy add|rm|list|use|off ...   # → §4
kb mode headed|headless            # → §5
kb profile list|use <name>         # ブラウザプロファイル(user-data-dir)切替
```

すべてのコマンドが `--json` で構造化出力 → Claude Code がパースしやすい。

---

## 4. プロキシプロファイル(必須要件)

### プロファイル定義 (`~/.kb/proxies.json`)

```jsonc
{
  "profiles": {
    "work":  { "type": "http",   "host": "10.0.0.1",    "port": 8080,
               "username": "u", "password": "…", "bypass": ["*.internal.example", "localhost"] },
    "socks": { "type": "socks5", "host": "127.0.0.1",   "port": 1080 },
    "direct": { "type": "direct" }
  },
  "rules": [                       // FoxyProxy のパターン振り分け相当(オプション)
    { "pattern": "*.corp.example.com", "profile": "work" },
    { "pattern": "*", "profile": "direct" }
  ],
  "active": "work"
}
```

### 切替の実装方式 — **ローカル中継プロキシ方式を推奨**

Chromium のプロキシは起動フラグ(`--proxy-server`)で固定されるため、素朴にやると **切替のたびにブラウザ再起動** が必要になる。これを回避するため:

```
Chromium ──(常に固定)──→ 127.0.0.1:0 のローカル中継プロキシ ──→ アクティブな上流プロキシ
```

- デーモン内に小さなフォワードプロキシ(Node なら `proxy-chain` 等、または自作)を常駐させ、Chromium は常にそこを向く。
- `kb proxy use work` は **中継プロキシの上流を差し替えるだけ** → ブラウザ無再起動・即時切替。
- 副次効果:
  - **SOCKS5 認証問題の解決**: Chromium は SOCKS プロキシの user/pass 認証を直接サポートしないが、中継層が認証を代行できる。
  - **FoxyProxy のパターン振り分けも実装可能**: 中継層でリクエスト先ホストを見て上流を選ぶ(`rules`)。本家 FoxyProxy を超える柔軟性。
  - **全トラフィックのロギング地点** としても使える。

代替案(併記):
- (a) コンテキスト再作成方式: Playwright はコンテキスト単位のプロキシ指定が可能なので、切替時に context を作り直す。ページは閉じるが `storageState` で Cookie 等は引き継げる。実装は簡単だが「開いているタブが消える」UX。
- (b) タブ(コンテキスト)ごとに別プロキシ: 「このタブだけ work プロキシ」という FoxyProxy 以上の芸当も (a) の仕組みで可能。v2 機能候補。

### CLI

```
kb proxy add work --type http --host 10.0.0.1 --port 8080 [--user u --pass p] [--bypass "*.internal"]
kb proxy list          # active に * 印
kb proxy use work      # 即時切替(無再起動)
kb proxy off           # direct
kb proxy test [work]   # 疎通確認(外部 IP 確認サイト or CONNECT テスト)
kb proxy rule add "*.corp.example.com" work
```

---

## 5. 手動操作モード(headed ⇄ headless)

Chromium は **headed(ウィンドウあり)で起動しても CDP 制御は完全に効く**。そこで:

- **デフォルトを headed にする**のが実用的。ウィンドウは常に本物の Chromium なので、ユーザーはいつでもマウス/キーボードで直接介入できる(ログイン、CAPTCHA、目視確認)。CLI 操作と手動操作は排他ではなく **常時併用可能**。
- `kb mode headless` はサーバ的運用・画面不要時用。**headed⇄headless の切替はブラウザ再起動が必要**(Chromium の制約)だが、persistent context により Cookie・ログイン状態は維持される。開いていたタブ URL もデーモンが記録して復元する。
- 手動介入の運用例: Claude Code が自動操作中にログイン画面へ到達 → `kb wait-for-user "ログインしてください"`(ユーザーの Enter または特定 URL 到達まで待機)→ 自動操作再開。

補足: 既存の(ユーザーが普段使う)Chrome に `--remote-debugging-port` でアタッチするモードも将来オプションとして追加可能(Playwright `connectOverCDP`)。

---

## 6. Claude Code からの運用

1. **第一形態: プレーン CLI + JSON 出力**
   - Bash ツールからそのまま叩ける。デーモン常駐なので各コマンドは数十 ms で返る。
   - `kb text` / `kb screenshot` / `kb net log --json` が Claude の主要な「目」になる。
   - スクリーンショットは Claude Code の Read ツールで画像として読める → 視覚確認ループが成立。
2. **第二形態(任意): MCP サーバ化**
   - CLI と同じデーモン API を MCP tools として公開すれば、権限プロンプトの粒度やスキーマ検証が改善。CLI が先、MCP は後付けで薄く被せる設計にする。
3. プロジェクトに `CLAUDE.md` を置き、コマンド体系と「スクショ→確認→操作」の推奨ループを記述。

---

## 7. リスク・注意点

| リスク | 対応 |
|---|---|
| Playwright 同梱 Chromium は **Widevine(DRM)なし**、コーデックも一部制限 | DRM が要る場合は `channel: 'chrome'` でインストール済み Chrome/Edge を起動する設定を用意(Karu で DRM 検証済みの知見が活きる) |
| headless はボット検出に引っかかりやすい | デフォルト headed + 実 Chrome チャネル起動で大半回避 |
| SOCKS5 認証を Chromium が非サポート | ローカル中継プロキシで解決(§4) |
| デーモンのポートを他ローカルプロセスに悪用される | 127.0.0.1 バインド + 起動時生成トークン認証 |
| headed⇄headless 切替に再起動が必要 | persistent context + タブ復元で体感を軽減 |
| CLI から「全機能」と言っても拡張機能エコシステムは対象外 | 広告ブロック等は `page.route()` で自前実装(Karu の AdBlocker 資産を移植可能) |

---

## 8. 実装フェーズ(案)

1. **M1: 骨格** — デーモン + CLI + Playwright persistent context。`open / tabs / screenshot / text / eval / cookies`
2. **M2: プロキシ** — プロファイル CRUD + ローカル中継プロキシ + 即時切替 + `proxy test`
3. **M3: DevTools 系** — `net log/har/block/mock`、`console --follow`、`dom query`、エミュレーション
4. **M4: モード** — headed/headless 切替、タブ復元、`wait-for-user`、実 Chrome チャネル対応
5. **M5: 仕上げ** — パターン振り分けルール、MCP サーバ、単一バイナリ配布
