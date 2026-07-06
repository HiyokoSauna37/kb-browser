# kb — CLI Browser

Playwright + Chromium (CDP) ベースの CLI 操作型ブラウザ。デーモンがブラウザを常駐保持し、`kb` コマンドが localhost RPC で命令を送る 2 プロセス構成。

## ビルドと実行

```bash
npm run build          # tsc → dist/
kb <cmd>               # npm link 済み(グローバル)。開発中は node dist/cli.js <cmd>
```

注意: デーモンは起動時の dist/ を保持し続けるため、**ビルド後は `kb daemon stop` で再起動しないと新コードが反映されない**。

## アーキテクチャ

- `src/cli.ts` — CLI クライアント (commander)。全コマンド `--json` 対応。
- `src/mcp.ts` — MCP stdio サーバ (`kb-mcp`)。デーモンの機能を 18 ツールとして公開。`claude mcp add kb -- kb-mcp` で登録。**SDK の zod ジェネリクスは tsc をメモリ爆発させるため、型消去した `tool()` ラッパ経由で登録している(server.tool を直接呼ばないこと)。**
- `src/shared/client.ts` — デーモンへの RPC クライアント(CLI / MCP 共用)。未起動時は自動 spawn。
- `src/daemon/main.ts` — HTTP サーバ (127.0.0.1 ランダムポート + トークン認証)。RPC を host にディスパッチ。
- `src/daemon/host.ts` — BrowserHost。`launchPersistentContext` で Chromium を保持、タブを ID 管理。channel は chrome → msedge → 同梱 chromium の順にフォールバック。
- `src/daemon/relay.ts` — ローカル中継プロキシ。Chromium は常にここを向き、上流(http/socks5/direct)だけ差し替えることで**無再起動のプロキシ切替**を実現。SOCKS5 認証代行・bypass パターンもこの層。
- `src/shared/paths.ts` — `~/.kb/` 配下のパス定義と daemon.json の読み書き。
- `src/shared/proxyStore.ts` — proxies.json(プロファイル + active)の読み書き。

## 状態ファイル (`~/.kb/`)

- `daemon.json` — port / token / pid(デーモン起動中のみ存在)
- `profiles/<name>/` — Chromium user-data-dir(Cookie 等が永続化される)
- `proxies.json` — プロキシプロファイルと active。CLI が直接編集し、デーモンには RPC で live 適用。
- `daemon.log` — デーモンのログ。デバッグはまずここを見る。

## モード切替・待機・エミュレーション

```bash
kb mode [headed|headless]        # 引数なしで現在値。切替は再起動を伴うがタブ URL と Cookie は復元
kb wait [--url "**dashboard**"] [--selector h1] [--timeout 120]   # 手動ログイン等の完了待ち
kb emulate ua "<UA>" / viewport 390x844 [--dpr 3 --mobile] / tz America/New_York / geo 35.68 139.76 / reset
```

- 手動介入の運用: headed のままユーザーがウィンドウを直接操作 → agent は `kb wait --url ...` で完了を検知して再開。
- エミュレーションはタブ単位(geo のみ context 全体)。CDP セッションを detach するとオーバーライドが消えるため、host が CDPSession をタブ毎に保持し続ける実装になっている。

## DevTools 系コマンド

```bash
kb net log [--filter <regex>] [-f] [-n 50]   # Network タブ相当。-f で追従
kb net block "*://*.doubleclick.net/*"        # glob パターンで遮断
kb net mock "*://api.example/**" --body mock.json [--status 200]
kb net rules / kb net unroute <id>
kb net har start / stop -o out.har            # HAR 記録(本文含む、256KB/エントリ上限)
kb console [-f] [--clear]                     # console.log / pageerror
kb dom query "h1" [--html] [--attr href]
```

ログはデーモン内のリングバッファ(3000 件)に seq 付きで蓄積され、`-f` は since カーソルのポーリング(700ms)で追従する。

## プロキシ操作

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 [--user u --pass p] [--bypass "*.internal,localhost"]
kb proxy list          # * = アクティブ
kb proxy use work      # デーモン起動中なら無再起動で即時切替
kb proxy off           # direct に戻す
kb proxy test [work]   # 外部 IP と応答時間で疎通確認
kb proxy rule add "*.corp.example.com" work   # ホスト別振り分け(先勝ち、FoxyProxy 相当)
kb proxy rule list / kb proxy rule rm <index>
```

active・rules の変更は proxies.json 書き込み + `proxy.reload` RPC(デーモンがファイル再読込)で live 反映される。

## 動作確認の基本ループ

```bash
node dist/cli.js open example.com
node dist/cli.js text            # 本文をテキストで読む
node dist/cli.js screenshot -o s.png   # 画像は Read ツールで確認
node dist/cli.js daemon stop     # ブラウザごと終了
```

デフォルトは headed(ウィンドウ表示)。ユーザーはウィンドウを直接操作でき、CLI 操作と常時併用可能。

## ロードマップ

docs/requirements.md 参照。M1(骨格)/ M2(プロキシプロファイル)/ M3(DevTools 系)/ M4(モード切替・wait・エミュレーション)/ M5(振り分けルール・MCP・npm link 配布)完了。

単一バイナリ(exe)化は見送り: Playwright はブラウザ実体とドライバ資産をディスク上に必要とするため bundler と相性が悪い。配布は npm パッケージ(`npm link` / `npm pack`)を正とする。

## 残課題(バックログ)

- 中継プロキシ(127.0.0.1)は無認証 — 同一マシンの他プロセスも使える。厳密にするなら Chromium のプロキシ認証チャレンジ対応。
- `kb net mock` はテキスト本文のみ(バイナリ未対応)。
- UA エミュレーションの reset は空文字セット頼みで、完全に戻すにはタブを開き直すのが確実。
