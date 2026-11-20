#!/usr/bin/env node
// ut-clean: 再生成できるものだけを、承認した計画に載ったものに限って削除する道具（/ut-diskclean の本体）。
// 削除の防御（パスの境界比較・リンクをたどらない・除外対象・削除直前の再測定・計画との照合）を、
// 毎回モデルが組み立てる手順ではなく、この部品の検査にする。
//
//   node tools/ut-clean.mjs scan  [--extra <path>]... [--min-size <GB>] [--json]     （候補の一覧と計画ID。削除しない）
//   node tools/ut-clean.mjs apply --expect <計画ID> --scope high|high-mid|ids:1,2,3 [--dry-run] [--json]
//   node tools/ut-clean.mjs --selftest
//
// 方針:
//  - scan は何も削除しない。候補を測り、計画（実パスつき）を UT_CLEAN_DIR（既定 <USERPROFILE>/.claude/work/diskclean）へ保存し、計画IDを出す。
//    計画を保存できなかったときは計画IDを出さない（削除へ進めない）。
//  - apply は、計画IDと範囲（high / high-mid / ids:…）の指定がそろったときだけ動く。会話での確認は /ut-diskclean が取る（この部品は確認の有無を見られない）。
//  - 削除の直前に、1件ずつ「計画に載っているか・リンクに置き換わっていないか・除外対象でないか・測り直した値が承認時から大きく動いていないか」を確かめる。
//    動いていたら削除せず「再承認」に戻す。
//  - リンク（ジャンクション・シンボリックリンク）・ハードリンクを含むもの、測れないものは「確認が必要」にして一括削除の対象から外す。
//  - 管理者権限への昇格はしない。権限で失敗するものは失敗として報告する。
//  - 実パスは計画ファイルにだけ書く。画面には <USERPROFILE> に戻した形で出す。
//
// 限界（この部品が見ないもの）:
//  - OneDrive 等の同期フォルダは、パスの形（環境変数・ユーザー直下の OneDrive*）で除く。リンクの属性そのものは読まない。
//  - 起動中のプロセスが掴んでいるファイルは消せない。その場合は部分成功か失敗として報告する。
//  - 8.3 短縮名など、解決後のパスと一致しない表記は、リンクを経由するパスとして除く。
//
// exit: 0 正常 / 1 入力の誤り・計画が使えない / 2 選んだものを全部は削除できなかった（または 0 件）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const W = path.win32;

export class InputError extends Error {}

const PLAN_MAX_AGE_MS = 24 * 3600 * 1000;
const PLAN_FUTURE_SKEW_MS = 5 * 60 * 1000;
// 測り直した値が承認時から動いてよい幅（これを超えたら再承認）
const DRIFT = { minBytes: MiB, ratio: 0.05, countAbs: 5, countRatio: 0.05 };
const DEFAULT_MAX_ENTRIES = 3000000;
const MAX_DEPTH = 8;
const S = { HIGH: '高', MID: '中', LOW: '低', CONFIRM: '確認が必要' };
const SAFETY_VALUES = Object.values(S);

// ---------------------------------------------------------------- パス
// 比較用の鍵。大文字小文字・末尾の区切り・Unicode の正規化を揃える（表示用の文字列では比べない）
// （W.normalize('C:') は 'C:.' を返すので、ドライブ文字だけの形は揃え直す）
const key = (p) => W.normalize(String(p)).normalize('NFC').replace(/^([A-Za-z]:)\.$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
// パス区切りの境界で比べる（C:\Temp が C:\TempX に当たらない）
export function isWithin(child, parent) {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p + '\\');
}

const DEFAULT_IO = {
  lstat: (p) => fs.lstatSync(p),
  readdir: (p, o) => fs.readdirSync(p, o),
  realpath: (p) => fs.realpathSync.native(p),
  rm: (p) => fs.rmSync(p, { recursive: true, force: false }),
  now: () => Date.now(),
  free: (root) => { const s = fs.statfsSync(root); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; },
};
const io = (cfg, name) => (cfg.hooks && cfg.hooks[name]) || DEFAULT_IO[name];

export function defaultConfig(env = process.env) {
  const sys = String(env.SystemDrive || 'C:').toUpperCase();
  const root = sys + '\\';
  const profile = env.USERPROFILE;
  const local = env.LOCALAPPDATA;
  if (!profile || !local) throw new InputError('USERPROFILE / LOCALAPPDATA が未設定');
  const P = (...a) => W.join(...a);
  const vsPackages = P(root, 'ProgramData', 'Microsoft', 'VisualStudio', 'Packages');
  const pkgCache = P(root, 'ProgramData', 'Package Cache');
  const syncZones = [];
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) if (env[k]) syncZones.push(env[k]);
  try { for (const n of fs.readdirSync(profile)) if (/^onedrive/i.test(n)) syncZones.push(P(profile, n)); } catch { /* 読めなければ環境変数の分だけ */ }
  return {
    drive: sys, driveRoot: root, profile,
    tempRoots: [P(root, 'TEMP'), P(root, 'Temp'), P(root, 'Windows', 'Temp'), P(local, 'Temp')],
    cacheRoots: [
      { path: P(profile, '.nuget', 'packages'), safety: S.MID, kind: 'パッケージキャッシュ', reason: '再取得できるが時間がかかる' },
      { path: P(profile, '.npm'), safety: S.MID, kind: 'パッケージキャッシュ', reason: '再取得できるが時間がかかる' },
      { path: P(profile, '.cache'), safety: S.CONFIRM, kind: 'パッケージキャッシュ', reason: 'ログイン状態や再取得困難な資産が入っていることがある' },
      { path: vsPackages, safety: S.MID, kind: 'VS関連', reason: 'VS の修復時に再ダウンロードが要る' },
      { path: pkgCache, safety: S.MID, kind: 'VS関連', reason: 'VS の修復・アンインストール時に必要' },
    ],
    projectRoot: root,
    projectSkip: ['windows', 'program files', 'program files (x86)', 'programdata', 'users', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'temp', 'msocache', 'documents and settings'],
    projectMarkers: ['.git', 'package.json', 'cargo.toml'],
    projectMarkerExts: ['.sln', '.csproj'],
    artifacts: {
      bin: { safety: S.HIGH, kind: 'ビルド成果物', reason: '再ビルドで復元できる' },
      obj: { safety: S.HIGH, kind: 'ビルド成果物', reason: '再ビルドで復元できる' },
      target: { safety: S.HIGH, kind: 'ビルド成果物', reason: '再ビルドで復元できる' },
      '.vs': { safety: S.HIGH, kind: 'ビルド成果物', reason: 'IDE を閉じてから消す（開いていると失敗する）' },
      testresults: { safety: S.HIGH, kind: 'ビルド成果物', reason: '再実行で復元できる' },
      node_modules: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: '手修正したパッチが入っていないか確認が要る' },
      dist: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: '唯一の納品物でないか確認が要る' },
      build: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: '唯一の納品物でないか確認が要る' },
      out: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: '唯一の納品物でないか確認が要る' },
      logs: { safety: S.CONFIRM, kind: 'ログ', reason: '障害調査・監査証跡でないか確認が要る' },
    },
    zones: [
      { p: P(root, 'Windows'), except: [P(root, 'Windows', 'Temp')] },
      { p: P(root, 'Program Files') },
      { p: P(root, 'Program Files (x86)') },
      { p: P(root, 'ProgramData'), except: [vsPackages, pkgCache] },
      { p: P(local, 'Packages') },
      { p: P(profile, 'Documents') },
      { p: P(profile, 'Desktop') },
      { p: P(profile, 'Downloads') },
    ],
    syncZones,
    planDir: env.UT_CLEAN_DIR || P(profile, '.claude', 'work', 'diskclean'),
    maxDepth: MAX_DEPTH,
    maxEntries: DEFAULT_MAX_ENTRIES,
  };
}

// 候補にしてはいけない場所の理由（なければ null）。副作用なし（ファイルに触れない）
export function classifyPath(abs, cfg) {
  const p = String(abs);
  if (/^[\\/]{2}/.test(p)) return 'ネットワークパス（UNC）';
  const m = /^([A-Za-z]):/.exec(p);
  if (!m) return 'ドライブ文字を持たない';
  if (m[1].toUpperCase() + ':' !== String(cfg.drive).toUpperCase()) return '対象ドライブ（' + cfg.drive + '）以外';
  if (/(^|[\\/])\.\.?([\\/]|$)/.test(p)) return '相対表記を含む';
  if (key(p) === key(cfg.driveRoot)) return 'ドライブ直下';
  for (const z of cfg.syncZones || []) {
    if (isWithin(p, z)) return '同期フォルダ（OneDrive 等）';
    if (isWithin(z, p)) return '同期フォルダを含む';
  }
  if (key(p).split('\\').includes('.git')) return '.git';
  for (const z of cfg.zones || []) {
    if (isWithin(p, z.p) && !(z.except || []).some((e) => isWithin(p, e))) return '除外対象';
    if (isWithin(z.p, p)) return '除外対象を含む';
  }
  return null;
}

// ---------------------------------------------------------------- 測定
// 1つの候補の大きさを測る。リンクはたどらず数える。読めない・多すぎるときは測定不能（0 にしない）
export function measure(top, cfg) {
  const lstat = io(cfg, 'lstat');
  const readdir = io(cfg, 'readdir');
  const max = cfg.maxEntries || DEFAULT_MAX_ENTRIES;
  const out = { size: 0, count: 0, links: 0, hardlinks: 0, errors: 0, errorCodes: [], truncated: false, mtimeMs: null, isDir: false };
  let st;
  try { st = lstat(top); } catch (e) { out.errors++; out.errorCodes.push(e.code || 'ERR'); return out; }
  out.mtimeMs = st.mtimeMs;
  if (st.isSymbolicLink()) { out.links++; return out; }
  if (!st.isDirectory()) {
    out.size = st.size; out.count = 1;
    if (st.nlink > 1) out.hardlinks++;
    return out;
  }
  out.isDir = true;
  const stack = [top];
  while (stack.length) {
    const d = stack.pop();
    let names;
    try { names = readdir(d); } catch (e) { out.errors++; if (!out.errorCodes.includes(e.code || 'ERR')) out.errorCodes.push(e.code || 'ERR'); continue; }
    for (const n of names) {
      if (out.count >= max) { out.truncated = true; return out; }
      const f = W.join(d, n);
      let s;
      try { s = lstat(f); } catch (e) { out.errors++; if (!out.errorCodes.includes(e.code || 'ERR')) out.errorCodes.push(e.code || 'ERR'); continue; }
      if (s.isSymbolicLink()) { out.links++; continue; }
      out.count++;
      if (s.isDirectory()) { stack.push(f); continue; }
      out.size += s.size;
      if (s.nlink > 1) out.hardlinks++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 候補の列挙
export function buildCandidates(cfg, opts = {}) {
  const lstat = io(cfg, 'lstat');
  const readdir = io(cfg, 'readdir');
  const realpath = io(cfg, 'realpath');
  const minBytes = Math.max(0, Number(opts.minSizeGB || 0)) * GiB;
  const excluded = [];
  const notFound = [];
  const raw = [];
  const seen = new Set();

  const consider = (absIn, meta) => {
    const abs = W.resolve(absIn);
    const why0 = classifyPath(abs, cfg); // ファイルに触れる前に、形だけで除く
    if (why0) { excluded.push({ path: abs, reason: why0 }); return; }
    let st;
    try { st = lstat(abs); } catch (e) {
      if (e && e.code === 'ENOENT') { notFound.push(abs); return; }
      excluded.push({ path: abs, reason: '状態を読めない（' + ((e && e.code) || 'ERR') + '）' }); return;
    }
    if (st.isSymbolicLink()) { excluded.push({ path: abs, reason: 'リンク（たどらない）' }); return; }
    let real;
    try { real = realpath(abs); } catch (e) { excluded.push({ path: abs, reason: 'パスを解決できない（' + ((e && e.code) || 'ERR') + '）' }); return; }
    if (key(real) !== key(abs)) { excluded.push({ path: abs, reason: 'リンクを経由するパス（解決後と一致しない）' }); return; }
    const why1 = classifyPath(real, cfg);
    if (why1) { excluded.push({ path: real, reason: why1 }); return; }
    raw.push({ path: real, ...meta });
  };

  // 1. 一時フォルダ: 中身を1件ずつ（フォルダそのものは候補にしない）
  for (const root of cfg.tempRoots) {
    const r = W.resolve(root);
    const why = classifyPath(r, cfg);
    if (why) { excluded.push({ path: r, reason: why }); continue; }
    let st;
    try { st = lstat(r); } catch (e) { if (e && e.code === 'ENOENT') notFound.push(r); else excluded.push({ path: r, reason: '状態を読めない（' + ((e && e.code) || 'ERR') + '）' }); continue; }
    if (st.isSymbolicLink()) { excluded.push({ path: r, reason: 'リンク（たどらない）' }); continue; }
    let real;
    try { real = realpath(r); } catch { excluded.push({ path: r, reason: 'パスを解決できない' }); continue; }
    if (seen.has(key(real))) continue; // C:\TEMP と C:\Temp は同じ場所
    seen.add(key(real));
    let names;
    try { names = readdir(real); } catch (e) { excluded.push({ path: real, reason: '一覧を読めない（' + ((e && e.code) || 'ERR') + '）' }); continue; }
    for (const n of names) consider(W.join(real, n), { kind: '一時', safety: S.HIGH, reason: '再生成できる一時ファイル（起動中のプロセスが掴むものは消せない）' });
  }
  // 2. パッケージキャッシュ・VS 関連: 場所そのもの
  for (const c of cfg.cacheRoots) consider(c.path, { kind: c.kind, safety: c.safety, reason: c.reason });
  // 3. プロジェクト成果物
  const projectRoot = W.resolve(cfg.projectRoot);
  const skip = new Set(cfg.projectSkip.map((s) => s.toLowerCase()));
  let top = [];
  try { top = readdir(projectRoot, { withFileTypes: true }); } catch (e) { excluded.push({ path: projectRoot, reason: '一覧を読めない（' + ((e && e.code) || 'ERR') + '）' }); }
  const walk = (dir, depth) => {
    if (depth > cfg.maxDepth) return;
    let ents;
    try { ents = readdir(dir, { withFileTypes: true }); } catch (e) { excluded.push({ path: dir, reason: '一覧を読めない（' + ((e && e.code) || 'ERR') + '）' }); return; }
    for (const d of ents) {
      if (d.isSymbolicLink() || !d.isDirectory()) continue;
      const lower = d.name.toLowerCase();
      const f = W.join(dir, d.name);
      if (lower === '.git') continue;
      const a = Object.prototype.hasOwnProperty.call(cfg.artifacts, lower) ? cfg.artifacts[lower] : null;
      if (a) { consider(f, { kind: a.kind, safety: a.safety, reason: a.reason }); continue; }
      walk(f, depth + 1);
    }
  };
  for (const d of top) {
    if (!d.isDirectory() || d.isSymbolicLink() || skip.has(d.name.toLowerCase())) continue;
    const proj = W.join(projectRoot, d.name);
    let names = [];
    try { names = readdir(proj).map((x) => String(x).toLowerCase()); } catch { continue; }
    const marked = names.some((n) => cfg.projectMarkers.includes(n) || cfg.projectMarkerExts.some((e) => n.endsWith(e)));
    if (marked) walk(proj, 0);
  }
  // 4. 追加指定: 判定できないので「確認が必要」
  for (const x of opts.extras || []) consider(x, { kind: 'その他', safety: S.CONFIRM, reason: '追加指定（安全度を判定できない）' });

  // 測る
  let items = raw.map((r) => {
    const m = measure(r.path, cfg);
    let safety = r.safety;
    let reason = r.reason;
    let size = m.size;
    let count = m.count;
    if (m.errors || m.truncated) { safety = S.CONFIRM; reason = '測定不能（' + (m.truncated ? '要素数が多すぎる' : '読めない: ' + m.errorCodes.join(',')) + '）。' + reason; size = null; count = null; }
    else if (m.links || m.hardlinks) { safety = S.CONFIRM; reason = (m.links ? 'リンク ' + m.links + ' 件を含む' : '') + (m.links && m.hardlinks ? '・' : '') + (m.hardlinks ? 'ハードリンク ' + m.hardlinks + ' 件を含む' : '') + '（一括削除の対象にしない）。' + reason; }
    return { path: r.path, key: key(r.path), kind: r.kind, safety, reason, size, count, links: m.links, hardlinks: m.hardlinks, errors: m.errors };
  });
  // 入れ子は外側だけ残す
  items.sort((a, b) => a.key.length - b.key.length || (a.key < b.key ? -1 : 1));
  const kept = [];
  let nested = 0;
  for (const it of items) {
    if (kept.some((k) => isWithin(it.path, k.path))) { nested++; continue; }
    kept.push(it);
  }
  items = kept;
  let filtered = 0;
  items = items.filter((it) => { if (it.size !== null && it.size < minBytes) { filtered++; return false; } return true; });
  items.sort((a, b) => (b.size === null ? -1 : 0) - (a.size === null ? -1 : 0) || (b.size ?? 0) - (a.size ?? 0) || (a.key < b.key ? -1 : 1));
  items.forEach((it, i) => { it.id = i + 1; });
  return { items, excluded, notFound, filtered, nested };
}

export function planId(items, params) {
  const rows = items.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((i) => [i.key, i.safety, i.kind, i.size, i.count, i.links, i.hardlinks, i.errors]);
  const body = JSON.stringify({ v: 1, params: { minSize: Number(params.minSizeGB || 0) }, items: rows });
  return 'C-' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

export function scan(cfg, opts = {}) {
  const c = buildCandidates(cfg, opts);
  const free = io(cfg, 'free')(cfg.driveRoot);
  const params = { minSizeGB: Number(opts.minSizeGB || 0) };
  const plan = {
    version: 1, id: planId(c.items, params), createdAt: new Date(io(cfg, 'now')()).toISOString(), params,
    free, items: c.items, excluded: c.excluded, notFound: c.notFound, filtered: c.filtered, nested: c.nested,
  };
  return plan;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// 保存できなかったら例外（計画IDを出さない）
export function savePlan(plan, cfg) {
  const file = path.join(cfg.planDir, 'plan-' + plan.id + '.json');
  try { writeAtomic(file, JSON.stringify(plan, null, 1)); } catch (e) { throw new InputError('計画を保存できない（' + ((e && e.code) || 'ERR') + '）。削除へ進めない'); }
  return file;
}

// ---------------------------------------------------------------- 計画の読み込み
const ID_RE = /^C-[0-9a-f]{12}$/;
export function loadPlan(cfg, expect) {
  if (!ID_RE.test(String(expect))) throw new InputError('計画ID の形が正しくない（C- と 16 進 12 桁）');
  const file = path.join(cfg.planDir, 'plan-' + expect + '.json');
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new InputError('計画を読めない（' + ((e && e.code) || '形式が不正') + '）。scan からやり直す'); }
  if (!plan || typeof plan !== 'object' || plan.version !== 1 || !Array.isArray(plan.items) || !plan.params || typeof plan.createdAt !== 'string') throw new InputError('計画の形式が不正');
  const seenIds = new Set();
  for (const i of plan.items) {
    if (!i || typeof i !== 'object' || !Number.isInteger(i.id) || typeof i.path !== 'string' || !SAFETY_VALUES.includes(i.safety)
      || !(i.size === null || (typeof i.size === 'number' && i.size >= 0)) || !(i.count === null || (typeof i.count === 'number' && i.count >= 0))
      || typeof i.kind !== 'string' || typeof i.key !== 'string' || i.key !== key(i.path)
      || !Number.isInteger(i.links) || !Number.isInteger(i.hardlinks) || !Number.isInteger(i.errors)) throw new InputError('計画の項目の形式が不正');
    if (seenIds.has(i.id)) throw new InputError('計画の承認番号が重複している');
    seenIds.add(i.id);
  }
  if (planId(plan.items, plan.params) !== expect || plan.id !== expect) throw new InputError('計画の内容が計画ID と一致しない（書き換えられた可能性）');
  const t = Date.parse(plan.createdAt);
  if (!Number.isFinite(t)) throw new InputError('計画の作成日時が不正');
  const age = io(cfg, 'now')() - t;
  if (age > PLAN_MAX_AGE_MS) throw new InputError('計画が古い（24 時間を超えた）。scan からやり直す');
  if (age < -PLAN_FUTURE_SKEW_MS) throw new InputError('計画の作成日時が未来になっている');
  return plan;
}

export function parseScope(spec, plan) {
  const s = String(spec || '');
  if (s === 'high') return { name: 'high', pick: (i) => i.safety === S.HIGH };
  if (s === 'high-mid') return { name: 'high-mid', pick: (i) => i.safety === S.HIGH || i.safety === S.MID };
  const m = /^ids:(\d+(?:,\d+)*)$/.exec(s);
  if (!m) throw new InputError('--scope は high / high-mid / ids:1,2,3 のどれか');
  const ids = [...new Set(m[1].split(',').map(Number))];
  for (const id of ids) if (!plan.items.some((i) => i.id === id)) throw new InputError('承認番号 ' + id + ' は計画に無い');
  return { name: 'ids', pick: (i) => ids.includes(i.id), ids };
}

// ---------------------------------------------------------------- 削除
function drifted(item, m) {
  const sizeTol = Math.max(DRIFT.minBytes, item.size * DRIFT.ratio);
  const countTol = Math.max(DRIFT.countAbs, item.count * DRIFT.countRatio);
  const d = [];
  if (Math.abs(m.size - item.size) > sizeTol) d.push('容量 ' + item.size + ' → ' + m.size + ' バイト');
  if (Math.abs(m.count - item.count) > countTol) d.push('要素数 ' + item.count + ' → ' + m.count);
  return d;
}

// 削除の直前の確認。通れば { ok:true, m }。通らなければ状態と理由
export function recheck(item, cfg) {
  const why = classifyPath(item.path, cfg);
  if (why) return { ok: false, status: '拒否', reason: why };
  if (item.size === null || item.count === null) return { ok: false, status: '拒否', reason: '承認時に測定できなかったものは削除しない' };
  const lstat = io(cfg, 'lstat');
  let st;
  try { st = lstat(item.path); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, status: '不在', reason: 'すでに存在しない' };
    return { ok: false, status: '拒否', reason: '状態を読めない（' + ((e && e.code) || 'ERR') + '）' };
  }
  if (st.isSymbolicLink()) return { ok: false, status: '拒否', reason: 'リンクに置き換わっている' };
  let real;
  try { real = io(cfg, 'realpath')(item.path); } catch (e) { return { ok: false, status: '拒否', reason: 'パスを解決できない（' + ((e && e.code) || 'ERR') + '）' }; }
  if (key(real) !== item.key) return { ok: false, status: '拒否', reason: '解決後のパスが承認時と違う' };
  const why2 = classifyPath(real, cfg);
  if (why2) return { ok: false, status: '拒否', reason: why2 };
  const m = measure(item.path, cfg);
  if (m.errors || m.truncated) return { ok: false, status: '再承認', reason: '測り直せない（' + (m.truncated ? '要素数が多すぎる' : m.errorCodes.join(',')) + '）' };
  if (m.links || m.hardlinks) return { ok: false, status: '再承認', reason: 'リンク・ハードリンクを含むようになった' };
  const dr = drifted(item, m);
  if (dr.length) return { ok: false, status: '再承認', reason: '承認時から変わった（' + dr.join('、') + '）' };
  return { ok: true, m };
}

export function applyPlan(cfg, { expect, scope, dryRun = false }) {
  const plan = loadPlan(cfg, expect);
  const sc = parseScope(scope, plan);
  const selected = plan.items.filter(sc.pick);
  const before = io(cfg, 'free')(cfg.driveRoot);
  const results = [];
  const rm = io(cfg, 'rm');
  for (const item of selected) {
    const rc = recheck(item, cfg);
    if (!rc.ok) { results.push({ id: item.id, path: item.path, safety: item.safety, status: rc.status, reason: rc.reason, removedBytes: 0 }); continue; }
    if (dryRun) { results.push({ id: item.id, path: item.path, safety: item.safety, status: '確認済み（削除せず）', reason: '', removedBytes: 0, size: rc.m.size }); continue; }
    let err = null;
    try { rm(item.path); } catch (e) { err = e; }
    let remain = null;
    try { io(cfg, 'lstat')(item.path); remain = measure(item.path, cfg); } catch (e) { if (!(e && e.code === 'ENOENT')) remain = { size: rc.m.size, count: rc.m.count, unknown: true }; }
    if (remain === null) {
      results.push({ id: item.id, path: item.path, safety: item.safety, status: '成功', reason: '', removedBytes: rc.m.size, size: rc.m.size });
    } else {
      const removed = Math.max(0, rc.m.size - remain.size);
      const progressed = removed > 0 || (remain.count != null && remain.count < rc.m.count);
      results.push({
        id: item.id, path: item.path, safety: item.safety, status: progressed ? '部分成功' : '失敗',
        reason: (err && (err.code || err.message) ? String(err.code || err.message).slice(0, 80) : '削除後も残っている') + '（残り ' + remain.size + ' バイト・' + remain.count + ' 件）',
        removedBytes: removed, size: rc.m.size, remainBytes: remain.size,
      });
    }
  }
  const after = io(cfg, 'free')(cfg.driveRoot);
  const by = {};
  for (const r of results) by[r.status] = (by[r.status] || 0) + 1;
  const reported = results.reduce((a, r) => a + r.removedBytes, 0);
  const measuredFreed = after.free - before.free;
  const diffTol = Math.max(10 * MiB, reported * 0.1);
  const summary = {
    planId: plan.id, scope: sc.name, dryRun, selected: selected.length, by,
    reportedFreedBytes: reported, measuredFreedBytes: measuredFreed,
    freedDiffers: !dryRun && Math.abs(measuredFreed - reported) > diffTol,
    freeBefore: before.free, freeAfter: after.free,
  };
  const allOk = selected.length > 0 && results.every((r) => (dryRun ? r.status.startsWith('確認済み') : r.status === '成功'));
  return { summary, results, allOk, plan };
}

// ---------------------------------------------------------------- 表示
export const maskPath = (p, cfg) => (cfg.profile && isWithin(p, cfg.profile) ? '<USERPROFILE>' + String(p).slice(String(cfg.profile).replace(/[\\/]+$/, '').length) : String(p));
const gb = (b) => (b === null || b === undefined ? '測定不能' : (b / GiB).toFixed(2) + ' GB');

function fmtScan(plan, cfg, file) {
  const L = [];
  L.push('計画ID: ' + plan.id);
  L.push('計画ファイル: ' + maskPath(file, cfg));
  L.push('空き容量: ' + gb(plan.free.free) + ' / 総容量 ' + gb(plan.free.total));
  L.push('');
  L.push('番号 | 安全度 | 種別 | 容量 | 件数 | パス | 理由');
  for (const i of plan.items) L.push([i.id, i.safety, i.kind, gb(i.size), i.count === null ? '測定不能' : i.count, maskPath(i.path, cfg), i.reason].join(' | '));
  const tot = (s) => plan.items.filter((i) => i.safety === s).reduce((a, i) => a + (i.size || 0), 0);
  L.push('');
  for (const s of SAFETY_VALUES) L.push('削除安全度 ' + s + ': 合計 ' + gb(tot(s)) + '（' + plan.items.filter((i) => i.safety === s).length + ' 件）');
  L.push('測定不能: ' + plan.items.filter((i) => i.size === null).length + ' 件');
  L.push('対象から外したパス: ' + plan.excluded.length + ' 件');
  for (const e of plan.excluded) L.push('  - ' + maskPath(e.path, cfg) + ' — ' + e.reason);
  L.push('該当なしのパス: ' + plan.notFound.length + ' 件');
  for (const n of plan.notFound) L.push('  - ' + maskPath(n, cfg));
  L.push('下限で絞った件数: ' + plan.filtered + ' / 入れ子で外側にまとめた件数: ' + plan.nested);
  return L.join('\n');
}

function fmtApply(r, cfg) {
  const L = [];
  const s = r.summary;
  L.push('計画ID: ' + s.planId + ' / 範囲: ' + s.scope + (s.dryRun ? '（削除せず確認のみ）' : ''));
  L.push('選んだ件数: ' + s.selected + ' / 内訳: ' + (Object.entries(s.by).map(([k, v]) => k + ' ' + v).join('、') || 'なし'));
  L.push('番号 | 安全度 | 状態 | パス | 理由');
  for (const x of r.results) L.push([x.id, x.safety, x.status, maskPath(x.path, cfg), x.reason].join(' | '));
  L.push('申告した解放量: ' + gb(s.reportedFreedBytes) + ' / 空き容量の実測の増加: ' + gb(s.measuredFreedBytes) + (s.freedDiffers ? '（食い違っている。期待値で上書きしない）' : ''));
  L.push('空き容量: ' + gb(s.freeBefore) + ' → ' + gb(s.freeAfter));
  if (!s.dryRun && s.selected === 0) L.push('削除は 0 件（選んだものが無い）。成功ではない');
  else if (!r.allOk) L.push('選んだものを全部は処理できていない（部分成功・失敗・再承認・拒否・不在を成功として数えない）');
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { extras: [], json: false, dryRun: false };
  const takes = new Set(['--extra', '--min-size', '--expect', '--scope']);
  const flags = new Set(['--json', '--dry-run', '--selftest']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { if (i === 0) { o.cmd = a; continue; } throw new InputError('余分な引数: ' + a); }
    if (a !== '--extra' && seen.has(a)) throw new InputError('同じオプションが 2 回: ' + a);
    seen.add(a);
    if (takes.has(a)) {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new InputError(a + ' に値が無い');
      if (a === '--extra') o.extras.push(v);
      else if (a === '--min-size') { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new InputError('--min-size は 0 以上の数（GB）'); o.minSizeGB = n; }
      else if (a === '--expect') o.expect = v;
      else o.scope = v;
    } else if (flags.has(a)) {
      if (a === '--json') o.json = true; else if (a === '--dry-run') o.dryRun = true; else o.selftest = true;
    } else throw new InputError('知らないオプション: ' + a);
  }
  return o;
}

export async function main(argv, cfgIn) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (o.selftest) return (await selftest()) ? 0 : 1;
  try {
    const cfg = cfgIn || defaultConfig();
    if (o.cmd === 'scan') {
      if (o.expect || o.scope || o.dryRun) throw new InputError('scan に使えないオプション');
      const plan = scan(cfg, { extras: o.extras, minSizeGB: o.minSizeGB });
      const file = savePlan(plan, cfg);
      console.log(o.json ? JSON.stringify({ ...plan, planFile: maskPath(file, cfg), items: plan.items.map((i) => ({ ...i, path: maskPath(i.path, cfg) })), excluded: plan.excluded.map((e) => ({ ...e, path: maskPath(e.path, cfg) })), notFound: plan.notFound.map((n) => maskPath(n, cfg)) }, null, 1) : fmtScan(plan, cfg, file));
      return 0;
    }
    if (o.cmd === 'apply') {
      if (!o.expect || !o.scope) throw new InputError('apply には --expect <計画ID> と --scope が要る');
      if (o.extras.length || o.minSizeGB !== undefined) throw new InputError('apply に使えないオプション');
      const r = applyPlan(cfg, { expect: o.expect, scope: o.scope, dryRun: o.dryRun });
      if (!o.dryRun) {
        try { writeAtomic(path.join(cfg.planDir, 'result-' + r.summary.planId + '-' + new Date(io(cfg, 'now')()).toISOString().replace(/[:.]/g, '-') + '.json'), JSON.stringify({ summary: r.summary, results: r.results }, null, 1)); } catch { console.error('警告: 結果の記録を保存できなかった（削除は済んでいる）'); }
      }
      console.log(o.json ? JSON.stringify({ summary: r.summary, results: r.results.map((x) => ({ ...x, path: maskPath(x.path, cfg) })), allOk: r.allOk }, null, 1) : fmtApply(r, cfg));
      return r.allOk ? 0 : 2;
    }
    throw new InputError('使い方: scan | apply | --selftest');
  } catch (e) {
    if (e instanceof InputError) { console.error(e.message); return 1; }
    throw e;
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
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'utclean(テスト)-')));
  const mk = (rel, size = 0) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size, 97)); return f; };
  const dir = (rel) => { const f = path.join(base, rel); fs.mkdirSync(f, { recursive: true }); return f; };
  const exists = (p) => fs.existsSync(p);
  const NOW = Date.now();
  let freeVal = 100 * GiB;
  const mkcfg = (over = {}) => ({
    drive: path.parse(base).root.slice(0, 2).toUpperCase(), driveRoot: path.parse(base).root, profile: path.join(base, 'home'),
    tempRoots: [path.join(base, 'tmpA')],
    cacheRoots: [{ path: path.join(base, 'pkg', 'nuget'), safety: S.MID, kind: 'パッケージキャッシュ', reason: 'r' },
      { path: path.join(base, 'pkg', 'dotcache'), safety: S.CONFIRM, kind: 'パッケージキャッシュ', reason: 'r' }],
    projectRoot: path.join(base, 'proj'), projectSkip: ['skipme'], projectMarkers: ['.git', 'package.json'], projectMarkerExts: ['.sln'],
    artifacts: { bin: { safety: S.HIGH, kind: 'ビルド成果物', reason: 'r' }, obj: { safety: S.HIGH, kind: 'ビルド成果物', reason: 'r' },
      node_modules: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: 'r' }, dist: { safety: S.CONFIRM, kind: 'ビルド成果物', reason: 'r' } },
    zones: [{ p: path.join(base, 'zone'), except: [path.join(base, 'zone', 'OKTemp')] }],
    syncZones: [path.join(base, 'sync')],
    planDir: path.join(base, 'plans'), maxDepth: 8, maxEntries: 100000,
    hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }) },
    ...over,
  });
  const pathsOf = (items) => items.map((i) => i.path);
  const find = (plan, p) => plan.items.find((i) => i.key === key(p));

  // 基準の木。削除する試験が互いに影響しないよう、毎回作り直せるようにする
  const seed = () => {
    for (const d of ['tmpA', 'tmpA_moved', 'pkg', 'proj', 'zone', 'outside', 'plans']) fs.rmSync(path.join(base, d), { recursive: true, force: true });
    mk('tmpA/f1.tmp', 3000); mk('tmpA/d1/a.bin', 5000); mk('tmpA/d1/b.bin', 5000); mk('tmpA/d2/c.bin', 100);
    mk('pkg/nuget/p1/x.dll', 4000); mk('pkg/dotcache/model.bin', 4000);
    mk('proj/app/.git/HEAD', 10); mk('proj/app/src/bin/x.dll', 6000); mk('proj/app/src/bin/nested/obj/y.o', 50);
    mk('proj/app/obj/y.o', 2000); mk('proj/app/node_modules/m/z.js', 1500); mk('proj/app/dist/out.js', 700);
    mk('proj/skipme/.git/HEAD', 1); mk('proj/skipme/bin/q.dll', 9000); mk('proj/noproj/bin/q.dll', 9000);
    mk('proj/app/.git/bin/ignored.dll', 9000);
    mk('zone/Windows/data.bin', 10); mk('zone/OKTemp/t.tmp', 800); mk('zone/OKTemp/sub/u.tmp', 300);
  };
  try {
    seed();

    await t('[C01] 一時フォルダは中身を1件ずつ候補にし、フォルダそのものは候補にしない（高）', () => {
      const c = mkcfg();
      const r = buildCandidates(c);
      const tmp = r.items.filter((i) => i.kind === '一時');
      assert(tmp.length === 3, `件数 ${tmp.length}`);
      assert(tmp.every((i) => i.safety === S.HIGH), '安全度が高でない');
      assert(!pathsOf(r.items).some((p) => key(p) === key(path.join(base, 'tmpA'))), '一時フォルダ自体が候補');
      const d1 = find(r, path.join(base, 'tmpA', 'd1'));
      assert(d1 && d1.size === 10000 && d1.count === 2, `d1 ${d1 && d1.size}/${d1 && d1.count}`);
    });
    await t('[C02] 存在しない既定パスは「該当なし」に残す（黙って落とさない）', () => {
      const c = mkcfg({ tempRoots: [path.join(base, 'tmpA'), path.join(base, 'nope')] });
      const r = buildCandidates(c);
      assert(r.notFound.some((p) => key(p) === key(path.join(base, 'nope'))), '該当なしに無い');
    });
    await t('[C03] 同じ場所を指す2つの一時フォルダ（大小文字違い）は1回だけ列挙する', () => {
      const c = mkcfg({ tempRoots: [path.join(base, 'tmpA'), path.join(base, 'TMPA')] });
      const r = buildCandidates(c);
      assert(r.items.filter((i) => i.kind === '一時').length === 3, `件数 ${r.items.filter((i) => i.kind === '一時').length}`);
      assert(r.nested === 0, `同じ場所を 2 回列挙した（入れ子の整理で隠れた） ${r.nested}`);
    });
    await t('[C04] パッケージキャッシュは中、.cache 相当は確認が必要', () => {
      const r = buildCandidates(mkcfg());
      assert(find(r, path.join(base, 'pkg', 'nuget')).safety === S.MID, 'nuget が中でない');
      assert(find(r, path.join(base, 'pkg', 'dotcache')).safety === S.CONFIRM, 'cache が確認が必要でない');
    });
    await t('[C05] プロジェクト成果物: bin/obj は高、node_modules/dist は確認が必要。入れ子・.git 配下・マーカーの無いフォルダ・除外名は拾わない', () => {
      const r = buildCandidates(mkcfg());
      const P = (rel) => path.join(base, 'proj', ...rel.split('/'));
      assert(find(r, P('app/src/bin')).safety === S.HIGH, 'bin');
      assert(find(r, P('app/obj')).safety === S.HIGH, 'obj');
      assert(find(r, P('app/node_modules')).safety === S.CONFIRM, 'node_modules');
      assert(find(r, P('app/dist')).safety === S.CONFIRM, 'dist');
      assert(!find(r, P('app/src/bin/nested/obj')), '入れ子の obj を別候補にした');
      assert(!find(r, P('app/.git/bin')), '.git の下を拾った');
      assert(!r.excluded.some((e) => key(e.path).includes('.git')), '.git の下を走査した（除外で隠れた）');
      assert(!find(r, P('noproj/bin')), 'マーカーの無いフォルダを拾った');
      assert(!find(r, P('skipme/bin')), '除外名のフォルダを拾った');
    });
    await t('[C06] 除外対象の下は候補にならず、除外の一覧に理由つきで残る。例外（except）は通る', () => {
      const c = mkcfg();
      const r = buildCandidates(c, { extras: [path.join(base, 'zone', 'Windows'), path.join(base, 'zone', 'OKTemp')] });
      assert(r.excluded.some((e) => key(e.path) === key(path.join(base, 'zone', 'Windows')) && e.reason === '除外対象'), '除外に無い');
      assert(find(r, path.join(base, 'zone', 'OKTemp')), '例外が通らない');
    });
    await t('[C07] 境界の比較: zone\\Temp の判定が zone\\TempX に当たらない', () => {
      const c = mkcfg({ zones: [{ p: path.join(base, 'zone', 'Temp') }] });
      assert(classifyPath(path.join(base, 'zone', 'TempX'), c) === null, 'TempX が除外された');
      assert(classifyPath(path.join(base, 'zone', 'Temp'), c) === '除外対象', 'Temp が除外されない');
      assert(classifyPath(path.join(base, 'zone', 'Temp', 'a'), c) === '除外対象', '配下が除外されない');
      assert(isWithin(path.join(base, 'ZONE', 'temp'), path.join(base, 'zone', 'Temp')), '大小文字を揃えて比べていない');
      assert(isWithin(path.join(base, 'zone', 'Temp'), path.join(base, 'zone', 'Temp') + '\\'), '親の末尾の区切りを揃えていない');
      assert(isWithin(path.join(base, 'zone', 'Temp') + '\\', path.join(base, 'zone', 'Temp')), '子の末尾の区切りを揃えていない');
    });
    await t('[C08] 除外対象を含むものも候補にしない（親を消すと中の除外対象が消える）', () => {
      const c = mkcfg();
      assert(classifyPath(path.join(base, 'zone'), c) === '除外対象', 'zone 自体');
      const c2 = mkcfg({ zones: [{ p: path.join(base, 'tmpA', 'd1') }] });
      assert(classifyPath(path.join(base, 'tmpA'), c2) === '除外対象を含む', '祖先を除かない');
    });
    await t('[C09] UNC・別ドライブ・ドライブ直下・相対表記・.git・ドライブ文字なしは形だけで除く', () => {
      const c = mkcfg();
      assert(/UNC/.test(classifyPath('\\\\srv\\share\\x', c)), 'UNC');
      assert(/UNC/.test(classifyPath('//srv/share/x', c)), 'UNC(/)');
      const other = c.drive === 'Z:' ? 'Y:' : 'Z:';
      assert(/以外/.test(classifyPath(other + '\\a', c)), '別ドライブ');
      assert(classifyPath(c.driveRoot, c) === 'ドライブ直下', 'ドライブ直下');
      assert(classifyPath(c.drive, c) === 'ドライブ直下', 'ドライブ直下（区切りなし）');
      assert(classifyPath(c.drive + '\\a\\..\\b', c) === '相対表記を含む', '相対表記');
      assert(classifyPath(path.join(base, 'x', '.git', 'y'), c) === '.git', '.git');
      assert(/ドライブ文字/.test(classifyPath('relative\\p', c)), 'ドライブ文字なし');
    });
    await t('[C10] 同期フォルダ（とその祖先）は除く', () => {
      const c = mkcfg();
      assert(classifyPath(path.join(base, 'sync', 'a'), c) === '同期フォルダ（OneDrive 等）', '同期の配下');
      assert(classifyPath(base, c) === '同期フォルダを含む', '同期を含む祖先');
    });

    await t('[C11] ジャンクションの候補はたどらず除く（先の実体は消えない前提）', () => {
      const target = dir('outside/real'); fs.writeFileSync(path.join(target, 'keep.txt'), 'k');
      dir('proj/linked'); fs.mkdirSync(path.join(base, 'proj', 'linked', 'src'), { recursive: true });
      fs.writeFileSync(path.join(base, 'proj', 'linked', 'package.json'), '{}');
      fs.symlinkSync(target, path.join(base, 'proj', 'linked', 'src', 'bin'), 'junction');
      const r = buildCandidates(mkcfg());
      assert(!find(r, path.join(base, 'proj', 'linked', 'src', 'bin')), 'リンクを候補にした');
      assert(!r.items.some((i) => key(i.path) === key(target)), 'リンク先を候補にした');
      // 追加指定で直接渡されたリンクも、たどらずに除く
      const r2 = buildCandidates(mkcfg(), { extras: [path.join(base, 'proj', 'linked', 'src', 'bin')] });
      assert(r2.excluded.some((e) => /リンク/.test(e.reason)), '追加指定のリンクを除いていない');
      assert(!r2.items.some((i) => key(i.path) === key(target)), '追加指定のリンクの先を候補にした');
    });
    await t('[C12] リンクを含む候補は「確認が必要」にして一括の対象から外す', () => {
      const target = dir('outside/real2'); fs.writeFileSync(path.join(target, 'k.txt'), 'k');
      mk('tmpA/withlink/a.txt', 100);
      fs.symlinkSync(target, path.join(base, 'tmpA', 'withlink', 'jn'), 'junction');
      const r = buildCandidates(mkcfg());
      const it = find(r, path.join(base, 'tmpA', 'withlink'));
      assert(it && it.safety === S.CONFIRM && it.links === 1, `${it && it.safety}/${it && it.links}`);
      assert(!/高|中/.test(it.safety), '一括対象');
    });
    await t('[C13] ハードリンクを含む候補は「確認が必要」にする', () => {
      mk('tmpA/withhard/a.txt', 100);
      fs.linkSync(path.join(base, 'tmpA', 'withhard', 'a.txt'), path.join(base, 'tmpA', 'withhard', 'b.txt'));
      const r = buildCandidates(mkcfg());
      const it = find(r, path.join(base, 'tmpA', 'withhard'));
      assert(it && it.safety === S.CONFIRM && it.hardlinks > 0, `${it && it.safety}/${it && it.hardlinks}`);
    });
    await t('[C14] 測れない候補は 0 GB にせず「測定不能」の確認が必要にする', () => {
      mk('tmpA/unreadable/a.txt', 100);
      const target = key(path.join(base, 'tmpA', 'unreadable'));
      const real = DEFAULT_IO.readdir;
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }), readdir: (p, o) => { if (key(p) === target) { const e = new Error('denied'); e.code = 'EPERM'; throw e; } return real(p, o); } } });
      const r = buildCandidates(c);
      const it = find(r, path.join(base, 'tmpA', 'unreadable'));
      assert(it && it.size === null && it.count === null && it.safety === S.CONFIRM, `${it && it.size}/${it && it.safety}`);
      assert(/測定不能/.test(it.reason), '理由に測定不能が無い');
    });
    await t('[C15] 要素数が上限を超えたら測定不能（途中までの値を使わない）', () => {
      const m = measure(path.join(base, 'tmpA'), mkcfg({ maxEntries: 2 }));
      assert(m.truncated === true, 'truncated');
      const r = buildCandidates(mkcfg({ maxEntries: 2 }));
      assert(r.items.some((i) => i.size === null), '測定不能が無い');
    });
    await t('[C16] 入れ子の候補は外側だけ残す。下限で絞った件数を数える', () => {
      const c = mkcfg({ cacheRoots: [{ path: path.join(base, 'tmpA', 'd1'), safety: S.MID, kind: 'パッケージキャッシュ', reason: 'r' }] });
      const r = buildCandidates(c);
      assert(r.nested >= 1, `入れ子 ${r.nested}`);
      const r2 = buildCandidates(mkcfg(), { minSizeGB: 1 });
      assert(r2.items.every((i) => i.size === null) && r2.filtered > 0, `絞り込み ${r2.filtered}`);
    });
    await t('[C17] 並びは容量の大きい順（測定不能は先頭）で、承認番号は 1 からの連番', () => {
      const r = buildCandidates(mkcfg());
      r.items.forEach((i, n) => assert(i.id === n + 1, '番号'));
      const sized = r.items.filter((i) => i.size !== null).map((i) => i.size);
      assert(sized.every((v, n) => n === 0 || sized[n - 1] >= v), '容量順でない');
    });

    // ---- 計画ID・保存
    await t('[C18] 計画ID は同じ結果で同じ、容量や下限が変われば変わる', () => {
      const c = mkcfg();
      const a = scan(c); const b = scan(c);
      assert(a.id === b.id && /^C-[0-9a-f]{12}$/.test(a.id), `id ${a.id}/${b.id}`);
      assert(scan(c, { minSizeGB: 1e-10 }).id !== a.id, '下限だけが違う計画で ID が変わらない');
      const items = a.items.map((i) => ({ ...i }));
      items[0].size += 1;
      assert(planId(items, a.params) !== a.id, '容量で変わらない');
      const it2 = a.items.map((i) => ({ ...i })); it2[0].safety = it2[0].safety === S.HIGH ? S.MID : S.HIGH;
      assert(planId(it2, a.params) !== a.id, '安全度で変わらない');
    });
    await t('[C19] 計画を保存できなければ例外（計画ID を出して削除へ進ませない）', () => {
      const blocker = mk('blockfile', 1);
      const c = mkcfg({ planDir: path.join(blocker, 'sub') });
      throwsLike(() => savePlan(scan(c), c), /保存できない/, '保存失敗で例外が出ない');
    });
    await t('[C20] 計画の読み込み: 形・ID・改ざん・古さ・未来を検査する', () => {
      const c = mkcfg(); const p = scan(c); const f = savePlan(p, c);
      assert(loadPlan(c, p.id).id === p.id, '読めない');
      throwsLike(() => loadPlan(c, 'C-zzzz'), /形が正しくない/, 'ID の形');
      throwsLike(() => loadPlan(c, 'C-000000000000'), /読めない/, '無い計画');
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      raw.items[0].size += 5; fs.writeFileSync(f, JSON.stringify(raw));
      throwsLike(() => loadPlan(c, p.id), /一致しない/, '改ざん');
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(JSON.stringify(p)), items: 'x' }));
      throwsLike(() => loadPlan(c, p.id), /形式が不正/, '形式');
      savePlan(p, c);
      throwsLike(() => loadPlan(mkcfg({ hooks: { now: () => NOW + PLAN_MAX_AGE_MS + 1000, free: () => ({ free: 1, total: 2 }) } }), p.id), /古い/, '古い計画');
      throwsLike(() => loadPlan(mkcfg({ hooks: { now: () => NOW - PLAN_FUTURE_SKEW_MS - 1000, free: () => ({ free: 1, total: 2 }) } }), p.id), /未来/, '未来の計画');
      const dup = JSON.parse(JSON.stringify(p)); dup.items[1].id = dup.items[0].id;
      fs.writeFileSync(f, JSON.stringify(dup));
      throwsLike(() => loadPlan(c, p.id), /重複|一致しない/, '番号の重複');
      savePlan(p, c);
    });
    await t('[C21] --scope の解釈: high / high-mid / ids。知らない形・計画に無い番号は拒否', () => {
      const p = scan(mkcfg());
      throwsLike(() => parseScope('all', p), /--scope/, '知らない範囲');
      throwsLike(() => parseScope('ids:', p), /--scope/, 'ids 空');
      throwsLike(() => parseScope('ids:9999', p), /計画に無い/, '無い番号');
      assert(p.items.filter(parseScope('high', p).pick).every((i) => i.safety === S.HIGH), 'high');
      assert(p.items.filter(parseScope('high-mid', p).pick).every((i) => i.safety === S.HIGH || i.safety === S.MID), 'high-mid');
      assert(!p.items.filter(parseScope('high-mid', p).pick).some((i) => i.safety === S.CONFIRM), '確認が必要が一括に入った');
    });

    // ---- 削除
    const fresh = () => { seed(); const c = mkcfg(); const p = scan(c); savePlan(p, c); return { c, p }; };
    await t('[C22] --dry-run は何も消さない。確認済みの印だけ返す', () => {
      const { c, p } = fresh();
      const r = applyPlan(c, { expect: p.id, scope: 'high-mid', dryRun: true });
      assert(exists(path.join(base, 'tmpA', 'd1')) && exists(path.join(base, 'pkg', 'nuget')), '消えた');
      assert(r.results.every((x) => x.status.startsWith('確認済み')), '状態');
      assert(r.allOk === true, 'allOk');
    });
    await t('[C23] high は高だけを消し、中・確認が必要は残る。リンクの先は消えない', () => {
      seed();
      const outside = dir('outside/real'); fs.writeFileSync(path.join(outside, 'keep.txt'), 'k');
      mk('tmpA/withlink/a.txt', 100);
      fs.symlinkSync(outside, path.join(base, 'tmpA', 'withlink', 'jn'), 'junction');
      const c = mkcfg(); const p = scan(c); savePlan(p, c);
      const hi = p.items.filter((i) => i.safety === S.HIGH);
      assert(hi.length > 0, '高が無い');
      const r = applyPlan(c, { expect: p.id, scope: 'high' });
      for (const i of hi) assert(!exists(i.path), '高が残った: ' + i.path);
      assert(exists(path.join(base, 'pkg', 'nuget')), '中を消した');
      assert(exists(path.join(base, 'proj', 'app', 'node_modules')), '確認が必要を消した');
      assert(exists(path.join(base, 'outside', 'real', 'keep.txt')), 'リンク先が消えた');
      assert(r.results.every((x) => x.status === '成功' || x.status === '拒否' || x.status === '再承認'), '想定外の状態');
    });
    await t('[C24] ids の指定なら確認が必要も、指定した番号だけ消える', () => {
      const { c, p } = fresh();
      const dist = find(p, path.join(base, 'proj', 'app', 'dist'));
      const cache = find(p, path.join(base, 'pkg', 'dotcache'));
      assert(dist && cache, '候補が無い');
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + dist.id });
      assert(!exists(dist.path), '指定を消していない');
      assert(exists(cache.path), '指定外を消した');
      assert(r.results.length === 1 && r.results[0].status === '成功', '状態');
    });
    await t('[C25] 承認後に中身が増えたら再承認に戻し、消さない', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'pkg', 'nuget'));
      fs.writeFileSync(path.join(it.path, 'p1', 'big.bin'), Buffer.alloc(3 * MiB, 98));
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '再承認', `状態 ${r.results[0].status}`);
      assert(exists(it.path) && exists(path.join(it.path, 'p1', 'big.bin')), '消えた');
      assert(r.allOk === false, 'allOk');
    });
    await t('[C26] 承認後に件数が増えただけでも再承認に戻す', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'proj', 'app', 'obj'));
      for (let n = 0; n < 40; n++) fs.writeFileSync(path.join(it.path, 'e' + n), '');
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '再承認' && /要素数/.test(r.results[0].reason), `状態 ${r.results[0].status} ${r.results[0].reason}`);
      assert(exists(it.path), '消えた');
    });
    await t('[C27] 承認後にフォルダがリンクに置き換えられたら拒否し、リンク先を消さない', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'pkg', 'nuget'));
      const real = dir('outside/swap'); fs.writeFileSync(path.join(real, 'keep.txt'), 'k');
      fs.rmSync(it.path, { recursive: true, force: true });
      fs.symlinkSync(real, it.path, 'junction');
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '拒否' && /リンク/.test(r.results[0].reason), `状態 ${r.results[0].status} ${r.results[0].reason}`);
      assert(exists(path.join(real, 'keep.txt')), 'リンク先が消えた');
    });
    await t('[C28] 承認後に親フォルダがリンクに置き換えられたら、解決後のパスの食い違いで拒否する', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'tmpA', 'd1'));
      const real = dir('outside/parent'); mk('outside/parent/d1/a.bin', 5000); mk('outside/parent/d1/b.bin', 5000);
      const hold = path.join(base, 'tmpA_moved');
      fs.renameSync(path.join(base, 'tmpA'), hold);
      fs.symlinkSync(real, path.join(base, 'tmpA'), 'junction');
      try {
        const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
        assert(r.results[0].status === '拒否', `状態 ${r.results[0].status} ${r.results[0].reason}`);
        assert(exists(path.join(real, 'd1', 'a.bin')), '親リンクの先を消した');
      } finally { fs.rmSync(path.join(base, 'tmpA'), { recursive: true, force: true }); fs.renameSync(hold, path.join(base, 'tmpA')); }
    });
    await t('[C29] 計画が改ざんされて除外対象を指していても、削除の直前の検査で拒否する', () => {
      const c = mkcfg();
      const p = scan(c);
      const victim = path.join(base, 'zone', 'Windows');
      const forged = { ...p, items: [{ id: 1, path: victim, key: key(victim), kind: 'その他', safety: S.HIGH, reason: '', size: 10, count: 1, links: 0, hardlinks: 0, errors: 0 }] };
      forged.id = planId(forged.items, forged.params);
      savePlan(forged, c);
      const r = applyPlan(c, { expect: forged.id, scope: 'high' });
      assert(r.results[0].status === '拒否' && r.results[0].reason === '除外対象', `状態 ${r.results[0].status} ${r.results[0].reason}`);
      assert(exists(path.join(victim, 'data.bin')), '消えた');
      const root = { ...p, items: [{ id: 1, path: c.driveRoot, key: key(c.driveRoot), kind: 'その他', safety: S.HIGH, reason: '', size: 10, count: 1, links: 0, hardlinks: 0, errors: 0 }] };
      root.id = planId(root.items, root.params); savePlan(root, c);
      assert(applyPlan(c, { expect: root.id, scope: 'high' }).results[0].status === '拒否', 'ドライブ直下');
    });
    await t('[C30] 承認時に測定不能だったものは、ids で指定されても削除しない', () => {
      seed();
      mk('tmpA/unread2/a.txt', 100);
      const target = key(path.join(base, 'tmpA', 'unread2'));
      const real = DEFAULT_IO.readdir;
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }), readdir: (q, o) => { if (key(q) === target) { const e = new Error('d'); e.code = 'EPERM'; throw e; } return real(q, o); } } });
      const p = scan(c); savePlan(p, c);
      const it = find(p, path.join(base, 'tmpA', 'unread2'));
      assert(it.size === null, '測れてしまった');
      const r = applyPlan(mkcfg(), { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '拒否' && /測定できなかった/.test(r.results[0].reason), `状態 ${r.results[0].status}`);
      assert(exists(it.path), '消えた');
    });
    await t('[C31] すでに無いものは「不在」で、成功に数えない', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'pkg', 'nuget'));
      fs.rmSync(it.path, { recursive: true, force: true });
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '不在' && r.allOk === false, `状態 ${r.results[0].status}`);
    });
    await t('[C32] 途中で失敗したら「部分成功」で、残りを報告する。成功にしない', () => {
      seed(); const c0 = mkcfg(); const p = scan(c0); savePlan(p, c0);
      const it = find(p, path.join(base, 'tmpA', 'd1'));
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }), rm: (q) => { fs.rmSync(path.join(q, 'a.bin')); const e = new Error('busy'); e.code = 'EBUSY'; throw e; } } });
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '部分成功' && /EBUSY/.test(r.results[0].reason) && r.results[0].removedBytes === 5000, `状態 ${r.results[0].status} ${r.results[0].reason} ${r.results[0].removedBytes}`);
      assert(r.allOk === false, '部分成功を成功にした');
    });
    await t('[C33] 何も消せなかったら「失敗」で、成功にしない', () => {
      seed(); const c0 = mkcfg(); const p = scan(c0); savePlan(p, c0);
      const it = find(p, path.join(base, 'tmpA', 'd2'));
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }), rm: () => { const e = new Error('locked'); e.code = 'EPERM'; throw e; } } });
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '失敗' && r.allOk === false, `状態 ${r.results[0].status}`);
      assert(exists(it.path), '消えた');
    });
    await t('[C40] 承認後に中へリンクが入ったら再承認に戻し、消さず、リンク先も消さない', () => {
      const { c, p } = fresh();
      const it = find(p, path.join(base, 'pkg', 'nuget'));
      const real = dir('outside/inner'); fs.writeFileSync(path.join(real, 'keep.txt'), 'k');
      fs.symlinkSync(real, path.join(it.path, 'p1', 'jn'), 'junction');
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '再承認' && /リンク/.test(r.results[0].reason), `状態 ${r.results[0].status} ${r.results[0].reason}`);
      assert(exists(it.path) && exists(path.join(real, 'keep.txt')), '消えた');
    });
    await t('[C41] 承認後に測り直せなくなったら再承認に戻し、消さない', () => {
      const { p } = fresh();
      const it = find(p, path.join(base, 'tmpA', 'd1'));
      const real = DEFAULT_IO.readdir;
      const target = key(path.join(base, 'tmpA', 'd1'));
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: freeVal, total: 500 * GiB }), readdir: (q, o) => { if (key(q) === target) { const e = new Error('d'); e.code = 'EPERM'; throw e; } return real(q, o); } } });
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.results[0].status === '再承認' && /測り直せない/.test(r.results[0].reason), `状態 ${r.results[0].status} ${r.results[0].reason}`);
      assert(exists(it.path), '消えた');
    });
    await t('[C34] 選んだものが 0 件なら成功にしない（削除 0 件を成功と言わない）', () => {
      seed();
      const c = mkcfg({ projectRoot: path.join(base, 'nothing'), tempRoots: [], cacheRoots: [{ path: path.join(base, 'pkg', 'nuget'), safety: S.MID, kind: 'パッケージキャッシュ', reason: 'r' }] });
      const p = scan(c); savePlan(p, c);
      const r = applyPlan(c, { expect: p.id, scope: 'high' });
      assert(r.summary.selected === 0 && r.allOk === false, `選んだ ${r.summary.selected} allOk ${r.allOk}`);
    });
    await t('[C35] 申告した解放量と空き容量の実測が食い違ったら、食い違いをそのまま出す', () => {
      seed(); const c0 = mkcfg(); const p = scan(c0); savePlan(p, c0);
      const it = find(p, path.join(base, 'tmpA', 'd1'));
      let calls = 0;
      const c = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: calls++ === 0 ? 100 * GiB : 100 * GiB + 1, total: 500 * GiB }) } });
      const r = applyPlan(c, { expect: p.id, scope: 'ids:' + it.id });
      assert(r.summary.reportedFreedBytes === 10000 || r.summary.reportedFreedBytes > 0, '申告量');
      const c2 = mkcfg({ hooks: { now: () => NOW, free: () => ({ free: calls++ % 2 === 0 ? 100 * GiB : 130 * GiB, total: 500 * GiB }) } });
      const p2 = scan(c2); savePlan(p2, c2);
      const it2 = find(p2, path.join(base, 'tmpA', 'd2'));
      const r2 = applyPlan(c2, { expect: p2.id, scope: 'ids:' + it2.id });
      assert(r2.summary.freedDiffers === true, '食い違いを出していない');
      assert(r2.summary.measuredFreedBytes !== r2.summary.reportedFreedBytes, '実測を申告値で上書きした');
    });
    await t('[C36] 表示では <USERPROFILE> に戻す。計画ファイルには実パスを書く', () => {
      const c = mkcfg();
      assert(maskPath(path.join(c.profile, 'x', 'y'), c) === '<USERPROFILE>' + path.sep + 'x' + path.sep + 'y', 'マスク');
      assert(maskPath(path.join(base, 'other'), c) === path.join(base, 'other'), '範囲外を変えた');
      const p = scan(c); const f = savePlan(p, c);
      const stored = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert(stored.items.every((i) => path.isAbsolute(i.path)), '実パスでない');
    });
    await t('[C37] 引数の検査: 知らないオプション・重複・値なし・scan と apply の取り違えを止める', async () => {
      const errs = [];
      const orig = console.error; console.error = (m) => errs.push(m);
      try {
        const cases = [[['scan', '--bogus'], /知らないオプション/], [['scan', '--min-size'], /値が無い/], [['scan', '--min-size', 'x'], /0 以上の数/], [['scan', '--json', '--json'], /2 回/],
          [['scan', '--expect', 'C-000000000000'], /scan に使えない/], [['apply'], /--expect <計画ID> と --scope が要る/], [['apply', '--expect', 'C-000000000000'], /--expect <計画ID> と --scope が要る/],
          [['bogus'], /使い方/], [['scan', 'extra'], /余分な引数/]];
        for (const [a, re] of cases) {
          const n0 = errs.length;
          assert((await main(a, mkcfg())) === 1, `exit 1 でない: ${a.join(' ')}`);
          assert(errs.length === n0 + 1 && re.test(errs[n0]), `理由が違う: ${a.join(' ')} → ${errs[n0]}`);
        }
      } finally { console.error = orig; }
    });
    await t('[C38] 試験用の差し込みは本番の経路（既定の設定）から呼べない', () => {
      const d = defaultConfig({ SystemDrive: 'C:', USERPROFILE: path.join(base, 'home'), LOCALAPPDATA: path.join(base, 'home', 'AppData', 'Local') });
      assert(d.hooks === undefined, '既定の設定に hooks がある');
      const src = fs.readFileSync(SELF, 'utf8').split('async function selftest(')[0];
      assert(!/process\.env\.UT_CLEAN_(MUTATE|TEST|HOOK)/.test(src), '試験用の環境変数の読み取りが残っている');
    });
    await t('[C39] 既定の設定: 一時・キャッシュ・除外対象の配置（Windows と ProgramData の例外・Documents など）', () => {
      const env = { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\tester', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
      const d = defaultConfig(env);
      assert(d.tempRoots.some((x) => key(x) === key('C:\\Windows\\Temp')), 'Windows\\Temp');
      assert(d.cacheRoots.length === 5 && d.cacheRoots.find((x) => /\.cache$/.test(x.path)).safety === S.CONFIRM, 'cache');
      assert(classifyPath('C:\\Windows\\System32\\x', d) === '除外対象', 'System32');
      assert(classifyPath('C:\\Windows\\Temp\\x', d) === null, 'Windows\\Temp の例外');
      assert(classifyPath('C:\\Program Files\\App', d) === '除外対象', 'Program Files');
      assert(classifyPath('C:\\Users\\tester\\Documents\\a', d) === '除外対象', 'Documents');
      assert(classifyPath('C:\\Users\\tester', d) === '除外対象を含む', 'ユーザー直下（Documents を含む）');
      assert(classifyPath('C:\\ProgramData\\Package Cache', d) === null, 'Package Cache の例外');
      assert(classifyPath('C:\\ProgramData\\Other', d) === '除外対象', 'ProgramData の他');
      throwsLike(() => defaultConfig({}), /未設定/, '環境変数なし');
    });
  } finally {
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
