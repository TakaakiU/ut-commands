// ut-defer.mjs の --selftest に欠陥を1つずつ注入し、実際に落ちるかを掃引する負テスト。
// 「selftest が全件パス」を検証済みの根拠にしないため、防御ごとに壊して、その防御を見るテストで落ちることを確かめる。
//   node tools/ut-defer-sweep.mjs            （repo ルートで実行する）
// exit: 0 全件 CAUGHT / 1 それ以外（基準実行の失敗・未検出・別理由での検出・異常終了・設計不正）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

// 生成経路でバックスラッシュが落ちる事故を避けるため、改行はエスケープではなく定数で組み立てる
const NL = String.fromCharCode(10);
const SRC_PATH = 'tools/ut-defer.mjs';
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'utd-sweep-'));
// 変異版から相対 import する mask.mjs を横に置く
fs.copyFileSync('tools/mask.mjs', path.join(tmp, 'mask.mjs'));
const STOP = 'selftest 本体が途中で停止';

// expect: その防御を見ているテスト名の一部。これで落ちた場合だけ CAUGHT と数える
// （無関係なテストが環境要因で落ちても「検出」にしないため）
const mutations = [
  { id: "M01", desc: "不明な失敗を hold でなく pending に戻す", expect: "不明な失敗は再試行せず hold",
    find: "  return finishAsOwner(job, 'hold', { failure: { kind: c.cls, note: c.reason || '' } }, att);", to: "  return finishAsOwner(job, 'pending', { next_attempt_at: null, failure: { kind: c.cls, note: c.reason || '' } }, att);" },
  { id: 'M02', desc: '年齢判定を外す（中身の無いロックは退避後の再確認でも戻せない）', expect: 'lock: 作成直後',
    find: 'if (lockAge() < cfg.stale_lock_min * MIN) return false;', to: '' },
  { id: 'M02b', desc: '年齢判定と退避後の再確認の両方を外す（生きているロックを奪う）', expect: 'lock: 新しい heartbeat',
    find: 'if (lockAge() < cfg.stale_lock_min * MIN) return false;', to: '',
    also: ['if (Number.isFinite(mhb) && now - mhb < cfg.stale_lock_min * MIN) {', 'if (false) {'] },
  { id: 'M03', desc: 'stale 判定を pid の生死で行う（pid 再利用で永久ロック）', expect: 'lock: heartbeat が止まった',
    find: 'if (lockAge() < cfg.stale_lock_min * MIN) return false;', to: 'if (readJson(P.lock(), null)?.pid) return false;' },
  { id: 'M04', desc: '作成直後の空のロックを古いとみなす', expect: 'lock: 作成直後',
    find: 'try { return now - fs.statSync(P.lock()).mtimeMs; } catch { return 0; }', to: 'return Infinity;' },
  { id: 'M05', desc: "ロックの排他作成 'wx' を 'w' にする", expect: 'lock: 新しい heartbeat',
    find: "fs.openSync(P.lock(), 'wx')", to: "fs.openSync(P.lock(), 'w')" },
  { id: 'M06', desc: '過去の resets_at を信用する', expect: '過去の resets_at は信用せず',
    find: 'if (resetMs > now) return', to: 'if (resetMs > 0) return' },
  { id: 'M07', desc: '禁止引数の検査を外す', expect: 'argv: 禁止引数',
    find: 'for (const f of FORBIDDEN_ARGS) if (String(a).includes(f)) throw', to: 'for (const f of FORBIDDEN_ARGS) if (false) throw' },
  { id: 'M10', desc: 'review のエンジン固定を外す', expect: 'review は codex 以外を拒否',
    find: "if (kind === 'review' && engine !== 'codex')", to: 'if (false)' },
  { id: 'M11', desc: '不変条件: running 残存の検査を外す', expect: 'invariant: running',
    find: 'if (running.length > 0) errs.push', to: 'if (false) errs.push' },
  { id: "M12", desc: "不変条件: フォルダ数と読めたジョブ数の照合を外す", expect: "フォルダ数と読めたジョブ数",
    find: "  if (dirCount !== jobs.length) errs.push", to: "  if (false) errs.push" },
  { id: 'M13', desc: '5時間あたりの上限を外す', expect: 'cap: 直近5時間',
    find: 'cfg.caps.per_5h - recentAttempts(jobs, now)', to: 'Infinity' },
  { id: 'M14', desc: '1起動あたりの上限を外す', expect: 'cap: 1回の起動',
    find: 'Math.min(cfg.caps.per_run, ', to: 'Math.min(Infinity, ' },
  { id: 'M16', desc: '完了マーカーの最終行検査を「含まれていればよい」に緩める', expect: 'マーカーに触れても最終行でなければ',
    find: "if (last !== DONE_MARK) return '最終行が完了マーカーではない';", to: "if (!lines.some((l) => l.includes(DONE_MARK))) return '最終行が完了マーカーではない';" },
  { id: 'M17', desc: '完了マーカー検査を外す', expect: 'マーカーが無ければ hold',
    find: "if (last !== DONE_MARK) return '最終行が完了マーカーではない';", to: '' },
  { id: "M18", desc: "記述量の下限検査を外す", expect: "記述が短すぎれば hold",
    find: "if (body.length < cfg.min_report_chars) return", to: "if (false) return" },
  { id: 'M25', desc: 'allowed_roots 外を許可する', expect: 'allowed_roots 外は拒否',
    find: '  return `allowed_roots の外: ${cwd}`;', to: '  return null;' },
  { id: 'M26', desc: 'allowed_roots が空でも許可する', expect: 'allowed_roots が空なら拒否',
    find: 'if (!roots.length) return', to: 'if (false) return' },
  { id: 'M27', desc: 'UNC パスを許可する', expect: 'UNC パスは拒否',
    find: "if (/^(\\\\\\\\|\\/\\/)/.test(cwd)) return 'UNC パスは許可しない';", to: '' },
  { id: 'M28', desc: '壊れた job.json を隔離せず読み込む', expect: '壊れた job.json は隔離',
    find: 'if (validJob(j, id)) { jobs.push(j); continue; }', to: 'jobs.push(j); continue;' },
  { id: 'M29', desc: '読むだけの操作でも隔離する', expect: '読むだけの操作では隔離しない',
    find: 'function loadJobs({ quarantine = false } = {})', to: 'function loadJobs({ quarantine = true } = {})' },
  { id: 'M30', desc: '読取ジョブの drift 検査を外す', expect: 'drift: 積んだ後に HEAD',
    find: 'if (head !== job.origin.head) {', to: 'if (false) {' },
  { id: "M31", desc: "途中で止まった書き込みジョブ（過去データ）も pending に戻す", expect: "timeout を過ぎて止まった running",
    find: "if (j.access !== 'read-only') transition(j, 'hold'", to: "if (false) transition(j, 'hold'" },
  { id: "M32", desc: "まだ生きている可能性がある running も回収する", expect: "まだ生きている可能性がある",
    find: "{ alive.push(j0.id); continue; }", to: "{ }" },
  { id: 'M33', desc: '途中停止の回数上限を外す', expect: '途中停止が max_attempts 回',
    find: 'else if (failures >= cfg.max_attempts)', to: 'else if (false)' },
  { id: "M34", desc: "実行途中の例外を捕捉しない", expect: "実行途中の例外は running",
    find: "    try { saved = finishAsOwner(job, 'hold', { failure: { kind: 'internal'", to: "    throw e; try { saved = finishAsOwner(job, 'hold', { failure: { kind: 'internal'" },
  { id: 'M37', desc: 'limit_owner の3日打ち切りを外す', expect: 'limit_owner が3日を超えたら',
    find: "if (c.cls === 'limit_owner' && t - first >", to: 'if (false && t - first >' },
  { id: 'M38', desc: '停止中エンジンを無視する', expect: '停止中のエンジンのジョブは選ばれない',
    find: 'return b && Date.parse(b.blocked_until) > now;', to: 'return false;' },
  { id: 'M39', desc: '疎通確認のトークン照合を外す', expect: 'probe: トークン不一致',
    find: "return lines.length === 2 && lines[0] === job.probe_token && lines[1] === DONE_MARK ? null : 'probe_mismatch';", to: 'return null;' },
  { id: 'M40', desc: 'git push の禁止を外す', expect: 'git push は呼べない',
    find: "if (args[0] === 'push') throw", to: 'if (false) throw' },
  { id: 'M41', desc: '読取 claude で Bash を禁止しない', expect: '読取ジョブは read-only sandbox と Bash 禁止',
    find: "'--disallowedTools', 'Bash', ", to: "'--disallowedTools', " },
  { id: 'M42', desc: 'Codex の上限到達を検出しない', expect: '5時間枠リセットが未来なら',
    find: 'const limitHit = reached.length > 0 || errorInfo;', to: 'const limitHit = false;' },
  { id: 'M43', desc: 'Codex の判定に自由文の正規表現を戻す', expect: '読んだ内容に制限の語があるだけ',
    find: 'const limitHit = reached.length > 0 || errorInfo;', to: 'const limitHit = reached.length > 0 || errorInfo || /usage_limit_exceeded|usage limit/i.test(String(rollout));' },
  { id: "M44", desc: "rollout を今回の試行に絞らない（前回の制限記録を拾う）", expect: "rollout は今回の試行より前",
    find: "Date.parse(e.timestamp) >= since - 2000", to: "true" },
  { id: 'M45', desc: 'Claude の api_retry(rate_limit) を検出しない', expect: 'api_retry(rate_limit) は60分後',
    find: "const retryLimit = ev.some((e) => e.type === 'system' && e.subtype === 'api_retry' && /rate_limit/i.test(String(e.error || '')));", to: 'const retryLimit = false;' },
  { id: 'M46', desc: 'Claude の成功判定を制限判定の後に回す（回復した 429 を捨てる）', expect: '429 から回復して成功',
    find: "  if (exitCode === 0 && result && result.subtype === 'success' && !result.is_error) return { cls: 'ok', text: resultText, session_id: sid };\n  const retryLimit",
    to: "  const retryLimit" },
  { id: 'M47', desc: '実行予定が無くてもロックを取る', expect: '実行予定が無ければロックもログも作らない',
    find: "return { ran: 0, reason: 'nothing_due' };", to: '{}' },
  { id: "M48", desc: "プロンプトを argv にも渡す", expect: "プロンプトは argv に出ない",
    find: "    '-C', runCwd, '-o', path.join(attemptDir, 'last-message.txt'), '-'];", to: "    '-C', runCwd, '-o', path.join(attemptDir, 'last-message.txt'), '-', fs.readFileSync(path.join(P.job(job.id), 'prompt.txt'), 'utf8')];" },
  // ---- Codex クロスチェックの指摘に対する防御
  { id: 'N03', desc: 'claude の --tools 制限を外す', expect: '使えるツール自体を読取系に絞り',
    find: "      '--tools', CLAUDE_READ_TOOLS," + NL, to: '' },
  { id: 'N04', desc: 'claude の確認なし拒否を外す（default に戻す）', expect: '使えるツール自体を読取系に絞り',
    find: "'--permission-mode', 'dontAsk', '--permission-prompts', 'none',", to: "'--permission-mode', 'default'," },
  { id: "N05", desc: "codex にプラグインを読ませる", expect: "ユーザー設定とプラグインを読ませない",
    find: "    '-c', 'features.plugins=false', '-c', 'windows.sandbox=\"unelevated\"',", to: "    '-c', 'windows.sandbox=\"unelevated\"'," },
  { id: 'N10', desc: '週次枠を見ない（5時間枠だけ）', expect: '週次枠のリセットまで待つ',
    find: "for (const k of ['primary', 'secondary'])", to: "for (const k of ['primary'])" },
  { id: 'N11', desc: 'any を止まったエンジンの解除時刻に縛る', expect: '空いているエンジンへ振り替える',
    find: "next_attempt_at: job.engine === 'any' ? null : new Date(next).toISOString()", to: 'next_attempt_at: new Date(next).toISOString()' },
  { id: 'N12', desc: 'attempt 要素の検証を外す', expect: '中身が崩れたジョブは隔離',
    find: 'return j.attempts.every(', to: 'return true || j.attempts.every(' },
  { id: 'N13', desc: 'caps の型・範囲検証を外す', expect: '型・範囲が不正なら',
    find: 'if (!Number.isInteger(v) || v < 0 || v > 1000) throw', to: 'if (false) throw' },
  { id: 'N14', desc: '壊れた config を既定値で補う', expect: '型・範囲が不正なら',
    find: "try { c = JSON.parse(fs.readFileSync(P.config(), 'utf8')); } catch (e) { throw new ConfigError(", to: "try { c = JSON.parse(fs.readFileSync(P.config(), 'utf8')); } catch (e) { c = {}; if (0) throw new ConfigError(" },
  { id: 'N17', desc: 'heartbeat の所有権確認を外し、パスへ書く（退避後に新しい所有者のロックを上書き）', expect: '退避された後の heartbeat と解放',
    find: '  if (!ownsLock()) {' + NL + '    LOCK.lost = true;', to: '  if (false) {' + NL + '    LOCK.lost = true;',
    also: ['try { fs.ftruncateSync(LOCK.fd, 0); fs.writeSync(LOCK.fd, lockBody(LOCK.started), 0); }', 'try { fs.writeFileSync(P.lock(), lockBody(LOCK.started)); }'] },
  { id: 'N18', desc: '解放時の所有者トークン照合を外す', expect: '退避された後の heartbeat と解放',
    find: 'if (cur && cur.token === mine)', to: 'if (true)' },
  { id: 'N19', desc: '疎通確認の行数照合を外す', expect: '余分な行があれば failed',
    find: "return lines.length === 2 && lines[0] === job.probe_token && lines[1] === DONE_MARK ? null : 'probe_mismatch';",
    to: "return last === DONE_MARK && lines.includes(job.probe_token) ? null : 'probe_mismatch';" },
  { id: 'N20', desc: 'doctor が choices の中を見ない', expect: 'choices の中にあるかで判定',
    find: 'for (const [flag, value] of HELP_CHOICES[engine]) if (', to: 'for (const [flag, value] of []) if (' },
  { id: 'N23', desc: 'codex の Windows sandbox 方式を明示しない', expect: 'unelevated を明示する',
    find: ", '-c', 'windows.sandbox=\"unelevated\"',", to: ',' },
  // ---- 2回目のクロスチェックとローカルレビューの指摘に対する防御
  { id: "O01", desc: "claude に対象 repo の project/local 設定を読ませる", expect: "ユーザー設定だけを読む",
    find: "      '--setting-sources', 'user', '--safe-mode',\n", to: "      '--safe-mode',\n" },
  { id: 'P01', desc: 'claude に --safe-mode を付けない（hook・プラグイン・MCP を読ませる）', expect: '--safe-mode で hook・プラグイン・MCP などの上乗せを読まない',
    find: "'--setting-sources', 'user', '--safe-mode',", to: "'--setting-sources', 'user'," },
  { id: 'P02', desc: 'doctor が --safe-mode でも効く認証の補助を報告しない', expect: '--safe-mode でも効く設定を、値を出さずに報告する',
    find: "const SAFE_MODE_RESIDUE_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'env'];", to: "const SAFE_MODE_RESIDUE_KEYS = [];" },
  { id: 'P03', desc: 'doctor が管理者の設定の hook を報告しない', expect: '--safe-mode でも効く設定を、値を出さずに報告する',
    find: '  if (h) notes.push(', to: '  if (false) notes.push(' },
  { id: 'P04', desc: '実行ファイルを専用の環境変数で差し替えられる', expect: '実行ファイルを専用の環境変数で差し替えられない',
    find: '  let bin = engineBins[engine];', to: "  let bin = engineBins[engine] || (engine === 'claude' ? process.env.UT_DEFER_CLAUDE_BIN : process.env.UT_DEFER_CODEX_BIN);" },
  { id: 'P05', desc: 'エンジンの子プロセスへ環境を丸ごと渡す', expect: '子プロセスへ NODE_OPTIONS・プロキシ・API の送り先を渡さない',
    find: 'export function engineEnv(env = process.env) { return Object.fromEntries(Object.entries(env).filter(([k]) => !ENGINE_ENV_DENY.test(k))); }', to: 'export function engineEnv(env = process.env) { return { ...env }; }' },
  { id: 'P20', desc: '壊れた設定ファイルを「無い」と同じに扱う', expect: '設定ファイルを読めないときは「無い」と区別する',
    find: "  try { return { state: 'ok', value: JSON.parse(raw) }; } catch { return { state: 'invalid', value: null }; }", to: "  try { return { state: 'ok', value: JSON.parse(raw) }; } catch { return { state: 'missing', value: null }; }" },
  { id: 'P21', desc: 'doctor が注意を出しても「問題なし」と締める', expect: '注意があれば「問題なし」と締めない',
    find: "  return lines.some((l) => /^\\s*注意 /.test(l)) ? 'doctor: 注意あり（上の注意を確かめる。実物 CLI との照合は問題なし）' : 'doctor: 問題なし';", to: "  return 'doctor: 問題なし';" },
  { id: 'P22', desc: 'PATH の相対パスの場所も探す', expect: '作業フォルダ・相対パスの場所の同名の実行ファイルを起動しない',
    find: '    if (!d || !path.isAbsolute(d)) continue;', to: '    if (!d) continue;' },
  { id: 'P23', desc: '見つからなければ名前のままで起動する', expect: '作業フォルダ・相対パスの場所の同名の実行ファイルを起動しない',
    find: '  if (!bin) bin = resolveOnPath(engine);', to: '  if (!bin) bin = resolveOnPath(engine) || engine;' },
  // APPDATA の絶対パスの検査と、最後の「実行ファイルが絶対パスか」の確認は二重の防御で、片方だけを外しても差が出ない。両方を外す
  { id: 'P24', desc: 'APPDATA が相対パスでも、その下の codex.js を使う（最後の絶対パスの確認も外す）', expect: 'APPDATA が相対パスなら、その下の codex.js を選ばない',
    find: "    const js = appdata && path.isAbsolute(appdata) ? path.join(appdata,", to: "    const js = true ? path.join(appdata || '',",
    also: ["  if (!path.isAbsolute(bin)) throw new Error(`実行ファイルが絶対パスでない: ${bin}`);", ''] },
  { id: 'P25', desc: 'git の fsmonitor を止めない', expect: '対象リポジトリの設定（fsmonitor・textconv）から外部コマンドを起動しない',
    find: "export const GIT_GUARD = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c',", to: "export const GIT_GUARD = ['--no-optional-locks', '-c'," },
  { id: 'P26', desc: '差分の取得で textconv を止めない', expect: '対象リポジトリの設定（fsmonitor・textconv）から外部コマンドを起動しない',
    find: "'--binary', '--no-ext-diff', '--no-textconv'],", to: "'--binary', '--no-ext-diff']," },
  // --no-optional-locks と core.hooksPath は二重の防御で、片方だけを外しても差が出ない。両方を外す
  { id: 'P27', desc: 'git の hook を止めない（索引の書き戻しと hooksPath の上書きの両方を外す）', expect: '対象リポジトリの hook（core.hooksPath）を起動しない',
    find: "export const GIT_GUARD = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];", to: "export const GIT_GUARD = ['-c', 'core.fsmonitor=false'];" },
  { id: 'P28', desc: 'taskkill を相対パスの場所からも選ぶ', expect: 'taskkill を作業フォルダ・相対パスの場所から選ばない',
    find: "  const q = sr && path.isAbsolute(sr) ? path.join(sr, 'System32', 'taskkill.exe') : null;", to: "  const q = sr ? path.join(sr, 'System32', 'taskkill.exe') : null;" },
  { id: 'P29', desc: '結果の保存の失敗の差し込みを環境変数でも効かせる', expect: '試験用の差し込みは環境変数では効かない',
    find: '  if (testHooks.failFinish) throw new Error(', to: '  if (testHooks.failFinish || process.env.UT_DEFER_FAIL_FINISH) throw new Error(' },
  { id: "O02", desc: "codex に実行ポリシーの .rules を読ませる", expect: ".rules を読ませない",
    find: "'--ignore-user-config', '--ignore-rules',\n    '-c'", to: "'--ignore-user-config',\n    '-c'" },
  { id: "O03", desc: "ジョブ単位のロックを排他作成しない", expect: "別プロセスの cancel は待たされて",
    find: "      const fd = fs.openSync(lf, 'wx');", to: "      const fd = fs.openSync(lf, 'w');" },
  { id: "O04", desc: "実行直前の読み直し（CAS）を外す", expect: "選んだ後に cancel",
    find: "      if (!validJob(disk, job0.id) || disk.state !== 'pending' || disk.attempts.length !== job0.attempts.length) return null;", to: "" },
  { id: "O05", desc: "結果の保存で所有者を照合しない", expect: "ジョブの所有者でなければ結果を書かない",
    find: "if (!validJob(disk, job.id) || disk.state !== 'running' || !LOCK || disk.owner !== LOCK.token || !ownsLock()) {", to: "if (!validJob(disk, job.id)) {" },
  { id: "O06", desc: "ロックを失っても子プロセスを止めない", expect: "所有権を失ったら",
    find: "    if (CURRENT_CHILD) killTree(CURRENT_CHILD);\n", to: "" },
  { id: "O08", desc: "同じ起動の中で止まったエンジンを見直さない", expect: "同じ起動の中で制限に当たった",
    find: "        const engine = pickEngine(job, engines, Date.now());", to: "        const engine = pickEngine(job, {}, Date.now());" },
  { id: "O09", desc: "--timeout-min の検証を外す", expect: "--timeout-min の型と範囲",
    find: "  if (!checkTimeoutMin(job.timeout_min)) throw", to: "  if (false) throw" },
  { id: "O10", desc: "caps の型不正を既定値で隠す", expect: "caps が null",
    find: "if (c.caps !== undefined && (c.caps === null || typeof c.caps !== 'object' || Array.isArray(c.caps))) throw", to: "if (false) throw" },
  { id: "O11", desc: "件数×時間がスケジューラの上限を超えても止めない", expect: "スケジューラの上限を超える",
    find: "  if (cfg.caps.per_run * cfg.timeout_min > MAX_TIMEOUT_MIN) throw", to: "  if (false) throw" },
  { id: "O12", desc: "キューの読み取りエラーを0件扱いにする", expect: "キューを読めない",
    find: "    if (e.code === 'ENOENT') return [];\n", to: "    return [];\n" },
  { id: "O13", desc: "list で読めないジョブを表示しない", expect: "読めないジョブも件数と一緒",
    find: "  for (const id of skipped) lines.push(", to: "  for (const id of []) lines.push(" },
  { id: "O14", desc: "drift のジョブを --accept-head なしで retry できる", expect: "--accept-head で新しい HEAD",
    find: "    if (drift && !acceptHead) throw", to: "    if (false) throw" },
  { id: "O15", desc: "エンジンを起動しなかった試行も件数上限に数える", expect: "--accept-head で新しい HEAD",
    find: "{ class: kind, skipped: true }", to: "{ class: kind }" },
  { id: "O16", desc: "--accept-head で基準の HEAD を更新しない", expect: "--accept-head で新しい HEAD",
    find: "      j.origin.head = head;\n", to: "" },
  { id: "O21", desc: "制限の回数を retry より前の試行も含めて数える", expect: "retry より後の試行だけで数える",
    find: "  const since = job.retry_at ? Date.parse(job.retry_at) : 0;", to: "  const since = 0;" },
  { id: "O22", desc: "--remove-root を文字列の完全一致で比べる", expect: "--remove-root は表記",
    find: "      const kept = c.allowed_roots.filter((r) => norm(r) !== target);", to: "      const kept = c.allowed_roots.filter((r) => r !== o.removeRoot);" },
  { id: "O24", desc: "show の出力全体をマスクしない", expect: "ユーザーのパスもマスク",
    find: "  return maskText(out.join('\\n')).text;", to: "  return out.join('\\n');" },
  { id: "O25", desc: "doctor が引数の説明ブロックの外まで choices を探す", expect: "隣の引数の choices",
    find: "  const block = next ? rest.slice(0, next.index) : rest;", to: "  const block = rest;" },
  // ---- 再レビュー（Claude・Codex・SonarQube）の指摘に対する防御
  { id: "P06", desc: "ロックを失った実行を正常終了として報告する", expect: "所有権を失ったら",
    find: "        if (res === 'lock_lost') return { ran: ran.length, ids: ran, lost: job.id, reason: 'lock_lost', exitCode: 3 };", to: "" },
  { id: "P07", desc: "ロックの所有者トークンを照合しない", expect: "所有権を失ったら",
    find: "    if (cur) return cur.token === LOCK.token;", to: "    if (cur) return true;" },
  { id: "P08", desc: "1回の起動の時間予算を見ない", expect: "上限時間の合計を",
    find: "        if (reservedMin + job.timeout_min > MAX_TIMEOUT_MIN) {", to: "        if (false) {" },
  { id: "P10", desc: "ジョブ単位のロックを時間だけで横取りする", expect: "古く見えても横取りしない",
    find: "      const stale = age > JOB_LOCK_MAX_MS || (age > JOB_LOCK_STALE_MS && !pidAlive(holder && holder.pid));", to: "      const stale = age > JOB_LOCK_STALE_MS;" },
  { id: "P11", desc: "ジョブ単位のロックの解放で所有者を照合しない", expect: "自分のロックだけを消す",
    find: "    if (cur && cur.token === token) { try { fs.unlinkSync(lf); } catch { /* */ } }", to: "    try { fs.unlinkSync(lf); } catch { /* */ }" },
  { id: "P12", desc: "途中停止の回数を retry 前や起動しなかった試行まで含めて数える", expect: "retry より後の、実際に起動した試行",
    find: "      const failures = attemptsSinceRetry(j).filter((a) => !a.skipped && a.class === 'orphaned').length;", to: "      const failures = j.attempts.filter((a) => !['limit_time', 'limit_owner', 'ok'].includes(a.class)).length;" },
  { id: "P13", desc: "画面の出力をマスクしない", expect: "画面に出す内容はマスク",
    find: "const out = (x) => console.log(maskText(String(x)).text);", to: "const out = (x) => console.log(String(x));" },
  { id: "P14", desc: "壊れた config.json を検証せずに上書きする", expect: "壊れた config.json を --add-root",
    find: "    loadConfig();\n    const c = readJson(P.config(), {});", to: "    const c = readJson(P.config(), {});" },
  { id: "P15", desc: "持ち主のプロセスの生死を見ない（常に生きている扱い）", expect: "持ち主のプロセスが居なければ",
    find: "  try { process.kill(pid, 0); return true; }", to: "  return true; try { process.kill(pid, 0); return true; }" },
  // ---- v1（読み取りジョブだけ）の防御
  { id: "W01", desc: "書き込みジョブを積めるようにする", expect: "書き込みジョブは積めず",
    find: "  if (access === 'write') throw new Error('v1 は読み取りジョブだけを扱う", to: "  if (false) throw new Error('v1 は読み取りジョブだけを扱う" },
  { id: "W02", desc: "書き込みジョブの引数を組み立てる", expect: "引数も組み立てない",
    find: "  if (job.access !== 'read-only') throw new Error('v1 は読み取りジョブだけを扱う（書き込みジョブは v2 で設計し直す）');", to: "" },
  { id: "W03", desc: "過去の書き込みジョブを hold にしない", expect: "過去に積まれた書き込みジョブは実行せず",
    find: "            if (!validJob(j, j0.id) || j.state !== 'pending' || j.access === 'read-only') return;", to: "            return;" },
  { id: "W04", desc: "codex を書き込み可能な sandbox で起動する", expect: "常に read-only",
    find: "    '--sandbox', 'read-only',\n    '-C'", to: "    '--sandbox', 'workspace-write',\n    '-C'" },
  { id: "W05", desc: "drift 検査を access に依存させる（読み取りジョブで効かなくなる）", expect: "drift: 積んだ後に HEAD",
    find: "  if (job.origin.is_git) {\n    let head", to: "  if (job.origin.is_git && job.access === 'write') {\n    let head" },
  { id: "W06", desc: "始める前の所有権喪失を lock_lost として返さない", expect: "始める前にロックの所有権を失っていたら",
    find: "    if (!ownsLock()) { log(`${job0.id} を始める前にロックの所有権を失った`); return 'lock_lost'; }", to: "" },
  { id: "W07", desc: "回収時のロック待ちを例外で落とす", expect: "回収しようとしたジョブが人の操作で使用中",
    find: "      if (!(e instanceof JobBusyError)) throw e;", to: "      throw e;" },
  { id: "W08", desc: "エンジンの停止記録の中身を検証しない", expect: "停止記録が壊れていたら",
    find: "    if (!['codex', 'claude'].includes(k) || !v || typeof v !== 'object' || !isIso(v.blocked_until)) throw", to: "    if (false) throw" },
  { id: "W09", desc: "壊れたエンジンの停止記録を空として扱う", expect: "停止記録が壊れていたら",
    find: "  try { e = JSON.parse(fs.readFileSync(P.engines(), 'utf8')); } catch (err) { throw new ConfigError(", to: "  try { e = JSON.parse(fs.readFileSync(P.engines(), 'utf8')); } catch (err) { e = {}; if (0) throw new ConfigError(" },
  { id: "W10", desc: "過去の書き込みジョブを retry できる", expect: "過去に積まれた書き込みジョブは実行せず",
    find: "    if (j.access !== 'read-only') throw new Error('v1 は読み取りジョブだけを扱うため、書き込みジョブは retry できない", to: "    if (false) throw new Error('v1 は読み取りジョブだけを扱うため、書き込みジョブは retry できない" },
  { id: "W11", desc: "結果が未確定のとき最後の試行の報告を探さない", expect: "完了の証拠が無く hold",
    find: "  const relRep = (j.result && j.result.report) || (last ? `attempts/${last.n}/report.md` : 'report.md');", to: "  const relRep = (j.result && j.result.report) || 'report.md';" },
  { id: "W12", desc: "報告の場所を OS の区切り文字で保存する", expect: "/ 区切りで保存",
    find: "path.posix.join('attempts', String(n), 'report.md')", to: "path.join('attempts', String(n), 'report.md')" },
  { id: "W13", desc: "list でエンジンの停止記録を検証しない", expect: "停止記録が壊れていたら、実行可と表示しない",
    find: "  try { engines = loadEngines(); } catch (e) { enginesError = e.message; }", to: "  engines = readJson(P.engines(), {});" },
  // ---- Codex レビュー（2026-09-30、Plan A と v1 コード）の指摘に対する防御
  { id: "U01", desc: "codex の web 検索を切らない", expect: "codex は web 検索を切る",
    find: ", '-c', 'web_search=\"disabled\"',", to: "," },
  { id: "U02", desc: "孤児の回収で所有権を確かめない", expect: "孤児の回収中に所有権を失ったら",
    find: "      assertOwner('孤児の回収');", to: "" },
  { id: "U03", desc: "旧ジョブの移行で所有権を確かめない", expect: "旧ジョブの移行中に所有権を失ったら",
    find: "            assertOwner('旧ジョブの移行');", to: "" },
  { id: "U04", desc: "子プロセスが生きていても回収する", expect: "子プロセスが生きていれば",
    find: "    if (childStillAlive(j0, now)) {", to: "    if (false) {" },
  { id: "U05", desc: "結果を保存できなくても正常終了にする", expect: "結果を保存できなければ",
    find: "      throw new FinishError(", to: "      void (" },
  { id: "U06", desc: "報告のパスを「..」だけで判定する（別ドライブ・絶対パスを通す）", expect: "別ドライブ・絶対パスを指す報告は読まない",
    find: "if (path.isAbsolute(relRep) || /^[A-Za-z]:/.test(relRep) || rel.startsWith('..') || path.isAbsolute(rel))", to: "if (rel.startsWith('..'))" },
  { id: "U07", desc: "廃止したオプションを専用の理由で拒否しない", expect: "サブコマンドで使えないオプション・廃止したオプションは拒否",
    find: "    if (RETIRED[g]) throw new Error(RETIRED[g]);", to: "" },
  { id: "U08", desc: "サブコマンドで使えないオプションを拒否しない", expect: "サブコマンドで使えないオプション・廃止したオプションは拒否",
    find: "    if (!(ALLOWED_OPTS[cmd] || []).includes(g)) throw", to: "    if (false) throw" },
  { id: "U09", desc: "実行中の作業ツリーの変化を記録しない", expect: "実行中に作業ツリーが変わったら報告に残す",
    find: "  if (treeBefore && treeAfter && treeBefore !== treeAfter) job.notes.push(", to: "  if (false) job.notes.push(" },
  { id: "U10", desc: "実行時に子プロセスの pid を記録しない", expect: "実行中に作業ツリーが変わったら報告に残す",
    find: "      try { writeJson(path.join(attemptDir, 'child.json'), { pid: child.pid, at: new Date().toISOString() }); }", to: "      try { }" },
];

// 変異の ID が重なると、部分実行（UT_SWEEP_ONLY）で両方が流れ、内訳の行も区別できない。重なっていたら何もせずに止める
{ const ids = mutations.map((m) => m.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }

function runSelftest(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, '--selftest'], { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const names = (out.match(/^  NG  .*$/gm) || []).map((x) => x.replace(/^  NG  /, '').split(' | ')[0]);
      const total = Number((/selftest: (\d+) 件中/.exec(out) || [])[1] || 0);
      resolve({ out, code, names, total });
    });
  });
}

async function runMutant(m) {
  const hits = SRC.split(m.find).length - 1;
  if (hits !== 1) return { ...m, verdict: 'INVALID', detail: 'アンカー一致 ' + hits + ' 件' };
  const f = path.join(tmp, m.id + '.mjs');
  let src = SRC.replace(m.find, m.to);
  if (m.also) {
    if (src.split(m.also[0]).length - 1 !== 1) return { ...m, verdict: 'INVALID', detail: '追加アンカー不一致' };
    src = src.replace(m.also[0], m.also[1]);
  }
  fs.writeFileSync(f, src);
  const r = await runSelftest(f);
  if (r.names.length === 0 && r.code !== 0) {
    return { ...m, verdict: 'CRASHED', detail: '異常終了(exit=' + r.code + ') ' + r.out.split(NL).filter(Boolean).slice(-2).join(' / ') };
  }
  const hit = r.names.some((n) => n.includes(m.expect));
  // 期待したテストで落ちず、別のテストだけが落ちた場合は、その防御を検証できたことにならない
  const verdict = hit ? 'CAUGHT' : r.names.length ? 'OTHER' : 'MISSED';
  return { ...m, verdict, detail: 'NG ' + r.names.length + ' 件', ngNames: r.names };
}

// UT_SWEEP_CHECK_ANCHORS=1: selftest を流さず、差し込み位置が1件だけ一致するかだけを確かめる（コードを変えたあとの下調べ用）
if (process.env.UT_SWEEP_CHECK_ANCHORS) {
  const bad = mutations.filter((m) => SRC.split(m.find).length - 1 !== 1 || (m.also && SRC.split(m.also[0]).length - 1 !== 1));
  for (const m of bad) console.log('  INVALID ' + m.id + ' ' + m.desc + ' (一致 ' + (SRC.split(m.find).length - 1) + ' 件)');
  console.log('差し込み位置の確認: ' + (mutations.length - bad.length) + ' / ' + mutations.length + ' 件が有効');
  process.exit(bad.length ? 1 : 0);
}
// 基準実行: 変異前の selftest が全件パスしていなければ、どの変異の結果も意味を持たない
const base = await runSelftest(SRC_PATH);
if (base.code !== 0 || base.names.length) {
  console.log('基準実行（変異なし）の selftest が失敗しているため掃引しない: ' + (base.names.join(' / ') || 'exit=' + base.code));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  process.exit(1);
}
console.log('基準実行: selftest ' + base.total + ' 件全件パス');

// 各変異は独立した一時ディレクトリで selftest を回すので並列に走らせてよい
// UT_SWEEP_ONLY=M01,O19 のように指定すると、その変異だけを流す（全件の結果ではないことを出力に明記する）
const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',').map((x) => x.trim())) : null;
if (only) console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
if (only) {
  const unknown = [...only].filter((id) => !mutations.some((m) => m.id === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
}
const rows = [];
const queue = mutations.filter((m) => !only || only.has(m.id));
const workers = Array.from({ length: Math.min(6, os.cpus().length) }, async () => {
  while (queue.length) { const m = queue.shift(); rows.push(await runMutant(m)); }
});
await Promise.all(workers);
rows.sort((a, b) => a.id.localeCompare(b.id));

console.log('== ut-defer ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(5) + r.verdict.padEnd(8) + r.desc + '  -> ' + r.detail);
  for (const n of (r.ngNames || [])) console.log('          落ちた: ' + n + (n.includes(r.expect) ? '  ← 期待' : ''));
}
const by = (v) => rows.filter((r) => r.verdict === v);
console.log(NL + '検出 ' + by('CAUGHT').length + ' / ' + rows.length + '   未検出 ' + by('MISSED').length + '   別理由で検出 ' + by('OTHER').length +
  '   異常終了 ' + by('CRASHED').length + '   設計不正 ' + by('INVALID').length);
for (const v of ['MISSED', 'OTHER', 'CRASHED', 'INVALID']) {
  if (by(v).length) console.log(v + ': ' + by(v).map((r) => r.id + ' ' + r.desc + (v === 'OTHER' ? '（期待: ' + r.expect + '）' : ' ' + r.detail)).join(' / '));
}
// 掃引できていない防御（決定的に再現できないため変異を置いていない）
console.log('対象外: git の --no-optional-locks だけ、または core.hooksPath の上書きだけを外す変異（もう片方が hook を止めるため差が出ない。両方を外す変異は P27）');
console.log('対象外: Codex の APPDATA の絶対パスの検査だけ、または最後の「実行ファイルが絶対パスか」の確認だけを外す変異（もう片方が同じものを止めるため差が出ない。両方を外す変異は P24）');
console.log('対象外（2重の防御の片方だけを外す変異。確認と書き込みの間に別 runner が割り込む競合でしか差が出ず、再現が非決定的）:');
console.log('  - stale ロックの退避後の再確認だけを外す（年齢判定が先に効く）');
console.log('  - heartbeat の fd への書き込みだけをパスへの書き込みに変える（所有権の確認が先に効く）');
console.log('  - 実行後の「所有権を失ったら結果を反映しない」確認だけを外す（結果保存時の所有者照合が先に効く）');
console.log('  - ジョブ単位のロックを退避したあと、作り直されたロックを戻すかの判定（判定から退避までの間に別の待機者が割り込む競合でしか差が出ない）');
console.log('  - 生きている持ち主のロックを上書きしない方法（link）で戻し、戻せなければ取得をあきらめる判定（同上の競合でしか差が出ない）');
console.log('  - 実行ループの冒頭での所有権の確認（直前のジョブの終了時にも確認しているため、その間に失う競合でしか差が出ない）');
console.log('  - 結果の保存を所有権の照合で拒否された（false）場合の lock_lost（直後の所有権の確認が同じ結果を返すため差が出ない）');
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(by('CAUGHT').length === rows.length ? 0 : 1);
