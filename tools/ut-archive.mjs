#!/usr/bin/env node
// ut-archive: 元を残したまま 1 ファイルずつ 7z を作り、元を消してよいかを確かめるための道具（/ut-diskarchive の本体）。
// 元のファイルは移動・削除しない。容量が減るのは、利用者が元を消したとき。
//
//   node tools/ut-archive.mjs roots [--json]                                          （圧縮の候補ルート。/ut-diskreport が使う）
//   node tools/ut-archive.mjs survey --source <dir> [--summary] [--json]
//   node tools/ut-archive.mjs plan   --source <dir> [--dest <dir>] [--purpose cloud|local-folder] [--older-than <日数>] [--json]
//   node tools/ut-archive.mjs apply  --source <dir> --expect <計画ID> [--dest <dir>] [--purpose …] [--older-than …] [--release-local --expect-release <解放ID>]
//   node tools/ut-archive.mjs status --source <dir> [--dest <dir>] [--json]          （記録を読むだけ）
//   node tools/ut-archive.mjs verify-current --source <dir> [--dest <dir>] [--rehash-archives] [--json]
//   node tools/ut-archive.mjs confirm-upload   --source <dir> --expect-upload <確認ID> [--dest <dir>]   （利用者のアップロードの確認を記録）
//   node tools/ut-archive.mjs release-archives --source <dir> --expect-upload <確認ID> [--dest <dir>]   （確認した書庫をクラウドのみへ）
//   node tools/ut-archive.mjs deletion-plan  --source <dir> [--dest <dir>] [--json]                  （削除の前の検査の範囲と見込み）
//   node tools/ut-archive.mjs deletion-check --source <dir> --expect <削除検査ID> [--dest <dir>] [--json]（参考の判定。元は消さない）
//   node tools/ut-archive.mjs --selftest
//
// 方針の正本: ~/.claude/work/diskarchive/policy-v7-20261009.md（リポジトリの外）。
// Windows 固有の読み取り（属性・ファイルID・割当サイズ・ADS・再解析タグ・OneDrive のプレースホルダーの状態・同期ルート）は
// tools/ut-archive-win.ps1 が行う（Node の fs.stat は属性を返さないため）。
// 管理情報（計画・詳細の一覧）の置き場所は UT_ARCHIVE_DIR（既定 <USERPROFILE>/.claude/work/archive）。実パスはそこにだけ書き、
// 画面には件数・サイズ・理由だけを出す（パスには顧客名などが含まれうる）。
//
// exit: 0 正常 / 1 入力の誤り・判定できない / 2 計画に止める理由がある
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, spawn as spawnChild } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WIN_HELPER = path.join(path.dirname(SELF), 'ut-archive-win.ps1');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export class InputError extends Error {}
export class BlockedError extends Error {}

// ---------------------------------------------------------------- 試験用の差し込み
// 本番の経路は環境変数を読まない。selftest がモジュールの中から差し替える（ut-env と同じ考え方）
//   winStub(req)      : 補助スクリプトの代わりに、出力の行（オブジェクトの配列）を返す
//   sevenZip          : 7z の実体の代わりに使う { path, version, sha }
//   now               : 現在時刻（ms）
//   freeBytes(p)      : ボリュームの空き
export const testHooks = { winStub: null, sevenZip: null, now: null, freeBytes: null };

// ---------------------------------------------------------------- パス
const home = () => process.env.USERPROFILE || process.env.HOME || os.homedir();
export const archiveDir = () => process.env.UT_ARCHIVE_DIR || path.join(home(), '.claude', 'work', 'archive');
const nowMs = () => (testHooks.now != null ? testHooks.now : Date.now());

// 比較用の正規化: 大文字小文字を区別せず（Windows の名前の比較）、Unicode は NFC、区切りは \
export const normKey = (p) => String(p).normalize('NFC').replace(/\//g, '\\').toLowerCase();
// パスの境界で、a が b と同じか、b の下にあるか
export function isWithin(a, b) {
  const x = normKey(a).replace(/\\+$/, '');
  const y = normKey(b).replace(/\\+$/, '');
  return x === y || x.startsWith(y + '\\');
}

function writeAtomic(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  // Windows では、置き換え先を別のプロセス（ウイルス対策・インデクサー等）が一瞬開いていると、改名が EPERM・EBUSY・EACCES で
  // 失敗することがある（試験で実際に起きた）。短く待って数回やり直し、それでも駄目なら失敗にする（成功扱いにしない）
  for (let n = 0; ; n++) {
    try { fs.renameSync(tmp, dest); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || n >= 9) { try { fs.unlinkSync(tmp); } catch { /* 残っても次の書き込みには影響しない */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (n + 1));
    }
  }
}

// ---------------------------------------------------------------- 実行ファイル
// 作業フォルダの同名の実行ファイルを拾わないよう、PATH のうち絶対パスの場所だけを探す（ut-env / ut-defer と同じ規則）
export function resolveOnPath(name, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(';');
  for (const raw of dirs) {
    const d = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !path.isAbsolute(d)) continue;
    const p = path.join(d, name + '.exe');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 無い */ }
  }
  return null;
}
const system32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
const POWERSHELL = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 7z の実体: %ProgramFiles%\7-Zip\7z.exe を優先し、無ければ絶対パスの PATH から。版とハッシュも返す（計画IDに含める）
export function resolve7z(env = process.env) {
  if (testHooks.sevenZip) return testHooks.sevenZip;
  const cands = [];
  for (const pf of [env.ProgramFiles, env.ProgramW6432]) if (pf && path.isAbsolute(pf)) cands.push(path.join(pf, '7-Zip', '7z.exe'));
  let exe = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || resolveOnPath('7z', env);
  if (!exe) return null;
  const r = spawnSync(exe, ['i'], { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true, timeout: 30000 });
  const m = String(r.stdout || '').match(/7-Zip(?: \(a\))? (\d+\.\d+)/);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  return { path: exe, version: m ? m[1] : null, sha };
}

// ---------------------------------------------------------------- 補助スクリプト
// 出力は JSON Lines。最初の行が header、最後の行が end（count が entry・error の行数と一致）でなければ、途中で切れた出力として扱う
function runHelper(req) {
  if (process.platform !== 'win32') throw new InputError('Windows 以外では動かない（OneDrive の状態の判定に Windows の API を使う）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-archive-'));
  try {
    const inF = path.join(dir, 'in.json');
    const outF = path.join(dir, 'out.jsonl');
    fs.writeFileSync(inF, JSON.stringify(req));
    const r = spawnSync(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_HELPER, '-In', inF, '-Out', outF],
      { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true, timeout: 3600000 });
    if (r.error) throw new Error(`補助スクリプトを起動できない（${r.error.code || 'spawn'}）`);
    if (r.status !== 0) throw new Error(`補助スクリプトが失敗した（exit ${r.status}）: ${String(r.stderr || '').split('\n').find((l) => l.trim()) || ''}`);
    return fs.readFileSync(outF, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export function winProbe(req) {
  // 試験の差し込みは、本物の補助スクリプト（runHelper）を2つ目の引数で受け取り、一部のモードだけを差し替えられる
  const lines = testHooks.winStub ? testHooks.winStub(req, runHelper) : runHelper(req);
  if (!lines.length || lines[0].type !== 'header') throw new Error('補助スクリプトの出力に header が無い');
  const end = lines[lines.length - 1];
  const body = lines.slice(1, -1);
  if (end.type !== 'end' || end.count !== body.length) throw new Error('補助スクリプトの出力が途中で切れている（end の行が無いか、件数が合わない）');
  return body;
}

// ---------------------------------------------------------------- OneDrive の状態
const A = { READONLY: 0x1, HIDDEN: 0x2, SYSTEM: 0x4, DIRECTORY: 0x10, REPARSE: 0x400, OFFLINE: 0x1000, ENCRYPTED: 0x4000, PINNED: 0x80000, UNPINNED: 0x100000, RECALL_ON_DATA_ACCESS: 0x400000 };
const PH = { PLACEHOLDER: 0x1, SYNC_ROOT: 0x2, IN_SYNC: 0x8, PARTIAL: 0x10, PARTIALLY_ON_DISK: 0x20 };
const PH_INVALID = 0xffffffff;

// クラウドのみ = PARTIAL かつ割当 0（実機: クラウドのみのファイルにも PARTIAL が立つ）。一部だけ取得 = PARTIAL かつ割当 > 0
export function localState(e) {
  if (e.ph === PH_INVALID || !(e.ph & PH.PLACEHOLDER)) return 'not-placeholder';
  if (!(e.ph & PH.PARTIAL)) return 'local';
  if (typeof e.alloc !== 'number') return 'unknown';
  return e.alloc === 0 ? 'cloud-only' : 'partial';
}
export const pinState = (attrs) => (attrs & A.PINNED ? 'pinned' : attrs & A.UNPINNED ? 'unpinned' : 'none');

// 同期ルート: OneDrive のアカウント（UserFolder）と、Cloud Files に登録された同期ルートの両方にあるものだけを認める
// （UserFolder だけのものは使われていない残骸でありうる。実機でアカウント 2 / 登録 1 だった）
export function syncRoots() {
  const rows = winProbe({ mode: 'syncroots' });
  // 「読めなかった」を「登録が無い」と取り違えない
  const err = rows.find((r) => r.type === 'error');
  if (err) throw new InputError(`OneDrive の登録を読めない（${err.where}）。同期ルートかどうかを判定できない`);
  // アカウント側・登録側をそれぞれ実体（realpath）にしてから突き合わせ、実体のパスを返す（片側だけがジャンクション・別の表記でも漏らさない。
  // roots・survey・plan が同じ実体のパスで比べる）。フォルダが無い（ENOENT）ものは、その下に何も無いので表記のまま残す。
  // それ以外で実体にできなければ判定できない
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch (e) {
      if (e.code === 'ENOENT') return p;
      throw new InputError(`OneDrive の同期ルートの実体を確かめられない（${e.code || 'error'}）。同期ルートかどうかを判定できない`);
    }
  };
  const accounts = rows.filter((r) => r.type === 'account').map((r) => real(r.folder));
  const registered = new Set(rows.filter((r) => r.type === 'registered').map((r) => normKey(real(r.folder))));
  return accounts.filter((a) => registered.has(normKey(a)));
}
export function syncRootHr(p) {
  const rows = winProbe({ mode: 'syncroot', path: p });
  return rows[0] && rows[0].type === 'syncroot' ? rows[0].hr : null;
}
const HR_NOT_UNDER_SYNC_ROOT = 0x80070186 - 0x100000000;
// 指定したパス（フォルダ）の属性・再解析タグ・プレースホルダーの状態。読めなければ error を持つ
export function statPaths(paths) {
  const rows = winProbe({ mode: 'stat', paths });
  if (rows.length !== paths.length || rows.some((r) => r.type !== 'stat')) throw new Error('補助スクリプトの stat の出力が要求と合わない');
  return rows;
}

// source が同期ルートの下か。API とレジストリの判定が食い違えば「判定できない」
export function syncRootOf(p, roots = syncRoots()) {
  const byReg = roots.find((r) => isWithin(p, r)) || null;
  const hr = syncRootHr(p);
  const byApi = hr === 0 ? true : hr === HR_NOT_UNDER_SYNC_ROOT ? false : null;
  if (byApi === null) throw new InputError(`同期ルートかどうかを判定できない（CfGetSyncRootInfoByPath の結果 0x${((hr >>> 0) || 0).toString(16)}）`);
  if (byApi !== !!byReg) throw new InputError('同期ルートかどうかの判定が食い違う（API と OneDrive の登録）。OneDrive の状態を確かめる');
  return byReg;
}

// ---------------------------------------------------------------- 対象の分類
const PACKED_EXT = new Set(['.zip', '.7z', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.rar', '.lzh', '.cab', '.jar']);
const NUMBERED_EXT = /\.\d{3}$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const OS_FILES = new Set(['desktop.ini', 'thumbs.db']);
const MAX_DEST_PATH = 400; // OneDrive のパスの長さの上限に合わせる

// 理由の名前（画面と計画で同じ語を使う）
export const REASON = {
  link: 'リンク・ジャンクション（たどらない）',
  ads: '代替データストリーム（ADS）がある',
  efs: 'EFS で暗号化されている',
  hardlink: 'ハードリンク',
  packed: '圧縮済み形式',
  numbered: '番号の拡張子（圧縮済みかもしれない）',
  osfile: 'OS が作り直すファイル',
  partial: '一部だけ取得されている',
  recent: '最終更新が新しい',
  longpath: '宛先のパスが長すぎる',
  badname: '名前（途中のフォルダを含む）の末尾がドット・空白、または予約名',
  onedrivename: 'OneDrive で使えない名前（~$ で始まる・_vti_ を含む・.lock）',
};
export const UNKNOWN = {
  scan: '走査できなかった',
  detail: '属性・ファイルIDを読めなかった',
  streams: 'ADS の有無を判定できなかった',
  placeholder: 'プレースホルダーでない（同期待ちの可能性）',
  state: 'クラウドのみか判定できない',
};

export const ticksToMs = (t) => Number((BigInt(t) - 116444736000000000n) / 10000n);
const badSegment = (s) => /[. ]$/.test(s) || RESERVED.test(s);
const oneDriveBadSegment = (s) => s.startsWith('~$') || /_vti_/i.test(s) || s.toLowerCase() === '.lock';

// 計画の時点の状態（§4.1 の「初期状態」）。apply の直前に、変わってよいもの（クラウドのみ／ローカル・割当）と、
// 変わってはいけないもの（プレースホルダーか・同期済みか・ピン・それ以外の属性）を分けて比べるために残す
// 変わってよい属性: クラウドのみ／ローカルで切り替わる RECALL_ON_DATA_ACCESS・OFFLINE・SPARSE と、
// 書き込みのたびに立つ ARCHIVE。ピン（PINNED・UNPINNED）は pin として別に持つ
const VOLATILE_ATTRS = A.RECALL_ON_DATA_ACCESS | A.OFFLINE | 0x200 /* SPARSE */ | 0x20 /* ARCHIVE */ | A.PINNED | A.UNPINNED;
export function stableState(e) {
  return {
    attrs: (e.attrs & ~VOLATILE_ATTRS) >>> 0,
    pin: pinState(e.attrs),
    placeholder: e.ph !== PH_INVALID && !!(e.ph & PH.PLACEHOLDER),
    inSync: e.ph !== PH_INVALID && !!(e.ph & PH.IN_SYNC),
    cloudTag: (e.tag & 0xffff0fff) === 0x9000001a, // 再解析タグの変種（0x9000x01A の x）は取得の有無で変わるため、Cloud Files かどうかだけを見る
  };
}

export function classify(entries, { inSyncRoot, destRoot, destInSyncRoot = false, olderThanDays, now }) {
  const out = [];
  for (const e of entries) {
    if (e.type === 'error') { out.push({ rel: e.rel, cls: 'unknown', reason: UNKNOWN.scan, code: e.error }); continue; }
    if (e.kind === 'dir') continue;
    const name = e.rel.split('\\').pop();
    const ext = path.extname(name).toLowerCase();
    const base = {
      rel: e.rel, size: e.size, mtimeMs: ticksToMs(e.mtime), fileId: e.fileId || null, vol: e.vol || null,
      alloc: typeof e.alloc === 'number' ? e.alloc : null, attrs: e.attrs, tag: e.tag, ph: e.ph,
    };
    const ex = (reason) => out.push({ ...base, cls: 'excluded', reason });
    const unk = (reason) => out.push({ ...base, cls: 'unknown', reason });
    if (e.kind === 'link') { ex(REASON.link); continue; }
    if (e.detailError !== undefined) { unk(UNKNOWN.detail); continue; }
    if (e.streamsError !== undefined) { unk(UNKNOWN.streams); continue; }
    if (e.streams > 0) { ex(REASON.ads); continue; }
    if (e.attrs & A.ENCRYPTED) { ex(REASON.efs); continue; }
    if (e.links > 1) { ex(REASON.hardlink); continue; }
    const st = inSyncRoot ? localState(e) : 'local';
    if (inSyncRoot && st === 'not-placeholder') {
      const os = (e.attrs & A.SYSTEM) && (e.attrs & A.HIDDEN) && OS_FILES.has(name.toLowerCase());
      if (os) ex(REASON.osfile); else unk(UNKNOWN.placeholder);
      continue;
    }
    if (st === 'unknown') { unk(UNKNOWN.state); continue; }
    if (st === 'partial') { ex(REASON.partial); continue; }
    if (PACKED_EXT.has(ext)) { ex(REASON.packed); continue; }
    if (NUMBERED_EXT.test(name)) { ex(REASON.numbered); continue; }
    // 名前はファイル名だけでなく、途中のフォルダも含めて全部の部分を見る（宛先に同じ並びのフォルダを作るため）
    const segs = (e.rel + '.7z').split('\\');
    if (e.rel.split('\\').some(badSegment)) { ex(REASON.badname); continue; }
    if (destInSyncRoot && segs.some(oneDriveBadSegment)) { ex(REASON.onedrivename); continue; }
    if (path.join(destRoot, e.rel + '.7z').length > MAX_DEST_PATH) { ex(REASON.longpath); continue; }
    if (olderThanDays > 0 && now - base.mtimeMs < olderThanDays * 86400000) { ex(REASON.recent); continue; }
    out.push({ ...base, cls: 'target', cloudOnly: st === 'cloud-only', pin: pinState(e.attrs), initial: stableState(e), dest: e.rel + '.7z' });
  }
  return out;
}

// ---------------------------------------------------------------- 宛先の衝突
// Windows の比較規則（大文字小文字を無視・各要素の末尾のドットと空白を落とす・NFC）で、宛先の集合と既存の出力を突き合わせる
const destKey = (rel) => normKey(rel).split('\\').map((s) => s.replace(/[. ]+$/, '')).join('\\');
// 一時フォルダ・隔離の領域の名前の先頭。保存先の中のこの名前は、ツールのもの（S3-2 で作る）と取り違えるので、対象・既存の物とぶつけない
export const RESERVED_PREFIX = '.ut-archive-';
// 宛先の全体の集合（作る書庫・作る必要のあるフォルダ・既存のファイルとフォルダ・ツールの予約名）で、
// ファイルどうし・ファイルとフォルダ・既存の物とのすべての組み合わせを突き合わせる
export function findCollisions(targets, destEntries) {
  const problems = [];
  const exFiles = new Set();
  const exDirs = new Set();
  for (const d of destEntries) {
    if (d.type !== 'entry') continue;
    if (d.kind === 'dir') exDirs.add(destKey(d.rel)); else exFiles.add(destKey(d.rel));
    if (d.rel.split('\\').some((s) => normKey(s).startsWith(RESERVED_PREFIX))) problems.push({ kind: `保存先にツールの予約名（${RESERVED_PREFIX}…）の物がある（前回の残りの可能性。確かめてから片付ける）`, a: d.rel, b: '' });
  }
  const outFiles = new Map(); // 作る書庫 → 元の相対パス
  const needDirs = new Map(); // 作る必要のあるフォルダ → それを要する元の相対パス
  for (const t of targets) {
    const k = destKey(t.dest);
    if (k.split('\\').some((s) => s.startsWith(RESERVED_PREFIX))) problems.push({ kind: `対象の名前がツールの予約名（${RESERVED_PREFIX}…）と重なる`, a: t.rel, b: t.dest });
    if (outFiles.has(k)) problems.push({ kind: '宛先が重なる（大文字小文字・末尾のドット・Unicode の正規化だけが違う）', a: outFiles.get(k), b: t.rel });
    else outFiles.set(k, t.rel);
    const segs = k.split('\\');
    for (let i = 1; i < segs.length; i++) {
      const dk = segs.slice(0, i).join('\\');
      if (!needDirs.has(dk)) needDirs.set(dk, t.rel);
    }
  }
  for (const [k, rel] of outFiles) {
    if (exFiles.has(k)) problems.push({ kind: '宛先に同じ名前のファイルが既にある', a: rel, b: k });
    if (exDirs.has(k)) problems.push({ kind: '宛先に同じ名前のフォルダが既にある', a: rel, b: k });
    if (needDirs.has(k)) problems.push({ kind: '作る書庫と、別の書庫のために作るフォルダの名前が同じ', a: rel, b: needDirs.get(k) });
  }
  for (const [k, rel] of needDirs) {
    if (exFiles.has(k)) problems.push({ kind: '作る必要のあるフォルダと同じ名前のファイルが既にある', a: rel, b: k });
  }
  return problems;
}

// ---------------------------------------------------------------- 空き容量
export function freeBytes(p) {
  if (testHooks.freeBytes) return testHooks.freeBytes(p);
  const s = fs.statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}
// 1 ファイルの処理に要る空き。書庫は圧縮できないデータでも元 × 1.001 ＋ 1 MiB に収まる見込み（LZMA2 の非圧縮チャンク。実測で確かめる）
export const archiveUpper = (size) => Math.ceil(size * 1.001) + MiB;
export function needFor(t, sameVolume, reserve) {
  const fetch = t.cloudOnly ? t.size : 0;
  if (sameVolume) return { source: fetch + archiveUpper(t.size) + reserve, dest: 0 };
  return { source: fetch + reserve, dest: archiveUpper(t.size) + reserve };
}

// ---------------------------------------------------------------- 計画ID
// 同じ計画なら同じID。正規化した相対パスの順・固定のキー順・整数バイト・UTC ミリ秒。クラウドのみかどうかは含めない
// （同期で変わり、無意味な拒否になる。apply の直前の再確認で見る）
export const COMPRESS = { format: '7z', method: 'lzma2', level: 5, filters: 'off', threads: 'on', switches: ['-t7z', '-m0=lzma2', '-mx=5', '-mmt=on', '-mf=off', '-spd', '-sse'] };
export function planId(p) {
  const canon = {
    v: 2,
    source: normKey(p.source), dest: normKey(p.dest),
    sourceVol: p.sourceVol, destVol: p.destVol, syncRoot: p.syncRoot ? normKey(p.syncRoot) : null, destSyncRoot: p.destSyncRoot ? normKey(p.destSyncRoot) : null,
    purpose: p.purpose, olderThanDays: p.olderThanDays,
    sevenZip: p.sevenZip ? { path: normKey(p.sevenZip.path), version: p.sevenZip.version, sha: p.sevenZip.sha } : null,
    compress: COMPRESS,
    // 対象ごとの不変であるべき状態（stableState）も含める。クラウドのみかどうか・割当は含めない（変わってよいもの）
    items: [...p.items].sort((a, b) => (normKey(a.rel) < normKey(b.rel) ? -1 : normKey(a.rel) > normKey(b.rel) ? 1 : 0))
      .map((i) => [normKey(i.rel), i.cls, i.reason || '', i.size ?? null, i.mtimeMs ?? null, i.fileId ?? null,
        i.initial ? [i.initial.attrs, i.initial.pin, i.initial.placeholder, i.initial.inSync, i.initial.cloudTag] : null]),
    destExisting: [...p.destExisting].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    manifest: p.manifestDigest || null,
  };
  return 'P-' + crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// plan --json の中身。計画を作らないとき（OneDrive の下で local-folder）は {noPlan:true} だけ（圧縮しないので入口との照合の対象外。census も出さない）
export function planJson(p) {
  if (p.noPlan) return { noPlan: true };
  return { id: p.id, valid: p.valid, blockers: p.blockers, warnings: p.warnings, planFile: p.planFile, releaseLocal: { count: p.releaseLocal.count, pending: p.releaseLocal.pending, bytes: p.releaseLocal.bytes, id: p.releaseLocal.id }, census: planCensus(p.items) };
}
// 計画の集計（名前を含まない）。入口（/ut-diskreport の survey --json）と出口（plan --json）の件数・論理サイズを照合するため:
// survey の files ＋ links ＋ errors ＝ total、survey の logical ＝ logicalExcludingLinks（リンクと走査エラーには論理サイズを数えない）
export function planCensus(items) {
  const byClass = { target: { n: 0, bytes: 0 }, done: { n: 0, bytes: 0 }, excluded: { n: 0, bytes: 0 }, unknown: { n: 0, bytes: 0 } };
  const links = { n: 0, bytes: 0 };
  let scanErrors = 0; let logicalExcludingLinks = 0;
  for (const i of items) {
    const c = byClass[i.cls];
    if (c) { c.n++; c.bytes += i.size || 0; }
    if (i.reason === REASON.link) { links.n++; links.bytes += i.size || 0; continue; }
    if (i.reason === UNKNOWN.scan) { scanErrors++; continue; }
    logicalExcludingLinks += i.size || 0;
  }
  return { total: items.length, byClass, links, scanErrors, logicalExcludingLinks };
}

// 解放ID（--release-local の承認の印）。正規化した source・dest と、最初からローカルにある対象の（キー・ファイルID・サイズ・更新日時）。
// 接頭辞は R-（計画ID の P-・確認ID の U-・削除検査ID の D- と取り違えない）
export function releaseId(src, dest, targets) {
  const items = [...targets].map((t) => [normKey(t.rel), t.fileId, t.size, t.mtimeMs]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return 'R-' + crypto.createHash('sha256').update(JSON.stringify({ v: 1, source: normKey(src), dest: normKey(dest), items })).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- source / dest の検査
function realDir(p, label) {
  if (!p || !path.isAbsolute(p)) throw new InputError(`${label} は絶対パスで指定する`);
  if (/^\\\\/.test(p)) throw new InputError(`${label} にネットワークのパス（UNC）は使えない`);
  let r;
  try { r = fs.realpathSync.native(p); } catch { throw new InputError(`${label} が見つからない`); }
  if (!fs.statSync(r).isDirectory()) throw new InputError(`${label} がフォルダではない`);
  if (path.parse(r).root.toLowerCase() === r.toLowerCase() || /^[A-Za-z]:\\?$/.test(r)) throw new InputError(`${label} にドライブの直下は指定できない（範囲が広すぎる）`);
  return r;
}
// ドライブの直下とボリュームが違えば、マウントポイントの下にある
function assertNotMountPoint(p, label) {
  const root = path.parse(p).root;
  if (fs.statSync(p).dev !== fs.statSync(root).dev) throw new InputError(`${label} がマウントポイントの下にある（扱わない）`);
}
function resolveDest(source, dest) {
  const want = dest || source.replace(/[\\/]+$/, '') + '_7z';
  if (!path.isAbsolute(want)) throw new InputError('--dest は絶対パスで指定する');
  if (/^\\\\/.test(want)) throw new InputError('--dest にネットワークのパス（UNC）は使えない');
  if (path.parse(want).root.toLowerCase() === path.resolve(want).toLowerCase()) throw new InputError('--dest にドライブの直下は指定できない（範囲が広すぎる）');
  let parent = path.dirname(want);
  try { parent = fs.realpathSync.native(parent); } catch { throw new InputError('--dest の親フォルダが見つからない'); }
  // 親がファイルでも、Windows ではその下の lstat が ENOENT を返す（実測）。「保存先がまだ無い」と取り違えないよう、親がフォルダかを確かめる
  if (!fs.statSync(parent).isDirectory()) throw new InputError('--dest の親がフォルダではない');
  const real = path.join(parent, path.basename(want));
  let exists = false;
  // 「存在しない」は ENOENT だけ。権限・途中がファイル（ENOTDIR）などのエラーを「無い」と取り違えない
  try { const st = fs.lstatSync(real); if (st.isSymbolicLink()) throw new InputError('--dest がリンク'); if (!st.isDirectory()) throw new InputError('--dest がフォルダではない'); exists = true; } catch (e) { if (e instanceof InputError || e.code !== 'ENOENT') throw e; }
  return { path: exists ? fs.realpathSync.native(real) : real, exists, parent };
}

// ---------------------------------------------------------------- roots（読み取りだけ）
// /ut-diskreport（入口）が圧縮の候補ルートを決めるための一覧（方針 §1.1）: 確定した OneDrive の同期ルート（アカウントと
// Cloud Files の登録の両方にあるもの）と、既知フォルダ（Documents・Desktop・Downloads）のうち同期ルートの外にあるもの。
// 中身は読まない。読めなかったものは errors に出す（「無い」と取り違えない）
export function roots() {
  const errors = [];
  // 同期ルートを読めなければ errors に出して続ける（例外で止めると、既知フォルダの結果も読めなかったことも入口に届かない）
  let syncs = [];
  let syncsKnown = true;
  // 同期ルートは syncRoots が実体（realpath）にして返す（survey・plan と同じ比べ方）。実体にできなければ読めないものとする
  try { syncs = syncRoots(); } catch (e) { syncs = []; syncsKnown = false; errors.push(`syncroots: ${e.message}`); }
  const rows = winProbe({ mode: 'knownfolders' });
  for (const r of rows) if (r.type === 'error') errors.push(`${r.where}: ${r.message || ''}`);
  const known = rows.filter((r) => r.type === 'known').map((r) => {
    // 「無い」は ENOENT のときだけ。権限などで読めないもの・フォルダでないものは errors に出す（未測定を「無い」にしない）
    let state = 'dir'; let real = r.path;
    try {
      if (!fs.statSync(r.path).isDirectory()) { state = 'notDir'; errors.push(`knownfolder:${r.name}: フォルダではない`); }
      else real = fs.realpathSync.native(r.path); // ジャンクション・リダイレクトは実体で同期ルートと比べる（同じ所を二重に数えない）
    } catch (e) {
      if (e.code === 'ENOENT') state = 'missing';
      else { state = 'unreadable'; errors.push(`knownfolder:${r.name}: 読めない（${e.code || 'error'}）`); }
    }
    return { name: r.name, path: r.path, realPath: real, exists: state === 'dir', state, inSyncRoot: state === 'dir' && syncs.some((s) => isWithin(real, s)) };
  });
  // 同期ルートを読めなかったときは、同期ルートの中か外かを判定できないので、既知フォルダも候補にしない（未測定）
  const candidates = [...syncs.map((p) => ({ kind: 'syncRoot', path: p })), ...(syncsKnown ? known.filter((k) => k.exists && !k.inSyncRoot).map((k) => ({ kind: 'known', name: k.name, path: k.realPath })) : [])];
  return { syncRoots: syncs, syncRootsKnown: syncsKnown, known, candidates, errors };
}

// ---------------------------------------------------------------- survey
export function survey({ source }) {
  const src = realDir(source, '--source');
  assertNotMountPoint(src, '--source');
  const syncRoot = syncRootOf(src);
  const entries = winProbe({ mode: 'scan', root: src });
  const s = { files: 0, dirs: 0, errors: 0, links: 0, logical: 0, alloc: 0, cloudOnly: { n: 0, bytes: 0 }, partial: 0, pin: { pinned: 0, unpinned: 0, none: 0 }, ads: 0, efs: 0, hardlinks: 0, ext: new Map(), top: new Map(), largest: [],
    // 読めなかった件数を軸ごとに数える（読めなかったものを 0 として足し込み、少なく見せない）
    unknown: { detail: 0, streams: 0, alloc: 0, state: 0 } };
  for (const e of entries) {
    if (e.type === 'error') { s.errors++; continue; }
    if (e.kind === 'dir') { s.dirs++; continue; }
    if (e.kind === 'link') { s.links++; continue; }
    s.files++;
    s.logical += e.size;
    if (e.detailError !== undefined) s.unknown.detail++;
    if (e.streamsError !== undefined) s.unknown.streams++;
    if (typeof e.alloc === 'number') s.alloc += e.alloc; else s.unknown.alloc++;
    if (syncRoot && localState(e) === 'unknown') s.unknown.state++;
    if (syncRoot) {
      const st = localState(e);
      if (st === 'cloud-only') { s.cloudOnly.n++; s.cloudOnly.bytes += e.size; }
      if (st === 'partial') s.partial++;
      s.pin[pinState(e.attrs)]++;
    }
    if (e.streams > 0) s.ads++;
    if (e.attrs & A.ENCRYPTED) s.efs++;
    if (e.links > 1) s.hardlinks++;
    const ext = path.extname(e.rel).toLowerCase() || '(なし)';
    s.ext.set(ext, (s.ext.get(ext) || 0) + e.size);
    const top = e.rel.includes('\\') ? e.rel.split('\\')[0] : '(直下)';
    s.top.set(top, (s.top.get(top) || 0) + e.size);
    s.largest.push({ rel: e.rel, size: e.size });
  }
  s.largest = s.largest.sort((a, b) => b.size - a.size).slice(0, 8);
  const sz = resolve7z();
  return { source: src, syncRoot, free: freeBytes(src), sevenZip: sz, stats: s };
}

// ---------------------------------------------------------------- plan
export function plan({ source, dest, purpose, olderThanDays = 30 }) {
  const src = realDir(source, '--source');
  assertNotMountPoint(src, '--source');
  const roots = syncRoots();
  const syncRoot = syncRootOf(src, roots);
  if (syncRoot && !purpose) throw new InputError('対象は OneDrive の同期ルートの下。目的を --purpose cloud（クラウドの容量を減らす）か --purpose local-folder（この PC の空き）で指定する');
  const pur = purpose || 'local-folder';
  if (!['cloud', 'local-folder'].includes(pur)) throw new InputError('--purpose は cloud か local-folder');
  if (pur === 'cloud' && !syncRoot) throw new InputError('--purpose cloud は OneDrive の同期ルートの下だけ（この対象は同期ルートの外）');
  if (pur === 'local-folder' && syncRoot) {
    // ローカルの空きだけが目的なら、OneDrive の「空き容量を増やす」で足りる。圧縮の計画は作らない
    return { noPlan: true, reason: 'local-in-sync-root', source: src };
  }
  const d = resolveDest(src, dest);
  if (isWithin(d.path, src)) throw new InputError('--dest が --source の中にある（自分の出力を圧縮し続ける）');
  if (isWithin(src, d.path)) throw new InputError('--source が --dest の中にある');
  if (syncRoot && !isWithin(d.path, syncRoot)) throw new InputError('--purpose cloud では --dest も同じ同期ルートの下に置く（外に置くとクラウドの容量が減らない）');
  // 保存先も別に判定する（元が OneDrive の外でも、保存先が OneDrive の下ということがある）
  const destProbe = d.exists ? d.path : d.parent;
  const destSyncRoot = syncRootOf(destProbe, roots);
  // 保存先が OneDrive の下なら、同期ルートから保存先までの各部分の名前も OneDrive の制限に当てる（新しく作るフォルダを含む）
  if (destSyncRoot) {
    const rel = path.relative(destSyncRoot, d.path);
    if (rel && rel.split(/[\\/]/).some((s) => badSegment(s) || oneDriveBadSegment(s))) throw new InputError('--dest のフォルダの名前が OneDrive で使えない（~$ で始まる・_vti_ を含む・.lock・末尾のドットと空白・予約名）');
  }
  const sourceVol = String(fs.statSync(src).dev);
  const destVol = String(fs.statSync(destProbe).dev);
  // 保存先が OneDrive の下なら、保存先（または作る予定の場所の既存の親）から同期ルートまでのピン留めを調べる。
  // 親がピン留め（常に保持）だと、作った 7z も継承してピン留めになり、解放できない
  const warnings = [];
  if (destSyncRoot) {
    const chain = [];
    for (let p = destProbe; isWithin(p, destSyncRoot); p = path.dirname(p)) { chain.push(p); if (normKey(p) === normKey(destSyncRoot)) break; }
    for (const st of statPaths(chain)) {
      if (st.error !== undefined) throw new InputError('保存先の親フォルダの状態を読めない（ピン留めを判定できない）');
      if (st.attrs & A.PINNED) { warnings.push('保存先の親フォルダが「常にこのデバイスに保持する」になっている。作った 7z も保持され、解放できない（apply では「利用者の確認待ち」になる）'); break; }
    }
  }

  const entries = winProbe({ mode: 'scan', root: src });
  const destEntries = d.exists ? winProbe({ mode: 'scan', root: d.path }) : [];
  const items = classify(entries, { inSyncRoot: !!syncRoot, destRoot: d.path, destInSyncRoot: !!destSyncRoot, olderThanDays, now: nowMs() });
  // 前回までの処理の記録（manifest）と突き合わせる。確定済みで、書庫のファイルIDとサイズが記録と一致し、元も変わっていないものは「済み」。
  // 確定の途中（作った書庫のリンクが宛先にある）のものは、衝突ではなく続きから再開する
  const manifest = loadManifest(src, d.path);
  const destByKey = new Map(destEntries.filter((e) => e.type === 'entry').map((e) => [destKey(e.rel), e]));
  const ours = new Set();
  for (const it of items) {
    if (it.cls !== 'target') continue;
    const m = manifest.items[normKey(it.rel)];
    if (!m) continue;
    const sameSource = m.fileId === it.fileId && m.size === it.size && m.mtimeMs === it.mtimeMs;
    const ex = destByKey.get(destKey(it.dest));
    const arc = m.archive || m.tmpArchive || null;
    // 書庫のファイルIDとサイズの両方が記録と同じときだけ、自分の書庫とみなす（同じIDのまま切り詰められたものを「済み」にしない）
    if (ex && sameSource && arc && ex.fileId === arc.fileId && ex.size === arc.size) {
      ours.add(destKey(it.dest));
      if (m.state === 'restored') it.cls = 'done';
      else it.resume = m.state;
    }
  }
  const targets = items.filter((i) => i.cls === 'target');
  const unknown = items.filter((i) => i.cls === 'unknown');
  const doneCount = items.filter((i) => i.cls === 'done').length;
  const collisions = findCollisions(targets, destEntries.filter((e) => !(e.type === 'entry' && ours.has(destKey(e.rel)))));
  // 記録に途中の状態が残っているのに、今回の対象に入らないもの（元が変わった・除外になった）
  const live = new Set(targets.map((t) => normKey(t.rel)));
  const stale = Object.entries(manifest.items).filter(([k, m]) => !live.has(k) && !['restored', 'abandoned', 'failed'].includes(m.state));
  // 今の対象に入らない失敗・中止の記録。apply が履歴へ移す（消さない）
  const settle = Object.entries(manifest.items).filter(([k, m]) => !live.has(k) && ['failed', 'abandoned'].includes(m.state)).map(([k]) => k);
  if (settle.length) warnings.push(`今の対象に入らない失敗・中止の記録が ${settle.length} 件ある（apply が履歴へ移す。消さない）`);
  if (stale.length) warnings.push(`前回の途中の記録が ${stale.length} 件あり、今回の対象に入らない（apply が一時フォルダを隔離して「中止」として記録する）`);
  const destErrors = destEntries.filter((e) => e.type === 'error').length;

  const free = freeBytes(src);
  const reserve = Math.max(2 * GiB, Math.floor(free * 0.05));
  const sameVolume = sourceVol === destVol;
  let worst = { source: 0, dest: 0 };
  for (const t of targets) { const n = needFor(t, sameVolume, reserve); worst = { source: Math.max(worst.source, n.source), dest: Math.max(worst.dest, n.dest) }; }
  const destFree = sameVolume ? free : freeBytes(d.exists ? d.path : d.parent);

  const sevenZip = resolve7z();
  const blockers = [];
  if (!sevenZip) blockers.push('7-Zip（7z.exe）が見つからない');
  else if (!sevenZip.version) blockers.push('7-Zip の版を読み取れない');
  if (unknown.length) blockers.push(`判定できないファイルが ${unknown.length} 件ある（不明のまま進めない）`);
  if (collisions.length) blockers.push(`宛先の衝突が ${collisions.length} 件ある`);
  if (destErrors) blockers.push(`保存先を走査できなかった箇所が ${destErrors} 件ある`);
  // 対象が 0 件でも、整理する記録（途中の状態・失敗・中止）があれば、整理だけの実行を許す
  const settleable = settle.length + stale.filter(([, m]) => !['committed', 'restoring'].includes(m.state)).length;
  // 前の apply で --release-local を指定されたのに、最初からローカルの元を解放し切れていない「済み」の対象（待ち・同期待ち・中断からやり直す）
  const pendingRelease = syncRoot ? items.filter((i) => {
    const m = i.cls === 'done' ? manifest.items[normKey(i.rel)] : null;
    return !!m && !!m.releaseLocalRequested && !(m.sourceRelease && m.sourceRelease.state === 'released');
  }) : [];
  if (!targets.length && !settleable && !pendingRelease.length) blockers.push(doneCount ? `残りの対象が 0 件（${doneCount} 件はすべて処理済み）` : '圧縮する対象が 0 件（処理不要。0 件を成功として扱わない）');

  const destExisting = destEntries.filter((e) => e.type === 'entry').map((e) => [normKey(e.rel), e.kind, e.size, ticksToMs(e.mtime)]);
  // 最初からローカルにある対象（元が OneDrive の下のときだけ）。apply --release-local で、処理の後にクラウドのみにできる（§5.2-9）。
  // 計画ID とは別の解放ID（R-）を、その対象（ファイルID・サイズ・更新日時）から作る。ローカル／クラウドのみが変われば ID も変わる
  // （前の apply で --release-local を指定されたのに解放し切れていない「済み」の対象も含める。pendingRelease は上で計算した）
  const localTargets = syncRoot ? [...targets.filter((t) => !t.cloudOnly), ...pendingRelease] : [];
  const releaseLocal = { count: localTargets.length, pending: pendingRelease.length, bytes: localTargets.reduce((a, t) => a + t.size, 0), id: localTargets.length ? releaseId(src, d.path, localTargets) : null, keys: localTargets.map((t) => normKey(t.rel)), pendingKeys: pendingRelease.map((t) => normKey(t.rel)) };
  const p = {
    version: 2, createdAt: new Date(nowMs()).toISOString(),
    source: src, dest: d.path, destExists: d.exists, sourceVol, destVol, syncRoot, destSyncRoot, purpose: pur, olderThanDays,
    sevenZip, reserve, free, destFree, sameVolume, worst, items, collisions, blockers, warnings, destExisting,
    manifestDigest: manifestDigest(manifest), stale: stale.map(([k]) => k), settle, destErrors, releaseLocal,
  };
  // 止める理由が1件でもあれば、計画ID を作らない（計画ファイルにも残さない。承認の印になりうるため）
  p.valid = blockers.length === 0;
  p.id = p.valid ? planId(p) : null;
  return p;
}

// ---------------------------------------------------------------- 処理の記録（manifest）
// 元と保存先の組ごとに1つ。世代つきで、書くときは前の世代を .prev に残してから置き換える（壊れたら前の世代から戻す）
// 対象ごとの状態: planned → writing → archived → verified → committed → restored（ほかに failed・abandoned）
export const manifestPath = (src, dest) => path.join(archiveDir(), 'manifests', crypto.createHash('sha256').update(normKey(src) + '|' + normKey(dest)).digest('hex').slice(0, 16) + '.json');
function readJson(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { missing: true }; throw e; }
  try { return { value: JSON.parse(text) }; } catch { return { broken: true }; }
}
const okManifest = (m, src, dest) => m && m.version === 1 && normKey(m.source) === normKey(src) && normKey(m.dest) === normKey(dest) && m.items && typeof m.items === 'object' && Number.isInteger(m.generation);
export function loadManifest(src, dest) {
  const f = manifestPath(src, dest);
  const cur = readJson(f);
  if (cur.missing) {
    // 今の世代が無いのに前の世代だけがある = 置き換えの途中で止まった
    const prev = readJson(f + '.prev');
    if (prev.missing) return { version: 1, source: src, dest, generation: 0, items: {}, runs: [], history: [] };
    if (prev.value && okManifest(prev.value, src, dest)) return { ...prev.value, recoveredFrom: 'prev' };
    throw new InputError('処理の記録が無く、前の世代も読めない。保存先の状態を確かめる（記録: ' + f + '）');
  }
  if (cur.value && okManifest(cur.value, src, dest)) return cur.value;
  const prev = readJson(f + '.prev');
  if (prev.value && okManifest(prev.value, src, dest)) return { ...prev.value, recoveredFrom: 'prev' };
  throw new InputError('処理の記録が壊れていて、前の世代も読めない。保存先の書庫を孤児として扱い、確かめてから記録を作り直す（記録: ' + f + '）');
}
export function saveManifest(m) {
  const f = manifestPath(m.source, m.dest);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  m.generation++;
  const recovered = m.recoveredFrom === 'prev';
  delete m.recoveredFrom;
  if (recovered) {
    // 前の世代から戻した直後: 正常な前の世代（.prev）を残したまま、壊れた今の世代を脇へ退けて新しい今の世代を書く
    // （壊れた今の世代を .prev へ写すと、唯一の正常な世代を先に壊してしまう）
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.broken-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  } else if (fs.existsSync(f)) writeAtomic(f + '.prev', fs.readFileSync(f));
  writeAtomic(f, JSON.stringify(m, null, 2) + '\n');
}
export function manifestDigest(m) {
  const rows = Object.entries(m.items).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, v.state, v.archive ? v.archive.fileId : null, v.tmpArchive ? v.tmpArchive.fileId : null]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- ロック
// 状態を変える実行は、利用者ごとに1つずつ（方針 v7 §5.1）。排他的な新規作成で取り、古いロックは同じ PC で
// プロセスが無い（または開始時刻が違う）ときだけ、所有トークン付きの名前へ原子的に改名して回収する。別の PC のロックは回収しない
export class LockError extends Error {}
const lockPath = () => path.join(archiveDir(), 'ut-archive.lock');
export function procInfo(pid) {
  const rows = winProbe({ mode: 'proc', pid });
  if (!rows[0] || rows[0].type !== 'proc') throw new Error('補助スクリプトの proc の出力が無い');
  return rows[0];
}
export function acquireLock(label) {
  const f = lockPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const me = procInfo(process.pid);
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ token, pid: process.pid, start: me.start, host: os.hostname(), at: new Date(nowMs()).toISOString(), label });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (testHooks.beforeLock) testHooks.beforeLock();
    try {
      const fd = fs.openSync(f, 'wx');
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      return () => { try { if (JSON.parse(fs.readFileSync(f, 'utf8')).token === token) fs.unlinkSync(f); } catch { /* 解放の失敗は次回の二重起動の拒否で見える */ } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let held;
    try { held = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new LockError('ロックファイルを読めない。実行中でないと確かめてから消す: ' + f); }
    if (held.host !== os.hostname()) throw new LockError(`別の PC（${held.host}）の実行のロックがある。自動では回収しない。確かめてから消す: ${f}`);
    const p = procInfo(held.pid);
    if (p.alive && String(p.start) === String(held.start)) throw new LockError(`別の ut-archive が実行中（PID ${held.pid}）`);
    // 古いロック。回収は原子的な改名で行い、改名できなければ（別の実行が先に回収した）競合として止まる
    try { fs.renameSync(f, `${f}.stale-${held.token || 'x'}-${token}`); } catch { throw new LockError('古いロックの回収が別の実行と競合した。やり直す'); }
  }
  throw new LockError('ロックを取れない');
}

// ---------------------------------------------------------------- 7-Zip
export class ItemError extends Error {}
// 中断（Ctrl+C）。受けたら、動いている 7z をすべて止め直し、処理は InterruptError で巻き戻す（7z が終わった後に、検証・確定へ進ませない）
export class InterruptError extends Error {}
let interrupted = false;
const children = new Set();
function track(child) {
  children.add(child);
  child.on('close', () => children.delete(child));
  child.on('error', () => children.delete(child));
  return child;
}
// 試験用: 中断を受けた状態にする・戻す（apply を通さずに、状態を戻す処理の中断を確かめるため）
export function interruptForTest(v) { interrupted = v; }
function checkInterrupt() { if (interrupted) throw new InterruptError('中断した（Ctrl+C）。続きは plan と apply をやり直す'); }
// 同期の 7z（t・l）の間は Node の処理が止まり、中断の処理も動かない。Ctrl+C は同じコンソールの 7z にも届いて止まるので、戻った後に中断を確かめる
function spawn7z(sz, args, cwd) {
  const r = spawnSync(sz.path, args, { cwd, encoding: 'buffer', windowsHide: true, maxBuffer: 64 * MiB, timeout: 6 * 3600000 });
  checkInterrupt();
  if (r.error) throw new ItemError(`7z を起動できない（${r.error.code || 'spawn'}）`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (testHooks.killTree) { testHooks.killTree(child); return; }
  spawnSync(system32('taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 30000 });
}
// 7z a を非同期で動かし、書き込み中も空きを監視する。予備を割ったら、プロセスツリーごと止めて止まったことを確かめる
function run7zAsync(sz, args, cwd, { watch, everyMs }) {
  return new Promise((resolve, reject) => {
    const child = track(spawnChild(sz.path, args, { cwd, windowsHide: true, stdio: 'ignore' }));
    let stopped = null;
    // 止めると決めたら、7z が実際に終わるまで、監視のたびに止め直す（起動の直後は taskkill が効かないことがある。実測）
    const timer = setInterval(() => {
      if (!stopped && !interrupted) { const why = watch(); if (why) stopped = why; }
      if (stopped || interrupted) killTree(child);
    }, everyMs);
    child.on('error', (e) => { clearInterval(timer); reject(new ItemError('7z を起動できない: ' + e.code)); });
    child.on('close', (code) => {
      clearInterval(timer);
      // 中断を受けていれば、7z の終わり方によらず中断として巻き戻す
      if (interrupted) { reject(new InterruptError('中断した（Ctrl+C）。書きかけの書庫は採用しない。続きは plan と apply をやり直す')); return; }
      // 止めたのに 7z が正常に終わっていた（止める前に書き終えていた）なら、それも書き残す（止める仕組みが効いているかを確かめるため）
      if (stopped) { const e = new ItemError(stopped + (code === 0 ? '（7z は止まる前に終わっていた）' : '')); e.stop = true; reject(e); return; }
      resolve(code);
    });
  });
}
// 7z l -slt の出力から、書庫の中のファイルの一覧（Path・Size・CRC）を取り出す
export function parseSlt(text) {
  const blocks = String(text).replace(/\r\n/g, '\n').split('\n----------\n')[1];
  if (blocks === undefined) return null;
  const out = [];
  for (const b of blocks.split(/\n\s*\n/)) {
    const kv = Object.fromEntries(b.split('\n').map((l) => l.match(/^([A-Za-z ]+?) = (.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
    if (kv.Path === undefined) continue;
    out.push({ path: kv.Path, size: kv.Size === undefined ? null : Number(kv.Size), crc: kv.CRC || null, folder: kv.Folder === '+' });
  }
  return out;
}
// 書庫を展開した中身の SHA-256（標準出力を文字列にせず、ストリームのまま計算する）。終了コード 0 を確かめてから採用する
function extractedSha(sz, archive) {
  return new Promise((resolve, reject) => {
    const child = track(spawnChild(sz.path, ['e', '-so', '--', archive], { cwd: os.tmpdir(), windowsHide: true }));
    const h = crypto.createHash('sha256');
    child.stdout.on('data', (b) => h.update(b));
    child.on('error', (e) => reject(new ItemError('7z e を起動できない: ' + e.code)));
    child.on('close', (code) => {
      if (interrupted) { reject(new InterruptError('中断した（Ctrl+C）。書庫の検証を終えていない。続きは plan と apply をやり直す')); return; }
      if (code === 0) resolve(h.digest('hex')); else reject(new ItemError(`7z e が失敗した（exit ${code}）`));
    });
  });
}
const fileSha = (f) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  const rs = fs.createReadStream(f);
  rs.on('data', (b) => { if (interrupted) { rs.destroy(new InterruptError('中断した（Ctrl+C）。続きは plan と apply をやり直す')); return; } h.update(b); });
  rs.on('error', (e) => reject(e instanceof InterruptError ? e : new ItemError('読めない: ' + e.code))).on('end', () => resolve(h.digest('hex')));
});

// 元を1回読み、SHA-256 と CRC32 を取る（クラウドのみのファイルはここで取得される）。読み込みが止まったら時間切れにする
function hashFile(file, stallMs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let crc = 0;
    let bytes = 0;
    const rs = fs.createReadStream(file, { highWaterMark: 4 * MiB });
    const arm = () => setTimeout(() => rs.destroy(new ItemError('元の読み込みが止まった（取得できない可能性）')), stallMs);
    let timer = arm();
    rs.on('data', (b) => {
      if (interrupted) { rs.destroy(new InterruptError('中断した（Ctrl+C）。続きは plan と apply をやり直す')); return; }
      h.update(b); crc = zlib.crc32(b, crc); bytes += b.length; clearTimeout(timer); timer = arm();
    });
    rs.on('error', (e) => { clearTimeout(timer); reject(e instanceof ItemError || e instanceof InterruptError ? e : new ItemError('元を読めない: ' + e.code)); });
    rs.on('end', () => { clearTimeout(timer); resolve({ sha256: h.digest('hex'), crc32: (crc >>> 0).toString(16).toUpperCase().padStart(8, '0'), bytes }); });
  });
}

// ---------------------------------------------------------------- apply
const ATTRIB = () => system32('attrib.exe');
function runAttrib(args) {
  checkInterrupt();
  if (testHooks.attrib) return testHooks.attrib(args);
  const r = spawnSync(ATTRIB(), args, { encoding: 'utf8', windowsHide: true, cwd: os.tmpdir(), timeout: 120000 });
  return { code: r.error ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function fileEntry(abs) {
  const rows = winProbe({ mode: 'files', paths: [abs] });
  return rows[0] && rows[0].type === 'entry' ? rows[0] : null;
}
function mkPrivate(dir) {
  if (testHooks.mkPrivate) return testHooks.mkPrivate(dir);
  winProbe({ mode: 'mkprivate', path: dir });
}
// 不変であるべきもの（ファイルID・サイズ・更新日時・プレースホルダーか・同期済みか・ピン・それ以外の属性）が同じか。
// クラウドのみ／ローカル・割当・タグの変種は、取得で変わってよい（§4.1）
export function sameInvariant(planned, e) {
  if (!e || e.kind !== 'file') return '元が無い・ファイルでない';
  if (e.fileId !== planned.fileId) return 'ファイルIDが違う（差し替えられた）';
  if (e.size !== planned.size) return 'サイズが違う';
  if (ticksToMs(e.mtime) !== planned.mtimeMs) return '更新日時が違う';
  const a = stableState(e); const b = planned.initial;
  for (const k of ['attrs', 'pin', 'placeholder', 'inSync', 'cloudTag']) {
    // 同期待ち → 同期済み は、アップロードが終わっただけ（中身は変わらない。更新日時・サイズ・ID は別に見ている）なので許す。
    // 逆（同期済み → 同期待ち）は、書き換えなどでアップロード待ちになったことを意味するので許さない
    if (k === 'inSync' && b.inSync === false && a.inSync === true) continue;
    if (a[k] !== b[k]) return `状態が変わった（${k}）`;
  }
  if (localState(e) === 'partial') return '一部だけ取得の状態になった';
  return null;
}

const QUARANTINE_LIMIT = 10 * GiB;
function dirBytes(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : fs.lstatSync(p).size; }
  return n;
}

// 隔離（§5.1）。一時フォルダを、記録と所有トークンが一致するときだけ、同じボリュームの隔離の領域へ上書きしない改名で移す。
// 「隔離の途中」で落ちていた場合は、移動元だけ（やり直す）・移動先だけ（済み）・両方／どちらも無い（止める）の4通りを扱う
export function quarantineStep(m, quarantineDir, save) {
  if (m.state === 'quarantining') {
    const atSrc = !!m.tmpDir && fs.existsSync(m.tmpDir);
    const atDst = !!m.quarantineTo && fs.existsSync(m.quarantineTo);
    if (atDst && !atSrc) { save({ state: 'quarantined', tmpDir: null }); return 'done'; }
    if (atSrc && atDst) throw new BlockedError('隔離の途中で、移動元と移動先の両方にある（あり得ないので止める）: ' + m.quarantineTo);
    if (!atSrc && !atDst) throw new BlockedError('隔離の途中で、移動元にも移動先にも無い（要対応）: ' + (m.tmpDir || ''));
  }
  if (!m.tmpDir || !fs.existsSync(m.tmpDir)) return 'nothing';
  const owner = path.join(m.tmpDir, '.owner');
  if (!fs.existsSync(owner) || fs.readFileSync(owner, 'utf8') !== m.token) throw new BlockedError('一時フォルダの所有トークンが記録と合わない。動かさない: ' + m.tmpDir);
  const limit = testHooks.quarantineLimit ?? QUARANTINE_LIMIT;
  if (dirBytes(quarantineDir) + dirBytes(m.tmpDir) > limit) throw new BlockedError('隔離すると上限を超える。隔離の領域の中身を確かめてから片付ける: ' + quarantineDir);
  const to = path.join(quarantineDir, path.basename(m.tmpDir));
  if (fs.existsSync(to)) throw new BlockedError('隔離先に同じ名前がある（上書きしない）: ' + to);
  save({ state: 'quarantining', quarantineTo: to });
  fs.renameSync(m.tmpDir, to);
  save({ state: 'quarantined', tmpDir: null });
  return 'moved';
}

// 状態を変える実行（apply・verify-current --rehash-archives・release-archives・deletion-check）の共通の枠:
// 管理用のフォルダの確認 → ロック → 中断の受け手 → 本体 → （中断なら子の停止を待って）受け手とロックを外す
async function guarded(label, log, body) {
  // 管理用のフォルダが OneDrive の外かは、ロックを含めて何かを書く前に確かめる（まだ無ければ、いちばん近い既存の親で判定する）
  let probe = archiveDir();
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (syncRootOf(probe)) throw new InputError('管理用のフォルダ（UT_ARCHIVE_DIR）が OneDrive の同期ルートの中にある。OneDrive の外のフォルダを指定する');
  const release = acquireLock(label);
  // 中断（Ctrl+C）: 受けたら、動いている 7z をすべて、終わるまで止め直す（起動の直後は止める命令が効かないことがある）。
  // 処理そのものは InterruptError で巻き戻り、ロックを外して終わる。受け手は終わるまで外さない（2 回目の Ctrl+C で既定の即終了に戻さない）。
  // 巻き戻らないまま（読み込みが止まっている等）子がいなくなって一定時間たったときだけ、ここで終える
  interrupted = false;
  let sigTimer = null;
  const onSig = () => {
    if (interrupted) return; // 2 回目以降: 止め直しの繰り返しは既に動いている
    interrupted = true;
    log('中断を受けた。動いている 7z を止めてから終わる');
    const t0 = Date.now();
    const tick = () => {
      for (const c of children) killTree(c);
      if (children.size === 0 && Date.now() - t0 > (testHooks.sigGraceMs ?? 30000)) { release(); process.exit(130); }
      sigTimer = setTimeout(tick, 200);
    };
    tick();
  };
  process.on('SIGINT', onSig);
  try {
    return await body();
  } finally {
    // 中断のときは、子が残っていれば終わるまで待ってから受け手を外す（子が残ったまま戻らない）
    while (interrupted && children.size) { for (const c of children) killTree(c); await new Promise((r) => setTimeout(r, 200)); }
    clearTimeout(sigTimer);
    process.removeListener('SIGINT', onSig);
    interrupted = false;
    release();
  }
}

export async function apply({ source, dest, purpose, olderThanDays = 30, expect, releaseLocal = false, expectRelease, log = console.log }) {
  if (!expect) throw new InputError('--expect <計画ID> が要る');
  if (releaseLocal && !/^R-[0-9a-f]{16}$/.test(expectRelease || '')) throw new InputError('--release-local には plan が出した解放ID（--expect-release R-…）が要る');
  return guarded(`${source} -> ${dest || '(既定)'}`, log, async () => {
    // 件数は「対象 = OK ＋ 失敗 ＋ 戻し待ち・要対応 ＋ 未処理」が成り立つように数える（0 件・途中の打ち切りを成功に見せない）
    const counts = { done: 0, ok: 0, failed: 0, abandoned: 0, pending: 0, notRun: 0, targets: 0, attention: 0, settled: 0 };
    const p = plan({ source, dest, purpose, olderThanDays });
    if (p.noPlan) throw new BlockedError('目的が local-folder で対象が OneDrive の下。圧縮しない（plan の案内を見る）');
    if (!p.valid) throw new BlockedError('計画に止める理由がある: ' + p.blockers.join(' / '));
    if (p.id !== expect) throw new BlockedError(`計画ID が今の状態と合わない（今: ${p.id}）。plan をやり直して確かめる`);
    // 最初からローカルにあった元の解放（任意）は、元が OneDrive の下で、解放ID が今の対象と一致するときだけ
    let releaseKeys = null;
    if (releaseLocal) {
      if (!p.syncRoot) throw new InputError('--release-local は、元が OneDrive の同期ルートの下のときだけ使える（元をクラウドのみにする操作のため）');
      if (p.releaseLocal.id !== expectRelease) throw new BlockedError(`解放ID が今の状態と合わない（今: ${p.releaseLocal.id || 'なし（最初からローカルにある対象が無い）'}）。plan をやり直して確かめる`);
      releaseKeys = new Set(p.releaseLocal.keys);
    }
    const src = p.source; const dst = p.dest;
    // 一時フォルダ・隔離の領域は管理用のフォルダの中に置く。OneDrive の外で、保存先と同じボリュームに限る
    // （OneDrive の中だと書きかけの書庫が同期され、別のボリュームだと最後の移動が名前の変更で済まない）
    const work = path.join(archiveDir(), 'work');
    const quarantine = path.join(archiveDir(), 'quarantine');
    fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(quarantine, { recursive: true });
    if (syncRootOf(work)) throw new InputError('管理用のフォルダ（UT_ARCHIVE_DIR）が OneDrive の同期ルートの中にある。OneDrive の外のフォルダを指定する');
    if (String(fs.statSync(work).dev) !== p.destVol) throw new InputError('管理用のフォルダ（UT_ARCHIVE_DIR）が保存先と別のボリュームにある。保存先と同じボリュームの、OneDrive の外のフォルダを指定する');
    const manifest = loadManifest(src, dst);
    const runId = new Date(nowMs()).toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + '-' + crypto.randomBytes(3).toString('hex');
    // 一時の領域に、記録に無いものがあれば、動かさずに止める
    const known = new Set(Object.values(manifest.items).filter((m) => m.tmpDir).map((m) => normKey(m.tmpDir)));
    const strays = fs.readdirSync(work).filter((n) => !known.has(normKey(path.join(work, n))));
    if (strays.length) throw new BlockedError(`一時の領域に、記録に無いものが ${strays.length} 件ある。動かさない。確かめてから片付ける: ${work}`);
    // 計画の条件（目的・日数）も残す。verify-current・status が、同じ条件で元を数え直すため
    manifest.runs.push({ runId, at: new Date(nowMs()).toISOString(), planId: p.id, reserve: p.reserve, purpose: p.purpose, olderThanDays: p.olderThanDays });
    saveManifest(manifest);
    // 状態の記録はすべてここを通る。中断を受けた後は、どの記録にも進まない（どの時点で止まっても、再開の手順で続きから戻れる）
    const save = (key, patch) => { checkInterrupt(); manifest.items[key] = { ...(manifest.items[key] || {}), ...patch }; saveManifest(manifest); if (testHooks.afterSave) testHooks.afterSave(manifest.items[key].state, key); };
    const quarantineItem = (key) => quarantineStep(manifest.items[key] || {}, quarantine, (patch) => save(key, patch));

    // 記録に途中の状態が残っているのに、今回の対象に入らないもの → 一時フォルダを隔離して「中止」にする
    for (const key of p.stale) {
      const m = manifest.items[key];
      if (['committed', 'restoring'].includes(m.state)) { counts.attention++; log('  要対応: 確定済みの記録が今回の対象に入らない（元が変わった可能性）。記録を残す'); continue; }
      quarantineItem(key);
      save(key, { state: 'abandoned' });
      counts.abandoned++;
    }

    const targets = p.items.filter((i) => i.cls === 'target').sort((a, b) => a.size - b.size);
    counts.done = p.items.filter((i) => i.cls === 'done').length;
    counts.targets = targets.length;
    // 今の対象に入らない失敗・中止の記録は、履歴へ移す（消さない）。verify-current の「失敗 0」を、今の対象について判定するため
    const liveKeys = new Set(targets.map((t) => normKey(t.rel)));
    manifest.history = manifest.history || [];
    for (const [k, m] of Object.entries(manifest.items)) {
      if (!['failed', 'abandoned'].includes(m.state) || liveKeys.has(k)) continue;
      checkInterrupt();
      manifest.history.push({ key: k, ...m, settledBy: runId, settledAt: new Date(nowMs()).toISOString() });
      delete manifest.items[k];
      counts.settled++;
    }
    if (counts.settled) saveManifest(manifest);
    let i = 0;
    for (const t of targets) {
      checkInterrupt();
      i++;
      const key = normKey(t.rel);
      try {
        const r = await processItem({ t, key, srcAbs: path.join(src, t.rel), finalAbs: path.join(dst, t.dest), work, sz: p.sevenZip, runId, reserve: p.reserve, sameVolume: p.sameVolume, dst, destSyncRoot: p.destSyncRoot, releaseLocal: !!releaseKeys && releaseKeys.has(key), manifest, save, quarantineItem });
        if (r === 'restoring') { counts.pending++; log(`  [${i}/${targets.length}] 書庫は確定。元がクラウドのみに戻るのを待っている（同期中の可能性。次の実行・確認で再確認する）`); }
        else { counts.ok++; log(`  [${i}/${targets.length}] OK ${(t.size / MiB).toFixed(1)} MB`); }
      } catch (e) {
        if (!(e instanceof ItemError)) throw e;
        const cur = manifest.items[key];
        if (cur && ['committed', 'restoring'].includes(cur.state)) {
          // 確定した後の失敗は、状態を保つ（次の実行で、戻す作業だけをやり直す）。「失敗」で上書きすると、確定済みの書庫と衝突して進めなくなる
          save(key, { lastError: e.message });
          counts.pending++;
          log(`  [${i}/${targets.length}] 書庫は確定。後の作業が止まった: ${e.message}`);
        } else {
          counts.failed++;
          try { quarantineItem(key); } catch (q) { log(`  隔離できない: ${q.message}`); }
          save(key, { state: 'failed', reason: e.message });
          log(`  [${i}/${targets.length}] 失敗: ${e.message}`);
        }
        if (e.stop) { log('空き容量が足りないため中断する（再実行で続きから）'); break; }
      }
    }
    counts.notRun = targets.length - i;
    // 前の apply で解放し切れなかった「済み」の対象を、解放し直す（対象の処理が打ち切られていなければ）
    if (releaseKeys && !counts.notRun) {
      for (const key of p.releaseLocal.pendingKeys) {
        checkInterrupt();
        const m = manifest.items[key];
        await releaseLocalSource(path.join(src, m.rel), m, (patch) => save(key, patch));
      }
    }
    // --release-local の結果を、指定した対象について数える（記録が無い・処理されなかったものも数える）
    if (releaseKeys) {
      const l = { total: releaseKeys.size, released: 0, waiting: 0, notSynced: 0, blocked: 0, error: 0, notRun: 0 };
      for (const k of releaseKeys) {
        const st = manifest.items[k] && manifest.items[k].sourceRelease && manifest.items[k].sourceRelease.state;
        if (st && Object.hasOwn(l, st)) l[st]++; else l.notRun++;
      }
      counts.local = l;
    }
    return { counts, manifest };
  });
}

// 再開のときに照合する相手は「処理の記録に残した値」（今回の計画の値ではない。落ちている間に元が書き換わっても、
// 今回の計画はその書き換わった状態を見ているので、計画と比べても一致してしまう）
const recorded = (x) => ({ rel: x.rel, fileId: x.fileId, size: x.size, mtimeMs: x.mtimeMs, initial: x.initial });

async function processItem(c) {
  const { t, key, srcAbs, finalAbs, work, sz, runId, reserve, sameVolume, dst, destSyncRoot, releaseLocal, manifest, save, quarantineItem } = c;
  let m = manifest.items[key];
  // 確定済み・戻し待ちから再開するときは、後始末と元の解放の前に、宛先の書庫を照合し直す（落ちている間に書き換えられうる）
  const resumedAfterCommit = !!m && ['committed', 'restoring'].includes(m.state);
  // ---- 途中で落ちたときの戻り方（§5.3）
  if (m && m.state === 'quarantining') { quarantineItem(key); m = null; }
  if (m && ['planned', 'writing'].includes(m.state)) { quarantineItem(key); m = null; }
  if (m && ['failed', 'quarantined', 'abandoned'].includes(m.state)) m = null;
  if (m && m.state === 'archived') {
    const tmpArchive = path.join(m.tmpDir, 'a.7z');
    try { checkTmpDir(m.tmpDir); await verifyArchiveFile(sz, tmpArchive, recorded(m), m); save(key, { state: 'verified', tmpArchive: await tmpArchiveInfo(tmpArchive) }); m = manifest.items[key]; } catch (e) { if (!(e instanceof ItemError)) throw e; quarantineItem(key); m = null; }
  }
  if (!m) {
    // ---- 新しく処理する。空きを待った後（＝処理を始める直前）の状態を測り、それを「最初の状態」として記録する（計画の時点の値でも、待つ前の値でもない）
    await waitFree(t, sameVolume, reserve, path.dirname(srcAbs), dst);
    const e0 = fileEntry(srcAbs);
    const why = sameInvariant(t, e0);
    if (why) throw new ItemError(`計画の後に元が変わった（${why}）`);
    const tmpDir = path.join(work, `${runId}-${crypto.randomBytes(6).toString('hex')}`);
    const token = crypto.randomBytes(16).toString('hex');
    save(key, { rel: t.rel, state: 'planned', run: runId, tmpDir, token, fileId: e0.fileId, size: e0.size, mtimeMs: ticksToMs(e0.mtime), initial: stableState(e0), cloudOnly: localState(e0) === 'cloud-only', archive: null, tmpArchive: null, reason: null, lastError: null });
    mkPrivate(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.owner'), token, { flag: 'wx' });
    save(key, { state: 'writing' });
    const hs = await hashFile(srcAbs, testHooks.stallMs || 10 * 60000);
    if (hs.bytes !== e0.size) throw new ItemError(`読めた量がサイズと違う（${hs.bytes} / ${e0.size}）`);
    save(key, { sha256: hs.sha256, crc32: hs.crc32 });
    if (testHooks.afterHash) testHooks.afterHash(srcAbs);
    const destVolDir = fs.existsSync(dst) ? dst : path.dirname(dst);
    const code = await run7zAsync(sz, ['a', ...COMPRESS.switches, '--', path.join(tmpDir, 'a.7z'), path.basename(srcAbs)], path.dirname(srcAbs), {
      everyMs: testHooks.monitorMs ?? 5000,
      watch: () => (freeBytes(destVolDir) < reserve || freeBytes(path.dirname(srcAbs)) < reserve ? '書き込み中に空き容量が予備を割った（7z を止めた）' : null),
    });
    if (code !== 0) throw new ItemError(`7z a が失敗した（exit ${code}。1 は読めないファイルを飛ばした警告で、失敗として扱う）`);
    save(key, { state: 'archived' });
    m = manifest.items[key];
    if (testHooks.afterArchive) testHooks.afterArchive(path.join(tmpDir, 'a.7z'));
    checkTmpDir(tmpDir);
    await verifyArchiveFile(sz, path.join(tmpDir, 'a.7z'), recorded(m), m);
    save(key, { state: 'verified', tmpArchive: await tmpArchiveInfo(path.join(tmpDir, 'a.7z')) });
    m = manifest.items[key];
  }
  checkInterrupt();
  if (m.state === 'verified') {
    // ---- 事後の再確認（再開のときも必ず行う）。処理の記録の値と比べ、変わっていれば書庫を採用しない
    const why = sameInvariant(recorded(m), fileEntry(srcAbs));
    if (why) { quarantineItem(key); throw new ItemError(`処理の間に元が変わった（${why}）。書庫は採用しない`); }
    // ---- 確定。一時の書庫と宛先の有無の4通りを扱う
    const tmpA = m.tmpDir ? path.join(m.tmpDir, 'a.7z') : null;
    if (testHooks.beforeCommit) testHooks.beforeCommit(finalAbs);
    const tmpE = tmpA && fs.existsSync(tmpA) ? fileEntry(tmpA) : null;
    const fin = fileEntry(finalAbs);
    let reVerify = false;
    if (tmpE && !fin) {
      fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
      // 上書きしない確定: ハードリンクは宛先が既にあると失敗する（rename は上書きするので使わない）
      try { fs.linkSync(tmpA, finalAbs); } catch (e) { quarantineItem(key); throw new ItemError(e.code === 'EEXIST' ? '確定の直前に宛先に同名のファイルができた（上書きしない）' : '書庫を宛先に置けない: ' + e.code); }
    } else if (fin) {
      // 宛先にもうある（前の実行が確定の途中で落ちた）: 自分の書庫（記録した一時の書庫と同じファイルID・サイズ）だけを受け入れ、中身を照合し直す
      if (fin.fileId !== m.tmpArchive.fileId || fin.size !== m.tmpArchive.size || (tmpE && tmpE.fileId !== fin.fileId)) { quarantineItem(key); throw new ItemError('宛先に別のファイルがある（上書きしない）'); }
      reVerify = true;
    } else {
      // 一時の書庫も宛先も無い: 書庫を失った。最初からやり直す
      throw new ItemError('一時の書庫も宛先の書庫も見つからない（最初からやり直す）');
    }
    if (testHooks.afterLink) testHooks.afterLink(finalAbs);
    const placed = fileEntry(finalAbs);
    if (!placed || placed.fileId !== m.tmpArchive.fileId || placed.size !== m.tmpArchive.size) throw new ItemError('宛先に置いた書庫を確かめられない');
    if (reVerify) {
      if ((await fileSha(finalAbs)) !== m.tmpArchive.sha256) throw new ItemError('宛先の書庫が、記録した書庫と違う（書き換えられた）');
      await verifyArchiveFile(sz, finalAbs, recorded(m), m);
    }
    // 確定を先に記録し、一時の書庫・所有の印・一時フォルダの後始末は、何度でもやり直せる作業にする
    save(key, { state: 'committed', archive: { fileId: placed.fileId, size: placed.size, sha256: m.tmpArchive.sha256 } });
    m = manifest.items[key];
    if (testHooks.afterCommit) testHooks.afterCommit();
  }
  checkInterrupt();
  if (['committed', 'restoring'].includes(m.state)) {
    if (resumedAfterCommit) {
      const fin = fileEntry(finalAbs);
      if (!fin || fin.fileId !== m.archive.fileId || fin.size !== m.archive.size) throw new ItemError('確定済みの書庫が宛先に無い・記録と違う（元は解放しない）');
      if ((await fileSha(finalAbs)) !== m.archive.sha256) throw new ItemError('確定済みの書庫が、記録した書庫と違う（書き換えられた。元は解放しない）');
      await verifyArchiveFile(sz, finalAbs, recorded(m), m);
    }
    cleanupTmp(m, (patch) => save(key, patch));
    m = manifest.items[key];
    const r = await restoreSource(m, srcAbs, (patch) => save(key, patch));
    // 解放を指定されたことも同じ記録に残す（この後で解放が待ち・同期待ちになっても、落ちても、次の plan と apply で解放し直せる）
    save(key, { state: r === 'waiting' ? 'restoring' : 'restored', lastError: null, ...(r === 'untouched' && releaseLocal ? { releaseLocalRequested: true } : {}) });
    // 最初からローカルにあった元は、--release-local と解放ID の指定があるときだけクラウドのみにする（§5.2-9）
    if (r === 'untouched' && releaseLocal) await releaseLocalSource(srcAbs, manifest.items[key], (patch) => save(key, patch));
    // 保存先が OneDrive の下なら、同期済みを機械で確かめられた書庫だけを、この場でクラウドのみに戻す（§5.2-8）
    if (r !== 'waiting' && destSyncRoot) await releaseNewArchive(finalAbs, manifest.items[key], (patch) => save(key, patch));
    return r === 'waiting' ? 'restoring' : 'ok';
  }
  return 'ok';
}

// 確定した後の後始末（何度でもやり直せる）。所有トークンが合うときだけ消す
export function cleanupTmp(m, save) {
  if (!m.tmpDir) return;
  if (fs.existsSync(m.tmpDir)) {
    const owner = path.join(m.tmpDir, '.owner');
    if (!fs.existsSync(owner)) {
      // 所有の印を消した直後に落ちると、空のフォルダだけが残る。空なら消してよい。中身があれば自分の物と確かめられないので動かさない
      if (fs.readdirSync(m.tmpDir).length) throw new BlockedError('一時フォルダの所有の印が無い（中身がある）。動かさない: ' + m.tmpDir);
      fs.rmdirSync(m.tmpDir);
    } else {
      if (fs.readFileSync(owner, 'utf8') !== m.token) throw new BlockedError('一時フォルダの所有の印が記録と合わない。動かさない: ' + m.tmpDir);
      const a = path.join(m.tmpDir, 'a.7z');
      if (fs.existsSync(a)) fs.unlinkSync(a);
      fs.unlinkSync(owner);
      fs.rmdirSync(m.tmpDir);
    }
  }
  save({ tmpDir: null });
}

// 状態の復元（§5.2-8）。元が最初クラウドのみなら、クラウドのみに戻す。最初からローカルにあった元には触らない。
// 属性を変える直前に、元が記録と同じか（ID・サイズ・更新日時・不変の状態・中身の SHA-256）を照合し、違えば何も変えない。
// 戻した後は、実際にクラウドのみになるまで期限つきで待ち、間に合わなければ 'waiting'（次の実行・確認で再確認する）
// beforeAttrib: すべての照合が通った後、属性を変える直前に呼ぶ（呼び出し元が「試みた」印を残すため）
export async function restoreSource(m, srcAbs, save = () => {}, waitMs, beforeAttrib = null) {
  if (!m.cloudOnly) return 'untouched';
  // 戻った（クラウドのみになった）と認めるのは、記録と同じファイル（ID・サイズ・更新日時・プレースホルダー・同期済み）のときだけ
  const sameFile = (x) => !!x && x.kind === 'file' && x.fileId === m.fileId && x.size === m.size && ticksToMs(x.mtime) === m.mtimeMs
    && stableState(x).placeholder === m.initial.placeholder && (stableState(x).inSync === m.initial.inSync || (stableState(x).inSync && !m.initial.inSync));
  const e = fileEntry(srcAbs);
  if (e && localState(e) === 'cloud-only') {
    if (sameFile(e)) return 'released';
    throw new ItemError('元がクラウドのみになっているが、記録と別のファイルに見える（要対応）');
  }
  const why = sameInvariant(recorded(m), e);
  if (why) throw new ItemError(`状態を戻す直前に、元が記録と違う（${why}。何も変えない。要対応）`);
  if (testHooks.beforeRestore) testHooks.beforeRestore(srcAbs);
  if ((await fileSha(srcAbs)) !== m.sha256) throw new ItemError('状態を戻す直前に、元の中身が記録と違う（何も変えない。要対応）');
  // 中身を読んでいる間に差し替えられうるので、属性を変える直前にもう一度照合する
  if (testHooks.beforeAttribCheck) testHooks.beforeAttribCheck(srcAbs);
  const why2 = sameInvariant(recorded(m), fileEntry(srcAbs));
  if (why2) throw new ItemError(`状態を戻す直前に、元が記録と違う（${why2}。何も変えない。要対応）`);
  checkInterrupt();
  save({ state: 'restoring' });
  if (beforeAttrib) beforeAttrib();
  const r = runAttrib(['-P', '+U', srcAbs]);
  if (r.code !== 0) throw new ItemError(`元をクラウドのみに戻せない（attrib exit ${r.code}）`);
  const after = fileEntry(srcAbs);
  if (!after || !(after.attrs & A.UNPINNED)) throw new ItemError('元に「空き容量を増やす」の指定が付かない');
  return waitReleased(srcAbs, sameFile, '戻した後の元', waitMs);
}

// 最初からローカルにあった元を、利用者の指定（--release-local と解放ID）でクラウドのみにする（§5.2-9）。
// 同期済み（プレースホルダー・IN_SYNC・一部だけ取得でない・ID とサイズが記録どおり）を確かめてから、restoreSource と同じ照合
// （記録・中身・属性を変える直前）で戻す。結果は sourceRelease に記録し、ファイルの処理の状態（restored）は変えない。
// 待たずに 1 回だけ確かめる（件数が多いと 1 件ごとの待ちが積み重なる。戻り切ったかは status・deletion-check で見える）
async function releaseLocalSource(srcAbs, m, save) {
  const at = new Date(nowMs()).toISOString();
  const e = fileEntry(srcAbs);
  const ns = notSynced(e, { fileId: m.fileId, size: m.size });
  if (ns) { save({ sourceRelease: { state: 'notSynced', reason: ns, at } }); return 'notSynced'; }
  // 前の解放の試みで自分が「空き容量を増やす」を付けた（ピンが unpinned になった）元は、そのピンの違いだけを許す。
  // 「自分が試みた」は、すべての照合が通った後・属性を変える直前に残す専用の印（releaseAttempted）で判断する
  // （結果の記録の有無では判断しない。属性を変えた直後・結果を記録する前に止まっても、次の 1 回でやり直せるように。
  // 照合で止まった・同期待ちなど、属性を変えていない記録では印が付かず、ピンの違いを許さない）。
  // それ以外の不変の状態・ファイルID・サイズ・更新日時・中身の照合はそのまま
  const mm = m.releaseAttempted && e && pinState(e.attrs) === 'unpinned' && m.initial.pin !== 'unpinned' ? { ...m, initial: { ...m.initial, pin: 'unpinned' } } : m;
  try {
    const r = await restoreSource({ ...mm, cloudOnly: true }, srcAbs, () => {}, 0, () => save({ releaseAttempted: true }));
    save({ sourceRelease: { state: r, at } });
    return r;
  } catch (err) {
    if (!(err instanceof ItemError)) throw err;
    const blocked = /指定が付かない/.test(err.message);
    save({ sourceRelease: { state: blocked ? 'blocked' : 'error', reason: err.message, at } });
    return blocked ? 'blocked' : 'error';
  }
}

// クラウドのみに戻るのを期限つきで待つ。戻ったと認めるのは記録と同じファイルのときだけ。間に合わなければ 'waiting'
async function waitReleased(abs, sameFile, what, waitMs) {
  const deadline = Date.now() + (waitMs !== undefined ? waitMs : (testHooks.restoreWaitMs ?? 60000));
  for (;;) {
    checkInterrupt();
    const now = fileEntry(abs);
    if (now && localState(now) === 'cloud-only') {
      if (sameFile(now)) return 'released';
      throw new ItemError(`${what}が、記録と別のファイルに見える（要対応）`);
    }
    if (Date.now() > deadline) return 'waiting';
    await new Promise((res) => setTimeout(res, testHooks.pollMs ?? 2000));
  }
}

// 書庫を読み直した後、読む前にクラウドのみだった書庫をクラウドのみに戻す。属性を変える直前に、書庫が記録（検証済みの世代の
// ファイルID・サイズ・SHA-256）と同じかを照合し、違えば何も変えない（§5.2-8）
// requireSynced: 機械で同期済みを根拠に解放するときは、属性を変える直前に同期済みを確かめ直す（判定の後に変わりうる）
async function rereleaseArchive(abs, arc, waitMs, requireSynced = false) {
  const same = (x) => !!x && x.kind === 'file' && x.fileId === arc.fileId && x.size === arc.size && stableState(x).placeholder && stableState(x).inSync;
  const e = fileEntry(abs);
  if (!e || e.kind !== 'file' || e.fileId !== arc.fileId || e.size !== arc.size) throw new ItemError('状態を戻す直前に、書庫が記録と違う（何も変えない。要対応）');
  // もうクラウドのみ（記録と同じ書庫）なら、読まずに済みとする（読むと取得が起きる）
  if (localState(e) === 'cloud-only' && same(e)) return 'released';
  if ((await fileSha(abs)) !== arc.sha256) throw new ItemError('状態を戻す直前に、書庫の中身が記録と違う（何も変えない。要対応）');
  // 中身を読んでいる間に差し替え・同期の変化が起きうるので、属性を変える直前にもう一度照合する
  if (testHooks.beforeAttribCheck) testHooks.beforeAttribCheck(abs);
  const e2 = fileEntry(abs);
  if (!e2 || e2.kind !== 'file' || e2.fileId !== arc.fileId || e2.size !== arc.size) throw new ItemError('状態を戻す直前に、書庫が記録と違う（差し替えられた。何も変えない。要対応）');
  if (requireSynced && notSynced(e2, arc)) throw new ItemError('状態を戻す直前に、書庫が同期済みでなくなった（何も変えない）');
  checkInterrupt();
  const r = runAttrib(['-P', '+U', abs]);
  if (r.code !== 0) throw new ItemError(`書庫をクラウドのみに戻せない（attrib exit ${r.code}）`);
  const after = fileEntry(abs);
  if (!after || !(after.attrs & A.UNPINNED)) throw new ItemError('書庫に「空き容量を増やす」の指定が付かない（親フォルダが「常に保持」の可能性）');
  return waitReleased(abs, same, '戻した後の書庫', waitMs);
}

// 複数のパスの状態を一度に読む（補助スクリプトはパスごとに 1 行を順に返す。読めないパスは null）
function fileEntries(paths) {
  if (!paths.length) return [];
  const rows = winProbe({ mode: 'files', paths });
  if (rows.length !== paths.length) throw new Error('補助スクリプトの files の出力が要求と合わない');
  return rows.map((r) => (r.type === 'entry' ? r : null));
}

// 同期済み（§4）: プレースホルダー・同期済み（IN_SYNC）・一部だけ取得でない・ファイルIDとサイズが記録どおり。
// 「クラウドのみになった」ことだけでは同期済みとしない。同期済みなら null、そうでなければ理由
export function notSynced(e, arc) {
  if (!e || e.kind !== 'file') return '書庫が無い';
  if (e.fileId !== arc.fileId || e.size !== arc.size) return '書庫が記録と違う（ファイルID・サイズ）';
  const s = localState(e);
  if (s === 'not-placeholder') return '同期待ち（まだプレースホルダーでない）';
  if (s === 'partial' || s === 'unknown') return '一部だけ取得・判定できない';
  if (!(e.ph & PH.IN_SYNC)) return '同期中（同期済みでない）';
  return null;
}

// ---------------------------------------------------------------- status（記録を読むだけ）
// 今のファイルは読み直さない。表示は「記録上」と明示する（§8）。元・保存先が消えていても、記録は表示する
const STATE_GROUP = {
  restored: '済み', restoring: '書庫は確定・元が戻るのを待っている', committed: '書庫は確定・後の作業が止まった',
  planned: '途中で止まった', writing: '途中で止まった', archived: '途中で止まった', verified: '途中で止まった', quarantining: '途中で止まった',
  failed: '失敗', abandoned: '中止（元が変わって対象から外れた）', quarantined: '途中で止まった',
};
function locate(source, dest) {
  // 記録を読むだけなので、元・保存先が「存在しない」（lstat が ENOENT）ときに限り、指定どおりのパスで記録を探す。
  // 形の誤り（相対パス・UNC・ドライブの直下）は存在の有無によらず先に拒否し、存在する物はほかのサブコマンドと同じ検証を通す
  const shape = (p, label) => {
    if (!p || !path.isAbsolute(p)) throw new InputError(`${label} は絶対パスで指定する`);
    if (/^[\\/]{2}/.test(p)) throw new InputError(`${label} にネットワークのパス（UNC。\\\\ と // のどちらの形も）は使えない`);
    const r = path.resolve(p);
    if (path.parse(r).root.toLowerCase() === r.toLowerCase()) throw new InputError(`${label} にドライブの直下は指定できない（範囲が広すぎる）`);
  };
  // 「存在しない」の判定。Windows では途中がファイルでも ENOENT になる（実測）ので、いちばん近い既存の祖先がフォルダかも確かめ、
  // フォルダでなければ入力の誤りとして拒否する（「無い」と取り違えない）
  const gone = (p, label) => {
    try { fs.lstatSync(p); return false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (let a = path.dirname(path.resolve(p)); ; a = path.dirname(a)) {
      try {
        if (!fs.statSync(a).isDirectory()) throw new InputError(`${label} の途中がフォルダではない`);
        return true;
      } catch (e) { if (e instanceof InputError || e.code !== 'ENOENT') throw e; }
      if (path.dirname(a) === a) return true;
    }
  };
  shape(source, '--source');
  if (dest !== undefined) shape(dest, '--dest');
  if (gone(source, '--source')) {
    const s = path.resolve(source);
    const want = path.resolve(dest || s.replace(/[\\/]+$/, '') + '_7z');
    // 元が無くても、保存先が在れば通常の検証（リンク・ファイルの指定を拒否）を通す
    if (!gone(want, '--dest')) return { src: s, dst: resolveDest(s, want).path, found: false };
    return { src: s, dst: want, found: false };
  }
  const src = realDir(source, '--source');
  try { return { src, dst: resolveDest(src, dest).path, found: true }; } catch (e) {
    // 保存先の親フォルダが無いときだけ、指定どおりのパスで探す
    const want = path.resolve(dest || src.replace(/[\\/]+$/, '') + '_7z');
    if (!(e instanceof InputError) || !gone(path.dirname(want), '--dest')) throw e;
    return { src, dst: want, found: false };
  }
}
const AFTER_COMMIT = ['committed', 'restoring', 'restored'];
export function status({ source, dest }) {
  const { src, dst, found } = locate(source, dest);
  const manifest = loadManifest(src, dst);
  const items = Object.values(manifest.items);
  const groups = countBy(items, (m) => STATE_GROUP[m.state] || `不明な状態（${m.state}）`);
  const reasons = countBy(items.filter((m) => m.state === 'failed'), (m) => m.reason || '(理由なし)');
  const errors = countBy(items.filter((m) => ['committed', 'restoring'].includes(m.state) && m.lastError), (m) => m.lastError);
  const fixed = items.filter((m) => AFTER_COMMIT.includes(m.state));
  // §8 の3つの列を分けて数える（確かめていないものを、確かめたものに混ぜない）
  const axes = {
    archive: { atCreate: fixed.length, rehashed: fixed.filter((m) => m.rehashedAt).length },
    sync: {
      machine: fixed.filter((m) => m.archiveSync && m.archiveSync.state === 'synced').length,
      user: fixed.filter((m) => m.archiveSync && m.archiveSync.state === 'userConfirmed').length,
      none: fixed.filter((m) => !m.archiveSync).length,
    },
    release: countBy(fixed, (m) => (m.archiveRelease ? m.archiveRelease.state : 'none')),
    source: {
      cloudRestored: items.filter((m) => m.state === 'restored' && m.cloudOnly).length,
      localUntouched: items.filter((m) => m.state === 'restored' && !m.cloudOnly).length,
      waiting: items.filter((m) => ['committed', 'restoring'].includes(m.state)).length,
      // 最初からローカルにあった元の解放（--release-local）の結果
      localRelease: countBy(items.filter((m) => m.sourceRelease), (m) => m.sourceRelease.state),
    },
    // 読み直し（verify-current --rehash-archives・deletion-check）で取得したまま、クラウドのみに戻っていないもの
    refetched: items.filter((m) => m.archiveRefetch || m.deletionRefetch).length,
  };
  const restored = items.filter((m) => m.state === 'restored').length;
  // --release-local を指定されたのに、最初からローカルの元を解放し切れていないもの
  axes.source.localReleasePending = items.filter((m) => m.releaseLocalRequested && !(m.sourceRelease && m.sourceRelease.state === 'released')).length;
  // 記録上の完了: 1 件以上あり、すべてが済みで、読み直しで取得したままの書庫が無く、指定された解放が残っていないこと（中止・失敗・記録が空は完了としない）
  const complete = restored > 0 && restored === items.length && axes.refetched === 0 && axes.source.localReleasePending === 0;
  return { source: src, dest: dst, found, manifestFile: manifestPath(src, dst), recovered: manifest.recoveredFrom === 'prev', generation: manifest.generation, runs: manifest.runs, history: (manifest.history || []).length, total: items.length, groups, reasons, errors, axes, complete };
}

// ---------------------------------------------------------------- verify-current（今のファイルを読み直す）
// 完了の条件（§8）: 元を数え直して記録と突き合わせ、判定できない 0・未処理 0・途中 0・失敗 0（今の対象に無い失敗・中止の記録を含む）・
// 戻し待ち 0・衝突 0・保存先の走査エラー 0・書庫以外の出力 0（同期の衝突でできた別名・余計なフォルダを含む）。
// 各書庫が在り、ファイルID・サイズが記録と一致し、同期済み。読み直しで取得したままの書庫が無いこと。
// --rehash-archives は書庫を展開して SHA-256 を照合する。クラウドのみの書庫は取得が起きるので、読む前に「取得した」と記録し、
// 照合の成否によらず、記録と同じ書庫ならクラウドのみへ戻す（失敗・中断の後も、次の実行で戻し直す）
export async function verifyCurrent({ source, dest, rehash = false, log = console.log }) {
  const src = realDir(source, '--source');
  const d = resolveDest(src, dest);
  const run = async () => {
    // 記録はロックを取った後に読む（待っている間に別の実行が記録を変えうる）
    const manifest = loadManifest(src, d.path);
    const last = manifest.runs[manifest.runs.length - 1];
    if (!last) throw new BlockedError('処理の記録が無い（apply がまだ動いていない）。0 件を完了として扱わない');
    if (!last.purpose || typeof last.olderThanDays !== 'number') throw new BlockedError('記録に計画の条件（目的・日数）が無い。plan と apply をやり直す');
    const p = plan({ source: src, dest: d.path, purpose: last.purpose, olderThanDays: last.olderThanDays });
    if (p.noPlan) throw new BlockedError('目的が local-folder で対象が OneDrive の下（圧縮の対象ではない）');
    if (rehash && !p.sevenZip) throw new BlockedError('7-Zip（7z.exe）が見つからない（書庫を読み直せない）');
    const save = (key, patch) => { checkInterrupt(); manifest.items[key] = { ...manifest.items[key], ...patch }; saveManifest(manifest); };
    const problems = []; // { kind, rel } 実パスは詳細ファイルにだけ書く
    const add = (kind, rel) => problems.push({ kind, rel });
    for (const it of p.items) {
      if (it.cls === 'unknown') add(`判定できない（${it.reason}）`, it.rel);
      if (it.cls !== 'target') continue;
      const m = manifest.items[normKey(it.rel)];
      if (!m) add('未処理', it.rel);
      else if (m.state === 'failed') add('失敗', it.rel);
      else if (['committed', 'restoring'].includes(m.state)) add('書庫は確定・元が戻るのを待っている／後の作業が止まった', it.rel);
      else if (m.state === 'restored') add('記録上は済みだが、今の元または書庫が記録と違う', it.rel);
      else add('途中で止まった', it.rel);
    }
    // --release-local を指定されたのに、最初からローカルの元を解放し切れていないもの（済みの対象の中にある）
    for (const it of p.items) {
      if (it.cls !== 'done') continue;
      const m = manifest.items[normKey(it.rel)];
      if (m && m.releaseLocalRequested && !(m.sourceRelease && m.sourceRelease.state === 'released')) add('指定された元の解放（--release-local）が終わっていない（plan と apply でやり直す）', it.rel);
    }
    for (const k of p.stale) add('記録に途中の状態があるが、今の対象に入らない', manifest.items[k].rel || k);
    // 今の対象に入らない失敗・中止の記録（apply が履歴へ整理するまでは、失敗が残っているものとして数える）
    for (const k of p.settle) add('記録に失敗・中止が残っている（今の対象でない。plan と apply で履歴へ整理する）', manifest.items[k].rel || k);
    for (const c of p.collisions) add(`宛先の衝突（${c.kind}）`, c.a);
    if (p.destErrors) add(`保存先を走査できなかった箇所が ${p.destErrors} 件`, '');
    const done = p.items.filter((i) => i.cls === 'done');
    // 保存先に、書庫以外のファイル（同期の衝突でできた別名・手で置いた物・リンク）や、書庫の置き場所でないフォルダが無いか
    const expected = new Set(p.items.filter((i) => i.cls === 'done' || i.cls === 'target').map((i) => destKey(i.dest)));
    const expectedDirs = new Set();
    for (const k of expected) { const segs = k.split('\\'); for (let n = 1; n < segs.length; n++) expectedDirs.add(segs.slice(0, n).join('\\')); }
    for (const [rel, kind] of p.destExisting) {
      if (kind === 'dir') { if (!expectedDirs.has(destKey(rel))) add('保存先に、書庫の置き場所でないフォルダがある', rel); }
      else if (!expected.has(destKey(rel))) add('保存先に、書庫以外のファイルがある（同期の衝突による別名の可能性）', rel);
    }
    // 書庫の今の状態
    const absList = done.map((i) => path.join(p.dest, i.dest));
    const ents = fileEntries(absList);
    let synced = 0;
    let rehashed = 0;
    for (let k = 0; k < done.length; k++) {
      const key = normKey(done[k].rel);
      const m = manifest.items[key];
      const why = p.destSyncRoot ? notSynced(ents[k], m.archive) : (!ents[k] || ents[k].fileId !== m.archive.fileId || ents[k].size !== m.archive.size ? '書庫が無い・記録と違う' : null);
      if (why) { add(why, done[k].dest); continue; }
      synced++;
      const nowCloud = p.destSyncRoot && localState(ents[k]) === 'cloud-only';
      if (!rehash) {
        // 前の読み直しで取得したまま戻っていない書庫（クラウドのみに戻っていれば、記録の消し込みは次の --rehash-archives で行う）
        if (m.deletionRefetch && ((m.deletionRefetch.source && localState(done[k]) !== 'cloud-only') || (m.deletionRefetch.archive && !nowCloud))) add('削除の前の検査で取得したまま、クラウドのみに戻っていない（deletion-check で戻し直す）', done[k].rel);
        if (m.archiveRefetch && !nowCloud) add('読み直しで取得した書庫が、クラウドのみに戻っていない（--rehash-archives で戻し直す）', done[k].dest);
        continue;
      }
      // 書庫を読み直す。読む前にクラウドのみ（または前の読み直しで取得したまま）なら、取得したと先に記録する
      const wasCloud = nowCloud || !!m.archiveRefetch;
      if (nowCloud && freeBytes(path.dirname(absList[k])) < m.archive.size + p.reserve) { add('空きが足りず、書庫を読み直せない', done[k].dest); continue; }
      if (wasCloud) save(key, { archiveRefetch: { at: new Date(nowMs()).toISOString() } });
      // 試験用: 読むと取得が起きる（クラウドのみでなくなる）ことを、OneDrive の模擬で再現するための差し込み
      if (wasCloud && testHooks.onRefetch) testHooks.onRefetch(absList[k]);
      try {
        if ((await fileSha(absList[k])) !== m.archive.sha256) throw new ItemError('書庫のファイルの SHA-256 が記録と違う');
        await verifyArchiveFile(p.sevenZip, absList[k], { rel: m.rel, size: m.size }, m);
        rehashed++;
        save(key, { rehashedAt: new Date(nowMs()).toISOString() });
      } catch (e) {
        if (!(e instanceof ItemError)) throw e;
        add(e.message, done[k].dest);
      }
      // 照合の成否によらず、戻す（rereleaseArchive が属性を変える直前に、記録と同じ書庫かを照合する。違えば何も変えない）
      if (wasCloud) {
        try {
          const r = await rereleaseArchive(absList[k], m.archive, undefined, true);
          if (r === 'released') save(key, { archiveRefetch: null });
          else add('読み直した書庫が、クラウドのみに戻るのを待っている', done[k].dest);
        } catch (e) {
          if (!(e instanceof ItemError)) throw e;
          add('読み直した書庫をクラウドのみに戻せない: ' + e.message, done[k].dest);
        }
      }
    }
    // アップロードの確認ID（保存先が OneDrive の下のとき）。読み直しで状態が変わりうるので、今の状態を読み直してから作る
    let upload = null;
    if (p.destSyncRoot) {
      const { set, anomalies } = uploadSet(manifest, p);
      // 一致しないものが 1 件でもあれば、確認ID を出さない（黙って外した一覧で確認させない）
      upload = { id: set.length && !anomalies.length ? uploadId(src, p.dest, set, manifest) : null, total: set.length, machineSynced: set.filter((x) => x.machineSynced).length, anomalies: anomalies.length };
    }
    const kinds = countBy(problems, (x) => x.kind);
    const complete = done.length > 0 && problems.length === 0;
    return { source: src, dest: p.dest, destSyncRoot: !!p.destSyncRoot, done: done.length, synced, rehashed, rehash, problems, kinds, complete, upload };
  };
  return rehash ? guarded(`verify-current ${src}`, log, run) : run();
}

// ---------------------------------------------------------------- アップロードの確認と書庫の解放（§5.2-8・§8）
// 「同期済みの確認」と「解放の完了」は別に記録する（archiveSync・archiveRelease）。
// 解放していない書庫の一覧。今の書庫が記録（ファイルID・サイズ）と同じものだけを候補にする（違うものは verify-current が理由として出す）
function uploadSet(manifest, p) {
  // 母集団は「記録上、元を戻し終えて（restored）書庫をまだ解放していないもの」すべて。今の計画で済みになっていない・
  // 今の書庫が記録と違うものは、黙って外さずに anomalies として返す（1 件でもあれば確認ID を出さない）
  const doneKeys = new Set(p.items.filter((i) => i.cls === 'done').map((i) => normKey(i.rel)));
  const cand = Object.entries(manifest.items).filter(([, m]) => m.state === 'restored' && m.archive && !(m.archiveRelease && m.archiveRelease.state === 'released'));
  const absOf = (m) => path.join(p.dest, m.rel + '.7z');
  const ents = fileEntries(cand.map(([, m]) => absOf(m)));
  const set = []; const anomalies = [];
  cand.forEach(([key, m], k) => {
    const e = ents[k];
    if (!doneKeys.has(key)) anomalies.push({ key, rel: m.rel, why: '今の計画で済みになっていない（元・書庫が記録と違う）' });
    else if (!e || e.kind !== 'file' || e.fileId !== m.archive.fileId || e.size !== m.archive.size) anomalies.push({ key, rel: m.rel, why: '書庫が記録と違う' });
    else set.push({ key, abs: absOf(m), machineSynced: notSynced(e, m.archive) === null });
  });
  return { set, anomalies };
}
// アップロードの確認ID。正規化した source・dest と、候補の書庫ごとの（キー・ファイルID・サイズ・SHA-256・機械で同期済みか）から作る。
// 接頭辞は U-（計画ID の P- と取り違えない）。状態が変われば ID も変わる
export function uploadId(src, dest, set, manifest) {
  const items = [...set].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => {
    const a = manifest.items[x.key].archive;
    return [x.key, a.fileId, a.size, a.sha256, x.machineSynced];
  });
  return 'U-' + crypto.createHash('sha256').update(JSON.stringify({ v: 1, source: normKey(src), dest: normKey(dest), items })).digest('hex').slice(0, 16);
}
// 最後の実行の条件で計画を作り直し、解放していない書庫の一覧と確認ID を作る（ロックの中で呼ぶ）
function uploadContext(source, dest) {
  const src = realDir(source, '--source');
  const d = resolveDest(src, dest);
  const manifest = loadManifest(src, d.path);
  const last = manifest.runs[manifest.runs.length - 1];
  if (!last) throw new BlockedError('処理の記録が無い（apply がまだ動いていない）');
  if (!last.purpose || typeof last.olderThanDays !== 'number') throw new BlockedError('記録に計画の条件（目的・日数）が無い。plan と apply をやり直す');
  const p = plan({ source: src, dest: d.path, purpose: last.purpose, olderThanDays: last.olderThanDays });
  if (p.noPlan) throw new BlockedError('目的が local-folder で対象が OneDrive の下（圧縮の対象ではない）');
  if (!p.destSyncRoot) throw new BlockedError('保存先は OneDrive の外。アップロードの確認・書庫の解放の対象ではない');
  const { set, anomalies } = uploadSet(manifest, p);
  if (anomalies.length) throw new BlockedError(`解放していない書庫のうち ${anomalies.length} 件が、今の計画・書庫と一致しない。verify-current で理由を確かめる（確認ID は出さない）`);
  return { src, p, manifest, set, id: set.length ? uploadId(src, p.dest, set, manifest) : null };
}
// 1 つの書庫を解放する。属性を変える直前の照合は rereleaseArchive が行う。失敗はこの書庫の記録に残し、呼び出し元の状態は変えない
async function releaseOne(abs, m, save, machineSynced, waitMs) {
  const at = new Date(nowMs()).toISOString();
  if (machineSynced && !(m.archiveSync && m.archiveSync.state === 'synced')) save({ archiveSync: { state: 'synced', at } });
  try {
    const r = await rereleaseArchive(abs, m.archive, waitMs, machineSynced);
    save({ archiveRelease: { state: r, at } });
    return r;
  } catch (e) {
    if (!(e instanceof ItemError)) throw e;
    // 「空き容量を増やす」が付かない = 親フォルダが「常に保持」等。利用者の確認待ち
    const blocked = /指定が付かない/.test(e.message);
    save({ archiveRelease: { state: blocked ? 'blocked' : 'error', reason: e.message, at } });
    return blocked ? 'blocked' : 'error';
  }
}
// apply の中: 作った書庫が機械で同期済みなら、この場で解放する（待たずに 1 回だけ確かめる。間に合わなければ release-archives で）
async function releaseNewArchive(abs, m, save) {
  if (notSynced(fileEntry(abs), m.archive)) return 'notSynced';
  return releaseOne(abs, m, save, true, 0);
}

export async function confirmUpload({ source, dest, expect, log = console.log }) {
  if (!/^U-[0-9a-f]{16}$/.test(expect || '')) throw new InputError('--expect-upload には verify-current が出した確認ID（U-…）が要る');
  return guarded(`confirm-upload ${source}`, log, async () => {
    const c = uploadContext(source, dest);
    if (!c.set.length) throw new BlockedError('解放していない書庫が無い（確認するものが無い）');
    if (c.id !== expect) throw new BlockedError(`確認ID が今の状態と合わない（今: ${c.id}）。verify-current をやり直して確かめる`);
    const at = new Date(nowMs()).toISOString();
    let user = 0; let machine = 0;
    for (const x of c.set) {
      checkInterrupt();
      const m = c.manifest.items[x.key];
      c.manifest.items[x.key] = { ...m, archiveSync: x.machineSynced ? { state: 'synced', at } : { state: 'userConfirmed', uploadId: c.id, at } };
      if (x.machineSynced) machine++; else user++;
    }
    saveManifest(c.manifest);
    return { id: c.id, user, machine };
  });
}

export async function releaseArchives({ source, dest, expect, log = console.log }) {
  if (!/^U-[0-9a-f]{16}$/.test(expect || '')) throw new InputError('--expect-upload には verify-current が出した確認ID（U-…）が要る');
  return guarded(`release-archives ${source}`, log, async () => {
    const c = uploadContext(source, dest);
    if (!c.set.length) throw new BlockedError('解放していない書庫が無い');
    if (c.id !== expect) throw new BlockedError(`確認ID が今の状態と合わない（今: ${c.id}）。verify-current をやり直して確かめる`);
    const save = (key, patch) => { checkInterrupt(); c.manifest.items[key] = { ...c.manifest.items[key], ...patch }; saveManifest(c.manifest); };
    const counts = { total: c.set.length, released: 0, waiting: 0, skipped: 0, blocked: 0, error: 0 };
    for (const x of c.set) {
      checkInterrupt();
      const m = c.manifest.items[x.key];
      // 解放してよいのは、機械で同期済みを確かめた書庫か、この確認ID で利用者が確認した書庫だけ
      const confirmed = x.machineSynced || (m.archiveSync && m.archiveSync.state === 'userConfirmed' && m.archiveSync.uploadId === c.id);
      if (!confirmed) { counts.skipped++; continue; }
      counts[await releaseOne(x.abs, m, (patch) => save(x.key, patch), x.machineSynced)]++;
    }
    return { id: c.id, counts };
  });
}

// ---------------------------------------------------------------- 削除の直前の検査（§9）
// deletion-plan で範囲と見込みを示して削除検査ID を出し、deletion-check がその ID と照合してから、元・書庫を読み直す。
// 結果は「検査した時点の参考の判定。直後に失効しうる」。元のファイルは消さない（消すのは利用者）
const TOOL_VERSION = 'ut-archive/1';
const READ_MBPS = 50; // 時間の目安の計算にだけ使う
// generation: 削除検査ID に入れる記録の世代。省けば今の世代。deletion-check の途中の再計算では、開始時の世代を渡す
// （deletion-check 自身の書き込みで世代は進むが、その回数は別に数えて照合する）
function deletionScope(source, dest, generation) {
  const src = realDir(source, '--source');
  const d = resolveDest(src, dest);
  const manifest = loadManifest(src, d.path);
  const last = manifest.runs[manifest.runs.length - 1];
  if (!last) throw new BlockedError('処理の記録が無い（apply がまだ動いていない）');
  if (!last.purpose || typeof last.olderThanDays !== 'number') throw new BlockedError('記録に計画の条件（目的・日数）が無い。plan と apply をやり直す');
  const p = plan({ source: src, dest: d.path, purpose: last.purpose, olderThanDays: last.olderThanDays });
  if (p.noPlan) throw new BlockedError('目的が local-folder で対象が OneDrive の下（圧縮の対象ではない）');
  const done = p.items.filter((i) => i.cls === 'done');
  const arcAbs = done.map((i) => path.join(p.dest, i.dest));
  const arcEnts = fileEntries(arcAbs);
  const candidates = done.map((it, k) => ({ key: normKey(it.rel), rel: it.rel, srcAbs: path.join(src, it.rel), arcAbs: arcAbs[k], item: it, arcEntry: arcEnts[k], m: manifest.items[normKey(it.rel)] }));
  // 候補にならないファイル（除外・判定できない・未処理）。OS が作り直すファイルは、フォルダ単位の判定で別に扱う
  const others = p.items.filter((i) => i.cls !== 'done').map((i) => ({ rel: i.rel, cls: i.cls, reason: i.cls === 'target' ? '未処理・途中' : i.reason }));
  const isCloud = (e, inRoot) => !!inRoot && !!e && localState(e) === 'cloud-only';
  const fetch = {
    source: candidates.filter((c) => isCloud(c.item, p.syncRoot)).reduce((a, c) => a + c.m.size, 0),
    archive: candidates.filter((c) => isCloud(c.arcEntry, p.destSyncRoot)).reduce((a, c) => a + c.m.archive.size, 0),
  };
  const readBytes = candidates.reduce((a, c) => a + c.m.size + c.m.archive.size, 0);
  // 削除検査ID が固定するもの（§9）: ツールの版・正規化した source と dest・計画の条件・記録の世代と状態の要約・
  // 候補ごとの元と書庫の（ファイルID・サイズ・SHA-256）・候補にならないファイルとその理由
  const sortBy = (xs, f) => [...xs].sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));
  const canon = {
    v: 1, tool: TOOL_VERSION, source: normKey(src), dest: normKey(p.dest), purpose: last.purpose, olderThanDays: last.olderThanDays,
    generation: generation ?? manifest.generation, manifest: manifestDigest(manifest),
    items: sortBy(candidates, (c) => c.key).map((c) => [c.key, c.m.fileId, c.m.size, c.m.sha256, c.m.archive.fileId, c.m.archive.size, c.m.archive.sha256]),
    others: sortBy(others, (o) => normKey(o.rel)).map((o) => [normKey(o.rel), o.cls, o.reason || '']),
    destErrors: p.destErrors,
  };
  const id = 'D-' + crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
  return { src, p, manifest, candidates, others, fetch, readBytes, id };
}

export function deletionPlan({ source, dest }) {
  const sc = deletionScope(source, dest);
  const osFiles = sc.others.filter((o) => o.cls === 'excluded' && o.reason === REASON.osfile).length;
  const minutes = Math.ceil(sc.readBytes / (READ_MBPS * MiB) / 60);
  return { id: sc.id, source: sc.src, dest: sc.p.dest, candidates: sc.candidates.length, others: sc.others, osFiles, fetch: sc.fetch, readBytes: sc.readBytes, minutes, scope: sc };
}

// 読み直しで取得したもの（元・書庫）を、それぞれ独立に元の状態（クラウドのみ）へ戻す。属性を変える直前の照合は
// rereleaseArchive・restoreSource が行う（違えば何も変えない）。戻せなかった側の量と実パスを restoreErr に積み、
// 両方戻せたときだけ印を消す。中断（Ctrl+C）は、すぐ止めることを優先して戻さない（印が残り、次の deletion-check が最初に戻す）。
// 想定外の例外も、もう一方を試してから投げ直す
async function restoreFetched(c, m, srcCloud, arcCloud, save, restoreErr) {
  const errs = []; const paths = []; let bytes = 0; let fatal = null;
  const attempt = async (fn, size, abs, label) => {
    try {
      if ((await fn()) !== 'released') { errs.push(`${label}がクラウドのみに戻るのを待っている`); bytes += size; paths.push(abs); }
    } catch (err) {
      if (err instanceof InterruptError) throw err;
      errs.push(`${label}: ${err.message}`); bytes += size; paths.push(abs);
      if (!(err instanceof ItemError)) fatal = fatal || err;
    }
  };
  if (arcCloud) await attempt(() => rereleaseArchive(c.arcAbs, m.archive, undefined, true), m.archive.size, c.arcAbs, '書庫');
  if (srcCloud) await attempt(() => restoreSource({ ...m, cloudOnly: true }, c.srcAbs), m.size, c.srcAbs, '元');
  if (errs.length) restoreErr.push({ rel: c.rel, paths, why: errs.join(' / '), bytes });
  else if (srcCloud || arcCloud) save(c.key, { deletionRefetch: null });
  if (fatal) throw fatal;
  return errs.length ? errs.join(' / ') : null;
}

// 1 件の検査。読む前にクラウドのみだったものは、先に「取得した」と記録し、照合の成否によらず元の状態へ戻す。
// 戻せなければ restoreErr に積む（検査全体を失敗にする）。前の検査の印は、deletionCheck が候補の判定より先に戻している
async function deletionCheckOne(c, sc, save, restoreErr) {
  const m = sc.manifest.items[c.key]; // 印を戻した後の最新の記録
  const e = fileEntry(c.srcAbs);
  const why0 = sameInvariant(recorded(m), e);
  if (why0) return `元が記録と違う（${why0}）`;
  const a = fileEntry(c.arcAbs);
  if (!a || a.kind !== 'file' || a.fileId !== m.archive.fileId || a.size !== m.archive.size) return '書庫が無い・記録と違う';
  if (sc.p.destSyncRoot) { const ns = notSynced(a, m.archive); if (ns) return `書庫が同期済みでない（${ns}）`; }
  const srcCloud = !!sc.p.syncRoot && localState(e) === 'cloud-only';
  const arcCloud = !!sc.p.destSyncRoot && localState(a) === 'cloud-only';
  // 取得に要る空き: 同じボリュームなら元と書庫の合計を一度に、別のボリュームならそれぞれの側で確かめる
  const srcNeed = srcCloud ? m.size : 0; const arcNeed = arcCloud ? m.archive.size : 0;
  // （別のボリュームでは、片方だけを取得するときも、両方の側に予備が残ることを確かめる）
  const short = (srcCloud || arcCloud) && (sc.p.sameVolume
    ? freeBytes(path.dirname(c.srcAbs)) < srcNeed + arcNeed + sc.p.reserve
    : freeBytes(path.dirname(c.srcAbs)) < srcNeed + sc.p.reserve || freeBytes(path.dirname(c.arcAbs)) < arcNeed + sc.p.reserve);
  if (short) return '空きが足りず、読み直せない';
  if (srcCloud || arcCloud) save(c.key, { deletionRefetch: { source: srcCloud, archive: arcCloud, at: new Date(nowMs()).toISOString() } });
  // 試験用: 読むと取得が起きることを、OneDrive の模擬で再現するための差し込み
  if (testHooks.onRefetch) { if (arcCloud) testHooks.onRefetch(c.arcAbs); if (srcCloud) testHooks.onRefetch(c.srcAbs); }
  let why = null; let pending = null;
  try {
    if ((await fileSha(c.arcAbs)) !== m.archive.sha256) throw new ItemError('書庫のファイルの SHA-256 が記録と違う');
    await verifyArchiveFile(sc.p.sevenZip, c.arcAbs, { rel: m.rel, size: m.size }, m);
    if ((await fileSha(c.srcAbs)) !== m.sha256) throw new ItemError('元の中身が記録と違う');
  } catch (err) {
    if (err instanceof InterruptError) throw err; // 中断: 戻さずに印を残す
    if (err instanceof ItemError) why = err.message; else pending = err;
  }
  // 照合の成否によらず戻す。想定外の例外は、戻す処理を試してから投げ直す
  const rw = await restoreFetched(c, m, srcCloud, arcCloud, save, restoreErr);
  if (pending) throw pending;
  if (rw) return why || '元の状態に戻せない: ' + rw;
  return why;
}

export async function deletionCheck({ source, dest, expect, log = console.log }) {
  if (!/^D-[0-9a-f]{16}$/.test(expect || '')) throw new InputError('deletion-check には deletion-plan が出した削除検査ID（--expect D-…）が要る');
  return guarded(`deletion-check ${source}`, log, async () => {
    // ① 前の検査で取得したまま戻っていないもの（印のある記録）を、範囲・削除検査ID の照合より先に、候補かどうかによらず戻す。
    // 戻すと記録が変わる（世代が進む）ので、戻したら deletion-plan からやり直してもらう
    const src0 = realDir(source, '--source');
    const mf = loadManifest(src0, resolveDest(src0, dest).path);
    const flagged = Object.entries(mf.items).filter(([, m]) => m.deletionRefetch && m.archive);
    if (flagged.length) {
      const save0 = (key, patch) => { checkInterrupt(); mf.items[key] = { ...mf.items[key], ...patch }; saveManifest(mf); };
      const errs0 = [];
      const failed = new Set();
      for (const [key, m] of flagged) {
        checkInterrupt();
        const c = { key, rel: m.rel, srcAbs: path.join(src0, m.rel), arcAbs: path.join(mf.dest, m.rel + '.7z') };
        // 1 件で想定外の例外が起きても、残りの記録も戻す（中断だけは止める）
        try {
          const n = errs0.length;
          await restoreFetched(c, m, !!m.deletionRefetch.source, !!m.deletionRefetch.archive, save0, errs0);
          if (errs0.length > n) failed.add(key);
        } catch (err) {
          if (err instanceof InterruptError) throw err;
          failed.add(key);
        }
      }
      throw new BlockedError(`前の検査で取得したまま戻っていなかったもの ${flagged.length} 件のうち、戻した ${flagged.length - failed.size} 件 / 戻せない ${failed.size} 件${failed.size ? '（status で確かめる）' : ''}。記録が変わったので deletion-plan からやり直す`);
    }
    // ② 範囲と削除検査ID の照合
    const sc = deletionScope(source, dest);
    if (sc.id !== expect) throw new BlockedError(`削除検査ID が今の状態と合わない（今: ${sc.id}）。deletion-plan からやり直す`);
    if (!sc.p.sevenZip) throw new BlockedError('7-Zip（7z.exe）が見つからない（書庫を確かめられない）');
    const startGen = sc.manifest.generation;
    let ownSaves = 0;
    const save = (key, patch) => { checkInterrupt(); sc.manifest.items[key] = { ...sc.manifest.items[key], ...patch }; saveManifest(sc.manifest); ownSaves++; };
    const restoreErr = [];
    // 範囲が開始時と同じか: 削除検査ID を開始時の世代で計算し直し、記録の世代が「開始時＋この検査が書いた回数」と一致するかを見る
    // （ほかの実行が記録を書いていれば、世代がずれる）
    const unchanged = () => { const now = deletionScope(source, dest, startGen); return now.id === sc.id && now.manifest.generation === startGen + ownSaves; };
    // ③ 各ファイルを処理する直前に範囲を計算し直し（§9）、変わっていれば止める（一覧を出さない）
    const results = [];
    let changed = false;
    for (const c of sc.candidates) {
      checkInterrupt();
      if (!unchanged()) { changed = true; break; }
      const why = await deletionCheckOne(c, sc, save, restoreErr);
      results.push({ rel: c.rel, srcAbs: c.srcAbs, why });
      if (testHooks.afterDeletionItem) testHooks.afterDeletionItem(c.srcAbs);
    }
    // ④ 終わりにも計算し直す。検査の間に追加・変更・削除（更新日時・サイズ・ファイルID の変化）があれば、結果を出さない。
    // 中身だけを書き換えて更新日時を戻すような変更は、ここでは見えない（同じ権限の能動的な攻撃者は対象外。§10）。
    // 結果は各ファイルを照合した時点の判定で、検査の後と同じく直後に失効しうる（§9）
    if (!changed && !unchanged()) changed = true;
    const ok = results.filter((r) => !r.why);
    const ng = results.filter((r) => r.why);
    const osFiles = sc.others.filter((o) => o.cls === 'excluded' && o.reason === REASON.osfile);
    const keep = sc.others.filter((o) => !(o.cls === 'excluded' && o.reason === REASON.osfile)).map((o) => ({ ...o, path: path.join(sc.src, o.rel) }));
    // 走査の完全性（§9）: 判定できない（走査エラー・ADS の判定不能を含む）0・保存先の走査エラー 0・特殊なオブジェクト（リンク等）0・列挙中の変更 0
    const links = sc.others.filter((o) => o.reason === REASON.link).length;
    const scanComplete = !sc.others.some((o) => o.cls === 'unknown') && !sc.p.destErrors && links === 0 && !changed;
    // 一覧を出すのは、検査の間に範囲が変わらず、状態を戻せなかったものが無いときだけ
    const listValid = !changed && restoreErr.length === 0;
    const folderReady = listValid && scanComplete && ok.length > 0 && ng.length === 0 && keep.length === 0;
    return { id: sc.id, source: sc.src, dest: sc.p.dest, syncRoot: !!sc.p.syncRoot, ok, ng, keep, osFiles: osFiles.length, links, scanComplete, changed, restoreErr, listValid, folderReady };
  });
}

async function tmpArchiveInfo(f) {
  const e = fileEntry(f);
  if (!e || e.kind !== 'file') throw new ItemError('一時の書庫を確かめられない');
  return { fileId: e.fileId, size: e.size, sha256: await fileSha(f) };
}

// 一時フォルダの中は、書庫と所有の印だけ
function checkTmpDir(dir) {
  const names = fs.readdirSync(dir).sort();
  if (names.join('|') !== ['.owner', 'a.7z'].join('|')) throw new ItemError('一時フォルダの中に想定外のファイルがある: ' + names.length + ' 件');
}

// 書庫の検証（§5.2-5）: 7z t・エントリがちょうど1件・名前・サイズ・CRC・展開した中身の SHA-256
async function verifyArchiveFile(sz, archive, rec, m) {
  const tr = spawn7z(sz, ['t', '--', archive], os.tmpdir());
  if (tr.code !== 0) throw new ItemError(`7z t が失敗した（exit ${tr.code}）`);
  const lr = spawn7z(sz, ['l', '-slt', '--', archive], os.tmpdir());
  if (lr.code !== 0) throw new ItemError(`7z l が失敗した（exit ${lr.code}）`);
  const list = parseSlt(lr.stdout.toString('utf8'));
  if (!list || list.length !== 1) throw new ItemError(`書庫の中のエントリが 1 件でない（${list ? list.length : '読めない'}）`);
  const x = list[0];
  if (x.folder || x.path !== path.basename(rec.rel)) throw new ItemError('書庫の中の名前が違う');
  if (x.size !== rec.size) throw new ItemError('書庫の中のサイズが元と違う');
  if (!m.crc32 || (x.crc || '').toUpperCase() !== m.crc32) throw new ItemError('書庫の CRC が元と違う');
  const sha = await extractedSha(sz, archive);
  if (sha !== m.sha256) throw new ItemError('書庫を展開した中身の SHA-256 が元と違う');
}

// 空きを待つ（§5.2-2）。予備は実行の開始時に固定した値。期限を過ぎたら、この実行を安全に止める（待つ時間は実時間で測る）
async function waitFree(t, sameVolume, reserve, srcDir, dstDir) {
  const need = needFor(t, sameVolume, reserve);
  const deadline = Date.now() + (testHooks.waitMs ?? 30 * 60000);
  const poll = testHooks.pollMs ?? 20000;
  for (;;) {
    const okSrc = freeBytes(srcDir) >= need.source;
    const okDst = sameVolume || freeBytes(fs.existsSync(dstDir) ? dstDir : path.dirname(dstDir)) >= need.dest;
    if (okSrc && okDst) return;
    checkInterrupt();
    if (Date.now() > deadline) { const e = new ItemError(`空き容量が足りない（元側に ${(need.source / GiB).toFixed(2)} GB 要る）`); e.stop = true; throw e; }
    await new Promise((r) => setTimeout(r, poll));
  }
}

// ---------------------------------------------------------------- 表示
const gb = (b) => (b >= GiB ? (b / GiB).toFixed(2) + ' GB' : (b / MiB).toFixed(1) + ' MB');
const countBy = (arr, f) => { const m = new Map(); for (const x of arr) m.set(f(x), (m.get(f(x)) || 0) + 1); return m; };

function printSurvey(r, { summary }) {
  const s = r.stats;
  const u = s.unknown;
  const allocLabel = `${gb(s.alloc)}${u.alloc ? `（割当を読めない ${u.alloc} 件を除く。実際はこれより多い）` : ''}`;
  if (summary) {
    // リンクも出す（plan はリンクを「除外」、走査エラーを「判定できない」に数える。入口と出口で件数を照合するため: 件数＋リンク＋走査エラー＝plan の全件）
    console.log(`件数 ${s.files} / リンク ${s.links} / 論理 ${gb(s.logical)} / ローカル実体 ${allocLabel} / クラウドのみ ${s.cloudOnly.n} 件 ${gb(s.cloudOnly.bytes)} / 走査エラー ${s.errors} / 読めない ${u.detail + u.streams + u.alloc + u.state} / OneDrive ${r.syncRoot ? 'あり' : 'なし'}`);
    return;
  }
  console.log('== survey（読み取りだけ。中身は開かない）==');
  console.log(`OneDrive の同期ルートの下: ${r.syncRoot ? 'はい' : 'いいえ'}`);
  console.log(`ファイル ${s.files} 件 / フォルダ ${s.dirs} / リンク ${s.links}（たどらない） / 走査エラー ${s.errors}`);
  console.log(`読めなかった: 属性・ファイルID ${u.detail} / ADS の有無 ${u.streams} / 割当 ${u.alloc} / クラウドのみか ${u.state}`);
  console.log(`論理サイズ ${gb(s.logical)} / ローカルの実体 ${allocLabel}`);
  if (r.syncRoot) {
    console.log(`クラウドのみ ${s.cloudOnly.n} 件 ${gb(s.cloudOnly.bytes)} / 一部だけ取得 ${s.partial} 件`);
    console.log(`ピン: 常に保持 ${s.pin.pinned} / 空き容量を増やす指定 ${s.pin.unpinned} / 指定なし ${s.pin.none}`);
  }
  console.log(`ADS あり ${s.ads} / EFS ${s.efs} / ハードリンク ${s.hardlinks}`);
  console.log('拡張子別（上位 10）: ' + [...s.ext].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, b]) => `${e} ${gb(b)}`).join(' / '));
  console.log('直下のフォルダ別（上位 5、名前は伏せる）: ' + [...s.top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([, b], i) => `#${i + 1} ${gb(b)}`).join(' / '));
  console.log('大きいファイル（上位 8、名前は伏せる）: ' + s.largest.map((x) => gb(x.size)).join(' / '));
  console.log(`空き（${path.parse(r.source).root}）: ${gb(r.free)}`);
  console.log(`7-Zip: ${r.sevenZip ? `${r.sevenZip.version || '版不明'}` : '見つからない'}`);
  if (r.detailFile) console.log(`名前つきの一覧（この PC の中だけ）: ${r.detailFile}`);
  console.log('');
  if (r.syncRoot) {
    console.log('次: 目的に合わせて計画を作る');
    console.log('  この PC の空きだけが目的 → 圧縮は不要。OneDrive の「空き容量を増やす」で空く（plan --purpose local-folder で案内を出す）');
    console.log(`  クラウドの容量を減らす → node tools/ut-archive.mjs plan --source "<対象>" --purpose cloud`);
  } else {
    console.log('次: node tools/ut-archive.mjs plan --source "<対象>"（--dest を省くと <対象>_7z）');
  }
}

function printPlan(p) {
  if (p.noPlan) {
    console.log('== plan: 圧縮の計画は作らない ==');
    console.log('対象は OneDrive の同期ルートの下で、目的は「この PC の空き」。圧縮しなくても、OneDrive の「空き容量を増やす」で空く。');
    console.log('  エクスプローラーで対象のフォルダを右クリック →「空き容量を増やす」（クラウドには残り、開くと取得される）');
    console.log('  「常にこのデバイスに保持する」の設定は外れる。未同期のファイルはローカルに残る（データは失われない）');
    console.log('クラウドの容量も減らしたいなら: --purpose cloud');
    return;
  }
  const items = p.items;
  const by = countBy(items, (i) => i.cls);
  console.log('== plan ==');
  console.log(`目的: ${p.purpose === 'cloud' ? 'クラウドの容量を減らす（元を消してごみ箱を空にするまで、クラウドの使用量は一時的に増える）' : 'この PC の空き（7z を作るだけ。元を消すまで空き容量は増えない）'}`);
  console.log(`保存先: ${p.destExists ? '既存のフォルダ' : '新しく作る'}（${p.sameVolume ? '元と同じボリューム' : '元と別のボリューム'}）`);
  console.log(`対象 ${by.get('target') || 0} 件 / 除外 ${by.get('excluded') || 0} 件 / 判定できない ${by.get('unknown') || 0} 件（計 ${items.length}）`);
  const targets = items.filter((i) => i.cls === 'target');
  const tBytes = targets.reduce((a, t) => a + t.size, 0);
  const cloud = targets.filter((t) => t.cloudOnly);
  console.log(`対象の合計 ${gb(tBytes)}（うちクラウドのみ ${cloud.length} 件 ${gb(cloud.reduce((a, t) => a + t.size, 0))}。処理のときに 1 件ずつ取得する）`);
  console.log(`書庫の見込み（参考。圧縮率はデータで 1/3〜1/40）: ${gb(tBytes * 0.3)} 以下`);
  for (const [reason, n] of countBy(items.filter((i) => i.cls !== 'target'), (i) => `${i.cls === 'unknown' ? '判定できない' : '除外'}: ${i.reason}`)) console.log(`  ${reason} ${n} 件`);
  console.log(`空き: 元のボリューム ${gb(p.free)}${p.sameVolume ? '' : ` / 保存先のボリューム ${gb(p.destFree)}`}（予備 ${gb(p.reserve)} を残す）`);
  console.log(`1 件あたりに要る空き（最大）: 元側 ${gb(p.worst.source)}${p.sameVolume ? '' : ` / 保存先側 ${gb(p.worst.dest)}`}${p.worst.source > p.free || (!p.sameVolume && p.worst.dest > p.destFree) ? ' ← 今の空きでは足りない（apply は空くまで待ち、期限を過ぎたら止まる）' : ''}`);
  console.log(`7-Zip: ${p.sevenZip ? p.sevenZip.version : '見つからない'}`);
  if (p.collisions.length) console.log(`宛先の衝突: ${p.collisions.length} 件（内容は計画ファイル）`);
  for (const w of p.warnings) console.log('注意: ' + w);
  console.log(`計画ファイル（この PC の中だけ。実パスを含む）: ${p.planFile}`);
  console.log('');
  if (!p.valid) {
    console.log('== 止める理由 ==');
    for (const b of p.blockers) console.log('  ' + b);
    console.log('計画ID は作らない（計画ファイルにも無効として残す）。理由を解消してから plan をやり直す。');
  } else {
    console.log(`計画ID: ${p.id}`);
    if (p.releaseLocal && p.releaseLocal.count) {
      console.log('');
      console.log(`最初からローカルにある対象: ${p.releaseLocal.count} 件 ${gb(p.releaseLocal.bytes)}（既定では処理の後もローカルのまま）${p.releaseLocal.pending ? `。うち ${p.releaseLocal.pending} 件は前回の --release-local で解放し切れなかった済みの対象（解放し直す）` : ''}`);
      console.log('  apply に --release-local --expect-release <解放ID> を付けると、処理の後に同期済みを確かめてからクラウドのみにする。');
      console.log('  影響: この PC の空きは増える。クラウドには残る。開くと取得される（時間がかかる・オフラインでは開けない）。「常に保持」の指定は外れる。');
      console.log(`解放ID: ${p.releaseLocal.id}（付けなければ、これらの元には触らない）`);
    }
    if (!targets.length) console.log(`処理する対象は 0 件。記録の整理（途中の状態・失敗・中止の記録を履歴へ移す）だけを行う。`);
    console.log('元のファイルは移動・削除しない。apply は、この計画ID と今の状態が一致するときだけ進む。');
  }
}

function printStatus(r) {
  console.log('== status（記録上。今のファイルは読み直していない。確かめるには verify-current）==');
  if (r.recovered) console.log('注意: 記録の今の世代が壊れていたため、前の世代から読んだ（次に状態を変える実行で書き直す）');
  if (!r.found) console.log('注意: 元または保存先が見つからない。指定どおりのパスで記録を探した（記録だけを表示する）');
  // 実行の記録が無いときだけ「まだ動いていない」とする（対象の記録が 0 件でも、履歴だけが残っていることがある）
  if (!r.runs.length && !r.total && !r.history) { console.log('処理の記録が無い（apply がまだ動いていない）。'); return; }
  const last = r.runs[r.runs.length - 1];
  console.log(`記録の世代 ${r.generation} / 実行 ${r.runs.length} 回（最後: ${last ? last.at : '-'}）`);
  console.log(`対象の記録 ${r.total} 件: ` + [...r.groups].map(([g, n]) => `${g} ${n}`).join(' / '));
  for (const [reason, n] of r.reasons) console.log(`  失敗: ${reason} ${n} 件`);
  for (const [err, n] of r.errors) console.log(`  後の作業が止まった: ${err} ${n} 件`);
  const x = r.axes;
  console.log(`書庫の検証: 作成時に照合済み ${x.archive.atCreate} 件 / 今の書庫を展開して照合済み ${x.archive.rehashed} 件`);
  console.log(`同期: 機械で確かめた ${x.sync.machine} 件 / 利用者が確認した ${x.sync.user} 件 / 記録なし ${x.sync.none} 件（今の状態は verify-current で確かめる）`);
  const rel = (k) => x.release.get(k) || 0;
  console.log(`書庫の解放: 解放済み ${rel('released')} 件 / クラウドのみに戻るのを待っている ${rel('waiting')} 件 / 解放できない（親フォルダが常に保持等） ${rel('blocked')} 件 / エラー ${rel('error')} 件 / まだ ${rel('none')} 件`);
  console.log(`元の状態: クラウドのみに戻した ${x.source.cloudRestored} 件 / 元からローカル ${x.source.localUntouched} 件 / 戻し待ち ${x.source.waiting} 件`);
  if (x.source.localRelease.size || x.source.localReleasePending) console.log('  元からローカルの元の解放（--release-local）: ' + [...x.source.localRelease].map(([k, n]) => `${{ released: '解放済み', waiting: '戻るのを待っている', notSynced: '同期待ち', blocked: '解放できない', error: 'エラー' }[k] || k} ${n}`).join(' / ') + ` / 解放し切れていない ${x.source.localReleasePending} 件${x.source.localReleasePending ? '（plan と apply --release-local でやり直す）' : ''}`);
  // 0 件でも出す（「出ていない」と「0 件」を区別できるように）
  console.log(`読み直しで取得したまま、クラウドのみに戻っていない書庫 ${x.refetched} 件${x.refetched ? '（verify-current --rehash-archives で戻し直す）' : ''}`);
  console.log(`履歴（今の対象から外れた失敗・中止の記録） ${r.history} 件`);
  console.log(`記録の場所（この PC の中だけ。実パスを含む）: ${r.manifestFile}`);
  console.log(r.complete ? '記録上はすべて済み。今の状態は verify-current で確かめる。' : '記録上、済んでいないものがある。plan と apply で続きを確かめる。');
}

function printVerify(r) {
  console.log(`== verify-current（今のファイルを読み直した${r.rehash ? '。書庫を展開して照合した' : '。書庫の中身の照合は --rehash-archives'}）==`);
  console.log(`済みの書庫 ${r.done} 件 / ${r.destSyncRoot ? `同期済み ${r.synced} 件` : `在って記録と一致 ${r.synced} 件（保存先は OneDrive の外。同期の確認は不要）`}${r.rehash ? ` / 展開して照合 ${r.rehashed} 件` : ''}`);
  if (r.problems.length) {
    console.log(`完了していない理由 ${r.problems.length} 件:`);
    for (const [k, n] of r.kinds) console.log(`  ${k} ${n} 件`);
  }
  if (r.upload) {
    if (r.upload.anomalies) console.log(`解放していない書庫のうち ${r.upload.anomalies} 件が、今の計画・書庫と一致しない。確認ID は出さない（上の理由を解消してから確かめ直す）`);
    else if (r.upload.total) {
      console.log(`解放していない書庫 ${r.upload.total} 件（機械で同期済み ${r.upload.machineSynced} / 同期を確かめられない ${r.upload.total - r.upload.machineSynced}）。確認ID: ${r.upload.id}`);
      if (r.upload.total > r.upload.machineSynced) console.log('  同期を確かめられない書庫は、OneDrive の画面でアップロードの完了を確かめてから confirm-upload --expect-upload <確認ID> で記録する');
      console.log('  解放は release-archives --expect-upload <確認ID>（機械で同期済み、または確認を記録した書庫だけを解放する）');
    } else console.log('解放していない書庫は無い。');
  }
  if (r.detailFile) console.log(`名前つきの一覧（この PC の中だけ）: ${r.detailFile}`);
  if (r.complete) console.log('完了の条件をすべて満たす（読み直した時点の判定。この後に変わりうる）。');
  else console.log(r.done ? '完了の条件を満たしていない。理由を解消してから確かめ直す。' : '済みの書庫が 0 件（0 件を完了として扱わない）。');
}

function printDeletionPlan(r) {
  console.log('== deletion-plan（範囲と見込み。書き込みは管理情報だけ）==');
  console.log(`検査する候補 ${r.candidates} 件（記録上済みで、今の元・書庫が記録と一致するもの）/ 候補にならないファイル ${r.others.length} 件（うち OS が作り直すファイル ${r.osFiles} 件）`);
  for (const [k, n] of countBy(r.others, (o) => `${o.cls === 'unknown' ? '判定できない' : o.cls === 'target' ? '未処理・途中' : '除外'}: ${o.reason || ''}`)) console.log(`  ${k} ${n} 件`);
  console.log(`読み直す量 ${gb(r.readBytes)}（元と書庫の両方）。うち取得が起きる量: 元 ${gb(r.fetch.source)} / 書庫 ${gb(r.fetch.archive)}（読んだ後、クラウドのみに戻す）`);
  console.log(`時間の目安: 約 ${r.minutes} 分（読み込み ${READ_MBPS} MB/s で概算。取得の速さで大きく変わる）`);
  console.log(`計画ファイル（この PC の中だけ。実パスを含む）: ${r.planFile}`);
  console.log(`削除検査ID: ${r.id}`);
  console.log('次: 同意を得てから deletion-check --expect <削除検査ID>。元のファイルは消さない（消すのは利用者）。');
}

function printDeletionCheck(r) {
  console.log('== deletion-check（検査した時点での参考の判定。直後に失効しうる）==');
  console.log('各ファイルを照合した時点の判定。照合の後に、更新日時を変えずに中身だけを書き換えるような変更は見えない。消す直前にやり直す。');
  if (r.changed) console.log('検査の間に、元・書庫・記録が変わった。この結果は使えない（一覧は出さない）。deletion-plan からやり直す。');
  if (r.restoreErr.length) {
    console.log(`読み直しで取得したものを元の状態に戻せなかった: ${r.restoreErr.length} 件（増えたローカルの使用量 ${gb(r.restoreErr.reduce((a, x) => a + x.bytes, 0))}）。検査全体を失敗とし、一覧は出さない`);
    console.log('  status で数を確かめ、deletion-check をやり直すと戻し直す。');
  }
  console.log(`個別の削除候補 ${r.listValid ? r.ok.length : 0} 件 / 候補にならなかった ${r.ng.length} 件 / 元に残すファイル ${r.keep.length} 件 / OS が作り直すファイル ${r.osFiles} 件 / 走査 ${r.scanComplete ? '完全' : `不完全（リンク等 ${r.links} 件を含む）`}`);
  for (const [k, n] of countBy(r.ng, (x) => x.why)) console.log(`  候補にならなかった: ${k} ${n} 件`);
  for (const [k, n] of countBy(r.keep, (o) => `${o.cls === 'unknown' ? '判定できない' : o.cls === 'target' ? '未処理・途中' : '除外'}: ${o.reason || ''}`)) console.log(`  元に残す: ${k} ${n} 件`);
  console.log(r.folderReady ? 'フォルダ単位: deletion-ready（その時点でフォルダ内のすべてが一覧に載っていた、というだけ。フォルダごと消してよい保証ではない）'
    : 'フォルダ単位: 消してはいけない（元に残すべきファイル・候補にならなかったファイル・走査の不足・検査の失敗のいずれかがある）');
  if (r.detailFile) console.log(`一覧と理由（この PC の中だけ。実パスを含む）: ${r.detailFile}`);
  if (r.listValid && r.ok.length) {
    console.log('消し方:');
    console.log('  1. この一覧に載ったファイルだけを消す（一覧に無いファイルは消さない）');
    console.log('  2. 消す直前に deletion-plan と deletion-check をやり直し、一覧が変わっていないことを確かめる');
    console.log('  3. 一覧のファイルを消してから、空になったフォルダを消す（フォルダごと消さない）');
    if (r.syncRoot) console.log('  4. クラウドの容量を空けるには、OneDrive のごみ箱（第 2 段階のごみ箱を含む）も空にする。保持期間は組織の設定で変わるので確かめる');
    else console.log('  4. ごみ箱へ送った場合は、ごみ箱を空にするまで空き容量は増えない');
  }
}

// ---------------------------------------------------------------- 引数
const SPEC = {
  roots: { value: [], flag: ['--json'] },
  survey: { value: ['--source'], flag: ['--summary', '--json'] },
  plan: { value: ['--source', '--dest', '--purpose', '--older-than'], flag: ['--json'] },
  apply: { value: ['--source', '--dest', '--purpose', '--older-than', '--expect', '--expect-release'], flag: ['--release-local'] },
  status: { value: ['--source', '--dest'], flag: ['--json'] },
  'verify-current': { value: ['--source', '--dest'], flag: ['--rehash-archives', '--json'] },
  'confirm-upload': { value: ['--source', '--dest', '--expect-upload'], flag: [] },
  'release-archives': { value: ['--source', '--dest', '--expect-upload'], flag: [] },
  'deletion-plan': { value: ['--source', '--dest'], flag: ['--json'] },
  'deletion-check': { value: ['--source', '--dest', '--expect'], flag: ['--json'] },
};
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!Object.hasOwn(SPEC, cmd || '')) throw new InputError('使い方: node tools/ut-archive.mjs roots | survey|plan|apply|status|verify-current|confirm-upload|release-archives|deletion-plan|deletion-check --source <dir> ...（--selftest で自己試験）');
  const spec = SPEC[cmd];
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const k = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (spec.value.includes(a)) {
      if (Object.hasOwn(o, k)) throw new InputError(`${a} が2回ある`);
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new InputError(`${a} に値が無い`);
      o[k] = v;
    } else if (spec.flag.includes(a)) {
      if (o[k]) throw new InputError(`${a} が2回ある`);
      o[k] = true;
    } else throw new InputError(`受け付けない引数: ${a}`);
  }
  if (cmd !== 'roots' && !o.source) throw new InputError('--source が要る');
  if (cmd === 'apply' && !/^P-[0-9a-f]{16}$/.test(o.expect || '')) throw new InputError('apply には plan が出した計画ID（--expect P-…）が要る');
  // --release-local と --expect-release は組で使う（片方だけは受け付けない）
  if (cmd === 'apply' && (o.releaseLocal || o.expectRelease !== undefined) && !(o.releaseLocal && /^R-[0-9a-f]{16}$/.test(o.expectRelease || ''))) throw new InputError('--release-local には plan が出した解放ID（--expect-release R-…）が要る（片方だけは受け付けない）');
  if (cmd === 'deletion-check' && !/^D-[0-9a-f]{16}$/.test(o.expect || '')) throw new InputError('deletion-check には deletion-plan が出した削除検査ID（--expect D-…）が要る');
  if ((cmd === 'confirm-upload' || cmd === 'release-archives') && !/^U-[0-9a-f]{16}$/.test(o.expectUpload || '')) throw new InputError(`${cmd} には verify-current が出した確認ID（--expect-upload U-…）が要る`);
  if (o.olderThan !== undefined) {
    if (!/^\d+$/.test(o.olderThan)) throw new InputError('--older-than は 0 以上の整数（日数）');
    o.olderThan = Number(o.olderThan);
  }
  return o;
}

function writeDetail(kind, obj) {
  const f = path.join(archiveDir(), kind, `${kind}-${new Date(nowMs()).toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${crypto.randomBytes(3).toString('hex')}.json`);
  writeAtomic(f, JSON.stringify(obj, null, 2) + '\n');
  return f;
}

export async function main(argv) {
  if (argv.includes('--selftest')) return null;
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  try {
    if (o.cmd === 'roots') {
      const r = roots();
      // パス（ユーザー名・組織名を含みうる）は --json にだけ出す。画面には件数と種類だけ
      if (o.json) console.log(JSON.stringify({ syncRoots: r.syncRoots, syncRootsKnown: r.syncRootsKnown, known: r.known, candidates: r.candidates, errors: r.errors }));
      else {
        console.log('== roots（読み取りだけ。圧縮の候補ルート）==');
        console.log(`OneDrive の同期ルート ${r.syncRootsKnown ? `${r.syncRoots.length} 件` : '読めない（未測定）'} / 既知フォルダ ${r.known.length} 件 / 候補 ${r.candidates.length} 件`);
        const label = { dir: (k) => (!r.syncRootsKnown ? '同期ルートを読めないため判定できない（未測定）' : k.inSyncRoot ? 'OneDrive の同期ルートの中（同期ルートとして数える）' : '同期ルートの外（候補）'), missing: () => '存在しない（候補にしない）', notDir: () => 'フォルダではない（未測定）', unreadable: () => '読めない（未測定）' };
        for (const k of r.known) console.log(`  ${k.name}: ${label[k.state](k)}`);
        for (const e of r.errors) console.log(`  読めなかった: ${e}`);
        console.log('パスは --json で出す（会話には伏せて示す）。');
      }
      // 読めなかったものがあれば、正常（0）で終えない
      return r.errors.length ? 2 : 0;
    }
    if (o.cmd === 'survey') {
      const r = survey(o);
      if (!o.summary && !o.json) r.detailFile = writeDetail('survey', { source: r.source, syncRoot: r.syncRoot, largest: r.stats.largest, top: [...r.stats.top] });
      const unk = Object.values(r.stats.unknown).reduce((a, b) => a + b, 0);
      if (o.json) console.log(JSON.stringify({ syncRoot: !!r.syncRoot, files: r.stats.files, links: r.stats.links, errors: r.stats.errors, unknown: r.stats.unknown, logical: r.stats.logical, alloc: r.stats.alloc, cloudOnly: r.stats.cloudOnly, free: r.free, sevenZip: r.sevenZip ? r.sevenZip.version : null }));
      else printSurvey(r, o);
      // 走査エラーや読めなかったものがあれば、正常（0）で終えない
      return r.stats.errors || unk ? 2 : 0;
    }
    if (o.cmd === 'plan') {
      const p = plan({ source: o.source, dest: o.dest, purpose: o.purpose, olderThanDays: o.olderThan ?? 30 });
      if (!p.noPlan) p.planFile = writeDetail('plans', p);
      // --json にも解放の別表（件数・サイズ・解放し直すものの数・解放ID）を出す（§5.2-9 の承認の材料）
      // 区分ごとの件数・バイト数（census）も出す（入口との照合のため。名前は含めない）
      if (o.json) console.log(JSON.stringify(planJson(p)));
      else printPlan(p);
      return p.noPlan ? 0 : p.valid ? 0 : 2;
    }
    if (o.cmd === 'apply') {
      const { counts } = await apply({ source: o.source, dest: o.dest, purpose: o.purpose, olderThanDays: o.olderThan ?? 30, expect: o.expect, releaseLocal: !!o.releaseLocal, expectRelease: o.expectRelease });
      if (counts.local) {
        const l = counts.local;
        console.log(`== 最初からローカルにあった元の解放（--release-local）: 対象 ${l.total} 件 = 解放 ${l.released} ＋ 戻るのを待っている ${l.waiting} ＋ 同期待ち ${l.notSynced} ＋ 解放できない ${l.blocked} ＋ エラー ${l.error} ＋ 処理されなかった ${l.notRun} ==`);
      }
      console.log(`== apply 終了: 今回の対象 ${counts.targets} 件 = OK ${counts.ok} ＋ 失敗 ${counts.failed} ＋ 戻し待ち・要対応 ${counts.pending} ＋ 未処理 ${counts.notRun} / 前回までに済み ${counts.done} 件 / 中止 ${counts.abandoned} 件 / 対象外の要対応 ${counts.attention} 件 / 履歴へ整理 ${counts.settled} 件 ==`);
      console.log('元のファイルは移動・削除していない。失敗したものは理由を記録した（plan をやり直すと、残りだけが対象になる）。');
      if (counts.pending || counts.attention) console.log('戻し待ち・要対応がある: 書庫は確定済み。status で内訳を、もう一度 plan と apply で続きを確かめる。');
      // 失敗・戻し待ち・未処理が 1 件でもあれば、正常（0）で終えない。--release-local を指定したのに解放し切れなかったものがあれば同じ
      return counts.failed || counts.pending || counts.notRun || counts.attention || (counts.local && counts.local.released !== counts.local.total) ? 2 : 0;
    }
    if (o.cmd === 'status') {
      const r = status(o);
      if (o.json) console.log(JSON.stringify({ total: r.total, groups: Object.fromEntries(r.groups), complete: r.complete, recovered: r.recovered, found: r.found, runs: r.runs.length, axes: { ...r.axes, release: Object.fromEntries(r.axes.release), source: { ...r.axes.source, localRelease: Object.fromEntries(r.axes.source.localRelease) } }, history: r.history }));
      else printStatus(r);
      return r.complete ? 0 : 2;
    }
    if (o.cmd === 'verify-current') {
      const r = await verifyCurrent({ source: o.source, dest: o.dest, rehash: !!o.rehashArchives });
      r.detailFile = writeDetail('verify', { source: r.source, dest: r.dest, at: new Date(nowMs()).toISOString(), problems: r.problems });
      if (o.json) console.log(JSON.stringify({ complete: r.complete, done: r.done, synced: r.synced, rehashed: r.rehashed, kinds: Object.fromEntries(r.kinds), upload: r.upload, detailFile: r.detailFile }));
      else printVerify(r);
      return r.complete ? 0 : 2;
    }
    if (o.cmd === 'confirm-upload') {
      const r = await confirmUpload({ source: o.source, dest: o.dest, expect: o.expectUpload });
      console.log(`== confirm-upload: 確認ID ${r.id} / 利用者の確認を記録 ${r.user} 件 / 機械で同期済み ${r.machine} 件 ==`);
      console.log('書庫はまだ解放していない。解放は release-archives --expect-upload <同じ確認ID>。');
      return 0;
    }
    if (o.cmd === 'release-archives') {
      const { id, counts: c } = await releaseArchives({ source: o.source, dest: o.dest, expect: o.expectUpload });
      console.log(`== release-archives: 確認ID ${id} / 候補 ${c.total} 件 = 解放 ${c.released} ＋ 戻るのを待っている ${c.waiting} ＋ 確認が無いため飛ばした ${c.skipped} ＋ 解放できない ${c.blocked} ＋ エラー ${c.error} ==`);
      if (c.blocked) console.log('解放できない書庫: 親フォルダが「常にこのデバイスに保持する」になっていないか確かめる。');
      // すべて解放できたときだけ 0
      return c.released === c.total ? 0 : 2;
    }
    if (o.cmd === 'deletion-plan') {
      const r = deletionPlan(o);
      r.planFile = writeDetail('deletion', { kind: 'deletion-plan', id: r.id, source: r.source, dest: r.dest, at: new Date(nowMs()).toISOString(), candidates: r.scope.candidates.map((c) => ({ rel: c.rel, source: c.srcAbs, archive: c.arcAbs })), others: r.others });
      if (o.json) console.log(JSON.stringify({ id: r.id, candidates: r.candidates, others: r.others.length, osFiles: r.osFiles, fetch: r.fetch, readBytes: r.readBytes, minutes: r.minutes, planFile: r.planFile }));
      else printDeletionPlan(r);
      return r.candidates ? 0 : 2;
    }
    if (o.cmd === 'deletion-check') {
      const r = await deletionCheck({ source: o.source, dest: o.dest, expect: o.expect });
      // 実パスはこの PC の中のファイルにだけ書く。一覧（deletable）は、使ってよいときだけ書く
      r.detailFile = writeDetail('deletion', { kind: 'deletion-check', id: r.id, source: r.source, dest: r.dest, at: new Date(nowMs()).toISOString(),
        note: '検査した時点での参考の判定。直後に失効しうる。この一覧に載ったファイルだけを消す。消す直前に検査し直す',
        listValid: r.listValid, folderReady: r.folderReady, deletable: r.listValid ? r.ok.map((x) => x.srcAbs) : [],
        notDeletable: r.ng.map((x) => ({ path: x.srcAbs, why: x.why })), keep: r.keep, restoreErrors: r.restoreErr, changed: r.changed });
      if (o.json) console.log(JSON.stringify({ id: r.id, listValid: r.listValid, folderReady: r.folderReady, deletable: r.listValid ? r.ok.length : 0, notDeletable: r.ng.length, keep: r.keep.length, osFiles: r.osFiles, links: r.links, scanComplete: r.scanComplete, changed: r.changed, restoreErrors: r.restoreErr.length, restoreBytes: r.restoreErr.reduce((a, x) => a + x.bytes, 0), detailFile: r.detailFile }));
      else printDeletionCheck(r);
      return r.folderReady ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof InterruptError) { console.error(e.message); return 130; }
    console.error((e instanceof InputError || e instanceof BlockedError || e instanceof LockError ? '' : '中断: ') + e.message);
    return 1;
  }
  return 1;
}

// ---------------------------------------------------------------- selftest
async function selftest(only = null) {
  const results = [];
  // --only A26,A30: 指定した試験だけを動かす（掃引で、変異ごとにその防御を見る試験だけを動かして時間を短くする。全件の判定には使わない）
  const picked = (name) => !only || only.some((id) => name.startsWith('[' + id + ']') || name.startsWith('[' + id + '-'));
  const t = (name, fn) => { if (!picked(name)) return; try { const m = fn(); results.push({ ok: true, name, m: m || '' }); } catch (e) { results.push({ ok: false, name, m: String((e && e.message) || e) }); } };
  const ta = async (name, fn) => { if (!picked(name)) return; try { const m = await fn(); results.push({ ok: true, name, m: m || '' }); } catch (e) { results.push({ ok: false, name, m: String((e && e.message) || e) }); } };
  const rejectsLike = async (fn, re, m) => { try { await fn(); } catch (e) { if (re.test(String(e.message))) return e; throw new Error(`${m}（別の理由: ${e.message}）`); } throw new Error(m); };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const throwsLike = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${m}（別の理由: ${e.message}）`); } throw new Error(m); };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-archive-st-'));
  const saved = { ...testHooks };
  const savedDir = process.env.UT_ARCHIVE_DIR;
  process.env.UT_ARCHIVE_DIR = path.join(base, 'mgmt');
  const restore = () => Object.assign(testHooks, saved);
  // 試験用の OneDrive: 同期ルートは base\od、その外は base\plain
  const od = path.join(base, 'od'); const plain = path.join(base, 'plain');
  for (const d of [path.join(od, 'src', 'sub'), path.join(plain, 'src'), path.join(od, 'pinned', 'inner')]) fs.mkdirSync(d, { recursive: true });
  const OLD = '133000000000000000'; // 2022 年ごろ（最終更新が十分古い）
  const msToTicks = (ms) => String(BigInt(ms) * 10000n + 116444736000000000n);
  // 既定は OneDrive の完全にローカルなファイルの実機の値（属性 0x420 = ARCHIVE・REPARSE、タグ 0x9000601a、状態 0x9）
  const fe = (rel, o = {}) => ({ type: 'entry', rel, kind: 'file', attrs: 0x420, tag: 0x9000601a, ph: 0x9, size: 1000, mtime: OLD, vol: 'aaaa0001', fileId: crypto.createHash('md5').update(rel).digest('hex').slice(0, 16), links: 1, alloc: 4096, streams: 0, ...o });
  // クラウドのみの実機の値（属性 0x401620・タグ 0x9000401a・状態 0x39・割当 0）
  const cloud = { attrs: 0x401620, tag: 0x9000401a, ph: 0x39, alloc: 0 };
  let scanRows = {};
  let statAttrs = {};
  let syncrootsExtra = [];
  const stubFor = ({ roots = [od], registered = [od] } = {}) => (req) => {
    const H = { type: 'header', version: 1, mode: req.mode };
    let body = [];
    if (req.mode === 'syncroots') body = [...roots.map((f) => ({ type: 'account', name: 'x', folder: f })), ...registered.map((f) => ({ type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: f })), ...syncrootsExtra];
    if (req.mode === 'syncroot') body = [{ type: 'syncroot', hr: registered.some((g) => isWithin(req.path, g)) ? 0 : HR_NOT_UNDER_SYNC_ROOT }];
    if (req.mode === 'scan') body = scanRows[normKey(req.root)] || [];
    if (req.mode === 'stat') body = req.paths.map((p) => (statAttrs[normKey(p)] === 'error' ? { type: 'stat', path: p, error: 5 } : { type: 'stat', path: p, attrs: statAttrs[normKey(p)] ?? 0x10, tag: 0, ph: 0x9 }));
    return [H, ...body, { type: 'end', count: body.length }];
  };
  const setup = (o) => {
    testHooks.winStub = stubFor(o);
    testHooks.sevenZip = { path: 'C:\\Program Files\\7-Zip\\7z.exe', version: '26.00', sha: 'x'.repeat(64) };
    testHooks.now = Date.UTC(2026, 9, 10);
    testHooks.freeBytes = () => 100 * GiB;
    scanRows = {}; statAttrs = {}; syncrootsExtra = [];
  };
  const putScan = (root, rows) => { scanRows[normKey(fs.realpathSync.native(root))] = rows; };
  try {
    // ---- 状態の判定（実機の値）
    t('[A01] 状態: クラウドのみ（PARTIAL かつ割当 0）・完全にローカル（PARTIAL なし）・一部だけ取得（PARTIAL かつ割当 > 0）', () => {
      assert(localState({ ph: 0x39, alloc: 0 }) === 'cloud-only', 'クラウドのみを取り違えた');
      assert(localState({ ph: 0x9, alloc: 8192 }) === 'local', '完全にローカルを取り違えた');
      assert(localState({ ph: 0x19, alloc: 4096 }) === 'partial', '一部だけ取得を取り違えた');
      assert(localState({ ph: 0, alloc: 10 }) === 'not-placeholder' && localState({ ph: PH_INVALID }) === 'not-placeholder', 'プレースホルダーでないものを取り違えた');
      assert(localState({ ph: 0x39 }) === 'unknown', '割当が読めないのにクラウドのみと決めた');
    });
    // ---- 分類
    t('[A02] 分類: 除外の理由と、判定できないもの', () => {
      setup();
      const rows = [
        fe('ok.csv'), fe('cloud.csv', cloud), fe('part.csv', { ph: 0x19, alloc: 4096 }),
        { type: 'entry', rel: 'jn', kind: 'link', attrs: 0x410, tag: 0xa0000003, ph: 0, size: 0, mtime: OLD },
        fe('ads.txt', { streams: 1 }), fe('efs.txt', { attrs: 0x4020 }), fe('hl.csv', { links: 2 }),
        fe('a.zip'), fe('b.7z'), fe('c.001'), fe('desktop.ini', { ph: 0, attrs: 0x26 }), fe('plain-new.txt', { ph: 0 }),
        fe('recent.csv', { mtime: msToTicks(Date.UTC(2026, 9, 1)) }),
        fe('noid.csv', { detailError: 5, fileId: undefined }), fe('nostream.csv', { streamsError: 5 }), fe('noalloc.csv', { ph: 0x39, alloc: undefined }),
        { type: 'error', rel: 'denied', error: 5 },
      ];
      const items = classify(rows, { inSyncRoot: true, destRoot: 'C:\\d', olderThanDays: 30, now: testHooks.now });
      const of = (rel) => items.find((i) => i.rel === rel);
      assert(of('ok.csv').cls === 'target' && !of('ok.csv').cloudOnly, 'ローカルのファイルを対象にしない');
      assert(of('cloud.csv').cls === 'target' && of('cloud.csv').cloudOnly, 'クラウドのみのファイルを対象にしない（PARTIAL の旗だけで外した）');
      const want = { 'part.csv': REASON.partial, jn: REASON.link, 'ads.txt': REASON.ads, 'efs.txt': REASON.efs, 'hl.csv': REASON.hardlink, 'a.zip': REASON.packed, 'b.7z': REASON.packed, 'c.001': REASON.numbered, 'desktop.ini': REASON.osfile, 'recent.csv': REASON.recent };
      for (const [rel, r] of Object.entries(want)) assert(of(rel).cls === 'excluded' && of(rel).reason === r, `${rel} の除外の理由が違う: ${of(rel).cls} ${of(rel).reason}`);
      const unk = { 'plain-new.txt': UNKNOWN.placeholder, 'noid.csv': UNKNOWN.detail, 'nostream.csv': UNKNOWN.streams, 'noalloc.csv': UNKNOWN.state, denied: UNKNOWN.scan };
      for (const [rel, r] of Object.entries(unk)) assert(of(rel).cls === 'unknown' && of(rel).reason === r, `${rel} を判定できないものにしない: ${of(rel).cls} ${of(rel).reason}`);
      return `${items.length} 件を分類`;
    });
    t('[A03] 分類: 同期ルートの外では、プレースホルダーでないファイルを対象にする', () => {
      const items = classify([fe('x.csv', { ph: 0 })], { inSyncRoot: false, destRoot: 'C:\\d', olderThanDays: 30, now: Date.UTC(2026, 9, 10) });
      assert(items[0].cls === 'target', '同期ルートの外のファイルを対象にしない');
    });
    t('[A04] 分類: 名前の問題（途中のフォルダを含む）・OneDrive で使えない名前・長すぎる宛先', () => {
      const items = classify([fe('a.csv.'), fe('b.csv '), fe('CON.txt'), fe('sub.\\x.csv'), fe('AUX\\y.csv'), fe('x'.repeat(390) + '.csv')], { inSyncRoot: false, destRoot: 'C:\\d', olderThanDays: 0, now: 0 });
      assert(items.slice(0, 5).every((i) => i.reason === REASON.badname), '名前の問題（途中のフォルダを含む）を見逃した: ' + items.slice(0, 5).map((i) => i.reason).join(' / '));
      assert(items[5].reason === REASON.longpath, '長すぎる宛先を見逃した');
      // ファイル .lock は宛先で .lock.7z になり OneDrive で使える。制限に当たるのは .lock という名前のフォルダ
      const od1 = classify([fe('~$draft.csv'), fe('a_vti_b\\c.csv'), fe('.lock\\x.csv')], { inSyncRoot: false, destRoot: 'C:\\d', destInSyncRoot: true, olderThanDays: 0, now: 0 });
      assert(od1.every((i) => i.reason === REASON.onedrivename), 'OneDrive で使えない名前を見逃した: ' + od1.map((i) => i.reason).join(' / '));
      const od2 = classify([fe('~$draft.csv')], { inSyncRoot: false, destRoot: 'C:\\d', destInSyncRoot: false, olderThanDays: 0, now: 0 });
      assert(od2[0].cls === 'target', '保存先が OneDrive でないのに OneDrive の名前の制限を当てた');
    });
    // ---- 衝突
    t('[A05] 衝突: 正規化だけが違う宛先・既存の出力・ファイルとフォルダ（既存・計画内）・ツールの予約名', () => {
      const tg = (rel) => ({ rel, dest: rel + '.7z' });
      const nfd = 'ga\u0301.csv'; const nfc = 'g\u00e1.csv';
      const cases = {
        '大文字小文字': findCollisions([tg('A.csv'), tg('a.CSV')], []),
        'Unicode の正規化': findCollisions([tg(nfd), tg(nfc)], []),
        '既存のファイル': findCollisions([tg('x.csv')], [{ type: 'entry', rel: 'X.CSV.7z', kind: 'file' }]),
        '途中のフォルダと既存のファイル': findCollisions([tg('sub\\y.csv')], [{ type: 'entry', rel: 'SUB', kind: 'file' }]),
        '既存のフォルダ': findCollisions([tg('z.csv')], [{ type: 'entry', rel: 'z.csv.7z', kind: 'dir' }]),
        '計画内のファイルとフォルダ': findCollisions([tg('a'), tg('a.7z\\b')], []),
        '対象が予約名': findCollisions([tg('.ut-archive-tmp\\x.csv')], []),
        '保存先に予約名の残り': findCollisions([tg('p.csv')], [{ type: 'entry', rel: '.ut-archive-tmp-1234', kind: 'dir' }]),
      };
      for (const [k, c] of Object.entries(cases)) assert(c.length >= 1, `${k} の衝突を見逃した`);
      assert(findCollisions([tg('p.csv'), tg('q.csv'), tg('sub\\r.csv')], [{ type: 'entry', rel: 'other.7z', kind: 'file' }, { type: 'entry', rel: 'sub', kind: 'dir' }]).length === 0, '衝突でないものを衝突にした');
      return Object.keys(cases).length + ' 形を検出';
    });
    // ---- 補助スクリプトの出力の検査
    t('[A06] 補助スクリプトの出力が途中で切れていれば止まる（end が無い・件数が合わない・header が無い）', () => {
      testHooks.winStub = () => [{ type: 'header' }, fe('a')];
      throwsLike(() => winProbe({ mode: 'scan' }), /途中で切れて/, 'end が無いのに通した');
      testHooks.winStub = () => [{ type: 'header' }, fe('a'), { type: 'end', count: 2 }];
      throwsLike(() => winProbe({ mode: 'scan' }), /途中で切れて/, '件数が合わないのに通した');
      testHooks.winStub = () => [fe('a'), { type: 'end', count: 1 }];
      throwsLike(() => winProbe({ mode: 'scan' }), /header が無い/, 'header が無いのに通した');
    });
    // ---- 同期ルート
    t('[A07] 同期ルート: 登録の無い OneDrive のフォルダ（残骸）は同期ルートとしない。API と食い違えば止まる', () => {
      setup({ roots: [od, plain], registered: [od] });
      assert(syncRootOf(path.join(od, 'src')) && !syncRootOf(path.join(plain, 'src')), '登録の無いフォルダを同期ルートとした');
      testHooks.winStub = stubFor({ roots: [], registered: [od] });
      throwsLike(() => syncRootOf(path.join(od, 'src')), /食い違う/, 'API とレジストリが食い違っても通した');
    });
    t('[A17] 同期ルート: OneDrive の登録を読めなければ、「登録が無い」とせずに止まる', () => {
      setup(); syncrootsExtra = [{ type: 'error', where: 'accounts', message: 'denied' }];
      throwsLike(() => syncRoots(), /読めない/, '読めない登録を「無い」として通した');
    });
    // ---- 計画: 目的・保存先
    t('[A08] 計画: OneDrive の下で目的が無ければ止まる。local-folder なら圧縮の計画を作らず案内する。外で cloud は止まる', () => {
      setup(); putScan(path.join(od, 'src'), [fe('a.csv')]); putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]);
      throwsLike(() => plan({ source: path.join(od, 'src') }), /--purpose/, '目的が無いのに計画を作った');
      const np = plan({ source: path.join(od, 'src'), purpose: 'local-folder' });
      assert(np.noPlan, 'local-folder でも圧縮の計画を作った');
      // plan --json は {noPlan:true} だけ（照合の対象外であることを、census の欠落ではなく明示で伝える）
      assert(JSON.stringify(planJson(np)) === '{"noPlan":true}', '計画を作らないときの plan --json が契約と違う: ' + JSON.stringify(planJson(np)));
      throwsLike(() => plan({ source: path.join(plain, 'src'), purpose: 'cloud' }), /同期ルートの下だけ/, '同期ルートの外で cloud を受け付けた');
      throwsLike(() => plan({ source: path.join(plain, 'src'), purpose: 'local' }), /cloud か local-folder/, '方針に無い目的の値を受け付けた');
    });
    t('[A09] 計画: 保存先と元の包含（どちら向きも）・cloud で保存先が同期ルートの外・UNC・ドライブの直下なら止まる', () => {
      setup(); putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]); putScan(path.join(od, 'src'), [fe('a.csv')]);
      throwsLike(() => plan({ source: path.join(plain, 'src'), dest: path.join(plain, 'src', 'out') }), /--source の中/, '元の中の保存先を受け付けた');
      throwsLike(() => plan({ source: path.join(plain, 'src'), dest: plain }), /--dest の中/, '保存先の中の元を受け付けた');
      throwsLike(() => plan({ source: path.join(od, 'src'), purpose: 'cloud', dest: path.join(plain, 'x') }), /同じ同期ルート/, '同期ルートの外の保存先を受け付けた');
      throwsLike(() => plan({ source: '\\\\server\\share\\x' }), /UNC/, 'UNC を受け付けた');
      throwsLike(() => plan({ source: path.parse(base).root }), /ドライブの直下/, 'ドライブの直下を受け付けた');
      throwsLike(() => plan({ source: path.join(plain, 'src'), dest: path.parse(base).root }), /--dest にドライブの直下/, '保存先にドライブの直下を受け付けた');
    });
    t('[A10] 計画: 止める理由（判定できない・対象 0 件・7-Zip の版・衝突・保存先の走査エラー）があれば計画ID を作らない', () => {
      setup();
      const check = (label, re) => { const p = plan({ source: path.join(plain, 'src') }); assert(p.blockers.some((b) => re.test(b)), `${label}で止めない`); assert(p.id === null && p.valid === false, `${label}なのに計画ID を作った: ${p.id}`); };
      putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 }), fe('b.csv', { ph: 0, detailError: 5 })]);
      check('判定できないものがある', /判定できない/);
      putScan(path.join(plain, 'src'), [fe('a.zip', { ph: 0 })]);
      check('対象 0 件', /0 件/);
      putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]);
      testHooks.sevenZip = { path: 'C:\\x\\7z.exe', version: null, sha: 'y' };
      check('7-Zip の版が読めない', /版を読み取れない/);
      testHooks.sevenZip = { path: 'C:\\x\\7z.exe', version: '26.00', sha: 'y' };
      const dst = path.join(plain, 'src_7z'); fs.mkdirSync(dst, { recursive: true });
      putScan(dst, [{ type: 'entry', rel: 'A.CSV.7z', kind: 'file', attrs: 0x20, size: 1, mtime: OLD }]);
      check('宛先の衝突', /衝突/);
      putScan(dst, [{ type: 'error', rel: '', error: 5 }]);
      check('保存先の走査エラー', /保存先を走査できなかった/);
      fs.rmSync(dst, { recursive: true });
      // 陽性対照: 問題が無ければ止める理由は無く、計画ID を作る
      const p = plan({ source: path.join(plain, 'src') });
      assert(p.valid && !p.blockers.length && /^P-[0-9a-f]{16}$/.test(p.id), '問題が無いのに止めた: ' + p.blockers.join(' / '));
    });
    t('[A16] 7-Zip が見つからなければ計画ID を作らない', () => {
      setup(); putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]);
      testHooks.sevenZip = null;
      const saveEnv = { ProgramFiles: process.env.ProgramFiles, ProgramW6432: process.env.ProgramW6432, PATH: process.env.PATH };
      process.env.ProgramFiles = path.join(base, 'nopf'); process.env.ProgramW6432 = path.join(base, 'nopf'); process.env.PATH = '';
      try {
        const p = plan({ source: path.join(plain, 'src') });
        assert(p.blockers.some((b) => /見つからない/.test(b)) && p.id === null, '7-Zip が無いのに止めない');
      } finally { Object.assign(process.env, saveEnv); }
    });
    t('[A18] 計画: 保存先の親がピン留めなら警告する。親の状態が読めなければ止まる', () => {
      setup(); putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]);
      const dst = path.join(od, 'pinned', 'inner', 'out');
      statAttrs[normKey(fs.realpathSync.native(path.join(od, 'pinned')))] = 0x80010;
      let p = plan({ source: path.join(plain, 'src'), dest: dst });
      assert(p.warnings.some((w) => /常にこのデバイスに保持/.test(w)), 'ピン留めの親を警告しない');
      statAttrs = {};
      p = plan({ source: path.join(plain, 'src'), dest: dst });
      assert(!p.warnings.length, 'ピン留めでないのに警告した');
      statAttrs[normKey(fs.realpathSync.native(path.join(od, 'pinned', 'inner')))] = 'error';
      throwsLike(() => plan({ source: path.join(plain, 'src'), dest: dst }), /ピン留めを判定できない/, '親の状態が読めないのに進んだ');
    });
    t('[A20] 計画: OneDrive の中に作る保存先のフォルダの名前も、OneDrive の制限に当てる', () => {
      setup(); putScan(path.join(plain, 'src'), [fe('a.csv', { ph: 0 })]);
      for (const bad of ['~$out', 'a_vti_b', '.lock', 'out.']) {
        throwsLike(() => plan({ source: path.join(plain, 'src'), dest: path.join(od, bad) }), /OneDrive で使えない/, `保存先の名前 ${bad} を受け付けた`);
      }
      const p = plan({ source: path.join(plain, 'src'), dest: path.join(od, 'good_out') });
      assert(p.valid, '使える名前の保存先を止めた: ' + p.blockers.join(' / '));
      const q = plan({ source: path.join(plain, 'src'), dest: path.join(plain, '~$ok-outside') });
      assert(q.valid, 'OneDrive の外の保存先に OneDrive の名前の制限を当てた');
    });
    // ---- 計画ID
    t('[A11] 計画ID: 同じ状態なら同じ・並び・クラウドのみかどうかでは変わらない。サイズ・更新日時・ファイルID・同期済み・ピン・7z・目的・日数では変わる', () => {
      setup();
      const src = path.join(od, 'src');
      const idOf = (rows, o = {}) => { putScan(src, rows); return plan({ source: src, purpose: 'cloud', ...o }).id; };
      const id1 = idOf([fe('a.csv'), fe('b.csv')]);
      assert(id1 && id1 === idOf([fe('a.csv'), fe('b.csv')]), '同じ状態で計画ID が変わった');
      assert(id1 === idOf([fe('b.csv'), fe('a.csv')]), '並び順で計画ID が変わった');
      assert(id1 === idOf([fe('a.csv', cloud), fe('b.csv')]), 'クラウドのみかどうか（属性・タグの変種・割当）で計画ID が変わった');
      const changes = {
        'サイズ': [fe('a.csv', { size: 1001 }), fe('b.csv')],
        '更新日時': [fe('a.csv', { mtime: '133000000010000000' }), fe('b.csv')],
        'ファイルID': [fe('a.csv', { fileId: 'ffff' }), fe('b.csv')],
        '同期済みでなくなった': [fe('a.csv', { ph: 0x1 }), fe('b.csv')],
        'ピン': [fe('a.csv', { attrs: 0x80020 }), fe('b.csv')],
      };
      for (const [k, rows] of Object.entries(changes)) assert(idOf(rows) !== id1, `${k}が変わっても計画ID が同じ`);
      assert(idOf([fe('a.csv'), fe('b.csv')], { olderThanDays: 7 }) !== id1, '日数が変わっても計画ID が同じ');
      // 目的は plan では値ごとに経路が分かれるため、計画の中身を固定して目的だけを変え、planId を直接比べる
      putScan(src, [fe('a.csv'), fe('b.csv')]);
      const pc = plan({ source: src, purpose: 'cloud' });
      assert(planId({ ...pc, purpose: 'local-folder' }) !== planId(pc), '目的が変わっても計画ID が同じ');
      testHooks.sevenZip = { ...testHooks.sevenZip, sha: 'z'.repeat(64) };
      assert(idOf([fe('a.csv'), fe('b.csv')]) !== id1, '7z の実体が変わっても計画ID が同じ');
      testHooks.sevenZip = { ...testHooks.sevenZip, sha: 'x'.repeat(64), version: '25.01' };
      assert(idOf([fe('a.csv'), fe('b.csv')]) !== id1, '7z の版が変わっても計画ID が同じ');
    });
    t('[A12] 空き: 同じボリュームなら元側に「取得分＋書庫の上限＋予備」、別なら元側と保存先側に分ける', () => {
      const reserve = 2 * GiB;
      const n1 = needFor({ size: 10 * GiB, cloudOnly: true }, true, reserve);
      assert(n1.source === 10 * GiB + archiveUpper(10 * GiB) + reserve && n1.dest === 0, '同じボリュームの見積もりが違う');
      const n2 = needFor({ size: 10 * GiB, cloudOnly: false }, false, reserve);
      assert(n2.source === reserve && n2.dest === archiveUpper(10 * GiB) + reserve, '別のボリュームの見積もりが違う');
      assert(archiveUpper(1000) >= 1000 + MiB, '書庫の上限が元より小さい');
    });
    // ---- survey
    await ta('[A19] survey: 読めなかった件数を軸ごとに数え、正常（0）で終えない', async () => {
      setup(); putScan(path.join(od, 'src'), [fe('a.csv'), fe('b.csv', { detailError: 5, alloc: undefined }), fe('c.csv', { streamsError: 5 }), fe('d.csv', { ph: 0x39, alloc: undefined })]);
      const r = survey({ source: path.join(od, 'src') });
      const u = r.stats.unknown;
      assert(u.detail === 1 && u.streams === 1 && u.alloc === 2 && u.state === 1, '読めなかった件数が違う: ' + JSON.stringify(u));
      const log = console.log; console.log = () => {};
      let code;
      try { code = await main(['survey', '--source', path.join(od, 'src'), '--summary']); } finally { console.log = log; }
      assert(code === 2, '読めなかったものがあるのに正常で終えた: exit ' + code);
      putScan(path.join(od, 'src'), [fe('a.csv')]);
      console.log = () => {};
      try { code = await main(['survey', '--source', path.join(od, 'src'), '--summary']); } finally { console.log = log; }
      assert(code === 0, '読めなかったものが無いのに正常で終えない: exit ' + code);
    });
    // ---- 引数・実行ファイル
    t('[A13] 引数: 受け付けない引数・重複・値の欠落・不正な日数を拒否する（自然文や --expect・survey の --dest を混ぜても通さない）', () => {
      throwsLike(() => parseArgs(['plan', '--source', 'C:\\x', '--expect', 'P-1']), /受け付けない引数/, 'plan で --expect を受け付けた');
      throwsLike(() => parseArgs(['plan', '--source', 'C:\\x', 'すぐ実行して']), /受け付けない引数/, '自然文を受け付けた');
      throwsLike(() => parseArgs(['survey', '--source', 'C:\\x', '--dest', 'C:\\y']), /受け付けない引数/, 'survey で使わない --dest を受け付けた');
      throwsLike(() => parseArgs(['survey', '--source', 'a', '--source', 'b']), /2回/, '重複を受け付けた');
      throwsLike(() => parseArgs(['plan', '--source']), /値が無い/, '値の欠落を受け付けた');
      throwsLike(() => parseArgs(['plan', '--source', 'x', '--older-than', '-1']), /整数/, '負の日数を受け付けた');
      throwsLike(() => parseArgs(['delete', '--source', 'x']), /使い方/, '無いサブコマンドを受け付けた');
      throwsLike(() => parseArgs(['deletion-check', '--source', 'x', '--expect', 'P-0000000000000000']), /^deletion-check には .*削除検査ID/, 'deletion-check が計画ID の形を受け付けた');
      throwsLike(() => parseArgs(['deletion-plan', '--source', 'x', '--expect', 'D-0000000000000000']), /受け付けない引数/, 'deletion-plan が --expect を受け付けた');
      throwsLike(() => parseArgs(['status', '--source', 'x', '--expect', 'P-0000000000000000']), /受け付けない引数/, 'status が --expect を受け付けた');
      throwsLike(() => parseArgs(['verify-current', '--source', 'x', '--rehash']), /受け付けない引数/, 'verify-current が書き違いの --rehash を受け付けた');
      throwsLike(() => parseArgs(['confirm-upload', '--source', 'x', '--expect-upload', 'P-0000000000000000']), /確認ID/, 'confirm-upload が計画ID の形を受け付けた');
      throwsLike(() => parseArgs(['release-archives', '--source', 'x']), /^release-archives には .*確認ID/, 'release-archives が確認ID なしで通った（またはエラー文にコマンド名が無い）');
      throwsLike(() => parseArgs(['apply', '--source', 'x', '--expect', 'U-0000000000000000']), /計画ID/, 'apply が確認ID の形を受け付けた');
      throwsLike(() => parseArgs(['apply', '--source', 'x']), /計画ID/, '計画ID の無い apply を受け付けた');
      throwsLike(() => parseArgs(['apply', '--source', 'x', '--expect', 'すぐ実行']), /計画ID/, '形の違う計画ID を受け付けた');
    });
    t('[A14] 実行ファイル: PATH の相対パスの場所の 7z を選ばない', () => {
      // 相対パスの場所は作業フォルダから解決される。作業フォルダに偽の 7z を置き、そこへ移ってから確かめる
      // （移らないと、相対パスの場所に何も無く、相対パスを探しても探さなくても結果が同じになる）
      const bin = path.join(base, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, '7z.exe'), 'x'); fs.writeFileSync(path.join(base, '7z.exe'), 'x');
      const cwd = process.cwd();
      process.chdir(base);
      try {
        assert(resolveOnPath('7z', { PATH: ['.', 'bin', ''].join(';') }) === null, '相対パスの場所（作業フォルダ・bin）の 7z を選んだ');
        assert(resolveOnPath('7z', { PATH: ['.', bin].join(';') }) === path.join(bin, '7z.exe'), '絶対パスの場所の 7z を選ばない');
      } finally { process.chdir(cwd); }
    });
    // ---- 補助スクリプトの実機の試験（Windows だけ）
    if (process.platform === 'win32') {
      t('[A15] 補助スクリプト（実機）: ジャンクションをたどらず、ハードリンク・ADS を数え、stat と同期ルートの判定が返り、出力が end で閉じる', () => {
        restore();
        const r = path.join(base, 'real'); const other = path.join(base, 'other');
        fs.mkdirSync(path.join(r, 'sub'), { recursive: true }); fs.mkdirSync(other);
        fs.writeFileSync(path.join(r, 'a.csv'), 'x'.repeat(1000));
        fs.linkSync(path.join(r, 'a.csv'), path.join(r, 'hl.csv'));
        fs.writeFileSync(path.join(r, 'sub', 'b.txt'), 'hello');
        fs.writeFileSync(path.join(r, 'sub', 'b.txt:secret'), 'ads');
        fs.writeFileSync(path.join(other, 'shouldnotappear.txt'), 'x');
        fs.symlinkSync(other, path.join(r, 'jn'), 'junction');
        const rows = winProbe({ mode: 'scan', root: r });
        const of = (rel) => rows.find((x) => x.rel === rel);
        assert(of('jn') && of('jn').kind === 'link', 'ジャンクションを link にしない');
        assert(!rows.some((x) => /shouldnotappear/.test(x.rel)), 'ジャンクションの先をたどった');
        assert(of('a.csv').links === 2 && of('hl.csv').fileId === of('a.csv').fileId, 'ハードリンクを数えない');
        assert(of('sub\\b.txt').streams === 1 && of('a.csv').streams === 0, 'ADS を数えない');
        assert(rows.every((x) => x.type === 'entry'), '走査エラーが出た');
        const st = winProbe({ mode: 'stat', paths: [r, path.join(r, 'nope')] });
        assert(st[0].attrs & A.DIRECTORY && st[1].error !== undefined, 'stat の結果が違う');
        assert(syncRootHr(base) === HR_NOT_UNDER_SYNC_ROOT, '一時フォルダを同期ルートの下と判定した');
        return `${rows.length} 行`;
      });
    } else results.push({ ok: true, name: '[A15] 補助スクリプト（実機）', m: 'Windows 以外のため飛ばした（1 件）' });

    // ---- apply（実機の 7-Zip と、OneDrive の外の一時フォルダの本物のファイルで動かす）
    restore();
    const sz7 = process.platform === 'win32' ? resolve7z() : null;
    if (sz7 && sz7.version) {
      class Crash extends Error {}
      const quiet = () => {};
      const OLD_DATE = new Date(Date.UTC(2022, 0, 1));
      const mk = (name, files) => {
        const s = path.join(base, 'ap-' + name);
        for (const [rel, body] of Object.entries(files)) { const f = path.join(s, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); fs.utimesSync(f, OLD_DATE, OLD_DATE); }
        return s;
      };
      const planOk = (s) => { const p = plan({ source: s, olderThanDays: 0 }); if (!p.valid) throw new Error('計画が無効: ' + p.blockers.join(' / ')); return p; };
      const run = (s, id) => apply({ source: s, expect: id, olderThanDays: 0, log: quiet });
      const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const listOf = (a) => parseSlt(spawn7z(sz7, ['l', '-slt', '--', a], os.tmpdir()).stdout.toString('utf8'));
      const workDir = () => path.join(archiveDir(), 'work');
      const csv = (n) => Array.from({ length: n }, (_, i) => `${i},name${i},${i * 3}`).join('\n');

      await ta('[A21] apply: 元を残したまま 1 ファイルずつ書庫を作り、書庫は 1 エントリ・元は変えない・一時の領域は空・やり直すと「すべて済み」', async () => {
        const s = mk('e2e', { 'a.csv': csv(2000), 'sub\\b.csv': csv(500) });
        const before = { a: sha(path.join(s, 'a.csv')), b: sha(path.join(s, 'sub', 'b.csv')), am: fs.statSync(path.join(s, 'a.csv')).mtimeMs };
        const p = planOk(s);
        const r = await run(s, p.id);
        assert(r.counts.ok === 2 && r.counts.failed === 0, '件数: ' + JSON.stringify(r.counts));
        for (const rel of ['a.csv', 'sub\\b.csv']) {
          const l = listOf(path.join(s + '_7z', rel + '.7z'));
          assert(l && l.length === 1 && l[0].path === path.basename(rel), rel + ' の書庫が 1 エントリでない');
        }
        assert(sha(path.join(s, 'a.csv')) === before.a && sha(path.join(s, 'sub', 'b.csv')) === before.b && fs.statSync(path.join(s, 'a.csv')).mtimeMs === before.am, '元が変わった');
        assert(fs.readdirSync(workDir()).length === 0, '一時の領域が空でない');
        assert(Object.values(r.manifest.items).every((m) => m.state === 'restored'), '記録の状態が restored でない');
        const p2 = plan({ source: s, olderThanDays: 0 });
        assert(!p2.valid && p2.blockers.some((b) => /すべて処理済み/.test(b)), 'やり直しで「すべて済み」にならない: ' + p2.blockers.join(' / '));
      });
      await ta('[A22] apply: 計画ID が今の状態と合わなければ何もしない', async () => {
        const s = mk('expect', { 'a.csv': csv(10) });
        await rejectsLike(() => run(s, 'P-0000000000000000'), /計画ID が今の状態と合わない/, '違う計画ID で進んだ');
        assert(!fs.existsSync(s + '_7z'), '止まったのに保存先を作った');
      });
      await ta('[A23] apply: 読んだ後に元が書き換わったら、書庫を採用しない', async () => {
        const s = mk('mutsrc', { 'a.csv': csv(1000) });
        const p = planOk(s);
        testHooks.afterHash = (f) => fs.appendFileSync(f, 'X');
        let r; try { r = await run(s, p.id); } finally { testHooks.afterHash = null; }
        assert(r.counts.failed === 1 && r.counts.ok === 0, '件数: ' + JSON.stringify(r.counts));
        assert(!fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '書き換わった元の書庫を確定した');
        assert(fs.readdirSync(workDir()).length === 0, '一時フォルダを隔離していない');
      });
      await ta('[A24] apply: 壊れた書庫（7z t が通らない）を採用しない', async () => {
        const s = mk('badarc', { 'a.csv': csv(1000) });
        const p = planOk(s);
        testHooks.afterArchive = (a) => { const b = fs.readFileSync(a); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(a, b); };
        let r; try { r = await run(s, p.id); } finally { testHooks.afterArchive = null; }
        assert(r.counts.failed === 1 && !fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '壊れた書庫を確定した: ' + JSON.stringify(r.counts));
      });
      for (const st of ['planned', 'writing', 'archived', 'verified', 'committed']) {
        await ta(`[A25-${st}] apply: ${st} の直後に落ちても、やり直すと正しく終わる（書庫は 1 つ・中身は元と同じ）`, async () => {
          const s = mk('crash-' + st, { 'a.csv': csv(1500) });
          const want = sha(path.join(s, 'a.csv'));
          let fired = false;
          testHooks.afterSave = (state) => { if (state === st && !fired) { fired = true; throw new Crash('落ちた'); } };
          try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterSave = null; }
          const r = await run(s, planOk(s).id);
          assert(r.counts.failed === 0 && r.counts.ok === 1, '件数: ' + JSON.stringify(r.counts));
          const out = path.join(s + '_7z', 'a.csv.7z');
          const ex = await extractedSha(sz7, out);
          assert(ex === want, '書庫の中身が元と違う');
          assert(fs.readdirSync(workDir()).length === 0, '一時の領域が空でない');
          assert(sha(path.join(s, 'a.csv')) === want, '元が変わった');
        });
      }
      await ta('[A26] apply: verified の後に落ちて、その間に元が書き換わったら、再開しても古い書庫を確定しない', async () => {
        const s = mk('crash-mut', { 'a.csv': csv(1500) });
        let fired = false;
        testHooks.afterSave = (state) => { if (state === 'verified' && !fired) { fired = true; throw new Crash('落ちた'); } };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterSave = null; }
        fs.appendFileSync(path.join(s, 'a.csv'), '\nchanged');
        fs.utimesSync(path.join(s, 'a.csv'), OLD_DATE, new Date(Date.UTC(2022, 0, 2)));
        const r = await run(s, planOk(s).id);
        assert(r.counts.failed === 1 && !fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '書き換わった元の古い書庫を確定した: ' + JSON.stringify(r.counts));
      });
      await ta('[A27] apply: 確定の直前に宛先に同名のファイルができたら、上書きしない', async () => {
        const s = mk('toctou', { 'a.csv': csv(800) });
        const p = planOk(s);
        testHooks.beforeCommit = (fin) => { fs.mkdirSync(path.dirname(fin), { recursive: true }); fs.writeFileSync(fin, 'mine'); };
        let r; try { r = await run(s, p.id); } finally { testHooks.beforeCommit = null; }
        assert(r.counts.failed === 1, '件数: ' + JSON.stringify(r.counts));
        assert(fs.readFileSync(path.join(s + '_7z', 'a.csv.7z'), 'utf8') === 'mine', '宛先のファイルを上書きした');
      });
      t('[A28] ロック: 実行中なら拒否・古い（プロセスが無い）なら原子的に回収・別の PC のものは回収しない', () => {
        const rel1 = acquireLock('x');
        try { throwsLike(() => acquireLock('y'), /実行中/, '実行中のロックを取れてしまった'); } finally { rel1(); }
        const lf = path.join(archiveDir(), 'ut-archive.lock');
        fs.writeFileSync(lf, JSON.stringify({ token: 'old', pid: 999999, start: '1', host: os.hostname() }));
        const rel2 = acquireLock('z');
        rel2();
        assert(fs.readdirSync(archiveDir()).some((n) => n.startsWith('ut-archive.lock.stale-old-')), '古いロックを回収した跡が無い');
        fs.writeFileSync(lf, JSON.stringify({ token: 'far', pid: process.pid, start: '1', host: 'another-host' }));
        throwsLike(() => acquireLock('w'), /別の PC/, '別の PC のロックを回収した');
        fs.unlinkSync(lf);
      });
      await ta('[A29] apply: 一時の領域に記録に無いものがあれば、動かさずに止まる', async () => {
        const s = mk('stray', { 'a.csv': csv(10) });
        const stray = path.join(workDir(), 'someone-else'); fs.mkdirSync(stray, { recursive: true }); fs.writeFileSync(path.join(stray, 'x'), 'x');
        try {
          await rejectsLike(() => run(s, planOk(s).id), /記録に無いもの/, '記録に無いものがあるのに進んだ');
          assert(fs.existsSync(path.join(stray, 'x')), '記録に無いものを動かした');
        } finally { fs.rmSync(stray, { recursive: true, force: true }); }
      });
      await ta('[A30] 状態の復元: 最初クラウドのみなら「空き容量を増やす」を指定する。元が記録と違えば（中身だけの違いも）何も変えない。指定が付かなければ成功にしない', async () => {
        const s = mk('restore', { 'a.csv': csv(10), 'c.csv': csv(10) });
        const recOf = async (f) => { const e = fileEntry(f); return { rel: path.basename(f), cloudOnly: true, fileId: e.fileId, size: e.size, mtimeMs: ticksToMs(e.mtime), initial: stableState(e), sha256: await fileSha(f) }; };
        const f = path.join(s, 'a.csv');
        const m = await recOf(f);
        assert((await restoreSource({ ...m, cloudOnly: false }, f)) === 'untouched', '最初からローカルのものに触れた');
        // OneDrive の外のファイルはクラウドのみにならないので、待つ時間を 0 にして「待ち」になることと、指定が付いたことを見る
        testHooks.restoreWaitMs = 0;
        try {
          assert((await restoreSource(m, f)) === 'waiting' && (fileEntry(f).attrs & A.UNPINNED), '「空き容量を増やす」が付かない');
          let calls = 0; testHooks.attrib = () => { calls++; return { code: 0 }; };
          try {
            await rejectsLike(() => restoreSource({ ...m, fileId: 'ffffffffffffffff' }, f), /記録と違う/, '記録と違う元を変えた');
            // 同じID・サイズ・更新日時のまま中身だけが違う
            const g = path.join(s, 'c.csv'); const mg = await recOf(g);
            testHooks.beforeRestore = () => { const fd = fs.openSync(g, 'r+'); fs.writeSync(fd, Buffer.from('Q'), 0, 1, 3); fs.closeSync(fd); fs.utimesSync(g, OLD_DATE, OLD_DATE); };
            await rejectsLike(() => restoreSource(mg, g), /中身が記録と違う/, '中身だけ違う元を変えた');
          } finally { testHooks.attrib = null; testHooks.beforeRestore = null; }
          assert(calls === 0, '記録と違うのに attrib を呼んだ');
          // attrib が成功を返しても、指定が実際に付いていなければ成功にしない
          const h = path.join(s, 'b.csv'); fs.writeFileSync(h, 'y'); fs.utimesSync(h, OLD_DATE, OLD_DATE);
          const mh = await recOf(h);
          testHooks.attrib = () => ({ code: 0 });
          try { await rejectsLike(() => restoreSource(mh, h), /指定が付かない/, '指定が付いていないのに成功にした'); } finally { testHooks.attrib = null; }
        } finally { testHooks.restoreWaitMs = undefined; }
      });
      await ta('[A32] apply: 読んだ後に、サイズ・更新日時・ファイルIDを変えずに中身だけ書き換わっても、書庫を採用しない', async () => {
        const s = mk('samesize', { 'a.csv': csv(1000) });
        const f = path.join(s, 'a.csv');
        const p = planOk(s);
        testHooks.afterHash = () => { const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('Z'), 0, 1, 10); fs.closeSync(fd); fs.utimesSync(f, OLD_DATE, OLD_DATE); };
        let r; try { r = await run(s, p.id); } finally { testHooks.afterHash = null; }
        assert(r.counts.failed === 1 && !fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '中身だけ書き換わった元の書庫を確定した: ' + JSON.stringify(r.counts));
      });
      await ta('[A33] apply: 一時フォルダの所有トークンが記録と合わなければ、動かさずに止まる', async () => {
        const s = mk('token', { 'a.csv': csv(500) });
        let fired = false;
        testHooks.afterSave = (state) => { if (state === 'writing' && !fired) { fired = true; throw new Crash('落ちた'); } };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterSave = null; }
        const d = fs.readdirSync(workDir()).map((n) => path.join(workDir(), n))[0];
        fs.writeFileSync(path.join(d, '.owner'), 'someone-else');
        try {
          await rejectsLike(() => run(s, planOk(s).id), /所有トークン/, '所有トークンが合わないのに動かした');
          assert(fs.existsSync(path.join(d, '.owner')), '所有トークンが合わない一時フォルダを動かした');
        } finally { fs.rmSync(d, { recursive: true, force: true }); }
      });
      await ta('[A34] apply: 空きが足りず期限を過ぎたら、その時点で止まり、残りに進まない', async () => {
        const s = mk('nospace', { 'a.csv': csv(100), 'b.csv': csv(200) });
        const p = planOk(s);
        Object.assign(testHooks, { freeBytes: () => 0, waitMs: 0, pollMs: 1 });
        let r; try { r = await run(s, p.id); } finally { Object.assign(testHooks, { freeBytes: null, waitMs: undefined, pollMs: undefined }); }
        assert(r.counts.failed === 1 && r.counts.ok === 0, '空きが足りないのに残りに進んだ: ' + JSON.stringify(r.counts));
      });
      t('[A31] 記録: 壊れていれば前の世代から戻す。両方とも読めなければ止まる', () => {
        const s = mk('man', { 'a.csv': 'x' });
        const d = s + '_7z';
        const m = loadManifest(s, d); m.items.k = { state: 'restored' }; saveManifest(m); m.items.k2 = { state: 'restored' }; saveManifest(m);
        const f = manifestPath(s, d);
        fs.writeFileSync(f, '{broken');
        const back = loadManifest(s, d);
        assert(back.recoveredFrom === 'prev' && back.items.k && !back.items.k2, '前の世代から戻さない');
        fs.writeFileSync(f + '.prev', '{broken');
        throwsLike(() => loadManifest(s, d), /前の世代も読めない/, '両方壊れているのに進んだ');
      });
      await ta('[A35] apply: 確定した後に後の作業が失敗しても「失敗」にせず状態を保ち、次の実行でやり直して終わる', async () => {
        const s = mk('aftercommit', { 'a.csv': csv(500) });
        testHooks.afterCommit = () => { throw new ItemError('後の作業が止まった'); };
        let r; try { r = await run(s, planOk(s).id); } finally { testHooks.afterCommit = null; }
        const m = Object.values(r.manifest.items)[0];
        assert(r.counts.pending === 1 && r.counts.failed === 0 && m.state === 'committed', '確定後の失敗で状態を潰した: ' + JSON.stringify(r.counts) + ' ' + m.state);
        const r2 = await run(s, planOk(s).id);
        assert(r2.counts.ok === 1 && r2.counts.failed === 0 && Object.values(r2.manifest.items)[0].state === 'restored', 'やり直しで終わらない: ' + JSON.stringify(r2.counts));
      });
      await ta('[A36] apply: 宛先にリンクを作った直後（確定の記録の前）に落ちても、やり直すと中身を照合し直して終わる', async () => {
        const s = mk('afterlink', { 'a.csv': csv(800) });
        const want = sha(path.join(s, 'a.csv'));
        testHooks.afterLink = () => { throw new Crash('落ちた'); };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterLink = null; }
        const r = await run(s, planOk(s).id);
        assert(r.counts.ok === 1 && (await extractedSha(sz7, path.join(s + '_7z', 'a.csv.7z'))) === want, 'やり直しで正しく終わらない: ' + JSON.stringify(r.counts));
        assert(fs.readdirSync(workDir()).length === 0, '一時の領域が空でない');
      });
      await ta('[A37] apply: リンクを作った後に落ち、その間に宛先の書庫が書き換えられたら、再開しても確定しない', async () => {
        const s = mk('linkmut', { 'a.csv': csv(800) });
        testHooks.afterLink = () => { throw new Crash('落ちた'); };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterLink = null; }
        const fin = path.join(s + '_7z', 'a.csv.7z');
        const b = fs.readFileSync(fin); const fd = fs.openSync(fin, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd);
        const r = await run(s, planOk(s).id);
        const m = Object.values(r.manifest.items)[0];
        assert(r.counts.failed === 1 && m.state === 'failed' && /記録した書庫と違う|SHA-256|CRC|7z t/.test(m.reason), '書き換えられた書庫を確定した: ' + JSON.stringify(r.counts) + ' ' + m.state + ' ' + m.reason);
      });
      t('[A40] 記録: 前の世代から戻した直後に保存しても、正常な前の世代を壊さない', () => {
        const s = mk('man2', { 'a.csv': 'x' });
        const d = s + '_7z';
        const m = loadManifest(s, d); m.items.k = { state: 'restored' }; saveManifest(m); m.items.k2 = { state: 'restored' }; saveManifest(m);
        const f = manifestPath(s, d);
        fs.writeFileSync(f, '{broken');
        const back = loadManifest(s, d);
        back.items.k3 = { state: 'restored' };
        saveManifest(back);
        const prev = JSON.parse(fs.readFileSync(f + '.prev', 'utf8'));
        assert(prev.items.k && !prev.items.k2, '前の世代が壊れた・変わった');
        assert(JSON.parse(fs.readFileSync(f, 'utf8')).items.k3, '新しい今の世代を書いていない');
        assert(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith(path.basename(f) + '.broken-')), '壊れた今の世代を退けていない');
      });
      await ta('[A41] apply: 管理用のフォルダが OneDrive の同期ルートの中なら止まる', async () => {
        const s = mk('mgmt-od', { 'a.csv': csv(10) });
        const p = planOk(s);
        const root = archiveDir();
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: root }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: root }, { type: 'end', count: 2 }];
          if (req.mode === 'syncroot') return [{ type: 'header' }, { type: 'syncroot', hr: isWithin(req.path, root) ? 0 : HR_NOT_UNDER_SYNC_ROOT }, { type: 'end', count: 1 }];
          return real(req);
        };
        try { await rejectsLike(() => run(s, p.id), /同期ルートの中にある/, 'OneDrive の中の管理用のフォルダで進んだ'); } finally { testHooks.winStub = null; }
      });
      await ta('[A42] apply: 隔離すると上限を超えるなら、移す前に止まる', async () => {
        const s = mk('qlimit', { 'a.csv': csv(500) });
        let fired = false;
        testHooks.afterSave = (state) => { if (state === 'writing' && !fired) { fired = true; throw new Crash('落ちた'); } };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterSave = null; }
        const d = fs.readdirSync(workDir()).map((n) => path.join(workDir(), n))[0];
        // 上限は「今の隔離の量 + 1」。移す量を足して判定していれば止まり、今の量だけで判定していれば通ってしまう
        testHooks.quarantineLimit = dirBytes(path.join(archiveDir(), 'quarantine')) + 1;
        try {
          await rejectsLike(() => run(s, planOk(s).id), /上限を超える/, '上限を超えるのに隔離した');
          assert(fs.existsSync(d), '止まったのに一時フォルダを動かした');
        } finally { testHooks.quarantineLimit = undefined; fs.rmSync(d, { recursive: true, force: true }); }
      });
      t('[A43] 隔離の途中で落ちた場合の4通り（移動元だけ＝やり直す・移動先だけ＝済み・両方／どちらも無い＝止める）', () => {
        const q = path.join(base, 'q43'); fs.mkdirSync(q, { recursive: true });
        const mkTmp = (n) => { const d = path.join(base, 'w43-' + n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.owner'), 'tok'); return d; };
        const saves = []; const save = (p) => saves.push(p.state);
        const a = mkTmp('a'); assert(quarantineStep({ state: 'quarantining', tmpDir: a, token: 'tok', quarantineTo: path.join(q, 'w43-a') }, q, save) === 'moved' && fs.existsSync(path.join(q, 'w43-a')), '移動元だけのときにやり直さない');
        const bTo = path.join(q, 'w43-b'); fs.mkdirSync(bTo);
        assert(quarantineStep({ state: 'quarantining', tmpDir: path.join(base, 'w43-b'), token: 'tok', quarantineTo: bTo }, q, save) === 'done', '移動先だけのときに済みにしない');
        const c = mkTmp('c'); const cTo = path.join(q, 'w43-c'); fs.mkdirSync(cTo);
        throwsLike(() => quarantineStep({ state: 'quarantining', tmpDir: c, token: 'tok', quarantineTo: cTo }, q, save), /両方にある/, '両方にあるのに進んだ');
        throwsLike(() => quarantineStep({ state: 'quarantining', tmpDir: path.join(base, 'w43-none'), token: 'tok', quarantineTo: path.join(q, 'w43-none') }, q, save), /移動元にも移動先にも無い/, 'どちらにも無いのに進んだ');
      });
      const childScript = path.join(base, 'child.mjs');
      fs.writeFileSync(childScript, [
        "import fs from 'node:fs';",
        "import { pathToFileURL } from 'node:url';",
        "const [mod, mode, a, b] = process.argv.slice(2);",
        "const m = await import(pathToFileURL(mod).href);",
        "const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
        "if (mode === 'lock') {",
        "  m.testHooks.beforeLock = () => { fs.writeFileSync(b + '.ready', '1'); const t0 = Date.now(); while (!fs.existsSync(a) && Date.now() - t0 < 60000) sleep(20); };",
        "  try { const rel = m.acquireLock('child'); fs.writeFileSync(b, 'got'); sleep(3000); rel(); } catch (e) { fs.writeFileSync(b, 'refused: ' + e.message); }",
        "} else if (mode === 'die') {",
        "  m.testHooks.afterSave = (st) => { if (st === 'archived') process.exit(9); };",
        "  const p = m.plan({ source: a, olderThanDays: 0 });",
        "  await m.apply({ source: a, expect: p.id, olderThanDays: 0, log: () => {} });",
        "}",
      ].join('\n'));
      const childEnv = { ...process.env, UT_ARCHIVE_DIR: archiveDir() };
      const runChild = (args) => new Promise((res) => { const c = spawnChild(process.execPath, [childScript, SELF, ...args], { env: childEnv, stdio: 'ignore', windowsHide: true }); c.on('close', (code) => res(code)); });
      await ta('[A44] ロック: 2つのプロセスが同時に取りに行くと、片方だけが取れる', async () => {
        const go = path.join(base, 'lock-go'); const o1 = path.join(base, 'lock-o1'); const o2 = path.join(base, 'lock-o2');
        const p1 = runChild(['lock', go, o1]); const p2 = runChild(['lock', go, o2]);
        const t0 = Date.now(); while (!(fs.existsSync(o1 + '.ready') && fs.existsSync(o2 + '.ready')) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(go, '1');
        await Promise.all([p1, p2]);
        const outs = [fs.readFileSync(o1, 'utf8'), fs.readFileSync(o2, 'utf8')];
        assert(outs.filter((x) => x === 'got').length === 1 && outs.some((x) => /実行中/.test(x)), '両方が取った・どちらも取れなかった: ' + outs.join(' / '));
      });
      await ta('[A45] apply: プロセスが途中で終了して古いロックが残っても、次の実行が回収して続きから終わる', async () => {
        const s = mk('die', { 'a.csv': csv(800) });
        const want = sha(path.join(s, 'a.csv'));
        const code = await runChild(['die', s]);
        assert(code === 9, 'プロセスが途中で終わらなかった: exit ' + code);
        assert(fs.existsSync(path.join(archiveDir(), 'ut-archive.lock')), 'ロックが残っていない（試験の前提が成り立たない）');
        const r = await run(s, planOk(s).id);
        assert(r.counts.ok === 1 && (await extractedSha(sz7, path.join(s + '_7z', 'a.csv.7z'))) === want, '続きから終わらない: ' + JSON.stringify(r.counts));
        assert(!fs.existsSync(path.join(archiveDir(), 'ut-archive.lock')), '終わったのにロックが残った');
      });
      await ta('[A46] apply: 書き込み中に空きが予備を割ったら、7z を止めて中断し、書庫を採用しない', async () => {
        // 7z が数秒は書き続ける大きさにする（小さいと、止める前に 7z が書き終えてしまい、止める仕組みを試せない）
        const s = mk('spacedrop', { 'a.csv': csv(3000000), 'b.csv': csv(100) });
        const p = planOk(s);
        let writing = false;
        // 空きの不足は、大きい a.csv を書いている間だけにする（小さい順に処理するので、先に処理する b.csv で起こすと、
        // 7z が止まる前に書き終えてしまい、止める仕組みを試せない）
        Object.assign(testHooks, { afterHash: (f) => { if (f.endsWith('a.csv')) writing = true; }, freeBytes: () => (writing ? 0 : 1e15), monitorMs: 5 });
        let r; try { r = await run(s, p.id); } finally { Object.assign(testHooks, { afterHash: null, freeBytes: null, monitorMs: undefined }); }
        const m = Object.values(r.manifest.items).find((x) => x.state === 'failed');
        assert(r.counts.failed === 1 && m && /書き込み中に空き容量/.test(m.reason), '書き込み中の空きの不足で止まらない: ' + JSON.stringify(r.counts) + ' ' + (m && m.reason));
        assert(!/止まる前に終わっていた/.test(m.reason), '7z を止めずに書き終えさせた（プロセスを止める仕組みが効いていない）');
        assert(!fs.existsSync(path.join(s + '_7z', 'a.csv.7z')) && fs.readdirSync(workDir()).length === 0, '中断したのに書庫や一時フォルダが残った');
      });
      await ta('[A47] apply: 確定済みから再開するとき、宛先の書庫が書き換えられていれば、元の後の作業に進まない（状態は確定済みのまま）', async () => {
        const s = mk('commitmut', { 'a.csv': csv(800) });
        let fired = false;
        testHooks.afterSave = (state) => { if (state === 'committed' && !fired) { fired = true; throw new Crash('落ちた'); } };
        try { await rejectsLike(() => run(s, planOk(s).id), /落ちた/, '落ちなかった'); } finally { testHooks.afterSave = null; }
        const fin = path.join(s + '_7z', 'a.csv.7z');
        const b = fs.readFileSync(fin); const fd = fs.openSync(fin, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd);
        const r = await run(s, planOk(s).id);
        const m = Object.values(r.manifest.items)[0];
        assert(r.counts.pending === 1 && m.state === 'committed' && /記録した書庫と違う/.test(m.lastError || ''), '書き換えられた確定済みの書庫のまま進んだ: ' + JSON.stringify(r.counts) + ' ' + m.state + ' ' + m.lastError);
        // 止まったまま残る一時フォルダは、後の試験の「記録に無いもの」にならないよう片付ける
        if (m.tmpDir) fs.rmSync(m.tmpDir, { recursive: true, force: true });
      });
      await ta('[A48] apply: 空きを待っている間に元が変わったら、待った後に測った状態で止まる（待つ前の古い状態を記録しない）', async () => {
        const s = mk('waitmut', { 'a.csv': csv(500) });
        const f = path.join(s, 'a.csv');
        const p = planOk(s);
        // 空きを待つ処理（waitFree）の中の最初の確認だけ足りないことにし、その間に元を書き換える
        // （回数で数えると、apply の冒頭で計画を作り直すときの確認に当たり、待っている間を通らない。実際にそうなって変異を見逃した）
        let fired = false;
        Object.assign(testHooks, { freeBytes: () => { if (!fired && new Error().stack.includes('waitFree')) { fired = true; fs.appendFileSync(f, '\nmore'); fs.utimesSync(f, OLD_DATE, new Date(Date.UTC(2022, 0, 3))); return 0; } return 1e15; }, pollMs: 1 });
        let r; try { r = await run(s, p.id); } finally { Object.assign(testHooks, { freeBytes: null, pollMs: undefined }); }
        assert(fired, '空きを待つ処理を通っていない（試験が狙った経路を通っていない）');
        const m = Object.values(r.manifest.items)[0];
        assert(r.counts.failed === 1 && /計画の後に元が変わった/.test(m.reason || ''), '待った後の状態で止まらない: ' + JSON.stringify(r.counts) + ' ' + m.reason);
      });
      await ta('[A49] 状態の復元: クラウドのみになっていても、記録と別のファイル（更新日時・同期済みが違う）なら「戻した」としない', async () => {
        const s = mk('restore2', { 'a.csv': csv(10) });
        const f = path.join(s, 'a.csv');
        const e = fileEntry(f);
        const m = { rel: 'a.csv', cloudOnly: true, fileId: e.fileId, size: e.size, mtimeMs: ticksToMs(e.mtime), initial: { ...stableState(e), placeholder: true, inSync: true }, sha256: await fileSha(f) };
        // 補助スクリプトの files だけを差し替え、クラウドのみ（PARTIAL・割当 0）に見せる
        const asCloud = (o) => (req, real) => (req.mode === 'files' ? real(req).map((x) => (x.type === 'entry' ? { ...x, ph: 0x39, alloc: 0, attrs: 0x401620, tag: 0x9000401a, ...o } : x)) : real(req));
        try {
          testHooks.winStub = asCloud({ mtime: String(BigInt(e.mtime) + 10000000n) });
          await rejectsLike(() => restoreSource(m, f), /別のファイルに見える/, '更新日時の違うファイルを「戻した」とした');
          testHooks.winStub = asCloud({ ph: 0x31 });
          await rejectsLike(() => restoreSource(m, f), /別のファイルに見える/, '同期済みでないファイルを「戻した」とした');
          testHooks.winStub = asCloud({});
          assert((await restoreSource(m, f)) === 'released', '記録と同じクラウドのみのファイルを「戻した」としない');
          // ローカルの元に attrib をかけた後で、別のファイル（更新日時が違う）がクラウドのみとして見えたら「戻した」としない
          let attribDone = false;
          testHooks.attrib = () => { attribDone = true; return { code: 0 }; };
          const asCloudAfter = asCloud({ attrs: 0x501620, mtime: String(BigInt(e.mtime) + 10000000n) });
          testHooks.winStub = (req, real) => (attribDone ? asCloudAfter(req, real) : real(req));
          // 記録は実ファイル（ローカル）の状態にする（入口の照合を通して attrib まで進ませる）
          await rejectsLike(() => restoreSource({ ...m, initial: stableState(e) }, f), /戻した後の元が、記録と別のファイル/, 'attrib の後に別のファイルを「戻した」とした');
          assert(attribDone, 'attrib まで進んでいない（試験が狙った経路を通っていない）');
        } finally { testHooks.winStub = null; testHooks.attrib = null; }
      });
      await ta('[A50] apply: 管理用のフォルダが OneDrive の中なら、ロックも作業用のフォルダも作らずに止まる', async () => {
        const s = mk('mgmt-od2', { 'a.csv': csv(10) });
        const p = planOk(s);
        const saved = process.env.UT_ARCHIVE_DIR;
        const odDir = path.join(base, 'od-mgmt'); // まだ無いフォルダ（いちばん近い既存の親で判定する）
        process.env.UT_ARCHIVE_DIR = odDir;
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: base }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: base }, { type: 'end', count: 2 }];
          if (req.mode === 'syncroot') return [{ type: 'header' }, { type: 'syncroot', hr: isWithin(req.path, base) ? 0 : HR_NOT_UNDER_SYNC_ROOT }, { type: 'end', count: 1 }];
          return real(req);
        };
        try {
          await rejectsLike(() => apply({ source: s, expect: p.id, olderThanDays: 0, log: quiet }), /同期ルートの中にある/, 'OneDrive の中の管理用のフォルダで進んだ');
          assert(!fs.existsSync(odDir), '止まる前に管理用のフォルダに書いた');
        } finally { testHooks.winStub = null; process.env.UT_ARCHIVE_DIR = saved; }
      });
      t('[A51] 後始末: 一時フォルダに所有の印が無いとき、中身があれば消さずに止まり、空なら片付ける', () => {
        const d = path.join(base, 'w51'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.7z'), 'x');
        throwsLike(() => cleanupTmp({ tmpDir: d, token: 'tok' }, () => {}), /所有の印が無い/, '所有の印が無いのに消した');
        assert(fs.existsSync(path.join(d, 'a.7z')), '所有の印が無いのに書庫を消した');
        // 所有の印を消した直後に落ちた形（空のフォルダだけが残る）は、やり直すと片付く
        const e = path.join(base, 'w52'); fs.mkdirSync(e);
        let saved = null; cleanupTmp({ tmpDir: e, token: 'tok' }, (p) => { saved = p; });
        assert(!fs.existsSync(e) && saved && saved.tmpDir === null, '空の一時フォルダを片付けられない（やり直せない）');
      });
      await ta('[A52] apply: 7z の書き込み中に中断（Ctrl+C）を受けたら、7z を止めて巻き戻し、書庫を確定しない。2 回目でも受け手は外れない。やり直すと正しく終わる', async () => {
        const s = mk('sigint', { 'a.csv': csv(3000000) });
        const p = planOk(s);
        const listeners0 = process.listenerCount('SIGINT');
        let writing = false, sent = false, listenersAfter = -1;
        const pids = [];
        Object.assign(testHooks, {
          afterHash: () => { writing = true; },
          // 書き込み中の空きの監視（7z が動いている間）の最初の呼び出しで、Ctrl+C を 2 回送る
          freeBytes: () => { if (writing && !sent) { sent = true; process.emit('SIGINT'); process.emit('SIGINT'); listenersAfter = process.listenerCount('SIGINT'); } return 1e15; },
          killTree: (child) => { pids.push(child.pid); spawnSync(system32('taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 30000 }); },
          monitorMs: 5,
        });
        try { await rejectsLike(() => run(s, p.id), /中断した/, '中断を受けたのに終わらなかった'); } finally { Object.assign(testHooks, { afterHash: null, freeBytes: null, killTree: null, monitorMs: undefined }); }
        assert(sent, '7z が動いている間に中断を送れていない（試験が狙った経路を通っていない）');
        assert(pids.length > 0, '中断を受けても、書き込み中の 7z を止めなかった');
        assert(listenersAfter === listeners0 + 1, '2 回目の Ctrl+C の後に受け手が外れた（既定の即終了に戻る）');
        assert(process.listenerCount('SIGINT') === listeners0, '終わった後も受け手が残った');
        for (const pid of new Set(pids)) { let alive = true; try { process.kill(pid, 0); } catch { alive = false; } assert(!alive, '7z が止まらずに残った: ' + pid); }
        const m = Object.values(loadManifest(p.source, p.dest).items)[0];
        assert(m && m.state === 'writing' && !fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '中断したのに先へ進んだ: ' + (m && m.state));
        const r = await run(s, planOk(s).id);
        assert(r.counts.ok === 1 && fs.readdirSync(workDir()).length === 0, 'やり直しで正しく終わらない: ' + JSON.stringify(r.counts));
      });
      await ta('[A53] apply: 7z が書き終えた後（検証の前）に中断を受けたら、検証・確定へ進まない', async () => {
        const s = mk('sigint2', { 'a.csv': csv(500) });
        const p = planOk(s);
        testHooks.afterArchive = () => process.emit('SIGINT');
        try { await rejectsLike(() => run(s, p.id), /中断した/, '中断を受けたのに終わらなかった'); } finally { testHooks.afterArchive = null; }
        const m = Object.values(loadManifest(p.source, p.dest).items)[0];
        assert(m && m.state === 'archived' && !fs.existsSync(path.join(s + '_7z', 'a.csv.7z')), '中断したのに検証・確定へ進んだ: ' + (m && m.state));
        const r = await run(s, planOk(s).id);
        assert(r.counts.ok === 1 && fs.readdirSync(workDir()).length === 0, 'やり直しで正しく終わらない: ' + JSON.stringify(r.counts));
      });
      await ta('[A54] apply: 確定の直後に中断を受けたら、後始末・戻しの記録へ進まない（確定済みのまま。やり直すと正しく終わる）', async () => {
        const s = mk('sigint3', { 'a.csv': csv(500) });
        const p = planOk(s);
        testHooks.afterCommit = () => process.emit('SIGINT');
        try { await rejectsLike(() => run(s, p.id), /中断した/, '中断を受けたのに終わらなかった'); } finally { testHooks.afterCommit = null; }
        const m = Object.values(loadManifest(p.source, p.dest).items)[0];
        assert(m && m.state === 'committed' && m.tmpDir, '中断したのに後始末・戻しの記録へ進んだ: ' + (m && m.state));
        const r = await run(s, planOk(s).id);
        assert(r.counts.ok === 1 && fs.readdirSync(workDir()).length === 0, 'やり直しで正しく終わらない: ' + JSON.stringify(r.counts));
      });
      await ta('[A55] 状態の復元: 中断を受けたら、元の照合の後でも、戻るのを待っている間でも、先へ進まない', async () => {
        const s = mk('sigint4', { 'a.csv': csv(10) });
        const f = path.join(s, 'a.csv');
        const e = fileEntry(f);
        const m = { rel: 'a.csv', cloudOnly: true, fileId: e.fileId, size: e.size, mtimeMs: ticksToMs(e.mtime), initial: stableState(e), sha256: await fileSha(f) };
        let attribCalls = 0;
        try {
          // 元の中身を照合している間に中断を受けた: attrib を呼ばない
          testHooks.attrib = () => { attribCalls++; return { code: 0 }; };
          testHooks.beforeRestore = () => interruptForTest(true);
          await rejectsLike(() => restoreSource(m, f), /中断した/, '照合の後に中断を見ずに進んだ');
          assert(attribCalls === 0, '中断を受けたのに attrib を呼んだ');
          interruptForTest(false); testHooks.beforeRestore = null;
          // attrib の後、戻るのを待っている間に中断を受けた: 「待ち」や「戻した」で終えずに止まる
          let attribDone = false;
          testHooks.attrib = () => { attribDone = true; interruptForTest(true); return { code: 0 }; };
          testHooks.winStub = (req, real) => (attribDone && req.mode === 'files' ? real(req).map((x) => (x.type === 'entry' ? { ...x, attrs: x.attrs | A.UNPINNED } : x)) : real(req));
          testHooks.restoreWaitMs = 0;
          await rejectsLike(() => restoreSource(m, f), /中断した/, '戻るのを待っている間の中断を見ずに終えた');
          assert(attribDone, 'attrib まで進んでいない（試験が狙った経路を通っていない）');
        } finally { interruptForTest(false); Object.assign(testHooks, { attrib: null, beforeRestore: null, winStub: null, restoreWaitMs: undefined }); }
      });
      // main を通す試験は、画面への出力を捨てて終了コードだけを見る
      const mainQuiet = async (args) => { const o = console.log; console.log = () => {}; try { return await main(args); } finally { console.log = o; } };
      await ta('[A56] status: 記録を読むだけで、済み・失敗を数える。記録が空、または済んでいないものがあれば完了としない（終了コード 2）', async () => {
        const s = mk('st1', { 'a.csv': csv(50), 'b.csv': csv(60) });
        const empty = status({ source: s });
        assert(empty.total === 0 && !empty.complete, '記録が空なのに完了とした');
        // b.csv だけ、読んだ後に書き換えて失敗させる
        testHooks.afterHash = (f) => { if (f.endsWith('b.csv')) fs.appendFileSync(f, 'X'); };
        try { await run(s, planOk(s).id); } finally { testHooks.afterHash = null; }
        const st = status({ source: s });
        assert(st.total === 2 && st.groups.get('済み') === 1 && st.groups.get('失敗') === 1 && !st.complete, '数え方が違う: ' + JSON.stringify([...st.groups]));
        assert(st.reasons.size === 1, '失敗の理由を数えていない');
        assert((await mainQuiet(['status', '--source', s, '--json'])) === 2, '済んでいないものがあるのに終了コードが 2 でない');
        const s2 = mk('st2', { 'a.csv': csv(50) });
        await run(s2, planOk(s2).id);
        assert(status({ source: s2 }).complete && (await mainQuiet(['status', '--source', s2, '--json'])) === 0, 'すべて済んだのに完了としない');
        // 中止の記録が混ざれば完了としない
        const mf = loadManifest(s2, s2 + '_7z');
        mf.items['x.csv'] = { rel: 'x.csv', state: 'abandoned' }; saveManifest(mf);
        assert(!status({ source: s2 }).complete, '中止を完了とした');
        // 元が消えても（移動されても）、記録は表示する
        fs.renameSync(s2, s2 + '-moved');
        const gone = status({ source: s2 });
        assert(!gone.found && gone.total === 2, '元が見つからないと記録を表示しない');
      });
      await ta('[A57] verify-current: 済みの書庫を読み直して完了と判定する。保存先の余計なファイル・消えた書庫・記録の無い状態を完了としない', async () => {
        const s = mk('vc1', { 'a.csv': csv(300), 'sub\\b.csv': csv(200) });
        await rejectsLike(() => verifyCurrent({ source: s, log: quiet }), /処理の記録が無い/, '記録が無いのに判定した');
        await run(s, planOk(s).id);
        let v = await verifyCurrent({ source: s, log: quiet });
        assert(v.complete && v.done === 2 && v.synced === 2 && v.problems.length === 0, '完了しているのに完了としない: ' + JSON.stringify([...v.kinds]));
        // 同期の衝突でできたような別名のファイル
        const extra = path.join(s + '_7z', 'a.csv-PC.7z');
        fs.writeFileSync(extra, 'x');
        v = await verifyCurrent({ source: s, log: quiet });
        assert(!v.complete && [...v.kinds.keys()].some((k) => /書庫以外のファイル/.test(k)), '保存先の余計なファイルを見逃した');
        fs.unlinkSync(extra);
        // 書庫の置き場所でない（空の）フォルダ
        const extraDir = path.join(s + '_7z', 'stray');
        fs.mkdirSync(extraDir);
        v = await verifyCurrent({ source: s, log: quiet });
        assert(!v.complete && [...v.kinds.keys()].some((k) => /置き場所でないフォルダ/.test(k)), '保存先の余計なフォルダを見逃した');
        fs.rmdirSync(extraDir);
        assert((await verifyCurrent({ source: s, log: quiet })).complete, '書庫の置き場所のフォルダ（sub）まで余計なものとした');
        // 書庫が消えた（別の場所へ移された）
        fs.renameSync(path.join(s + '_7z', 'sub', 'b.csv.7z'), path.join(base, 'vc1-moved.7z'));
        v = await verifyCurrent({ source: s, log: quiet });
        assert(!v.complete && v.done === 1 && [...v.kinds.keys()].some((k) => /記録上は済みだが/.test(k)), '消えた書庫を見逃した: ' + JSON.stringify([...v.kinds]));
        assert((await mainQuiet(['verify-current', '--source', s, '--json'])) === 2, '完了していないのに終了コードが 2 でない');
      });
      await ta('[A58] verify-current --rehash-archives: 書庫を展開して照合する。ファイルID・サイズを変えずに中身だけ書き換えられた書庫を見つける', async () => {
        const s = mk('vc2', { 'a.csv': csv(3000) });
        await run(s, planOk(s).id);
        // 書庫の状態を変えうる（取得・クラウドのみへ戻す）ので、ほかの実行と同時に動かない（ロックを取る）
        const held = acquireLock('test');
        try { await rejectsLike(() => verifyCurrent({ source: s, rehash: true, log: quiet }), /実行中/, 'ロックを取らずに書庫を読み直した'); } finally { held(); }
        let v = await verifyCurrent({ source: s, rehash: true, log: quiet });
        assert(v.complete && v.rehashed === 1, '照合できる書庫を照合しない: ' + JSON.stringify([...v.kinds]));
        const fin = path.join(s + '_7z', 'a.csv.7z');
        const b = fs.readFileSync(fin); const fd = fs.openSync(fin, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd);
        v = await verifyCurrent({ source: s, rehash: true, log: quiet });
        assert(!v.complete && v.rehashed === 0 && [...v.kinds.keys()].some((k) => /SHA-256 が記録と違う/.test(k)), '中身の書き換えを見逃した: ' + JSON.stringify([...v.kinds]));
        // 展開しない確認では、ファイルID・サイズが同じ書き換えは見えない（--rehash-archives が要る理由）
        v = await verifyCurrent({ source: s, log: quiet });
        assert(v.complete, '展開しない確認の範囲が想定と違う');
      });
      t('[A59] 同期済みの判定: プレースホルダー・同期済み・一部だけ取得でない・ファイルID とサイズの 4 つがそろうときだけ', () => {
        const arc = { fileId: 'f1', size: 100 };
        const e = (o) => ({ kind: 'file', fileId: 'f1', size: 100, ph: 0x39, alloc: 0, attrs: 0x401620, ...o });
        assert(notSynced(e({}), arc) === null, 'クラウドのみ・同期済みを同期済みとしない');
        assert(notSynced(e({ ph: 0x9, alloc: 100 }), arc) === null, 'ローカル・同期済みを同期済みとしない');
        assert(/プレースホルダーでない/.test(notSynced(e({ ph: PH_INVALID }), arc) || ''), 'プレースホルダーでないものを同期済みとした');
        assert(/同期中/.test(notSynced(e({ ph: 0x1, alloc: 100 }), arc) || ''), '同期済みでないものを同期済みとした');
        assert(/一部だけ/.test(notSynced(e({ alloc: 50 }), arc) || ''), '一部だけ取得を同期済みとした');
        assert(/ファイルID/.test(notSynced(e({ fileId: 'f2' }), arc) || '') && /ファイルID/.test(notSynced(e({ size: 99 }), arc) || ''), 'ID・サイズの違いを同期済みとした');
        assert(/無い/.test(notSynced(null, arc) || ''), '無い書庫を同期済みとした');
      });
      await ta('[A60] apply: 空きの不足で打ち切ったら、残りを「未処理」として数え、対象 = OK ＋ 失敗 ＋ 戻し待ち ＋ 未処理 が成り立つ。終了コードは 2', async () => {
        const s = mk('cnt', { 'a.csv': csv(10), 'b.csv': csv(20) });
        Object.assign(testHooks, { freeBytes: () => (new Error().stack.includes('waitFree') ? 0 : 1e15), waitMs: 0, pollMs: 1 });
        let r; let code;
        try {
          r = await run(s, planOk(s).id);
          code = await mainQuiet(['apply', '--source', s, '--older-than', '0', '--expect', planOk(s).id]);
        } finally { Object.assign(testHooks, { freeBytes: null, waitMs: undefined, pollMs: undefined }); }
        const c = r.counts;
        assert(c.targets === 2 && c.failed === 1 && c.notRun === 1 && c.ok + c.failed + c.pending + c.notRun === c.targets, '件数が合わない: ' + JSON.stringify(c));
        assert(code === 2, '打ち切ったのに終了コードが 2 でない: ' + code);
      });
      await ta('[A61] apply: 失敗が無くても、確定した後の作業が止まったもの（戻し待ち・要対応）があれば、終了コードは 2。status にも出る', async () => {
        const s = mk('pend', { 'a.csv': csv(40) });
        let fired = false;
        testHooks.afterCommit = () => { if (!fired) { fired = true; throw new ItemError('後の作業が止まった（試験）'); } };
        let code; try { code = await mainQuiet(['apply', '--source', s, '--older-than', '0', '--expect', planOk(s).id]); } finally { testHooks.afterCommit = null; }
        assert(fired, '確定の後まで進んでいない（試験が狙った経路を通っていない）');
        assert(code === 2, '戻し待ちがあるのに終了コードが 2 でない: ' + code);
        const st = status({ source: s });
        assert(st.groups.get('書庫は確定・後の作業が止まった') === 1 && !st.complete, 'status に戻し待ちが出ない: ' + JSON.stringify([...st.groups]));
        // 止まったまま残る一時フォルダは、後の試験の「記録に無いもの」にならないよう片付ける
        const m = Object.values(loadManifest(s, s + '_7z').items)[0];
        if (m.tmpDir) fs.rmSync(m.tmpDir, { recursive: true, force: true });
      });
      // OneDrive の模擬: root の下を同期ルートとし、ファイルは「ローカル・同期済みのプレースホルダー」に、cloud に入れたパスは
      // 「クラウドのみ（PARTIAL・割当 0・空き容量を増やす指定）」に見せる。属性の変わってよい部分だけを変え、不変の部分は本物のまま
      // pending に入れたパスは「プレースホルダーだが同期済みでない」（アップロード待ち）に見せる
      // 一度クラウドのみだったファイルは、読んで取得された後も「空き容量を増やす」の指定（UNPINNED）が残る（実物の OneDrive と同じ）
      const fakeOneDrive = (root, cloud, pending = new Set(), unpinned = new Set()) => (req, real) => {
        if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: root }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: root }, { type: 'end', count: 2 }];
        if (req.mode === 'syncroot') return [{ type: 'header' }, { type: 'syncroot', hr: isWithin(req.path, root) ? 0 : HR_NOT_UNDER_SYNC_ROOT }, { type: 'end', count: 1 }];
        if (req.mode !== 'scan' && req.mode !== 'files') return real(req);
        return real(req).map((x) => {
          if (x.type !== 'entry' || x.kind !== 'file') return x;
          const abs = req.mode === 'scan' ? path.join(req.root, x.rel) : x.rel;
          if (!isWithin(abs, root)) return x;
          if (cloud.has(normKey(abs))) { unpinned.add(normKey(abs)); return { ...x, ph: 0x39, alloc: 0, attrs: x.attrs | A.RECALL_ON_DATA_ACCESS | A.OFFLINE | 0x200 | A.UNPINNED }; }
          const pin = unpinned.has(normKey(abs)) ? A.UNPINNED : 0;
          if (pending.has(normKey(abs))) return { ...x, ph: 0x1, attrs: x.attrs | pin };
          return { ...x, ph: 0x9, attrs: x.attrs | pin };
        });
      };
      await ta('[A62] verify-current --rehash-archives（OneDrive の模擬）: クラウドのみの書庫は、読む前に「取得した」と記録し、照合に失敗しても記録を残す。照合が通れば、クラウドのみへ戻して記録を消す', async () => {
        const root = path.join(base, 'od'); const s = path.join(root, 'r1');
        fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'a.csv'), csv(3000)); fs.utimesSync(path.join(s, 'a.csv'), OLD_DATE, OLD_DATE);
        const cloud = new Set();
        testHooks.winStub = fakeOneDrive(root, cloud);
        testHooks.attrib = (args) => { cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          assert(p.valid, '模擬の OneDrive で計画が無効: ' + p.blockers.join(' / '));
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          // 書庫は同期済み（模擬）なので、apply がこの場で解放している
          const m0 = loadManifest(s, s + '_7z').items[normKey('a.csv')];
          assert(m0.archiveSync && m0.archiveSync.state === 'synced' && m0.archiveRelease && m0.archiveRelease.state === 'released', 'apply が同期済みの書庫を解放しない: ' + JSON.stringify([m0.archiveSync, m0.archiveRelease]));
          // 読むと取得される（模擬ではクラウドのみの一覧から外す）
          testHooks.onRefetch = (abs) => cloud.delete(normKey(abs));
          let v = await verifyCurrent({ source: s, log: quiet });
          assert(v.complete && v.destSyncRoot && v.synced === 1, '同期済みの書庫で完了としない: ' + JSON.stringify([...v.kinds]));
          // 書庫がアップロード後に解放された（クラウドのみ）。その中身を、ID・サイズを変えずに書き換える
          const arc = path.join(s + '_7z', 'a.csv.7z');
          cloud.add(normKey(arc));
          const flip = () => { const b = fs.readFileSync(arc); const fd = fs.openSync(arc, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd); };
          flip();
          v = await verifyCurrent({ source: s, rehash: true, log: quiet });
          assert(!v.complete && [...v.kinds.keys()].some((k) => /クラウドのみに戻せない/.test(k)), '記録と違う書庫の扱いが想定と違う: ' + JSON.stringify([...v.kinds]));
          const m1 = loadManifest(s, s + '_7z').items[normKey('a.csv')];
          assert(m1.archiveRefetch, '読み直しで取得したことが記録に残らない（次の実行で戻し直せない）');
          // 取得されてローカルにある状態: 展開しない確認でも、status でも、未完了として見える
          cloud.delete(normKey(arc));
          v = await verifyCurrent({ source: s, log: quiet });
          assert(!v.complete && [...v.kinds.keys()].some((k) => /クラウドのみに戻っていない/.test(k)), '取得したままの書庫を見逃した');
          assert(!status({ source: s }).complete && status({ source: s }).axes.refetched === 1, 'status が取得したままの書庫を見逃した');
          // 中身を元に戻してやり直すと、記録をもとに戻し直し、記録を消す
          flip();
          v = await verifyCurrent({ source: s, rehash: true, log: quiet });
          assert(v.complete && v.rehashed === 1 && cloud.has(normKey(arc)), '戻し直せない: ' + JSON.stringify([...v.kinds]));
          assert(!loadManifest(s, s + '_7z').items[normKey('a.csv')].archiveRefetch && status({ source: s }).complete, '戻した後も記録が残った');
        } finally { testHooks.winStub = null; testHooks.attrib = null; testHooks.onRefetch = null; }
      });
      await ta('[A63] 今の対象に入らない失敗の記録: verify-current は完了としない。対象が 0 件でも、plan と apply で履歴へ整理でき、その後は完了になる', async () => {
        const s = mk('settle', { 'a.csv': csv(30), 'b.csv': csv(40) });
        testHooks.afterHash = (f) => { if (f.endsWith('b.csv')) fs.appendFileSync(f, 'X'); };
        try { await run(s, planOk(s).id); } finally { testHooks.afterHash = null; }
        fs.unlinkSync(path.join(s, 'b.csv')); // 失敗した元を、利用者が消した
        let v = await verifyCurrent({ source: s, log: quiet });
        assert(!v.complete && [...v.kinds.keys()].some((k) => /失敗・中止が残っている/.test(k)), '今の対象に無い失敗を見逃した: ' + JSON.stringify([...v.kinds]));
        const p = plan({ source: s, olderThanDays: 0 });
        assert(p.valid && !p.items.some((i) => i.cls === 'target') && p.settle.length === 1, '整理だけの計画にならない: ' + p.blockers.join(' / '));
        const r = await run(s, p.id);
        assert(r.counts.settled === 1 && r.counts.targets === 0, '履歴へ整理しない: ' + JSON.stringify(r.counts));
        v = await verifyCurrent({ source: s, log: quiet });
        const st = status({ source: s });
        assert(v.complete && st.complete && st.history === 1, '整理した後に完了にならない: ' + JSON.stringify([...v.kinds]));
      });
      await ta('[A64] status: 対象の記録が 0 件で履歴だけがあるときも「まだ動いていない」としない。--json に元の有無・3 列・履歴を出す。存在しない元のほかの入力の誤りは拒否する', async () => {
        const s = mk('hist', { 'b.csv': csv(40) });
        testHooks.afterHash = (f) => fs.appendFileSync(f, 'X');
        try { await run(s, planOk(s).id); } finally { testHooks.afterHash = null; }
        fs.unlinkSync(path.join(s, 'b.csv'));
        await run(s, planOk(s).id); // 整理だけ（履歴へ）
        const capture = async (args) => { const lines = []; const o = console.log; console.log = (x) => lines.push(String(x)); try { await main(args); } finally { console.log = o; } return lines; };
        const text = (await capture(['status', '--source', s])).join('\n');
        assert(!/まだ動いていない/.test(text) && /履歴（今の対象から外れた失敗・中止の記録） 1 件/.test(text), '履歴だけの状態を「まだ動いていない」とした: ' + text.slice(0, 200));
        const j = JSON.parse((await capture(['status', '--source', s, '--json']))[0]);
        assert(j.found === true && j.history === 1 && j.runs === 2 && j.axes && j.axes.refetched === 0 && j.complete === false, '--json の項目が足りない: ' + JSON.stringify(j));
        // 存在しない元だけを、指定どおりのパスで探す。ファイル・相対パス・UNC は拒否する
        const file = path.join(base, 'not-a-dir.txt'); fs.writeFileSync(file, 'x');
        throwsLike(() => status({ source: file }), /フォルダではない/, 'ファイルの指定を受け付けた');
        throwsLike(() => status({ source: 'relative\\x' }), /絶対パス/, '相対パスを受け付けた');
        throwsLike(() => status({ source: '\\\\server\\share\\x' }), /UNC/, 'UNC を受け付けた');
        assert(status({ source: path.join(base, 'no-such-dir') }).found === false, '存在しない元の記録を探さない');
        // 元が無くても、保存先の誤り（存在するファイル・ドライブの直下）は拒否する。存在しないドライブの直下も拒否する
        throwsLike(() => status({ source: path.join(base, 'no-such-dir'), dest: file }), /フォルダではない/, '元が無いとき、保存先にファイルを受け付けた');
        throwsLike(() => status({ source: path.join(base, 'no-such-dir'), dest: 'Q:\\' }), /ドライブの直下/, '元が無いとき、保存先にドライブの直下を受け付けた');
        throwsLike(() => status({ source: 'Q:\\' }), /ドライブの直下/, '存在しないドライブの直下を受け付けた');
        // 保存先の親がファイルのものを「保存先が無い」と取り違えない（Windows ではその下の lstat が ENOENT を返す。plan も同じ検証を使う）
        throwsLike(() => status({ source: s, dest: path.join(file, 'x') }), /親がフォルダではない/, '親がファイルの保存先を「無い」とした');
        throwsLike(() => plan({ source: s, dest: path.join(file, 'x'), olderThanDays: 0 }), /親がフォルダではない/, 'plan が親がファイルの保存先を「無い」とした');
        // 元が無い分岐でも同じ（保存先の途中がファイル・元の途中がファイル）
        throwsLike(() => status({ source: path.join(base, 'no-such-dir'), dest: path.join(file, 'x') }), /途中がフォルダではない/, '元が無いとき、途中がファイルの保存先を「無い」とした');
        throwsLike(() => status({ source: path.join(file, 'sub') }), /途中がフォルダではない/, '途中がファイルの元を「無い」とした');
      });
      // OneDrive の模擬の下に、古い日付のファイルを並べたフォルダを作る
      const mkOd = (name, files) => {
        const s = path.join(base, 'od', name);
        for (const [rel, body] of Object.entries(files)) { const f = path.join(s, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); fs.utimesSync(f, OLD_DATE, OLD_DATE); }
        return s;
      };
      await ta('[A65] 書庫の解放（OneDrive の模擬）: 同期を確かめられない書庫は apply で解放しない。確認ID の照合・利用者の確認の記録・解放。確認の無い書庫は解放しない。状態が変われば古い確認ID を拒否する', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r2', { 'a.csv': csv(200), 'b.csv': csv(300) });
        const arcA = normKey(path.join(s + '_7z', 'a.csv.7z')); const arcB = normKey(path.join(s + '_7z', 'b.csv.7z'));
        const cloud = new Set(); const pending = new Set([arcA, arcB]); // 作った直後の書庫は、まだアップロードされていない
        let attribCalls = 0;
        testHooks.winStub = fakeOneDrive(root, cloud, pending);
        testHooks.attrib = (args) => { attribCalls++; cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          const mf = loadManifest(s, s + '_7z');
          assert(Object.values(mf.items).every((m) => !m.archiveRelease && !m.archiveSync) && attribCalls === 0, 'apply が同期を確かめられない書庫を解放した');
          let v = await verifyCurrent({ source: s, log: quiet });
          assert(!v.complete && v.upload && v.upload.total === 2 && v.upload.machineSynced === 0 && /^U-[0-9a-f]{16}$/.test(v.upload.id), '確認ID と候補の数が想定と違う: ' + JSON.stringify(v.upload));
          const id = v.upload.id;
          await rejectsLike(() => confirmUpload({ source: s, expect: 'U-0000000000000000', log: quiet }), /合わない/, '違う確認ID で確認を記録した');
          await rejectsLike(() => releaseArchives({ source: s, expect: 'P-' + id.slice(2), log: quiet }), /確認ID（U-…）/, '計画ID の形で解放した');
          // 確認を記録していない書庫は解放しない
          let r = await releaseArchives({ source: s, expect: id, log: quiet });
          assert(r.counts.skipped === 2 && r.counts.released === 0 && attribCalls === 0, '確認の無い書庫を解放した: ' + JSON.stringify(r.counts));
          const cu = await confirmUpload({ source: s, expect: id, log: quiet });
          assert(cu.user === 2 && cu.machine === 0, '確認の記録の数が違う: ' + JSON.stringify(cu));
          // a のアップロードが終わった（機械で同期済み）。状態が変わったので、古い確認ID は確認にも解放にも通らない
          pending.delete(arcA);
          await rejectsLike(() => confirmUpload({ source: s, expect: id, log: quiet }), /合わない/, '状態が変わったのに古い確認ID で確認した');
          await rejectsLike(() => releaseArchives({ source: s, expect: id, log: quiet }), /合わない/, '状態が変わったのに古い確認ID で解放した');
          v = await verifyCurrent({ source: s, log: quiet });
          const id2 = v.upload.id;
          assert(id2 !== id && v.upload.machineSynced === 1, '状態が変わっても確認ID が変わらない');
          // 新しい確認ID では、機械で同期済みの a だけを解放する。b の確認は古い確認ID に対するものなので使わない
          r = await releaseArchives({ source: s, expect: id2, log: quiet });
          assert(r.counts.released === 1 && r.counts.skipped === 1 && cloud.has(arcA) && !cloud.has(arcB), '古い確認ID の確認で解放した: ' + JSON.stringify(r.counts));
          v = await verifyCurrent({ source: s, log: quiet });
          const id3 = v.upload.id;
          const cu3 = await confirmUpload({ source: s, expect: id3, log: quiet });
          assert(cu3.user === 1 && cu3.machine === 0, '確認の記録の数が違う: ' + JSON.stringify(cu3));
          r = await releaseArchives({ source: s, expect: id3, log: quiet });
          assert(r.counts.released === 1 && cloud.has(arcB), '確認した書庫を解放しない: ' + JSON.stringify(r.counts));
          const st = status({ source: s });
          assert(st.axes.release.get('released') === 2 && st.axes.sync.machine === 1 && st.axes.sync.user === 1, 'status の同期・解放の数が違う: ' + JSON.stringify([st.axes.sync, [...st.axes.release]]));
          v = await verifyCurrent({ source: s, log: quiet });
          assert(v.complete && v.upload.total === 0 && v.upload.id === null, '解放済みの書庫を候補に残した');
          await rejectsLike(() => releaseArchives({ source: s, expect: id3, log: quiet }), /解放していない書庫が無い/, '候補が無いのに進んだ');
        } finally { testHooks.winStub = null; testHooks.attrib = null; }
      });
      await ta('[A66] 書庫の解放（OneDrive の模擬）: 属性を変える直前に中身を照合し、違えば変えない。指定が付かなければ「解放できない」。もうクラウドのみの書庫は読まずに済みとする', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r3', { 'a.csv': csv(300) });
        const arc = path.join(s + '_7z', 'a.csv.7z'); const arcK = normKey(arc);
        const cloud = new Set(); const pending = new Set([arcK]);
        let attribCalls = 0; let pinned = false;
        testHooks.winStub = fakeOneDrive(root, cloud, pending);
        // pinned のときは、attrib が成功を返しても指定が付かない（親フォルダが「常に保持」）
        testHooks.attrib = (args) => { attribCalls++; if (!pinned) cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        const flip = () => { const b = fs.readFileSync(arc); const fd = fs.openSync(arc, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd); };
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          const id = (await verifyCurrent({ source: s, log: quiet })).upload.id;
          await confirmUpload({ source: s, expect: id, log: quiet });
          // 中身が書き換えられた（ID・サイズは同じ）: 何も変えない
          flip();
          let r = await releaseArchives({ source: s, expect: id, log: quiet });
          let m = loadManifest(s, s + '_7z').items[normKey('a.csv')];
          assert(r.counts.error === 1 && m.archiveRelease.state === 'error' && attribCalls === 0 && !cloud.has(arcK), '中身の違う書庫の属性を変えた: ' + JSON.stringify(r.counts));
          flip();
          // 親フォルダが「常に保持」: 指定が付かないので「解放できない」
          pinned = true;
          r = await releaseArchives({ source: s, expect: id, log: quiet });
          m = loadManifest(s, s + '_7z').items[normKey('a.csv')];
          assert(r.counts.blocked === 1 && m.archiveRelease.state === 'blocked' && attribCalls === 1, '指定が付かないのに解放したとした: ' + JSON.stringify(r.counts));
          // 利用者が別の方法でクラウドのみにした: 読まず（attrib も呼ばず）に済みとする
          pinned = false; cloud.add(arcK);
          const id3 = (await verifyCurrent({ source: s, log: quiet })).upload.id;
          r = await releaseArchives({ source: s, expect: id3, log: quiet });
          assert(r.counts.released === 1 && attribCalls === 1, 'クラウドのみの書庫を読み直した・attrib を呼んだ: ' + JSON.stringify(r.counts) + ' attrib ' + attribCalls);
        } finally { testHooks.winStub = null; testHooks.attrib = null; }
      });
      await ta('[A67] 解放（OneDrive の模擬）: 照合の後・属性を変える直前に、同期が外れた・差し替えられたものは変えない。記録と一致しない書庫があれば確認ID を出さない。元の状態を戻す処理も同じ', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r4', { 'a.csv': csv(200), 'b.csv': csv(300) });
        const arc = path.join(s + '_7z', 'a.csv.7z'); const arcK = normKey(arc);
        const arcBK = normKey(path.join(s + '_7z', 'b.csv.7z'));
        const cloud = new Set(); const pending = new Set([arcK, arcBK]);
        let attribCalls = 0;
        testHooks.winStub = fakeOneDrive(root, cloud, pending);
        testHooks.attrib = (args) => { attribCalls++; cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        // 同じ中身のまま別のファイルへ差し替える（ファイルID が変わる）
        const swap = (f) => { const t = f + '.swap'; fs.copyFileSync(f, t); fs.renameSync(t, f); };
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          // ① a が機械で同期済みになった。照合の後に同期が外れる（アップロードのやり直し等）→ 変えない
          pending.delete(arcK);
          let id = (await verifyCurrent({ source: s, log: quiet })).upload.id;
          testHooks.beforeAttribCheck = (abs) => { if (normKey(abs) === arcK) pending.add(arcK); };
          let r = await releaseArchives({ source: s, expect: id, log: quiet });
          assert(r.counts.error === 1 && r.counts.skipped === 1 && attribCalls === 0 && !cloud.has(arcK), '同期が外れた書庫の属性を変えた: ' + JSON.stringify(r.counts));
          // ② 利用者が確認した書庫（同期の確かめ直しは無い）が、照合の後に差し替えられる → ファイルID の照合し直しで変えない
          id = (await verifyCurrent({ source: s, log: quiet })).upload.id;
          await confirmUpload({ source: s, expect: id, log: quiet });
          testHooks.beforeAttribCheck = (abs) => { if (normKey(abs) === arcK) swap(arc); };
          r = await releaseArchives({ source: s, expect: id, log: quiet });
          assert(r.counts.error === 1 && r.counts.released === 1 && attribCalls === 1 && !cloud.has(arcK) && cloud.has(arcBK), '差し替えられた書庫の属性を変えた: ' + JSON.stringify(r.counts));
          testHooks.beforeAttribCheck = null;
          // status --json に解放の列が出る（a: エラー、b: 解放済み）
          const lines = []; const o = console.log; console.log = (x) => lines.push(String(x));
          try { await main(['status', '--source', s, '--json']); } finally { console.log = o; }
          const j = JSON.parse(lines[0]);
          assert(j.axes && j.axes.release && j.axes.release.error === 1 && j.axes.release.released === 1, 'status --json に解放の列が出ない: ' + lines[0]);
          // ③ 別の保存先で、記録と一致しない書庫（x: 書庫が差し替えられた）・今の計画で済みにならない記録（y: 元の更新日時が変わった）と、
          // 正常な書庫（z）が並ぶ: 一致しないものを黙って外さず、確認ID を出さず、確認を拒否する
          const s2 = mkOd('r5', { 'x.csv': csv(100), 'y.csv': csv(110), 'z.csv': csv(120) });
          for (const n of ['x', 'y', 'z']) pending.add(normKey(path.join(s2 + '_7z', n + '.csv.7z')));
          const p2 = plan({ source: s2, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s2, purpose: 'cloud', olderThanDays: 0, expect: p2.id, log: quiet });
          const id2 = (await verifyCurrent({ source: s2, log: quiet })).upload.id;
          swap(path.join(s2 + '_7z', 'x.csv.7z'));
          fs.utimesSync(path.join(s2, 'y.csv'), OLD_DATE, new Date(Date.UTC(2022, 0, 5)));
          const v = await verifyCurrent({ source: s2, log: quiet });
          assert(v.upload.anomalies === 2 && v.upload.total === 1 && v.upload.id === null, '記録と一致しない書庫があるのに確認ID を出した・黙って外した: ' + JSON.stringify(v.upload));
          await rejectsLike(() => confirmUpload({ source: s2, expect: id2, log: quiet }), /一致しない/, '記録と一致しない書庫があるのに確認を記録した');
          // ④ 元の状態を戻す処理も、照合の後の差し替えを見つける
          const src = path.join(s, 'b.csv'); const e = fileEntry(src);
          const m = { rel: 'b.csv', cloudOnly: true, fileId: e.fileId, size: e.size, mtimeMs: ticksToMs(e.mtime), initial: stableState(e), sha256: await fileSha(src) };
          const before = attribCalls;
          testHooks.beforeAttribCheck = () => swap(src);
          await rejectsLike(() => restoreSource(m, src), /差し替え/, '照合の後に差し替えられた元の属性を変えた');
          assert(attribCalls === before, '差し替えられた元に attrib を呼んだ');
        } finally { Object.assign(testHooks, { winStub: null, attrib: null, beforeAttribCheck: null }); }
      });
      const flipByte = (f) => { const b = fs.readFileSync(f); const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from([b[40] ^ 0xff]), 0, 1, 40); fs.closeSync(fd); };
      await ta('[A68] deletion-plan・deletion-check: 照合した元だけを個別の候補にし、すべてそろえばフォルダ単位の deletion-ready。書庫の中身が違えば候補にしない。範囲が変われば古い削除検査ID を拒否する', async () => {
        const s = mk('del1', { 'a.csv': csv(300), 'b.csv': csv(400) });
        await run(s, planOk(s).id);
        let dp = deletionPlan({ source: s });
        assert(/^D-[0-9a-f]{16}$/.test(dp.id) && dp.candidates === 2 && dp.others.length === 0 && dp.readBytes > 0, '計画が想定と違う: ' + JSON.stringify({ id: dp.id, c: dp.candidates, o: dp.others.length }));
        // 記録の世代が進めば（ほかの実行が書いた）、古い削除検査ID は通らない
        saveManifest(loadManifest(s, s + '_7z'));
        await rejectsLike(() => deletionCheck({ source: s, expect: dp.id, log: quiet }), /合わない/, '記録の世代が進んだのに古い削除検査ID で検査した');
        dp = deletionPlan({ source: s });
        let r = await deletionCheck({ source: s, expect: dp.id, log: quiet });
        assert(r.listValid && r.folderReady && r.ok.length === 2 && r.ng.length === 0, 'すべて照合できたのに deletion-ready にならない');
        // 書庫の中身が書き換えられた（ID・サイズは同じ。削除検査ID は記録の値で作るので変わらない）: その元は候補にしない
        const arc = path.join(s + '_7z', 'a.csv.7z');
        flipByte(arc);
        dp = deletionPlan({ source: s });
        r = await deletionCheck({ source: s, expect: dp.id, log: quiet });
        assert(r.listValid && !r.folderReady && r.ok.length === 1 && r.ng.length === 1 && /SHA-256/.test(r.ng[0].why), '中身の違う書庫の元を候補にした: ' + JSON.stringify(r.ng));
        flipByte(arc);
        // 元の中身だけが変わった（サイズ・更新日時・ファイルID は同じ）: 読み直した SHA-256 で見つけ、候補にしない
        const srcA = path.join(s, 'a.csv'); const st0 = fs.statSync(srcA);
        flipByte(srcA); fs.utimesSync(srcA, st0.atime, st0.mtime);
        r = await deletionCheck({ source: s, expect: deletionPlan({ source: s }).id, log: quiet });
        assert(r.ng.length === 1 && /元の中身/.test(r.ng[0].why), '中身の変わった元を候補にした: ' + JSON.stringify(r.ng));
        flipByte(srcA); fs.utimesSync(srcA, st0.atime, st0.mtime);
        // ファイルが増えた: 削除検査ID が変わり、古い ID を拒否する。増えたファイルは「元に残す」
        fs.writeFileSync(path.join(s, 'c.txt'), 'new');
        await rejectsLike(() => deletionCheck({ source: s, expect: dp.id, log: quiet }), /合わない/, '範囲が変わったのに古い削除検査ID で検査した');
        dp = deletionPlan({ source: s });
        r = await deletionCheck({ source: s, expect: dp.id, log: quiet });
        assert(r.listValid && !r.folderReady && r.ok.length === 2 && r.keep.length === 1, '増えたファイルを元に残すものとして扱わない: ' + JSON.stringify({ ok: r.ok.length, keep: r.keep.length }));
        // main: フォルダ単位で消せないなら終了コード 2。一覧はこの PC の中のファイルにだけ書く
        assert((await mainQuiet(['deletion-check', '--source', s, '--expect', dp.id, '--json'])) === 2, 'deletion-ready でないのに終了コードが 2 でない');
      });
      await ta('[A69] deletion-check: 検査の間に範囲が変わったら、一覧を出さない（フォルダ単位の判定も出さない）', async () => {
        const s = mk('del2', { 'a.csv': csv(100), 'b.csv': csv(120) });
        await run(s, planOk(s).id);
        const dp = deletionPlan({ source: s });
        let added = false;
        testHooks.afterDeletionItem = () => { if (!added) { added = true; fs.writeFileSync(path.join(s, 'during.csv'), 'x'); } };
        let r; try { r = await deletionCheck({ source: s, expect: dp.id, log: quiet }); } finally { testHooks.afterDeletionItem = null; }
        assert(added && r.changed && !r.listValid && !r.folderReady, '検査の間の変更を見逃した: ' + JSON.stringify({ changed: r.changed, listValid: r.listValid }));
        // 各ファイルの直前に計算し直すので、変わった直後のファイルの前で止まる（2 件目は処理しない）
        assert(r.ok.length + r.ng.length === 1, '変わった後も処理を続けた: ' + (r.ok.length + r.ng.length));
        // 検査の間に、ほかの実行が記録を書いた（世代が進んだ）: 変化として扱う
        fs.unlinkSync(path.join(s, 'during.csv'));
        const dp2 = deletionPlan({ source: s });
        let wrote = false;
        testHooks.afterDeletionItem = () => { if (!wrote) { wrote = true; saveManifest(loadManifest(s, s + '_7z')); } };
        try { r = await deletionCheck({ source: s, expect: dp2.id, log: quiet }); } finally { testHooks.afterDeletionItem = null; }
        assert(wrote && r.changed && !r.listValid, '検査の間の、ほかの実行による記録の書き込みを見逃した');
        // 最後のファイルを処理した後に変わった: 終わりの計算し直しで見つける
        const dp3 = deletionPlan({ source: s });
        let n = 0; let late = false;
        testHooks.afterDeletionItem = () => { n++; if (n === 2) { late = true; fs.writeFileSync(path.join(s, 'late.csv'), 'x'); } };
        try { r = await deletionCheck({ source: s, expect: dp3.id, log: quiet }); } finally { testHooks.afterDeletionItem = null; }
        assert(late && r.changed && !r.listValid && r.ok.length + r.ng.length === 2, '最後のファイルの後の変更を見逃した');
      });
      await ta('[A70] deletion-check（OneDrive の模擬）: クラウドのみの元・書庫を読み直した後、クラウドのみへ戻す。戻せなければ検査全体を失敗にし、印を残す。やり直すと戻し直す', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r6', { 'a.csv': csv(500) });
        const srcK = normKey(path.join(s, 'a.csv')); const arcK = normKey(path.join(s + '_7z', 'a.csv.7z'));
        const cloud = new Set([srcK]); const pending = new Set();
        let pinned = false;
        testHooks.winStub = fakeOneDrive(root, cloud, pending);
        testHooks.attrib = (args) => { if (!pinned) cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          assert(cloud.has(srcK) && cloud.has(arcK), '前提: 元と書庫がクラウドのみになっていない');
          // 読むと取得される（模擬ではクラウドのみの一覧から外す）
          testHooks.onRefetch = (abs) => cloud.delete(normKey(abs));
          const dp = deletionPlan({ source: s });
          assert(dp.fetch.source > 0 && dp.fetch.archive > 0, '取得が起きる量を見込まない: ' + JSON.stringify(dp.fetch));
          // クラウドのみに戻らない（attrib が効かない）: 検査全体を失敗にし、一覧を出さず、印を残す
          pinned = true; testHooks.restoreWaitMs = 0;
          let r = await deletionCheck({ source: s, expect: dp.id, log: quiet });
          testHooks.restoreWaitMs = undefined;
          assert(r.restoreErr.length === 1 && !r.listValid && !r.folderReady, '戻せないのに一覧を出した: ' + JSON.stringify(r.restoreErr));
          const m = loadManifest(s, s + '_7z').items[srcK.split('\\').pop()];
          assert(m.deletionRefetch && m.deletionRefetch.source && m.deletionRefetch.archive, '取得したことが記録に残らない');
          assert(status({ source: s }).axes.refetched === 1, 'status が取得したままのものを数えない');
          const v = await verifyCurrent({ source: s, log: quiet });
          assert(!v.complete && [...v.kinds.keys()].some((k) => /削除の前の検査で取得したまま/.test(k)), 'verify-current が取得したままの元を見逃した');
          // やり直すと、まず印のあるものを戻し、記録が変わったので計画からやり直すよう求めて止まる。計画し直した検査は通る
          pinned = false;
          // クラウドのみのものを読む検査は記録の世代を進めるので、検査のたびに計画し直す
          const chk = () => deletionCheck({ source: s, expect: deletionPlan({ source: s }).id, log: quiet });
          await rejectsLike(() => deletionCheck({ source: s, expect: dp.id, log: quiet }), /戻した.*deletion-plan からやり直す/, '印のあるものを戻さない');
          assert(cloud.has(srcK) && cloud.has(arcK) && !loadManifest(s, s + '_7z').items[srcK.split('\\').pop()].deletionRefetch, '印のあるものを戻し直せない');
          r = await chk();
          assert(r.restoreErr.length === 0 && r.listValid && r.folderReady && cloud.has(srcK) && cloud.has(arcK), '計画し直した検査が通らない: ' + JSON.stringify(r.restoreErr));
          assert(!loadManifest(s, s + '_7z').items[srcK.split('\\').pop()].deletionRefetch && status({ source: s }).axes.refetched === 0, '戻した後も印が残った');
          // 空きが足りなければ読まない（取得を起こさない）
          testHooks.freeBytes = () => 0;
          try { r = await chk(); } finally { testHooks.freeBytes = null; }
          assert(r.ng.length === 1 && /空きが足りず/.test(r.ng[0].why) && cloud.has(srcK) && cloud.has(arcK), '空きが足りないのに読んだ: ' + JSON.stringify(r.ng));
          // 書庫が同期済みでない（アップロードのやり直し等）: 候補にしない
          cloud.delete(arcK); pending.add(arcK);
          r = await chk();
          assert(r.ng.length === 1 && /同期済みでない/.test(r.ng[0].why), '同期済みでない書庫の元を候補にした: ' + JSON.stringify(r.ng));
          pending.delete(arcK); cloud.add(arcK);
          // 元の中身だけが変わった（クラウドのみの元）: 照合に失敗しても、取得したものを戻す処理は試みる
          // （書庫は戻る。元は属性を変える直前の照合で止まり、戻せないものとして数える）
          const srcAbs = path.join(s, 'a.csv'); const st0 = fs.statSync(srcAbs);
          flipByte(srcAbs); fs.utimesSync(srcAbs, st0.atime, st0.mtime);
          r = await chk();
          assert(r.ng.length === 1 && /元の中身/.test(r.ng[0].why) && r.restoreErr.length === 1 && cloud.has(arcK), '照合に失敗した後に戻す処理を試みない: ' + JSON.stringify({ ng: r.ng, restoreErr: r.restoreErr }));
        } finally { Object.assign(testHooks, { winStub: null, attrib: null, onRefetch: null, restoreWaitMs: undefined, freeBytes: null }); }
      });
      await ta('[A71] deletion-check（OneDrive の模擬）: 印のある記録を候補の判定より先に戻す。片側だけ戻せないときはその側だけを数える。想定外の例外でももう一方を戻す。中断では印を残し次に戻す。リンクがあれば走査は不完全。詳細は実パス', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r7', { 'a.csv': csv(400) });
        const srcAbs = path.join(s, 'a.csv'); const arcAbs = path.join(s + '_7z', 'a.csv.7z');
        const srcK = normKey(srcAbs); const arcK = normKey(arcAbs);
        const cloud = new Set([srcK]);
        let pinArchive = false;
        testHooks.winStub = fakeOneDrive(root, cloud);
        testHooks.attrib = (args) => { const k = normKey(args[args.length - 1]); if (!(pinArchive && k === arcK)) cloud.add(k); return { code: 0 }; };
        const flag = () => loadManifest(s, s + '_7z').items[normKey('a.csv')].deletionRefetch;
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          testHooks.onRefetch = (abs) => cloud.delete(normKey(abs));
          const dp = deletionPlan({ source: s });
          // ① 書庫だけ戻らない: 数える量とパスは書庫の側だけ。元は戻る
          pinArchive = true; testHooks.restoreWaitMs = 0;
          let r = await deletionCheck({ source: s, expect: dp.id, log: quiet });
          testHooks.restoreWaitMs = undefined; pinArchive = false;
          assert(r.restoreErr.length === 1 && r.restoreErr[0].bytes === loadManifest(s, s + '_7z').items[normKey('a.csv')].archive.size && r.restoreErr[0].paths.length === 1 && normKey(r.restoreErr[0].paths[0]) === arcK && cloud.has(srcK), '戻せなかった側の量・パスが違う: ' + JSON.stringify(r.restoreErr));
          // クラウドのみのものを読む検査は記録の世代を進めるので、検査のたびに計画し直す
          const chk = () => deletionCheck({ source: s, expect: deletionPlan({ source: s }).id, log: quiet });
          // ② 印が残っている。候補の判定（空き不足）や削除検査ID の照合より先に、印のあるものを戻し、計画からやり直すよう求める
          assert(flag(), '前提: 印が残っていない');
          testHooks.freeBytes = () => 0;
          try { await rejectsLike(() => deletionCheck({ source: s, expect: dp.id, log: quiet }), /戻した.*deletion-plan からやり直す/, '印のあるものを先に戻さない'); } finally { testHooks.freeBytes = null; }
          assert(cloud.has(arcK) && !flag(), '印のある書庫を先に戻さない');
          // ③ 書庫を戻す途中で想定外の例外: 元は戻し、例外は投げ直す（印は残る）
          testHooks.beforeAttribCheck = (abs) => { if (normKey(abs) === arcK) throw new Error('想定外（試験）'); };
          try { await rejectsLike(() => chk(), /想定外（試験）/, '想定外の例外を投げ直さない'); } finally { testHooks.beforeAttribCheck = null; }
          assert(cloud.has(srcK) && !cloud.has(arcK) && flag() && flag().archive, '想定外の例外で、もう一方を戻さない・印を消した');
          await rejectsLike(() => chk(), /戻した/, '印のある書庫を戻さない');
          // ④ 読んでいる途中で中断: 戻さずに印を残し、次の検査が最初に戻す
          let sent = false;
          testHooks.onRefetch = (abs) => { cloud.delete(normKey(abs)); if (!sent) { sent = true; process.emit('SIGINT'); } };
          await rejectsLike(() => chk(), /中断した/, '中断を受けたのに終わらなかった');
          assert(flag() && !cloud.has(srcK), '中断で印が残らない、または戻した');
          testHooks.onRefetch = (abs) => cloud.delete(normKey(abs));
          await rejectsLike(() => chk(), /戻した/, '中断の後に、印のあるものを戻さない');
          r = await chk();
          assert(r.restoreErr.length === 0 && r.listValid && cloud.has(srcK) && cloud.has(arcK) && !flag(), '中断の後に戻し直せない: ' + JSON.stringify(r.restoreErr));
          // ⑤ リンク（ジャンクション）があれば走査は不完全。詳細ファイルの「元に残す」は実パス
          fs.mkdirSync(path.join(base, 'jt'), { recursive: true });
          fs.symlinkSync(path.join(base, 'jt'), path.join(s, 'lnk'), 'junction');
          const dp2 = deletionPlan({ source: s });
          const lines = []; const o = console.log; console.log = (x) => lines.push(String(x));
          try { await main(['deletion-check', '--source', s, '--expect', dp2.id, '--json']); } finally { console.log = o; }
          const j = JSON.parse(lines[0]);
          assert(j.scanComplete === false && j.links === 1 && !j.folderReady, 'リンクがあるのに走査を完全とした: ' + lines[0]);
          const detail = JSON.parse(fs.readFileSync(j.detailFile, 'utf8'));
          assert(detail.keep.length === 1 && path.isAbsolute(detail.keep[0].path), '詳細ファイルの「元に残す」が実パスでない');
        } finally { Object.assign(testHooks, { winStub: null, attrib: null, onRefetch: null, restoreWaitMs: undefined, freeBytes: null, beforeAttribCheck: null }); }
      });
      await ta('[A72] deletion-check（OneDrive の模擬）: 印のある記録を戻す途中で 1 件に想定外の例外が起きても、残りの記録も戻し、戻した件数と戻せない件数を分けて出す', async () => {
        const root = path.join(base, 'od'); const s = mkOd('r8', { 'a.csv': csv(200), 'b.csv': csv(210) });
        const K = (n) => normKey(path.join(s, n)); const A = (n) => normKey(path.join(s + '_7z', n + '.7z'));
        const cloud = new Set([K('a.csv'), K('b.csv')]);
        let pinned = false;
        testHooks.winStub = fakeOneDrive(root, cloud);
        testHooks.attrib = (args) => { if (!pinned) cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        const flagOf = (n) => loadManifest(s, s + '_7z').items[normKey(n)].deletionRefetch;
        try {
          const p = plan({ source: s, purpose: 'cloud', olderThanDays: 0 });
          await apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: p.id, log: quiet });
          testHooks.onRefetch = (abs) => cloud.delete(normKey(abs));
          // 2 件とも戻らずに印が残る
          pinned = true; testHooks.restoreWaitMs = 0;
          const r = await deletionCheck({ source: s, expect: deletionPlan({ source: s }).id, log: quiet });
          pinned = false; testHooks.restoreWaitMs = undefined;
          assert(r.restoreErr.length === 2 && flagOf('a.csv') && flagOf('b.csv'), '前提: 2 件の印が残っていない');
          // a の書庫を戻す途中で想定外の例外。b は戻す
          testHooks.beforeAttribCheck = (abs) => { if (normKey(abs) === A('a.csv')) throw new Error('想定外（試験）'); };
          try { await rejectsLike(() => deletionCheck({ source: s, expect: deletionPlan({ source: s }).id, log: quiet }), /戻した 1 件 \/ 戻せない 1 件/, '1 件の想定外の例外で残りを戻さない'); } finally { testHooks.beforeAttribCheck = null; }
          assert(!flagOf('b.csv') && cloud.has(K('b.csv')) && cloud.has(A('b.csv')) && flagOf('a.csv'), '残りの記録を戻さない、または失敗した記録の印を消した');
        } finally { Object.assign(testHooks, { winStub: null, attrib: null, onRefetch: null, restoreWaitMs: undefined, beforeAttribCheck: null }); }
      });
      await ta('[A73] apply --release-local（OneDrive の模擬）: 指定が無ければ最初からローカルの元に触らない。解放ID を照合し、状態が変われば ID も変わる。同期済みを確かめてから解放し、同期待ちは解放しない。OneDrive の外では拒否する', async () => {
        const root = path.join(base, 'od');
        const cloud = new Set(); const pending = new Set();
        let attribCalls = 0;
        testHooks.winStub = fakeOneDrive(root, cloud, pending);
        testHooks.attrib = (args) => { attribCalls++; cloud.add(normKey(args[args.length - 1])); return { code: 0 }; };
        const srcRel = (s, n) => loadManifest(s, s + '_7z').items[normKey(n)].sourceRelease;
        try {
          // ① 指定しなければ触らない。plan は別表と解放ID を出す
          const s1 = mkOd('rl1', { 'a.csv': csv(100), 'b.csv': csv(110) });
          cloud.add(normKey(path.join(s1, 'b.csv'))); // b は最初からクラウドのみ
          const p1 = plan({ source: s1, purpose: 'cloud', olderThanDays: 0 });
          assert(p1.releaseLocal.count === 1 && /^R-[0-9a-f]{16}$/.test(p1.releaseLocal.id), '最初からローカルの対象の別表・解放ID が無い: ' + JSON.stringify(p1.releaseLocal));
          await apply({ source: s1, purpose: 'cloud', olderThanDays: 0, expect: p1.id, log: quiet });
          assert(!cloud.has(normKey(path.join(s1, 'a.csv'))) && !srcRel(s1, 'a.csv'), '指定が無いのに、最初からローカルの元を解放した');
          // ② 解放ID の照合。ローカル／クラウドのみが変われば ID も変わる。指定すれば解放する
          const s2 = mkOd('rl2', { 'a.csv': csv(120), 'b.csv': csv(130) });
          const p2 = plan({ source: s2, purpose: 'cloud', olderThanDays: 0 });
          await rejectsLike(() => apply({ source: s2, purpose: 'cloud', olderThanDays: 0, expect: p2.id, releaseLocal: true, expectRelease: 'R-0000000000000000', log: quiet }), /解放ID が今の状態と合わない/, '違う解放ID で進んだ');
          cloud.add(normKey(path.join(s2, 'b.csv'))); // b がクラウドのみになった（最初からローカルの対象が変わるので、解放ID も変わる）
          const p2b = plan({ source: s2, purpose: 'cloud', olderThanDays: 0 });
          assert(p2b.releaseLocal.id !== p2.releaseLocal.id && p2b.releaseLocal.count === 1, 'ローカル／クラウドのみが変わっても解放ID が変わらない');
          await rejectsLike(() => apply({ source: s2, purpose: 'cloud', olderThanDays: 0, expect: p2b.id, releaseLocal: true, expectRelease: p2.releaseLocal.id, log: quiet }), /解放ID が今の状態と合わない/, '古い解放ID で進んだ');
          const before = attribCalls;
          const r2 = await apply({ source: s2, purpose: 'cloud', olderThanDays: 0, expect: p2b.id, releaseLocal: true, expectRelease: p2b.releaseLocal.id, log: quiet });
          assert(cloud.has(normKey(path.join(s2, 'a.csv'))) && srcRel(s2, 'a.csv').state === 'released' && !srcRel(s2, 'b.csv') && r2.counts.local.released === 1 && r2.counts.local.total === 1 && attribCalls > before, '指定したのに解放しない: ' + JSON.stringify(r2.counts.local));
          assert(status({ source: s2 }).axes.source.localRelease.get('released') === 1, 'status に元の解放が出ない');
          // ③ 同期待ちの元は解放しない（終了コードは 2）
          const s3 = mkOd('rl3', { 'a.csv': csv(140) });
          pending.add(normKey(path.join(s3, 'a.csv')));
          const p3 = plan({ source: s3, purpose: 'cloud', olderThanDays: 0 });
          // 同期待ちの元は計画で「判定できない」にならない（プレースホルダー）。apply の後の解放の前に同期済みを確かめる
          const code3 = await mainQuiet(['apply', '--source', s3, '--purpose', 'cloud', '--older-than', '0', '--expect', p3.id, '--release-local', '--expect-release', p3.releaseLocal.id]);
          assert(srcRel(s3, 'a.csv').state === 'notSynced' && !cloud.has(normKey(path.join(s3, 'a.csv'))) && code3 === 2, '同期待ちの元を解放した、または終了コードが 2 でない: ' + code3);
        } finally { Object.assign(testHooks, { winStub: null, attrib: null }); }
        // ④ OneDrive の外では拒否する。引数は組で使う
        const s4 = mk('rl4', { 'a.csv': csv(10) });
        await rejectsLike(() => apply({ source: s4, olderThanDays: 0, expect: planOk(s4).id, releaseLocal: true, expectRelease: 'R-0000000000000000', log: quiet }), /OneDrive の同期ルートの下のときだけ/, 'OneDrive の外で --release-local を受け付けた');
        throwsLike(() => parseArgs(['apply', '--source', 'x', '--expect', 'P-0000000000000000', '--release-local']), /解放ID/, '--release-local だけで通った');
        throwsLike(() => parseArgs(['apply', '--source', 'x', '--expect', 'P-0000000000000000', '--expect-release', 'R-0000000000000000']), /解放ID/, '--expect-release だけで通った');
        throwsLike(() => parseArgs(['apply', '--source', 'x', '--expect', 'P-0000000000000000', '--release-local', '--expect-release', 'P-0000000000000000']), /解放ID/, '解放ID に計画ID の形を受け付けた');
      });
      await ta('[A74] apply --release-local（OneDrive の模擬）: 解放が待ち・同期待ち・済みにした直後の中断で終わっても、済みとして消えず、plan と apply で解放し直せる。それまで status・verify-current は完了としない。plan --json に解放ID が出る', async () => {
        const root = path.join(base, 'od');
        const cloud = new Set(); const pending = new Set(); const unpinned = new Set();
        let mode = 'normal';
        testHooks.winStub = fakeOneDrive(root, cloud, pending, unpinned);
        // slow: 指定は付くが、まだクラウドのみにならない（戻るのを待っている）
        testHooks.attrib = (args) => { const k = normKey(args[args.length - 1]); if (mode === 'slow') unpinned.add(k); else cloud.add(k); return { code: 0 }; };
        const st = (s) => loadManifest(s, s + '_7z').items[normKey('a.csv')];
        const planJson = async (s) => { const lines = []; const o = console.log; console.log = (x) => lines.push(String(x)); try { await main(['plan', '--source', s, '--purpose', 'cloud', '--older-than', '0', '--json']); } finally { console.log = o; } return JSON.parse(lines[0]); };
        // 計画し直して、--release-local 付きで apply する（解放ID は plan --json から取る）
        const again = async (s) => { const j = await planJson(s); return apply({ source: s, purpose: 'cloud', olderThanDays: 0, expect: j.id, releaseLocal: true, expectRelease: j.releaseLocal.id, log: quiet }); };
        try {
          // ① 戻るのを待っている → 済みとして消えず、やり直すと解放する
          const s1 = mkOd('rp1', { 'a.csv': csv(100) });
          const j1 = await planJson(s1);
          assert(j1.releaseLocal && j1.releaseLocal.count === 1 && /^R-[0-9a-f]{16}$/.test(j1.releaseLocal.id), 'plan --json に解放ID が無い: ' + JSON.stringify(j1));
          mode = 'slow';
          await apply({ source: s1, purpose: 'cloud', olderThanDays: 0, expect: j1.id, releaseLocal: true, expectRelease: j1.releaseLocal.id, log: quiet });
          assert(st(s1).sourceRelease.state === 'waiting' && !status({ source: s1 }).complete, '解放の待ちを完了とした');
          const v1 = await verifyCurrent({ source: s1, log: quiet });
          assert(!v1.complete && [...v1.kinds.keys()].some((k) => /元の解放.*終わっていない/.test(k)), 'verify-current が解放の待ちを見逃した');
          const j1b = await planJson(s1);
          assert(j1b.valid && j1b.releaseLocal.pending === 1, '解放し直す対象を計画に含めない: ' + JSON.stringify(j1b));
          mode = 'normal';
          await again(s1);
          assert(st(s1).sourceRelease.state === 'released' && status({ source: s1 }).complete, 'やり直しで解放しない');
          // ② 同期待ち → やり直すと解放する
          const s2 = mkOd('rp2', { 'a.csv': csv(110) });
          pending.add(normKey(path.join(s2, 'a.csv')));
          await again(s2);
          assert(st(s2).sourceRelease.state === 'notSynced' && !status({ source: s2 }).complete, '同期待ちを完了とした');
          pending.delete(normKey(path.join(s2, 'a.csv')));
          await again(s2);
          assert(st(s2).sourceRelease.state === 'released', '同期が終わった後のやり直しで解放しない');
          // ③ 済みにした直後に中断 → 解放の記録が無いまま済みになっても、やり直すと解放する
          const s3 = mkOd('rp3', { 'a.csv': csv(120) });
          let sent = false;
          testHooks.afterSave = (state) => { if (state === 'restored' && !sent) { sent = true; process.emit('SIGINT'); } };
          try { await rejectsLike(() => again(s3), /中断した/, '中断を受けたのに終わらなかった'); } finally { testHooks.afterSave = null; }
          assert(st(s3).state === 'restored' && st(s3).releaseLocalRequested && !st(s3).sourceRelease, '前提: 済みにした直後で止まっていない');
          await again(s3);
          assert(st(s3).sourceRelease.state === 'released' && cloud.has(normKey(path.join(s3, 'a.csv'))), '中断の後のやり直しで解放しない');
          // ④ 属性を変えた直後（ピンは unpinned になった）・結果を記録する前に中断 → 次の 1 回で解放する
          const s4 = mkOd('rp4', { 'a.csv': csv(130) });
          let sent4 = false;
          mode = 'slow';
          const attribSlow = testHooks.attrib;
          testHooks.attrib = (args) => { const r = attribSlow(args); if (!sent4) { sent4 = true; process.emit('SIGINT'); } return r; };
          try { await rejectsLike(() => again(s4), /中断した/, '中断を受けたのに終わらなかった'); } finally { testHooks.attrib = attribSlow; }
          assert(st(s4).releaseAttempted && !st(s4).sourceRelease && unpinned.has(normKey(path.join(s4, 'a.csv'))), '前提: 属性を変えた直後・結果の記録の前で止まっていない');
          mode = 'normal';
          await again(s4);
          assert(st(s4).sourceRelease.state === 'released', '属性を変えた直後の中断から、次の 1 回で解放しない: ' + JSON.stringify(st(s4).sourceRelease));
          // ⑤ ツールが属性を変えていない記録（同期待ちで止まった）では、ピンの違いを許さない（利用者が自分で変えたものは記録と違う）
          const s5 = mkOd('rp5', { 'a.csv': csv(140) });
          const k5 = normKey(path.join(s5, 'a.csv'));
          pending.add(k5);
          await again(s5);
          assert(st(s5).sourceRelease.state === 'notSynced' && !st(s5).releaseAttempted, '前提: 同期待ちで、属性を変えずに止まっていない');
          pending.delete(k5); unpinned.add(k5); // 同期が終わり、利用者が自分で「空き容量を増やす」を付けた
          await again(s5);
          assert(st(s5).sourceRelease.state === 'error' && /pin/.test(st(s5).sourceRelease.reason || '') && !cloud.has(k5), 'ツールが変えていないピンの違いを許した: ' + JSON.stringify(st(s5).sourceRelease));
          // 照合で止まった試みは「試みた」印を付けない。もう一度やり直しても、引き続きピンの違いで止まる
          assert(!st(s5).releaseAttempted, '照合で止まったのに「試みた」印を付けた');
          await again(s5);
          assert(st(s5).sourceRelease.state === 'error' && /pin/.test(st(s5).sourceRelease.reason || '') && !cloud.has(k5), '2 回目のやり直しで、ツールが変えていないピンの違いを許した: ' + JSON.stringify(st(s5).sourceRelease));
        } finally { Object.assign(testHooks, { winStub: null, attrib: null, afterSave: null }); }
      });
    } else results.push({ ok: true, name: '[A21〜A74] apply（実機の 7-Zip）', m: '7-Zip が無い・Windows 以外のため飛ばした（55 件）' });
    await ta('[A75] roots: 確定した同期ルートと、同期ルートの外にある既知フォルダだけを候補にする。読めなかったものは errors に出し、終了コードは 2。実機の補助スクリプトは 3 つの既知フォルダを返す', async () => {
      const od = path.join(base, 'odroot'); const docs = path.join(od, 'Documents'); const desk = path.join(base, 'Desktop-x');
      fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(desk, { recursive: true });
      const stub = (knownRows) => (req, real) => {
        if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: od }, { type: 'account', name: 'y', folder: path.join(base, 'stale') }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: od }, { type: 'end', count: 3 }];
        if (req.mode === 'knownfolders') return [{ type: 'header' }, ...knownRows, { type: 'end', count: knownRows.length }];
        return real(req);
      };
      try {
        testHooks.winStub = stub([{ type: 'known', name: 'Documents', path: docs }, { type: 'known', name: 'Desktop', path: desk }, { type: 'known', name: 'Downloads', path: path.join(base, 'no-such') }]);
        let r = roots();
        assert(r.syncRoots.length === 1 && normKey(r.syncRoots[0]) === normKey(od), '登録の無い OneDrive のアカウントを同期ルートとした');
        const kinds = r.candidates.map((c) => c.kind + ':' + (c.name || '')).sort().join(',');
        assert(kinds === 'known:Desktop,syncRoot:' && r.errors.length === 0, '候補が想定と違う（同期ルートの中・存在しない既知フォルダを外す）: ' + kinds);
        // 読めなかったもの: errors に出し、main の終了コードは 2
        testHooks.winStub = stub([{ type: 'known', name: 'Documents', path: docs }, { type: 'error', where: 'knownfolder:Downloads', message: 'value not found' }]);
        r = roots();
        assert(r.errors.length === 1 && /Downloads/.test(r.errors[0]), '読めなかった既知フォルダを errors に出さない');
        const o = console.log; console.log = () => {}; let code;
        try { code = await main(['roots', '--json']); } finally { console.log = o; }
        assert(code === 2, '読めなかったものがあるのに終了コードが 2 でない: ' + code);
        // 既知フォルダがフォルダでない（ファイル）: 「無い」にせず errors に出す
        const notDir = path.join(base, 'Desktop-file'); fs.writeFileSync(notDir, 'x');
        testHooks.winStub = stub([{ type: 'known', name: 'Desktop', path: notDir }]);
        r = roots();
        assert(r.errors.some((e) => /Desktop: フォルダではない/.test(e)) && r.known[0].state === 'notDir' && !r.candidates.some((c) => c.kind === 'known'), 'フォルダでない既知フォルダを「無い」とした・候補にした');
        // 既知フォルダがジャンクションで同期ルートの中を指す: 実体で比べ、候補にしない（二重に数えない）
        const link = path.join(base, 'Downloads-link'); fs.symlinkSync(docs, link, 'junction');
        testHooks.winStub = stub([{ type: 'known', name: 'Downloads', path: link }]);
        r = roots();
        assert(r.known[0].inSyncRoot && !r.candidates.some((c) => c.kind === 'known'), '同期ルートの中を指すジャンクションを、別の候補として数えた');
        // 同期ルートの登録がジャンクション（別の表記）でも、実体で比べる: 実体の下にある既知フォルダは同期ルートの中
        const odLink = path.join(base, 'odroot-link'); fs.symlinkSync(od, odLink, 'junction');
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: odLink }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: odLink }, { type: 'end', count: 2 }];
          if (req.mode === 'knownfolders') return [{ type: 'header' }, { type: 'known', name: 'Documents', path: docs }, { type: 'end', count: 1 }];
          return real(req);
        };
        r = roots();
        assert(r.syncRootsKnown && r.known[0].inSyncRoot && r.candidates.length === 1, '同期ルートの登録がジャンクションのとき、実体の下の既知フォルダを外と判定した: ' + JSON.stringify(r.known));
        // アカウント側だけがジャンクション（登録側は実体）でも、同じ実体なら同期ルートとして突き合わせる
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: odLink }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: od }, { type: 'end', count: 2 }];
          if (req.mode === 'knownfolders') return [{ type: 'header' }, { type: 'known', name: 'Documents', path: docs }, { type: 'end', count: 1 }];
          return real(req);
        };
        r = roots();
        assert(r.syncRoots.length === 1 && normKey(r.syncRoots[0]) === normKey(fs.realpathSync.native(od)), '片側だけ別表記の同期ルートを突き合わせから落とした: ' + JSON.stringify(r.syncRoots));
        // 逆向き（登録側だけがジャンクション）も同じ
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'account', name: 'x', folder: od }, { type: 'registered', id: 'x', sid: 'S-1-12-1-x', folder: odLink }, { type: 'end', count: 2 }];
          if (req.mode === 'knownfolders') return [{ type: 'header' }, { type: 'known', name: 'Documents', path: docs }, { type: 'end', count: 1 }];
          return real(req);
        };
        r = roots();
        assert(r.syncRoots.length === 1 && normKey(r.syncRoots[0]) === normKey(fs.realpathSync.native(od)), '登録側だけ別表記の同期ルートを突き合わせから落とした: ' + JSON.stringify(r.syncRoots));
        // roots が返した候補（実体のパス）を survey にそのまま渡せる（survey も同じ実体で同期ルートを判定する。API の判定は実体で返す）
        const apiStub = testHooks.winStub;
        testHooks.winStub = (req, real) => (req.mode === 'syncroot' ? [{ type: 'header' }, { type: 'syncroot', hr: isWithin(req.path, od) ? 0 : HR_NOT_UNDER_SYNC_ROOT }, { type: 'end', count: 1 }] : apiStub(req, real));
        const sv = survey({ source: r.candidates[0].path });
        assert(sv.syncRoot && normKey(sv.syncRoot) === normKey(od), 'roots の候補を survey に渡すと、同期ルートの判定が食い違う');
        // 同期ルートを読めない: 例外で止まらず errors に出し、既知フォルダも判定できないので候補にしない。終了コードは 2
        testHooks.winStub = (req, real) => {
          if (req.mode === 'syncroots') return [{ type: 'header' }, { type: 'error', where: 'accounts', message: 'denied' }, { type: 'end', count: 1 }];
          if (req.mode === 'knownfolders') return [{ type: 'header' }, { type: 'known', name: 'Desktop', path: desk }, { type: 'end', count: 1 }];
          return real(req);
        };
        r = roots();
        assert(!r.syncRootsKnown && r.errors.some((e) => /^syncroots:/.test(e)) && r.candidates.length === 0, '同期ルートを読めないのに判定した・止まらなかった: ' + JSON.stringify(r.errors));
        const lines = []; console.log = (x) => lines.push(String(x));
        try { code = await main(['roots', '--json']); } finally { console.log = o; }
        assert(code === 2 && JSON.parse(lines[0]).syncRootsKnown === false, '同期ルートを読めないときに一覧を返さない・終了コードが 2 でない: ' + code);
      } finally { testHooks.winStub = null; }
      // 実機の補助スクリプト: 3 つの既知フォルダを、known か error の行で返す（黙って落とさない）
      if (process.platform === 'win32') {
        const rows = winProbe({ mode: 'knownfolders' });
        const names = rows.map((x) => (x.type === 'known' ? x.name : (x.where || '').replace(/^knownfolder:/, ''))).sort().join(',');
        assert(rows.length === 3 && names === 'Desktop,Documents,Downloads', '実機の knownfolders が 3 行でない: ' + JSON.stringify(rows.map((x) => x.type)));
      }
      throwsLike(() => parseArgs(['roots', '--source', 'x']), /受け付けない引数/, 'roots が --source を受け付けた');
    });
    await ta('[A76] 入口と出口の件数の照合: survey の件数 ＋ リンク ＋ 走査エラー ＝ plan の全件（対象＋済み＋除外＋判定できない）。論理サイズはリンクを除いて一致。survey --json にリンクの数を出す', async () => {
      const s = path.join(base, 'census'); fs.mkdirSync(path.join(s, 'sub'), { recursive: true });
      for (const [n, body] of [['a.csv', 'x'.repeat(100)], ['b.zip', 'y'.repeat(50)], ['sub\\c.txt', 'z'.repeat(30)]]) { const f = path.join(s, n); fs.writeFileSync(f, body); fs.utimesSync(f, new Date(Date.UTC(2022, 0, 1)), new Date(Date.UTC(2022, 0, 1))); }
      fs.mkdirSync(path.join(base, 'census-target'), { recursive: true });
      fs.symlinkSync(path.join(base, 'census-target'), path.join(s, 'lnk'), 'junction');
      // 走査エラーを 1 件まぜる（補助スクリプトの scan に error の行を足す）
      testHooks.winStub = (req, real) => {
        if (req.mode !== 'scan') return real(req);
        const rows = real(req); const end = rows.pop();
        return [...rows, { type: 'error', rel: 'denied', error: 5 }, { ...end, count: end.count + 1 }];
      };
      try {
        const sv = survey({ source: s });
        const p = plan({ source: s, olderThanDays: 0 });
        const cls = countBy(p.items, (i) => i.cls);
        const planTotal = ['target', 'done', 'excluded', 'unknown'].reduce((a, k) => a + (cls.get(k) || 0), 0);
        assert(sv.stats.files === 3 && sv.stats.links === 1 && sv.stats.errors === 1, '前提: survey の数え方が想定と違う: ' + JSON.stringify({ f: sv.stats.files, l: sv.stats.links, e: sv.stats.errors }));
        assert(sv.stats.files + sv.stats.links + sv.stats.errors === planTotal && planTotal === p.items.length, '件数の式が成り立たない: ' + JSON.stringify({ survey: sv.stats.files + sv.stats.links + sv.stats.errors, plan: planTotal }));
        const planLogical = p.items.filter((i) => i.reason !== REASON.link && i.reason !== UNKNOWN.scan).reduce((a, i) => a + (i.size || 0), 0);
        assert(planLogical === sv.stats.logical, '論理サイズが一致しない（リンクと走査エラーを除く）: ' + JSON.stringify({ survey: sv.stats.logical, plan: planLogical }));
        // 実際に入口と出口が使う CLI の出力どうしで照合する（survey --json と plan --json の census）
        const lines = []; const o = console.log; console.log = (x) => lines.push(String(x));
        try { await main(['survey', '--source', s, '--json']); } finally { console.log = o; }
        const sj = JSON.parse(lines[0]);
        assert(sj.links === 1, 'survey --json にリンクの数が無い');
        lines.length = 0; console.log = (x) => lines.push(String(x));
        try { await main(['plan', '--source', s, '--older-than', '0', '--json']); } finally { console.log = o; }
        const cj = JSON.parse(lines[0]).census;
        assert(cj && sj.files + sj.links + sj.errors === cj.total && sj.logical === cj.logicalExcludingLinks && sj.links === cj.links.n && sj.errors === cj.scanErrors,
          'CLI の出力どうしで照合できない: ' + JSON.stringify({ survey: [sj.files, sj.links, sj.errors, sj.logical], census: cj && [cj.total, cj.links.n, cj.scanErrors, cj.logicalExcludingLinks] }));
        lines.length = 0; console.log = (x) => lines.push(String(x));
        try { await main(['survey', '--source', s, '--summary']); } finally { console.log = o; }
        assert(/リンク 1 /.test(lines.join('\n')), 'survey --summary にリンクの数が無い');
      } finally { testHooks.winStub = null; }
    });
  } finally {
    restore();
    if (savedDir === undefined) delete process.env.UT_ARCHIVE_DIR; else process.env.UT_ARCHIVE_DIR = savedDir;
    fs.rmSync(base, { recursive: true, force: true });
  }
  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.m ? ' | ' + r.m : ''));
  const ng = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng} 件パス / ${ng} 件失敗`);
  // 指定した試験が 1 件も動かなければ失敗にする（ID の書き間違いを「全件パス」と読まない）
  if (only && results.length === 0) { console.log('指定した試験が 1 件も見つからない: ' + only.join(',')); return false; }
  return ng === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv.includes('--selftest')) {
    const i = process.argv.indexOf('--only');
    const only = i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (only) console.log(`部分実行: ${only.join(',')}（全件の判定ではない）`);
    process.exit((await selftest(only)) ? 0 : 1);
  }
  process.exit(await main(process.argv.slice(2)));
}
