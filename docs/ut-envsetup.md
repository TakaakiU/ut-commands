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
   | `newrelic` | New Relic のユーザーキーを入れた環境変数名と、リージョン（`us` か `eu`。省略時は `us`）（使う場合だけ） | 任意 |
   | `sonarqube` | SonarQube の URL を入れた環境変数名（使う場合だけ） | 任意 |
   | `priorities` | `{点検名: "A"｜"B"｜"C"}`。点検の優先度を点検名ごとに上書きする（下の「点検の状態と優先度」） | 任意 |
   | `requests` | `[{to, checks, ask, issue, place}]`。点検が fail・warn のとき、頼み先ごとに依頼文などを示す（下の「頼む一覧」） | 任意 |
   | `vscode` / `tools` | 点検する項目の有無（`.vscode/launch.json`、Claude Code・Codex・Azure CLI・ut-defer） | 任意 |

   `backlog`・`newrelic`・`sonarqube` は、`--online` を付けたときだけ読み取りの通信を1回ずつ行う。

   - Backlog の `space` は公式ドメイン（`<スペース>.backlog.jp` / `.backlog.com` / `.backlogtool.com`）だけを受け付け、API キーは https のその送り先（既定のポート）にだけ送る。ほかの送り先・ポート・認証情報入りの URL には送らない
   - `backlog.env` には、通信の子プロセスの起動に使う変数（`PATH` など）や `UT_ENV_` で始まる名前は使えない（`newrelic.env` も同じ）
   - New Relic（NerdGraph）は、リージョンごとの固定のホスト（`api.newrelic.com` / `api.eu.newrelic.com`）の `/graphql` にだけ、キーをヘッダー（`API-Key`）で付けて POST する。profile から送り先の URL は受け取らない。NerdGraph は失敗でも HTTP 200 で `errors` を返すことがあるため、応答に `errors` が（空の配列・null 以外で）あれば型を問わず失敗とし、応答が JSON として読めない場合や、アクセスできるアカウントが 0 件の場合も失敗として、理由を分けて表示する。表示するのはアカウントの件数だけで、ID や名前は出さない。キーの種別（ユーザーキー）と権限までは、この点検では切り分けない
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
     "newrelic": { "env": "EXAMPLE_NEWRELIC_USER_KEY", "region": "us" },
     "sonarqube": { "url_env": "EXAMPLE_SONARQUBE_URL" },
     "priorities": { "New Relic API（NerdGraph）": "B" },
     "requests": [{ "to": "New Relic の管理者", "checks": ["New Relic API（NerdGraph）"], "ask": "対象アカウントを閲覧できる権限を付けてください", "issue": "ユーザーキー（自分で発行）", "place": "ユーザー環境変数 EXAMPLE_NEWRELIC_USER_KEY" }],
     "vscode": true,
     "tools": { "claude": true, "codex": true, "az": true, "ut_defer": true }
   }
   ```

2. 点検して、マシン単位の不足を直す。

   ```powershell
   node "<repo>/tools/ut-env.mjs" doctor
   ```

### 点検の状態と優先度

doctor の判定は 4 つ。合計行は `ok + warn + fail + unknown` で、各点検に優先度が付く。

| 状態 | 意味 | 終了コード |
|---|---|---|
| ✓ ok | 確かめられて、問題がない | 0 |
| ! warn | 問題があるが、作業は止まらない | 0 |
| ✗ fail | 問題があり、直す必要がある（点検が判定できなかったときも fail） | 1 |
| ? unknown | **確かめていない**。ok に数えない | 0 |

- unknown は、通信する点検（Backlog・New Relic・SonarQube）を `--online` なしで実行しなかったときに付く。点検を結果から消すと「そもそも見ていない」ことが見えなくなるため、残して未確認と書く。`--online` を付けると ok か fail になる。
- unknown が終了コードを変えないのは、`--online` を付けない通常の実行を失敗にしないため。代わりに、**セットアップの完了判定に入れない**（次項）。
- 判定できなかった点検（外部コマンドの失敗・出力の形式の変化）は unknown にせず fail のまま。終了コード 0 で通り抜けないようにするため。

優先度は、点検名から既定で決まる。

| 優先度 | 意味 | 既定で当たるもの |
|---|---|---|
| A | これが無いと作業を始められない | 環境変数・Claude Code・ツリー・セット・exclude・秘密ファイル・個人設定・必須ファイル |
| B | 一部の機能が使えない | Codex・Azure CLI・プラグイン・MCP・Backlog の許可ドメイン／同期スクリプト・各 API の疎通・ut-defer。**どれにも当たらない点検もここ** |
| C | あれば便利 | VS Code のデバッグ設定・Backlog の同期データ・計画の警告 |

- 出力の最後に、優先度ごとの内訳と「セットアップ: 完了／未完了」が出る。**完了は、優先度 A の点検がすべて ok のとき**だけ（A に warn・fail・unknown が 1 件でもあれば未完了。A が 0 件のときも完了とは言わない）。B・C に問題があっても完了にはなるので、B・C の一覧は別に見る。
- 既定が合わない点検は、profile の `priorities` で上げ下げする。例: New Relic を必須にするなら `"priorities": { "New Relic API（NerdGraph）": "A" }`。そうすると `--online` なしでは A に unknown が入り、完了にならない。
- JSON 出力（`--json`）には、各結果の `priority` と、`byPriority`・`setupComplete`・`requests`・`diff` が入る。
- `priorities` と `requests` が指す点検名は、その profile で実際に行われる点検の名前でなければならない（綴りの誤りは読み込みで止める。黙って効かないままにしないため）。名前は doctor の出力に出ているものと同じ（例: `環境変数 EXAMPLE_NEWRELIC_USER_KEY`・`Codex のログイン`・`セット review`）。

### 前回との差

doctor は実行のたびに、点検名と状態だけを `<USERPROFILE>/.claude/work/env/last-doctor-<範囲>.json` に残し、次の実行で変わったものを出力の最後に示す。

```
前回（2026-11-17T02:40:00.000Z）との差: 2 件
  ✗ → ✓ 環境変数 EXAMPLE_NEWRELIC_USER_KEY
  ? → ✓ New Relic API（NerdGraph）
```

- 範囲は「マシンだけ」と「`--target` ごと」で別の記録。`--target` が違えば、別の記録と比べる。
- 記録に残すのは点検名と状態だけ（メッセージ・修正の案内・値は残さない）。
- 前回の記録が無い・壊れているときは、そう書いて今回の結果で作り直す（差が無かったことにはしない）。保存できなかったときも、そう書く。
- 前回が `--online` なし・今回が あり（またはその逆）のときは、通信する点検の `?` と `✓/✗` の違いがそのためだと添える。
- 記録は、形が正しいものだけを読む（日時・`online` の真偽値・点検名に制御文字なし・点検数 500 件以内・256KB 以内・通常のファイル）。外れたら「読めない」として作り直す。同名の点検が複数あるときは、実行順ではなく状態の組で比べる。
- 同じ範囲で doctor を同時に実行したときは、後に保存した結果が次回の基準になる（ロックはしない。点検の結果自体は変わらず、基準が 1 回ぶんずれるだけ）。
- **前回 fail だった点検だけを再確認する方式にはしていない。** doctor は毎回すべてを見て、差だけを示す。一部だけを見直すと、ほかの点検の悪化が見えなくなるため。

### 頼む一覧

自分では直せない fail・warn（アカウント・権限・キーの発行など）を、人に頼める形で出す。依頼の文面は profile の `requests` に書く（頼み先の名前や依頼文を、コードに持たないため）。

```json
"requests": [
  {
    "to": "New Relic の管理者",
    "checks": ["環境変数 EXAMPLE_NEWRELIC_USER_KEY", "New Relic API（NerdGraph）"],
    "ask": "New Relic の対象アカウントを閲覧できる権限を付けてください。",
    "issue": "ユーザーキー（NRAK- で始まるもの）。自分の画面から発行する",
    "place": "ユーザー環境変数 EXAMPLE_NEWRELIC_USER_KEY（setx。値は端末で直接入力する）"
  }
]
```

| 項目 | 内容 |
|---|---|
| `to` | 頼み先（必須。1〜500 文字・1 行）。同じ頼み先の依頼は 1 つにまとめて出す。各項目に改行などの制御文字は使えない（出力に偽の行を混ぜられないため） |
| `checks` | この依頼に対応する点検名（必須。1 つ以上）。**どれかが fail か warn のときだけ**出る |
| `ask` | そのまま送れる依頼文（必須） |
| `issue` | 受け取った後に**自分で**発行するもの（任意） |
| `place` | 入れる場所。環境変数名・パス・コマンドを、貼れる形で（任意） |

- 頼むのは**アカウントと権限まで**。キー・トークンは本人が発行し、他の人のキーを借りない。依頼文に値を書かない。
- unknown（確かめていない）では出さない。`--online` なしの未確認に対して「キーを頼む」と案内すると、すでに持っている人に余計な依頼をさせるため。確かめたい場合は `--online` を付けて、fail になったときに出す。

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

ツリーごとに秘密を置かない。認証はマシン単位の仕組みに寄せる（例: Azure DevOps は PAT ではなく `az login`、SonarQube・Backlog の値はユーザー環境変数）。ふだんの点検は環境変数の有無だけを見て、値を読まない。`--online` を付けたときだけ Backlog・New Relic の API キーの値を読み、送り先の検査に通った公式の送り先への読み取りの通信1回にだけ使う。どちらの場合も値は表示しない。

## 外部コマンドと git

- Claude Code・Codex・Azure CLI などは cmd.exe 経由で起動し、作業ディレクトリを一時フォルダに固定する（対象のツリーにある同名の `.cmd` を実行しないため）。`PATH` 上の CLI は信頼する前提。
- git は、`PATH` のうち絶対パスの場所だけから探して絶対パスに決めて起動し、対象のツリーの設定を通じた外部コマンドの起動（`core.fsmonitor`、hook）を止める。
