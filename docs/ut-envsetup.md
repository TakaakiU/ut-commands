# ut-envsetup — profile の書き方と運用

git の worktree や別の clone へ移ったときに、マシンとツリーの環境を点検し、正本のチェックアウトにあるファイル一式（レビュー用のコマンド・スクリプトなど）を、出所の記録付きで対象のツリーへ重ねる。本体は `tools/ut-env.mjs`、入口は `commands/ut-envsetup.md`。

以下の `<repo>` は、このリポジトリを置いた場所の絶対パスに読み替える。

## 何のためのものか

Claude Code は、worktree 側に `.claude` があると、メインのチェックアウトの `.claude/commands` などを自動では読まない。さらに、コマンドが呼ぶスクリプトはリポジトリのルートからの相対パスで呼ばれることが多く、実体が各ツリーに必要になる。

手で写すと、どれをどこから写したのか、写したあとで手元で変えたのか正本が進んだのかが分からなくなる。`ut-env.mjs` は、写した各ファイルの正本のハッシュを記録し、次回はその記録・正本・対象の3つを比べて、「正本が更新された」のか「手元で変えた」のかを区別する。手元の変更は上書きしない。

## 最初に1回だけ行うこと

1. `tools/ut-env.profile.example.json` を `<USERPROFILE>/.claude/work/env/profile.json` に写し、実際の値に直す（リポジトリには置かない。`UT_ENV_PROFILE` で場所を変えられる）。
   例は最小の形（必須の `source` と `sets` だけ）で、どちらも自分の環境に合わせて置き換える。ほかの項目は任意で、**使う機能の項目だけを足す**（書かなければ、その点検は行わない）。

   | キー | 書くもの | 必須 |
   |---|---|---|
   | `source` | 正本チェックアウトの絶対パス（セットの複製元） | 必須 |
   | `sets` | `{セット名: [ツリーのルートからの相対パス]}`。ディレクトリは末尾に `/**`。秘密ファイル・個人設定を含めるとエラーになる | 必須 |
   | `env` | 必要な環境変数の**名前**（値は書かない） | 任意 |
   | `plugins` / `mcp` | 必要な Claude Code のプラグイン名・ユーザー単位の MCP 名 | 任意 |
   | `exclude` | 対象のツリーの git から除外するパス（セットのパスは自動で加わる） | 任意 |
   | `secret_files` | ツリーに置かれていないこと・git で追跡されていないことを確かめる秘密ファイル（exclude にも加える） | 任意 |
   | `required` | ツリーに揃っていなければならないファイル（写せたことと、使えることは別のため） | 任意 |
   | `config_json` | 個人設定のパス、必要なキー、正本と同じであるべきキー（値は表示しない） | 任意 |
   | `backlog` | Backlog の API キーを入れた環境変数名、スペースのホスト名、同期スクリプト・同期データの場所（使う場合だけ） | 任意 |
   | `sonarqube` | SonarQube の URL を入れた環境変数名（使う場合だけ） | 任意 |
   | `vscode` / `tools` | 点検する項目の有無（`.vscode/launch.json`、Claude Code・Codex・Azure CLI・ut-defer） | 任意 |

   `backlog` と `sonarqube` は、`--online` を付けたときだけ読み取りの通信を1回ずつ行う。

   - Backlog の `space` は公式ドメイン（`<スペース>.backlog.jp` / `.backlog.com` / `.backlogtool.com`）だけを受け付け、API キーは https のその送り先（既定のポート）にだけ送る。ほかの送り先・ポート・認証情報入りの URL には送らない
   - `backlog.env` には、通信の子プロセスの起動に使う変数（`PATH` など）や `UT_ENV_` で始まる名前は使えない
   - SonarQube の URL は https に限る。リダイレクトはどちらもたどらない
   - 通信の子プロセスには起動に要る環境変数だけを渡す（`NODE_OPTIONS` やプロキシの変数は渡さない）。プロキシ経由でしか外へ出られない環境では `--online` は使えない

   任意の項目をすべて使った例（値はすべて置き換え用。要らない項目は消す）:

   ```json
   {
     "source": "C:/path/to/main-checkout",
     "sets": { "review": [".claude/commands/review/**", ".claude/scripts/**"] },
     "env": ["EXAMPLE_SERVICE_TOKEN"],
     "plugins": ["example-plugin@example-marketplace"],
     "mcp": ["example-mcp"],
     "exclude": [],
     "secret_files": [".claude/config.local.json"],
     "required": [".claude/commands/review/review.md"],
     "config_json": { "path": ".claude/config.json", "keys": ["owner", "project"], "same_as_source": ["owner"] },
     "backlog": {
       "env": "EXAMPLE_BACKLOG_API_KEY", "space": "example.backlog.jp", "settings_pattern": "*.backlog.jp",
       "sync_script": "~/path/to/example-sync-script", "data": "~/path/to/example-synced-data.md", "max_age_hours": 24
     },
     "sonarqube": { "url_env": "EXAMPLE_SONARQUBE_URL" },
     "vscode": true,
     "tools": { "claude": true, "codex": true, "az": true, "ut_defer": true }
   }
   ```

2. 点検して、マシン単位の不足を直す。

   ```powershell
   node "<repo>/tools/ut-env.mjs" doctor
   ```

## ツリーを移ったとき

```powershell
node "<repo>/tools/ut-env.mjs" doctor --target <dir>     # 点検
node "<repo>/tools/ut-env.mjs" plan   --target <dir>     # 変更の計画（書き込まない）。最後に計画ID が出る
node "<repo>/tools/ut-env.mjs" apply  --target <dir> --expect <計画ID>   # 利用者の確認を得てから
```

- `apply` は、plan が出した計画ID を `--expect` で渡さないと動かない。plan の後に正本・対象・profile が変わっていたら拒否されるので、plan からやり直す。
- 完了の条件は、`apply` の最後の「適用後の確認: 変更 0 件 / 未解決 0 件」と、続けて実行した doctor に fail が無いこと。
- 終了コードは次のとおり。

  | サブコマンド | 0 | 1 | 2 | 3 |
  |---|---|---|---|---|
  | doctor | fail なし | fail あり・入力エラー | — | — |
  | plan | 計画を出した | 入力エラー | — | — |
  | apply | 完了 | 適用後にも変更が残った・入力エラー | 未解決（衝突・正本にセットの中身が無い等）が残った | 別の実行が動いている |

- 衝突は上書きしない。正本で置き換えるときは `--take-source <path>` を付ける。
- 正本から消えたファイルは、既定では消さない。消すときは `--prune` を付ける。どちらの場合も、元のファイルを先に退避する。
- 退避先は `<USERPROFILE>/.claude/work/env/backup/<ツリー名>/<時刻>/`。戻すときは、相対パスを保ったまま対象ツリーへ複製する。

## 置き場所

| 場所 | 内容 |
|---|---|
| `<ツリー>/.claude/.ut-env-manifest.json` | 複製した各ファイルの正本ハッシュ（exclude に登録する） |
| `<ツリー>/.claude/.ut-env.lock` | 実行中のロック。実行中でないのに残っていれば消してよい |
| exclude | リンク worktree では全 worktree で共有するファイル（`<正本>/.git/info/exclude`）。別 clone ではその clone のもの |

## 秘密情報

ツリーごとに秘密を置かない。認証はマシン単位の仕組みに寄せる（例: Azure DevOps は PAT ではなく `az login`、SonarQube・Backlog の値はユーザー環境変数）。ふだんの点検は環境変数の有無だけを見て、値を読まない。`--online` を付けたときだけ Backlog の API キーの値を読み、送り先の検査に通った公式の送り先への読み取りの通信1回にだけ使う。どちらの場合も値は表示しない。

## 外部コマンドと git

- Claude Code・Codex・Azure CLI などは cmd.exe 経由で起動し、作業ディレクトリを一時フォルダに固定する（対象のツリーにある同名の `.cmd` を実行しないため）。`PATH` 上の CLI は信頼する前提。
- git は、`PATH` のうち絶対パスの場所だけから探して絶対パスに決めて起動し、対象のツリーの設定を通じた外部コマンドの起動（`core.fsmonitor`、hook）を止める。
