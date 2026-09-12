# CLIBrowser repository agent instructions

このリポジトリで作業するエージェントは、最初に <code>CLAUDE.md</code> を読み、そこにある開発・検証手順に従ってください。

## Documentation update gate

コード、設定、CLI、MCP、永続化形式、またはユーザーから見える挙動を変更したら、完了前に必ずドキュメントへの影響を確認します。

- CLI コマンド、引数、オプション、既定値を変更した場合は、<code>--help</code> と <code>docs/CLI_REFERENCE.ja.md</code> を更新します。
- MCP ツール名、入力スキーマ、説明を変更した場合は、実装上の説明、<code>docs/CLI_REFERENCE.ja.md</code> の MCP 節、README に記載したツール数を確認します。
- インストール、代表的な利用手順、セキュリティ上の注意、ユーザー向けワークフローを変更した場合は、<code>README.ja.md</code> と <code>README.md</code> を確認します。
- アーキテクチャ、状態ファイル、保守手順を変更した場合は、<code>CLAUDE.md</code> を確認します。
- ドキュメント更新が不要と判断した場合も、最終報告に確認済みであることと、その理由を一言記載します。

変更後は、関連する CLI の <code>--help</code> と実装をドキュメントに照合し、通常のビルド・テストと併せて不整合がないことを確認します。ドキュメント影響確認は完了条件の一部です。
