<p align="center">
  <img src="assets/banner.svg" alt="kb — 人にも AI にも使えるブラウザ操作ツール。Windows・macOS 対応。" width="760">
</p>

<p align="center">
  <b>いつものブラウザ操作を、短いコマンドでも。</b><br>
  Windows でも、Mac でも。自分で使って、AI にも任せられる kb。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-supported-3ddc97.svg" alt="Windows 対応">
  <img src="https://img.shields.io/badge/macOS-supported-3ddc97.svg" alt="macOS 対応">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3ddc97.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#できること">できること</a> ·
  <a href="#はじめる">はじめる</a> ·
  <a href="#ai-と一緒に使う">AI と使う</a> ·
  <a href="docs/USAGE.ja.md">詳しい使い方</a> ·
  <a href="README.md">English</a>
</p>

**kb は、Chrome や Edge を短いコマンドで操作するツールです。** ページを開く、文章を取り出す、スクリーンショットを残す。いつものブラウザ作業を、ターミナルから行えます。

画面には実際のブラウザが開くので、マウスやキーボードでも操作できます。AI エージェントと組み合わせれば、ページの確認や繰り返しの操作を任せることもできます。AI を使わず、コマンドだけでも利用できます。

**macOS でもそのまま使えます。** Windows と同じソース・同じ基本コマンドで動き、Mac だけで利用できます。Windows へのリモート接続は不要です。

## できること

| こんなときに | kb でできること |
|---|---|
| ページの文章をメモや資料に使いたい | 本文をテキストとして取り出す |
| Web サイトの表示を残したい | 今の画面や、ページ全体のスクリーンショットを保存する |
| 外国語のページを読みたい | 表示中の文章を翻訳し、原文に戻す |
| 同じ確認作業を繰り返したい | ページを開く・クリックする・入力する操作をコマンドで組み合わせる |
| AI にブラウザ作業を手伝ってほしい | AI がページを読み、必要なボタンや入力欄を操作する |

通信の確認やプロキシ連携など、開発・調査向けの機能もあります。必要になったら [使い方ガイド](docs/USAGE.ja.md) で詳しく読めます。

## kb の考え方

- **画面を見ながら使う。** ブラウザで何が起きているかを確認でき、ログインなどは自分で操作できます。作業に応じて、人と AI が同じウィンドウを使います。
- **小さな操作を組み合わせる。** 「開く」は `kb open`、「読む」は `kb text`。まずは数個のコマンドから始めて、必要な操作を足していけます。
- **続きから作業する。** 起動中は同じブラウザを使い続け、ログイン情報は kb 専用の保存領域に残します。普段の Chrome とは別管理なので、初回は kb のウィンドウでログインします。

kb 自体は AI ではありません。ブラウザの読み取りや操作を kb が受け持ち、要約や判断は接続した AI エージェントが行います。

## はじめる

初回はターミナルでセットアップします。Mac は「ターミナル」、Windows は PowerShell を開いてください。

必要なものは **Git、Node.js 18 以上（npm を含む）、Google Chrome または Microsoft Edge** です。それぞれ、お使いの OS で動作する版を用意してください。

### 1. kb をインストールする

保存したいフォルダで、次を 1 行ずつ実行します。Windows・macOS 共通です。

```sh
git clone https://github.com/HiyokoSauna37/kb-browser.git
cd kb-browser
npm ci
npm run build
npm link
```

`npm link` が終わると、どのフォルダからでも `kb` と入力して使えます。`kb --version` でバージョンが表示されれば準備完了です。

<details>
<summary>Mac で「EACCES」「permission denied」と出たら</summary>

`npm link` の登録先に書き込めない場合は、同じ `kb-browser` フォルダで、ユーザー用の場所に登録できます。

```sh
npm_config_prefix="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
kb --version
```

標準の zsh を使っている場合は、`export PATH="$HOME/.local/bin:$PATH"` の行を `~/.zshrc` にも追記すると、次にターミナルを開いたときも使えます。すでに同じ設定があれば追記は不要です。

</details>

<details>
<summary>Chrome / Edge を使わずに試したい場合</summary>

`kb-browser` フォルダで次を実行すると、kb が利用する Chromium をダウンロードできます。

```sh
npx playwright install chromium
kb daemon start --channel chromium
```

通常は、インストール済みの Chrome → Edge → この Chromium の順に自動選択します。Safari は操作対象に含まれません。

</details>

### 2. ページを開いてみる

次も 1 行ずつ実行してください。

```sh
kb open https://example.com
kb text
kb screenshot -o example.png
```

ブラウザに「Example Domain」が開き、ターミナルに本文が表示されます。`example.png` は、コマンドを実行したフォルダに保存されます。

開いたウィンドウは、そのまま手で操作しても大丈夫です。作業を終えるときは、次のコマンドで kb のブラウザを閉じます。

```sh
kb daemon stop
```

`daemon` は、ブラウザを起動したまま管理する裏側のプログラムの名前です。最初は「終了するときに使うコマンド」と覚えれば十分です。

### 3. よく使う操作を足す

| やりたいこと | コマンド |
|---|---|
| 別のページを新しいタブで開く | `kb open https://example.org --new` |
| ページ全体を画像にする | `kb screenshot --full -o page.png` |
| ページを日本語に翻訳する | `kb translate` |
| 翻訳を原文に戻す | `kb translate --restore` |
| 開いているタブを見る | `kb tabs` |
| コマンドの使い方を見る | `kb --help` |

翻訳にはページの文章を Google の翻訳サービスへ送信します。クリックやフォーム入力は [使い方ガイド](docs/USAGE.ja.md#ai-エージェントから使う) に例があります。

## AI と一緒に使う

kb を操作できる AI エージェントに接続すると、たとえばこんな依頼ができます。

> kb でこのページを開いて、本文の要点をまとめて。最後にスクリーンショットも保存して。

kb がページを開いて情報を渡し、AI がそれを読んで要約します。ログインが必要な場面では、自分でブラウザを操作してから続きを任せられます。

Claude Code を使っている場合は、kb のインストール後に次で接続できます。

```sh
claude mcp add kb -- kb-mcp
```

ここでの MCP は、AI が外部ツールを呼び出すための接続方式です。kb は 34 個の操作ツールを公開しています。ターミナルのコマンドを実行できるエージェントなら、`kb` を直接呼び出す方法もあります。[接続と操作の詳しい例](docs/USAGE.ja.md#ai-エージェントから使う)

## よくある質問

### 普段の Chrome のログインは引き継がれる？

通常起動では別の保存領域を使うため、自動では引き継がれません。kb のウィンドウでログインすると、その状態を保存します。サイト側の有効期限などによって、再ログインが必要になることはあります。

### Windows と Mac で同じ更新を使える？

はい。同じ GitHub リポジトリから更新できます。Windows 側の変更が GitHub に push されていれば、Mac でも取り込めます。各 PC の `kb-browser` フォルダで、次を 1 行ずつ実行し、エラーが出たらそこで止めて内容を確認してください。

```sh
git pull --ff-only
npm ci
npm run build
```

kb が起動中なら、作業を区切って `kb daemon restart` で更新を反映します。再起動前に必要なタブの URL や入力中の内容を控えてください。ブラウザのログイン情報や設定は PC ごとに保存され、自動同期されません。

### データはどこに保存される？

ログイン情報・設定・操作ログは、ユーザーフォルダ内の `.kb` に保存されます。操作ログは既定で記録され、入力内容や認証情報を含むことがあります。共有するときは `kb log export` で書き出し、内容を確認してください。

AI と連携した場合、ページ本文や画像などの操作結果は接続先の AI に渡ります。

### Linux でも使える？

Linux 向けの実装もあります。WSL で単体テストを確認していますが、この README では Windows・macOS の導入を中心に案内しています。ブラウザ用ライブラリなどの準備については [開発メモ](CLAUDE.md) を参照してください。

## もっと詳しく

- [使い方ガイド](docs/USAGE.ja.md) — クリック・入力、翻訳、ログイン、AI 連携、通信の確認、プロキシなど。
- [CLI / MCP 完全リファレンス](docs/CLI_REFERENCE.ja.md) — すべてのコマンド、オプション、環境変数。
- [開発・内部構造](CLAUDE.md) — Playwright + Chromium による仕組み、ビルド、テスト手順。

ライセンス: [MIT](LICENSE)
