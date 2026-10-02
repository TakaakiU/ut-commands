# ut-defer — 配備・登録・復旧の手順

`tools/ut-defer.mjs` は、利用制限で今は実行できない Claude / Codex のジョブを積み、制限が解けたあとに無人で実行する。
**v1 は読み取りジョブだけ**を扱う（ファイルを変更するジョブは v2 で設計し直す。前提は `commands/ut-defer.md` の末尾）。
入口の説明・信頼の前提・閉じ込めの範囲は `commands/ut-defer.md`、この文書は配備・登録・復旧の手順を扱う。

以下の `<repo>` は、このリポジトリを置いた場所の絶対パスに読み替える。動作を確かめているのは Windows のタスクスケジューラだけ。

## 最初に1回だけ行うこと

```powershell
# 無人実行を許す作業ディレクトリを登録する（既定は空。空のままでは add を拒否する）
node "<repo>/tools/ut-defer.mjs" config --add-root "<無人実行を許す作業ディレクトリ>"

# 自己テストと負テスト（防御を1つずつ壊して、実際に落ちるかを見る）
node "<repo>/tools/ut-defer.mjs" --selftest
node "<repo>/tools/ut-defer-sweep.mjs"      # <repo> で実行。全件 CAUGHT で exit 0

# 実物 CLI が、使う引数と値を受け付けるか（モデルは呼ばない。CLI を更新したら再実行する）
node "<repo>/tools/ut-defer.mjs" doctor
```

`doctor` の「注意」は止める理由ではなく、確かめてほしい点を示す（例: `--safe-mode` でも効く管理者の設定の hook がある）。

Codex の無人実行では、ユーザー設定を読まずに `windows.sandbox="unelevated"` を明示する。

- `elevated` は、準備処理（setup refresh）のたびにプロファイル配下へ権限を付与し続ける既知の不具合がある（openai/codex#48228）。無人実行のたびにこの準備処理を起こさないため。

この指定は **ut-defer が起動する Codex のプロセスにだけ効く**（`-c` による起動ごとの上書き）。`~/.codex/config.toml` は書き換えないので、対話で使う Codex の設定はそのまま残る。

- 代わりに捨てたもの: 公式ドキュメント上、`unelevated` は `elevated` より弱い代替方式である。
  - 専用の低権限ユーザーではなく、自分のユーザーの制限付きトークンで動く。
  - ネットワークの遮断が、専用ユーザー向けのファイアウォール規則ではなく、環境変数レベルになる。
  - つまり無人実行中のジョブは、`elevated` が動く環境より**外部通信を止める力が弱い**。
- 受け入れる理由: 作者の環境では `elevated` の準備処理が失敗しており、`elevated` を前提にできないため。
- 見直す条件: Codex の更新で `elevated` の不具合が直ったら、疎通確認ジョブを `elevated` で試し、通れば戻す。
- `config.toml` を実行のたびに書き換えて切り替える方式は採らない。対話中の Codex にも同時に効くうえ、途中で異常終了すると設定が戻らないまま残るため。

モデルを使わずに積めるよう、PowerShell のプロファイルに関数を置いておく（エンジンが両方止まっていても積める）。

```powershell
function utd { node "<repo>/tools/ut-defer.mjs" @args }
# 例: utd add --engine codex --kind review --prompt-file .\review-request.md
#     utd list / utd review / utd show <id>
```

## タスクスケジューラへの登録

```powershell
# conhost --headless で起動する（node.exe を直接起動すると 15分ごとにコンソール窓が開く）
$repo = "<repo>"   # 例: C:\path\to\ut-commands
$node = (Get-Command node).Source
$a = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$node`" `"$repo\tools\ut-defer.mjs`" run" -WorkingDirectory $repo
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ut-defer-runner" -Action $a -Trigger $t -Settings $s   # ログオン中のみ実行（ユーザーの PATH で claude/codex を解決する）

# 確認 / 解除
Get-ScheduledTask ut-defer-runner | Get-ScheduledTaskInfo
Unregister-ScheduledTask -TaskName "ut-defer-runner" -Confirm:$false
```

- ログオン中だけ動く。スリープ中は実行しない（スリープ解除は設定しない）。復帰後の次の起動で追いつく。
- 二重起動はスケジューラ側（`IgnoreNew`）とロックファイル（`runner.lock`）の両方で防ぐ。
- 実行予定のジョブが無い起動は、何も書かずに終了する。15分ごとの起動でも負荷はほぼ無い。
- エンジン・git・taskkill の実行ファイルは、`PATH` のうち絶対パスの場所から決める（作業フォルダは探さない）。タスクの実行ユーザーの `PATH` に Claude Code・Codex・git があることを確かめる。

## 登録後の陽性対照

登録したら、疎通確認ジョブを各エンジンで1件ずつ流す。**これが done にならない限り、キューが動いているとは言えない**
（ジョブが0件実行のまま「正常」に見える状態を避けるため）。

```powershell
utd add --kind selftest-probe --engine codex  --cwd "<登録した作業ディレクトリ>"
utd add --kind selftest-probe --engine claude --cwd "<登録した作業ディレクトリ>"
utd run      # 手動で1回。以後はスケジューラに任せる
utd list     # probe が done、合計行の等式が成り立っていることを確認する
```

## 何が起きているかを見る

| 見る場所 | 内容 |
|---|---|
| `utd list` | エンジンごとの停止状況、ジョブ一覧、合計行 `合計 N = pending + running + done + failed + hold` |
| `<data>/runner.log` | 状態遷移・ロック・隔離の記録 |
| `<data>/jobs/<id>/attempts/<n>/` | 起動引数（`argv.json`）と生出力（`stdout.jsonl` / `stderr.txt`）。hold の原因調査はここを見る |

`<data>` は `<USERPROFILE>/.claude/work/defer/`（`UT_DEFER_DIR` で変更できる）。

## 手元に残るもの

キューのフォルダ（`<data>`）には、次のものが**マスクせずに平文で**残る。分類の不具合を後から直せるよう、生の出力を捨てないため。

- 積んだプロンプトの本文（`prompt.txt`）
- モデルの出力・エラー・報告（`attempts/<n>/`）。読んだファイルの内容や実パスを含みうる

扱い:

- `<data>` を共有の端末・同期フォルダ（OneDrive など）・バックアップの対象に置かない
- 要らなくなったジョブを消すときは、ランナーと競合しないよう次の順で行う（ランナーは自分では消さない）
  1. 消すのは、`done` か `failed` になったジョブだけにする（`pending` や `hold` のものは、先に `utd cancel <id>` で `failed` にする）
  2. タスクスケジューラの `ut-defer-runner` を無効にし（`Disable-ScheduledTask -TaskName ut-defer-runner`）、`utd list` に running が無いこと・`runner.lock` が無いことを確かめる
  3. `<data>/jobs/<id>/` を消す
  4. スケジューラを有効に戻す（`Enable-ScheduledTask -TaskName ut-defer-runner`）
- `list` / `show` の画面への出力はマスクを通すが、これは**表示のためのもの**で、ファイルの中身を無害にするものでも、公開してよいかの判断でもない

## 復旧

| 状況 | 対応 |
|---|---|
| `runner.lock` が残っている | heartbeat が10分以上止まっていれば次の起動が自動で退避する（`runner.lock.stale-*`）。手動で消す必要はない |
| running のまま止まった | 実行開始から「そのジョブの上限時間＋ロック判定の猶予（既定10分）＋5分」が過ぎたあとの起動で回収される（pending に戻る。途中停止が上限回数に達したら hold）。**回収されるまでの間、ほかのジョブも実行されない**（まだ動いている可能性があるため） |
| `run` が exit 3（`lock_lost`） | 実行中にロックの所有権を失った（長時間のスリープ明けに別の runner が引き継いだなど）。そのジョブは running のまま残り、上の条件で回収される |
| `jobs/_quarantine/` にジョブがある | `job.json` が壊れていたもの。内容を確認して不要なら削除する |
| Claude の失敗が hold ばかりになる | Claude の分類は実例が無い暫定実装。`attempts/<n>/stdout.jsonl` の実例をもとに `classifyClaude` を直す |
| v1 より前に積んだ書き込みジョブがある | 実行されず `unsupported` で hold になる（retry はできない）。`utd cancel <id>` で片付ける。実行済みの書き込みジョブ（done）は `show` で報告を見られる |
| v1 より前の残りファイル（`<data>/capabilities.json`、空の `<data>/wt/`） | v1 では使わない。削除してよい |
| drift で hold になった | 新しい HEAD で良ければ `utd retry <id> --accept-head`。前提が変わったなら `cancel` して積み直す |
| `list` に「読めない」ジョブがある | `job.json` が壊れている。次の `run` で `jobs/_quarantine/` に隔離される |
| `run` が exit 3（`config` / `queue_read` / `invariant`） | 設定の値（`config.json`）・エンジンの停止記録（`engines.json`）・キューのフォルダの権限を直す。0件の正常終了に見せないために止めている。`engines.json` は削除すれば「どのエンジンも止まっていない」状態から再開する |
| Claude・Codex を更新した | `utd doctor` で、使う引数と値が実物のヘルプにあるかを確かめる |
| `run` が exit 3（`finish_failed`） | 結果を保存できず、ジョブの状態を確定できなかった（ディスクの容量・権限など）。原因を直すまで次の起動も同じになりうる。ジョブは running のまま残り、原因を直した後の起動で回収される |
| 時間が過ぎても running のまま回収されない | 試行のフォルダの `child.json` の pid がまだ動いている（runner だけが止まり、エンジンが残っている）。そのプロセスを確かめて止めれば、次の起動で回収される。1日を過ぎたら pid に関係なく回収する |
| エンジンや git が「PATH の絶対パスの場所に見つからない」 | タスクの実行ユーザーの `PATH` に、絶対パスでそのフォルダが入っているかを確かめる（相対パスの要素は探さない） |

## 版を入れ替えるとき

`tools/ut-defer.mjs` を新しい版に入れ替えても、すでに動いているランナーと、その子プロセス（エンジン）は古い版のまま動き続ける。次の順で入れ替える。

1. タスクスケジューラの `ut-defer-runner` を無効にする（`Disable-ScheduledTask -TaskName ut-defer-runner`）
2. 動いているランナーとエンジンが無いことを確かめる（`utd list` に running が無いこと、`runner.lock` が無いこと）
3. キューのフォルダ（`<data>`）を丸ごと退避する。完了済みジョブの報告も保全される
4. 新しい版を入れる（`git pull` など）
5. `utd doctor` と `node "<repo>/tools/ut-defer.mjs" --selftest` を実行する
6. スケジューラを有効に戻す（`Enable-ScheduledTask -TaskName ut-defer-runner`）
7. 次の起動の後、`utd list` と `runner.log` に異常が無いことを確かめる

## 積むときの注意

- プロンプトのファイルは対象リポジトリの外（例: `<USERPROFILE>/.claude/work/defer/drafts/`）に置く（本文は積んだ時点でジョブ側に複製される）。
- `allowed_roots` には、外部に出してはいけない情報を含むリポジトリを登録しない。推論のためにモデルの提供元へは内容が送られる。
- Codex には組み込みの web 検索を切る設定（`web_search="disabled"`）を渡しているが、根拠はモデルの自己申告による比較で、通信そのものを止める仕組みではない。
- Claude のジョブは `--safe-mode` で hook・プラグイン・MCP を読まないが、管理者のポリシー設定と認証の補助（`apiKeyHelper` など）は効く（`doctor` が報告する）。
- どちらのエンジンも、ネットワークを遮断する仕組みではない。隔離したい場合は、専用の OS ユーザーやファイアウォールを別に用意する。
