# コマンド設計方針（frontmatter と機構の使い分け）

- **記載時点**: 2026-09-14
- **調査対象バージョン**: Claude Code 2.1.270（VS Code 拡張）
- **位置づけ**: `commands/ut-*.md` を作る・直すときの判断基準。

## 1. 一次情報

| 情報源 | 内容 | 扱い |
| --- | --- | --- |
| [Slash commands - Claude Code Docs](https://code.claude.com/docs/en/slash-commands) | frontmatter **19フィールド**を定義 | **これを正とする** |
| [anthropics/claude-code の frontmatter-reference.md](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/command-development/references/frontmatter-reference.md) | 5フィールドのみ（`description` / `allowed-tools` / `model` / `argument-hint` / `disable-model-invocation`） | **部分集合** |

⚠️ この2つは食い違う。`metadata` / `license` / `compatibility` / `disallowed-tools` /
`effort` / `context` などは docs サイトにしか載っていない。
**GitHub 側だけを見て「そのフィールドは無い」と判断しない。**

## 1.1 前提: コマンドは skills に統合されている

> Custom commands have been merged into skills. A file at `.claude/commands/deploy.md` and a skill
> at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way.
> Your existing `.claude/commands/` files keep working.

`ut-*` は `.claude/commands/` 形式（旧形式）を使っている。動作は継続するが、
**docs サイトの frontmatter 表は「skills 全般」の表**である。コマンド専用の表ではない。

## 1.2 配布経路でフィールドの許容範囲が変わる

⚠️ **Claude Code の中と外で、使えるフィールドが違う。**

| 経路 | 許容されるフィールド |
| --- | --- |
| Claude Code | 表の**全フィールド** |
| Claude Code の外（claude.ai へのアップロード、Skills API、パッケージング） | Agent Skills 仕様の**6つのみ**: `name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools` |

> If you include any field the spec doesn't allow, packaging or upload fails with a
> **hard error** instead of ignoring the field.

**現行の `ut-*` は Claude Code 外へは出せない。** 使っている
`argument-hint` / `disable-model-invocation` / `disallowed-tools` は仕様の6つに含まれないため、
アップロードは**無視ではなくエラーで落ちる**。

Claude Code 内で使う限り問題はない。将来 claude.ai の personal skill として使いたくなった場合は、
この3フィールドを外すか、別形態を用意する必要がある。
なお `metadata` は6つに含まれるので、`scope` ラベルは経路が変わっても持ち出せる。


## 2. 採用しているフィールド

| フィールド | 適用 | 理由 |
| --- | --- | --- |
| `description` | 全本必須 | 一覧と発見性の要。省略すると本文1行目が使われ、意図と合わない |
| `argument-hint` | 全本必須 | 引数の期待値を利用者に示す |
| `disable-model-invocation` | 全本 `true` | `ut-*` は副作用や長い手順を持つ。モデルの自動起動を許さず、人が明示的に打つものとする |
| `metadata.scope` | 全本必須 | 下記 2.1 |
| `disallowed-tools` | 対象を限定 | 下記 2.2 |

### 2.1 `metadata.scope` — 社内依存の有無

```yaml
metadata:
  scope: generic        # または org-specific
```

| 値 | 意味 |
| --- | --- |
| `generic` | 社内固有のシステム・データに依存しない |
| `org-specific` | 社内固有の仕組み（社内Wiki・製品スキーマ・社内運用フロー）に依存する |

**これは「公開してよいか」という判断ではなく、「何に依存しているか」という性質である。**
公開可否は `publish.allowlist` が持つ。両者の関係は等値ではなく片方向の含意になる。

> allowlist に載っている → その `scope` は `generic` でなければならない
> （`generic` だが公開しない、はありうる）

`metadata` を使うのは、Claude Code が自前ツール用の自由記述領域として定義しているため。

> Free-form YAML map for your own key-value data ... read by your own tooling from `SKILL.md`.
> Claude Code doesn't act on its contents, and drops a value that isn't a map.

⚠️ 値がマップでないと**黙って捨てられる**。`scope` を直に書かず、必ず `metadata:` の下にネストする。
未定義のトップレベルキーも実機では読み込まれるが、**文書化されていない挙動に依存しない**ため使わない。

### 2.2 `disallowed-tools` — 事故経路を機構で塞ぐ

本文に「実行はしない」「DBへは接続しない」と書いてあるだけの状態は、指示であって機構ではない。
実行禁止を宣言しているコマンドには `disallowed-tools` を付ける。

⚠️ **完全な安全装置ではない。** 公式ドキュメントに明記がある。

> The restriction clears when you send your next message.

塞げるのは「コマンドを起動したそのターン」だけで、会話が続けば元に戻る。したがって:

- ✅ **初手の事故経路を塞ぐ機構**として使う
- ❌ **「このコマンドでは絶対に実行されない」保証**としては書かない

コマンド本文にこの限界を併記する。書かないと読み手が「制限されている」と誤読する。

付ける対象は「禁止したい事故経路」が具体的に定義できるものに限る。強く付けすぎると、
最小限の調査（ファイルを読む、状態を確認する）まで殺して使い物にならなくなる。

#### 適用状況

| コマンド | 指定 | 理由 |
| --- | --- | --- |
| `ut-plan` | `Bash, Edit, NotebookEdit` | 実行しないコマンド。`Write` は「保存を求められた場合」に使うため残す |
| `ut-sqlpatch` | `Bash, Edit, Write, NotebookEdit` | SQLテキストを生成するだけで、DBへ接続も実行もしない |

| 付けないコマンド | 理由 |
| --- | --- |
| `ut-docrewrite` / `ut-growipost` | 既定は dry-run だが `--apply` で実際に書き込む。**同じコマンド内でモードが変わる**ため、ターン単位で効く機構では表現できない |
| その他 | 「禁止したい事故経路」が具体的に定義できていない |

⚠️ **未検証**: 指定したツール名で実際に制限がかかることを実機で確認していない。
ツール名が誤っていた場合、**エラーは出ず、単に何も制限されない**。

確認方法: 配備後に `/ut-plan` を実行し `Bash` が拒否されることを見る。
対照として `disallowed-tools` を持たない `/ut-report` では `Bash` が使えることも併せて見る。
**片方だけでは「そもそも Bash を使う場面が無かった」と区別できない。**

## 3. 採用していないフィールド

| フィールド | 判断 | 理由 |
| --- | --- | --- |
| `allowed-tools` | 見送り | 事前承認（許可を広げる側）。`ut-*` は確認を挟む設計なので、許可を先回りで広げる動機が無い |
| `model` / `effort` | 保留 | 機械的な処理なら軽量モデルで足りるが、設計判断・レビュー・引き継ぎ生成を安くすると品質が落ちる。対象を特定してから入れる |
| `context: fork` / `agent` | 保留 | 重い収集には効きうるが、挙動の理解コストが上がる。「遅い・文脈を汚す」実害が特定できてから |
| `` !`command` `` / `@file` | 採用しない | 実行前に文脈を注入できる反面、**失敗するとコマンド全体が中断する**。環境差で壊れやすい |
| `arguments`（名前付き引数） | 次段階 | `$ARGUMENTS` を本文で解釈するより誤用が減る。既存13本の引数仕様を一度に変えるのは別作業 |
| `license` / `compatibility` | 次段階 | Agent Skills 仕様。Claude Code は受け取るが何もしない。公開する分に入れる価値がある |
| `user-invocable` | 不要 | `ut-*` はすべて人が打つもの。既定（`true`）でよい |
| `paths` | 不要 | ファイル種別で自動起動させる設計にしていない |
| `hooks` / `shell` | 不要 | 現状そこまでの制御を必要としていない |
| `when_to_use` | 不要 | 全本 `disable-model-invocation: true` で自動起動しないため、効く場面が無い |
| `name` | 不要 | ファイル名と一致させる運用にしている |

### `description` の長さ

一次情報の上限は次のとおり。

> the combined `description` and `when_to_use` text is truncated at 1,536 characters

現行13本の最長は207字で、上限に対して十分収まっている。**短縮は不要。**
（二次情報に「60字目安」とあるが、一次情報の値ではない）

## 4. 機械的に守られること

人の記憶ではなく `deploy.mjs --check` が見る。

| 検査 | 内容 |
| --- | --- |
| C2 | `ut-*.md` が6節骨格を順序どおり持つ |
| C11 | `metadata.scope` が全本に在り、値が `generic` / `org-specific` のいずれかであること。`publish.allowlist` に載るコマンドが `generic` であること。README の分類表と一致すること |
| C12 | 使用している frontmatter キーが本書「2. 採用しているフィールド」と一致すること。**本書に書かずにキーを増やせない**。本書が存在しない場合もエラー |

公開側では `publish.mjs` が、公開対象コマンドの `scope` が `generic` であることを二重に見る。

## 5. 再確認の手順

本書の内容はバージョンに依存する。次のいずれかのときは引き直す。

1. Claude Code のバージョンが上がり、frontmatter 関連の挙動が変わったと疑うとき
2. 新しいフィールドを使いたくなったとき
3. 本書の記載と実挙動が食い違ったとき

手順:

1. **docs サイトの frontmatter 表を引く**（GitHub 側は部分集合なので単独で使わない）
2. 使いたいフィールドが**文書化されているか**を確認する。文書化されていない挙動に依存しない
3. 挙動を変えるフィールドは、**対照を用意して実機で確認する**。
   「壊したときに落ちること」まで見る（通ることは根拠にならない）
4. 本書を更新する。**採らなかった理由も残す**
