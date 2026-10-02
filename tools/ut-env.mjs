#!/usr/bin/env node
// ut-env: worktree / clone を移るときの開発環境を点検し、出所ごとのファイルセットを記録付きで重ねる。
//
//   node tools/ut-env.mjs doctor [--target <dir>] [--online] [--json]
//   node tools/ut-env.mjs plan   --target <dir> [--set <name>] [--take-source <path>]... [--prune]
//   node tools/ut-env.mjs apply  --target <dir> --expect <計画ID> [--set <name>] [--take-source <path>]... [--prune]
//   node tools/ut-env.mjs --selftest
//
// 環境固有の値（正本の場所・セットの中身・必要な環境変数の名前など）はリポジトリに置かず、
// profile（UT_ENV_PROFILE、既定 <USERPROFILE>/.claude/work/env/profile.json）に持つ。
// 秘密の値は読まない・書かない・表示しない。外部コマンドの出力は必要な欄だけを取り出し、maskText を通して表示する。
//
// exit: 0 正常 / 1 点検で fail がある・入力エラー / 2 適用したが未解決（衝突など）が残る / 3 ロック中
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskText } from './mask.mjs';

const SELF = fileURLToPath(import.meta.url);
const MANIFEST = '.claude/.ut-env-manifest.json';
const LOCK = '.claude/.ut-env.lock';
const IGNORE_NAMES = new Set(['__pycache__', '.DS_Store', 'Thumbs.db']);
const IGNORE_EXT = ['.pyc'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ConfigError extends Error {}
export class LockError extends Error {}

// ---------------------------------------------------------------- パス・入出力

const home = () => process.env.UT_ENV_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
const envDir = () => process.env.UT_ENV_DIR || path.join(home(), '.claude', 'work', 'env');
const profilePath = () => process.env.UT_ENV_PROFILE || path.join(envDir(), 'profile.json');
const expandHome = (p) => (p.startsWith('~/') || p.startsWith('~\\') ? path.join(home(), p.slice(2)) : p);
const posix = (p) => p.replace(/\\/g, '/');
const key = (rel) => posix(rel).toLowerCase();
const canonAbs = (p) => posix(fs.realpathSync.native(p)).replace(/\/+$/, '').toLowerCase();
const mask = (s) => maskText(String(s)).text;

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// Windows では作成直後のファイルをウイルス対策やインデクサが掴み、rename が EPERM/EBUSY で落ちることがある
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) throw e;
      sleepMs(25 * (i + 1));
    }
  }
}
function writeAtomic(dest, data) {
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  renameRetry(tmp, dest);
}

// 改行コードの差だけで衝突にしないよう、CRLF を LF に揃えてから比べる（deploy.mjs と同じ考え方）
export function fileHash(abs) {
  const s = fs.readFileSync(abs).toString('latin1').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(s, 'latin1').digest('hex');
}

// ---------------------------------------------------------------- profile

function strArray(v, name, re) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x || (re && !re.test(x)))) {
    throw new ConfigError(`profile の ${name} は文字列の配列にする${re ? `（形式 ${re}）` : ''}`);
  }
  return v;
}
// 同じファイルを別の書き方（./a、a//b、a/./b）で指せると、秘密ファイルとの照合をすり抜けるため、正規の書き方だけを受け付ける
export function relPattern(p, name) {
  const s = posix(p);
  const segs = s.split('/');
  const bad = path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || s.startsWith('/')
    || segs.some((x, i) => x === '' || x === '.' || x === '..' || (x.includes('*') && !(x === '**' && i === segs.length - 1)));
  if (bad) throw new ConfigError(`profile の ${name} は対象ツリーのルートからの正規の相対パスにする（.. ・ . ・ 空の区切り・絶対パス・末尾以外の ** は不可）: ${p}`);
  return s;
}

export function loadProfile(file = profilePath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    throw new ConfigError(`profile が無い: ${file}（tools/ut-env.profile.example.json を写して作る）`);
  }
  let p;
  // 例外文は入力の断片を含むため使わない（誤って秘密を書いた profile が壊れていても、断片を表示しない）
  try { p = JSON.parse(raw); } catch { throw new ConfigError('profile を JSON として読めない（位置は JSON の検査ツールで確かめる）'); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ConfigError('profile はオブジェクトにする');
  if (typeof p.source !== 'string' || !path.isAbsolute(p.source)) throw new ConfigError('profile の source は正本チェックアウトの絶対パスにする');
  if (!fs.existsSync(p.source)) throw new ConfigError(`profile の source が存在しない: ${p.source}`);
  const sets = {};
  if (!p.sets || typeof p.sets !== 'object' || Array.isArray(p.sets) || !Object.keys(p.sets).length) {
    throw new ConfigError('profile の sets は {セット名: [相対パス…]} にする（1つ以上）');
  }
  for (const [name, list] of Object.entries(p.sets)) {
    sets[name] = strArray(list, `sets.${name}`).map((x) => relPattern(x, `sets.${name}`));
    if (!sets[name].length) throw new ConfigError(`profile の sets.${name} が空`);
  }
  const secretFiles = strArray(p.secret_files, 'secret_files').map((x) => relPattern(x, 'secret_files'));
  let configJson = null;
  if (p.config_json !== undefined) {
    const c = p.config_json;
    if (!c || typeof c !== 'object' || typeof c.path !== 'string') throw new ConfigError('profile の config_json は {path, keys, same_as_source} にする');
    configJson = { path: relPattern(c.path, 'config_json.path'), keys: strArray(c.keys, 'config_json.keys'), same_as_source: strArray(c.same_as_source, 'config_json.same_as_source') };
  }
  // 秘密ファイルや個人設定をセットに含めると、正本の値が別のツリーへ複製される。記録・ロックを含めると管理情報を上書きする
  const guarded = [...secretFiles, ...(configJson ? [configJson.path] : []), MANIFEST, LOCK].map(key);
  const bases = [];
  for (const [name, list] of Object.entries(sets)) {
    for (const pat of list) {
      const base = key(pat.replace(/\/\*\*$/, ''));
      const hit = guarded.find((g) => g === base || g.startsWith(base + '/'));
      if (hit) throw new ConfigError(`sets.${name} の ${pat} が秘密ファイル・個人設定・管理ファイル（${hit}）を含む。セットに入れない`);
      bases.push({ name, base });
    }
  }
  // 同じファイルを2つのセットが持つと、どちらの記録で判定・削除するかが決まらない
  for (const a of bases) {
    for (const b of bases) {
      if (a.name !== b.name && (a.base === b.base || a.base.startsWith(b.base + '/'))) {
        throw new ConfigError(`sets.${a.name} と sets.${b.name} が同じパス（${a.base}）を含む。1つのファイルは1つのセットに入れる`);
      }
    }
  }
  let backlog = null;
  if (p.backlog !== undefined) {
    const b = p.backlog;
    if (!b || typeof b !== 'object') throw new ConfigError('profile の backlog はオブジェクトにする');
    if (typeof b.env !== 'string' || !ENV_NAME.test(b.env)) throw new ConfigError('profile の backlog.env は環境変数名にする');
    // 通信の子プロセスの起動に使う変数（PATH など）や内部の変数（UT_ENV_*）と重なる名前は使わせない（キーの値がその名前のまま子へ渡るため）
    if (CHILD_ENV_KEYS.some((k) => k.toLowerCase() === b.env.toLowerCase()) || /^UT_ENV_/i.test(b.env)) throw new ConfigError(`profile の backlog.env に ${b.env} は使えない（通信の子プロセスの起動に使う変数・内部の変数と重なる）`);
    backlog = {
      env: b.env,
      sync_script: typeof b.sync_script === 'string' ? b.sync_script : null,
      data: typeof b.data === 'string' ? b.data : null,
      max_age_hours: Number.isFinite(b.max_age_hours) && b.max_age_hours > 0 ? b.max_age_hours : 24,
      settings_pattern: typeof b.settings_pattern === 'string' ? b.settings_pattern : null,
      space: typeof b.space === 'string' && isBacklogHost(b.space) ? b.space.toLowerCase() : null,
    };
  }
  if (p.backlog?.space !== undefined && !backlog.space) throw new ConfigError('profile の backlog.space は Backlog の公式ドメインのホスト名（<スペース>.backlog.jp / .backlog.com / .backlogtool.com）にする');
  let sonarqube = null;
  if (p.sonarqube !== undefined) {
    if (!p.sonarqube || typeof p.sonarqube.url_env !== 'string' || !ENV_NAME.test(p.sonarqube.url_env)) throw new ConfigError('profile の sonarqube.url_env は環境変数名にする');
    sonarqube = { url_env: p.sonarqube.url_env };
  }
  const bool = (v, n) => {
    if (v === undefined) return false;
    if (typeof v !== 'boolean') throw new ConfigError(`profile の ${n} は true/false にする`);
    return v;
  };
  return {
    source: p.source,
    sets,
    env: strArray(p.env, 'env', ENV_NAME),
    plugins: strArray(p.plugins, 'plugins'),
    mcp: strArray(p.mcp, 'mcp'),
    // exclude はディレクトリを末尾の / で表せるようにする（/ を外して検査し、付け直す）
    exclude: strArray(p.exclude, 'exclude').map((x) => {
      const d = x.replace(/^\//, '');
      return relPattern(d.replace(/\/$/, ''), 'exclude') + (d.endsWith('/') ? '/' : '');
    }),
    secret_files: secretFiles,
    required: strArray(p.required, 'required').map((x) => relPattern(x, 'required')),
    config_json: configJson,
    backlog,
    sonarqube,
    vscode: bool(p.vscode, 'vscode'),
    tools: { claude: bool(p.tools?.claude, 'tools.claude'), codex: bool(p.tools?.codex, 'tools.codex'), az: bool(p.tools?.az, 'tools.az'), ut_defer: bool(p.tools?.ut_defer, 'tools.ut_defer') },
  };
}

// ---------------------------------------------------------------- 外部コマンド

// 試験用の差し込み。自己テストが同じプロセスの中で設定する。環境変数では切り替えられない（本番の経路から、確認済みの計画に無い
// 書き込みや、外部コマンドの差し替えをできないようにするため。ut-defer の engineBins と同じ考え方）
export const testHooks = { failAfter: 0, failAtWrite: 0, mutateSource: '', mutateTarget: '', cmdStubs: {} };
// selftest ではスタブに差し替える（testHooks.cmdStubs.<名前の小文字>=スタブの .mjs）
// 引数に入れてよいのは、本ファイル内の固定値と、profile の読み込みで ENV_NAME に一致すると確かめた環境変数名だけ
const SAFE_ARG = /^[A-Za-z0-9_\\/\-.]+$/;
export function runCmd(name, args, { timeout = 60000 } = {}) {
  for (const a of [name, ...args]) if (!SAFE_ARG.test(a)) throw new Error(`外部コマンドに渡せない文字を含む引数: ${a}`);
  const stub = testHooks.cmdStubs[name.toLowerCase()];
  // cmd.exe はカレントディレクトリの同名の .cmd を PATH より先に実行する。対象ツリーのファイルを起動しないよう、
  // それを止める環境変数を渡し、作業ディレクトリも一時フォルダに固定する
  const opts = { encoding: 'utf8', timeout, windowsHide: true, cwd: os.tmpdir(), env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } };
  let r;
  if (stub) r = spawnSync(process.execPath, [stub, ...args], opts);
  else if (process.platform === 'win32') {
    // az・codex は .cmd のため cmd 経由で起動する
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[name, ...args].join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  } else r = spawnSync(name, args, opts);
  // 時間切れのとき、Windows では cmd.exe だけが止まり、その先の子プロセスは残りうる（既知の限界）
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`${name} が ${timeout / 1000} 秒以内に終わらない`);
  if (r.error) throw new Error(`${name} を起動できない (${r.error.code || 'spawn'})`);
  if (r.signal) throw new Error(`${name} が時間内に終わらない (${r.signal})`);
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// git も名前のままで起動しない。作業フォルダ（対象のツリーで実行されうる）の同名の実行ファイルを拾わないよう、PATH のうち
// 絶対パスの場所だけを探して絶対パスに決める（ut-defer.mjs の resolveOnPath と同じ規則。2つのツールは互いを読み込まない作りのため、それぞれに持つ）
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
let GIT_BIN;
function gitBin() {
  if (GIT_BIN === undefined) GIT_BIN = resolveOnPath('git');
  if (!GIT_BIN) throw new Error('git が PATH の絶対パスの場所に見つからない（作業フォルダと相対パスの場所は探さない）');
  return GIT_BIN;
}
// 対象のツリーの設定を通じた外部コマンドの起動を止める（fsmonitor、索引の書き戻しのときの hook、それ以外の hook）
export const GIT_GUARD = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];
export function git(cwd, args) {
  return execFileSync(gitBin(), [...GIT_GUARD, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}
function gitOk(cwd, args) {
  const r = spawnSync(gitBin(), [...GIT_GUARD, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git を起動できない (${r.error.code})`);
  return r.status;
}

// ---------------------------------------------------------------- ツリー

export function treeInfo(target, source) {
  if (!fs.existsSync(target)) throw new ConfigError(`対象が存在しない: ${target}`);
  let top, common, srcTop, srcCommon;
  try {
    top = git(target, ['rev-parse', '--show-toplevel']);
    common = git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch { throw new ConfigError(`対象が git の作業ツリーではない: ${target}`); }
  if (canonAbs(top) !== canonAbs(target)) throw new ConfigError(`対象は作業ツリーのルートを指定する（ルート: ${top}）`);
  try {
    srcTop = git(source, ['rev-parse', '--show-toplevel']);
    srcCommon = git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch { throw new ConfigError(`正本が git の作業ツリーではない: ${source}`); }
  let kind;
  if (canonAbs(top) === canonAbs(srcTop)) kind = 'source';
  else if (canonAbs(common) === canonAbs(srcCommon)) kind = 'linked-worktree';
  else kind = 'clone';
  const exclude = git(target, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  return { top, kind, exclude, excludeShared: kind === 'linked-worktree' };
}

// 対象パスの途中にリンク（シンボリックリンク・ジャンクション）があれば、その位置を返す。リンクの先へは書かない
function linkInPath(root, rel) {
  let cur = root;
  for (const part of posix(rel).split('/')) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return posix(path.relative(root, cur));
  }
  return null;
}

function listSetFiles(root, patterns, warnings) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { warnings.push(`正本のリンクは複製しない: ${posix(rel)}`); return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (IGNORE_NAMES.has(name)) continue;
        walk(path.join(rel, name));
      }
    } else if (st.isFile()) {
      if (IGNORE_EXT.some((e) => rel.toLowerCase().endsWith(e))) return;
      out.push(posix(rel));
    }
  };
  for (const pat of patterns) {
    const rec = pat.endsWith('/**');
    const base = rec ? pat.slice(0, -3) : pat;
    const abs = path.join(root, base);
    // 起点より上（例 .claude/commands がジャンクション）にリンクがあると、正本の外を読んで複製してしまう
    const link = linkInPath(root, base);
    if (link) { warnings.push(`正本のリンクは複製しない: ${link}`); continue; }
    if (!fs.existsSync(abs)) { warnings.push(`正本にセットの要素が無い: ${pat}`); continue; }
    if (!rec && fs.lstatSync(abs).isDirectory()) { warnings.push(`ディレクトリは末尾に /** を付けて指定する: ${pat}`); continue; }
    walk(base);
  }
  return [...new Map(out.map((r) => [key(r), r])).values()];
}

// ---------------------------------------------------------------- マニフェスト

// source を渡すと、別の正本から複製した記録を「壊れた記録」として扱う（正本を切り替えたのに、古い記録で更新・削除しない）
export function readManifest(top, source = null) {
  const f = path.join(top, MANIFEST);
  if (!fs.existsSync(f)) return { files: {}, broken: false };
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!m || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('shape');
    if (source && m.source !== canonAbs(source)) return { files: {}, broken: true, foreign: true };
    const files = {};
    for (const [k, v] of Object.entries(m.files)) {
      if (!v || typeof v.hash !== 'string' || typeof v.path !== 'string' || typeof v.set !== 'string') throw new Error('entry');
      if (v.pending !== undefined && typeof v.pending !== 'string') throw new Error('pending');
      // 記録はツリーの中にあり、利用者以外も書ける（コミットされた記録を clone で受け取るなど）。
      // 記録の path はそのまま読み書き先になるため、ツリーの外を指すもの・キーと食い違うものは壊れた記録として扱う
      const s = posix(v.path);
      if (path.isAbsolute(v.path) || /^[A-Za-z]:/.test(v.path) || s.startsWith('/') || s.split('/').includes('..') || key(s) !== key(k)) throw new Error('path');
      files[key(k)] = { ...v, path: s };
    }
    return { files, broken: false };
  } catch {
    // 壊れた記録は「記録なし」として扱う。一致以外は衝突になり、上書きしない側に倒れる
    return { files: {}, broken: true };
  }
}
function writeManifest(top, files, source) {
  const f = path.join(top, MANIFEST);
  if (linkInPath(top, MANIFEST)) throw new Error(`記録の書き込み先の途中にリンクがある: ${MANIFEST}`);
  writeAtomic(f, JSON.stringify({ version: 2, source: canonAbs(source), files }, null, 2) + '\n');
}

// ---------------------------------------------------------------- plan

// 状態: missing（不足）/ same（一致）/ updated（正本が更新）/ conflict（手元で変更・記録なしの差分）/
//       deleted（管理済みのファイルが手元で消えた）/ tracked（対象で git 管理下）/ removed（正本から消滅）/
//       link（リンク）/ gone（記録だけ残る）
// src / tgt / rec はハッシュ（無ければ null）。戻り値の action が null なら、その状態では何もしない
// canPrune: 正本の列挙が警告なしで完了したときだけ true（正本を読めなかったのを「消滅」と取り違えて消さない）
export function classify({ src, tgt, rec, tracked, take, prune, canPrune = true }) {
  // 対象のブランチが git で管理しているファイルは、正本の有無・内容に関係なく触れない（消さない・書き戻さない・記録しない）
  if (tracked) return { state: 'tracked', action: null };
  if (src) {
    // 記録があるのに無いのは、利用者が消したもの。黙って書き戻さない（戻すなら --take-source）
    if (tgt === null && rec) return { state: 'deleted', action: take ? 'copy' : null };
    if (tgt === null) return { state: 'missing', action: 'copy' };
    if (tgt === src) return { state: 'same', action: rec === src ? null : 'record' };
    if (rec && tgt === rec) return { state: 'updated', action: 'update' };
    return { state: 'conflict', action: take ? 'take' : null };
  }
  if (tgt === null) return { state: 'gone', action: 'drop-record' };
  if (rec && tgt === rec) return { state: 'removed', action: prune && canPrune ? 'prune' : null };
  return { state: 'conflict', action: null };
}

export function planTree(profile, target, { set = null, takeSource = [], prune = false } = {}) {
  const info = treeInfo(target, profile.source);
  if (info.kind === 'source') throw new ConfigError('正本自身は対象にできない');
  const warnings = [];
  const manifest = readManifest(info.top, profile.source);
  if (manifest.foreign) warnings.push(`記録（${MANIFEST}）は別の正本から複製したもの。使わずに、差分はすべて衝突にする`);
  else if (manifest.broken) warnings.push(`記録（${MANIFEST}）が壊れている。記録なしとして扱い、差分はすべて衝突にする`);
  const setNames = set ? [set] : Object.keys(profile.sets);
  for (const s of setNames) if (!profile.sets[s]) throw new ConfigError(`profile に無いセット: ${s}`);
  const tracked = new Set(git(info.top, ['ls-files', '-z']).split('\0').filter(Boolean).map(key));
  const take = new Set(takeSource.map(key));
  const items = [];
  const seen = new Set();
  const sourceCounts = {};
  for (const s of setNames) {
    const before = warnings.length;
    const files = listSetFiles(profile.source, profile.sets[s], warnings);
    const complete = warnings.length === before;
    sourceCounts[s] = files.length;
    // 正本にセットの中身が1件も無いと、何も複製せずに「変更 0 件」で終わってしまう（正本の取り違えなど）
    if (!files.length) warnings.push(`セット ${s} の中身が正本に1件も無い（profile の source と sets を確かめる）`);
    const inSet = (k) => profile.sets[s].some((pat) => {
      const b = key(pat.replace(/\/\*\*$/, ''));
      return pat.endsWith('/**') ? k.startsWith(b + '/') : k === b;
    });
    const recs = Object.entries(manifest.files).filter(([k, v]) => v.set === s && inSet(k));
    const rels = new Map(files.map((r) => [key(r), r]));
    for (const [k, v] of recs) if (!rels.has(k)) rels.set(k, v.path);
    for (const [k, rel] of rels) {
      if (seen.has(k)) continue;
      seen.add(k);
      const src = path.join(profile.source, rel);
      const tgt = path.join(info.top, rel);
      const it = { set: s, rel, srcHash: null, rec: null, tgtHash: null, state: null, action: null };
      // 正本側・対象側とも、途中にリンクがあれば読みも書きもしない
      const link = linkInPath(info.top, rel) || (linkInPath(profile.source, rel) && `正本の ${linkInPath(profile.source, rel)}`);
      if (link) { it.state = 'link'; it.note = link; items.push(it); continue; }
      it.srcHash = fs.existsSync(src) ? fileHash(src) : null;
      it.tgtHash = fs.existsSync(tgt) ? fileHash(tgt) : null;
      const ent = manifest.files[k];
      it.rec = ent && ent.hash ? ent.hash : null;
      // 書き換えの途中で止まった場合: 対象が「書き込む予定だった内容」と一致していれば、その内容を記録とみなす
      if (ent && ent.pending && it.tgtHash === ent.pending) it.rec = ent.pending;
      Object.assign(it, classify({ src: it.srcHash, tgt: it.tgtHash, rec: it.rec, tracked: tracked.has(k), take: take.has(k), prune, canPrune: complete }));
      if (it.state === 'removed' && prune && !complete) it.note = '正本の列挙に警告があるため、--prune を効かせない';
      items.push(it);
    }
  }
  // 指定した取り込み対象が衝突・手元で削除として計画に載っていなければ、打ち間違いを黙って無視しない。
  // 途中で止まった取り込みを同じ引数で再実行したとき、取り込み済み（一致）のものは許す
  const takeable = new Set(items.filter((it) => (['conflict', 'deleted'].includes(it.state) && it.srcHash) || it.state === 'same').map((it) => key(it.rel)));
  const strayTake = takeSource.filter((p) => !takeable.has(key(p)));
  if (strayTake.length) throw new ConfigError(`--take-source の対象が衝突として計画に無い: ${strayTake.join(' ')}（plan で衝突の行のパスを確かめる）`);
  const excludeAdds = planExclude(profile, info, setNames);
  const plan = { info, items, warnings, excludeAdds, manifestBroken: manifest.broken, sourceCounts };
  plan.id = planId(plan, { takeSource, prune });
  return plan;
}

// 計画の指紋。apply は、利用者が確かめた計画と同じ内容のときだけ進む（plan の後に正本・対象・profile が変わった場合を拒否する）
export function planId(plan, { takeSource = [], prune = false } = {}) {
  const body = JSON.stringify({
    top: canonAbs(plan.info.top),
    items: plan.items.map((it) => [key(it.rel), it.set, it.state, it.action, it.srcHash, it.tgtHash, it.rec]),
    exclude: plan.excludeAdds.map(key),
    warnings: plan.warnings,
    take: [...takeSource].map(key).sort(),
    prune: !!prune,
  });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function excludeCandidates(profile, setNames) {
  const out = [MANIFEST, LOCK, ...profile.exclude, ...profile.secret_files];
  for (const s of setNames) {
    for (const pat of profile.sets[s]) out.push(pat.endsWith('/**') ? pat.slice(0, -3) + '/' : pat);
  }
  return [...new Map(out.map((p) => [key(p), p])).values()];
}
// exclude の1行として書くとき、git の glob 記号をそのまま書くと別のパスに一致してしまうため逃がす
export const excludeLine = (p) => '/' + p.replace(/[[\]*?!#\\]/g, '\\$&');
// 既存の規則で実際に除外されているかを git 自身に判定させる（行の一致では、/.claude/ の丸ごと除外などを見落とす）
function planExclude(profile, info, setNames) {
  const adds = [];
  for (const p of excludeCandidates(profile, setNames)) {
    const code = gitOk(info.top, ['check-ignore', '-q', '--no-index', '--', p]);
    if (code === 1) adds.push(p);
    else if (code !== 0) throw new Error(`git check-ignore が判定できない（終了コード ${code}）: ${p}`);
  }
  return adds;
}

const STATE_LABEL = {
  missing: '不足', same: '一致', updated: '正本が更新', conflict: '衝突', deleted: '手元で削除', tracked: '追跡ファイル（触れない）',
  removed: '正本から消滅', link: 'リンク（追従しない）', gone: '記録だけ残る',
};
const ACTION_LABEL = { copy: '複製', record: '記録', update: '退避して更新', take: '退避して取り込む', prune: '退避して削除', 'drop-record': '記録を消す' };

export function summarize(plan) {
  const counts = {};
  for (const it of plan.items) counts[it.state] = (counts[it.state] || 0) + 1;
  const changes = plan.items.filter((it) => it.action).length + plan.excludeAdds.length;
  // 追跡ファイルは対象ブランチの持ち物で、利用者の判断は要らないため未解決に数えない。警告（正本に中身が無い等）は数える
  const unresolved = plan.items.filter((it) => ['conflict', 'deleted', 'link', 'removed'].includes(it.state) && !it.action).length
    + plan.warnings.length;
  return { counts, total: plan.items.length, changes, unresolved };
}

function fmtPlan(plan, title) {
  const { counts, total, changes, unresolved } = summarize(plan);
  const L = [];
  L.push(`${title}: ${plan.info.top}（${{ 'linked-worktree': 'リンク worktree', clone: '別 clone' }[plan.info.kind]}）`);
  for (const w of plan.warnings) L.push(`  ! ${w}`);
  const byState = Object.keys(STATE_LABEL).filter((s) => counts[s]).map((s) => `${STATE_LABEL[s]} ${counts[s]}`);
  L.push(`  ファイル ${total} = ${byState.join(' + ') || '0'}`);
  for (const it of plan.items) {
    if (it.state === 'same' && !it.action) continue;
    const act = it.action ? ` → ${ACTION_LABEL[it.action]}` : '';
    let hint = '';
    if (it.state === 'conflict' && !it.action) hint = `（上書きしない。正本で置き換えるなら --take-source ${it.rel}）`;
    else if (it.state === 'deleted' && !it.action) hint = `（書き戻さない。戻すなら --take-source ${it.rel}）`;
    else if (it.state === 'removed' && !it.action) hint = it.note ? `（${it.note}）` : '（消さない。消すなら --prune）';
    else if (it.state === 'link') hint = `（${it.note} がリンク）`;
    L.push(`  [${STATE_LABEL[it.state]}] ${it.set}: ${it.rel}${act}${hint}`);
  }
  if (plan.excludeAdds.length) {
    L.push(`  exclude に追記: ${plan.excludeAdds.map(excludeLine).join(' ')}（${plan.info.excludeShared ? '全 worktree で共有するファイル' : 'この clone のファイル'}: ${plan.info.exclude}）`);
  }
  L.push(`  変更 ${changes} 件 / 未解決 ${unresolved} 件`);
  L.push(`  計画ID: ${plan.id}（apply に --expect ${plan.id} を付ける。計画の後に正本・対象・profile が変わっていたら拒否される）`);
  return L.join('\n');
}

// ---------------------------------------------------------------- apply

export function acquireLock(f, label) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  try {
    const fd = fs.openSync(f, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === 'EEXIST') throw new LockError(`別の ut-env が実行中（${label}）。実行中でないと確かめてから、このファイルを消す`);
    throw e;
  }
  // 自分が取ったロックだけを消す（手で消したあとに別の実行が取り直したロックを、終了時に消さない）
  return () => {
    try { if (JSON.parse(fs.readFileSync(f, 'utf8')).token === token) fs.unlinkSync(f); } catch { /* 解放失敗は次回の二重起動拒否で見える */ }
  };
}

// exclude はリンク worktree の間で共有されるため、ツリーのロックとは別に exclude 自体のロックを取り、
// 書く直前に読み直して、まだ除外されていない行だけを足す
// 判定できなかった（0/1 以外の）ときは、除外済みとも未除外とも扱わずに止める
function isIgnored(top, p) {
  const code = gitOk(top, ['check-ignore', '-q', '--no-index', '--', p]);
  if (code === 0) return true;
  if (code === 1) return false;
  throw new Error(`git check-ignore が判定できない（終了コード ${code}）: ${p}`);
}
// 絶対パスの途中にリンクがあるか（実体の場所と、書いたとおりの場所が食い違うか）で判定する
function assertNoLinkAbs(abs, label) {
  let cur = path.resolve(abs);
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) return; cur = up; }
  if (canonAbs(cur) !== posix(cur).replace(/\/+$/, '').toLowerCase()) throw new Error(`${label} の途中にリンクがある: ${cur}`);
}
function appendExclude(info, adds) {
  const f = info.exclude;
  assertNoLinkAbs(path.dirname(f), 'exclude の書き込み先');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const release = acquireLock(`${f}.ut-env.lock`, `${f}.ut-env.lock`);
  try {
    const still = adds.filter((p) => !isIgnored(info.top, p));
    if (still.length) {
      const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const add = (cur && !cur.endsWith('\n') ? '\n' : '') + '# ut-env\n' + still.map(excludeLine).join('\n') + '\n';
      writeAtomic(f, cur + add);
    }
    // 追記しても、優先順位の高い .gitignore の否定規則（!pattern）で除外されないことがある。効いていなければ複製の前に止める
    const notEffective = adds.filter((p) => !isIgnored(info.top, p));
    if (notEffective.length) throw new Error(`exclude に追記しても除外されない（.gitignore の否定規則など）: ${notEffective.join(' ')}。複製はしていない`);
    return still.length;
  } finally { release(); }
}

export function applyTree(profile, target, opts = {}) {
  const info0 = treeInfo(target, profile.source);
  if (info0.kind === 'source') throw new ConfigError('正本自身は対象にできない');
  // 管理ファイルの置き場所（.claude など）がリンクなら、ロックを作る前に止める（リンクの先にロックや記録を書かない）
  const ctlLink = linkInPath(info0.top, LOCK) || linkInPath(info0.top, MANIFEST);
  if (ctlLink) throw new ConfigError(`管理ファイルの置き場所の途中にリンクがある: ${ctlLink}`);
  const release = acquireLock(path.join(info0.top, LOCK), LOCK);
  try {
    // 判定はロックを取ってから行う（plan と apply の間に他が書いた分を見落とさない）
    const plan = planTree(profile, target, opts);
    const { top } = plan.info;
    // 利用者が確かめた計画と違えば進まない
    if (opts.expect && opts.expect !== plan.id) {
      throw new ConfigError(`計画が変わった（確かめた計画 ${opts.expect} / 今の計画 ${plan.id}）。plan をやり直して、新しい計画ID で apply する`);
    }
    // 複製より先に除外する。途中で止まっても、複製済みのファイルや記録が未追跡として見えて add される状態を作らない
    if (plan.excludeAdds.length) appendExclude(plan.info, plan.excludeAdds);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // ツリー名だけだと、日本語の名前が同じ記号列に置き換わって別のツリーと衝突するため、パスのハッシュを添える
    const treeTag = path.basename(top).replace(/[^\w.-]/g, '_') + '-' + crypto.createHash('sha256').update(canonAbs(top)).digest('hex').slice(0, 8);
    const backupDir = path.join(envDir(), 'backup', treeTag, ts);
    const manifest = readManifest(top, profile.source);
    const files = plan.manifestBroken ? {} : { ...manifest.files };
    const done = [];
    // selftest 用: 途中で止まる状況を作る（AFTER=n 件目の前で止める / AT_WRITE=n 件目のファイルを書いた直後、記録の確定前に止める）
    const failAfter = testHooks.failAfter;
    const failAtWrite = testHooks.failAtWrite;
    const mutateSource = testHooks.mutateSource;
    if (mutateSource) fs.appendFileSync(path.join(profile.source, mutateSource), 'changed after plan\n');
    const mutateTarget = testHooks.mutateTarget;
    if (mutateTarget) fs.appendFileSync(path.join(top, mutateTarget), 'edited after plan\n');
    // 計画のときのハッシュと今のハッシュが違えば、その間に誰かが書いた。上書き・削除をしない
    const unchanged = (it) => {
      const now = fs.existsSync(path.join(top, it.rel)) ? fileHash(path.join(top, it.rel)) : null;
      if (now !== it.tgtHash) throw new Error(`計画の後に対象が変わった: ${it.rel}。plan をやり直す`);
    };
    const backup = (rel) => {
      const from = path.join(top, rel);
      const to = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (fileHash(to) !== fileHash(from)) throw new Error(`退避の確認に失敗: ${rel}`);
    };
    const copyIn = (it) => {
      const dest = path.join(top, it.rel);
      if (linkInPath(top, it.rel) || linkInPath(profile.source, it.rel)) throw new Error(`読み書きの途中にリンクがある: ${it.rel}`);
      // 正本は計画のときの内容だけを取り込む（計画の後に正本が変わっていたら、その内容を書かない）
      const buf = fs.readFileSync(path.join(profile.source, it.rel));
      const bufHash = crypto.createHash('sha256').update(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
      if (bufHash !== it.srcHash) throw new Error(`計画の後に正本が変わった: ${it.rel}。plan をやり直す`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (linkInPath(top, it.rel)) throw new Error(`書き込み先の途中にリンクがある: ${it.rel}`);
      writeAtomic(dest, buf);
      if (fileHash(dest) !== it.srcHash) throw new Error(`書き込み後の確認に失敗: ${it.rel}`);
    };
    for (const it of plan.items) {
      if (!it.action) continue;
      if (failAfter && done.length >= failAfter) throw new Error('試験用の差し込み（failAfter）による中断');
      const k = key(it.rel);
      if (['copy', 'update', 'take', 'prune'].includes(it.action)) unchanged(it);
      if (['copy', 'update', 'take'].includes(it.action)) {
        // 書き換えの前に「書き込む予定の内容」を記録しておく。書いた直後に止まっても、再実行で「一致」と判定でき収束する
        files[k] = { path: it.rel, set: it.set, hash: it.rec || '', pending: it.srcHash, at: new Date().toISOString() };
        writeManifest(top, files, profile.source);
      }
      if (it.action === 'copy') copyIn(it);
      else if (it.action === 'update' || it.action === 'take') { backup(it.rel); copyIn(it); }
      else if (it.action === 'prune') { backup(it.rel); fs.unlinkSync(path.join(top, it.rel)); }
      if (failAtWrite && done.length + 1 >= failAtWrite) throw new Error('試験用の差し込み（failAtWrite）による中断');
      if (it.action === 'prune' || it.action === 'drop-record') delete files[k];
      else files[k] = { path: it.rel, set: it.set, hash: it.srcHash, at: new Date().toISOString() };
      // 1件ごとに記録する。途中で止まっても、再実行で残りだけが対象になる
      writeManifest(top, files, profile.source);
      done.push(it);
    }
    const after = planTree(profile, target, { set: opts.set });
    return { plan, done, backupDir: done.some((d) => ['update', 'take', 'prune'].includes(d.action)) ? backupDir : null, after };
  } finally { release(); }
}

// ---------------------------------------------------------------- doctor

const STATUS_MARK = { ok: '✓', warn: '!', fail: '✗' };

// 1つの点検の失敗（例外・外部コマンドの不在・出力形式の変化）を、その点検の fail に閉じ込める
async function runCheck(results, area, name, fn) {
  try {
    const r = await fn();
    for (const x of Array.isArray(r) ? r : [r]) results.push({ area, check: x.check || name, status: x.status, message: x.message || '', fix: x.fix || '', evidence: x.evidence || '' });
  } catch (e) {
    results.push({ area, check: name, status: 'fail', message: `判定できない: ${String(e && e.message || e).split('\n')[0]}`, fix: '', evidence: '' });
  }
}

function envCheck(name) {
  if (process.env[name] !== undefined && process.env[name] !== '') return { check: `環境変数 ${name}`, status: 'ok', message: '現在のプロセスに設定あり（値は表示しない。値が有効かは未確認）', evidence: '現在のプロセスの環境変数' };
  // setx で登録した直後は、起動済みのプロセスに反映されない。レジストリの有無だけを見る（出力は捨てる）
  if (process.platform === 'win32' || testHooks.cmdStubs.reg) {
    const r = runCmd('reg', ['query', 'HKCU\\Environment', '/v', name], { timeout: 15000 });
    if (r.code === 0) return { check: `環境変数 ${name}`, status: 'warn', message: 'ユーザー環境変数にはあるが、このプロセスに反映されていない', fix: '端末（VS Code）を起動し直す', evidence: 'HKCU\\Environment（値は読まない）' };
  }
  return { check: `環境変数 ${name}`, status: 'fail', message: '未設定', fix: `setx ${name} "<値>"（値は端末で直接入力し、履歴やファイルに残さない）`, evidence: '現在のプロセスとユーザー環境変数' };
}

// JSON.parse の例外文は入力の断片（トークンの一部など）を含み、途中で切れた値はマスクでも消えないため、固定の文言に置き換える
function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} を JSON として読めない`); }
}
function readJsonFile(f, label = path.basename(f)) { return parseJson(fs.readFileSync(f, 'utf8'), label); }

async function machineChecks(profile, results, { online }) {
  for (const name of profile.env) await runCheck(results, 'machine', `環境変数 ${name}`, () => envCheck(name));
  if (profile.tools.claude) await runCheck(results, 'machine', 'Claude Code', () => {
    const r = runCmd('claude', ['--version']);
    if (r.code !== 0) throw new Error(`claude --version が終了コード ${r.code}`);
    return { status: 'ok', message: r.stdout.trim().split('\n')[0], evidence: 'claude --version' };
  });
  if (profile.tools.codex) {
    await runCheck(results, 'machine', 'Codex', () => {
      const r = runCmd('codex', ['--version']);
      if (r.code !== 0) throw new Error(`codex --version が終了コード ${r.code}`);
      return { status: 'ok', message: r.stdout.trim().split('\n')[0], evidence: 'codex --version' };
    });
    await runCheck(results, 'machine', 'Codex のログイン', () => {
      const r = runCmd('codex', ['login', 'status']);
      // "Not logged in" にも "logged in" は含まれるため、行頭の Logged in だけを見る
      const text = r.stdout + r.stderr;
      const logged = r.code === 0 && /^\s*logged in\b/im.test(text) && !/not logged in/i.test(text);
      return logged ? { status: 'ok', message: 'ログイン済み', evidence: 'codex login status' }
        : { status: 'fail', message: 'ログインしていない', fix: 'codex login', evidence: 'codex login status' };
    });
    await runCheck(results, 'machine', 'codex doctor', () => {
      const r = runCmd('codex', ['doctor', '--json'], { timeout: 120000 });
      const o = parseJson(r.stdout, 'codex doctor --json の出力');
      if (!o || !o.checks || typeof o.checks !== 'object' || typeof o.overallStatus !== 'string') throw new Error('codex doctor --json の形式が想定と違う');
      // 検査が0件・項目の形が崩れている・全体の状態と終了コードが食い違うものは「全項目 ok」にしない
      const checks = Object.values(o.checks);
      const KNOWN = new Set(['ok', 'warning', 'error', 'fail', 'skipped']);
      if (!checks.length) throw new Error('codex doctor --json の検査が0件');
      if (checks.some((c) => !c || typeof c.id !== 'string' || !KNOWN.has(c.status)) || !KNOWN.has(o.overallStatus)) throw new Error('codex doctor --json の項目の形式が想定と違う');
      // 取り出すのは各項目の id と合否だけ（details にはパスやアカウント情報が入る）
      const bad = checks.filter((c) => c.status !== 'ok' && c.status !== 'skipped').map((c) => `${c.id}=${c.status}`);
      // 実機（0.154）は warning でも終了コード 0。0 以外は、全体の状態が何であっても fail にする
      let st;
      if (r.code !== 0 || ['error', 'fail'].includes(o.overallStatus)) st = 'fail';
      else if (o.overallStatus === 'ok' && !bad.length) st = 'ok';
      else st = 'warn';
      return { status: st, message: bad.length ? `ok 以外: ${bad.join(', ')}` : '全項目 ok', fix: st === 'ok' ? '' : 'codex doctor で詳細を見る', evidence: 'codex doctor --json の id と status' };
    });
  }
  if (profile.tools.az) await runCheck(results, 'machine', 'Azure CLI のログイン', () => {
    // 出力はテナント ID やアカウント名を含むため -o none で捨て、終了コードだけを見る
    const r = runCmd('az', ['account', 'show', '-o', 'none']);
    return r.code === 0 ? { status: 'ok', message: 'Azure CLI にログイン済み（対象の Azure DevOps 組織へのアクセスは未確認）', evidence: 'az account show の終了コード' }
      : { status: 'fail', message: 'ログインしていない', fix: 'az login', evidence: 'az account show の終了コード' };
  });
  // 項目ごとに1つの点検にする（期待する点検との突き合わせで、名前が一意に決まるように）
  for (const p of profile.plugins) await runCheck(results, 'machine', `プラグイン ${p}`, () => {
    const names = Object.keys(readJsonFile(path.join(home(), '.claude', 'plugins', 'installed_plugins.json')).plugins || {});
    return names.includes(p)
      ? { status: 'ok', message: '導入の記録あり（読み込まれるかは未確認）', evidence: 'installed_plugins.json' }
      : { status: 'fail', message: '導入の記録が無い', fix: `Claude Code で /plugin install ${p}`, evidence: 'installed_plugins.json' };
  });
  for (const m of profile.mcp) await runCheck(results, 'machine', `MCP ${m}`, () => {
    const names = Object.keys(readJsonFile(path.join(home(), '.claude.json'), '.claude.json').mcpServers || {});
    return names.includes(m)
      ? { status: 'ok', message: 'ユーザー単位に登録あり（接続できるかは未確認）', evidence: '~/.claude.json の mcpServers のキー名' }
      : { status: 'fail', message: 'ユーザー単位に登録が無い', fix: 'その MCP の文書に従って登録する（claude mcp add など）', evidence: '~/.claude.json の mcpServers のキー名' };
  });
  if (profile.backlog) {
    const b = profile.backlog;
    await runCheck(results, 'machine', `環境変数 ${b.env}`, () => envCheck(b.env));
    if (b.settings_pattern) await runCheck(results, 'machine', 'Backlog の許可ドメイン', () => {
      // 文字列の部分一致だと deny に書かれた指定でも「許可あり」になるため、allow の項目だけを見る
      const f = path.join(home(), '.claude', 'settings.json');
      const allow = readJsonFile(f, 'settings.json').permissions?.allow;
      const hit = Array.isArray(allow) && allow.some((x) => typeof x === 'string' && x.includes(b.settings_pattern));
      return hit ? { status: 'ok', message: '許可あり', evidence: '~/.claude/settings.json' }
        : { status: 'warn', message: `settings.json に ${b.settings_pattern} が無い`, fix: 'WebFetch の許可ドメインに追加する', evidence: '~/.claude/settings.json' };
    });
    if (b.sync_script) await runCheck(results, 'machine', 'Backlog の同期スクリプト', () => (fs.existsSync(expandHome(b.sync_script))
      ? { status: 'ok', message: 'あり', evidence: b.sync_script }
      : { status: 'fail', message: '無い', fix: '同期スクリプトを配置する', evidence: b.sync_script }));
    if (b.data) await runCheck(results, 'machine', 'Backlog の同期データ', () => {
      const f = expandHome(b.data);
      if (!fs.existsSync(f)) return { status: 'warn', message: 'まだ同期していない', fix: b.sync_script ? `python "${b.sync_script}"` : '同期する', evidence: b.data };
      const h = (Date.now() - fs.statSync(f).mtimeMs) / 3600000;
      return h <= b.max_age_hours ? { status: 'ok', message: `${h.toFixed(1)} 時間前に更新（同期が成功したかは未確認）`, evidence: `${b.data} の更新時刻` }
        : { status: 'warn', message: `${h.toFixed(1)} 時間前から更新なし（基準 ${b.max_age_hours} 時間）`, fix: b.sync_script ? `python "${b.sync_script}"` : '同期する', evidence: `${b.data} の更新時刻` };
    });
    if (online) await runCheck(results, 'machine', 'Backlog API（読み取り）', () => {
      if (!b.space) return { status: 'warn', message: 'profile に backlog.space が無いため確認しない' };
      const url = `https://${b.space}/api/v2/users/myself`;
      const st = onlineStatus(url, b.env);
      if (st.err === 'destination_refused') return { status: 'fail', message: `送り先を拒否した（${st.why}）。キーは送っていない`, evidence: '送る前の送り先の検査' };
      return st.ok ? { status: 'ok', message: `HTTP ${st.code}（送り先 ${new URL(url).hostname}）`, evidence: 'GET /users/myself（ステータスだけ）' }
        : { status: 'fail', message: st.code ? `HTTP ${st.code}` : `接続できない（${st.err}）`, fix: 'キーの有効性とネットワークを確かめる', evidence: 'GET /users/myself（ステータスだけ）' };
    });
  }
  if (profile.sonarqube && online) await runCheck(results, 'machine', 'SonarQube の疎通', () => {
    const base = process.env[profile.sonarqube.url_env];
    if (!base) return { status: 'fail', message: `${profile.sonarqube.url_env} が未設定のため確認できない` };
    // 送り先は https に限る（http への接続や、リダイレクトでの別の宛先への送信はしない）
    if (!/^https:\/\//i.test(base)) return { status: 'fail', message: `${profile.sonarqube.url_env} が https ではないため確認しない` };
    const st = onlineStatus(base.replace(/\/+$/, '') + '/api/system/status', null);
    return st.ok ? { status: 'ok', message: `HTTP ${st.code}`, evidence: 'GET /api/system/status' }
      : { status: 'fail', message: st.code ? `HTTP ${st.code}` : `接続できない（${st.err}）`, fix: '証明書の登録（--use-system-ca）と hosts を確かめる', evidence: 'GET /api/system/status' };
  });
}

// Backlog の公式ドメインだけを「キーを送ってよい送り先」とする。スペースは1つの ASCII ラベル
// （英数字とハイフン。先頭・末尾はハイフン不可。63文字まで。国際化ドメインの xn-- は認めない）。大文字小文字は区別しない
const BACKLOG_SUFFIXES = ['backlog.jp', 'backlog.com', 'backlogtool.com'];
export function isBacklogHost(host) {
  const m = String(host).toLowerCase().match(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z.]+)$/);
  return !!m && BACKLOG_SUFFIXES.includes(m[2]) && !m[1].startsWith('xn--');
}
// キーを付ける前の、完成した URL で判定する（文字列の連結や、呼び出し側の検査に頼らない）。null なら送ってよい
export function keyDestinationError(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return 'URL が不正'; }
  if (u.protocol !== 'https:') return 'https ではない';
  if (u.username || u.password) return 'URL に認証情報が含まれる';
  if (u.port !== '') return '既定以外のポート';
  if (u.search || u.hash) return 'URL にクエリかフラグメントが含まれる';
  if (!isBacklogHost(u.hostname)) return '送り先が Backlog の公式ドメインではない';
  if (!u.pathname.startsWith('/api/v2/')) return 'API のパスではない';
  return null;
}
// 通信の子プロセスに渡す環境は、起動に要るものだけにする。NODE_OPTIONS（読み込ませるコード）やプロキシの変数を渡すと、
// 検査した URL とは別の経路でキーが出うる。プロキシ経由でしか外へ出られない環境では使えない（既知の制限）
const CHILD_ENV_KEYS = ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'];
function childEnv(extra) {
  const e = {};
  for (const k of CHILD_ENV_KEYS) if (process.env[k] !== undefined) e[k] = process.env[k];
  return { ...e, ...extra };
}
// 試験は net.run を差し替えて、子プロセスを起動せずに渡す値を確かめる（環境変数では切り替えられないようにする）
export const net = { run: spawnSync };

// 通信は子プロセスで行う。API キーは子プロセスの中で環境変数から URL に付け、argv・出力・例外文に出さない。
// キーを付ける通信は、送り先の検査に通ったときだけ起動する。子が返すのはステータスコードか例外の型だけ
// （例外の文言はキー入りの URL を含みうるため捨てる）。リダイレクトはたどらない
export function onlineStatus(url, keyEnv) {
  if (keyEnv) {
    const why = keyDestinationError(url);
    if (why) return { ok: false, code: null, err: 'destination_refused', why };
  }
  const code = `
const u = new URL(process.env.UT_ENV_URL);
if (process.env.UT_ENV_HAS_KEY === '1') u.searchParams.set('apiKey', process.env.UT_ENV_API_KEY || '');
const ac = new AbortController(); setTimeout(() => ac.abort(), 15000);
fetch(u, { signal: ac.signal, redirect: 'manual' })
  .then((r) => { console.log(JSON.stringify({ code: r.status })); process.exit(0); })
  .catch((e) => { console.log(JSON.stringify({ err: (e && e.cause && e.cause.code) || (e && e.name) || 'Error' })); process.exit(0); });`;
  // 組織内の認証局（CA）や自己署名の証明書を、OS の証明書ストアで検証するため --use-system-ca を使う（Node 22.15 / 23.8 以上）。
  // それより古い Node では付けずに通信し、失敗したときの型（証明書エラー）で分かるようにする
  const [maj, min] = process.versions.node.split('.').map(Number);
  const sysCa = maj > 23 || (maj === 23 && min >= 8) || (maj === 22 && min >= 15);
  // キーの値は固定の名前（UT_ENV_API_KEY）で渡す。profile の変数名をそのまま子の環境に作ると、backlog.env を NODE_OPTIONS などに
  // されたとき、除いたはずの変数が復活する
  const keyVar = keyEnv ? { UT_ENV_API_KEY: process.env[keyEnv] || '', UT_ENV_HAS_KEY: '1' } : {};
  const r = net.run(process.execPath, [...(sysCa ? ['--use-system-ca'] : []), '-e', code], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: childEnv({ ...keyVar, UT_ENV_URL: url }),
  });
  let o = {};
  try { o = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { o = { err: r.error ? r.error.code || 'spawn' : 'no-output' }; }
  const safeErr = typeof o.err === 'string' && /^[A-Za-z_]+$/.test(o.err) ? o.err : 'Error';
  return { ok: Number.isInteger(o.code) && o.code >= 200 && o.code < 300, code: Number.isInteger(o.code) ? o.code : null, err: safeErr };
}

async function targetChecks(profile, target, results) {
  let plan;
  await runCheck(results, 'target', 'ツリー', () => {
    plan = planTree(profile, target);
    const kind = { 'linked-worktree': 'リンク worktree', clone: '別 clone' }[plan.info.kind];
    return { status: 'ok', message: `${kind}（exclude: ${plan.info.excludeShared ? '全 worktree で共有' : 'この clone だけ'}）`, evidence: 'git rev-parse --git-common-dir' };
  });
  // ツリーを判定できなければ、後続の点検は「未実施」の fail として並べる（行ごと消して点検漏れを隠さない）
  if (!plan) {
    for (const s of Object.keys(profile.sets)) results.push({ area: 'target', check: `セット ${s}`, status: 'fail', message: 'ツリーを判定できないため未実施', fix: '', evidence: '' });
    results.push({ area: 'target', check: 'exclude', status: 'fail', message: 'ツリーを判定できないため未実施', fix: '', evidence: '' });
  }
  if (plan) {
    for (const s of Object.keys(profile.sets)) {
      await runCheck(results, 'target', `セット ${s}`, () => {
        const its = plan.items.filter((it) => it.set === s);
        const c = {};
        for (const it of its) c[it.state] = (c[it.state] || 0) + 1;
        const detail = Object.keys(STATE_LABEL).filter((x) => c[x]).map((x) => `${STATE_LABEL[x]} ${c[x]}`).join(' + ');
        // 正本から列挙できた件数で見る（過去の記録があると its は0にならないため、それでは正本が空になったことに気づけない）
        if (!plan.sourceCounts[s]) return { status: 'fail', message: `正本から列挙できたファイルが0件（記録由来 ${its.length} 件）`, fix: 'profile の source と sets を確かめる', evidence: 'profile' };
        const needsWork = its.some((it) => it.action || ['conflict', 'deleted', 'link', 'removed'].includes(it.state));
        const status = needsWork ? 'warn' : 'ok';
        return { status, message: `${its.length} = ${detail}`, fix: needsWork ? `node tools/ut-env.mjs plan --target "${plan.info.top}" で内訳を見る` : '', evidence: MANIFEST };
      });
    }
    await runCheck(results, 'target', 'exclude', () => (plan.excludeAdds.length
      ? { status: 'warn', message: `除外されていない: ${plan.excludeAdds.join(' ')}`, fix: 'apply で追記する', evidence: 'git check-ignore' }
      : { status: 'ok', message: '必要なパスはすべて除外済み', evidence: 'git check-ignore' }));
    for (const w of plan.warnings) results.push({ area: 'target', check: '警告', status: 'warn', message: w, fix: '', evidence: '' });
  }
  const top = plan ? plan.info.top : target;
  for (const sf of profile.secret_files) {
    await runCheck(results, 'target', `秘密ファイル ${sf}`, () => {
      // 追跡済みのファイルには除外規則が効かない。exclude に一致していても、変更はコミットの対象になる
      if (gitOk(top, ['ls-files', '--error-unmatch', '--', sf]) === 0) return { status: 'fail', message: 'git の追跡対象になっている（除外規則は効かない。中身は読まない）', fix: `git rm --cached "${sf}" で追跡から外し、秘密はマシン単位の仕組みへ移す`, evidence: 'git ls-files' };
      if (!fs.existsSync(path.join(top, sf))) return { status: 'ok', message: '無い（ツリーごとに秘密を置かない方針どおり）', evidence: sf };
      const ignored = isIgnored(top, sf);
      return ignored ? { status: 'warn', message: 'ある（中身は読まない）。不要なら消し、認証はマシン単位の仕組みに寄せる', evidence: sf }
        : { status: 'fail', message: 'あり、しかも git の除外に入っていない（誤って add される）', fix: 'apply で exclude に追記する', evidence: 'git check-ignore' };
    });
  }
  if (profile.config_json) {
    const cj = profile.config_json;
    await runCheck(results, 'target', `個人設定 ${cj.path}`, () => {
      const f = path.join(top, cj.path);
      if (!fs.existsSync(f)) return { status: 'fail', message: '無い', fix: '正本のものを参考に作る（値は各自）', evidence: cj.path };
      const o = readJsonFile(f);
      const missing = cj.keys.filter((k) => !(k in o));
      let diff = [];
      if (cj.same_as_source.length) {
        const s = readJsonFile(path.join(profile.source, cj.path));
        diff = cj.same_as_source.filter((k) => JSON.stringify(o[k]) !== JSON.stringify(s[k]));
      }
      if (!missing.length && !diff.length) return { status: 'ok', message: `キー ${cj.keys.length} 件あり${cj.same_as_source.length ? `・正本と同じであるべき ${cj.same_as_source.length} 件が一致` : ''}（値は表示しない）`, evidence: cj.path };
      return { status: 'warn', message: [missing.length ? `無いキー: ${missing.join(', ')}` : '', diff.length ? `正本と違うキー: ${diff.join(', ')}` : ''].filter(Boolean).join(' / '), fix: '追跡ファイルのためツールは書き換えない。手で直す', evidence: cj.path };
    });
  }
  if (profile.vscode) {
    await runCheck(results, 'target', 'VS Code のデバッグ設定', () => (fs.existsSync(path.join(top, '.vscode', 'launch.json'))
      ? { status: 'ok', message: '.vscode/launch.json あり', evidence: '.vscode/launch.json' }
      : { status: 'warn', message: '.vscode/launch.json が無い', fix: `/ut-vscode-debug を入力し「${top} の F5 デバッグ設定を作って」と送る`, evidence: '.vscode/launch.json' }));
  }
  // 同期できたことと、使えることは別。レビューなどが実際に参照するファイルが揃っているかを見る
  for (const req of profile.required) {
    await runCheck(results, 'target', `必須ファイル ${req}`, () => (fs.existsSync(path.join(top, req))
      ? { status: 'ok', message: 'あり', evidence: req }
      : { status: 'fail', message: '無い', fix: 'plan / apply で揃うか、profile の required を確かめる', evidence: req }));
  }
}

// profile から、実施されるべき点検の名前を結果とは独立に作る。登録漏れ・重複は「総数の照合」では見つからないため、名前の集合で突き合わせる
export function expectedChecks(profile, { target = null, online = false } = {}) {
  const e = [...profile.env.map((n) => `環境変数 ${n}`)];
  if (profile.tools.claude) e.push('Claude Code');
  if (profile.tools.codex) e.push('Codex', 'Codex のログイン', 'codex doctor');
  if (profile.tools.az) e.push('Azure CLI のログイン');
  e.push(...profile.plugins.map((p) => `プラグイン ${p}`), ...profile.mcp.map((m) => `MCP ${m}`));
  const b = profile.backlog;
  if (b) {
    e.push(`環境変数 ${b.env}`);
    if (b.settings_pattern) e.push('Backlog の許可ドメイン');
    if (b.sync_script) e.push('Backlog の同期スクリプト');
    if (b.data) e.push('Backlog の同期データ');
    if (online) e.push('Backlog API（読み取り）');
  }
  if (profile.sonarqube && online) e.push('SonarQube の疎通');
  if (target) {
    e.push('ツリー', ...Object.keys(profile.sets).map((s) => `セット ${s}`), 'exclude', ...profile.secret_files.map((f) => `秘密ファイル ${f}`));
    if (profile.config_json) e.push(`個人設定 ${profile.config_json.path}`);
    if (profile.vscode) e.push('VS Code のデバッグ設定');
    e.push(...profile.required.map((r) => `必須ファイル ${r}`));
  }
  if (profile.tools.ut_defer) e.push('ut-defer');
  return e;
}

export async function doctor(profile, { target = null, online = false } = {}) {
  const results = [];
  await machineChecks(profile, results, { online });
  if (target) await targetChecks(profile, target, results);
  if (profile.tools.ut_defer) await runCheck(results, 'delegate', 'ut-defer', () => {
    const r = spawnSync(process.execPath, [path.join(path.dirname(SELF), 'ut-defer.mjs'), 'doctor'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
    return r.status === 0 ? { status: 'ok', message: 'doctor が通る', evidence: 'ut-defer.mjs doctor' }
      : { status: 'warn', message: `doctor が終了コード ${r.status}`, fix: 'node tools/ut-defer.mjs doctor で詳細を見る', evidence: 'ut-defer.mjs doctor' };
  });
  // 期待する点検と実際の結果を名前で突き合わせる（「警告」は計画の補足で、点検ではないため除く）
  const count = (list) => list.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
  const want = count(expectedChecks(profile, { target, online }));
  const got = count(results.filter((r) => r.check !== '警告').map((r) => r.check));
  const missing = [...want].filter(([n, c]) => (got.get(n) || 0) < c).map(([n]) => n);
  const extra = [...got].filter(([n, c]) => c > (want.get(n) || 0)).map(([n]) => n);
  if (missing.length) results.push({ area: 'machine', check: '点検漏れ', status: 'fail', message: `実施されなかった点検: ${missing.join(', ')}`, fix: '', evidence: 'expectedChecks' });
  if (extra.length) results.push({ area: 'machine', check: '点検の重複・想定外', status: 'fail', message: `想定より多い点検: ${extra.join(', ')}`, fix: '', evidence: 'expectedChecks' });
  // profile に点検項目が1つも無いと「合計 0」の正常終了になる。点検していないことを成功に見せない
  if (!results.length) results.push({ area: 'machine', check: '点検', status: 'fail', message: '点検の対象が0件', fix: 'profile の env・tools などを確かめる', evidence: 'profile' });
  const totals = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) {
    if (!(r.status in totals)) { r.message = `不正な判定値 ${r.status}: ${r.message}`; r.status = 'fail'; }
    totals[r.status]++;
  }
  // 表示・保存するものはすべてマスクを通す
  for (const r of results) for (const k of ['check', 'message', 'fix', 'evidence']) r[k] = mask(r[k]);
  return { results, totals, total: results.length };
}

export function fmtDoctor(d) {
  const L = [];
  let area = null;
  for (const r of d.results) {
    if (r.area !== area) { area = r.area; L.push(`== ${{ machine: 'マシン', target: '対象ツリー', delegate: '他のツール' }[area]} ==`); }
    L.push(`  ${STATUS_MARK[r.status]} ${r.check}: ${r.message}${r.evidence ? `  [${r.evidence}]` : ''}`);
    if (r.fix) L.push(`      → ${r.fix}`);
  }
  L.push(`合計 ${d.total} = ok ${d.totals.ok} + warn ${d.totals.warn} + fail ${d.totals.fail}`);
  return mask(L.join('\n'));
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { _: [], takeSource: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ConfigError(`${a} に値が要る`);
      return v;
    };
    if (a === '--target') o.target = val();
    else if (a === '--set') o.set = val();
    else if (a === '--take-source') o.takeSource.push(val());
    else if (a === '--prune') o.prune = true;
    else if (a === '--online') o.online = true;
    else if (a === '--json') o.json = true;
    else if (a === '--expect') o.expect = val();
    else if (a === '--selftest') o.selftest = true;
    else if (a.startsWith('--')) throw new ConfigError(`不明な引数: ${a}`);
    else o._.push(a);
  }
  return o;
}

const out = (s) => console.log(mask(s));

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (o.selftest) return (await selftest()) ? 0 : 1;
  const cmd = o._[0];
  if (!['doctor', 'plan', 'apply'].includes(cmd)) {
    console.error('使い方: node tools/ut-env.mjs doctor [--target <dir>] [--online] [--json] | plan --target <dir> [--set <name>] | apply --target <dir> --expect <計画ID> [--set <name>] [--take-source <path>]... [--prune] | --selftest');
    return 1;
  }
  try {
    const profile = loadProfile();
    // --json のときは標準出力を JSON だけにする（profile の行は標準エラーへ）
    if (o.json) console.error(mask(`profile: ${profilePath()}`));
    else out(`profile: ${profilePath()}`);
    if (cmd === 'doctor') {
      const d = await doctor(profile, { target: o.target ? path.resolve(o.target) : null, online: !!o.online });
      if (o.json) console.log(mask(JSON.stringify({ profile: profilePath(), ...d }, null, 2)));
      else out(fmtDoctor(d));
      return d.totals.fail ? 1 : 0;
    }
    if (!o.target) throw new ConfigError('--target が要る');
    const target = path.resolve(o.target);
    if (cmd === 'plan') {
      const p = planTree(profile, target, { set: o.set, takeSource: o.takeSource, prune: !!o.prune });
      out(fmtPlan(p, '計画'));
      out(`（計画だけ。変更するには、同じ引数に --expect ${p.id} を足して apply を実行する）`);
      return 0;
    }
    // 利用者が確かめた計画を指定しないと適用しない（plan を見ずに apply するのを防ぐ）
    if (!o.expect) throw new ConfigError('apply には --expect <計画ID> が要る。先に同じ引数で plan を実行し、表示された計画ID を渡す');
    const r = applyTree(profile, target, { set: o.set, takeSource: o.takeSource, prune: !!o.prune, expect: o.expect });
    out(fmtPlan(r.plan, '適用前'));
    out(`適用: ${r.done.length} 件${r.plan.excludeAdds.length ? ` ＋ exclude ${r.plan.excludeAdds.length} 行` : ''}`);
    if (r.backupDir) out(`退避先: ${r.backupDir}（戻すときは、相対パスを保ったまま対象ツリーへ複製する）`);
    const s = summarize(r.after);
    out(`適用後の確認: 変更 ${s.changes} 件 / 未解決 ${s.unresolved} 件${s.changes ? '（0 にならない。原因を確かめる）' : ''}`);
    return s.changes ? 1 : s.unresolved ? 2 : 0;
  } catch (e) {
    console.error(mask(e.message));
    return e instanceof LockError ? 3 : 1;
  }
}

// ---------------------------------------------------------------- selftest

async function selftest() {
  const results = [];
  const t = async (name, fn) => {
    try { const msg = await fn(); results.push({ ok: true, name, msg: msg || '' }); }
    catch (e) { results.push({ ok: false, name, msg: String((e && e.message) || e) }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const throwsLike = (fn, re, msg) => { try { fn(); } catch (e) { assert(re.test(e.message), `${msg}: ${e.message}`); return e; } throw new Error(msg + ': 例外が出ない'); };

  // 実運用と同じく括弧と日本語を含むパスで動かす
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ute(テスト)-'));
  const saved = { ...process.env };
  const g = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=selftest', '-c', 'user.email=selftest' + '@' + 'example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const W = (root, rel, s) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  const R = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const src = path.join(base, 'src');
  const HOME = path.join(base, 'home');
  process.env.UT_ENV_HOME = HOME;
  process.env.UT_ENV_DIR = path.join(base, 'envdir');
  testHooks.failAfter = 0;

  // 正本: 追跡ファイルと、追跡しないセット（commands/review・scripts）
  fs.mkdirSync(src, { recursive: true });
  g(src, ['init', '-q']);
  W(src, 'README.md', 'x\n'); W(src, '.claude/config.json', '{"owner":"a","project":"p"}\n');
  g(src, ['add', '.']); g(src, ['commit', '-q', '-m', 'init']);
  W(src, '.claude/commands/review/review.md', 'review v1\n');
  W(src, '.claude/commands/review/_rules.md', 'rules\n');
  W(src, '.claude/scripts/lib/a.sh', 'echo a\n');
  W(src, '.claude/scripts/lib/__pycache__/x.pyc', 'bin');
  W(src, '.claude/skills/cross/SKILL.md', 'skill v1\n');
  const worktree = path.join(base, 'wt');
  g(src, ['worktree', 'add', '-q', worktree, '-b', 'feature']);
  const clone = path.join(base, 'clone');
  execFileSync('git', ['clone', '-q', src, clone], { stdio: 'ignore' });

  const profileObj = {
    source: src,
    sets: { review: ['.claude/commands/review/**', '.claude/scripts/**', '.claude/skills/cross/**'] },
    secret_files: ['.claude/config.local.json'],
    config_json: { path: '.claude/config.json', keys: ['owner', 'project'], same_as_source: ['owner'] },
  };
  const pf = path.join(base, 'profile.json');
  const setProfile = (o) => { fs.writeFileSync(pf, JSON.stringify(o)); process.env.UT_ENV_PROFILE = pf; return loadProfile(pf); };
  let profile = setProfile(profileObj);
  const st = (plan, rel) => (plan.items.find((i) => key(i.rel) === key(rel)) || {}).state;
  const fresh = (name) => { const d = path.join(base, name); g(src, ['worktree', 'add', '-q', d, '-b', name]); return d; };

  try {
    // ---- profile
    await t('profile: 不正な型は拒否', () => {
      throwsLike(() => setProfile({ ...profileObj, sets: { review: 'x' } }), /文字列の配列/, '文字列が通った');
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['../x/**'] } }), /相対パス/, '.. が通った');
      throwsLike(() => setProfile({ ...profileObj, env: ['BAD-NAME'] }), /形式/, '不正な環境変数名が通った');
      profile = setProfile(profileObj);
    });
    await t('profile: セットに秘密ファイルを含めたら拒否', () => {
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['.claude/**'] } }), /秘密ファイル・個人設定/, '.claude/** が通った');
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['.claude/config.local.json'] } }), /秘密ファイル・個人設定/, '秘密ファイルが通った');
      profile = setProfile(profileObj);
    });

    // ---- 判定
    await t('plan: 正本自身は拒否', () => { throwsLike(() => planTree(profile, src), /正本自身/, '正本が通った'); throwsLike(() => applyTree(profile, src), /正本自身/, 'apply で正本が通った'); });
    await t('plan: ツリーの種類を判定する', () => {
      assert(planTree(profile, worktree).info.kind === 'linked-worktree', 'worktree の判定');
      assert(planTree(profile, clone).info.kind === 'clone', 'clone の判定');
      assert(planTree(profile, worktree).info.excludeShared === true, '共有 exclude の判定');
    });
    await t('plan: 不足を複製対象にする', () => {
      const p = planTree(profile, worktree);
      assert(st(p, '.claude/commands/review/review.md') === 'missing', `状態 ${st(p, '.claude/commands/review/review.md')}`);
      assert(p.items.every((i) => !i.rel.includes('__pycache__')), 'キャッシュが対象に入った');
      assert(summarize(p).total === 4, `件数 ${summarize(p).total}`);
    });

    const wt1 = fresh('wt1');
    W(wt1, '.claude/commands/other/own.md', 'other\n'); // セット外（別の出所のコマンド群）
    await t('apply: 不足を複製し2回目は変更0件', () => {
      const r = applyTree(profile, wt1);
      assert(r.done.length === 4, `適用 ${r.done.length}`);
      assert(R(wt1, '.claude/commands/review/review.md') === 'review v1\n', '中身が違う');
      const s = summarize(r.after);
      assert(s.changes === 0 && s.unresolved === 0, `2回目 ${JSON.stringify(s)}`);
      const r2 = applyTree(profile, wt1);
      assert(r2.done.length === 0 && r2.plan.excludeAdds.length === 0, '2回目の apply で変更が出た');
    });
    await t('apply: セット外のファイルに触れない', () => { assert(R(wt1, '.claude/commands/other/own.md') === 'other\n', 'セット外のコマンド群が変わった'); });
    await t('exclude: 未除外のセットのディレクトリを追記する', () => {
      const code = gitOk(wt1, ['check-ignore', '-q', '--no-index', '--', '.claude/scripts/']);
      assert(code === 0, 'scripts が除外されていない');
      assert(gitOk(wt1, ['check-ignore', '-q', '--no-index', '--', '.claude/config.local.json']) === 0, '秘密ファイルが除外されていない');
      assert(g(wt1, ['status', '--porcelain', '--', '.claude/scripts']).trim() === '', 'scripts が未追跡として見える');
    });
    await t('plan: 一致は変更なし', () => { const p = planTree(profile, wt1); assert(p.items.every((i) => i.state === 'same' && !i.action), JSON.stringify(summarize(p))); });

    await t('plan: 正本の更新を検出して更新する', () => {
      W(src, '.claude/commands/review/review.md', 'review v2\n');
      const p = planTree(profile, wt1);
      assert(st(p, '.claude/commands/review/review.md') === 'updated', `状態 ${st(p, '.claude/commands/review/review.md')}`);
      const r = applyTree(profile, wt1);
      assert(R(wt1, '.claude/commands/review/review.md') === 'review v2\n', '更新されない');
      assert(r.backupDir && R(r.backupDir, '.claude/commands/review/review.md') === 'review v1\n', '退避されていない');
    });
    await t('apply: 退避から戻せる', () => {
      const tags = fs.readdirSync(path.join(process.env.UT_ENV_DIR, 'backup')).filter((x) => x.startsWith('wt1-'));
      assert(tags.length === 1, `退避先のフォルダ ${tags.join(',')}`);
      const dirs = fs.readdirSync(path.join(process.env.UT_ENV_DIR, 'backup', tags[0]));
      assert(dirs.length >= 1, '退避先が無い');
      const b = path.join(process.env.UT_ENV_DIR, 'backup', tags[0], dirs[0]);
      assert(R(b, '.claude/commands/review/review.md') === 'review v1\n', '退避の中身が違う');
    });
    await t('plan: 手元の変更は衝突で上書きしない', () => {
      W(wt1, '.claude/commands/review/_rules.md', 'local edit\n');
      W(src, '.claude/commands/review/_rules.md', 'rules v2\n');
      const p = planTree(profile, wt1);
      assert(st(p, '.claude/commands/review/_rules.md') === 'conflict', `状態 ${st(p, '.claude/commands/review/_rules.md')}`);
      const r = applyTree(profile, wt1);
      assert(R(wt1, '.claude/commands/review/_rules.md') === 'local edit\n', '上書きされた');
      assert(summarize(r.after).unresolved === 1, '未解決に数えない');
    });
    await t('apply: --take-source で退避して取り込む', () => {
      const r = applyTree(profile, wt1, { takeSource: ['.claude/commands/review/_rules.md'] });
      assert(R(wt1, '.claude/commands/review/_rules.md') === 'rules v2\n', '取り込まれない');
      assert(R(r.backupDir, '.claude/commands/review/_rules.md') === 'local edit\n', '退避されていない');
    });
    await t('plan: 記録なしの差分は衝突', () => {
      const wt2 = fresh('wt2');
      W(wt2, '.claude/skills/cross/SKILL.md', 'other skill\n');
      const p = planTree(profile, wt2);
      assert(st(p, '.claude/skills/cross/SKILL.md') === 'conflict', `状態 ${st(p, '.claude/skills/cross/SKILL.md')}`);
      applyTree(profile, wt2);
      assert(R(wt2, '.claude/skills/cross/SKILL.md') === 'other skill\n', '上書きされた');
    });
    await t('plan: 正本から消えたものは既定で消さない', () => {
      fs.unlinkSync(path.join(src, '.claude/scripts/lib/a.sh'));
      const p = planTree(profile, wt1);
      assert(st(p, '.claude/scripts/lib/a.sh') === 'removed', `状態 ${st(p, '.claude/scripts/lib/a.sh')}`);
      applyTree(profile, wt1);
      assert(fs.existsSync(path.join(wt1, '.claude/scripts/lib/a.sh')), '消された');
    });
    await t('apply: --prune で退避してから消す', () => {
      const r = applyTree(profile, wt1, { prune: true });
      assert(!fs.existsSync(path.join(wt1, '.claude/scripts/lib/a.sh')), '消えない');
      assert(R(r.backupDir, '.claude/scripts/lib/a.sh') === 'echo a\n', '退避されていない');
      assert(!readManifest(wt1).files[key('.claude/scripts/lib/a.sh')], '記録が残る');
      W(src, '.claude/scripts/lib/a.sh', 'echo a\n');
    });

    await t('plan: CRLF だけの差は一致', () => {
      const wt3 = fresh('wt3');
      W(wt3, '.claude/scripts/lib/a.sh', 'echo a\r\n');
      assert(st(planTree(profile, wt3), '.claude/scripts/lib/a.sh') === 'same', 'CRLF で差分扱い');
    });
    await t('plan: パスの大小文字だけの差は一致', () => {
      const m = readManifest(wt1).files;
      const up = {};
      for (const v of Object.values(m)) up[v.path.toUpperCase()] = { ...v, path: v.path.toUpperCase() };
      writeManifest(wt1, up, src);
      // 記録が大小文字違いで引けないと、一致でも「記録を補う」になり、記録側は「消滅・記録だけ残る」に見える
      const p = planTree(profile, wt1);
      const bad = p.items.filter((i) => ['record', 'drop-record'].includes(i.action) || ['removed', 'gone'].includes(i.state));
      assert(bad.length === 0, `大小文字で別物扱い ${bad.map((i) => `${i.rel}:${i.state}/${i.action}`).join(', ')}`);
    });
    await t('plan: リンクは追従しない', () => {
      const wt4 = fresh('wt4');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(path.join(wt4, '.claude', 'scripts'), { recursive: true });
      fs.symlinkSync(outside, path.join(wt4, '.claude', 'scripts', 'lib'), 'junction');
      const p = planTree(profile, wt4);
      assert(st(p, '.claude/scripts/lib/a.sh') === 'link', `状態 ${st(p, '.claude/scripts/lib/a.sh')}`);
      applyTree(profile, wt4);
      assert(fs.readdirSync(outside).length === 0, 'リンクの先に書いた');
    });
    await t('apply: 壊れたマニフェストは上書きしない側に倒れる', () => {
      const wt5 = fresh('wt5');
      applyTree(profile, wt5);
      W(src, '.claude/commands/review/review.md', 'review v3\n');
      fs.writeFileSync(path.join(wt5, MANIFEST), '{ broken');
      const p = planTree(profile, wt5);
      assert(p.manifestBroken && st(p, '.claude/commands/review/review.md') === 'conflict', `状態 ${st(p, '.claude/commands/review/review.md')}`);
      applyTree(profile, wt5);
      assert(R(wt5, '.claude/commands/review/review.md') === 'review v2\n', '上書きされた');
    });
    await t('apply: 二重起動を拒否', () => {
      fs.writeFileSync(path.join(wt1, LOCK), '{}');
      const e = throwsLike(() => applyTree(profile, wt1), /別の ut-env が実行中/, 'ロック中に通った');
      assert(e instanceof LockError, 'LockError でない');
      fs.unlinkSync(path.join(wt1, LOCK));
    });
    await t('apply: 途中で止まっても再実行で収束', () => {
      const wt6 = fresh('wt6');
      testHooks.failAfter = 2;
      try { throwsLike(() => applyTree(profile, wt6), /中断/, '中断しない'); } finally { testHooks.failAfter = 0; }
      assert(Object.keys(readManifest(wt6).files).length === 2, '途中までの記録が無い');
      assert(!fs.existsSync(path.join(wt6, LOCK)), 'ロックが残った');
      const r = applyTree(profile, wt6);
      assert(r.done.length === 2 && summarize(r.after).changes === 0, `収束しない ${r.done.length}`);
    });
    await t('apply: 追跡ファイルは上書きしない', () => {
      const wt7 = fresh('wt7');
      W(wt7, '.claude/skills/cross/SKILL.md', 'tracked\n');
      g(wt7, ['add', '-f', '.claude/skills/cross/SKILL.md']); g(wt7, ['commit', '-q', '-m', 't']);
      const p = planTree(profile, wt7);
      assert(st(p, '.claude/skills/cross/SKILL.md') === 'tracked', `状態 ${st(p, '.claude/skills/cross/SKILL.md')}`);
      throwsLike(() => applyTree(profile, wt7, { takeSource: ['.claude/skills/cross/SKILL.md'] }), /衝突として計画に無い/, '追跡ファイルを取り込もうとして通った');
      applyTree(profile, wt7);
      assert(R(wt7, '.claude/skills/cross/SKILL.md') === 'tracked\n', '追跡ファイルを上書きした');
    });
    await t('apply: 追跡ファイルは正本から消えても消さず、消えていても書き戻さない', () => {
      const wt10 = fresh('wt10');
      W(wt10, '.claude/scripts/lib/a.sh', 'echo a\n'); // 正本と同じ内容で追跡する
      W(wt10, '.claude/commands/review/_rules.md', R(src, '.claude/commands/review/_rules.md'));
      g(wt10, ['add', '-f', '.claude/scripts/lib/a.sh', '.claude/commands/review/_rules.md']); g(wt10, ['commit', '-q', '-m', 't']);
      applyTree(profile, wt10);
      assert(!readManifest(wt10).files[key('.claude/scripts/lib/a.sh')], '追跡ファイルを記録した');
      fs.unlinkSync(path.join(src, '.claude/scripts/lib/a.sh'));
      applyTree(profile, wt10, { prune: true });
      W(src, '.claude/scripts/lib/a.sh', 'echo a\n');
      assert(fs.existsSync(path.join(wt10, '.claude/scripts/lib/a.sh')), '追跡ファイルを --prune で消した');
      fs.unlinkSync(path.join(wt10, '.claude/commands/review/_rules.md'));
      applyTree(profile, wt10);
      assert(!fs.existsSync(path.join(wt10, '.claude/commands/review/_rules.md')), '作業ツリーで消した追跡ファイルを書き戻した');
    });
    await t('apply: 記録のパスがツリーの外を指したら壊れた記録として扱う', () => {
      const wt11 = fresh('wt11');
      W(base, 'secret-outside.txt', 'outside\n');
      // wt11 から見て ../secret-outside.txt は base 直下のファイル。正本（src）から見ても同じ場所になる
      // 正本の識別は正しくしておく（別の正本の記録として先に弾かれると、パスの検査まで届かない）
      const evil = { version: 2, source: canonAbs(src), files: { '.claude/scripts/evil': { path: '../secret-outside.txt', set: 'review', hash: fileHash(path.join(base, 'secret-outside.txt')) } } };
      W(wt11, MANIFEST, JSON.stringify(evil));
      const p = planTree(profile, wt11);
      assert(p.manifestBroken, '壊れた記録と判定しない');
      assert(!p.items.some((i) => i.rel.includes('..')), 'ツリー外のパスが計画に入った');
      applyTree(profile, wt11, { prune: true });
      assert(fs.existsSync(path.join(base, 'secret-outside.txt')) && R(base, 'secret-outside.txt') === 'outside\n', 'ツリー外のファイルを変えた・消した');
    });
    await t('apply: 正本にセットの中身が無ければ成功にしない', async () => {
      const wt12 = fresh('wt12');
      // ディレクトリはあるが、複製対象が0件（キャッシュだけ）の場合。無いディレクトリは別の警告が先に効くため使わない
      W(src, '.claude/emptyset/__pycache__/x.pyc', 'bin');
      const empty = setProfile({ ...profileObj, sets: { review: ['.claude/emptyset/**'] } });
      const r = applyTree(empty, wt12);
      assert(summarize(r.after).unresolved > 0, '未解決に数えない');
      const d = await doctor(empty, { target: wt12 });
      const c = d.results.find((x) => x.check === 'セット review');
      assert(c && c.status === 'fail', `doctor の判定 ${c && c.status}`);
      assert(!r.plan.warnings.some((w) => w.includes('要素が無い')), '別の警告が先に効いている（この条件では検証にならない）');
      process.env.UT_ENV_PROFILE = pf; fs.writeFileSync(pf, JSON.stringify({ ...profileObj, sets: { review: ['.claude/emptyset/**'] } }));
      const code = await main(['apply', '--target', wt12, '--expect', planTree(empty, wt12).id]);
      assert(code === 2, `終了コード ${code}`);
      profile = setProfile(profileObj);
    });
    await t('exclude: glob 記号を逃がして1つのパスだけに一致させる', () => {
      assert(excludeLine('.claude/a[b]*?.md') === '/.claude/a\\[b\\]\\*\\?.md', `逃がし方 ${excludeLine('.claude/a[b]*?.md')}`);
    });
    await t('plan: 計画に無い --take-source は拒否', () => {
      throwsLike(() => planTree(profile, wt1, { takeSource: ['.claude/commands/review/typo.md'] }), /衝突として計画に無い/, '打ち間違いが通った');
    });
    await t('apply: 途中で止まっても exclude は先に入っている', () => {
      const c13 = path.join(base, 'clone13');
      execFileSync('git', ['clone', '-q', src, c13], { stdio: 'ignore' });
      testHooks.failAfter = 1;
      try { throwsLike(() => applyTree(profile, c13), /中断/, '中断しない'); } finally { testHooks.failAfter = 0; }
      assert(gitOk(c13, ['check-ignore', '-q', '--no-index', '--', MANIFEST]) === 0, '記録が除外されていない');
      const untracked = g(c13, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l.startsWith('??'));
      assert(untracked.length === 0, `未追跡として見える: ${untracked.join(' / ')}`);
    });
    await t('lock: 自分のロックだけを解放する', () => {
      const f = path.join(base, 'x.lock');
      const release = acquireLock(f, 'x');
      fs.writeFileSync(f, JSON.stringify({ token: 'other' }));
      release();
      assert(fs.existsSync(f), '他人のロックを消した');
      fs.unlinkSync(f);
    });
    await t('exclude: 除外済みなら追記しない', () => {
      W(clone, '.git/info/exclude', '/.claude/\n');
      const p = planTree(profile, clone);
      assert(p.excludeAdds.length === 0, `追記しようとした ${p.excludeAdds.join(' ')}`);
    });
    await t('apply: config.json と秘密ファイルを書かない', () => {
      const wt8 = fresh('wt8');
      W(src, '.claude/config.local.json', '{"azure_devops_pat":"x"}');
      const before = fileHash(path.join(wt8, '.claude/config.json'));
      applyTree(profile, wt8);
      assert(fileHash(path.join(wt8, '.claude/config.json')) === before, 'config.json が変わった');
      assert(!fs.existsSync(path.join(wt8, '.claude/config.local.json')), '秘密ファイルが複製された');
      fs.unlinkSync(path.join(src, '.claude/config.local.json'));
    });

    // ---- Codex クロスチェック（計画・コード）の指摘に対する防御
    await t('profile: 別の書き方のパスで秘密ファイルを指せない', () => {
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['./.claude/config.local.json'] } }), /正規の相対パス/, './ が通った');
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['.claude//config.local.json'] } }), /正規の相対パス/, '// が通った');
      throwsLike(() => setProfile({ ...profileObj, sets: { review: ['.claude/./config.local.json'] } }), /正規の相対パス/, '/./ が通った');
      profile = setProfile(profileObj);
    });
    await t('profile: 管理ファイルを含むセット・重なるセットは拒否', () => {
      throwsLike(() => setProfile({ ...profileObj, sets: { review: [MANIFEST] } }), /管理ファイル/, '記録ファイルが通った');
      throwsLike(() => setProfile({ ...profileObj, sets: { a: ['.claude/scripts/**'], b: ['.claude/scripts/lib/**'] } }), /同じパス/, '重なるセットが通った');
      profile = setProfile(profileObj);
    });
    await t('plan: 正本の祖先のリンクを追従しない', () => {
      const outside = path.join(base, 'outside-src');
      W(outside, 'sub/leak.md', 'leak\n');
      fs.symlinkSync(outside, path.join(src, '.claude', 'linkdir'), 'junction');
      const lp = setProfile({ ...profileObj, sets: { linked: ['.claude/linkdir/sub/**'] } });
      const p = planTree(lp, fresh('wt13'));
      assert(p.warnings.some((w) => w.includes('正本のリンク')), `警告が無い ${p.warnings.join(' / ')}`);
      assert(!p.items.some((i) => i.rel.includes('leak')), 'リンクの先のファイルが計画に入った');
      fs.rmSync(path.join(src, '.claude', 'linkdir'), { recursive: false, force: true });
      profile = setProfile(profileObj);
    });
    await t('apply: 管理ファイルの置き場所がリンクなら書かない', () => {
      const c14 = path.join(base, 'clone14');
      execFileSync('git', ['clone', '-q', src, c14], { stdio: 'ignore' });
      const outside = path.join(base, 'outside-ctl');
      fs.mkdirSync(outside, { recursive: true });
      fs.rmSync(path.join(c14, '.claude'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(c14, '.claude'), 'junction');
      throwsLike(() => applyTree(profile, c14), /管理ファイルの置き場所の途中にリンク/, 'リンクのまま進んだ');
      assert(fs.readdirSync(outside).length === 0, `リンクの先に書いた: ${fs.readdirSync(outside).join(',')}`);
    });
    await t('plan: 別の正本の記録は使わない', () => {
      const wt15 = fresh('wt15');
      applyTree(profile, wt15);
      const m = readManifest(wt15, src).files;
      writeManifest(wt15, m, base);
      const p = planTree(profile, wt15);
      assert(p.manifestBroken && p.warnings.some((w) => w.includes('別の正本')), `判定 ${p.warnings.join(' / ')}`);
    });
    await t('apply: 書いた直後に止まっても、正本が進んだ後の再実行で収束', () => {
      const wt16 = fresh('wt16');
      applyTree(profile, wt16);
      const orig = R(src, '.claude/commands/review/review.md');
      W(src, '.claude/commands/review/review.md', 'review v4\n');
      testHooks.failAtWrite = 1;
      // 落ちても差し込みを必ず戻す（戻さないと、後続の試験がすべて同じ理由で落ちる）
      try { throwsLike(() => applyTree(profile, wt16), /failAtWrite/, '中断しない'); } finally { testHooks.failAtWrite = 0; }
      assert(R(wt16, '.claude/commands/review/review.md') === 'review v4\n', '書き込みが起きていない');
      W(src, '.claude/commands/review/review.md', 'review v5\n');
      const p = planTree(profile, wt16);
      assert(st(p, '.claude/commands/review/review.md') === 'updated', `状態 ${st(p, '.claude/commands/review/review.md')}（書き込み予定の記録が効いていない）`);
      const r = applyTree(profile, wt16);
      assert(summarize(r.after).changes === 0 && R(wt16, '.claude/commands/review/review.md') === 'review v5\n', '収束しない');
      W(src, '.claude/commands/review/review.md', orig);
    });
    await t('apply: 計画ID が違えば適用しない', async () => {
      const wt17 = fresh('wt17');
      throwsLike(() => applyTree(profile, wt17, { expect: '000000000000' }), /計画が変わった/, '違う計画ID で通った');
      assert(!fs.existsSync(path.join(wt17, '.claude/commands/review/review.md')), '拒否したのに書いた');
      const code = await main(['apply', '--target', wt17]);
      assert(code === 1, `--expect なしの終了コード ${code}`);
      const id = planTree(profile, wt17).id;
      assert(applyTree(profile, wt17, { expect: id }).done.length > 0, '正しい計画ID で進まない');
    });
    await t('apply: 計画の後に正本が変わったら書かない', () => {
      const wt18 = fresh('wt18');
      const rel = '.claude/commands/review/_rules.md';
      const orig = R(src, rel);
      testHooks.mutateSource = rel;
      try { throwsLike(() => applyTree(profile, wt18), /計画の後に正本が変わった/, '変わった正本を書いた'); } finally { testHooks.mutateSource = ''; }
      assert(!fs.existsSync(path.join(wt18, rel)), '変わった正本の内容を書いた');
      W(src, rel, orig);
    });
    await t('apply: 計画の後に対象が変わったら上書きしない', () => {
      const wt25 = fresh('wt25');
      applyTree(profile, wt25);
      const rel = '.claude/commands/review/review.md';
      const orig = R(src, rel);
      W(src, rel, orig + 'next\n');
      testHooks.mutateTarget = rel;
      try { throwsLike(() => applyTree(profile, wt25), /計画の後に対象が変わった/, '手元の編集を上書きした'); } finally { testHooks.mutateTarget = ''; }
      assert(R(wt25, rel).endsWith('edited after plan\n'), '手元の編集が消えた');
      W(src, rel, orig);
    });
    await t('apply: 手元で消した管理済みファイルは書き戻さない', () => {
      const wt19 = fresh('wt19');
      applyTree(profile, wt19);
      const rel = '.claude/commands/review/review.md';
      fs.unlinkSync(path.join(wt19, rel));
      const p = planTree(profile, wt19);
      assert(st(p, rel) === 'deleted', `状態 ${st(p, rel)}`);
      const r = applyTree(profile, wt19);
      assert(!fs.existsSync(path.join(wt19, rel)) && summarize(r.after).unresolved === 1, '書き戻した、または未解決に数えない');
      applyTree(profile, wt19, { takeSource: [rel] });
      assert(fs.existsSync(path.join(wt19, rel)), '--take-source で戻らない');
    });
    await t('apply: 正本の列挙に警告があれば --prune しない', () => {
      const wt20 = fresh('wt20');
      applyTree(profile, wt20);
      const old = '.claude/commands/review/old.md';
      W(wt20, old, 'old\n');
      const m = readManifest(wt20, src).files;
      m[key(old)] = { path: old, set: 'review', hash: fileHash(path.join(wt20, old)) };
      writeManifest(wt20, m, src);
      const partial = setProfile({ ...profileObj, sets: { review: [...profileObj.sets.review, '.claude/missingdir/**'] } });
      applyTree(partial, wt20, { prune: true });
      assert(fs.existsSync(path.join(wt20, old)), '列挙が不完全なのに消した');
      profile = setProfile(profileObj);
      applyTree(profile, wt20, { prune: true });
      assert(!fs.existsSync(path.join(wt20, old)), '列挙が完全なのに消さない');
    });
    await t('apply: 途中で止まった取り込みを同じ引数で再開できる', () => {
      const wt21 = fresh('wt21');
      const a = '.claude/commands/review/review.md';
      const b2 = '.claude/commands/review/_rules.md';
      W(wt21, a, 'mine a\n'); W(wt21, b2, 'mine b\n');
      testHooks.failAfter = 1;
      try { throwsLike(() => applyTree(profile, wt21, { takeSource: [a, b2] }), /中断/, '中断しない'); } finally { testHooks.failAfter = 0; }
      const r = applyTree(profile, wt21, { takeSource: [a, b2] });
      assert(R(wt21, a) === R(src, a) && R(wt21, b2) === R(src, b2), `再開できない ${r.done.length}`);
    });
    await t('apply: exclude が効かなければ複製しない', () => {
      const c22 = path.join(base, 'clone22');
      execFileSync('git', ['clone', '-q', src, c22], { stdio: 'ignore' });
      W(c22, '.gitignore', '!/.claude/scripts/\n');
      throwsLike(() => applyTree(profile, c22), /除外されない/, '除外が効かないまま進んだ');
      assert(!fs.existsSync(path.join(c22, '.claude/scripts/lib/a.sh')), '複製した');
    });

    // ---- doctor（外部コマンドはスタブ）
    const stub = path.join(base, 'stub.mjs');
    fs.writeFileSync(stub, `
const a = process.argv.slice(2).join(' ');
const mode = process.env.UT_ENV_STUB_MODE || '';
if (a === '--version') { console.log(mode === 'env' ? (process.env.NoDefaultCurrentDirectoryInExePath || 'unset') + ' ' + process.cwd() : '1.2.3'); process.exit(0); }
if (a === 'login status') {
  if (mode === 'notlogged') { console.log('Not logged in'); process.exit(0); }
  console.log('Logged in using ChatGPT as someone' + '@' + 'example.com'); process.exit(0);
}
if (a === 'doctor --json') {
  if (mode === 'badjson') { console.log('not json'); process.exit(0); }
  if (mode === 'emptychecks') { console.log(JSON.stringify({ overallStatus: 'ok', checks: {} })); process.exit(0); }
  if (mode === 'nonzero') { console.log(JSON.stringify({ overallStatus: 'ok', checks: { a: { id: 'a', status: 'ok' } } })); process.exit(1); }
  console.log(JSON.stringify({ overallStatus: 'warning', checks: { 'auth.credentials': { id: 'auth.credentials', status: 'ok', details: { account: 'someone' + '@' + 'example.com' } }, 'x.y': { id: 'x.y', status: 'warning', summary: 'tenant 11111111-2222-3333-4444-555555555555' } } }));
  process.exit(0);
}
if (a === 'account show -o none') { process.exit(mode === 'azfail' ? 1 : 0); }
if (a.startsWith('query HKCU')) { console.log('    TEST_REG_ONLY    REG_SZ    registry-secret-value'); process.exit(a.includes('TEST_REG_ONLY') ? 0 : 1); }
process.exit(2);`);
    for (const n of ['claude', 'codex', 'az', 'reg']) testHooks.cmdStubs[n] = stub;
    W(HOME, '.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'example-plugin@example-marketplace': [] } }));
    W(HOME, '.claude.json', JSON.stringify({ mcpServers: { 'example-mcp': {} } }));
    W(HOME, '.claude/settings.json', '{"permissions":{"allow":["WebFetch(domain:*.backlog.jp)"]}}');
    const SECRET = 'sv-' + crypto.randomBytes(8).toString('hex');
    process.env.TEST_SECRET_ENV = SECRET;
    delete process.env.TEST_REG_ONLY; delete process.env.TEST_MISSING_ENV;
    const dprof = setProfile({
      ...profileObj, env: ['TEST_SECRET_ENV', 'TEST_REG_ONLY'], plugins: ['example-plugin@example-marketplace'], mcp: ['example-mcp'], vscode: true,
      tools: { claude: true, codex: true, az: true },
      backlog: { env: 'TEST_SECRET_ENV', settings_pattern: '*.backlog.jp', space: 'example.backlog.jp' },
    });
    await t('doctor: 秘密の値・メール・テナントIDを出さない', async () => {
      const d = await doctor(dprof, { target: wt1 });
      const text = fmtDoctor(d) + JSON.stringify(d);
      assert(!text.includes(SECRET), '環境変数の値が出た');
      assert(!text.includes('registry-secret-value'), 'レジストリの値が出た');
      assert(!/someone@example\.com/.test(text), 'メールが出た');
      assert(!text.includes('11111111-2222-3333-4444-555555555555'), 'テナント ID が出た');
    });
    await t('doctor: 未反映の環境変数は warn', async () => {
      const d = await doctor(dprof, {});
      const r = d.results.find((x) => x.check === '環境変数 TEST_REG_ONLY');
      assert(r && r.status === 'warn', `判定 ${r && r.status}`);
    });
    await t('doctor: 総数 = ok + warn + fail', async () => {
      // fail を数え落とす欠陥を見るため、fail が1件以上ある状態で照合する
      process.env.UT_ENV_STUB_MODE = 'azfail';
      const d = await doctor(dprof, { target: wt1 });
      delete process.env.UT_ENV_STUB_MODE;
      assert(d.results.some((x) => x.status === 'fail'), 'fail が1件も無く、照合の意味が無い');
      assert(d.total === d.totals.ok + d.totals.warn + d.totals.fail && d.total === d.results.length, JSON.stringify(d.totals));
      assert(fmtDoctor(d).includes(`合計 ${d.total} = ok ${d.totals.ok} + warn ${d.totals.warn} + fail ${d.totals.fail}`), '合計行が無い');
    });
    await t('doctor: 点検の例外が他に波及しない', async () => {
      process.env.UT_ENV_STUB_MODE = 'badjson';
      const d = await doctor(dprof, { target: wt1 });
      delete process.env.UT_ENV_STUB_MODE;
      const r = d.results.find((x) => x.check === 'codex doctor');
      assert(r && r.status === 'fail' && /判定できない/.test(r.message), `codex doctor の判定 ${r && r.status}`);
      assert(d.results.some((x) => x.check === 'Azure CLI のログイン') && d.results.some((x) => x.check.startsWith('セット ')), '後続の点検が消えた');
    });
    await t('doctor: fail のときだけ終了コード1', async () => {
      const okProf = setProfile({ ...profileObj, env: ['TEST_SECRET_ENV'], tools: { az: true } });
      const d1 = await doctor(okProf, {});
      assert(d1.totals.fail === 0, `fail ${d1.totals.fail}`);
      process.env.UT_ENV_STUB_MODE = 'azfail';
      const d2 = await doctor(okProf, {});
      delete process.env.UT_ENV_STUB_MODE;
      assert(d2.totals.fail === 1, `fail ${d2.totals.fail}`);
      const code = await main(['doctor']);
      assert(code === 0, `終了コード ${code}`);
      process.env.UT_ENV_STUB_MODE = 'azfail';
      const code2 = await main(['doctor']);
      delete process.env.UT_ENV_STUB_MODE;
      assert(code2 === 1, `終了コード ${code2}`);
    });
    await t('doctor: 除外されていない秘密ファイルは fail', async () => {
      // リンク worktree は exclude を共有しており、先のテストで追記済みのため、独立した clone で確かめる
      const wt9 = path.join(base, 'clone9');
      execFileSync('git', ['clone', '-q', src, wt9], { stdio: 'ignore' });
      W(wt9, '.claude/config.local.json', '{}');
      const d = await doctor(setProfile(profileObj), { target: wt9 });
      const r = d.results.find((x) => x.check === '秘密ファイル .claude/config.local.json');
      assert(r && r.status === 'fail', `判定 ${r && r.status}`);
      applyTree(setProfile(profileObj), wt9);
      const d2 = await doctor(setProfile(profileObj), { target: wt9 });
      const r2 = d2.results.find((x) => x.check === '秘密ファイル .claude/config.local.json');
      assert(r2 && r2.status === 'warn', `apply 後の判定 ${r2 && r2.status}`);
    });
    await t('doctor: Not logged in をログイン済みにしない', async () => {
      process.env.UT_ENV_STUB_MODE = 'notlogged';
      const d = await doctor(dprof, {});
      delete process.env.UT_ENV_STUB_MODE;
      const r = d.results.find((x) => x.check === 'Codex のログイン');
      assert(r && r.status === 'fail', `判定 ${r && r.status}`);
    });
    await t('doctor: 外部コマンドをカレントディレクトリから探させない', async () => {
      // Claude Code の配下ではこの変数が最初から 1 のことがあり、ツールが渡し忘れても引き継いで通ってしまう。外してから確かめる
      const inherited = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      process.env.UT_ENV_STUB_MODE = 'env';
      let d;
      try { d = await doctor(setProfile({ ...profileObj, tools: { claude: true } }), {}); } finally {
        delete process.env.UT_ENV_STUB_MODE;
        if (inherited !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = inherited;
      }
      const r = d.results.find((x) => x.check === 'Claude Code');
      assert(r && r.message.startsWith('1 '), `NoDefaultCurrentDirectoryInExePath が渡っていない: ${r && r.message}`);
      assert(r.message.toLowerCase().includes(posix(os.tmpdir()).toLowerCase().split('/').pop()), `作業ディレクトリが固定されていない: ${r.message}`);
      throwsLike(() => runCmd('codex', ['a"b']), /渡せない文字/, '引用符を含む引数が通った');
    });
    await t('doctor: JSON の解析エラーで入力の断片を出さない', async () => {
      const frag = 'ghp_' + 'abcdef';
      const saveJ = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8');
      fs.writeFileSync(path.join(HOME, '.claude.json'), `{"mcpServers": {"x": ${frag}}}`);
      const d = await doctor(dprof, {});
      fs.writeFileSync(path.join(HOME, '.claude.json'), saveJ);
      const r = d.results.find((x) => x.check === 'MCP example-mcp');
      assert(r && r.status === 'fail', `判定 ${r && r.status}`);
      assert(!(fmtDoctor(d) + JSON.stringify(d)).includes('abcdef'), '入力の断片が出た');
      // profile 自体が壊れている場合も同じ（誤って秘密を書いた profile の断片を出さない）
      const bad = path.join(base, 'bad-profile.json');
      fs.writeFileSync(bad, `{"source": ${frag}}`);
      const e = throwsLike(() => loadProfile(bad), /JSON として読めない/, '壊れた profile が通った');
      assert(!e.message.includes('abcdef'), 'profile の断片が出た');
    });
    await t('doctor: deny にだけある許可ドメインを許可ありにしない', async () => {
      const saveS = fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8');
      fs.writeFileSync(path.join(HOME, '.claude/settings.json'), '{"permissions":{"deny":["WebFetch(domain:*.backlog.jp)"]}}');
      const d = await doctor(dprof, {});
      fs.writeFileSync(path.join(HOME, '.claude/settings.json'), saveS);
      const r = d.results.find((x) => x.check === 'Backlog の許可ドメイン');
      assert(r && r.status === 'warn', `判定 ${r && r.status}`);
    });
    await t('doctor: 点検が0件なら fail', async () => {
      const d = await doctor(setProfile(profileObj), {});
      assert(d.totals.fail === 1 && d.results[0].check === '点検', JSON.stringify(d.totals));
    });
    await t('doctor: codex doctor の空の結果・非0終了を ok にしない', async () => {
      const cp = setProfile({ ...profileObj, tools: { codex: true } });
      for (const mode of ['emptychecks', 'nonzero']) {
        process.env.UT_ENV_STUB_MODE = mode;
        const d = await doctor(cp, {});
        delete process.env.UT_ENV_STUB_MODE;
        const r = d.results.find((x) => x.check === 'codex doctor');
        assert(r && r.status === 'fail', `${mode} の判定 ${r && r.status}`);
      }
    });
    await t('doctor: https でない SonarQube には接続しない', async () => {
      process.env.TEST_SONAR_URL = 'http://127.0.0.1:9';
      const d = await doctor(setProfile({ ...profileObj, sonarqube: { url_env: 'TEST_SONAR_URL' } }), { online: true });
      delete process.env.TEST_SONAR_URL;
      const r = d.results.find((x) => x.check === 'SonarQube の疎通');
      assert(r && r.status === 'fail' && /https/.test(r.message), `判定 ${r && r.status} ${r && r.message}`);
    });
    await t('doctor: 期待する点検がすべて実施される', async () => {
      const full = setProfile({ ...profileObj, env: ['TEST_SECRET_ENV'], plugins: ['example-plugin@example-marketplace'], mcp: ['example-mcp'], vscode: true, required: ['.claude/commands/review/review.md'], tools: { claude: true, codex: true, az: true } });
      const d = await doctor(full, { target: wt1 });
      const bad = d.results.filter((x) => ['点検漏れ', '点検の重複・想定外'].includes(x.check));
      assert(bad.length === 0, bad.map((x) => x.message).join(' / '));
      // 突き合わせの仕組みとは別に、結果の名前の集合が期待と一致することを直接見る
      const names = d.results.map((x) => x.check).filter((n) => !['警告', '点検漏れ', '点検の重複・想定外'].includes(n)).sort();
      const want = expectedChecks(full, { target: wt1 }).sort();
      assert(JSON.stringify(names) === JSON.stringify(want), `点検の名前が期待と違う: ${names.filter((n) => !want.includes(n)).concat(want.filter((n) => !names.includes(n))).join(', ')}`);
      assert(d.results.some((x) => x.check === '必須ファイル .claude/commands/review/review.md' && x.status === 'ok'), '必須ファイルの点検が無い');
    });
    await t('doctor: 必須ファイルが無ければ fail', async () => {
      const d = await doctor(setProfile({ ...profileObj, required: ['.claude/commands/review/nothing.md'] }), { target: wt1 });
      const r = d.results.find((x) => x.check === '必須ファイル .claude/commands/review/nothing.md');
      assert(r && r.status === 'fail', `判定 ${r && r.status}`);
    });
    await t('doctor: 正本が空でも記録があれば fail', async () => {
      const wt23 = fresh('wt23');
      const rel = '.claude/emptyset/a.md';
      W(wt23, rel, 'a\n');
      writeManifest(wt23, { [key(rel)]: { path: rel, set: 'review', hash: fileHash(path.join(wt23, rel)) } }, src);
      const d = await doctor(setProfile({ ...profileObj, sets: { review: ['.claude/emptyset/**'] } }), { target: wt23 });
      const r = d.results.find((x) => x.check === 'セット review');
      assert(r && r.status === 'fail', `判定 ${r && r.status} ${r && r.message}`);
    });
    await t('doctor: 追跡済みの秘密ファイルは fail', async () => {
      const wt24 = fresh('wt24');
      W(wt24, '.claude/config.local.json', '{}');
      g(wt24, ['add', '-f', '.claude/config.local.json']); g(wt24, ['commit', '-q', '-m', 's']);
      const d = await doctor(setProfile(profileObj), { target: wt24 });
      const r = d.results.find((x) => x.check === '秘密ファイル .claude/config.local.json');
      assert(r && r.status === 'fail' && /追跡/.test(r.message), `判定 ${r && r.status} ${r && r.message}`);
    });
    await t('doctor: --json の標準出力は JSON だけ', async () => {
      setProfile({ ...profileObj, env: ['TEST_SECRET_ENV'] });
      const logs = [];
      const orig = console.log;
      console.log = (s) => logs.push(String(s));
      try { await main(['doctor', '--json']); } finally { console.log = orig; }
      const o = JSON.parse(logs.join('\n'));
      assert(o.total === 1 && o.profile, `JSON の中身 ${Object.keys(o)}`);
    });
    // 表示の前にマスクが掛かるため、通信の子プロセスへ渡す値そのものを見る（マスクに頼らずキーを argv や戻り値に出さないこと）。
    // 本物の通信はしない: net.run を差し替えて、起動されたかと渡された値を記録する
    const fakeNet = (reply = { err: 'ECONNREFUSED' }) => {
      const calls = [];
      net.run = (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); return { stdout: JSON.stringify(reply) + '\n' }; };
      return calls;
    };
    const realRun = net.run;
    await t('online: キーは公式の Backlog の https の送り先にだけ送る（陽性対照）', () => {
      const calls = fakeNet({ code: 200 });
      try {
        const st = onlineStatus('https://example.backlog.jp/api/v2/users/myself', 'TEST_SECRET_ENV');
        assert(st.ok && calls.length === 1, `送るべき送り先で送らなかった ${JSON.stringify(st)} / 起動 ${calls.length} 回`);
        const c = calls[0];
        assert(!c.args.join(' ').includes(SECRET) && !c.env.UT_ENV_URL.includes(SECRET), 'キーが argv か URL に入った');
        assert(c.env.UT_ENV_API_KEY === SECRET && !('TEST_SECRET_ENV' in c.env), 'キーを固定の名前で渡していない（profile の変数名が子の環境にある）');
        assert(!JSON.stringify(st).includes(SECRET), 'キーが戻り値に入った');
      } finally { net.run = realRun; }
    });
    await t('online: 公式の Backlog 以外へはキーを送らない（子プロセスを起動しない）', () => {
      const bad = {
        'http': 'http://example.backlog.jp/api/v2/users/myself',
        '別のホスト': 'https://evil.example.com/api/v2/users/myself',
        '公式ドメインの後ろに別のドメイン': 'https://example.backlog.jp.evil.example/api/v2/users/myself',
        '末尾のドット': 'https://example.backlog.jp./api/v2/users/myself',
        '複数のラベルのスペース': 'https://a.b.backlog.jp/api/v2/users/myself',
        '国際化ドメイン': 'https://xn--eckwd4c7c.backlog.jp/api/v2/users/myself',
        '認証情報入り': 'https://user:pass' + '@' + 'example.backlog.jp/api/v2/users/myself',
        '既定以外のポート': 'https://example.backlog.jp:8443/api/v2/users/myself',
        'クエリ付き': 'https://example.backlog.jp/api/v2/users/myself?x=1',
        'フラグメント付き': 'https://example.backlog.jp/api/v2/users/myself#x',
        'API 以外のパス': 'https://example.backlog.jp/users/myself',
        'ループバック（IPv4）': 'https://127.0.0.1/api/v2/users/myself',
        'ループバック（IPv6）': 'https://[::1]/api/v2/users/myself',
        'localhost': 'https://localhost/api/v2/users/myself',
        '壊れた URL': 'https://',
      };
      const calls = fakeNet();
      try {
        for (const [label, u] of Object.entries(bad)) {
          const st = onlineStatus(u, 'TEST_SECRET_ENV');
          assert(st.err === 'destination_refused', `${label}: 拒否しない ${JSON.stringify(st)}`);
        }
        assert(calls.length === 0, `拒否すべき送り先で子プロセスを ${calls.length} 回起動した`);
        // 大文字小文字の違いは同じ送り先として扱う（正規化して受け付ける）
        assert(onlineStatus('https://EXAMPLE.Backlog.JP/api/v2/users/myself', 'TEST_SECRET_ENV').err !== 'destination_refused', '大文字の公式ドメインを拒否した');
      } finally { net.run = realRun; }
    });
    await t('online: 通信の子プロセスへ NODE_OPTIONS やプロキシの変数を渡さない', () => {
      const keep = { NODE_OPTIONS: process.env.NODE_OPTIONS, HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
      process.env.NODE_OPTIONS = '--require=C:/nothing.js'; process.env.HTTPS_PROXY = 'http://127.0.0.1:9'; process.env.NODE_USE_ENV_PROXY = '1';
      const calls = fakeNet();
      try {
        onlineStatus('https://example.backlog.jp/api/v2/users/myself', 'TEST_SECRET_ENV');
        const env = calls[0] && calls[0].env;
        assert(env && !('NODE_OPTIONS' in env) && !('HTTPS_PROXY' in env) && !('NODE_USE_ENV_PROXY' in env), `渡した環境の変数: ${env && Object.keys(env).join(',')}`);
        assert(env.SystemRoot || env.SYSTEMROOT || process.platform !== 'win32', '起動に要る SystemRoot を渡していない');
      } finally {
        net.run = realRun;
        for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    });
    await t('online: キーの変数名が NODE_OPTIONS などでも、その名前を子の環境に作らない', () => {
      // PATH などの起動に要る変数は、もともと許可して渡すため対象にしない（ここでは許可していない名前で持ち込めないことを見る）
      for (const name of ['NODE_OPTIONS', 'HTTPS_PROXY', 'UT_ENV_URL']) {
        const keep = process.env[name]; process.env[name] = SECRET;
        const calls = fakeNet();
        try {
          onlineStatus('https://example.backlog.jp/api/v2/users/myself', name);
          const env = calls[0].env;
          assert(env.UT_ENV_API_KEY === SECRET, `${name}: キーを固定の名前で渡していない`);
          assert(env[name] !== SECRET, `${name}: profile の変数名で値を子の環境に入れた`);
          assert(env.UT_ENV_URL === 'https://example.backlog.jp/api/v2/users/myself', `${name}: 送り先が書き換わった`);
        } finally { net.run = realRun; if (keep === undefined) delete process.env[name]; else process.env[name] = keep; }
      }
    });
    await t('git: 作業フォルダ・相対パスの場所の git を選ばない', () => {
      const exe = process.platform === 'win32' ? 'git.exe' : 'git';
      const cwdDir = path.join(base, 'target-tree-git'); fs.mkdirSync(path.join(cwdDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(cwdDir, exe), ''); fs.writeFileSync(path.join(cwdDir, 'bin', exe), '');
      const binDir = path.join(base, 'trusted-git'); fs.mkdirSync(binDir, { recursive: true }); fs.writeFileSync(path.join(binDir, exe), '');
      const sep = process.platform === 'win32' ? ';' : ':';
      const keepCwd = process.cwd(); process.chdir(cwdDir);
      try {
        assert(resolveOnPath('git', { PATH: ['', '.', 'bin', binDir].join(sep) }) === path.join(binDir, exe), '作業フォルダか相対パスの場所の git を選んだ');
        assert(resolveOnPath('git', { PATH: ['.', 'bin'].join(sep) }) === null, '絶対パスの場所が無いのに git を返した');
      } finally { process.chdir(keepCwd); }
    });
    await t('git: 対象のツリーの設定（fsmonitor・hook）から外部コマンドを起動しない', () => {
      const r = path.join(base, 'git-guard-probe'); fs.mkdirSync(path.join(r, 'evil-hooks'), { recursive: true });
      const hit = path.join(base, 'git-guard-hit.txt').replace(/\\/g, '/');
      const fsm = path.join(base, 'fsm-probe.sh');
      fs.writeFileSync(fsm, '#!/bin/sh\necho fsm >> "' + hit + '"\n');
      fs.writeFileSync(path.join(r, 'evil-hooks', 'post-index-change'), '#!/bin/sh\necho hook >> "' + hit + '"\n');
      // Linux などでは、実行の権限が無い hook・fsmonitor のスクリプトは起動しない（陽性対照が成立しなくなる）。Windows では不要
      try { fs.chmodSync(fsm, 0o755); fs.chmodSync(path.join(r, 'evil-hooks', 'post-index-change'), 0o755); } catch { /* Windows では不要 */ }
      g(r, ['init', '-q']); fs.writeFileSync(path.join(r, 'a.txt'), 'a\n'); g(r, ['add', 'a.txt']); g(r, ['commit', '-q', '-m', 'a']);
      // 値は sh に渡されるため、一時フォルダの名前の記号で崩れないよう引用符で囲む
      g(r, ['config', 'core.fsmonitor', '"' + fsm.replace(/\\/g, '/') + '"']); g(r, ['config', 'core.hooksPath', 'evil-hooks']);
      const touch = () => { const tm = new Date(Date.now() + Math.floor(Math.random() * 100000)); fs.utimesSync(path.join(r, 'a.txt'), tm, tm); };
      fs.rmSync(hit, { force: true }); touch();
      try { execFileSync('git', ['-C', r, 'status', '--porcelain'], { stdio: 'ignore' }); } catch { /* 起動の有無だけを見る */ }
      assert(fs.existsSync(hit), '陽性対照: 対策を付けない git status でも仕掛けたコマンドが起動しない（試験の前提が崩れている）');
      fs.rmSync(hit, { force: true }); touch();
      git(r, ['status', '--porcelain']); git(r, ['ls-files', '-z']); git(r, ['rev-parse', '--show-toplevel']);
      assert(!fs.existsSync(hit), `対象のツリーの設定から外部コマンドを起動した: ${fs.existsSync(hit) ? fs.readFileSync(hit, 'utf8').trim() : ''}`);
    });
    await t('online: profile の backlog.env に起動に使う変数・内部の変数の名前を使わせない', () => {
      for (const name of ['PATH', 'Path', 'HOME', 'APPDATA', 'UT_ENV_URL', 'ut_env_api_key']) {
        throwsLike(() => setProfile({ ...profileObj, backlog: { env: name, space: 'example.backlog.jp' } }), /使えない/, `${name} を受け付けた`);
      }
    });
    // 本物の子プロセスが返す値を見る（親の選別に頼らずキーを返さないこと）。送り先の検査は公式の URL で通し、起動の直前に
    // 送り先だけを、つながらないループバックへ差し替える（外への通信を起こさない）
    await t('online: 通信の子プロセスがキーを返さない', () => {
      net.run = (cmd, args, opts) => realRun(cmd, args, { ...opts, env: { ...opts.env, UT_ENV_URL: 'http://127.0.0.1:9/api/v2/users/myself' } });
      try {
        const st = onlineStatus('https://example.backlog.jp/api/v2/users/myself', 'TEST_SECRET_ENV');
        assert(!st.ok && st.code === null, `接続できないはずが ${JSON.stringify(st)}`);
        assert(!JSON.stringify(st).includes(SECRET), 'キーが戻り値に入った');
        assert(/^[A-Za-z_]+$/.test(st.err), `例外の型以外が入った: ${st.err}`);
      } finally { net.run = realRun; }
    });
    // 例と文書は、このファイルのあるリポジトリから読む。掃引は変異を入れた写しを一時フォルダで動かすため、UT_ENV_TEST_REPO で場所を渡す
    // （自己テストが読むファイルの場所を決めるだけで、ツールの動きには関わらない）
    const TEST_REPO = process.env.UT_ENV_TEST_REPO || path.join(path.dirname(SELF), '..');
    // 利用者が写して使う例は、source（置き換えが前提の実在しないパス）以外の値のままで、profile の検査を通らなければならない
    await t('profile: 例（tools/ut-env.profile.example.json）は source を差し替えれば読み込める', () => {
      const ex = JSON.parse(fs.readFileSync(path.join(TEST_REPO, 'tools', 'ut-env.profile.example.json'), 'utf8'));
      const p = setProfile({ ...ex, source: src });
      assert(p && Object.keys(p.sets).length > 0, '例のセットが読み込まれない');
    });
    // 文書（docs/ut-envsetup.md）に載せた、任意の項目をすべて使った例も、source を差し替えれば読み込めなければならない
    await t('profile: 文書の全項目の例は source を差し替えれば読み込める', () => {
      const doc = fs.readFileSync(path.join(TEST_REPO, 'docs', 'ut-envsetup.md'), 'utf8');
      const m = /```json\r?\n([\s\S]*?)```/.exec(doc);
      assert(m, '文書に json の例が見つからない');
      const ex = JSON.parse(m[1]);
      const p = setProfile({ ...ex, source: src });
      assert(p.backlog && p.sonarqube && Object.keys(p.sets).length > 0, '全項目の例の任意の項目が読み込まれない');
    });
    await t('試験用の差し込みは環境変数では効かない（計画に無い書き込み・外部コマンドの差し替えをさせない）', () => {
      const keep = { ...process.env };
      process.env.UT_ENV_MUTATE_SOURCE = 'x'; process.env.UT_ENV_MUTATE_TARGET = 'x'; process.env.UT_ENV_FAIL_AFTER = '1'; process.env.UT_ENV_CMD_AZ = 'evil.mjs';
      try {
        assert(testHooks.mutateSource === '' && testHooks.mutateTarget === '' && testHooks.failAfter === 0, '環境変数が試験用の差し込みに入った');
        assert(!/UT_ENV_(MUTATE|FAIL|CMD_)/.test(fs.readFileSync(SELF, 'utf8').split('async function selftest(')[0].replace(/\/\/.*$/gm, '')), '本番の経路に試験用の環境変数の読み取りが残っている');
      } finally {
        for (const k of ['UT_ENV_MUTATE_SOURCE', 'UT_ENV_MUTATE_TARGET', 'UT_ENV_FAIL_AFTER', 'UT_ENV_CMD_AZ']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
      }
    });
    await t('online: profile の backlog.space は公式ドメインの形だけを受け付ける', () => {
      throwsLike(() => setProfile({ ...profileObj, backlog: { env: 'TEST_SECRET_ENV', space: 'evil.example.com' } }), /公式ドメイン/, '公式でないドメインを受け付けた');
      throwsLike(() => setProfile({ ...profileObj, backlog: { env: 'TEST_SECRET_ENV', space: 'example.backlog.jp.' } }), /公式ドメイン/, '末尾のドットを受け付けた');
    });
    await t('online: Backlog の点検は、送り先の検査を通った宛先にだけ送り、例外でキーを出さない', async () => {
      const calls = fakeNet();
      try {
        const d = await doctor(dprof, { online: true });
        const r = d.results.find((x) => x.check === 'Backlog API（読み取り）');
        assert(r && r.status === 'fail', `判定 ${r && r.status}`);
        assert(calls.length === 1 && calls[0].env.UT_ENV_URL === 'https://example.backlog.jp/api/v2/users/myself', `送り先 ${calls[0] && calls[0].env.UT_ENV_URL}`);
        assert(!(fmtDoctor(d) + JSON.stringify(d)).includes(SECRET), 'キーが出た');
      } finally { net.run = realRun; }
    });
    // 本物の子プロセスで、リダイレクトをたどらないことを確かめる。キーは付けない（キー付きの通信はループバックへは送れない）。
    // サーバーは別のプロセスで動かす（onlineStatus は同期で待つため、同じプロセスのサーバーは応答できない）
    await t('online: リダイレクトをたどらない（転送先へ1件も届かない）', async () => {
      const srv = `const http = require('http'); let hits = 0;
const b = http.createServer((q, s) => { hits++; s.end('b'); }).listen(0, '127.0.0.1', () => {
  const a = http.createServer((q, s) => { s.writeHead(302, { Location: 'http://127.0.0.1:' + b.address().port + '/x' }); s.end(); }).listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ a: a.address().port }));
    process.stdin.on('data', () => { console.log(JSON.stringify({ hits })); process.exit(0); });
  });
});`;
      const { spawn } = await import('node:child_process');
      const p = spawn(process.execPath, ['-e', srv], { stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = [];
      const next = () => new Promise((res) => { const f = () => { if (lines.length) return res(lines.shift()); setTimeout(f, 20); }; f(); });
      let buf = '';
      p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      try {
        const { a } = JSON.parse(await next());
        const st = onlineStatus(`http://127.0.0.1:${a}/start`, null);
        p.stdin.write('done\n');
        const { hits } = JSON.parse(await next());
        assert(st.code === 302, `転送の応答をそのまま返さない ${JSON.stringify(st)}`);
        assert(hits === 0, `転送先へ ${hits} 件届いた（リダイレクトをたどった）`);
      } finally { try { p.kill(); } catch { /* 終了済み */ } }
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows で掴まれていても結果には影響しない */ }
  }
  for (const r of results) console.log(`${r.ok ? 'OK' : 'NG'}  ${r.name}${r.ok ? '' : ` — ${r.msg}`}`);
  const ng = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng} 件パス / ${ng} 件失敗`);
  return ng === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
