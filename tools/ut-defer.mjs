#!/usr/bin/env node
// ut-defer: 利用制限で今は実行できない Claude / Codex のジョブを積み、制限が解けたら無人で実行する。
// v1 は読み取りジョブだけを扱う（ファイルを変更するジョブは v2 で設計し直す）。
//
//   node tools/ut-defer.mjs add --engine codex|claude|any [--kind task|review|selftest-probe]
//                               [--cwd <dir>] (--prompt <text> | --prompt-file <file> | --prompt -) [--timeout-min N] [--drift hold|warn]
//   node tools/ut-defer.mjs list | show <id> | cancel <id> | retry <id> [--accept-head]
//   node tools/ut-defer.mjs review [<id>]      # 結果を表示して確認済みにする
//   node tools/ut-defer.mjs config [--add-root <dir>] [--remove-root <dir>]
//   node tools/ut-defer.mjs doctor       # 実物 CLI が使う引数を受け付けるか
//   node tools/ut-defer.mjs run          # タスクスケジューラから定期起動する
//   node tools/ut-defer.mjs --selftest
//
// 実行可否は「試して、失敗を分類する」で決める。リセット時刻は次回試行の時刻を決めるためだけに使う。
// exit: 0 正常 / 1 入力・操作エラー / 3 キュー全体の不整合（何も実行しない）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
import { maskText } from './mask.mjs';

const STATES = ['pending', 'running', 'done', 'failed', 'hold'];
const KINDS = ['task', 'review', 'selftest-probe'];
const ENGINES = ['codex', 'claude', 'any'];
const ACCESS = ['read-only', 'write'];
const DONE_MARK = 'UT_DEFER_DONE';
const FORBIDDEN_ARGS = ['--dangerously-skip-permissions', '--yolo', 'danger-full-access', 'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox'];
const MIN = 60 * 1000;
// タスクスケジューラの実行時間の上限（2時間）より短くする。超えると runner ごと強制終了され、ジョブが孤児になる
const MAX_TIMEOUT_MIN = 110;
const HOUR = 60 * MIN;
const DEFAULTS = {
  allowed_roots: [],
  caps: { per_run: 1, per_5h: 4 },
  timeout_min: 30,
  min_report_chars: 200,
  limit_owner_probe_min: 60,
  max_probe_days: 3,
  max_limit_time_retries: 10,
  max_attempts: 6,
  stale_lock_min: 10,
};

// ---------------------------------------------------------------- パス・入出力

const home = () => process.env.USERPROFILE || process.env.HOME || os.homedir();
const qdir = () => process.env.UT_DEFER_DIR || path.join(home(), '.claude', 'work', 'defer');
const P = {
  config: () => path.join(qdir(), 'config.json'),
  engines: () => path.join(qdir(), 'engines.json'),
  lock: () => path.join(qdir(), 'runner.lock'),
  log: () => path.join(qdir(), 'runner.log'),
  jobs: () => path.join(qdir(), 'jobs'),
  quarantine: () => path.join(qdir(), 'jobs', '_quarantine'),
  job: (id) => path.join(qdir(), 'jobs', id),
};

// Windows では作成直後のファイル・ディレクトリをウイルス対策やインデクサが掴み、rename が EPERM/EBUSY で落ちることがある
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) throw e;
      sleepMs(25 * (i + 1));
    }
  }
}
function writeAtomic(dest, data) {
  // add と run が同時に書いても一時ファイルが衝突しないよう、pid と乱数を名前に入れる
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  renameRetry(tmp, dest);
}
const writeJson = (f, o) => writeAtomic(f, JSON.stringify(o, null, 2) + '\n');
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function log(msg) {
  try {
    fs.mkdirSync(qdir(), { recursive: true });
    fs.appendFileSync(P.log(), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ログ失敗で本処理を止めない */ }
}
// 設定の型・範囲の誤りは「0件のまま正常終了」になる（例: per_run が文字列だと slice(0, NaN) で何も選ばれない）。
// 壊れた設定は既定値で黙って補わず、明示的に止める
export class ConfigError extends Error {}
// stale_lock_min の下限は heartbeat 間隔（1分）の数倍にする。同じ値だと、生きている runner の処理の遅れだけでロックが奪われる
const NUM_KEYS = { timeout_min: [0.01, MAX_TIMEOUT_MIN], min_report_chars: [0, 100000], limit_owner_probe_min: [1, 24 * 60], max_probe_days: [0, 60],
  max_limit_time_retries: [0, 1000], max_attempts: [1, 100], stale_lock_min: [5, 24 * 60] };
export function checkTimeoutMin(v) {
  const [lo, hi] = NUM_KEYS.timeout_min;
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}
function loadConfig() {
  let c = {};
  if (fs.existsSync(P.config())) {
    try { c = JSON.parse(fs.readFileSync(P.config(), 'utf8')); } catch (e) { throw new ConfigError(`config.json を解析できない: ${e.message}`); }
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ConfigError('config.json がオブジェクトではない');
  }
  // caps は「無い」ときだけ既定値。null・配列・数値などの型不正は既定値で隠さない
  if (c.caps !== undefined && (c.caps === null || typeof c.caps !== 'object' || Array.isArray(c.caps))) throw new ConfigError(`caps はオブジェクト: ${JSON.stringify(c.caps)}`);
  const cfg = { ...DEFAULTS, ...c, caps: { ...DEFAULTS.caps, ...(c.caps || {}) },
    allowed_roots: c.allowed_roots === undefined ? [] : c.allowed_roots };
  if (!Array.isArray(cfg.allowed_roots) || cfg.allowed_roots.some((r) => typeof r !== 'string')) throw new ConfigError('allowed_roots は文字列の配列');
  for (const k of ['per_run', 'per_5h']) {
    const v = cfg.caps[k];
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw new ConfigError(`caps.${k} は 0〜1000 の整数: ${JSON.stringify(v)}`);
  }
  for (const [k, [lo, hi]] of Object.entries(NUM_KEYS)) {
    const v = cfg[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new ConfigError(`${k} は ${lo}〜${hi} の数値: ${JSON.stringify(v)}`);
  }
  // 1回の起動で流す件数 × 1件の上限時間が、スケジューラの実行時間の上限を超えないこと
  if (cfg.caps.per_run * cfg.timeout_min > MAX_TIMEOUT_MIN) throw new ConfigError(`caps.per_run × timeout_min が ${MAX_TIMEOUT_MIN} 分を超える（スケジューラの実行上限 2時間に収まらない）`);
  return cfg;
}
function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = now;
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

// ---------------------------------------------------------------- git

// git も名前のままで起動しない（作業フォルダの同名の実行ファイルを拾わないため）。対象リポジトリの設定を通じた外部コマンドの起動
// （core.fsmonitor）も止める。差分の取得では外部の差分ツールと textconv も止める（treeFingerprint）。2026-10-01 に実機で、
// これらを付けない git status / diff は仕掛けたコマンドを起動し、付けると起動しないことを確認
let GIT_BIN;
function gitBin() {
  if (GIT_BIN === undefined) GIT_BIN = resolveOnPath('git');
  if (!GIT_BIN) throw new Error('git が PATH の絶対パスの場所に見つからない（作業フォルダと相対パスの場所は探さない）');
  return GIT_BIN;
}
// --no-optional-locks: status などが索引を書き戻さない（書き戻しのときに post-index-change の hook が起動されるため）。
// core.hooksPath を hook を置けない場所に向け、どの hook も起動させない（2026-10-01 に実機で、どちらも単独で止めることを確認）
export const GIT_GUARD = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];
function git(args, cwd, opts = {}) {
  if (args[0] === 'push') throw new Error('ut-defer は push しない');
  return execFileSync(gitBin(), [...GIT_GUARD, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
// 作業ツリーの指紋（HEAD・追跡ファイルの差分・未追跡ファイルの中身）。レビューは「実行した時点の作業ツリー」を対象にする契約のため、
// 実行の前後で比べて、途中で変わった（依頼時・実行開始時とは違う内容を読んだ可能性がある）ことを報告に残す
export function treeFingerprint(cwd) {
  try {
    const h = crypto.createHash('sha256');
    h.update(git(['rev-parse', 'HEAD'], cwd));
    h.update(execFileSync(gitBin(), [...GIT_GUARD, '-C', cwd, 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
    for (const f of git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean).sort()) {
      h.update('\0' + f + '\0');
      try { const st = fs.statSync(path.join(cwd, f)); h.update(st.size <= 5 * 1024 * 1024 ? fs.readFileSync(path.join(cwd, f)) : `${st.size}:${st.mtimeMs}`); } catch { h.update('?'); }
    }
    return h.digest('hex').slice(0, 16);
  } catch { return null; }
}
function gitInfo(cwd) {
  try {
    const top = git(['rev-parse', '--show-toplevel'], cwd);
    return {
      is_git: true, top,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      head: git(['rev-parse', 'HEAD'], cwd),
      dirty: git(['status', '--porcelain'], cwd) !== '',
    };
  } catch { return { is_git: false }; }
}

// ---------------------------------------------------------------- 検証（add 時）

function canon(p) { return fs.realpathSync.native(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
export function checkCwdAllowed(cwd, roots) {
  if (/^(\\\\|\/\/)/.test(cwd)) return 'UNC パスは許可しない';
  if (!fs.existsSync(cwd)) return `作業ディレクトリが存在しない: ${cwd}`;
  if (!roots.length) return 'allowed_roots が空（`config --add-root <dir>` で許可するルートを登録する）';
  const c = canon(cwd);
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const rc = canon(r);
    if (c === rc || c.startsWith(rc + '/')) return null;
  }
  return `allowed_roots の外: ${cwd}`;
}
export function assertSafeArgv(argv) {
  for (const a of argv) {
    for (const f of FORBIDDEN_ARGS) if (String(a).includes(f)) throw new Error(`禁止引数を検出したため起動しない: ${f}`);
  }
}

// ---------------------------------------------------------------- ジョブの読み書き

// キューが「まだ無い」ときだけを空として扱う。アクセス拒否や I/O エラーを 0件にすると、
// 実行予定のジョブがあるのに「何もすることがない」と正常終了してしまう
export class QueueReadError extends Error {}
function listJobIds() {
  let ents;
  try { ents = fs.readdirSync(P.jobs(), { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new QueueReadError(`キューを読めない: ${e.code || e.message}`);
  }
  return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')).map((d) => d.name).sort();
}
function countQuarantine() {
  try { return fs.readdirSync(P.quarantine()).length; } catch { return 0; }
}
// JSON として正しくても中身が崩れていれば、後段（日付比較・並べ替え）で例外になり runner 全体が毎回落ちる。入れ子まで検査する
const isIso = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));
function validJob(j, id) {
  if (!j || typeof j !== 'object' || j.schema !== 1 || j.id !== id) return false;
  if (!STATES.includes(j.state) || !ENGINES.includes(j.engine) || !ACCESS.includes(j.access) || !KINDS.includes(j.kind)) return false;
  if (!isIso(j.created_at) || !(j.next_attempt_at === null || isIso(j.next_attempt_at))) return false;
  const o = j.origin;
  if (!o || typeof o !== 'object' || typeof o.cwd !== 'string') return false;
  if (o.is_git && (typeof o.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(o.head))) return false;
  if (j.access === 'write' && !o.is_git) return false;
  if (!checkTimeoutMin(j.timeout_min)) return false;
  if (!Array.isArray(j.attempts) || !Array.isArray(j.notes)) return false;
  if (j.state === 'done' && (!j.result || typeof j.result !== 'object' || typeof j.result.report !== 'string')) return false;
  return j.attempts.every((a) => a && typeof a === 'object' && Number.isInteger(a.n) && ENGINES.includes(a.engine) && isIso(a.started_at));
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 壊れたジョブは隔離して他のジョブを止めない。
// 読み取りは書き換え中の rename と競合しうるので、隔離はロックを持つランナーだけが、再読込しても壊れている場合に行う
function loadJobs({ quarantine = false } = {}) {
  const jobs = [];
  const quarantined = [];
  const skipped = [];
  const ids = listJobIds();
  for (const id of ids) {
    let j = null;
    for (let i = 0; i < 3; i++) {
      j = readJson(path.join(P.job(id), 'job.json'), null);
      if (validJob(j, id)) break;
      sleepMs(50);
    }
    if (validJob(j, id)) { jobs.push(j); continue; }
    if (!quarantine) { skipped.push(id); continue; }
    fs.mkdirSync(P.quarantine(), { recursive: true });
    const dest = path.join(P.quarantine(), `${id}.${Date.now()}`);
    try { renameRetry(P.job(id), dest); quarantined.push(id); log(`quarantine ${id} -> ${path.basename(dest)}`); }
    catch (e) { log(`quarantine 失敗 ${id}: ${e.message}`); }
  }
  return { jobs, quarantined, skipped, scanned: ids.length };
}
const saveJob = (j) => writeJson(path.join(P.job(j.id), 'job.json'), j);

// 状態の値域は validJob が先に弾くので、「状態別の和＝件数」は実行時には落ちない。
// 落ちうる等式として「ジョブのフォルダ数＝読めたジョブ数」を見る（隔離に失敗して残った壊れたジョブを見逃さない）
export function checkInvariants(jobs, dirCount = jobs.length) {
  const errs = [];
  const running = jobs.filter((j) => j.state === 'running');
  if (running.length > 0) errs.push(`回収後も running が ${running.length} 件残っている`);
  if (dirCount !== jobs.length) errs.push(`ジョブのフォルダ ${dirCount} 件のうち ${dirCount - jobs.length} 件を読めない（隔離もできていない）`);
  return errs;
}

// ---------------------------------------------------------------- add

function completionContract() {
  const lines = ['', '---', '[ut-defer 完了契約]',
    '- このジョブは無人で実行されている。確認の質問はできないので、判断が必要な点は前提を明記して進めること。',
    '- 作業を最後まで終えたら、最終メッセージに成果（何を確認・変更したか、根拠）を書き、最後の行に ' + DONE_MARK + ' とだけ書くこと。',
    '- 続行できない場合はマーカーを書かず、理由を書いて終了すること。'];
  lines.push('- ファイルは変更しないこと（読み取り専用ジョブ）。');
  return lines.join('\n');
}

export function addJob(opts, now = new Date()) {
  const cfg = loadConfig();
  const kind = opts.kind || 'task';
  const engine = opts.engine;
  const access = opts.access || 'read-only';
  if (!KINDS.includes(kind)) throw new Error(`--kind が不正: ${kind}`);
  if (!ENGINES.includes(engine)) throw new Error('--engine は codex|claude|any のどれかを明示する');
  if (!ACCESS.includes(access)) throw new Error(`--access が不正: ${access}`);
  // v1 は読み取りジョブだけ。無人のモデルが書き換えた作業場所を runner が自分の権限で扱う構造に、
  // レビューで繰り返し問題が見つかったため、書き込みジョブは v2 で設計し直す
  if (access === 'write') throw new Error('v1 は読み取りジョブだけを扱う（書き込みジョブは v2 で設計し直す）');
  // 別モデルで見ることが目的のジョブは振り替えない
  if (kind === 'review' && engine !== 'codex') throw new Error('review ジョブは engine=codex 固定（別モデルでのクロスチェックが目的のため）');
  const cwd = path.resolve(opts.cwd || process.cwd());
  const bad = checkCwdAllowed(cwd, cfg.allowed_roots);
  if (bad) throw new Error(bad);
  const g = gitInfo(cwd);
  let prompt = opts.prompt;
  let probeToken = null;
  if (kind === 'selftest-probe') {
    probeToken = 'PROBE-' + crypto.randomBytes(4).toString('hex');
    prompt = `これは ut-defer の疎通確認です。ツールは使わずに、次の2行だけをそのまま返してください。\n${probeToken}\n${DONE_MARK}`;
  }
  if (!prompt || !String(prompt).trim()) throw new Error('プロンプトが空');
  const id = newId(now);
  const job = {
    schema: 1, id, kind, engine, access, state: 'pending',
    created_at: now.toISOString(), next_attempt_at: null,
    origin: { cwd, ...g, top: undefined },
    drift_policy: opts.drift || 'hold',
    timeout_min: opts.timeoutMin === undefined ? cfg.timeout_min : Number(opts.timeoutMin),
    probe_token: probeToken,
    attempts: [], result: null, failure: null, notes: [],
  };
  if (!['hold', 'warn'].includes(job.drift_policy)) throw new Error('--drift は hold|warn');
  // 不正値を既定値で黙って補わない。上限を超えるとタイマーが溢れて即時に kill される（setTimeout は 2^31-1 ms まで）
  if (!checkTimeoutMin(job.timeout_min)) throw new Error(`--timeout-min は ${NUM_KEYS.timeout_min[0]}〜${NUM_KEYS.timeout_min[1]} の数値: ${opts.timeoutMin}`);
  // 作りかけのジョブを走査に拾わせないため、一時ディレクトリで組み立ててから rename する
  fs.mkdirSync(P.jobs(), { recursive: true });
  const tmp = path.join(P.jobs(), `.tmp-${id}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'prompt.txt'), String(prompt) + (kind === 'selftest-probe' ? '' : completionContract()));
  fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job, null, 2) + '\n');
  renameRetry(tmp, P.job(id));
  log(`add ${id} kind=${kind} engine=${engine} access=${access}`);
  return job;
}

// ---------------------------------------------------------------- エンジン起動

// 試験は engineBins を差し替えてスタブを起動する。UT_DEFER_*_BIN のような専用の環境変数では切り替えられないようにする
// （任意の実行ファイルを指定されると、--safe-mode も読み取りの制限も効かない処理を無人で動かせてしまう）
export const engineBins = { claude: null, codex: null };
// ほかの試験用の差し込みも、環境変数ではなくここに置く（自己テストが同じプロセスの中で設定する）。
// failFinish: 結果の保存を失敗させる / heartbeatMs: heartbeat の間隔（既定は1分）
export const testHooks = { failFinish: false, heartbeatMs: 0 };
// エンジンの子プロセスへ渡さない環境変数。読み込ませるコード（NODE_OPTIONS）、通信の経路（プロキシ・API の送り先）、シェルの初期化。
// Claude・Codex の起動に要る変数は種類が多く、許可したものだけを渡す方式では起動を壊しうるため、渡さないものを決める方式にしている
export const ENGINE_ENV_DENY = /^(NODE_OPTIONS|NODE_USE_ENV_PROXY|HTTPS?_PROXY|ALL_PROXY|ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|OPENAI_BASE_URL|BASH_ENV|ENV)$/i;
export function engineEnv(env = process.env) { return Object.fromEntries(Object.entries(env).filter(([k]) => !ENGINE_ENV_DENY.test(k))); }
// PATH のうち絶対パスの場所だけを順に探す（空の要素・. ・相対パスは、起動したときの作業フォルダを指すため飛ばす）
export function resolveOnPath(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.com'] : [''];
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':');
  for (const raw of dirs) {
    const d = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !path.isAbsolute(d)) continue;
    for (const e of exts) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 無い */ }
    }
  }
  return null;
}
function engineCommand(engine) {
  let bin = engineBins[engine];
  if (!bin && engine === 'codex') {
    // npm のシム（.cmd）は Node から直接 spawn できないので、JS 本体を node で起動する
    // APPDATA が無い・相対パスのときは使わない（相対パスのままだと、作業フォルダ＝対象リポジトリの中の codex.js を選びうる）
    const appdata = process.env.APPDATA;
    const js = appdata && path.isAbsolute(appdata) ? path.join(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : null;
    if (js && fs.existsSync(js)) bin = js;
  }
  // 名前のままで起動しない。Windows では作業フォルダ（＝対象リポジトリ）が先に探され、そこに置かれた claude.exe などが起動されるため。
  // 信頼する PATH の絶対パスの場所だけを探して、起動の前に絶対パスに決める（doctor も同じ結果を使う）
  if (!bin) bin = resolveOnPath(engine);
  if (!bin) throw new Error(`${engine} が PATH の絶対パスの場所に見つからない（作業フォルダと相対パスの場所は探さない）`);
  if (!path.isAbsolute(bin)) throw new Error(`実行ファイルが絶対パスでない: ${bin}`);
  if (/\.(cmd|bat|ps1)$/i.test(bin)) throw new Error(`シェル経由の起動は行わない: ${bin}`);
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { file: process.execPath, pre: [bin] };
  return { file: bin, pre: [] };
}

// 引数の値は実物 CLI のヘルプに載っているものだけを使う（`doctor` が照合する）
export const CLAUDE_READ_TOOLS = 'Read,Grep,Glob';
export function buildArgv(engine, job, runCwd, attemptDir) {
  // v1 は読み取りジョブだけ。書き込みジョブの引数は組み立てない（既存データに残っていても起動しない）
  if (job.access !== 'read-only') throw new Error('v1 は読み取りジョブだけを扱う（書き込みジョブは v2 で設計し直す）');
  if (engine === 'claude') {
    // --tools は「使えるツール」そのものを絞る（--allowedTools は自動許可の規則で、他のツールを消さない）。
    // 許可規則に無い操作は確認を出さずに拒否させる。
    // 設定はユーザー設定だけを読む。-p ではワークスペースの信頼確認が出ないため、対象 repo の project/local 設定
    // （hooks・env・apiKeyHelper）を読ませると、--tools の閉じ込めの外でコマンドが動きうる。
    // さらに --safe-mode で、ユーザー設定の hook・installed plugins・MCP・CLAUDE.md・skills などの上乗せも止める（Codex のジョブの
    // --ignore-user-config と揃える。2026-10-01 に実機で、--settings で与えた hook が --safe-mode なしでは動き、ありでは動かないことを確認）。
    // 止まらないもの: 管理者のポリシー設定（hook を含む）、認証の処理（apiKeyHelper は --safe-mode でも実行される。実機で確認）。
    // これらは doctor が報告する（safeModeResidue）。エンジンへ渡さない環境変数は engineEnv が除き、doctor が今の環境にあるかを報告する
    return ['-p', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', 'user', '--safe-mode',
      '--tools', CLAUDE_READ_TOOLS,
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--disallowedTools', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch',
      '--strict-mcp-config'];
  }
  // ユーザー設定とプラグインを読ませない。プラグイン由来の MCP（コンピュータ操作・JS 実行など）が sandbox の外で動くため。
  // 実行ポリシーの .rules も読ませない。対象 repo の .rules で許可を広げられないようにするため（ユーザー側の禁止ルールも効かなくなる）。
  // Windows の sandbox 方式は unelevated を明示する。elevated は準備処理がプロファイル配下へ権限を繰り返し付与する
  // 既知の不具合があり（openai/codex#48228）、無人実行のたびにその準備処理を起こさないため
  // 制限で中断したジョブの「再開」は行わない（常に最初からやり直す）
  // 組み込みの web 検索も切る。読んだ内容が検索語として外へ出る経路をなくすため（既定では有効。2026-09-30 に実機で有無を比較して確認）
  return ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-c', 'features.plugins=false', '-c', 'windows.sandbox="unelevated"', '-c', 'web_search="disabled"',
    '--sandbox', 'read-only',
    '-C', runCwd, '-o', path.join(attemptDir, 'last-message.txt'), '-'];
}

// スタブは実物 CLI の引数解析を再現しない。実物のヘルプに、使う引数と値が載っているかをモデルを呼ばずに照合する
export const HELP_REQUIREMENTS = {
  claude: ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
    '--disallowedTools', '--strict-mcp-config'],
  codex: ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--config', '--sandbox', 'read-only', '--cd', '--output-last-message'],
};
// 値は、その引数自身の choices の中にあるかで見る（"default" のような語はヘルプの別の箇所にも現れるため）
const HELP_CHOICES = { claude: [['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none']], codex: [] };
// その引数の説明ブロック（見出し行から、次の引数の見出し行の手前まで）の中だけで choices を探す。
// 範囲を文字数で切ると、choices を持たない引数のあとにある別の引数の choices を拾ってしまう
function choicesOf(helpText, flag) {
  const text = String(helpText).replace(/\t/g, ' ');
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`(^|\\n)[ ]*(-[A-Za-z], )?${esc}(?=[ ,<=\\n])`).exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length);
  const next = /\n[ ]{1,6}(-[A-Za-z], )?--[A-Za-z]/.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  const m = /\(choices:([^)]*)\)/.exec(block);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}
export function checkHelp(engine, helpText) {
  const missing = HELP_REQUIREMENTS[engine].filter((tok) => !String(helpText).includes(tok));
  for (const [flag, value] of HELP_CHOICES[engine]) if (!choicesOf(helpText, flag).includes(value)) missing.push(`${flag}=${value}`);
  return missing;
}
// --safe-mode でも止まらず、無人の Claude のジョブで動きうる設定を、キーの名前と件数だけで返す（値は返さない）。
// ユーザー設定の認証の補助（apiKeyHelper など）と env、管理者の設定の hook。止めはしない（利用者自身・組織の設定のため）が、黙って動かさない
const SAFE_MODE_RESIDUE_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'env'];
export function safeModeResidue(userSettings, managedSettings) {
  const notes = [];
  const keys = (o) => (o && typeof o === 'object' ? SAFE_MODE_RESIDUE_KEYS.filter((k) => Object.hasOwn(o, k)) : []);
  const hookCount = (o) => (o && o.hooks && typeof o.hooks === 'object' ? Object.values(o.hooks).reduce((n, a) => n + (Array.isArray(a) ? a.reduce((m, x) => m + ((x && Array.isArray(x.hooks)) ? x.hooks.length : 0), 0) : 0), 0) : 0);
  const u = keys(userSettings);
  if (u.length) notes.push(`ユーザー設定の ${u.join(', ')} は --safe-mode でも効く（無人の Claude のジョブで実行・適用される）`);
  const m = keys(managedSettings);
  if (m.length) notes.push(`管理者の設定の ${m.join(', ')} は --safe-mode でも効く`);
  const h = hookCount(managedSettings);
  if (h) notes.push(`管理者の設定の hook ${h} 件は --safe-mode でも動く（組織の統制として配られたもの）`);
  return notes;
}
// 「無い」と「読めない・JSON が壊れている」を区別する。読めないものを「該当なし」として OK にしない
export function readSettingsFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { state: 'missing', value: null } : { state: 'unreadable', value: null }; }
  try { return { state: 'ok', value: JSON.parse(raw) }; } catch { return { state: 'invalid', value: null }; }
}
const MANAGED_SETTINGS = process.platform === 'win32' ? 'C:/Program Files/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
// 最後の行。NG があれば「問題あり」、注意だけなら「注意あり」（注意を出しながら「問題なし」と締めない）
export function doctorSummary(ok, lines) {
  if (!ok) return 'doctor: 問題あり（実物 CLI の変更に追従が必要）';
  return lines.some((l) => /^\s*注意 /.test(l)) ? 'doctor: 注意あり（上の注意を確かめる。実物 CLI との照合は問題なし）' : 'doctor: 問題なし';
}
function doctor() {
  const lines = [];
  let ok = true;
  const run = (engine, args) => {
    const cmd = engineCommand(engine);
    return execFileSync(cmd.file, [...cmd.pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true, env: engineEnv() });
  };
  for (const [engine, args] of [['claude', ['--help']], ['codex', ['exec', '--help']]]) {
    let help = '';
    try { help = run(engine, args); } catch (e) { ok = false; lines.push(`  NG  ${engine}: ヘルプを取得できない (${e.message.split('\n')[0]})`); continue; }
    const missing = checkHelp(engine, help);
    if (missing.length) { ok = false; lines.push(`  NG  ${engine}: ヘルプに無い引数・値 ${missing.join(' ')}`); }
    else lines.push(`  OK  ${engine}: 使用する引数 ${HELP_REQUIREMENTS[engine].length} 件がすべてヘルプにある`);
  }
  try {
    const feats = run('codex', ['features', 'list']);
    if (/^plugins\s/m.test(feats)) lines.push('  OK  codex: features.plugins が存在する');
    else { ok = false; lines.push('  NG  codex: features.plugins が一覧に無い（プラグイン由来の MCP を外せない可能性）'); }
  } catch (e) { ok = false; lines.push(`  NG  codex: features を取得できない (${e.message.split('\n')[0]})`); }
  const userS = readSettingsFile(path.join(os.homedir(), '.claude', 'settings.json'));
  const managedS = readSettingsFile(MANAGED_SETTINGS);
  const unread = [['ユーザー設定', userS], ['管理者の設定', managedS]].filter(([, r]) => r.state === 'unreadable' || r.state === 'invalid');
  for (const [label, r] of unread) lines.push(`  注意 claude: ${label}を${r.state === 'invalid' ? ' JSON として読めない' : '読めない'}（--safe-mode でも効く設定があるかを確認できていない）`);
  const residue = safeModeResidue(userS.value, managedS.value);
  for (const n of residue) lines.push(`  注意 claude: ${n}`);
  if (!residue.length && !unread.length) lines.push('  OK  claude: --safe-mode でも効く設定（認証の補助・env・管理者の hook）は無い');
  // エンジンへ渡さない変数が、今の環境にあれば名前だけを出す（タスクスケジューラから起動したときの環境とは違いうる）
  const denied = Object.keys(process.env).filter((k) => ENGINE_ENV_DENY.test(k));
  lines.push(denied.length ? `  注意 env: エンジンへは渡さない変数がある（${denied.join(', ')}）。この端末から起動したときの環境で判定` : '  OK  env: エンジンへ渡さない変数（NODE_OPTIONS・プロキシ・API の送り先など）は今の環境に無い');
  lines.push(doctorSummary(ok, lines));
  return { ok, text: lines.join('\n') };
}


// taskkill も名前のままで起動しない（作業フォルダの同名の実行ファイルを拾わないため）。PATH の絶対パスの場所、
// 無ければ SystemRoot（絶対パスのときだけ）の System32 から探す。見つからなければ taskkill は使わない
export function taskkillBin(env = process.env) {
  const p = resolveOnPath('taskkill', env, 'win32');
  if (p) return p;
  const sr = env.SystemRoot || env.SYSTEMROOT;
  const q = sr && path.isAbsolute(sr) ? path.join(sr, 'System32', 'taskkill.exe') : null;
  return q && fs.existsSync(q) ? q : null;
}
function killTree(child) {
  try {
    const tk = process.platform === 'win32' ? taskkillBin() : null;
    if (tk) execFileSync(tk, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL'); // taskkill が見つからなければ、子プロセスの木ではなく直接の子だけを止める
  } catch { /* 既に終了している */ }
}

let CURRENT_CHILD = null;
function runEngine({ engine, argv, cwd, stdinText, attemptDir, timeoutMs }) {
  return new Promise((resolve) => {
    const cmd = engineCommand(engine);
    const full = [...cmd.pre, ...argv];
    assertSafeArgv(full);
    // 起動した引数を先に残す（プロンプトは stdin で渡すので引数には含まれない）
    writeJson(path.join(attemptDir, 'argv.json'), { file: cmd.file, args: full, cwd });
    const out = fs.openSync(path.join(attemptDir, 'stdout.jsonl'), 'w');
    const err = fs.openSync(path.join(attemptDir, 'stderr.txt'), 'w');
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd.file, full, { cwd, stdio: ['pipe', out, err], windowsHide: true, env: engineEnv() });
      // ロックを失ったとき heartbeat から止められるよう、実行中の子プロセスを覚えておく
      CURRENT_CHILD = child;
      // runner だけが止まって子プロセスが残った場合に、次の runner が時間だけで回収して二重に実行しないよう pid を残す
      try { writeJson(path.join(attemptDir, 'child.json'), { pid: child.pid, at: new Date().toISOString() }); } catch { /* 記録できなくても実行は続ける */ }
    } catch (e) {
      fs.closeSync(out); fs.closeSync(err);
      resolve({ exitCode: null, spawnError: e.message, timedOut });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); CURRENT_CHILD = null; fs.closeSync(out); fs.closeSync(err); resolve({ exitCode: null, spawnError: e.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); CURRENT_CHILD = null; try { fs.closeSync(out); fs.closeSync(err); } catch { /* */ } resolve({ exitCode: code, timedOut }); });
    child.stdin.on('error', () => { /* 子が stdin を読まずに終了した場合 */ });
    child.stdin.end(stdinText);
  });
}

// ---------------------------------------------------------------- 分類

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { out.push(JSON.parse(s)); } catch { /* 途中で切れた行 */ }
  }
  return out;
}
function codexHome() { return process.env.CODEX_HOME || path.join(home(), '.codex'); }
// rollout は sessions/YYYY/MM/DD/ の下にある。今日と昨日（日付をまたいだ実行）の日付フォルダを先に探し、無ければ全体を探す
function findRollout(threadId) {
  if (!threadId) return null;
  const root = path.join(codexHome(), 'sessions');
  const p2 = (n) => String(n).padStart(2, '0');
  for (const d of [new Date(), new Date(Date.now() - 24 * HOUR)]) {
    const dir = path.join(root, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    try { const hit = fs.readdirSync(dir).find((n) => n.endsWith('.jsonl') && n.includes(threadId)); if (hit) return path.join(dir, hit); } catch { /* 無ければ全体を探す */ }
  }
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl') && e.name.includes(threadId)) return p;
    }
  }
  return null;
}
function findKey(obj, key, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (Object.prototype.hasOwnProperty.call(obj, key)) acc.push(obj[key]);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') findKey(v, key, acc);
  return acc;
}

// Codex: 実測済みの rollout 形状（★）と、未測定の --json 出力（△）の両方から信号を拾う
// 自由文は見ない。読んだファイルやツール出力に「usage limit」と書かれているだけで制限と誤判定するため。
// rollout は同じファイルに前の試行の記録が残りうるので、今回の試行開始より後の行だけを使う
function limitSignals(events) {
  const reached = [];
  let errorInfo = false;
  for (const e of events) {
    for (const rl of findKey(e, 'rate_limits')) {
      if (rl && typeof rl === 'object' && typeof rl.rate_limit_reached_type === 'string' && rl.rate_limit_reached_type) reached.push(rl.rate_limit_reached_type);
    }
    for (const info of findKey(e, 'codex_error_info')) {
      if (info === 'usage_limit_exceeded' || (info && typeof info === 'object' && Object.keys(info).includes('usage_limit_exceeded'))) errorInfo = true;
    }
  }
  return { reached, errorInfo };
}
export function classifyCodex({ exitCode, stdout, rollout, lastMessage, timedOut, spawnError, since = 0 }, now = Date.now()) {
  const outEv = parseJsonl(stdout);
  const rollEv = parseJsonl(rollout).filter((e) => !e.timestamp || Date.parse(e.timestamp) >= since - 2000);
  const events = [...outEv, ...rollEv];
  const threadId = findKey(outEv, 'thread_id').find((x) => typeof x === 'string')
    || findKey(outEv, 'session_id').find((x) => typeof x === 'string') || null;
  if (spawnError) return { cls: 'unknown', reason: `起動失敗: ${spawnError}`, session_id: threadId };
  if (timedOut) return { cls: 'timeout', reason: 'タイムアウト', session_id: threadId };
  const { reached, errorInfo } = limitSignals(events);
  const limitHit = reached.length > 0 || errorInfo;
  if (limitHit) {
    // 止まった瞬間の記録には時刻が無い。直前の 5時間枠が使い切られていて、リセットが未来なら時刻で待てる
    // 5時間枠だけでなく週次枠も使い切っていれば、5時間枠のリセットでは戻らない。使い切った枠のうち最も遅いリセットまで待つ
    const exhausted = [];
    for (const rl of findKey(events, 'rate_limits')) {
      for (const k of ['primary', 'secondary']) {
        const w = rl && typeof rl === 'object' ? rl[k] : null;
        if (w && typeof w === 'object' && Number(w.used_percent) >= 100 && Number(w.resets_at) > 0) exhausted.push(Number(w.resets_at) * 1000);
      }
    }
    const resetMs = exhausted.length ? Math.max(...exhausted) : 0;
    if (resetMs > now) return { cls: 'limit_time', next: resetMs + 10 * MIN, reason: `5時間枠のリセット待ち (${reached.join(',') || 'usage_limit'})`, session_id: threadId };
    return { cls: 'limit_owner', reason: `管理者の補充・上限引き上げ待ち (${reached.join(',') || 'usage_limit'})`, session_id: threadId };
  }
  if (exitCode === 0) return { cls: 'ok', text: lastMessage || '', session_id: threadId };
  return { cls: 'unknown', reason: `exit=${exitCode}`, session_id: threadId };
}

// 「resets 3pm」「resets at 15:30」形式の時刻を次の該当時刻に直す（暫定。実例が無い）
export function parseResetText(s, now = Date.now()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(s || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  const d = new Date(now);
  d.setHours(h, mi, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Claude: 実際の制限到達サンプルが無いため全て暫定（△）。判定できないものは hold に倒す
export function classifyClaude({ exitCode, stdout, timedOut, spawnError }, now = Date.now()) {
  const ev = parseJsonl(stdout);
  const sid = ev.map((e) => e.session_id).filter((x) => typeof x === 'string').pop() || null;
  if (spawnError) return { cls: 'unknown', reason: `起動失敗: ${spawnError}`, session_id: sid };
  if (timedOut) return { cls: 'timeout', reason: 'タイムアウト', session_id: sid };
  const result = ev.filter((e) => e.type === 'result').pop();
  const resultText = result ? String(result.result || '') : '';
  // 途中の 429 を CLI が再試行して回復した実行は成功として扱う。成功判定を先に行う
  if (exitCode === 0 && result && result.subtype === 'success' && !result.is_error) return { cls: 'ok', text: resultText, session_id: sid };
  const retryLimit = ev.some((e) => e.type === 'system' && e.subtype === 'api_retry' && /rate_limit/i.test(String(e.error || '')));
  const limitText = /(session|weekly|opus|sonnet|usage) limit|rate limit/i.test(resultText) && (result?.is_error || exitCode !== 0);
  if (retryLimit || limitText) {
    const t = parseResetText(resultText, now);
    return { cls: 'limit_time', next: t ? t + 10 * MIN : now + HOUR, reason: t ? '制限リセット待ち（文言から時刻を取得）' : '制限リセット待ち（時刻不明のため60分後）', session_id: sid };
  }
  return { cls: 'unknown', reason: `exit=${exitCode} result=${result ? result.subtype : 'なし'}`, session_id: sid };
}

// exit 0 は「やり終えた」証拠にならない。完了マーカーと出力量を見る
// マーカーは「本文中に現れる」では足りない（契約文の引用や「書きません」という説明でも現れる）。行として完全一致を求める
export function checkEvidence(job, text, cfg) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (job.kind === 'selftest-probe') {
    // 疎通確認は「2行だけをそのまま返す」契約。余分な行があれば指示どおりに動いていない
    return lines.length === 2 && lines[0] === job.probe_token && lines[1] === DONE_MARK ? null : 'probe_mismatch';
  }
  if (last !== DONE_MARK) return '最終行が完了マーカーではない';
  const body = lines.filter((l) => l !== DONE_MARK).join('\n');
  if (body.length < cfg.min_report_chars) return `成果の記述が ${cfg.min_report_chars} 文字未満`;
  return null;
}

// ---------------------------------------------------------------- ロック

// ロックファイルは開いたまま保持し、heartbeat はその fd へ書く。別の runner が退避（rename）しても
// 書き込みは退避先へ入るだけで、相手が新しく作ったロックを上書きしない。解放時は所有者トークンを照合する
let LOCK = null;
function lockBody(started) { return JSON.stringify({ pid: process.pid, token: LOCK.token, started_at: started, heartbeat_at: new Date().toISOString() }); }
function acquireLock(cfg, now = Date.now()) {
  fs.mkdirSync(qdir(), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(P.lock(), 'wx');
      LOCK = { fd, token: crypto.randomBytes(8).toString('hex'), started: new Date(now).toISOString(), lost: false };
      fs.writeSync(fd, lockBody(LOCK.started), 0);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // pid は再利用されうるので生死判定には使わない。heartbeat が止まっていれば古いとみなす。
      // 作成直後で中身がまだ無いロックは、heartbeat の代わりにファイルの更新時刻で判断する
      const lockAge = () => {
        const cur = readJson(P.lock(), null);
        const hb = cur && Date.parse(cur.heartbeat_at);
        if (Number.isFinite(hb)) return now - hb;
        try { return now - fs.statSync(P.lock()).mtimeMs; } catch { return 0; }
      };
      if (lockAge() < cfg.stale_lock_min * MIN) return false;
      const dest = `${P.lock()}.stale-${newId(new Date(now))}-${process.pid}`;
      try { renameRetry(P.lock(), dest); } catch { return false; }
      // 判定から退避までの間に別の runner が新しいロックを作っていたら、それを奪ったことになる。中身を見直して戻す
      const moved = readJson(dest, null);
      const mhb = moved && Date.parse(moved.heartbeat_at);
      if (Number.isFinite(mhb) && now - mhb < cfg.stale_lock_min * MIN) {
        try { if (!fs.existsSync(P.lock())) renameRetry(dest, P.lock()); } catch { /* */ }
        return false;
      }
      log(`stale lock を退避 pid=${moved && moved.pid}`);
    }
  }
  return false;
}
// 自分がまだロックの所有者か。退避されて別の runner が作り直していれば、パスの先のトークンが変わっている
// 読み取りの一時的な失敗（退避の rename と重なった等）を所有権の喪失と取り違えないよう、読めないときは数回読み直す
function ownsLock() {
  if (!LOCK || LOCK.lost) return false;
  for (let i = 0; i < 3; i++) {
    const cur = readJson(P.lock(), null);
    if (cur) return cur.token === LOCK.token;
    sleepMs(100);
  }
  return false;
}
// 所有権を失った runner は処理を続けない。実行中の子プロセスを止め、以後は結果を反映しない
function heartbeat() {
  if (!LOCK) return;
  if (!ownsLock()) {
    LOCK.lost = true;
    log('ロックの所有権を失った（長時間の停止中に別の runner が引き継いだ可能性）。実行中のジョブを止め、結果は反映しない');
    if (CURRENT_CHILD) killTree(CURRENT_CHILD);
    return;
  }
  try { fs.ftruncateSync(LOCK.fd, 0); fs.writeSync(LOCK.fd, lockBody(LOCK.started), 0); } catch (e) { log('heartbeat 失敗: ' + e.message); }
}
function releaseLock() {
  if (!LOCK) return;
  const mine = LOCK.token;
  try { fs.closeSync(LOCK.fd); } catch { /* */ }
  LOCK = null;
  const cur = readJson(P.lock(), null);
  if (cur && cur.token === mine) { try { fs.unlinkSync(P.lock()); } catch { /* */ } }
  else log('ロックの所有者が変わっていたため削除しない（退避された可能性）');
}

// ジョブ単位の排他。状態の読み直しから保存までを1つの区間にし、runner の状態更新と人の操作
// （cancel・retry・review）が互いの結果を古い状態で上書きしないようにする。区間は数ミリ秒で終わる
export class JobBusyError extends Error {}
// 横取りしてよいのは「持ち主のプロセスがもう居ない」か「持ち主が居ても異常に長い」ときだけ。
// 持ち主が生きているのに時間だけで奪うと、遅い処理（ディスクが遅い・ウイルス対策の検査中など）の途中に割り込む
const JOB_LOCK_STALE_MS = 30 * 1000;
const JOB_LOCK_MAX_MS = 10 * MIN;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // 分からないときは生きているものとして扱う
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function withJobLock(id, fn) {
  const lf = path.join(P.job(id), '.lock');
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const fd = fs.openSync(lf, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`ジョブが見つからない: ${id}`);
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lf).mtimeMs; } catch { continue; }
      const holder = readJson(lf, null);
      const stale = age > JOB_LOCK_MAX_MS || (age > JOB_LOCK_STALE_MS && !pidAlive(holder && holder.pid));
      if (stale) {
        // 退避してから中身を見直す。判定から退避までの間に別の待機者が作り直していたら戻す
        const moved = `${lf}.stale-${token}`;
        try { renameRetry(lf, moved); } catch { continue; }
        const got = readJson(moved, null);
        if (got && holder && got.token !== holder.token) {
          // 判定から退避までの間に作り直されたロック（別の持ち主のもの）を退避してしまった。
          // 持ち主が生きていて新しければ、上書きしない方法（link）で元の場所へ戻す。戻せなければ（別の待機者がもう作っていた）
          // 取得をあきらめる。持ち主の排他を黙って失わせないため、生きた持ち主のロックは消さない
          let fresh = false;
          try { fresh = Date.now() - fs.statSync(moved).mtimeMs < JOB_LOCK_STALE_MS && pidAlive(got.pid); } catch { /* */ }
          if (!fresh) { try { fs.unlinkSync(moved); } catch { /* */ } continue; }
          try { fs.linkSync(moved, lf); fs.unlinkSync(moved); } catch {
            log(`${id} のロックの持ち主が入れ替わる競合を検出した（${moved} を残す）。今回は取得しない`);
            throw new JobBusyError(`ジョブ ${id} のロックが競合している（少し待ってからやり直す）`);
          }
          continue;
        }
        try { fs.unlinkSync(moved); } catch { /* */ }
        continue;
      }
      if (Date.now() > deadline) throw new JobBusyError(`ジョブ ${id} は他の操作が処理中（少し待ってからやり直す）`);
      sleepMs(50);
    }
  }
  try { return fn(); } finally {
    // 自分のロックだけを消す（横取りされていたら相手のロックを消さない）
    const cur = readJson(lf, null);
    if (cur && cur.token === token) { try { fs.unlinkSync(lf); } catch { /* */ } }
  }
}

// ---------------------------------------------------------------- run

function engineBlocked(engines, e, now) {
  const b = engines[e];
  return b && Date.parse(b.blocked_until) > now;
}
function recentAttempts(jobs, now) {
  let n = 0;
  for (const j of jobs) for (const a of j.attempts) if (a.started_at && now - Date.parse(a.started_at) < 5 * HOUR && !a.skipped) n++;
  return n;
}
function pickEngine(job, engines, now) {
  if (job.engine !== 'any') return engineBlocked(engines, job.engine, now) ? null : job.engine;
  return ['codex', 'claude'].find((e) => !engineBlocked(engines, e, now)) || null;
}
export function selectJobs(jobs, engines, cfg, now) {
  const budget = Math.max(0, Math.min(cfg.caps.per_run, cfg.caps.per_5h - recentAttempts(jobs, now)));
  // 読み取りジョブだけを選ぶ（過去の書き込みジョブで起動の枠を使わない。runOnce が hold にする）
  const due = jobs.filter((j) => j.state === 'pending' && j.access === 'read-only' && (!j.next_attempt_at || Date.parse(j.next_attempt_at) <= now))
    .map((j) => ({ job: j, engine: pickEngine(j, engines, now) })).filter((x) => x.engine)
    .sort((a, b) => a.job.created_at.localeCompare(b.job.created_at));
  return due.slice(0, budget);
}

// engines.json（エンジンの停止記録）も既定値で黙って補わない。壊れた記録を「止まっていない」と読むと、
// 制限中のエンジンへ起動を繰り返して上限枠を使い切る
function loadEngines() {
  if (!fs.existsSync(P.engines())) return {};
  let e;
  try { e = JSON.parse(fs.readFileSync(P.engines(), 'utf8')); } catch (err) { throw new ConfigError(`engines.json を解析できない: ${err.message}`); }
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ConfigError('engines.json がオブジェクトではない');
  for (const [k, v] of Object.entries(e)) {
    if (!['codex', 'claude'].includes(k) || !v || typeof v !== 'object' || !isIso(v.blocked_until)) throw new ConfigError(`engines.json の ${k} が不正`);
  }
  return e;
}

// 人の操作用。呼び出し側がジョブ単位のロックを持っていること
function transition(job, state, patch = {}) {
  Object.assign(job, patch, { state });
  saveJob(job);
  log(`${job.id} -> ${state}${patch.failure ? ' ' + patch.failure.kind + ': ' + (patch.failure.note || '') : ''}`);
}

// runner 用。running にした本人（所有者トークンが一致し、全体のロックもまだ持っている）でなければ書かない。
// 長く止まっていた古い runner が復帰して、引き継がれたジョブを古い結果で上書きするのを防ぐ
function finishAsOwner(job, state, patch = {}, attemptPatch = {}) {
  // selftest 用: 結果の保存がディスクの異常などで失敗する状況を作る
  if (testHooks.failFinish) throw new Error('試験用の差し込み（failFinish）による保存の失敗');
  return withJobLock(job.id, () => {
    const disk = readJson(path.join(P.job(job.id), 'job.json'), null);
    if (!validJob(disk, job.id) || disk.state !== 'running' || !LOCK || disk.owner !== LOCK.token || !ownsLock()) {
      log(`${job.id} の所有権を失ったため結果を反映しない (${disk ? disk.state : '読めない'})`);
      return false;
    }
    Object.assign(disk.attempts[disk.attempts.length - 1], { ended_at: new Date().toISOString(), ...attemptPatch });
    Object.assign(disk, patch, { state, owner: null, notes: job.notes });
    saveJob(disk);
    log(`${job.id} -> ${state}${patch.failure ? ' ' + patch.failure.kind + ': ' + (patch.failure.note || '') : ''}`);
    return true;
  });
}

// running が残っていても、それが本当に止まっているとは限らない（別の runner が sleep 明けに動いている、手動の run など）。
// 実行開始から「timeout＋ロック判定の猶予」を過ぎたものだけを死んだとみなして回収する。まだ生きている可能性があれば何も実行しない
// 子プロセスがまだ生きていれば回収しない。pid の再利用で永久に回収できなくならないよう、1日を過ぎたら時間で判断する
const CHILD_ALIVE_MAX_MS = 24 * HOUR;
function childStillAlive(job, now) {
  const last = job.attempts[job.attempts.length - 1];
  if (!last) return false;
  const c = readJson(path.join(P.job(job.id), 'attempts', String(last.n), 'child.json'), null);
  if (!c || !Number.isInteger(c.pid) || c.pid <= 0) return false;
  const at = Date.parse(c.at);
  if (Number.isFinite(at) && now - at > CHILD_ALIVE_MAX_MS) return false;
  try { process.kill(c.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 回収・移行で状態を書き換える前に、runner 全体のロックをまだ持っているか確かめる。失っていれば以後は何も書かない
export class LockLostError extends Error {}
function assertOwner(what) {
  if (!ownsLock()) { if (LOCK) LOCK.lost = true; throw new LockLostError(`${what}の途中でロックの所有権を失った`); }
}
function recoverOrphans(jobs, cfg, now) {
  const alive = [];
  for (const j0 of jobs.filter((x) => x.state === 'running')) {
    const last0 = j0.attempts[j0.attempts.length - 1];
    const started = last0 && Date.parse(last0.started_at);
    const limit = j0.timeout_min * MIN + cfg.stale_lock_min * MIN + 5 * MIN;
    if (Number.isFinite(started) && now - started < limit) { alive.push(j0.id); continue; }
    // 時間が過ぎていても、子プロセスが生きていれば実行中とみなす（runner だけが止まった場合の二重実行を防ぐ）
    if (childStillAlive(j0, now)) { log(`${j0.id} は子プロセスがまだ動いているため回収しない`); alive.push(j0.id); continue; }
    // 人の操作と重なってロックを取れないジョブは、使用中とみなして今回は回収しない（例外で run 全体を落とさない）
    try { withJobLock(j0.id, () => {
      const j = readJson(path.join(P.job(j0.id), 'job.json'), null);
      if (!validJob(j, j0.id) || j.state !== 'running') return;
      assertOwner('孤児の回収');
      const last = j.attempts[j.attempts.length - 1];
      if (last && !last.ended_at) Object.assign(last, { ended_at: new Date(now).toISOString(), class: 'orphaned' });
      const failures = attemptsSinceRetry(j).filter((a) => !a.skipped && a.class === 'orphaned').length;
      if (j.access !== 'read-only') transition(j, 'hold', { owner: null, failure: { kind: 'unsupported', note: 'v1 は読み取りジョブだけを扱う。cancel で片付ける' } });
      else if (failures >= cfg.max_attempts) transition(j, 'hold', { owner: null, failure: { kind: 'orphaned', note: `途中停止が ${failures} 回続いた` } });
      else transition(j, 'pending', { owner: null, next_attempt_at: null });
    }); } catch (e) {
      if (!(e instanceof JobBusyError)) throw e;
      log(`${j0.id} は他の操作が処理中のため今回は回収しない`);
      alive.push(j0.id);
    }
  }
  return alive;
}


// 回数と最初の制限時刻は、最後の retry より後の試行だけで数える（retry したのに即座に上限扱いにしない）
function attemptsSinceRetry(job) {
  const since = job.retry_at ? Date.parse(job.retry_at) : 0;
  return job.attempts.filter((a) => Date.parse(a.started_at) >= since);
}
function limitCount(job, cls) { return attemptsSinceRetry(job).filter((a) => a.class === cls).length; }
function firstLimitAt(job) {
  const a = attemptsSinceRetry(job).find((x) => x.class === 'limit_time' || x.class === 'limit_owner');
  return a ? Date.parse(a.started_at) : null;
}

export class FinishError extends Error {}
// 1) ジョブ単位のロックの下で pending を読み直し、running にして所有者を記録する（ここが CAS）
// 2) 実行する。実行途中の例外で running のまま残すと、回収と再実行を繰り返して上限枠を食い続けるので、例外は必ず hold にする
async function runJob(job0, engine, cfg, engines, now) {
  let job;
  try {
    job = withJobLock(job0.id, () => {
      const disk = readJson(path.join(P.job(job0.id), 'job.json'), null);
      if (!validJob(disk, job0.id) || disk.state !== 'pending' || disk.attempts.length !== job0.attempts.length) return null;
      if (!ownsLock()) return null;
      disk.attempts.push({ n: disk.attempts.length + 1, engine, started_at: new Date(Math.max(now, Date.now())).toISOString(), by_runner: true });
      disk.state = 'running';
      disk.owner = LOCK.token;
      saveJob(disk);
      log(`${disk.id} -> running`);
      return disk;
    });
  } catch (e) {
    if (e instanceof JobBusyError) { log(`${job0.id} は他の操作が処理中のため今回は実行しない`); return false; }
    throw e;
  }
  if (!job) {
    if (!ownsLock()) { log(`${job0.id} を始める前にロックの所有権を失った`); return 'lock_lost'; }
    log(`${job0.id} は選択後に状態が変わったため実行しない`); return false;
  }
  try {
    // 結果の保存を所有権の照合で拒否された（false）場合も、1件実行したとは数えない
    const r = await runJobInner(job, engine, cfg, engines);
    if (r === 'lock_lost' || r === false) return 'lock_lost';
  } catch (e) {
    let saved = false;
    try { saved = finishAsOwner(job, 'hold', { failure: { kind: 'internal', note: String((e && e.message) || e) } }, { class: 'internal' }); }
    catch (e2) {
      // hold にも保存できなければ、状態を確定できていない。ログだけ残して正常終了にしない（孤児回収で再実行されうるため）
      log(`${job.id} hold への遷移に失敗: ${e2.message}（元の例外: ${e.message}）`);
      throw new FinishError(`${job.id} の結果を保存できない: ${e2.message}`);
    }
    if (!saved) return 'lock_lost';
  }
  // 結果の保存が所有権の喪失で拒否された場合も、正常に1件実行したとは数えない
  if (!ownsLock()) return 'lock_lost';
  return true;
}

async function runJobInner(job, engine, cfg, engines) {
  const n = job.attempts[job.attempts.length - 1].n;
  const attemptDir = path.join(P.job(job.id), 'attempts', String(n));
  fs.mkdirSync(attemptDir, { recursive: true });
  // エンジンを起動しなかった終わり方は、件数上限の試行数に数えない（skipped）
  const stop = (kind, note) => finishAsOwner(job, 'hold', { failure: { kind, note } }, { class: kind, skipped: true });
  // drift: 積んだ時点から HEAD が動いていないか（読み取りジョブの主要な防御。access に依存させない）
  if (job.origin.is_git) {
    let head = null;
    try { head = git(['rev-parse', 'HEAD'], job.origin.cwd); } catch { /* */ }
    if (head !== job.origin.head) {
      if (job.drift_policy === 'hold') return stop('drift', `HEAD が変わった ${String(job.origin.head).slice(0, 8)} -> ${String(head).slice(0, 8)}（新しい HEAD で良ければ retry --accept-head）`);
      job.notes.push(`drift(warn): HEAD ${String(job.origin.head).slice(0, 8)} -> ${String(head).slice(0, 8)}`);
    }
  }
  const bad = checkCwdAllowed(job.origin.cwd, cfg.allowed_roots);
  if (bad) return stop('not_allowed', bad);

  const runCwd = job.origin.cwd;
  const prompt = fs.readFileSync(path.join(P.job(job.id), 'prompt.txt'), 'utf8');
  let argv;
  try { argv = buildArgv(engine, job, runCwd, attemptDir); assertSafeArgv(argv); } catch (e) { return stop('config', e.message); }
  const startedAt = Date.now();
  const treeBefore = job.origin.is_git ? treeFingerprint(runCwd) : null;
  const r = await runEngine({ engine, argv, cwd: runCwd, stdinText: prompt, attemptDir, timeoutMs: job.timeout_min * MIN });
  const treeAfter = job.origin.is_git ? treeFingerprint(runCwd) : null;
  if (treeBefore && treeAfter && treeBefore !== treeAfter) job.notes.push(`実行中に作業ツリーが変わった（${treeBefore} -> ${treeAfter}）。報告は実行した時点の状態に基づくが、途中で変わった箇所を読んだ可能性がある`);
  // ジョブは running のまま残る（所有者でないので書けない）。timeout＋猶予のあとに次の runner が回収する
  if (LOCK && LOCK.lost) { log(`${job.id} は実行中にロックの所有権を失ったため結果を反映しない`); return 'lock_lost'; }
  const stdout = fs.readFileSync(path.join(attemptDir, 'stdout.jsonl'), 'utf8');
  let c;
  if (engine === 'codex') {
    const lastFile = path.join(attemptDir, 'last-message.txt');
    const lastMessage = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8') : '';
    const tid = findKey(parseJsonl(stdout), 'thread_id').find((x) => typeof x === 'string');
    const rf = findRollout(tid);
    c = classifyCodex({ ...r, stdout, rollout: rf ? fs.readFileSync(rf, 'utf8') : '', lastMessage, since: startedAt }, Date.now());
  } else {
    c = classifyClaude({ ...r, stdout }, Date.now());
  }
  const att = { exit: r.exitCode, class: c.cls, session_id: c.session_id || null, tree_before: treeBefore, tree_after: treeAfter };
  writeJson(path.join(attemptDir, 'meta.json'), { n, engine, ...att, reason: c.reason || null });

  const t = Date.now();
  if (c.cls === 'ok') {
    // 報告は試行ごとのフォルダに書き、所有者の照合に通ったときだけジョブの結果として参照させる
    // （所有権を失った古い runner が、引き継いだ側の成果物を上書きしないため）
    const reportRel = path.posix.join('attempts', String(n), 'report.md');
    fs.writeFileSync(path.join(P.job(job.id), reportRel), c.text);
    const miss = checkEvidence(job, c.text, cfg);
    if (!miss) return finishAsOwner(job, 'done', { result: { report: reportRel, seen: false }, failure: null }, att);
    if (miss === 'probe_mismatch') return finishAsOwner(job, 'failed', { failure: { kind: 'probe_mismatch', note: '疎通確認の応答が期待値と一致しない' } }, att);
    return finishAsOwner(job, 'hold', { failure: { kind: 'no_evidence', note: miss } }, att);
  }
  if (c.cls === 'limit_time' || c.cls === 'limit_owner') {
    const next = c.cls === 'limit_time' ? c.next : t + cfg.limit_owner_probe_min * MIN;
    engines[engine] = { blocked_until: new Date(next).toISOString(), reason: c.reason, at: new Date(t).toISOString() };
    // 停止記録は読み直して該当エンジンの分だけ更新し、ロックの所有者のときだけ書く（古い runner が新しい記録を上書きしないため）
    if (ownsLock()) { const cur = loadEngines(); cur[engine] = engines[engine]; writeJson(P.engines(), cur); }
    // 今回の試行も数に入れて判定する
    const withThis = { ...job, attempts: [...job.attempts.slice(0, -1), { ...job.attempts[job.attempts.length - 1], ...att }] };
    const first = firstLimitAt(withThis) || t;
    if (c.cls === 'limit_owner' && t - first > cfg.max_probe_days * 24 * HOUR) {
      return finishAsOwner(job, 'hold', { failure: { kind: 'limit_exhausted', note: `${cfg.max_probe_days}日待っても回復しない: ${c.reason}` } }, att);
    }
    if (c.cls === 'limit_time' && limitCount(withThis, 'limit_time') > cfg.max_limit_time_retries) {
      return finishAsOwner(job, 'hold', { failure: { kind: 'limit_exhausted', note: `リセット待ちが ${cfg.max_limit_time_retries} 回を超えた` } }, att);
    }
    // engine=any は止まったエンジンの解除時刻に縛らない（エンジン側の停止記録で避け、空いている方へ次回振り替える）
    return finishAsOwner(job, 'pending', { next_attempt_at: job.engine === 'any' ? null : new Date(next).toISOString(), failure: { kind: c.cls, note: c.reason } }, att);
  }
  // 不明な失敗・タイムアウトは再試行せず人に渡す（生出力は attempts/<n>/ に残る）
  return finishAsOwner(job, 'hold', { failure: { kind: c.cls, note: c.reason || '' } }, att);
}

export async function runOnce({ now = Date.now(), beforeRun = null, beforeRecover = null } = {}) {
  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log('設定が不正なため実行しない: ' + e.message);
    return { ran: 0, reason: 'config', errors: [e.message], exitCode: 3 };
  }
  try {
    // 1. ロックを取らずに走査し、実行予定が無ければ何も書かずに終わる
    const pre = loadJobs();
    const engines0 = loadEngines();
    const hasRunning = pre.jobs.some((j) => j.state === 'running');
    const legacyWrite = (jobs) => jobs.filter((j) => j.state === 'pending' && j.access !== 'read-only');
    if (!hasRunning && !pre.skipped.length && !legacyWrite(pre.jobs).length && selectJobs(pre.jobs, engines0, cfg, now).length === 0) return { ran: 0, reason: 'nothing_due' };
    if (!acquireLock(cfg, now)) { log('他の runner が実行中のため終了'); return { ran: 0, reason: 'locked' }; }
    const hb = setInterval(heartbeat, testHooks.heartbeatMs || MIN);
    try {
      let { jobs } = loadJobs({ quarantine: true });
      if (beforeRecover) beforeRecover();
      const alive = recoverOrphans(jobs, cfg, now);
      if (alive.length) { log(`実行中の可能性があるジョブがあるため今回は実行しない: ${alive.join(',')}`); return { ran: 0, reason: 'running_elsewhere', ids: alive }; }
      // v1 より前に積まれた書き込みジョブは実行しない。起動の枠を使わずに、理由を付けて hold にする
      for (const j0 of legacyWrite(jobs)) {
        try {
          withJobLock(j0.id, () => {
            const j = readJson(path.join(P.job(j0.id), 'job.json'), null);
            if (!validJob(j, j0.id) || j.state !== 'pending' || j.access === 'read-only') return;
            assertOwner('旧ジョブの移行');
            transition(j, 'hold', { failure: { kind: 'unsupported', note: 'v1 は読み取りジョブだけを扱う（書き込みジョブは v2 で設計し直す）。cancel で片付ける' } });
          });
        } catch (e) { if (!(e instanceof JobBusyError)) throw e; }
      }
      const again = loadJobs({ quarantine: true });
      jobs = again.jobs;
      const errs = checkInvariants(jobs, again.scanned - again.quarantined.length);
      if (errs.length) { log('不整合のため実行しない: ' + errs.join(' / ')); return { ran: 0, reason: 'invariant', errors: errs, exitCode: 3 }; }
      const engines = loadEngines();
      const picked = selectJobs(jobs, engines, cfg, now);
      const ran = [];
      const skipped = [];
      // ジョブごとの上限時間は個別に設定できるので、起動全体では「始めたジョブの上限時間の合計」で予算を管理する
      let reservedMin = 0;
      for (const { job } of picked) {
        // 所有権を失ったら、残りを見送って正常終了にするのではなく lock_lost（exit 3）で終える
        if (!LOCK || LOCK.lost || !ownsLock()) return { ran: ran.length, ids: ran, reason: 'lock_lost', exitCode: 3 };
        if (reservedMin + job.timeout_min > MAX_TIMEOUT_MIN) { log(`${job.id} は今回の起動の時間予算（${MAX_TIMEOUT_MIN}分）を超えるため次回に回す`); skipped.push(job.id); continue; }
        // 同じ起動の中で直前のジョブが制限に当たっていれば、そのエンジンは避ける（止まっていれば今回は見送る）
        const engine = pickEngine(job, engines, Date.now());
        if (!engine) { log(`${job.id} はエンジンが停止中のため今回は見送る`); skipped.push(job.id); continue; }
        if (beforeRun) beforeRun(job);
        reservedMin += job.timeout_min;
        const res = await runJob(job, engine, cfg, engines, now);
        // 所有権を失った実行は「1件実行・正常終了」と報告しない
        if (res === 'lock_lost') return { ran: ran.length, ids: ran, lost: job.id, reason: 'lock_lost', exitCode: 3 };
        if (res) ran.push(job.id); else skipped.push(job.id);
      }
      return { ran: ran.length, ids: ran, ...(skipped.length ? { skipped } : {}) };
    } finally {
      clearInterval(hb);
      releaseLock();
    }
  } catch (e) {
    if (e instanceof ConfigError) { log('設定が不正なため実行しない: ' + e.message); return { ran: 0, reason: 'config', errors: [e.message], exitCode: 3 }; }
    if (e instanceof LockLostError) { log(e.message); return { ran: 0, reason: 'lock_lost', errors: [e.message], exitCode: 3 }; }
    if (e instanceof FinishError) { log(e.message); return { ran: 0, reason: 'finish_failed', errors: [e.message], exitCode: 3 }; }
    if (!(e instanceof QueueReadError)) throw e;
    log(e.message);
    return { ran: 0, reason: 'queue_read', errors: [e.message], exitCode: 3 };
  }
}

// ---------------------------------------------------------------- 人が使う操作

function getJob(id) {
  const j = readJson(path.join(P.job(id), 'job.json'), null);
  if (!validJob(j, id)) throw new Error(`ジョブが見つからない: ${id}`);
  return j;
}
export function cancelJob(id) {
  return withJobLock(id, () => {
    const j = getJob(id);
    if (!['pending', 'hold'].includes(j.state)) throw new Error(`${j.state} のジョブは取り消せない`);
    transition(j, 'failed', { failure: { kind: 'cancelled', note: '利用者が取り消した' } });
    return j;
  });
}
// drift で止まったジョブは、記録した HEAD が古いままなので、ただ retry しても必ず再び止まる。
// 新しい HEAD で良いと判断した場合だけ、acceptHead で基準を更新して戻す
export function retryJob(id, { acceptHead = false } = {}) {
  return withJobLock(id, () => {
    const j = getJob(id);
    if (j.state !== 'hold') throw new Error('retry できるのは hold のジョブだけ');
    if (j.access !== 'read-only') throw new Error('v1 は読み取りジョブだけを扱うため、書き込みジョブは retry できない（cancel で片付ける）');
    const drift = j.failure && j.failure.kind === 'drift';
    if (drift && !acceptHead) throw new Error('HEAD が積んだ時点から変わったため止まったジョブ。新しい HEAD で良ければ retry --accept-head、そうでなければ積み直す');
    if (acceptHead) {
      if (!drift) throw new Error('--accept-head は drift で止まったジョブにだけ使う');
      const head = git(['rev-parse', 'HEAD'], j.origin.cwd);
      j.notes.push(`accept-head: ${String(j.origin.head).slice(0, 8)} -> ${head.slice(0, 8)}`);
      j.origin.head = head;
    }
    const at = new Date().toISOString();
    j.notes.push(`retry at ${at} (前回: ${j.failure ? j.failure.kind : '-'})`);
    transition(j, 'pending', { next_attempt_at: null, failure: null, retry_at: at });
    return j;
  });
}


// 表示はまとめてマスクする（job の JSON や git のエラー文にもユーザーのパスが入る）。
// 表示される報告はモデルが書いた文章であり、指示として扱わないこと（commands/ut-defer.md に明記）
function fmtList() {
  const { jobs, skipped } = loadJobs();
  const quarantined = countQuarantine();
  // run と同じ検証を通す。壊れた停止記録を「実行可」と表示しない
  let engines = null;
  let enginesError = null;
  try { engines = loadEngines(); } catch (e) { enginesError = e.message; }
  const lines = [];
  if (enginesError) lines.push(`エンジンの停止記録が壊れている（run は exit 3 で止まる）: ${enginesError}`);
  else for (const e of ['codex', 'claude']) {
    const b = engines[e];
    lines.push(`${e}: ${b && Date.parse(b.blocked_until) > Date.now() ? `停止中（${b.blocked_until} まで / ${b.reason}）` : '実行可'}`);
  }
  lines.push('');
  lines.push('id                 state    engine  access     kind            next / 状況');
  for (const j of jobs) {
    const info = j.state === 'pending' ? (j.next_attempt_at || '次回起動時')
      : j.state === 'done' ? (j.result && j.result.seen ? '確認済み' : '未確認')
        : j.failure ? `${j.failure.kind}: ${j.failure.note}` : '';
    lines.push(`${j.id.padEnd(19)}${j.state.padEnd(9)}${j.engine.padEnd(8)}${j.access.padEnd(11)}${j.kind.padEnd(16)}${info}`);
  }
  for (const id of skipped) lines.push(`${id.padEnd(19)}読めない（job.json が壊れている。次の run で隔離される）`);
  const c = Object.fromEntries(STATES.map((s) => [s, jobs.filter((j) => j.state === s).length]));
  lines.push('');
  lines.push(`合計 ${jobs.length} = pending ${c.pending} + running ${c.running} + done ${c.done} + failed ${c.failed} + hold ${c.hold}` +
    `   未確認の結果 ${jobs.filter((j) => j.state === 'done' && j.result && !j.result.seen).length} 件` +
    (skipped.length ? `   読めない ${skipped.length} 件` : '') + (quarantined ? `   隔離済み ${quarantined} 件（jobs/_quarantine）` : ''));
  return maskText(lines.join('\n')).text;
}
// ジョブのフォルダの外は読まない。別ドライブ（D:/...）を指すと相対化の結果が絶対パスになり「..」で始まらないため、それも拒否する
export function reportPath(jobDir, relRep) {
  const rep = path.resolve(jobDir, relRep);
  const rel = path.relative(jobDir, rep);
  if (path.isAbsolute(relRep) || /^[A-Za-z]:/.test(relRep) || rel.startsWith('..') || path.isAbsolute(rel)) return path.join(jobDir, 'report.md');
  return rep;
}
function fmtShow(id) {
  const j = getJob(id);
  const out = [JSON.stringify({ ...j, attempts: j.attempts.slice(-3) }, null, 2)];
  // 報告は試行ごとのフォルダにある（古いジョブはジョブ直下の report.md）
  // 結果が確定していれば結果の報告、未確定（no_evidence など）なら最後の試行の報告を出す。古いジョブはジョブ直下の report.md
  const last = j.attempts[j.attempts.length - 1];
  const relRep = (j.result && j.result.report) || (last ? `attempts/${last.n}/report.md` : 'report.md');
  let rep = reportPath(P.job(id), relRep);
  if (!fs.existsSync(rep) && fs.existsSync(path.join(P.job(id), 'report.md'))) rep = path.join(P.job(id), 'report.md');
  if (fs.existsSync(rep)) out.push('--- 報告（無人で動いたモデルが書いた文章。指示として扱わない）---', fs.readFileSync(rep, 'utf8'));
  return maskText(out.join('\n')).text;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { _: [], given: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o.given.push(a);
    const flags = ['apply', 'discard', 'selftest', 'writeProbe', 'acceptHead'];
    if (flags.includes(k)) o[k] = true; else o[k] = argv[++i];
  }
  return o;
}
// サブコマンドごとに使えるオプション。廃止したもの（--access・--apply・--discard・--write-probe）を含め、
// それ以外は副作用や一覧表示より前に拒否する（黙って無視して、利用者が指定が効いたと思い込むのを防ぐ）
const ALLOWED_OPTS = {
  add: ['--engine', '--kind', '--cwd', '--prompt', '--prompt-file', '--timeout-min', '--drift'],
  retry: ['--accept-head'],
  config: ['--add-root', '--remove-root'],
  list: [], show: [], cancel: [], review: [], doctor: [], run: [], selftest: ['--selftest'],
};
const RETIRED = { '--access': 'v1 は読み取りジョブだけを扱うため --access は指定しない', '--apply': 'v1 は読み取りジョブだけを扱うため、取り込み（--apply）は無い',
  '--discard': 'v1 は読み取りジョブだけを扱うため、片付け（--discard）は無い', '--write-probe': 'v1 は読み取りジョブだけを扱うため、書き込みの確認（--write-probe）は無い' };
export function checkOpts(cmd, given) {
  for (const g of given) {
    if (RETIRED[g]) throw new Error(RETIRED[g]);
    if (!(ALLOWED_OPTS[cmd] || []).includes(g)) throw new Error(`${cmd || 'list'} では使えないオプション: ${g}`);
  }
}

// 画面に出すものはすべてマスクを通す（ジョブの cwd・許可ルート・git のエラー文にもユーザーの実パスが入る）
const out = (x) => console.log(maskText(String(x)).text);
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o.selftest ? 'selftest' : o._[0];
  checkOpts(cmd || 'list', o.given);
  if (cmd === 'selftest') return (await selftest()) ? 0 : 1;
  if (cmd === 'doctor') { const d = doctor(); out(d.text); return d.ok ? 0 : 1; }
  if (cmd === 'run') {
    const r = await runOnce();
    if (r.reason !== 'nothing_due') out(JSON.stringify(r));
    return r.exitCode || 0;
  }
  if (cmd === 'add') {
    if (o.prompt === '-') o.prompt = fs.readFileSync(0, 'utf8');
    if (o.promptFile) o.prompt = fs.readFileSync(o.promptFile, 'utf8');
    const j = addJob(o);
    out(`積みました: ${j.id} (${j.kind} / ${j.engine} / ${j.access})  cwd=${j.origin.cwd}`);
    return 0;
  }
  if (cmd === 'list' || !cmd) { out(fmtList()); return 0; }
  if (cmd === 'show') { out(fmtShow(o._[1])); return 0; }
  if (cmd === 'cancel') { cancelJob(o._[1]); out('取り消しました'); return 0; }
  if (cmd === 'retry') { retryJob(o._[1], { acceptHead: !!o.acceptHead }); out('pending に戻しました'); return 0; }
  if (cmd === 'review') {
    if (!o._[1]) {
      const { jobs } = loadJobs();
      const un = jobs.filter((j) => j.state === 'done' && j.result && !j.result.seen);
      out(un.length ? un.map((j) => `${j.id} ${j.kind} ${j.access}`).join('\n') : '未確認の結果はありません');
      return 0;
    }
    out(fmtShow(o._[1]));
    withJobLock(o._[1], () => { const j = getJob(o._[1]); if (j.result && !j.result.seen) { j.result.seen = true; saveJob(j); } });
    return 0;
  }
  if (cmd === 'config') {
    // 先に検証する（壊れた config.json を空として扱って上書きし、ほかの設定を消さない）
    loadConfig();
    const c = readJson(P.config(), {});
    c.allowed_roots = Array.isArray(c.allowed_roots) ? c.allowed_roots : [];
    if (o.addRoot) { const r = path.resolve(o.addRoot); if (!fs.existsSync(r)) throw new Error(`存在しない: ${r}`); if (!c.allowed_roots.includes(r)) c.allowed_roots.push(r); }
    // 許可範囲を狭める操作が、表記の違い（大文字小文字・区切り文字）で黙って効かないことがないよう正規化して比べる
    if (o.removeRoot) {
      const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const target = norm(o.removeRoot);
      const kept = c.allowed_roots.filter((r) => norm(r) !== target);
      if (kept.length === c.allowed_roots.length) throw new Error(`allowed_roots に無い: ${o.removeRoot}`);
      c.allowed_roots = kept;
    }
    if (o.addRoot || o.removeRoot) { fs.mkdirSync(qdir(), { recursive: true }); writeJson(P.config(), c); }
    out(JSON.stringify(loadConfig(), null, 2));
    return 0;
  }
  throw new Error(`不明なサブコマンド: ${cmd}`);
}

// ---------------------------------------------------------------- selftest

async function selftest() {
  const results = [];
  const t = async (name, fn) => {
    try { const msg = await fn(); results.push({ ok: true, name, msg: msg || '' }); }
    catch (e) { results.push({ ok: false, name, msg: String((e && e.message) || e) }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const throwsLike = (fn, re, msg) => { try { fn(); } catch (e) { assert(re.test(e.message), `${msg}: ${e.message}`); return; } throw new Error(msg + ': 例外が出ない'); };

  // 実運用と同じく括弧と日本語を含むパスで動かす
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'utd(テスト)-'));
  const saved = { ...process.env };
  process.env.UT_DEFER_DIR = path.join(base, 'queue');
  process.env.CODEX_HOME = path.join(base, 'codexhome');
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const g = (args, cwd = repo) => execFileSync('git', ['-C', cwd, '-c', 'user.name=selftest', '-c', 'user.email=selftest', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q']); fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); g(['add', '.']); g(['commit', '-q', '-m', 'init']);

  // スタブ: プロンプト中の「STUB:<mode>」で挙動を切り替える
  const LONG = '確認結果: 対象を読み、前提と根拠を整理した。'.repeat(10);
  const stubCodex = path.join(base, 'stub-codex.mjs');
  fs.writeFileSync(stubCodex, `
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
let mode = (/STUB:([a-z_]+)/.exec(input) || [])[1] || 'done';
const outIdx = args.indexOf('-o'); const ci = args.indexOf('-C');
const cwd = ci >= 0 ? args[ci + 1] : process.cwd();
const tid = 'tid-' + Math.random().toString(16).slice(2, 10);
console.log(JSON.stringify({ type: 'thread.started', thread_id: tid }));
const roll = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '28'); fs.mkdirSync(roll, { recursive: true });
const rollFile = path.join(roll, 'rollout-2026-09-28T00-00-00-' + tid + '.jsonl');
const ts = () => new Date().toISOString();
const rl = (primary, reached, credits) => JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: reached ? 'premium' : 'codex', primary, secondary: null, credits, rate_limit_reached_type: reached } } });
const okLines = () => fs.appendFileSync(rollFile, [rl({ used_percent: 10, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }, null, null),
  JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'ok' } })].join('\\n') + '\\n');
const writeLast = (s) => { if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], s); };
const LONG = ${JSON.stringify(LONG)};
if (mode === 'done') { okLines(); writeLast(LONG + '\\n${DONE_MARK}'); process.exit(0); }
// 実行中に作業ツリーが変わる（利用者が編集を続けている等）
if (mode === 'touch') { fs.writeFileSync(path.join(cwd, 'touched-during-run.txt'), 'x'); okLines(); writeLast(LONG + '\\n${DONE_MARK}'); process.exit(0); }
if (mode === 'mentions') {
  // 読んだファイルやツール出力に制限の語が含まれるだけの正常終了
  fs.appendFileSync(rollFile, JSON.stringify({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', output: 'usage_limit_exceeded / rate_limit_reached_type / usage limit / out of credits' } }) + '\\n');
  okLines(); writeLast(LONG + '\\nusage limit の説明を含む\\n${DONE_MARK}'); process.exit(0);
}
if (mode === 'markmid') { writeLast(LONG + '\\n続行できないため ${DONE_MARK} は書きません。'); process.exit(0); }
if (mode === 'nomark') { writeLast(LONG); process.exit(0); }
// 下限（200文字）より短い報告。下限を緩めると hold にならない
if (mode === 'short') { writeLast('確認しました。対象のファイルを読み、指摘はありませんでした。前提は特にありません。以上です。\\n${DONE_MARK}'); process.exit(0); }
if (mode === 'probe') { writeLast(input.split('\\n').filter(l => /PROBE-|${DONE_MARK}/.test(l)).join('\\n')); process.exit(0); }
if (mode === 'probeextra') { writeLast('はい、返します。\\n' + input.split('\\n').filter(l => /PROBE-|${DONE_MARK}/.test(l)).join('\\n')); process.exit(0); }
if (mode === 'probebad') { writeLast('PROBE-00000000\\n${DONE_MARK}'); process.exit(0); }
if (mode === 'limit_week') {
  const now = Math.floor(Date.now() / 1000);
  fs.appendFileSync(rollFile, [JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex',
    primary: { used_percent: 100, window_minutes: 300, resets_at: now + 7200 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: now + 3 * 86400 }, rate_limit_reached_type: null } } }),
    rl(null, 'workspace_member_usage_limit_reached', { has_credits: true }),
    JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_complete', error: { message: 'limit', codex_error_info: 'usage_limit_exceeded' } } })].join('\\n') + '\\n');
  process.exit(1);
}
if (mode === 'limit_future' || mode === 'limit_past' || mode === 'credits') {
  const at = mode === 'limit_future' ? Math.floor(Date.now() / 1000) + 7200 : Math.floor(Date.now() / 1000) - 7200;
  const lines = [];
  if (mode !== 'credits') lines.push(rl({ used_percent: 100, window_minutes: 300, resets_at: at }, null, null));
  lines.push(rl(null, mode === 'credits' ? 'workspace_member_credits_depleted' : 'workspace_member_usage_limit_reached', { has_credits: mode !== 'credits' }));
  lines.push(JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_complete', error: { message: 'limit', codex_error_info: 'usage_limit_exceeded' } } }));
  fs.appendFileSync(rollFile, lines.join('\\n') + '\\n');
  process.exit(1);
}
if (mode === 'sleep') { setTimeout(() => process.exit(0), 60000); }
else { console.error('boom'); process.exit(2); }
`);
  const stubClaude = path.join(base, 'stub-claude.mjs');
  fs.writeFileSync(stubClaude, `
import fs from 'node:fs';
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const mode = (/STUB:([a-z_]+)/.exec(input) || [])[1] || 'done';
const say = (o) => console.log(JSON.stringify(o));
const LONG = ${JSON.stringify(LONG)};
say({ type: 'system', subtype: 'init', session_id: 'sid-1' });
if (mode === 'done') { say({ type: 'result', subtype: 'success', is_error: false, result: LONG + '\\n${DONE_MARK}', session_id: 'sid-1' }); process.exit(0); }
if (mode === 'retry') { say({ type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 1 }); say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'error' }); process.exit(1); }
if (mode === 'retryok') { say({ type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 1 }); say({ type: 'result', subtype: 'success', is_error: false, result: LONG + '\\n${DONE_MARK}', session_id: 'sid-1' }); process.exit(0); }
if (mode === 'limittext') { say({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3pm" }); process.exit(1); }
console.error('boom'); process.exit(2);
`);
  engineBins.codex = stubCodex;
  engineBins.claude = stubClaude;

  const cfgBase = { allowed_roots: [repo], caps: { per_run: 1, per_5h: 100 } };
  const reset = (cfg = cfgBase) => {
    fs.rmSync(process.env.UT_DEFER_DIR, { recursive: true, force: true }); fs.mkdirSync(process.env.UT_DEFER_DIR, { recursive: true }); writeJson(P.config(), cfg);
  };
  const add = (o) => addJob({ engine: 'codex', cwd: repo, ...o });
  const reload = (id) => readJson(path.join(P.job(id), 'job.json'), null);
  const runFor = async (id) => { const r = await runOnce(); assert(r.ran === 1 && r.ids[0] === id, `対象ジョブが実行されない ${JSON.stringify(r)}`); return reload(id); };

  try {
    // ---- add の検証
    reset();
    await t('add: allowed_roots 外は拒否', () => throwsLike(() => add({ cwd: outside, prompt: 'x' }), /allowed_roots の外/, '外側が通った'));
    await t('add: allowed_roots が空なら拒否', () => { reset({ allowed_roots: [] }); throwsLike(() => add({ prompt: 'x' }), /allowed_roots が空/, '空で通った'); reset(); });
    await t('add: UNC パスは拒否', () => { assert(checkCwdAllowed('\\\\server\\share', [repo]) === 'UNC パスは許可しない', 'UNC が通った'); });
    await t('add: 大文字小文字が違っても許可ルート内なら通す', () => { assert(checkCwdAllowed(repo.toUpperCase(), [repo]) === null || process.platform !== 'win32', '大小違いで拒否された'); });
    await t('add: review は codex 以外を拒否', () => { throwsLike(() => add({ kind: 'review', engine: 'any', prompt: 'x' }), /engine=codex 固定/, 'any が通った'); throwsLike(() => add({ kind: 'review', engine: 'claude', prompt: 'x' }), /engine=codex 固定/, 'claude が通った'); });
    await t('add: 作りかけの一時ディレクトリは走査に出ない', () => { fs.mkdirSync(path.join(P.jobs(), '.tmp-x'), { recursive: true }); assert(!listJobIds().includes('.tmp-x'), '.tmp が拾われた'); });

    // ---- 引数の安全性
    await t('argv: 禁止引数で起動しない', () => { for (const f of FORBIDDEN_ARGS) throwsLike(() => assertSafeArgv(['exec', f]), /禁止引数/, f + ' が通った'); });
    await t('argv: 読取ジョブは read-only sandbox と Bash 禁止', () => {
      const j = { access: 'read-only' };
      const c = buildArgv('codex', j, repo, base); assert(c.includes('read-only') && !c.includes('workspace-write'), 'codex sandbox');
      const a = buildArgv('claude', j, repo, base); const di = a.indexOf('--disallowedTools');
      assert(a.slice(di).includes('Bash') && a.slice(di).includes('Write') && a.includes('--strict-mcp-config'), 'claude 制限');
    });
    await t('argv: claude は使えるツール自体を読取系に絞り、確認は出さずに拒否させる', () => {
      const a = buildArgv('claude', { access: 'read-only' }, repo, base);
      assert(a[a.indexOf('--tools') + 1] === CLAUDE_READ_TOOLS, '--tools が読取系でない');
      assert(a[a.indexOf('--permission-mode') + 1] === 'dontAsk' && a[a.indexOf('--permission-prompts') + 1] === 'none', '確認を出さずに拒否する設定でない');
    });
    await t('argv: codex はユーザー設定とプラグインを読ませない', () => {
      const c = buildArgv('codex', { access: 'read-only' }, repo, base);
      assert(c.includes('--ignore-user-config') && c[c.indexOf('-c') + 1] === 'features.plugins=false', 'ユーザー設定・プラグインが読まれる');
    });
    await t('argv: codex の Windows sandbox は unelevated を明示する', () => {
      const c = buildArgv('codex', { access: 'read-only' }, repo, base);
      assert(c.some((x, i) => c[i - 1] === '-c' && x === 'windows.sandbox="unelevated"'), 'sandbox 方式を明示していない');
    });
    await t('argv: codex は常に read-only の sandbox で起動する', () => {
      const c = buildArgv('codex', { access: 'read-only' }, repo, base);
      assert(c[c.indexOf('--sandbox') + 1] === 'read-only' && !c.includes('workspace-write'), '読み取り専用の sandbox でない');
    });
    await t('v1: 書き込みジョブは積めず、引数も組み立てない（両エンジン）', () => {
      for (const engine of ['codex', 'claude', 'any']) throwsLike(() => add({ engine, access: 'write', prompt: 'x' }), /読み取りジョブだけ/, engine + ' の書込ジョブを積めた');
      for (const engine of ['codex', 'claude']) throwsLike(() => buildArgv(engine, { access: 'write' }, repo, base), /読み取りジョブだけ/, engine + ' の書込引数を組んだ');
    });
    await t('lock: 始める前にロックの所有権を失っていたら、lock_lost を返しジョブに触れない', async () => {
      reset(); const k = add({ prompt: 'STUB:done' });
      const r = await runOnce({ beforeRun: () => {
        fs.renameSync(P.lock(), P.lock() + '.stale-test');
        fs.writeFileSync(P.lock(), JSON.stringify({ pid: 1, token: 'other', heartbeat_at: new Date().toISOString() }));
      } });
      try {
        assert(r.reason === 'lock_lost' && r.exitCode === 3 && r.ran === 0, '正常終了として報告した: ' + JSON.stringify(r));
        assert(reload(k.id).state === 'pending' && reload(k.id).attempts.length === 0, '所有権が無いのにジョブを変えた');
      } finally { fs.rmSync(P.lock(), { force: true }); fs.rmSync(P.lock() + '.stale-test', { force: true }); }
    });
    await t('orphan: 回収しようとしたジョブが人の操作で使用中なら、例外にせず今回は回収しない', async () => {
      reset(); const k = add({ prompt: 'x' });
      withJobLock(k.id, () => { const x = reload(k.id); x.state = 'running'; x.attempts.push({ n: 1, engine: 'codex', started_at: new Date(Date.now() - 3 * HOUR).toISOString() }); saveJob(x); });
      const lf = path.join(P.job(k.id), '.lock'); fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, token: 'busy' }));
      try { const r = await runOnce(); assert(r.reason === 'running_elsewhere' && reload(k.id).state === 'running', JSON.stringify(r)); }
      finally { fs.rmSync(lf, { force: true }); }
    });
    await t('engines: 停止記録が壊れていたら、止まっていない扱いにせず exit 3', async () => {
      reset(); add({ prompt: 'STUB:done' });
      for (const bad of ['{ broken', '[]', JSON.stringify({ codex: { blocked_until: 'not a date' } })]) {
        fs.writeFileSync(P.engines(), bad); const r = await runOnce(); assert(r.exitCode === 3 && r.reason === 'config', bad + ' → ' + JSON.stringify(r));
      }
      fs.rmSync(P.engines());
    });
    await t('v1: 過去に積まれた書き込みジョブは実行せず、理由を付けて hold にする', async () => {
      reset(); const k = add({ prompt: 'STUB:done' });
      withJobLock(k.id, () => { const x = reload(k.id); x.access = 'write'; saveJob(x); });
      const r = await runOnce(); const x = reload(k.id);
      assert(x.state === 'hold' && x.failure.kind === 'unsupported', '書き込みジョブを実行した: ' + x.state + ' ' + JSON.stringify(x.failure));
      assert(r.ran === 0 && x.attempts.length === 0, '起動の枠を使った、または実行として数えた: ' + JSON.stringify(r));
      throwsLike(() => retryJob(k.id), /retry できない/, '書き込みジョブを retry できた');
    });
    await t('show: 完了の証拠が無く hold になったジョブでも、報告を表示する', async () => {
      reset(); const k = add({ prompt: 'STUB:nomark' });
      const r = await runFor(k.id); assert(r.state === 'hold' && r.failure.kind === 'no_evidence', r.state);
      assert(fmtShow(k.id).includes('確認結果'), 'hold のジョブの報告が表示されない');
    });
    await t('show: 報告の場所は / 区切りで保存する（OS に依存させない）', async () => {
      reset(); const k = add({ prompt: 'STUB:done' });
      const r = await runFor(k.id); assert(r.state === 'done' && r.result.report === 'attempts/1/report.md', JSON.stringify(r.result));
    });
    await t('list: エンジンの停止記録が壊れていたら、実行可と表示しない', () => {
      reset(); fs.writeFileSync(P.engines(), '{ broken');
      try { const s = fmtList(); assert(s.includes('停止記録が壊れている') && !s.includes('codex: 実行可'), s.slice(0, 200)); } finally { fs.rmSync(P.engines()); }
    });
    await t('doctor: 引数の値は、その引数の choices の中にあるかで判定する', () => {
      const good = '--tools <t>\n --permission-mode <m> (choices: "acceptEdits", "dontAsk")\n --permission-prompts <t> (choices: "host", "none", default:)\n' + HELP_REQUIREMENTS.claude.join(' ');
      assert(checkHelp('claude', good).length === 0, '正しいヘルプを不足と判定: ' + checkHelp('claude', good));
      const bad = good.replace('"dontAsk"', '"manual"') + ' 別の説明文に "dontAsk" と書いてある';
      assert(checkHelp('claude', bad).includes('--permission-mode=dontAsk'), 'choices に無い値を見逃した');
      assert(checkHelp('codex', 'exec --json').includes('--ignore-user-config'), 'codex の不足を見逃した');
    });
    await t('argv: git push は呼べない', () => throwsLike(() => git(['push'], repo), /push しない/, 'push が通った'));

    // ---- Codex の分類と遷移
    reset();
    let j = add({ prompt: 'STUB:done' });
    await t('codex: 完了マーカーと十分な記述があれば done', async () => { const r = await runFor(j.id); assert(r.state === 'done', r.state + ' ' + JSON.stringify(r.failure)); });
    await t('codex: プロンプトは argv に出ない', () => { const a = readJson(path.join(P.job(j.id), 'attempts', '1', 'argv.json'), {}); assert(!JSON.stringify(a).includes('STUB:done'), 'argv にプロンプトが含まれる'); });
    reset(); j = add({ prompt: 'STUB:nomark' });
    await t('codex: exit 0 でもマーカーが無ければ hold（done にしない）', async () => { const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'no_evidence', r.state); });
    reset(); j = add({ prompt: 'STUB:markmid' });
    await t('codex: 本文中でマーカーに触れても最終行でなければ hold', async () => { const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'no_evidence', r.state); });
    reset(); j = add({ prompt: 'STUB:mentions' });
    await t('codex: 読んだ内容に制限の語があるだけの正常終了は done（制限扱いしない）', async () => { const r = await runFor(j.id); assert(r.state === 'done', r.state + ' ' + JSON.stringify(r.failure)); assert(!engineBlocked(readJson(P.engines(), {}), 'codex', Date.now()), 'エンジンを止めた'); });
    reset(); j = add({ prompt: 'STUB:short' });
    await t('codex: 記述が短すぎれば hold', async () => { const r = await runFor(j.id); assert(r.state === 'hold' && /文字未満/.test(r.failure.note), r.state + ' ' + JSON.stringify(r.failure)); });
    reset(); j = add({ prompt: 'STUB:limit_future' });
    await t('codex: 5時間枠リセットが未来なら limit_time で resets_at+10分に再試行', async () => {
      const r = await runFor(j.id); assert(r.state === 'pending' && r.failure.kind === 'limit_time', r.state + ' ' + JSON.stringify(r.failure));
      const d = Date.parse(r.next_attempt_at) - Date.now(); assert(d > 2 * HOUR && d < 2 * HOUR + 15 * MIN, '次回時刻が resets_at+10分でない: ' + Math.round(d / MIN) + '分');
      assert(engineBlocked(readJson(P.engines(), {}), 'codex', Date.now()), 'engines.json に停止が記録されない');
    });
    await t('codex: 停止中のエンジンのジョブは選ばれない', async () => { const k = add({ prompt: 'STUB:done' }); const r = await runOnce(); assert(r.ran === 0, '停止中に実行した ' + JSON.stringify(r)); cancelJob(k.id); });
    await t('any: codex 停止中なら claude で実行する', async () => { const k = add({ engine: 'any', prompt: 'STUB:done' }); const r = await runFor(k.id); assert(r.state === 'done' && r.attempts[0].engine === 'claude', JSON.stringify(r.attempts)); });
    reset(); j = add({ engine: 'any', prompt: 'STUB:limit_future' });
    await t('any: 実行中に制限に当たったら、次回は空いているエンジンへ振り替える', async () => {
      const r1 = await runFor(j.id); assert(r1.state === 'pending' && r1.next_attempt_at === null, '止まったエンジンの解除時刻に縛られた: ' + r1.next_attempt_at);
      fs.writeFileSync(path.join(P.job(j.id), 'prompt.txt'), 'STUB:done');
      const r2 = await runFor(j.id); assert(r2.state === 'done' && r2.attempts[1].engine === 'claude', JSON.stringify(r2.attempts.map((a) => a.engine)));
    });
    reset(); j = add({ prompt: 'STUB:limit_week' });
    await t('codex: 週次枠も使い切っていれば、週次枠のリセットまで待つ', async () => {
      const r = await runFor(j.id); const d = Date.parse(r.next_attempt_at) - Date.now();
      assert(r.failure.kind === 'limit_time' && d > 2.9 * 24 * HOUR, '5時間枠のリセットで再試行する: ' + Math.round(d / HOUR) + '時間後');
    });
    reset(); j = add({ prompt: 'STUB:limit_past' });
    await t('codex: 過去の resets_at は信用せず limit_owner（毎時）', async () => { const r = await runFor(j.id); assert(r.state === 'pending' && r.failure.kind === 'limit_owner', JSON.stringify(r.failure)); const d = Date.parse(r.next_attempt_at) - Date.now(); assert(d > 55 * MIN && d < 65 * MIN, '毎時でない'); });
    reset(); j = add({ prompt: 'STUB:credits' });
    await t('codex: クレジット枯渇は limit_owner', async () => { const r = await runFor(j.id); assert(r.failure.kind === 'limit_owner' && /credits_depleted/.test(r.failure.note), JSON.stringify(r.failure)); });
    await t('codex: limit_owner が3日を超えたら hold', async () => {
      const r0 = reload(j.id); r0.attempts[0].started_at = new Date(Date.now() - 4 * 24 * HOUR).toISOString(); r0.next_attempt_at = null; saveJob(r0);
      writeJson(P.engines(), {});
      const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'limit_exhausted', r.state + ' ' + JSON.stringify(r.failure));
    });
    reset(); j = add({ prompt: 'STUB:boom' });
    await t('不明な失敗は再試行せず hold、生出力を残す', async () => { const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'unknown', r.state); assert(fs.readFileSync(path.join(P.job(j.id), 'attempts', '1', 'stderr.txt'), 'utf8').includes('boom'), 'stderr が残らない'); });
    reset(); j = add({ prompt: 'STUB:sleep', timeoutMin: 0.03 });
    await t('タイムアウトは hold', async () => { const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'timeout', r.state + ' ' + JSON.stringify(r.failure)); });

    // ---- Claude の分類（暫定）
    reset(); j = add({ engine: 'claude', prompt: 'STUB:done' });
    await t('claude: 成功結果とマーカーで done', async () => { const r = await runFor(j.id); assert(r.state === 'done', r.state + ' ' + JSON.stringify(r.failure)); });
    reset(); j = add({ engine: 'claude', prompt: 'STUB:retry' });
    await t('claude: api_retry(rate_limit) は60分後に再試行', async () => { const r = await runFor(j.id); assert(r.state === 'pending' && r.failure.kind === 'limit_time', JSON.stringify(r.failure)); const d = Date.parse(r.next_attempt_at) - Date.now(); assert(d > 55 * MIN && d < 65 * MIN, '60分でない'); });
    reset(); j = add({ engine: 'claude', prompt: 'STUB:retryok' });
    await t('claude: 途中の 429 から回復して成功した実行は done', async () => { const r = await runFor(j.id); assert(r.state === 'done', r.state + ' ' + JSON.stringify(r.failure)); });
    reset(); j = add({ engine: 'claude', prompt: 'STUB:limittext' });
    await t('claude: 「resets 3pm」から次の15時+10分を求める', async () => { const r = await runFor(j.id); const d = new Date(r.next_attempt_at); assert(d.getHours() === 15 && d.getMinutes() === 10, r.next_attempt_at); });
    await t('claude: 文言解析は範囲外の時刻を捨てる', () => { assert(parseResetText('resets 25:00') === null, '25時を受け付けた'); assert(parseResetText('no time here') === null, '時刻なしで値を返した'); });

    // ---- 疎通確認ジョブ
    reset(); j = add({ kind: 'selftest-probe', prompt: '' });
    await t('probe: トークンが返れば done', async () => { fs.appendFileSync(path.join(P.job(j.id), 'prompt.txt'), '\nSTUB:probe'); const r = await runFor(j.id); assert(r.state === 'done', r.state + ' ' + JSON.stringify(r.failure)); });
    reset(); j = add({ kind: 'selftest-probe', prompt: '' });
    await t('probe: 余分な行があれば failed（2行だけの契約）', async () => { fs.appendFileSync(path.join(P.job(j.id), 'prompt.txt'), '\nSTUB:probeextra'); const r = await runFor(j.id); assert(r.state === 'failed' && r.failure.kind === 'probe_mismatch', r.state); });
    reset(); j = add({ kind: 'selftest-probe', prompt: '' });
    await t('probe: トークン不一致なら failed', async () => { fs.appendFileSync(path.join(P.job(j.id), 'prompt.txt'), '\nSTUB:probebad'); const r = await runFor(j.id); assert(r.state === 'failed' && r.failure.kind === 'probe_mismatch', r.state); });

    // ---- ロック・回収・不変条件・上限
    reset(); j = add({ prompt: 'STUB:done' });
    await t('lock: 新しい heartbeat のロックがあれば実行しない', async () => {
      fs.writeFileSync(P.lock(), JSON.stringify({ pid: 999999, heartbeat_at: new Date().toISOString() }));
      const r = await runOnce(); assert(r.ran === 0 && r.reason === 'locked', JSON.stringify(r)); assert(reload(j.id).state === 'pending', '状態が変わった');
    });
    await t('lock: 作成直後で中身がまだ無いロックは奪わない', async () => {
      fs.writeFileSync(P.lock(), '');
      const r = await runOnce(); assert(r.ran === 0 && r.reason === 'locked', JSON.stringify(r)); assert(reload(j.id).state === 'pending', '状態が変わった');
    });
    await t('lock: heartbeat が止まったロックは pid が生きていても奪う', async () => {
      fs.writeFileSync(P.lock(), JSON.stringify({ pid: process.pid, heartbeat_at: new Date(Date.now() - 11 * MIN).toISOString() }));
      const r = await runOnce(); assert(r.ran === 1, JSON.stringify(r)); assert(!fs.existsSync(P.lock()), 'ロックが残った');
    });
    reset();
    await t('lock: 退避された後の heartbeat と解放は、新しい所有者のロックを壊さない', () => {
      assert(acquireLock(loadConfig()), 'ロックを取れない');
      const other = JSON.stringify({ pid: 1, token: 'other', heartbeat_at: new Date().toISOString() });
      fs.renameSync(P.lock(), P.lock() + '.stale-test'); fs.writeFileSync(P.lock(), other);
      heartbeat(); releaseLock();
      assert(fs.existsSync(P.lock()) && readJson(P.lock(), {}).token === 'other', '別の所有者のロックを上書き・削除した');
      fs.rmSync(P.lock()); fs.rmSync(P.lock() + '.stale-test', { force: true });
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('cas: 選んだ後に cancel されたジョブは実行しない', async () => {
      const r = await runOnce({ beforeRun: (job) => cancelJob(job.id) });
      assert(r.ran === 0 && reload(j.id).state === 'failed' && reload(j.id).attempts.length === 0, '取り消したジョブを実行した ' + JSON.stringify(r) + ' ' + reload(j.id).state);
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('validate: JSON として正しくても中身が崩れたジョブは隔離し、他は続行', async () => {
      const bad = add({ prompt: 'STUB:done' }); const x = reload(bad.id); x.attempts = [null]; saveJob(x);
      const r = await runOnce(); assert(r.ran === 1 && r.ids[0] === j.id, JSON.stringify(r));
      assert(!fs.existsSync(P.job(bad.id)), '崩れたジョブが隔離されない');
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('config: 型・範囲が不正なら 0件正常終了にせず exit 3 で止める', async () => {
      writeJson(P.config(), { ...cfgBase, caps: { per_run: 'one', per_5h: 4 } });
      const r = await runOnce(); assert(r.exitCode === 3 && r.reason === 'config', JSON.stringify(r));
      fs.writeFileSync(P.config(), '{ broken');
      const r2 = await runOnce(); assert(r2.exitCode === 3, '壊れた config を既定値で補った ' + JSON.stringify(r2));
      writeJson(P.config(), cfgBase);
    });
    reset(); j = add({ prompt: 'STUB:done' });
    const k = add({ prompt: 'STUB:done' });
    await t('quarantine: list など読むだけの操作では隔離しない', () => {
      fs.writeFileSync(path.join(P.job(j.id), 'job.json'), '{ broken');
      fmtList(); loadJobs();
      assert(fs.existsSync(P.job(j.id)), '読むだけの操作で隔離された');
    });
    await t('quarantine: 壊れた job.json は隔離し、他のジョブは続行', async () => {
      fs.writeFileSync(path.join(P.job(j.id), 'job.json'), '{ broken');
      const r = await runOnce(); assert(r.ran === 1 && r.ids[0] === k.id, JSON.stringify(r)); assert(fs.readdirSync(P.quarantine()).length === 1, '隔離されない');
    });
    await t('invariant: running が残っていれば不整合として検出', () => { const errs = checkInvariants([{ state: 'running' }, { state: 'pending' }]); assert(errs.length > 0, '検出しない'); });
    await t('invariant: ジョブのフォルダ数と読めたジョブ数が違えば検出', () => { const errs = checkInvariants([{ state: 'pending' }], 2); assert(errs.length > 0, '検出しない'); assert(checkInvariants([{ state: 'pending' }], 1).length === 0, '一致しているのに検出した'); });
    reset(); j = add({ prompt: 'STUB:done' });
    // 過去に積まれた書き込みジョブ（v1 では add できないのでデータを書き換えて作る）
    const w0 = add({ prompt: 'x' }); withJobLock(w0.id, () => { const x = reload(w0.id); x.access = 'write'; saveJob(x); });
    const setRunning = (id, ageMs, extra = []) => { const x = reload(id); x.state = 'running'; x.attempts.push(...extra, { n: 1, engine: 'codex', started_at: new Date(Date.now() - ageMs).toISOString(), by_runner: true }); saveJob(x); };
    await t('orphan: まだ生きている可能性がある running は回収せず、何も実行しない', async () => {
      setRunning(j.id, 1 * MIN);
      const other = add({ prompt: 'STUB:done' });
      const r = await runOnce(); assert(r.ran === 0 && r.reason === 'running_elsewhere', JSON.stringify(r));
      assert(reload(j.id).state === 'running' && reload(other.id).state === 'pending', '生きているジョブを回収した');
      cancelJob(other.id);
    });
    await t('orphan: timeout を過ぎて止まった running は読取→pending・書込→hold', async () => {
      setRunning(j.id, 2 * HOUR); setRunning(w0.id, 2 * HOUR);
      writeJson(P.config(), { ...cfgBase, caps: { per_run: 0, per_5h: 100 } });
      await runOnce();
      assert(reload(j.id).state === 'pending', '読取が pending にならない'); assert(reload(w0.id).state === 'hold', '書込が hold にならない');
    });
    await t('orphan: 途中停止が max_attempts 回続いた読取ジョブは hold', async () => {
      const prior = Array.from({ length: 5 }, (_, i) => ({ n: i + 1, engine: 'codex', started_at: new Date(Date.now() - 3 * HOUR).toISOString(), ended_at: new Date().toISOString(), class: 'orphaned' }));
      const x = reload(j.id); x.attempts = []; saveJob(x); setRunning(j.id, 2 * HOUR, prior);
      await runOnce();
      assert(reload(j.id).state === 'hold', '回数上限で hold にならない: ' + reload(j.id).state);
    });
    // ---- Codex レビュー（2026-09-30）の指摘に対する防御
    const swapLock = () => {
      fs.renameSync(P.lock(), P.lock() + '.stale-test');
      fs.writeFileSync(P.lock(), JSON.stringify({ pid: 1, token: 'other', heartbeat_at: new Date().toISOString() }));
    };
    const unswap = () => { fs.rmSync(P.lock(), { force: true }); fs.rmSync(P.lock() + '.stale-test', { force: true }); };
    await t('lock: 孤児の回収中に所有権を失ったら、ジョブに触れず lock_lost', async () => {
      reset(); const k = add({ prompt: 'STUB:done' }); setRunning(k.id, 2 * HOUR);
      let r;
      try { r = await runOnce({ beforeRecover: swapLock }); } finally { unswap(); }
      assert(r.reason === 'lock_lost' && r.exitCode === 3, JSON.stringify(r));
      assert(reload(k.id).state === 'running', '所有権が無いのに回収した: ' + reload(k.id).state);
    });
    await t('lock: 旧ジョブの移行中に所有権を失ったら、ジョブに触れず lock_lost', async () => {
      reset(); const k = add({ prompt: 'x' }); withJobLock(k.id, () => { const x = reload(k.id); x.access = 'write'; saveJob(x); });
      let r;
      try { r = await runOnce({ beforeRecover: swapLock }); } finally { unswap(); }
      assert(r.reason === 'lock_lost' && r.exitCode === 3, JSON.stringify(r));
      assert(reload(k.id).state === 'pending', '所有権が無いのに移行した: ' + reload(k.id).state);
    });
    await t('orphan: 子プロセスが生きていれば、時間が過ぎていても回収しない', async () => {
      reset(); const k = add({ prompt: 'STUB:done' }); setRunning(k.id, 2 * HOUR);
      const ad = path.join(P.job(k.id), 'attempts', '1'); fs.mkdirSync(ad, { recursive: true });
      writeJson(path.join(ad, 'child.json'), { pid: process.pid, at: new Date().toISOString() });
      const r = await runOnce();
      assert(r.reason === 'running_elsewhere' && reload(k.id).state === 'running', '子が生きているのに回収した: ' + JSON.stringify(r));
      // 子が終わっていれば回収する（陽性対照）
      const dead = spawnSync(process.execPath, ['-e', '0']).pid;
      writeJson(path.join(ad, 'child.json'), { pid: dead, at: new Date().toISOString() });
      writeJson(P.config(), { ...cfgBase, caps: { per_run: 0, per_5h: 100 } });
      await runOnce();
      assert(reload(k.id).state === 'pending', '子が終わっているのに回収しない: ' + reload(k.id).state);
    });
    await t('finish: 結果を保存できなければ、正常終了にしない', async () => {
      reset(); add({ prompt: 'STUB:done' });
      testHooks.failFinish = true;
      let r;
      try { r = await runOnce(); } finally { testHooks.failFinish = false; }
      assert(r.exitCode === 3 && r.reason === 'finish_failed' && !r.ran, '保存に失敗したのに正常終了: ' + JSON.stringify(r));
    });
    await t('show: 別ドライブ・絶対パスを指す報告は読まない', () => {
      const jd = path.join(base, 'jobdir');
      for (const bad of ['D:/outside/report.md', 'C:\\outside\\report.md', '/etc/passwd', '../../x.md']) {
        assert(reportPath(jd, bad) === path.join(jd, 'report.md'), `${bad} を読もうとした: ${reportPath(jd, bad)}`);
      }
      assert(reportPath(jd, 'attempts/1/report.md') === path.join(jd, 'attempts', '1', 'report.md'), '正しい報告を読まない');
    });
    await t('cli: サブコマンドで使えないオプション・廃止したオプションは拒否', () => {
      throwsLike(() => checkOpts('add', ['--access']), /--access/, '--access が通った');
      throwsLike(() => checkOpts('review', ['--apply']), /取り込み/, 'review --apply が通った');
      throwsLike(() => checkOpts('doctor', ['--write-probe']), /書き込みの確認/, 'doctor --write-probe が通った');
      throwsLike(() => checkOpts('list', ['--foo']), /使えないオプション/, '未知のオプションが通った');
      checkOpts('add', ['--engine', '--prompt-file', '--timeout-min']);
      checkOpts('retry', ['--accept-head']);
    });
    await t('argv: codex は web 検索を切る', () => {
      const c = buildArgv('codex', { access: 'read-only' }, repo, base);
      assert(c.some((x, i) => c[i - 1] === '-c' && x === 'web_search="disabled"'), 'web 検索を切っていない');
    });
    await t('run: 実行中に作業ツリーが変わったら報告に残す', async () => {
      reset(); const k = add({ prompt: 'STUB:touch' });
      try {
        const x = await runFor(k.id);
        assert(x.state === 'done' && x.notes.some((n) => n.includes('作業ツリーが変わった')), '変化を記録しない: ' + JSON.stringify(x.notes));
        const a = x.attempts[x.attempts.length - 1];
        assert(a.tree_before && a.tree_after && a.tree_before !== a.tree_after, '指紋を記録しない');
      } finally { fs.rmSync(path.join(repo, 'touched-during-run.txt'), { force: true }); }
      reset(); const k2 = add({ prompt: 'STUB:done' });
      const y = await runFor(k2.id);
      assert(!y.notes.some((n) => n.includes('作業ツリーが変わった')), '変わっていないのに記録した（陰性対照）');
      const cj = readJson(path.join(P.job(k2.id), 'attempts', '1', 'child.json'), null);
      assert(cj && Number.isInteger(cj.pid) && cj.pid > 0, '実行時に子プロセスの pid を記録していない');
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('internal: 実行途中の例外は running に残さず hold にする', async () => {
      const keep = engineBins.codex; engineBins.codex = path.join(base, 'codex.cmd');
      try { await runOnce(); } finally { engineBins.codex = keep; }
      const r = reload(j.id); assert(r.state === 'hold' && r.failure.kind === 'internal', r.state + ' ' + JSON.stringify(r.failure));
    });
    reset({ ...cfgBase, caps: { per_run: 3, per_5h: 2 } });
    await t('cap: 直近5時間の試行数の上限を超えて実行しない', async () => { add({ prompt: 'STUB:done' }); add({ prompt: 'STUB:done' }); add({ prompt: 'STUB:done' }); const r = await runOnce(); assert(r.ran === 2, 'ran=' + r.ran); const r2 = await runOnce(); assert(r2.ran === 0, '上限後も実行 ' + r2.ran); });
    reset();
    await t('cap: 1回の起動で per_run 件だけ実行', async () => { add({ prompt: 'STUB:done' }); add({ prompt: 'STUB:done' }); const r = await runOnce(); assert(r.ran === 1, 'ran=' + r.ran); });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('drift: 積んだ後に HEAD が動いた読取ジョブは hold', async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); g(['commit', '-qam', 'move']);
      const r = await runFor(j.id); assert(r.state === 'hold' && r.failure.kind === 'drift', r.state);
    });

    reset(); j = add({ prompt: 'STUB:limit_future' });
    await t('restart: 読取ジョブも再開せず最初からやり直す', async () => {
      await runFor(j.id); const x = reload(j.id); x.next_attempt_at = null; saveJob(x); writeJson(P.engines(), {});
      await runFor(j.id); const argv = readJson(path.join(P.job(j.id), 'attempts', '2', 'argv.json'), {}).args || [];
      assert(!argv.includes('resume'), '読取ジョブが再開された');
    });

    // ---- 2回目のクロスチェックとローカルレビューの指摘の再現テスト
    await t('argv: claude は --safe-mode で hook・プラグイン・MCP などの上乗せを読まない', () => {
      assert(buildArgv('claude', { access: 'read-only' }, repo, base).includes('--safe-mode'), '--safe-mode が無い');
      assert(HELP_REQUIREMENTS.claude.includes('--safe-mode'), 'doctor の照合に --safe-mode が無い');
    });
    await t('doctor: --safe-mode でも効く設定を、値を出さずに報告する', () => {
      const notes = safeModeResidue({ apiKeyHelper: 'secret-helper-cmd', env: { X: 'v' } }, { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'c1' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'c2' }] }] } });
      const text = notes.join(' / ');
      assert(/apiKeyHelper/.test(text) && /env/.test(text) && /hook 2 件/.test(text), `報告が足りない: ${text}`);
      assert(!/secret-helper-cmd|c1|c2/.test(text), '設定の値を出した');
      assert(safeModeResidue({ permissions: {} }, null).length === 0, '何も無いのに報告した');
    });
    await t('試験用の差し込みは環境変数では効かない（本番の経路に読み取りが無い）', () => {
      const prod = fs.readFileSync(SELF, 'utf8').split('async function selftest(')[0].replace(/\/\/.*$/gm, '');
      const found = prod.match(/process\.env\.UT_DEFER_(?!DIR\b)[A-Z_]+/g) || [];
      assert(found.length === 0, `本番の経路に試験用の環境変数の読み取りがある: ${[...new Set(found)].join(', ')}`);
    });
    await t('engine: 実行ファイルを専用の環境変数で差し替えられない', () => {
      const keep = engineBins.claude; engineBins.claude = null;
      const binDir = path.join(base, 'trusted-bin'); fs.mkdirSync(binDir, { recursive: true });
      const real = path.join(binDir, process.platform === 'win32' ? 'claude.exe' : 'claude'); fs.writeFileSync(real, '');
      const keepPath = process.env.PATH; process.env.PATH = binDir;
      process.env.UT_DEFER_CLAUDE_BIN = path.join(base, 'evil.js');
      try { assert(engineCommand('claude').file === real, `専用の環境変数の実行ファイルを使った: ${JSON.stringify(engineCommand('claude'))}`); }
      finally { engineBins.claude = keep; delete process.env.UT_DEFER_CLAUDE_BIN; process.env.PATH = keepPath; }
    });
    await t('engine: APPDATA が相対パスなら、その下の codex.js を選ばない', () => {
      const cwdDir = path.join(base, 'target-repo-ad');
      const rel = path.join('npm', 'node_modules', '@openai', 'codex', 'bin');
      fs.mkdirSync(path.join(cwdDir, rel), { recursive: true }); fs.writeFileSync(path.join(cwdDir, rel, 'codex.js'), '');
      const keep = engineBins.codex; engineBins.codex = null;
      const keepAd = process.env.APPDATA, keepPath = process.env.PATH, keepCwd = process.cwd();
      process.chdir(cwdDir);
      try {
        for (const ad of ['.', '', undefined]) {
          if (ad === undefined) delete process.env.APPDATA; else process.env.APPDATA = ad;
          process.env.PATH = '.';
          let got = null; try { got = engineCommand('codex'); } catch { /* 見つからずに止まるのは正しい */ }
          assert(!got || !(got.pre[0] || '').endsWith('codex.js'), `APPDATA=${JSON.stringify(ad)} で対象リポジトリの codex.js を選んだ: ${JSON.stringify(got)}`);
        }
      } finally {
        process.chdir(keepCwd); engineBins.codex = keep; process.env.PATH = keepPath;
        if (keepAd === undefined) delete process.env.APPDATA; else process.env.APPDATA = keepAd;
      }
    });
    await t('git: 対象リポジトリの設定（fsmonitor・textconv）から外部コマンドを起動しない', () => {
      const r = path.join(base, 'git-probe'); fs.mkdirSync(r, { recursive: true });
      const hit = path.join(base, 'git-probe-hit.txt').replace(/\\/g, '/');
      const fsm = path.join(base, 'fsm.sh'), tc = path.join(base, 'tc.sh');
      fs.writeFileSync(fsm, '#!/bin/sh\necho fsm >> "' + hit + '"\n'); fs.writeFileSync(tc, '#!/bin/sh\necho tc >> "' + hit + '"\ncat "$1"\n');
      try { fs.chmodSync(fsm, 0o755); fs.chmodSync(tc, 0o755); } catch { /* Windows では不要 */ }
      g(['init', '-q'], r); g(['commit', '-q', '--allow-empty', '-m', 'init'], r);
      // 値は sh に渡されるため、試験の一時フォルダの名前の括弧で崩れないよう引用符で囲む
      g(['config', 'core.fsmonitor', '"' + fsm.replace(/\\/g, '/') + '"'], r); g(['config', 'diff.evil.textconv', '"' + tc.replace(/\\/g, '/') + '"'], r);
      fs.writeFileSync(path.join(r, '.gitattributes'), '*.txt diff=evil\n'); fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
      g(['add', '.'], r); g(['commit', '-q', '-m', 'a'], r); fs.appendFileSync(path.join(r, 'a.txt'), 'b\n');
      // 陽性対照: 対策を付けない git は、仕掛けたコマンドを起動する（起動しない環境なら、この試験は防御を見られない）
      fs.rmSync(hit, { force: true });
      try { execFileSync('git', ['-C', r, 'status', '--porcelain'], { stdio: 'ignore' }); execFileSync('git', ['-C', r, 'diff', 'HEAD', '--binary'], { stdio: 'ignore' }); } catch { /* 起動の有無だけを見る */ }
      assert(fs.existsSync(hit), '陽性対照: 対策を付けない git でも仕掛けたコマンドが起動しない（試験の前提が崩れている）');
      fs.rmSync(hit, { force: true });
      treeFingerprint(r); gitInfo(r);
      assert(!fs.existsSync(hit), `対象リポジトリの設定から外部コマンドを起動した: ${fs.existsSync(hit) ? fs.readFileSync(hit, 'utf8').trim() : ''}`);
    });
    await t('git: 対象リポジトリの hook（core.hooksPath）を起動しない', () => {
      const r = path.join(base, 'hook-probe'); fs.mkdirSync(path.join(r, 'evil-hooks'), { recursive: true });
      const hit = path.join(base, 'hook-probe-hit.txt').replace(/\\/g, '/');
      g(['init', '-q'], r);
      fs.writeFileSync(path.join(r, 'evil-hooks', 'post-index-change'), '#!/bin/sh\necho hook >> "' + hit + '"\n');
      // Linux などでは、実行の権限が無い hook は起動しない（陽性対照が成立しなくなる）。Windows では不要
      try { fs.chmodSync(path.join(r, 'evil-hooks', 'post-index-change'), 0o755); } catch { /* Windows では不要 */ }
      fs.writeFileSync(path.join(r, 'a.txt'), 'a\n'); g(['add', 'a.txt'], r); g(['commit', '-q', '-m', 'a'], r);
      g(['config', 'core.hooksPath', 'evil-hooks'], r);
      const touch = () => { const tm = new Date(Date.now() + Math.floor(Math.random() * 100000)); fs.utimesSync(path.join(r, 'a.txt'), tm, tm); };
      // 陽性対照: 対策を付けない git status は、索引の書き戻しで hook を起動する
      fs.rmSync(hit, { force: true }); touch();
      try { execFileSync('git', ['-C', r, 'status', '--porcelain'], { stdio: 'ignore' }); } catch { /* 起動の有無だけを見る */ }
      assert(fs.existsSync(hit), '陽性対照: 対策を付けない git status でも hook が起動しない（試験の前提が崩れている）');
      fs.rmSync(hit, { force: true }); touch();
      treeFingerprint(r); gitInfo(r);
      assert(!fs.existsSync(hit), '対象リポジトリの hook を起動した');
    });
    await t('engine: taskkill を作業フォルダ・相対パスの場所から選ばない', () => {
      const cwdDir = path.join(base, 'target-repo-tk'); fs.mkdirSync(path.join(cwdDir, 'System32'), { recursive: true });
      // 作業フォルダの直下と、相対パスの SystemRoot（.）から見た System32 の両方に置く（どちらも選ばれてはいけない）
      fs.writeFileSync(path.join(cwdDir, 'taskkill.exe'), ''); fs.writeFileSync(path.join(cwdDir, 'System32', 'taskkill.exe'), '');
      const sysDir = path.join(base, 'fake-systemroot'); fs.mkdirSync(path.join(sysDir, 'System32'), { recursive: true });
      const keepCwd = process.cwd(); process.chdir(cwdDir);
      try {
        assert(taskkillBin({ PATH: '.;', SystemRoot: sysDir }) === null, `作業フォルダの taskkill を選んだ: ${taskkillBin({ PATH: '.;', SystemRoot: sysDir })}`);
        assert(taskkillBin({ PATH: '.', SystemRoot: '.' }) === null, '相対パスの SystemRoot の taskkill を選んだ');
        fs.writeFileSync(path.join(sysDir, 'System32', 'taskkill.exe'), '');
        assert(taskkillBin({ PATH: '.', SystemRoot: sysDir }) === path.join(sysDir, 'System32', 'taskkill.exe'), 'SystemRoot の taskkill を選ばない（陽性対照）');
      } finally { process.chdir(keepCwd); }
    });
    await t('engine: 作業フォルダ・相対パスの場所の同名の実行ファイルを起動しない', () => {
      const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const cwdDir = path.join(base, 'target-repo'); fs.mkdirSync(path.join(cwdDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(cwdDir, exe), ''); fs.writeFileSync(path.join(cwdDir, 'bin', exe), '');
      const binDir = path.join(base, 'trusted-bin2'); fs.mkdirSync(binDir, { recursive: true }); fs.writeFileSync(path.join(binDir, exe), '');
      const sep = process.platform === 'win32' ? ';' : ':';
      const keepCwd = process.cwd(); process.chdir(cwdDir);
      try {
        const hit = resolveOnPath('claude', { PATH: ['', '.', 'bin', binDir].join(sep) });
        assert(hit === path.join(binDir, exe), `作業フォルダか相対パスの場所の実行ファイルを選んだ: ${hit}`);
        assert(resolveOnPath('claude', { PATH: ['.', 'bin'].join(sep) }) === null, '絶対パスの場所が無いのに実行ファイルを返した');
        const keep = engineBins.claude; engineBins.claude = null; const keepPath = process.env.PATH; process.env.PATH = ['.', 'bin'].join(sep);
        try { throwsLike(() => engineCommand('claude'), /見つからない/, '名前のままで起動しようとした'); }
        finally { engineBins.claude = keep; process.env.PATH = keepPath; }
      } finally { process.chdir(keepCwd); }
    });
    await t('engine: 子プロセスへ NODE_OPTIONS・プロキシ・API の送り先を渡さない', () => {
      const env = engineEnv({ PATH: 'p', NODE_OPTIONS: '--require x', https_proxy: 'h', ALL_PROXY: 'a', ANTHROPIC_BASE_URL: 'u', OPENAI_BASE_URL: 'o', BASH_ENV: 'b', USERPROFILE: 'c' });
      assert(JSON.stringify(Object.keys(env).sort()) === JSON.stringify(['PATH', 'USERPROFILE']), `渡した変数: ${Object.keys(env).join(',')}`);
    });
    await t('doctor: 注意があれば「問題なし」と締めない', () => {
      assert(doctorSummary(true, ['  OK  a', '  注意 claude: x']).startsWith('doctor: 注意あり'), '注意があるのに注意ありと締めない');
      assert(doctorSummary(true, ['  OK  a']) === 'doctor: 問題なし', '注意が無いのに問題なしと締めない');
      assert(doctorSummary(false, ['  注意 x']).startsWith('doctor: 問題あり'), 'NG があるのに問題ありと締めない');
    });
    await t('doctor: 設定ファイルを読めないときは「無い」と区別する', () => {
      const bad = path.join(base, 'bad-settings.json'); fs.writeFileSync(bad, '{ not json');
      assert(readSettingsFile(bad).state === 'invalid', `壊れた JSON を ${readSettingsFile(bad).state} とした`);
      assert(readSettingsFile(path.join(base, 'no-such.json')).state === 'missing', '無いファイルを missing としない');
      assert(readSettingsFile(base).state === 'unreadable', 'フォルダ（読めないもの）を unreadable としない');
    });
    await t('argv: claude はユーザー設定だけを読む（対象 repo の hooks・env を読ませない）', () => {
      const a = buildArgv('claude', { access: 'read-only' }, repo, base); assert(a[a.indexOf('--setting-sources') + 1] === 'user', '--setting-sources user が無い');
    });
    await t('codex: rollout は今回の試行より前の記録を見ない（前回の制限記録で正常終了を制限扱いにしない）', () => {
      const old = new Date(Date.now() - HOUR).toISOString();
      const rollout = [JSON.stringify({ timestamp: old, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, resets_at: 1 }, rate_limit_reached_type: 'workspace_member_credits_depleted' } } }),
        JSON.stringify({ timestamp: old, type: 'event_msg', payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } } })].join('\n');
      const c = classifyCodex({ exitCode: 0, stdout: '', rollout, lastMessage: 'x', since: Date.now() - 1000 });
      assert(c.cls === 'ok', '前回の記録で制限扱いにした: ' + c.cls);
    });
    await t('argv: codex は実行ポリシーの .rules を読ませない', () => { assert(buildArgv('codex', { access: 'read-only' }, repo, base).includes('--ignore-rules'), '--ignore-rules が無い'); });
    await t('doctor: 隣の引数の choices を拾わず、タブ区切りでも読める', () => {
      const tail = ' ' + HELP_REQUIREMENTS.claude.join(' ');
      const neighbor = '  --permission-mode <m>  mode\n  --other <x>  (choices: "dontAsk")\n  --permission-prompts <t> (choices: "none")\n' + tail;
      assert(checkHelp('claude', neighbor).includes('--permission-mode=dontAsk'), '隣の引数の choices を拾った');
      const tab = '  --permission-mode\t<m> (choices: "dontAsk")\n  --permission-prompts <t> (choices: "none")\n' + tail;
      assert(checkHelp('claude', tab).length === 0, 'タブ区切りを読めない: ' + checkHelp('claude', tab));
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('joblock: 人の操作が処理中のジョブは、runner が実行しない', async () => {
      const lf = path.join(P.job(j.id), '.lock'); fs.writeFileSync(lf, '99999');
      try { const r = await runOnce(); assert(r.ran === 0 && reload(j.id).state === 'pending', JSON.stringify(r)); } finally { fs.rmSync(lf, { force: true }); }
    });
    await t('joblock: 処理中のあいだ、別プロセスの cancel は待たされて状態を上書きしない', () => {
      const lf = path.join(P.job(j.id), '.lock');
      const cancelFromOther = () => spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { cancelJob } from ${JSON.stringify(pathToFileURL(SELF).href)}; try { cancelJob(${JSON.stringify(j.id)}); console.log('CANCELLED'); } catch (e) { console.log('ERR ' + e.constructor.name); }`],
        { env: process.env, encoding: 'utf8', timeout: 30000 });
      fs.writeFileSync(lf, String(process.pid));
      let r1;
      try { r1 = cancelFromOther(); } finally { fs.rmSync(lf, { force: true }); }
      assert(r1.stdout.includes('ERR JobBusyError') && reload(j.id).state === 'pending', '排他されずに取り消した: ' + r1.stdout + r1.stderr);
      const r2 = cancelFromOther();
      assert(r2.stdout.includes('CANCELLED') && reload(j.id).state === 'failed', 'ロック解放後に取り消せない: ' + r2.stdout + r2.stderr);
    });
    reset(); j = add({ prompt: 'STUB:sleep', timeoutMin: 0.5 });
    await t('lock: 実行中にロックの所有権を失ったら、子を止めて結果を反映しない', async () => {
      testHooks.heartbeatMs = 300;
      const swap = setTimeout(() => {
        fs.renameSync(P.lock(), P.lock() + '.stale-test');
        fs.writeFileSync(P.lock(), JSON.stringify({ pid: 1, token: 'other', heartbeat_at: new Date().toISOString() }));
      }, 1500);
      const t0 = Date.now();
      let res;
      try { res = await runOnce(); } finally { clearTimeout(swap); testHooks.heartbeatMs = 0; }
      const x = reload(j.id);
      assert(res.reason === 'lock_lost' && res.exitCode === 3 && res.ran === 0, '所有権を失ったのに正常終了として報告した: ' + JSON.stringify(res));
      assert(Date.now() - t0 < 20000, '子を止めずに timeout まで待った');
      assert(x.state === 'running' && x.owner, '所有権を失ったのに結果を反映した: ' + x.state);
      assert(readJson(P.lock(), {}).token === 'other', '新しい所有者のロックを壊した');
      fs.rmSync(P.lock()); fs.rmSync(P.lock() + '.stale-test', { force: true });
    });
    reset({ ...cfgBase, caps: { per_run: 2, per_5h: 100 } });
    await t('run: 同じ起動の中で制限に当たったエンジンのジョブは、続けて起動しない', async () => {
      const a1 = add({ prompt: 'STUB:limit_future' }); await new Promise((r) => setTimeout(r, 10)); const a2 = add({ prompt: 'STUB:done' });
      const r = await runOnce();
      assert(r.ran === 1 && r.ids[0] === a1.id && reload(a2.id).state === 'pending' && reload(a2.id).attempts.length === 0, JSON.stringify(r));
    });
    reset();
    await t('add: --timeout-min の型と範囲を検証する', () => {
      for (const v of ['abc', '-1', '0', '1e9', '111']) throwsLike(() => add({ prompt: 'x', timeoutMin: v }), /--timeout-min/, v + ' が通った');
      const ok = add({ prompt: 'x', timeoutMin: '5' }); assert(ok.timeout_min === 5, '有効な値が反映されない'); cancelJob(ok.id);
    });
    await t('config: caps が null・配列・数値なら既定値で隠さず止める', async () => {
      for (const caps of [null, [], 5]) { writeJson(P.config(), { ...cfgBase, caps }); const r = await runOnce(); assert(r.exitCode === 3, JSON.stringify(caps) + ' で止まらない'); }
      writeJson(P.config(), cfgBase);
    });
    await t('config: per_run × timeout_min がスケジューラの上限を超える設定は止める', async () => {
      writeJson(P.config(), { ...cfgBase, caps: { per_run: 4, per_5h: 4 }, timeout_min: 30 }); const r = await runOnce(); assert(r.exitCode === 3, JSON.stringify(r));
      writeJson(P.config(), cfgBase);
    });
    await t('run: キューを読めないときは 0件の正常終了にせず exit 3', async () => {
      reset(); fs.writeFileSync(P.jobs(), 'not a dir');
      try { const r = await runOnce(); assert(r.exitCode === 3 && r.reason === 'queue_read', JSON.stringify(r)); } finally { fs.rmSync(P.jobs()); }
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('list: 読めないジョブも件数と一緒に表示する', () => {
      fs.writeFileSync(path.join(P.job(j.id), 'job.json'), '{ broken'); const s = fmtList(); assert(s.includes('読めない 1 件') && s.includes(j.id), s);
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('retry: drift で止まったジョブは --accept-head で新しい HEAD を基準にして戻せる', async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'drift2\n'); g(['commit', '-qam', 'drift2']);
      const r1 = await runFor(j.id); assert(r1.state === 'hold' && r1.failure.kind === 'drift', r1.state);
      assert(r1.attempts[0].skipped === true, 'エンジンを起動していない試行が件数上限に数えられる');
      throwsLike(() => retryJob(j.id), /accept-head/, '案内なしで retry できた（必ず再び止まる）');
      retryJob(j.id, { acceptHead: true }); const r2 = await runFor(j.id); assert(r2.state === 'done', r2.state + ' ' + JSON.stringify(r2.failure));
    });
    reset(); j = add({ prompt: 'STUB:credits' });
    await t('retry: 制限の回数と最初の制限時刻は、retry より後の試行だけで数える', async () => {
      await runFor(j.id); const x = reload(j.id); x.attempts[0].started_at = new Date(Date.now() - 4 * 24 * HOUR).toISOString(); x.next_attempt_at = null; saveJob(x); writeJson(P.engines(), {});
      const r1 = await runFor(j.id); assert(r1.state === 'hold' && r1.failure.kind === 'limit_exhausted', r1.state);
      retryJob(j.id); writeJson(P.engines(), {});
      const r2 = await runFor(j.id); assert(r2.state === 'pending' && r2.failure.kind === 'limit_owner', 'retry 直後に上限扱いになった: ' + r2.state);
    });
    await t('config: --remove-root は表記の違いを正規化して外し、該当なしはエラー', () => {
      if (process.platform !== 'win32') return 'Windows 以外では省略';
      reset(); const run = (a) => spawnSync(process.execPath, [SELF, 'config', ...a], { env: process.env, encoding: 'utf8' });
      const r1 = run(['--remove-root', repo.toUpperCase().replace(/\\/g, '/')]); assert(r1.status === 0, r1.stderr);
      assert(readJson(P.config(), {}).allowed_roots.length === 0, '表記が違うと外れない');
      const r2 = run(['--remove-root', repo]); assert(r2.status !== 0 && /allowed_roots に無い/.test(r2.stderr), '該当なしが成功扱い');
      writeJson(P.config(), cfgBase);
    });
    reset({ ...cfgBase, caps: { per_run: 2, per_5h: 100 } });
    await t('run: 1回の起動で始めるジョブの上限時間の合計を、スケジューラの実行上限に収める', async () => {
      const a1 = add({ prompt: 'STUB:done', timeoutMin: '60' }); await new Promise((r) => setTimeout(r, 10)); const a2 = add({ prompt: 'STUB:done', timeoutMin: '60' });
      const r = await runOnce();
      assert(r.ran === 1 && r.ids[0] === a1.id && reload(a2.id).state === 'pending', '合計 120 分を1回の起動で始めた: ' + JSON.stringify(r));
    });
    reset(); j = add({ prompt: 'x' });
    await t('joblock: 持ち主のプロセスが生きていれば、古く見えても横取りしない', () => {
      const lf = path.join(P.job(j.id), '.lock');
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, token: 'alive' }));
      const old = new Date(Date.now() - 60 * 1000); fs.utimesSync(lf, old, old);
      try { throwsLike(() => withJobLock(j.id, () => 1), /他の操作が処理中/, '生きている持ち主のロックを奪った'); } finally { fs.rmSync(lf, { force: true }); }
    });
    await t('joblock: 持ち主のプロセスが居なければ、古いロックは奪える', () => {
      const lf = path.join(P.job(j.id), '.lock');
      fs.writeFileSync(lf, JSON.stringify({ pid: 999999, token: 'dead' }));
      const old = new Date(Date.now() - 60 * 1000); fs.utimesSync(lf, old, old);
      assert(withJobLock(j.id, () => 42) === 42 && !fs.existsSync(lf), '居なくなった持ち主のロックを奪えない');
    });
    await t('joblock: 解放は自分のロックだけを消す（横取りされていたら相手のロックを消さない）', () => {
      const lf = path.join(P.job(j.id), '.lock');
      withJobLock(j.id, () => { fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, token: 'other' })); });
      try { assert(fs.existsSync(lf) && readJson(lf, {}).token === 'other', '相手のロックを消した'); } finally { fs.rmSync(lf, { force: true }); }
    });
    reset(); j = add({ prompt: 'STUB:done' });
    await t('orphan: 途中停止の回数は retry より後の、実際に起動した試行だけで数える', async () => {
      const old = new Date(Date.now() - 3 * HOUR).toISOString();
      withJobLock(j.id, () => {
        const x = reload(j.id);
        x.attempts = Array.from({ length: 5 }, (_, i) => ({ n: i + 1, engine: 'codex', started_at: old, ended_at: old, class: 'orphaned' }));
        x.retry_at = new Date(Date.now() - 2.5 * HOUR).toISOString();
        x.attempts.push({ n: 6, engine: 'codex', started_at: new Date(Date.now() - 2 * HOUR).toISOString() });
        x.state = 'running'; saveJob(x);
      });
      writeJson(P.config(), { ...cfgBase, caps: { per_run: 0, per_5h: 100 } });
      try { await runOnce(); } finally { writeJson(P.config(), cfgBase); }
      assert(reload(j.id).state === 'pending', 'retry 前の途中停止まで数えて hold にした: ' + reload(j.id).state);
    });
    await t('cli: 画面に出す内容はマスクする（許可ルートなどにユーザーのパスが入る）', () => {
      reset();
      // ホームは Windows では USERPROFILE、Linux などでは HOME から決まるため、両方を差し替える
      const r = spawnSync(process.execPath, [SELF, 'config'], { env: { ...process.env, USERPROFILE: base, HOME: base }, encoding: 'utf8' });
      assert(r.status === 0 && !r.stdout.includes(path.basename(base)), 'ユーザーのパスが画面に出た: ' + r.stdout.slice(0, 200));
    });
    await t('cli: 壊れた config.json を --add-root で上書きしない', () => {
      reset(); fs.writeFileSync(P.config(), '{ broken');
      const r = spawnSync(process.execPath, [SELF, 'config', '--add-root', repo], { env: process.env, encoding: 'utf8' });
      const after = fs.readFileSync(P.config(), 'utf8'); writeJson(P.config(), cfgBase);
      assert(r.status !== 0 && after === '{ broken', '壊れた設定を上書きした');
    });
    await t('show: job の JSON やエラー文に含まれるユーザーのパスもマスクする', () => {
      reset(); const k = add({ prompt: 'x' });
      withJobLock(k.id, () => { const x = reload(k.id); x.state = 'hold'; x.failure = { kind: 'unknown', note: 'error at ' + os.homedir() + '\\secret.txt' }; saveJob(x); });
      // JSON の中では区切り文字がエスケープされる（\ → \\）。素の表記とエスケープ後の表記の両方で確かめる
      const s = fmtShow(k.id); const esc = JSON.stringify(os.homedir()).slice(1, -1);
      assert(!s.includes(os.homedir()) && !s.includes(esc), 'ユーザーのパスが出た');
    });
    await t('finish: 全体のロックを持っていても、ジョブの所有者でなければ結果を書かない', () => {
      reset(); const k = add({ prompt: 'x' });
      assert(acquireLock(loadConfig()), 'ロックを取れない');
      try {
        withJobLock(k.id, () => { const x = reload(k.id); x.state = 'running'; x.owner = 'someone-else'; x.attempts.push({ n: 1, engine: 'codex', started_at: new Date().toISOString() }); saveJob(x); });
        assert(finishAsOwner(reload(k.id), 'done', { result: { report: 'r', seen: false } }) === false && reload(k.id).state === 'running', '所有者でないのに結果を書いた');
        withJobLock(k.id, () => { const x = reload(k.id); x.owner = LOCK.token; saveJob(x); });
        assert(finishAsOwner(reload(k.id), 'done', { result: { report: 'r', seen: false } }) === true && reload(k.id).state === 'done', '所有者なのに書けない');
      } finally { releaseLock(); }
    });

    // ---- 人の操作
    reset(); j = add({ prompt: 'STUB:boom' });
    await t('cancel/retry: hold→retry→pending、pending→cancel→failed', async () => {
      await runFor(j.id); retryJob(j.id); assert(reload(j.id).state === 'pending', 'retry で pending にならない');
      cancelJob(j.id); assert(reload(j.id).state === 'failed' && reload(j.id).failure.kind === 'cancelled', 'cancel');
      throwsLike(() => retryJob(j.id), /hold のジョブだけ/, 'failed を retry できた');
    });
    await t('run: 実行予定が無ければロックもログも作らない', async () => {
      reset(); fs.rmSync(P.log(), { force: true }); const r = await runOnce(); assert(r.reason === 'nothing_due', JSON.stringify(r)); assert(!fs.existsSync(P.lock()) && !fs.existsSync(P.log()), '何か書いた');
    });
  } catch (e) {
    // テスト間の準備処理で落ちても、それまでの結果と停止理由を必ず出す（掃引が「異常終了」を検出と誤認しないため）
    results.push({ ok: false, name: 'selftest 本体が途中で停止', msg: String((e && e.message) || e) });
  } finally {
    for (const k2 of Object.keys(process.env)) if (!(k2 in saved)) delete process.env[k2];
    Object.assign(process.env, saved);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log('  (一時ディレクトリの削除に失敗: ' + e.code + ')'); }
  }

  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.msg ? ' | ' + r.msg : ''));
  const ng = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng} 件パス / ${ng} 件失敗`);
  return ng === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    log(`例外で終了: ${(e && e.stack) || e}`);
    console.error(maskText('ut-defer: ' + ((e && e.message) || e)).text);
    process.exit(1);
  });
}
