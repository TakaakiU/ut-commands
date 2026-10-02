# ut-commands

Claude Code の個人用スラッシュコマンド集です。作者が自分の作業手順を固定するために作ったものを、汎用的に使える分だけ切り出して公開しています。

- **チーム標準でも公式ツールでもありません。** 作者1人が自分の必要に合わせて育てています
- 予告なく破壊的変更を行うことがあります
- 動作前提は **Windows / Node.js 20.11 以上 / Claude Code**（CLI または VS Code 拡張）。`usage-stats.mjs` が `import.meta.dirname` を使うため 18 系では動きません

## 何が入っているか

| コマンド | 何をするか |
| --- | --- |
| `/ut-report` | 調査・分析・作業の一次報告を Markdown / HTML で生成する。**事実と判断を分離**し、既定でマスク版を出力する |
| `/ut-plan` | 作業に対する実行プロファイル（model / effort / 委譲 / 並列 / 検証強度）を提示する。実行はしない |
| `/ut-handoff` | 次セッションへ手戻りなく再開するための引き継ぎ情報を生成する |
| `/ut-docrewrite` | 既存ドキュメントを、経緯を知らない読者向けに全面再構成する。文書構成規約があれば検出して従う |
| `/ut-sqlpatch` | 調査結果から手動DB復旧SQLを**確認 / 適用 / ロールバックの3本**に分けて生成する（DBへは接続しない） |
| `/ut-diskreport` | Windows Cドライブの大容量・削除候補を**安全度別**にレポートする |
| `/ut-copyblock` | 別媒体へ移す SQL・コード・文面などを、1単位＝1コードブロックで出力する応答モード |
| `/ut-commentrewrite` | 作業ブランチの差分で追加・変更されたソースコメントを、経緯を知らない読者に意味が通る形へ書き直す。**コメントを除いたソースがバイト一致すること**を機械照合してからでないと適用しない |
| `/ut-backlogformat` | 手元の Markdown を Backlog（Nulab）の記法へ変換する。**どちらの記法モードかを実機で判定してから**変換し、投稿はしない |
| `/ut-vscode-debug` | .NET / ASP.NET Core の Web プロジェクトを、VS Code の F5 から HTTPS Kestrel でデバッグ実行できるよう `launch.json` / `tasks.json` を整備する |
| `/ut-defer` | 利用制限で今は実行できない Claude / Codex の作業を積み、制限が解けたらタスクスケジューラ経由で**無人で**実行する。v1 は読み取りの作業だけ |
| `/ut-envsetup` | git の worktree・別の clone へ移ったときに開発環境を点検し、正本のチェックアウトにあるファイル一式（レビュー用のコマンドなど）を、出所の記録付きで重ねる。手元の変更は上書きしない |

⚠️ `/ut-defer` は AI を無人で動かします。使う前に `docs/ut-defer.md` と `commands/ut-defer.md` の「信頼の前提」「閉じ込め」「手元に残るもの」を読んでください。**ネットワークを遮断する仕組みではなく**、読み取りの制限もモデルが使うツールに対するものです。

## 中身

> この見出しと直後の表は `tools/deploy.mjs --check`（C1）が読みます。見出しは `## 中身` のまま、直後に表を置きます。ファイルを足したら行を足してください。足さないと検査が止まります。

| ファイル | 役割 |
| --- | --- |
| `commands/ut-report.md` | `/ut-report` の本体（役割は上の表） |
| `commands/ut-plan.md` | `/ut-plan` の本体（役割は上の表） |
| `commands/ut-handoff.md` | `/ut-handoff` の本体（役割は上の表） |
| `commands/ut-docrewrite.md` | `/ut-docrewrite` の本体（役割は上の表） |
| `commands/ut-sqlpatch.md` | `/ut-sqlpatch` の本体（役割は上の表） |
| `commands/ut-diskreport.md` | `/ut-diskreport` の本体（役割は上の表） |
| `commands/ut-copyblock.md` | `/ut-copyblock` の本体（役割は上の表） |
| `commands/ut-commentrewrite.md` | `/ut-commentrewrite` の本体（役割は上の表） |
| `commands/ut-backlogformat.md` | `/ut-backlogformat` の本体（役割は上の表） |
| `commands/ut-vscode-debug.md` | `/ut-vscode-debug` の本体（役割は上の表） |
| `commands/ut-defer.md` | `/ut-defer` の本体（役割は上の表） |
| `commands/ut-envsetup.md` | `/ut-envsetup` の本体（役割は上の表） |
| `commands/templates/ut-report-html-template.html` | `ut-report` の HTML 出力テンプレート |
| `tools/deploy.mjs` | 正本 ⇄ 実行場所の配置・回収と整合性検査（`--check`） |
| `tools/mask.mjs` | 外部へ出す Markdown から機微値を落とす最小限のマスク（`--selftest` に回帰テスト内蔵） |
| `tools/usage-stats.mjs` | 各コマンドの実呼び出し回数を Claude / Codex のセッション記録から集計する（コマンド名と日付だけを読み、会話本文は保持しない） |
| `codex-skills/ut/SKILL.md` | 同じコマンドを Codex 側から `$ut CMD=ut-* ARGS="..."` で呼ぶためのラッパー（skills） |
| `codex-skills/ut/agents/openai.yaml` | 上のラッパーを Codex が自動で呼ばないようにする設定（明示したときだけ動く） |
| `docs/command-design.md` | コマンドの frontmatter をどう使うか、何を採らないか。判断理由と限界も残している |
| `docs/vscode-ai-shortcuts.md` | VS Code で AI チャットへフォーカスするキー割り当ての記録 |
| `tools/ut-defer.mjs` | `/ut-defer` の本体（キュー・ランナー・`doctor`。`--selftest` に自己テスト内蔵） |
| `tools/ut-defer-sweep.mjs` | `ut-defer.mjs` の防御を1つずつ壊して、自己テストが実際に落ちるかを確かめる掃引 |
| `tools/ut-env.mjs` | `/ut-envsetup` の本体（`doctor` / `plan` / `apply`。`--selftest` に自己テスト内蔵） |
| `tools/ut-env-sweep.mjs` | `ut-env.mjs` の防御を1つずつ壊して、自己テストが実際に落ちるかを確かめる掃引 |
| `tools/ut-env.profile.example.json` | `/ut-envsetup` の profile の最小の例（`source` と `sets` を自分の環境に合わせる。任意の項目は `docs/ut-envsetup.md` を見て、使う機能の分だけ足す） |
| `docs/ut-defer.md` | `/ut-defer` の配備・タスクスケジューラへの登録・復旧の手順と、手元に残るもの |
| `docs/ut-envsetup.md` | `/ut-envsetup` の profile の書き方と運用 |
| `LICENSE` | MIT License |

## 導入

```sh
git clone <このリポジトリ> ut-commands
cd ut-commands

node tools/deploy.mjs --check                    # 整合性検査（書き込まない）
node tools/deploy.mjs --target claude            # 差分の確認（dry-run）
node tools/deploy.mjs --target claude --apply    # ~/.claude/commands/ へ配置
```

`deploy.mjs` は **既定が dry-run** で、`--apply` を付けるまで何も書き込みません。Codex 側へ配る場合は `--target codex-skills` を使います（`~/.agents/skills/` へ配置）。

以前の版で Codex の custom prompts（`~/.codex/prompts/ut.md`。`/prompts:ut` で呼ぶ形）を配置していた場合: custom prompts は Codex で非推奨になったため、skills（`$ut`）へ移しました。`--target codex` は廃止しています。`--target codex-skills --apply` で skills を配置したあと、`~/.codex/prompts/ut.md` は要らなければ手で削除してください（`deploy.mjs` は削除をしません）。skills は `agents/openai.yaml` で自動の呼び出しを止めてあり、`$ut` と明示したときだけ動きます。

VS Code 拡張として使っている場合、**ウィンドウの再読み込みでは反映されません**。全ウィンドウを閉じて起動し直してください。

## 設計の考え方

このコマンド群には共通する方針があります。使う前に知っておくと挙動が読めます。

**1. 既定は dry-run。書き込みは明示指定のみ**

配置も、ドキュメント再構成も、ディスク削除も、既定では提示だけで終わります。`--apply` と確認応答の両方が揃ったときだけ実行します。

**2. 「エラーが出なかったこと」を成功の根拠にしない**

書き込み後は読み直して一致を確認します。0件更新・変化なしは失敗として報告します。処理が例外を出さずに何もしていない、という状態を成功と呼ばないためです。

**3. 0件を「問題なし」と読まない**

検索や検出が0件を返したとき、それが「該当なし」なのか「検出ロジックが壊れている」のかは区別できません。0件を根拠にする前に、**検出できると分かっている対象で同じ検索を1回叩いて**、検出経路が生きていることを示します（陽性対照）。

**4. 事実と判断を分ける**

レポート生成では、実測した事実と、そこから導いた解釈を別の節に置きます。根拠のない結論は主張にしか見えないためです。

**5. マスクは秘匿値の検出であって、公開可否の判断ではない**

`mask.mjs` はトークンや接続文字列のような「形が決まっている機微値」を落としますが、固有名詞の辞書は持ちません。顧客名・個人名・社外秘の範囲は人が判断します。**マスクが通ったことを公開可の根拠にしないでください。**

## 検査について

`deploy.mjs --check` は、README の一覧表と実ファイルの一致、コマンド本文の構造、機微値の混入などを機械的に検査します。ファイルを増やして README に書き忘れると検査が止まるので、一覧は構造的に最新へ保たれます。

この検査は公開物の中でも通るように作っています（公開用のビルドが、組み上げた公開ツリーで実際に `--check` を動かして確かめています）。検査が読む表は、上の「中身」と次の2つです。

## Codex ラッパー一覧

> この見出しと直後の表は `tools/deploy.mjs --check`（C4）が読みます。

| 入口 | 主な用途 |
|---|---|
| `ut` | `$ut CMD=ut-* ARGS="..."` で `ut-*` コマンドを Codex から呼ぶ |

## コマンドの分類

> この見出しと直後の表は `tools/deploy.mjs --check`（C11）が読みます。`metadata.scope` は「社内固有の仕組みに依存するか」という性質です（`docs/command-design.md`）。

| コマンド | `metadata.scope` | 公開用ビルドに含める |
|---|---|---|
| `ut-report` | `generic` | あり |
| `ut-plan` | `generic` | あり |
| `ut-handoff` | `generic` | あり |
| `ut-docrewrite` | `generic` | あり |
| `ut-sqlpatch` | `generic` | あり |
| `ut-diskreport` | `generic` | あり |
| `ut-copyblock` | `generic` | あり |
| `ut-commentrewrite` | `generic` | あり |
| `ut-backlogformat` | `generic` | あり |
| `ut-vscode-debug` | `generic` | あり |
| `ut-defer` | `generic` | あり |
| `ut-envsetup` | `generic` | あり |

`mask.mjs --selftest` はマスクの回帰テストです。**陽性ケースと陰性ケースの両方**を見ます。全件パスしない状態で外部へ出さないでください。

## 貢献について

Issue / PR は歓迎しますが、**このリポジトリは上流の作業リポジトリから生成された公開用ビルドです。** 取り込む場合は上流へ反映してから、あらためてここへ反映されます。そのため PR がそのままマージされるとは限らず、内容を取り込んだうえで別のコミットとして現れることがあります。

## ライセンス

MIT License. 詳細は `LICENSE` を参照してください。
