#!/usr/bin/env node
// /ut-handoff と /ut-takeover の部品（依存なし。機微値の型は ut-review.mjs と共有）。引き継ぎの中身は LLM が書き、
// この部品は機械で決まることだけを受け持つ: 引き継ぎ ID、照合用の鍵（HMAC）、見出しの読み書き、資料の写しと除外、
// 書く順序（.partial → 改名 → ポインタ）、候補の走査、照合、受領通知の宛先の照合、後片付け、クリップボード。
//
//   node ut-handoff.mjs create --draft <下書き.md> --title <短い名前> [--files-json <資料.json>] [--include a,b] [--exclude a,b]
//                              [--no-notify] [--source-name <名前> --source-ref <ref>] [--uncopied-images <N>] [--repo <dir>] [--base <dir>]
//   node ut-handoff.mjs list   [--repo <dir>] [--base <dir>]                 （読み取りだけ）
//   node ut-handoff.mjs verify --id <ID> [--accept-head|--accept-repo|--accept-branch|--accept-legacy|--accept-older] [--repo <dir>] [--base <dir>]（読み取りだけ）
//   node ut-handoff.mjs peer   --id <ID> --name <ListAgents の名前> [--base <dir>]   （読み取りだけ）
//   node ut-handoff.mjs check  [--base <dir>]                                （削除の候補。読み取りだけ）
//   node ut-handoff.mjs prune  --apply [--base <dir>]                        （候補を消す。要確認の操作）
//   node ut-handoff.mjs clip   --id <ID> [--base <dir>]   /   link --id <ID> [--base <dir>]   （1 行を部品の中で組み立てる。手順はこちら）
//   node ut-handoff.mjs clip   --text <1 行>              /   link --text <1 行>              （手で打つとき。1 行の形を検査する）
//   node ut-handoff.mjs --selftest
//
// 下書きは「再開用ブロック」を <!-- resume-block:start --> と <!-- resume-block:end --> で囲む。資料の JSON は [{"path": "...", "desc": "..."}]。
// 鍵 <base>/.key を作るのは create だけ（list・verify・peer は作らない）。exit: 0 成功 / 1 検査で止めた / 2 入力の誤り
// サブコマンドごとに使えるオプションが決まっており、知らないオプション・同じオプションの 2 回目・値の無い余分な語は exit 2 で止める
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS, maskText } from './ut-review.mjs';

const SELF = fileURLToPath(import.meta.url);
export class InputError extends Error {}
export class CheckError extends Error {}

export const homeBase = () => path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'work', 'handoff');
export const ID_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$/;
const LEGACY_RE = /^[\p{L}\p{N}_-]+$/u;
const BLOCK_START = '<!-- resume-block:start -->';
const BLOCK_END = '<!-- resume-block:end -->';
const HEAD_START = '<!-- ut-handoff';
export const LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, listDays: 14, listMax: 10, partialHours: 24, keepDays: 30, noticeChars: 300 };
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// 秘密を含みうる名前（大文字・小文字を区別しない）
export const SECRET_NAMES = [/^\.env/, /\.pem$/, /\.pfx$/, /\.p12$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /\.ppk$/, /^\.git-credentials$/, /^\.npmrc$/, /^\.pypirc$/, /settings.*\.json$/, /^credentials/, /\.kdbx$/];
// 写す前の中身の走査に使う型（ローカルのホームのパスは引き継ぎの場所でも同じマシンなので除く）
const SCAN_PATTERNS = SECRET_PATTERNS.filter((p) => p.name !== 'ユーザーのホーム');
const mask = (s) => maskText(s, []).text;

// ---------------------------------------------------------------- 鍵と照合用の値
export function keyPath(base) { return path.join(base, '.key'); }
export function loadKey(base, { create = false } = {}) {
  const p = keyPath(base);
  try { const k = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex'); if (k.length >= 32) return k; throw new CheckError('鍵のファイルが壊れている: ' + p); } catch (e) {
    if (e instanceof CheckError) throw e;
    if (!create) return null;
    fs.mkdirSync(base, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(p, k.toString('hex') + '\n', { flag: 'wx' });
    return k;
  }
}
export const hmac = (key, kind, value) => crypto.createHmac('sha256', key).update(kind + '\0' + value).digest('hex').slice(0, 16);
export const keyId = (key) => crypto.createHmac('sha256', key).update('ut-handoff-key-id').digest('hex').slice(0, 8);
export const nameKey = (key, name) => hmac(key, 'name', String(name).trim());
export function normRepoPath(p, platform = process.platform) {
  const s = path.resolve(p).replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

// ---------------------------------------------------------------- git（読み取りだけ）
// GIT_OPTIONAL_LOCKS=0: status がインデックスを更新して .git/index.lock を作るのを止める（照合は読み取りだけにする）
function git(args, cwd, input) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
export function gitInfo(dir) {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) return { git: false };
  const root = top.out.trim();
  const common = git(['rev-parse', '--git-common-dir'], dir).out.trim();
  let commonAbs = path.resolve(dir, common);
  try { commonAbs = fs.realpathSync.native(commonAbs); } catch { /* 実パスにできなくても続ける */ }
  const branch = git(['branch', '--show-current'], dir).out.trim() || '(detached)';
  const headR = git(['rev-parse', '--short=12', 'HEAD'], dir);
  const head = headR.ok ? headR.out.trim() : 'none';
  // 作業ツリーの状態: 状態の行と、変更・未追跡のファイルごとのインデックスの blob と作業ファイルの中身（どちらもリポジトリに書かない）
  const stR = git(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], root);
  const lsR = git(['ls-files', '-s', '-z'], root);
  const st = stR.out.split('\0').filter(Boolean).sort();
  const paths = st.map((l) => l.slice(3));
  const index = new Map(lsR.out.split('\0').filter(Boolean).map((l) => { const m = /^\d+ ([0-9a-f]+) \d\t(.*)$/s.exec(l); return m ? [m[2], m[1]] : null; }).filter(Boolean));
  const kinds = new Map(paths.map((p) => { try { const s = fs.lstatSync(path.join(root, p)); return [p, s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : 'other']; } catch { return [p, 'deleted']; } }));
  const files = paths.filter((p) => kinds.get(p) === 'file');
  const hoR = files.length ? git(['hash-object', '--stdin-paths'], root, files.join('\n') + '\n') : { ok: true, out: '' };
  const hashes = hoR.out.trim().split(/\r?\n/);
  const work = new Map(files.map((p, i) => [p, hashes[i] || '']));
  // リンクは指し先の文字列、ファイル以外（サブモジュールなど）は種類だけを入れる（中身までは見ない。限界は docs）
  const workOf = (p) => kinds.get(p) === 'file' ? work.get(p) : kinds.get(p) === 'link' ? 'link:' + (() => { try { return fs.readlinkSync(path.join(root, p)); } catch { return '?'; } })() : kinds.get(p);
  const material = st.map((l, i) => `${l}\t${index.get(paths[i]) || '-'}\t${workOf(paths[i])}`).join('\n');
  // 状態を取れなかったら、照合の差が黙って消えないように「取れない」と明示する
  const materialOk = stR.ok && lsR.ok && hoR.ok && (!files.length || hashes.length === files.length);
  return { git: true, root, common: commonAbs, branch, head, material, materialOk };
}
export function isAncestor(dir, a, b = 'HEAD') { return git(['merge-base', '--is-ancestor', a, b], dir).ok; }

// ---------------------------------------------------------------- 見出し
export function renderHeader(h) {
  const keys = ['handoff-id', 'created', 'git', 'key-id', 'repo-key', 'branch-key', 'head', 'tree-state', 'dir-key', 'source-ref', 'source-name-key', 'uncopied', 'notify'];
  return [HEAD_START, ...keys.filter((k) => h[k] !== undefined && h[k] !== '').map((k) => `${k}: ${h[k]}`), '-->'].join('\n');
}
export function parseHeader(text) {
  const t = String(text).replace(/^\uFEFF/, '');
  if (!t.startsWith(HEAD_START)) return null;
  const end = t.indexOf('-->');
  if (end < 0) return null;
  const h = {};
  for (const line of t.slice(HEAD_START.length, end).split(/\r?\n/)) { const m = /^([a-z-]+):\s*(.*)$/.exec(line.trim()); if (m) h[m[1]] = m[2].trim(); }
  return h;
}
export function extractBlock(text) {
  const s = text.indexOf(BLOCK_START), e = text.indexOf(BLOCK_END);
  if (s < 0 || e < 0 || e < s) return null;
  return text.slice(s + BLOCK_START.length, e).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}
function readHead(file, bytes = 4096) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- ID
const pad = (n) => String(n).padStart(2, '0');
export function makeId(now, title) {
  const slug = String(title || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new InputError('--title は英小文字・数字・ハイフンだけで 1〜40 文字（先頭は英数字）: ' + slug);
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${slug}`;
}
// ID から保存先の中のファイルを決める（外を指すものは拒む）
export function resolveId(base, id) {
  const s = String(id || '');
  if (!s || /\.\.|[\\/:]/.test(s)) throw new InputError('ID に使えない文字（..・\\・/・:）を含む: ' + s);
  if (ID_RE.test(s)) {
    const f = path.join(base, s, 'handoff.md');
    if (fs.existsSync(f)) return { kind: 'new', file: f, dir: path.join(base, s) };
    throw new InputError('引き継ぎが見つからない（完成していない・消された可能性）: ' + s);
  }
  if (LEGACY_RE.test(s)) {
    const f = path.join(base, s + '.md');
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return { kind: 'legacy', file: f };
  }
  throw new InputError('引き継ぎが見つからない: ' + s);
}

// ---------------------------------------------------------------- 資料の写し
function isUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}
export function scanText(text) { return SCAN_PATTERNS.filter((p) => { p.re.lastIndex = 0; return p.re.test(text); }).map((p) => p.name); }
const sameFile = (a, b) => normRepoPath(a) === normRepoPath(b);
// 親のどれかがシンボリックリンク・ジャンクションか（短い名前の展開で誤判定しないよう、実パスの比較ではなく lstat で見る）
function linkAbove(p) {
  for (let d = path.dirname(p); ; ) {
    try { if (fs.lstatSync(d).isSymbolicLink()) return true; } catch { return false; }
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}
export const INDEX_NAME = '一覧.md';
// 表の 1 セルに収める（縦棒と改行で列・行が増えて「マスク未確認」の印がずれないように）
const cell = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '／');
export function copyFiles(items, filesDir, { include = [], exclude = [], read = fs.readFileSync } = {}) {
  const copied = [], skipped = [];
  let total = 0;
  const used = new Set([INDEX_NAME.toLowerCase()]); // 一覧の名前は予約する（同名の資料で上書きしない）
  for (const it of items) {
    const src = path.resolve(String(it.path || ''));
    const desc = cell(mask(String(it.desc || '')));
    const skip = (reason, size) => skipped.push({ src, desc, reason, size });
    if (exclude.some((x) => sameFile(x, src))) { skip('利用者が除外した'); continue; }
    const name = path.basename(src);
    if (SECRET_NAMES.some((re) => re.test(name.toLowerCase()))) { skip('秘密を含みうる名前'); continue; }
    let st;
    try { st = fs.lstatSync(src); } catch { skip('見つからない'); continue; }
    if (st.isSymbolicLink()) { skip('シンボリックリンク・ジャンクション'); continue; }
    if (linkAbove(src)) { skip('シンボリックリンク・ジャンクションの下'); continue; }
    if (!st.isFile()) { skip('ファイルではない'); continue; }
    if (st.size > LIMITS.fileBytes) { skip('1 ファイルの上限（10 MB）を超える', st.size); continue; }
    if (total + st.size > LIMITS.totalBytes) { skip('合計の上限（50 MB）を超える', st.size); continue; }
    let buf;
    try { buf = read(src); } catch (e) { skip('読めない（' + (e.code || e.message) + '）', st.size); continue; }
    const ext = path.extname(name).toLowerCase();
    let mark = '';
    if (IMAGE_EXT.has(ext)) mark = 'マスク未確認（画像）';
    else if (isUtf8Text(buf)) { const hits = scanText(buf.toString('utf8')); if (hits.length) { skip('中身に機微値の型が当たった（' + hits.join('・') + '）', st.size); continue; } }
    else if (include.some((x) => sameFile(x, src))) mark = 'マスク未確認（利用者が指定）';
    else { skip('中身を確かめられない形式（--include で写せる）', st.size); continue; }
    let rel = name, n = 2;
    while (used.has(rel.toLowerCase())) { rel = `${path.basename(name, ext)}-${n++}${ext}`; }
    const dest = path.join(filesDir, rel);
    if (path.relative(filesDir, dest).startsWith('..') || path.isAbsolute(path.relative(filesDir, dest))) { skip('写し先が files/ の外へ出る'); continue; }
    used.add(rel.toLowerCase());
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(dest, buf, { flag: 'wx' });
    total += st.size;
    copied.push({ src, rel, size: st.size, sha: crypto.createHash('sha256').update(buf).digest('hex'), desc, mark });
  }
  return { copied, skipped };
}
const homeRe = /^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/i;
export const showPath = (p) => mask(String(p).replace(homeRe, '<USERPROFILE>'));
export function renderIndex({ copied, skipped }) {
  const L = ['# 資料の一覧', '', '| 写し | 大きさ | SHA-256 | 説明 | 印 |', '|---|---|---|---|---|'];
  for (const c of copied) L.push(`| ${c.rel} | ${c.size} | ${c.sha.slice(0, 16)} | ${c.desc} | ${c.mark} |`);
  // 写さなかったものは、元のパス（顧客名などのフォルダ名を含みうる）を残さず、ファイル名だけを書く
  L.push('', '## 写さなかったもの', '', '| ファイル名 | 理由 | 説明 |', '|---|---|---|');
  for (const s of skipped) L.push(`| ${cell(mask(path.basename(s.src)))} | ${s.reason} | ${s.desc} |`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- 作る
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// Windows では書いた直後のファイル・フォルダをウイルス対策などが一時的に掴み、改名が EPERM・EBUSY になることがある。少し待ってやり直す
export function renameRetry(from, to, { tries = 10, waitMs = 100, rename = fs.renameSync } = {}) {
  for (let i = 0; ; i++) {
    try { rename(from, to); return; } catch (e) {
      if (i + 1 >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}
export function create(opts, { now = new Date(), base: baseIn = homeBase(), fault = () => {} } = {}) {
  const base = path.resolve(baseIn);
  const draft = (() => { try { return fs.readFileSync(opts.draft, 'utf8'); } catch (e) { throw new InputError('下書きを読めない（' + (e.code || e.message) + '）'); } })();
  const block = extractBlock(draft);
  if (block === null || !block.trim()) throw new InputError('下書きに再開用ブロック（' + BLOCK_START + ' 〜 ' + BLOCK_END + '）が無い');
  // 本文にも資料と同じ機微値の型を当てる（当たれば保存しない。LLM が伏せ直してやり直す）
  const draftHits = scanText(draft);
  if (draftHits.length) throw new InputError('下書きに機微値の型が当たった（' + draftHits.join('・') + '）。伏せてから作り直す');
  const items = opts.filesJson ? (() => { try { const a = JSON.parse(fs.readFileSync(opts.filesJson, 'utf8')); if (!Array.isArray(a)) throw new Error('配列ではない'); return a; } catch (e) { throw new InputError('資料の JSON を読めない（' + e.message + '）'); } })() : [];
  // 見出しに 1 行で書く値の検査（改行や --> を入れられると見出しの欄を差し替えられる）
  if (opts.sourceRef !== undefined && !/^[0-9a-f]{4,16}$/i.test(String(opts.sourceRef))) throw new InputError('--source-ref は 4〜16 桁の 16 進（ListAgents の [ref]）: ' + opts.sourceRef);
  if (opts.sourceName !== undefined && (/[\r\n]/.test(String(opts.sourceName)) || !String(opts.sourceName).trim() || String(opts.sourceName).length > 300)) throw new InputError('--source-name は改行を含まない 1〜300 文字');
  const unc = opts.uncopiedImages === undefined ? 0 : Number(opts.uncopiedImages);
  if (!Number.isInteger(unc) || unc < 0) throw new InputError('--uncopied-images は 0 以上の整数: ' + opts.uncopiedImages);
  const id = makeId(now, opts.title);
  // 保存先が git の作業ツリーの中だと、鍵や資料がコミットされうる
  if (gitInfo(fs.existsSync(base) ? base : path.dirname(base)).git) throw new InputError('保存先が git の作業ツリーの中にある（鍵や資料がコミットされうる）。リポジトリの外を --base に渡す: ' + showPath(base));
  fs.mkdirSync(base, { recursive: true });
  const key = loadKey(base, { create: true });
  const final = path.join(base, id), partial = final + '.partial';
  if (fs.existsSync(final) || fs.existsSync(partial)) throw new InputError('同じ ID の引き継ぎが既にある（上書きしない）: ' + id);
  const gi = gitInfo(opts.repo || process.cwd());
  const res = { id, dir: final, stage: 0, copied: [], skipped: [], pointer: null, notes: [] };
  const fail = (stage, e) => ({ ...res, ok: false, stage, state: stage <= 3 ? partial : final, error: String((e && e.message) || e) });
  // 段 1: 作りかけのフォルダと資料
  try {
    fault(1);
    fs.mkdirSync(partial);
    if (items.length) {
      const filesDir = path.join(partial, 'files');
      fs.mkdirSync(filesDir, { recursive: true }); // すべて写さなかったときも一覧は書く
      const r = copyFiles(items, filesDir, { include: opts.include || [], exclude: opts.exclude || [] });
      res.copied = r.copied; res.skipped = r.skipped;
      fs.writeFileSync(path.join(filesDir, INDEX_NAME), renderIndex(r), { flag: 'wx' });
    }
  } catch (e) { return fail(1, e); }
  const uncopied = res.skipped.length + unc;
  const h = { 'handoff-id': id, created: now.toISOString(), git: gi.git ? 'yes' : 'none', 'key-id': keyId(key), uncopied, notify: opts.noNotify ? 'off' : 'on' };
  if (gi.git) Object.assign(h, { 'repo-key': hmac(key, 'repo', normRepoPath(gi.common)), 'branch-key': hmac(key, 'branch', gi.branch), head: gi.head, 'tree-state': gi.materialOk ? hmac(key, 'tree', gi.material) : 'unavailable' });
  else h['dir-key'] = hmac(key, 'dir', normRepoPath(opts.repo || process.cwd())); // git の外でも場所だけは照合する
  if (opts.sourceRef && opts.sourceName) Object.assign(h, { 'source-ref': opts.sourceRef, 'source-name-key': nameKey(key, opts.sourceName) });
  // 段 2: 本文を一時名で書き、読み直してから置き換える
  try {
    fault(2);
    const text = renderHeader(h) + '\n\n# 引き継ぎ ' + id + '\n\n' + draft.replace(/^\uFEFF/, '');
    const tmp = path.join(partial, 'handoff.md.tmp');
    fs.writeFileSync(tmp, text);
    const back = fs.readFileSync(tmp, 'utf8');
    const hb = parseHeader(back);
    if (!hb || hb['handoff-id'] !== id || extractBlock(back) !== block) throw new CheckError('読み直した本文が書いたものと違う');
    renameRetry(tmp, path.join(partial, 'handoff.md'));
  } catch (e) { return fail(2, e); }
  // 段 3: 完成の印（改名）
  try { fault(3); renameRetry(partial, final); } catch (e) { return fail(3, e); }
  // 段 4: ポインタ（本文の絶対パス 1 行）
  const target = path.join(final, 'handoff.md');
  const ptr = path.join(base, 'latest_handoff.txt');
  try {
    fault(4);
    const tmp = ptr + '.tmp-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, target + '\n');
    try { renameRetry(tmp, ptr, { tries: 3 }); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 残っても次の check が見つける */ } throw e; }
    fault(4.5);
    const now2 = fs.readFileSync(ptr, 'utf8').replace(/\r?\n$/, '');
    if (now2 === target) res.pointer = 'updated';
    else if (/[\\/]handoff\.md$/.test(now2) && fs.existsSync(now2) && !path.dirname(now2).endsWith('.partial')) { res.pointer = 'other'; res.notes.push('ポインタは別の引き継ぎ（' + path.basename(path.dirname(now2)) + '）が後から更新した'); }
    else throw new CheckError('ポインタを読み直すと違う値になっている');
  } catch (e) { const r = fail(4, e); r.ok = true; r.pointer = 'failed'; r.notes = [...res.notes, 'ポインタを更新できなかった（引き継ぎは完成している。ID で読み込める）: ' + r.error]; delete r.error; r.uncopied = uncopied; r.line = takeoverLine(id, base); return r; }
  res.draftRemoved = removeDrafts(base, [opts.draft, opts.filesJson]);
  return { ...res, ok: true, stage: 4, uncopied, line: takeoverLine(id, base), file: target };
}
// 新しいセッションで打つ 1 行。既定でない保存先なら --base も入れる（Ctrl+V → Enter だけで読めるように）
export function takeoverLine(id, base) {
  return normRepoPath(base) === normRepoPath(homeBase()) ? '/ut-takeover ' + id : `/ut-takeover ${id} --base "${path.resolve(base)}"`;
}
// 下書きを消す（保存先の .drafts/ の中にあるものだけ。外の下書きは消さない）
export function removeDrafts(base, files) {
  const dir = normRepoPath(path.join(base, '.drafts'));
  const removed = [];
  for (const f of files.filter(Boolean)) {
    const p = path.resolve(f);
    if (normRepoPath(path.dirname(p)) !== dir) continue;
    try { fs.unlinkSync(p); removed.push(path.basename(p)); } catch { /* 消せなくても完成は変わらない */ }
  }
  return removed;
}

// ---------------------------------------------------------------- 候補・照合
function completed(base) {
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!ID_RE.test(n)) continue;
    const f = path.join(base, n, 'handoff.md');
    try { // 読めない 1 件で走査全体を止めない
      if (!isDir(path.join(base, n)) || !fs.statSync(f).isFile()) continue;
      const h = parseHeader(readHead(f));
      if (h) out.push({ id: n, file: f, h });
    } catch { /* 読めないものは候補にしない */ }
  }
  return out;
}
function currentKeys(key, repo) {
  const gi = gitInfo(repo);
  if (!gi.git) return { gi, git: false, dirKey: hmac(key, 'dir', normRepoPath(repo)) };
  return { gi, git: true, repoKey: hmac(key, 'repo', normRepoPath(gi.common)), branchKey: hmac(key, 'branch', gi.branch), tree: gi.materialOk ? hmac(key, 'tree', gi.material) : 'unavailable' };
}
export function list({ base = homeBase(), repo = process.cwd(), now = new Date() } = {}) {
  const key = loadKey(base);
  if (!key) throw new CheckError('鍵が無い（まだ /ut-handoff で引き継ぎを作っていないか、消された）: ' + keyPath(base));
  const kid = keyId(key);
  const cur = currentKeys(key, repo);
  const since = now.getTime() - LIMITS.listDays * 864e5;
  const match = completed(base).filter((x) => x.h['key-id'] === kid && Date.parse(x.h.created) >= since)
    .filter((x) => cur.git ? x.h.git === 'yes' && x.h['repo-key'] === cur.repoKey && x.h['branch-key'] === cur.branchKey : x.h.git === 'none' && x.h['dir-key'] === cur.dirKey)
    .sort((a, b) => Date.parse(b.h.created) - Date.parse(a.h.created));
  return { items: match.slice(0, LIMITS.listMax).map((x) => ({ id: x.id, created: x.h.created, head: x.h.head || '', uncopied: Number(x.h.uncopied || 0) })), more: Math.max(0, match.length - LIMITS.listMax) };
}
// 旧形式の貼り付けブロック（最初のコードブロック）。開きの囲みと同じ文字で、同じ長さ以上の閉じまでを取る（4 個の囲みの中の 3 個で切らない）
export function firstFence(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!m) continue;
    const ch = m[1][0], len = m[1].length;
    const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
    for (let j = i + 1; j < lines.length; j++) if (close.test(lines[j])) return lines.slice(i + 1, j).join('\n');
    return lines.slice(i + 1).join('\n');
  }
  return lines.slice(0, 80).join('\n');
}
export function verify(id, { base = homeBase(), repo = process.cwd(), accept = {} } = {}) {
  const r = resolveId(base, id);
  const out = { id, ok: false, stops: [], warns: [], notes: [], block: '', filesIndex: '', notice: null };
  if (r.kind === 'legacy') {
    const text = fs.readFileSync(r.file, 'utf8');
    if (!accept.legacy) {
      const hints = text.split(/\r?\n/).filter((l) => /リポジトリ|ブランチ|repo|branch/i.test(l)).slice(0, 5).map((l) => mask(l.trim()).slice(0, 160));
      out.stops.push('旧形式の引き継ぎ（照合の見出しが無い）。確かめてから --accept-legacy を付けて打ち直す');
      out.legacy = { modified: fs.statSync(r.file).mtime.toISOString(), hints };
      return out;
    }
    out.notes.push('旧形式のため照合を省いた');
    out.block = firstFence(text);
    out.ok = true;
    return out;
  }
  const text = fs.readFileSync(r.file, 'utf8');
  const h = parseHeader(text);
  if (!h || !['yes', 'none'].includes(h.git) || !h['handoff-id'] || h['handoff-id'] !== id || !/^\d+$/.test(String(h.uncopied || ''))) { out.stops.push('見出しが壊れている（git の欄・ID・写せなかった件数が無い、または合わない）'); return out; }
  const block = extractBlock(text);
  if (block === null || !block.trim()) { out.stops.push('再開用ブロックが無い・空（本文が途中で切れている可能性がある）。読み込まない'); return out; }
  const key = loadKey(base);
  const skipped = []; // 照合を省いた理由（受領通知で「閉じてよい」にしない）
  if (!key) {
    if (!accept.legacy) { out.stops.push('鍵が無いため照合できない（入口は鍵を作らない）: ' + showPath(keyPath(base)) + '。中身を確かめてから --accept-legacy で照合を省いて読める'); return out; }
    skipped.push('鍵が無いため照合を省いた');
  } else if (h['key-id'] !== keyId(key)) {
    if (!accept.legacy) { out.stops.push('鍵が違う（作り直された）ため照合できない。確かめてから --accept-legacy で照合を省いて読める'); return out; }
    skipped.push('鍵が違うため照合を省いた');
  } else if (h.git === 'none') {
    const cur = currentKeys(key, repo);
    if (cur.git || h['dir-key'] !== cur.dirKey) { if (accept.repo) out.warns.push('作った場所と違う（--accept-repo で続けた）'); else out.stops.push('引き継ぎを作った場所（git の外）と今の場所が違う。作った場所で `/ut-takeover ' + id + '` を打つ（意図して別の場所で続けるなら --accept-repo）'); }
    else out.notes.push('git の外の引き継ぎ。場所だけを照合した');
    const newer = completed(base).filter((x) => x.id !== id && x.h['key-id'] === h['key-id'] && x.h.git === 'none' && x.h['dir-key'] === h['dir-key'] && Date.parse(x.h.created) > Date.parse(h.created));
    if (newer.length) { const ids = newer.map((x) => x.id).sort().reverse(); if (accept.older) out.warns.push('より新しい引き継ぎがある（--accept-older で続けた）: ' + ids[0]); else out.stops.push('同じ場所に、より新しい引き継ぎがある: ' + ids.join(', ') + '（古い方で続けるなら --accept-older）'); }
  } else {
    const cur = currentKeys(key, repo);
    if (!cur.git) out.stops.push('今の場所は git のリポジトリではない（引き継ぎはリポジトリで作られた）。引き継ぎを作ったリポジトリのウィンドウ・フォルダで `/ut-takeover ' + id + '` を打つ。git の外では照合できないので --accept-repo でも続かない。ここで続けるなら貼り付けブロックを使う');
    else {
      if (h['repo-key'] !== cur.repoKey) { if (accept.repo) out.warns.push('リポジトリが違う（--accept-repo で続けた）'); else out.stops.push('リポジトリが違う。正しいウィンドウ・フォルダで `/ut-takeover ' + id + '` を打つ（意図して別のリポジトリで続けるなら --accept-repo）'); }
      if (h['branch-key'] !== cur.branchKey) { if (accept.branch) out.warns.push('ブランチが違う（--accept-branch で続けた）'); else out.stops.push('ブランチが違う。引き継ぎを作ったブランチに切り替えて `/ut-takeover ' + id + '` を打ち直す／worktree など意図して別ブランチで続けるなら --accept-branch／貼り付けブロックを使う'); }
      if (h.head !== cur.gi.head) {
        if (h.head !== 'none' && isAncestor(cur.gi.root, h.head)) out.warns.push(`HEAD が進んでいる（引き継ぎ時 ${h.head} → 今 ${cur.gi.head}）`);
        else if (accept.head) out.warns.push(`HEAD が違う（引き継ぎ時 ${h.head}・今 ${cur.gi.head}。--accept-head で続けた）`);
        else out.stops.push(`HEAD が違い、引き継ぎ時の HEAD（${h.head}）が今の祖先ではない。確かめてから --accept-head`);
      }
      if (h['tree-state'] === 'unavailable' || cur.tree === 'unavailable') out.warns.push('作業ツリーの状態を取れなかった（照合できない）');
      else if (h['tree-state'] !== cur.tree) out.warns.push('作業ツリーの状態が引き継ぎ時と違う（未コミットの変更が別のセッションに残っている可能性がある）');
      const newer = completed(base).filter((x) => x.id !== id && x.h['key-id'] === h['key-id'] && x.h['repo-key'] === h['repo-key'] && x.h['branch-key'] === h['branch-key'] && Date.parse(x.h.created) > Date.parse(h.created));
      if (newer.length) { const ids = newer.map((x) => x.id).sort().reverse(); if (accept.older) out.warns.push('より新しい引き継ぎがある（--accept-older で続けた）: ' + ids[0]); else out.stops.push('同じリポジトリ・ブランチに、より新しい引き継ぎがある: ' + ids.join(', ') + '（古い方で続けるなら --accept-older）'); }
    }
  }
  if (out.stops.length) return out;
  out.notes.push(...skipped);
  out.ok = true;
  out.block = block;
  try { out.filesIndex = fs.readFileSync(path.join(r.dir, 'files', INDEX_NAME), 'utf8'); } catch { /* 資料なし */ }
  const uncopied = Number(h.uncopied);
  if (h.notify !== 'off' && h['source-ref'] && h['source-name-key']) {
    const issues = [...skipped.map((s) => s.replace(/ため照合を省いた$/, '照合を省いた')), ...out.warns.map((w) => w.split('（')[0]), ...(uncopied ? [`写せなかった資料 ${uncopied} 件`] : [])];
    const summary = issues.join('・').slice(0, 80);
    const message = issues.length
      ? `/ut-handoff の受領通知: ${id} を受け取ったが、${summary} がある。作業は不要です。利用者に『${id} は受け取られたが、${summary} の確認が済むまでこのセッションは閉じないで』と伝えてください。`
      : `/ut-handoff の受領通知: ${id} を受け取り、照合は OK。作業は不要です。利用者に『${id} は引き継ぎ済み。このセッションは閉じてよい』と伝えてください。`;
    out.notice = { sourceRef: h['source-ref'], message: message.slice(0, LIMITS.noticeChars) };
  } else out.notes.push(h.notify === 'off' ? '受領通知は作成元が断った（--no-notify）' : '作成元のセッションが記録されていない（受領通知なし）');
  return out;
}
export function peer(id, name, { base = homeBase() } = {}) {
  const r = resolveId(base, id);
  if (r.kind !== 'new') return { match: false, reason: '旧形式には作成元の記録が無い' };
  const h = parseHeader(readHead(r.file));
  const key = loadKey(base);
  if (!h || !key || !h['source-name-key']) return { match: false, reason: '作成元の記録・鍵が無い' };
  if (h.notify === 'off') return { match: false, reason: '作成元が受領通知を断った（--no-notify）' }; // verify の notice と同じ条件で断る
  return { match: nameKey(key, name) === h['source-name-key'] };
}

// ---------------------------------------------------------------- 後片付け
export function check({ base = homeBase(), now = new Date() } = {}) {
  let names = [];
  try { names = fs.readdirSync(base); } catch { return { candidates: [] }; }
  let pointed = '';
  try { pointed = path.dirname(fs.readFileSync(path.join(base, 'latest_handoff.txt'), 'utf8').replace(/\r?\n$/, '')); } catch { /* ポインタなし */ }
  const out = [];
  for (const n of names) {
    const p = path.join(base, n);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (n.endsWith('.partial') && ID_RE.test(n.slice(0, -8))) { if (now - st.mtimeMs > LIMITS.partialHours * 36e5) out.push({ name: n, reason: '作りかけ（24 時間以上更新なし）' }); continue; }
    if (!ID_RE.test(n) || sameFile(p, pointed)) continue;
    let created = st.mtimeMs;
    try { const h = parseHeader(readHead(path.join(p, 'handoff.md'))); if (h && Date.parse(h.created)) created = Date.parse(h.created); } catch { /* 見出しが読めなければ更新日時 */ }
    if (now - created > LIMITS.keepDays * 864e5) out.push({ name: n, reason: '作成から 30 日を過ぎた' });
  }
  // 失敗で残った下書き（.drafts/ の中。24 時間以上更新なし）
  try {
    for (const n of fs.readdirSync(path.join(base, '.drafts'))) {
      const st = fs.lstatSync(path.join(base, '.drafts', n));
      if (st.isFile() && now - st.mtimeMs > LIMITS.partialHours * 36e5) out.push({ name: '.drafts/' + n, reason: '残った下書き（24 時間以上更新なし）' });
    }
  } catch { /* 下書きの置き場なし */ }
  return { candidates: out };
}
export function prune({ base = homeBase(), now = new Date(), apply = false } = {}) {
  const { candidates } = check({ base, now });
  if (!apply) return { removed: [], candidates };
  const removed = [];
  const realBase = fs.realpathSync.native(base);
  for (const c of candidates) {
    const p = path.join(base, c.name);
    const real = fs.realpathSync.native(p);
    const parent = c.name.startsWith('.drafts/') ? path.join(realBase, '.drafts') : realBase;
    if (path.relative(realBase, real).startsWith('..') || path.dirname(real) !== parent) continue; // 保存先の直下（下書きは .drafts/ の直下）だけ
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(c.name);
  }
  return { removed, candidates };
}

// ---------------------------------------------------------------- クリップボード・リンク
// Git Bash（MSYS）は、ネイティブの exe に渡す引数のうち / で始まるものを Unix のパスとみなして書き換える
// （"/ut-takeover X" → "C:/Program Files/Git/ut-takeover X"。--base "C:\…" が入ると : を区切りとみなし ; や \ まで変わる。実測 2026-10-19）。
// そのため手順は --id で渡し、1 行は部品の中で組み立てる（シェルを通るのは ID とパスだけ）。--text で受けた 1 行は形を検査し、
// 壊れていれば入れずに理由を返す（以前は壊れた 1 行を黙って入れ、ok: true を返していた）
const LINE_RE = /^\/ut-takeover (\S+)(?: --base "([^"]+)")?$/;
export function checkLine(text, platform = process.platform) {
  const s = String(text ?? '');
  const m = LINE_RE.exec(s);
  // win32 は、ドライブ名つき（C:\ か C:/）か UNC（\\ で始まる）だけ。path.win32.isAbsolute は、ドライブ名の無い "\foo"・"/tmp/x" も絶対とみなし、
  // 受け取った側の現在のドライブからの相対位置に解決されて保存先がずれる
  const isAbsolute = platform === 'win32' ? (p) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(p) && path.win32.isAbsolute(p) : path.posix.isAbsolute;
  if (m && ID_RE.test(m[1]) && (m[2] === undefined || isAbsolute(m[2]))) return null;
  const msys = /^[A-Za-z]:[\\/]/.test(s) || /Program Files[\\/]Git/i.test(s);
  return (msys ? 'シェル（Git Bash）のパスの変換で 1 行が壊れている（/ で始まる引数が Windows のパスに書き換えられた）。--id <ID> で渡す'
    : '1 行の形が違う（/ut-takeover <ID> [--base "<絶対パス>"] の形だけを受け付ける）') + ': ' + JSON.stringify(s.slice(0, 200));
}
// 書いた後に読み戻す道具。読み戻して違えば入れたと報告しない（文字コードの取り違え・別の書き込み）
const PASTE = {
  win32: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw']]],
  darwin: [['pbpaste', []]],
  other: [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']]],
};
const runTool = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true });
export function clip(text, { platform = process.platform, run = runTool } = {}) {
  const bad = checkLine(text, platform);
  if (bad) return { ok: false, reason: bad };
  // Windows は PowerShell の Set-Clipboard で入れる。値は Base64 で渡し、中で UTF-8 から戻す（文字コード・引用符に左右されない）。
  // clip.exe は標準入力をコンソールのコードページで読み（日本語が化ける）、BOM を付けると BOM を文字として残す（実機 2026-10-19）ので予備にする
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const tools = platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`]], ['clip.exe', []]]
    : platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  for (const [cmd, args] of tools) {
    // clip.exe は日本語を化けさせ、読み戻す道具（PowerShell）が使えないときは確かめられない。呼んだ後に断ると、化けた 1 行が利用者のクリップボードに残る
    if (cmd === 'clip.exe' && /[^\x00-\x7f]/.test(text)) return { ok: false, tool: cmd, verified: false, reason: 'PowerShell が使えず、clip.exe の予備では非 ASCII の文字が化けうるので、クリップボードには入れていない（表示した 1 行を打つ）' };
    const r = run(cmd, args, cmd === 'powershell.exe' ? undefined : text);
    if (!r || r.status !== 0) continue;
    for (const [pc, pa] of PASTE[platform === 'win32' || platform === 'darwin' ? platform : 'other']) {
      const p = run(pc, pa);
      if (!p || p.status !== 0 || typeof p.stdout !== 'string') continue;
      const got = p.stdout.replace(/\r?\n$/, '');
      return got === text ? { ok: true, tool: cmd, verified: true }
        : { ok: false, tool: cmd, reason: '書いた後に読み戻すと違う中身だった（文字コードの取り違え、または別の書き込み）: ' + JSON.stringify(got.slice(0, 200)) };
    }
    return { ok: true, tool: cmd, verified: false, note: '読み戻す道具が使えず、入った中身は確かめていない（' + PASTE[platform === 'win32' || platform === 'darwin' ? platform : 'other'].map((t) => t[0]).join('・') + '）' };
  }
  return { ok: false, reason: 'クリップボードの道具が使えない（' + tools.map((t) => t[0]).join('・') + '）' };
}
export const link = (text) => 'vscode://anthropic.claude-code/open?prompt=' + encodeURIComponent(text);
// clip・link に渡す 1 行: --id なら保存先の引き継ぎを確かめて部品の中で組み立てる。--text なら受けた 1 行（clip・link が形を検査する）
export function lineFrom({ id, text }, base) {
  if ((id === undefined) === (text === undefined)) throw new InputError('--id か --text のどちらか一方を渡す（手順からは --id。--text は手で打つとき）');
  if (text !== undefined) return text;
  if (!ID_RE.test(id)) throw new InputError('ID の形が違う: ' + JSON.stringify(String(id).slice(0, 80)) + '（Git Bash のパスの変換を受けていないかも確かめる）');
  if (!fs.existsSync(path.join(base, id, 'handoff.md'))) throw new CheckError(`引き継ぎ ${id} が保存先（${base}）に無い。--base の指定を確かめる`);
  return takeoverLine(id, base);
}

// ---------------------------------------------------------------- CLI
function arg(argv, name) { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new InputError(name + ' に値が無い'); return v; }
const has = (argv, name) => argv.includes(name);
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
// サブコマンドごとのオプションと、値を取るかどうかの正本。以前は使えるオプションとフラグを別々の一覧で持ち、
// 新しいフラグを片方へ足し忘れると、その次の余分な語を値として読み飛ばし得た。
const SUB_SPEC = {
  create: { values: ['--draft', '--title', '--files-json', '--include', '--exclude', '--source-name', '--source-ref', '--uncopied-images', '--repo', '--base'], flags: ['--no-notify'] },
  list: { values: ['--repo', '--base'], flags: [] },
  verify: { values: ['--id', '--repo', '--base'], flags: ['--accept-head', '--accept-repo', '--accept-branch', '--accept-legacy', '--accept-older'] },
  peer: { values: ['--id', '--name', '--base'], flags: [] },
  check: { values: ['--base'], flags: [] }, prune: { values: ['--base'], flags: ['--apply'] },
  clip: { values: ['--id', '--text', '--base'], flags: [] }, link: { values: ['--id', '--text', '--base'], flags: [] },
};
export const SUB_OPTS = Object.fromEntries(Object.entries(SUB_SPEC).map(([cmd, s]) => [cmd, [...s.values, ...s.flags]]));
const SUB_FLAGS = new Set(Object.values(SUB_SPEC).flatMap((s) => s.flags));
export function checkSubOpts(cmd, rest) {
  const ok = SUB_OPTS[cmd];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const a = String(rest[i]);
    if (!a.startsWith('--')) throw new InputError(`余分な引数: ${a}（${cmd} の引数はすべて --名前 <値> の形で渡す。値に空白があれば引用符で囲む）`);
    if (!ok.includes(a)) {
      const other = Object.keys(SUB_OPTS).filter((k) => SUB_OPTS[k].includes(a));
      throw new InputError(`知らないオプション: ${a}（${other.length ? other.join('・') + ' のオプション。' : ''}${cmd} で使えるのは ${ok.join('・')}）`);
    }
    if (seen.has(a)) throw new InputError(`${a} を 2 回指定した（どちらの値か決められない）`);
    seen.add(a);
    if (!SUB_FLAGS.has(a) && i + 1 < rest.length && !String(rest[i + 1]).startsWith('--')) i++;
  }
}
export function main(argv) {
  const out = (o) => console.log(JSON.stringify(o, null, 1));
  try {
    const cmd = argv[0];
    if (Object.hasOwn(SUB_OPTS, cmd)) checkSubOpts(cmd, argv.slice(1));
    const base = path.resolve(arg(argv, '--base') || homeBase()); // 相対パスのままポインタに書かないよう絶対パスにする
    const repo = arg(argv, '--repo') || process.cwd();
    if (cmd === 'create') {
      if (Boolean(arg(argv, '--source-name')) !== Boolean(arg(argv, '--source-ref'))) throw new InputError('--source-name と --source-ref は両方そろえて渡す');
      const r = create({ draft: arg(argv, '--draft'), title: arg(argv, '--title'), filesJson: arg(argv, '--files-json'), include: csv(arg(argv, '--include')), exclude: csv(arg(argv, '--exclude')), noNotify: has(argv, '--no-notify'), sourceName: arg(argv, '--source-name'), sourceRef: arg(argv, '--source-ref'), uncopiedImages: arg(argv, '--uncopied-images'), repo }, { base });
      out(r); return r.ok ? 0 : 1;
    }
    if (cmd === 'list') { out(list({ base, repo })); return 0; }
    if (cmd === 'verify') { const r = verify(arg(argv, '--id'), { base, repo, accept: { head: has(argv, '--accept-head'), repo: has(argv, '--accept-repo'), branch: has(argv, '--accept-branch'), legacy: has(argv, '--accept-legacy'), older: has(argv, '--accept-older') } }); out(r); return r.ok ? 0 : 1; }
    if (cmd === 'peer') { out(peer(arg(argv, '--id'), arg(argv, '--name'), { base })); return 0; }
    if (cmd === 'check') { out(check({ base })); return 0; }
    if (cmd === 'prune') { out(prune({ base, apply: has(argv, '--apply') })); return 0; }
    if (cmd === 'clip') { const line = lineFrom({ id: arg(argv, '--id'), text: arg(argv, '--text') }, base); const r = clip(line); out({ ...r, line }); return r.ok ? 0 : 1; }
    if (cmd === 'link') {
      const line = lineFrom({ id: arg(argv, '--id'), text: arg(argv, '--text') }, base);
      const bad = checkLine(line);
      if (bad) { out({ ok: false, reason: bad, line }); return 1; }
      out({ ok: true, url: link(line), line, vscode: process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode' }); return 0;
    }
    throw new InputError('使い方: node ut-handoff.mjs create|list|verify|peer|check|prune|clip|link …（冒頭のコメント）');
  } catch (e) {
    console.log((e instanceof CheckError ? '検査で止めた: ' : e instanceof InputError ? '入力の誤り: ' : '中断: ') + e.message);
    return e instanceof InputError ? 2 : 1;
  }
}

// ---------------------------------------------------------------- selftest
async function selftest() {
  const results = [];
  // 実施できなかった試験は skip(理由) を返す。パスに数えず、省略として別に数える（文字列を返しても、パスに数えられてしまう）
  const skip = (reason) => ({ __skip: String(reason) });
  const t = (name, fn) => { try { const r = fn(); if (r && typeof r === 'object' && r.__skip) results.push({ ok: true, skipped: true, name, m: '省略: ' + r.__skip }); else results.push({ ok: true, name, m: r || '' }); } catch (e) { results.push({ ok: false, name, m: String((e && e.message) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const throwsLike = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(m + '（別の理由: ' + e.message + '）'); } throw new Error(m); };
  // 日本語と括弧を含む場所で試す（利用者のホームと同じ形）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-handoff-試験(a)-'));
  const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t' + '@' + 't.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  const mkRepo = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'c1'); return d; };
  let seq = 0;
  const draftFile = (body = '本文') => { const f = path.join(tmp, `draft-${seq++}.md`); fs.writeFileSync(f, `${BLOCK_START}\n再開: 次は試験\n${BLOCK_END}\n\n${body}\n`); return f; };
  const at = (s) => new Date(Date.parse('2026-10-16T10:00:00') + s * 1000);
  try {
    const base = path.join(tmp, 'store');
    const repo = mkRepo('repo');
    t('[H01] ID: 形と検査（..・\\・/・: を拒む、旧形式のファイル名は受ける、無い ID は拒む）', () => {
      assert(makeId(at(0), 'abc-1') === '20261016-100000-abc-1', makeId(at(0), 'abc-1'));
      throwsLike(() => makeId(at(0), 'ABC'), /英小文字/, '大文字を通した');
      throwsLike(() => makeId(at(0), 'a/b'), /英小文字/, 'スラッシュを通した');
      fs.mkdirSync(base, { recursive: true });
      for (const bad of ['..\\x', '../x', 'a/b', 'C:x', '..']) throwsLike(() => resolveId(base, bad), /使えない文字/, '外を指す ID を通した: ' + bad);
      fs.writeFileSync(path.join(base, 'handoff_2026-09-28_旧形式.md'), '旧');
      assert(resolveId(base, 'handoff_2026-09-28_旧形式').kind === 'legacy', '旧形式を受けない');
      throwsLike(() => resolveId(base, '20261016-100000-none'), /見つからない/, '無い ID を通した');
    });
    t('[H02] 鍵: create だけが作る。list・verify・peer は作らない', () => {
      const b = path.join(tmp, 'nokey');
      fs.mkdirSync(b);
      throwsLike(() => list({ base: b, repo }), /鍵が無い/, 'list が鍵なしで進んだ');
      assert(!fs.existsSync(keyPath(b)), 'list が鍵を作った');
      assert(loadKey(b) === null && !fs.existsSync(keyPath(b)), 'loadKey が鍵を作った');
      const k = loadKey(b, { create: true });
      assert(k && k.length === 32 && fs.existsSync(keyPath(b)), '鍵を作れない');
      assert(loadKey(b).equals(k), '読み直した鍵が違う');
    });
    t('[H03] 照合用の値: 生の値を書かない。大文字・小文字だけ違うブランチは別の鍵。名前の鍵は作る側と読む側で同じ', () => {
      const k = crypto.randomBytes(32);
      assert(hmac(k, 'branch', 'Feature') !== hmac(k, 'branch', 'feature'), '大文字・小文字の違うブランチが同じ鍵');
      assert(nameKey(k, ' ut-commands-d9 ') === nameKey(k, 'ut-commands-d9'), '前後の空白で名前の鍵が変わる（陽性対照）');
      assert(nameKey(k, 'ut-commands-d9') !== nameKey(k, 'ut-commands-d8'), '1 文字違う名前が同じ鍵');
      assert(hmac(k, 'repo', 'x') !== hmac(crypto.randomBytes(32), 'repo', 'x'), '鍵が違っても同じ値（塩が効いていない）');
      assert(normRepoPath('C:\\Users\\試験(a)\\R', 'win32') === normRepoPath('c:/users/試験(a)/r', 'win32'), 'Windows の区切り・大文字小文字で一致しない');
      assert(normRepoPath('/home/A', 'linux') !== normRepoPath('/home/a', 'linux'), 'Linux で大文字・小文字をそろえた');
    });
    let first;
    t('[H04] 作る: 見出し・再開用ブロック・ポインタ（本文の絶対パス 1 行）。生のパス・ブランチ名・名前を書かない', () => {
      const r = create({ draft: draftFile(), title: 'first', repo, sourceName: 'ut-commands-d9', sourceRef: '00238c' }, { base, now: at(0) });
      assert(r.ok && r.stage === 4 && r.pointer === 'updated', JSON.stringify(r));
      first = r.id;
      const text = fs.readFileSync(r.file, 'utf8');
      const h = parseHeader(text);
      for (const k of ['handoff-id', 'created', 'git', 'key-id', 'repo-key', 'branch-key', 'head', 'tree-state', 'source-ref', 'source-name-key', 'uncopied', 'notify']) assert(h[k] !== undefined, '見出しに無い: ' + k);
      assert(/^[0-9a-f]{12}$/.test(h.head), 'head が短い SHA ではない: ' + h.head);
      assert(!text.includes('ut-commands-d9') && !text.includes('main') && !text.includes(repo), '生の値が見出しにある');
      assert(extractBlock(text) === '再開: 次は試験', '再開用ブロックが違う');
      assert(fs.readFileSync(path.join(base, 'latest_handoff.txt'), 'utf8') === r.file + '\n', 'ポインタの中身が規約と違う');
      assert(!fs.existsSync(r.dir + '.partial'), '作りかけが残った');
      throwsLike(() => create({ draft: draftFile(), title: 'first', repo }, { base, now: at(0) }), /既にある/, '同じ ID を上書きした');
    });
    t('[H05] 読む: 同じ場所なら照合 OK・受領通知の文面（閉じてよい）・peer の名前の照合（陽性対照と 1 文字違い）', () => {
      const v = verify(first, { base, repo });
      assert(v.ok && !v.stops.length && !v.warns.length, JSON.stringify(v));
      assert(v.block === '再開: 次は試験' && v.notice && v.notice.sourceRef === '00238c' && /閉じてよい/.test(v.notice.message) && v.notice.message.length <= LIMITS.noticeChars, JSON.stringify(v.notice));
      assert(peer(first, 'ut-commands-d9', { base }).match === true, '同じ名前が一致しない（陽性対照）');
      assert(peer(first, 'ut-commands-d8', { base }).match === false, '違う名前が一致した');
    });
    t('[H06] 照合: ブランチが違えば止める（--accept-branch で続く）・切り離し同士は一致・片方だけ切り離しは不一致', () => {
      g(repo, 'checkout', '-q', '-b', 'other');
      const v = verify(first, { base, repo });
      assert(!v.ok && v.stops.some((s) => /ブランチが違う/.test(s)), JSON.stringify(v.stops));
      assert(verify(first, { base, repo, accept: { branch: true } }).ok, '--accept-branch で続かない');
      g(repo, 'checkout', '-q', '--detach');
      const d = create({ draft: draftFile(), title: 'detached', repo }, { base, now: at(10) });
      assert(d.ok && parseHeader(fs.readFileSync(d.file, 'utf8')).head.length === 12, '切り離しで head が SHA にならない');
      assert(verify(d.id, { base, repo }).ok, '切り離し同士が一致しない');
      g(repo, 'checkout', '-q', 'main');
      assert(verify(d.id, { base, repo }).stops.some((s) => /ブランチが違う/.test(s)), '片方だけ切り離しが一致した');
    });
    t('[H07] 照合: HEAD が進んだら警告して続ける。祖先でなければ止める（--accept-head で続く）', () => {
      const b = path.join(tmp, 'store-head');
      const r2 = mkRepo('repo-head');
      const c = create({ draft: draftFile(), title: 'head', repo: r2, sourceName: 'src', sourceRef: 'abcdef' }, { base: b, now: at(0) });
      assert(/閉じてよい/.test(verify(c.id, { base: b, repo: r2 }).notice.message), '警告が無いのに閉じてよいと伝えない（陽性対照）');
      fs.writeFileSync(path.join(r2, 'b.txt'), 'b\n'); g(r2, 'add', '.'); g(r2, 'commit', '-q', '-m', 'c2');
      const v = verify(c.id, { base: b, repo: r2 });
      assert(v.ok && v.warns.some((w) => /HEAD が進んで/.test(w)), JSON.stringify(v));
      assert(v.notice && /閉じないで/.test(v.notice.message) && !/閉じてよい/.test(v.notice.message), '警告があるのに閉じてよいと伝える: ' + JSON.stringify(v.notice));
      g(r2, 'reset', '-q', '--hard', 'HEAD~1'); fs.writeFileSync(path.join(r2, 'c.txt'), 'c\n'); g(r2, 'add', '.'); g(r2, 'commit', '-q', '-m', 'c3');
      g(r2, 'reflog', 'expire', '--expire=now', '--all');
      const hh = parseHeader(fs.readFileSync(path.join(b, c.id, 'handoff.md'), 'utf8')).head;
      // 引き継ぎ時の HEAD（c1）は今の祖先なので警告。祖先でない HEAD を見出しに作って止まることを見る
      const f = path.join(b, c.id, 'handoff.md');
      const txt = fs.readFileSync(f, 'utf8');
      const fake = '0123456789ab';
      fs.writeFileSync(f, txt.replace('head: ' + hh, 'head: ' + fake));
      const v2 = verify(c.id, { base: b, repo: r2 });
      assert(!v2.ok && v2.stops.some((s) => /祖先ではない/.test(s)), JSON.stringify(v2.stops));
      assert(verify(c.id, { base: b, repo: r2, accept: { head: true } }).ok, '--accept-head で続かない');
    });
    t('[H08] 照合: リポジトリが違えば止める（--accept-repo）。worktree は同じリポジトリ', () => {
      const other = mkRepo('repo-other');
      const v = verify(first, { base, repo: other });
      assert(!v.ok && v.stops.some((s) => /リポジトリが違う/.test(s)), JSON.stringify(v.stops));
      const wt = path.join(tmp, 'wt');
      g(repo, 'worktree', 'add', '-q', '-b', 'wtb', wt);
      const w = verify(first, { base, repo: wt });
      assert(!w.stops.some((s) => /リポジトリが違う/.test(s)) && w.stops.some((s) => /ブランチが違う/.test(s)), 'worktree を別のリポジトリと見た: ' + JSON.stringify(w.stops));
      assert(verify(first, { base, repo: wt, accept: { branch: true } }).ok, 'worktree で --accept-branch が効かない');
    });
    t('[H34] 照合: リポジトリで作った引き継ぎを git の外で読むと、--accept-repo でも止め、貼り付けブロックを案内する', () => {
      const nogit = path.join(tmp, 'nogit-from-repo');
      fs.mkdirSync(nogit);
      for (const accept of [{}, { repo: true, branch: true, head: true }]) {
        const v = verify(first, { base, repo: nogit, accept });
        assert(!v.ok && !v.block && v.stops.some((s) => /git のリポジトリではない/.test(s) && /貼り付けブロック/.test(s)), JSON.stringify(v.stops));
      }
    });
    t('[H09] 照合: 中身だけを変えた作業ツリーで状態が違うと出る（ファイルの一覧は同じ）', () => {
      const b = path.join(tmp, 'store-tree');
      const r3 = mkRepo('repo-tree');
      fs.writeFileSync(path.join(r3, 'a.txt'), 'x\n');
      const c = create({ draft: draftFile(), title: 'tree', repo: r3 }, { base: b, now: at(0) });
      assert(verify(c.id, { base: b, repo: r3 }).warns.length === 0, '同じ状態で警告が出た（陽性対照）');
      fs.writeFileSync(path.join(r3, 'a.txt'), 'y\n');
      assert(verify(c.id, { base: b, repo: r3 }).warns.some((w) => /作業ツリー/.test(w)), '中身の変化を見逃した');
    });
    t('[H10] 照合: 見出しが壊れている・git の欄が無い・鍵が違う・鍵が無いと止まる。入口は鍵を作らない', () => {
      const b = path.join(tmp, 'store-broken');
      const r4 = mkRepo('repo-broken');
      const c = create({ draft: draftFile(), title: 'broken', repo: r4 }, { base: b, now: at(0) });
      const f = path.join(b, c.id, 'handoff.md');
      const txt = fs.readFileSync(f, 'utf8');
      fs.writeFileSync(f, txt.replace(/^git: yes\r?\n/m, ''));
      assert(verify(c.id, { base: b, repo: r4 }).stops.some((s) => /壊れている/.test(s)), 'git の欄が無い見出しを通した');
      fs.writeFileSync(f, txt);
      const kp = keyPath(b), k = fs.readFileSync(kp, 'utf8');
      fs.writeFileSync(kp, crypto.randomBytes(32).toString('hex'));
      assert(verify(c.id, { base: b, repo: r4 }).stops.some((s) => /鍵が違う/.test(s)), '鍵が違うのに照合した');
      fs.unlinkSync(kp);
      assert(verify(c.id, { base: b, repo: r4 }).stops.some((s) => /鍵が無い/.test(s)) && !fs.existsSync(kp), '鍵が無いのに進んだ・鍵を作った');
      fs.writeFileSync(kp, k);
      assert(verify(c.id, { base: b, repo: r4 }).ok, '鍵を戻しても照合できない（陽性対照）');
    });
    t('[H11] 照合: より新しい引き継ぎがあると止まる（--accept-older で続く）', () => {
      const b = path.join(tmp, 'store-older');
      const r5 = mkRepo('repo-older');
      const a = create({ draft: draftFile(), title: 'old', repo: r5 }, { base: b, now: at(0) });
      assert(verify(a.id, { base: b, repo: r5 }).ok, '1 本だけで止まった（陽性対照）');
      create({ draft: draftFile(), title: 'new', repo: r5 }, { base: b, now: at(60) });
      const v = verify(a.id, { base: b, repo: r5 });
      assert(!v.ok && v.stops.some((s) => /より新しい/.test(s)), JSON.stringify(v.stops));
      assert(verify(a.id, { base: b, repo: r5, accept: { older: true } }).ok, '--accept-older で続かない');
    });
    t('[H12] 旧形式: --accept-legacy が無ければ止める。あれば照合を省いたと明記して読む', () => {
      fs.writeFileSync(path.join(base, 'handoff_2026-09-28_legacy.md'), '# 旧\nリポジトリ: X\n```text\n貼り付け\n```\n');
      const v = verify('handoff_2026-09-28_legacy', { base, repo });
      assert(!v.ok && v.stops.length && v.legacy && v.legacy.hints.length, JSON.stringify(v));
      const w = verify('handoff_2026-09-28_legacy', { base, repo, accept: { legacy: true } });
      assert(w.ok && w.block === '貼り付け' && w.notes.some((n) => /照合を省いた/.test(n)), JSON.stringify(w));
    });
    t('[H13] 候補: 14 日以内のすべてを見てから絞り、新しい順に 10 本と「ほかに N 本」。一致しない 20 本に埋もれない', () => {
      const b = path.join(tmp, 'store-list');
      const mine = mkRepo('repo-list'), other = mkRepo('repo-list-other');
      for (let i = 0; i < 20; i++) create({ draft: draftFile(), title: 'o' + i, repo: other }, { base: b, now: at(1000 + i) });
      for (let i = 0; i < 12; i++) { const c = create({ draft: draftFile(), title: 'm' + i, repo: mine }, { base: b, now: at(i) }); if (!c.ok) throw new Error('作れない m' + i + ': ' + JSON.stringify(c)); }
      const l = list({ base: b, repo: mine, now: at(2000) });
      assert(l.items.length === 10 && l.more === 2 && l.items[0].id.endsWith('-m11') && l.items.every((x) => /-m\d+$/.test(x.id)), JSON.stringify(l));
      const old = list({ base: b, repo: mine, now: new Date(at(0).getTime() + 15 * 864e5) });
      assert(old.items.length === 0, '14 日を過ぎたものが出た');
    });
    t('[H14] 資料: 普通の文字ファイルと画像は写る（陽性対照）。秘密の名前・機微値・リンク・中身を確かめられない形式は写らない。--include で写り印が付く', () => {
      const src = path.join(tmp, '資料');
      fs.mkdirSync(src);
      const w = (n, c) => { const p = path.join(src, n); fs.writeFileSync(p, c); return p; };
      const plain = w('memo.txt', 'ふつうのメモ\n');
      const img = w('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
      const pdf = w('doc.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff]));
      const p12 = w('cert.p12', Buffer.from([0x30, 0x82, 0, 1]));
      const rsa = w('id_rsa', 'k');
      const npm = w('.npmrc', 'x');
      const gc = w('.git-credentials', 'x');
      const leak = w('log.txt', ['db', 'pass' + 'word'].join('_') + ' = "' + 'Sup3rSecretValue' + '"' + String.fromCharCode(10));
      const items = [plain, img, pdf, p12, rsa, npm, gc, leak].map((p) => ({ path: p, desc: 'd' }));
      const out = path.join(tmp, 'files-a');
      const r = copyFiles(items, out, {});
      const copied = r.copied.map((c) => c.rel).sort();
      assert(JSON.stringify(copied) === JSON.stringify(['memo.txt', 'shot.png']), '写ったもの: ' + copied.join(','));
      assert(r.copied.find((c) => c.rel === 'shot.png').mark.includes('マスク未確認'), '画像に印が無い');
      const why = Object.fromEntries(r.skipped.map((s) => [path.basename(s.src), s.reason]));
      assert(/確かめられない/.test(why['doc.pdf']) && /確かめられない|秘密/.test(why['cert.p12']) && /秘密/.test(why['id_rsa']) && /秘密/.test(why['.npmrc']) && /秘密/.test(why['.git-credentials']) && /機微値/.test(why['log.txt']), JSON.stringify(why));
      const r2 = copyFiles([{ path: pdf, desc: 'd' }], path.join(tmp, 'files-b'), { include: [pdf] });
      assert(r2.copied.length === 1 && /利用者が指定/.test(r2.copied[0].mark), '--include で写らない');
      const r3 = copyFiles([{ path: plain, desc: 'd' }], path.join(tmp, 'files-c'), { exclude: [plain] });
      assert(r3.copied.length === 0 && /除外/.test(r3.skipped[0].reason), '--exclude が効かない');
      const linkP = path.join(src, 'lnk.txt');
      let linked = false;
      try { fs.symlinkSync(plain, linkP, 'file'); linked = true; } catch { /* 権限が無ければリンクの試験は省く */ }
      if (linked) { const r4 = copyFiles([{ path: linkP, desc: 'd' }], path.join(tmp, 'files-d')); assert(r4.copied.length === 0 && /リンク/.test(r4.skipped[0].reason), 'リンクをたどった'); }
      return linked ? '' : 'シンボリックリンクの試験は省いた（作る権限が無い）';
    });
    t('[H15] 資料: 写し先の名前の重複を避ける・一覧に説明のマスク・写せなかった件数が見出しと受領通知に出る', () => {
      const s1 = path.join(tmp, 'd1'), s2 = path.join(tmp, 'd2');
      fs.mkdirSync(s1); fs.mkdirSync(s2);
      fs.writeFileSync(path.join(s1, 'x.txt'), '1'); fs.writeFileSync(path.join(s2, 'x.txt'), '2');
      const r = copyFiles([{ path: path.join(s1, 'x.txt'), desc: '担当 a' + '@' + 'b.example.com' }, { path: path.join(s2, 'x.txt'), desc: 'd' }], path.join(tmp, 'files-e'));
      assert(r.copied.map((c) => c.rel).join(',') === 'x.txt,x-2.txt', r.copied.map((c) => c.rel).join(','));
      assert(!renderIndex(r).includes('example.com'), '一覧の説明がマスクされない');
      const b = path.join(tmp, 'store-unc');
      const r6 = mkRepo('repo-unc');
      const fj = path.join(tmp, 'files.json');
      fs.writeFileSync(fj, JSON.stringify([{ path: path.join(s1, 'x.txt'), desc: 'd' }, { path: path.join(tmp, 'nothing.txt'), desc: 'd' }]));
      const c = create({ draft: draftFile(), title: 'unc', repo: r6, filesJson: fj, uncopiedImages: 1, sourceName: 'n', sourceRef: 'aaaaaa' }, { base: b, now: at(0) });
      assert(c.ok && c.uncopied === 2 && fs.existsSync(path.join(b, c.id, 'files', 'x.txt')) && fs.existsSync(path.join(b, c.id, 'files', '一覧.md')), JSON.stringify(c));
      const v = verify(c.id, { base: b, repo: r6 });
      assert(v.ok && /閉じないで/.test(v.notice.message) && /2 件/.test(v.notice.message) && v.filesIndex.includes('x.txt'), JSON.stringify(v.notice));
    });
    t('[H16] 書く順序: 段 1〜3 の失敗は .partial を残しポインタを変えない。段 4 の失敗は完成扱いで報告にポインタ未更新', () => {
      const b = path.join(tmp, 'store-fault');
      const r7 = mkRepo('repo-fault');
      const ok = create({ draft: draftFile(), title: 'base', repo: r7 }, { base: b, now: at(0) });
      const ptr = path.join(b, 'latest_handoff.txt');
      const before = fs.readFileSync(ptr, 'utf8');
      for (const st of [1, 2, 3]) {
        const r = create({ draft: draftFile(), title: 'f' + st, repo: r7 }, { base: b, now: at(st), fault: (s) => { if (s === st) throw new Error('故障 ' + st); } });
        assert(!r.ok && r.stage === st && fs.readFileSync(ptr, 'utf8') === before, `段 ${st}: ` + JSON.stringify(r));
        // 段 1 の故障はフォルダを作る前に起こすので何も残らない。段 2・3 は .partial が残る
        assert(st === 1 ? !fs.existsSync(r.state) : fs.existsSync(r.state) && r.state.endsWith('.partial'), `段 ${st} の後の状態が違う`);
        assert(!fs.existsSync(path.join(b, r.id)), `段 ${st} で完成の印が付いた`);
      }
      const r4 = create({ draft: draftFile(), title: 'f4', repo: r7 }, { base: b, now: at(4), fault: (s) => { if (s === 4) throw new Error('故障 4'); } });
      assert(r4.ok && r4.pointer === 'failed' && r4.notes.some((n) => /ポインタを更新できなかった/.test(n)) && fs.existsSync(path.join(b, r4.id, 'handoff.md')) && fs.readFileSync(ptr, 'utf8') === before, JSON.stringify(r4));
      assert(ok.ok, '陽性対照が失敗');
    });
    t('[H17] ポインタ: 読み取り専用で置き換えに失敗しても中身は変わらない。別の完成済みの引き継ぎが後から書いたら失敗にしない', () => {
      const b = path.join(tmp, 'store-ptr');
      const r8 = mkRepo('repo-ptr');
      const a = create({ draft: draftFile(), title: 'a', repo: r8 }, { base: b, now: at(0) });
      const ptr = path.join(b, 'latest_handoff.txt');
      const h0 = crypto.createHash('sha256').update(fs.readFileSync(ptr)).digest('hex');
      fs.chmodSync(ptr, 0o444);
      let ro;
      try { ro = create({ draft: draftFile(), title: 'b', repo: r8 }, { base: b, now: at(1) }); } finally { fs.chmodSync(ptr, 0o644); }
      const h1 = crypto.createHash('sha256').update(fs.readFileSync(ptr)).digest('hex');
      const roNote = ro.pointer === 'failed' ? '読み取り専用で失敗を確かめた' : '（この環境では読み取り専用でも置き換えられた）';
      assert(ro.pointer === 'updated' || (ro.pointer === 'failed' && h0 === h1), JSON.stringify(ro));
      const c = create({ draft: draftFile(), title: 'c', repo: r8 }, { base: b, now: at(2), fault: (s) => { if (s === 4.5) fs.writeFileSync(ptr, path.join(b, a.id, 'handoff.md') + '\n'); } });
      assert(c.ok && c.pointer === 'other' && c.notes.some((n) => /後から更新/.test(n)), JSON.stringify(c));
      return roNote;
    });
    t('[H18] 後片付け: 1 時間前の作りかけは候補にしない・25 時間前は候補・ポインタの指し先と 30 日以内は候補にしない。prune は直下だけ消す', () => {
      const b = path.join(tmp, 'store-prune');
      const r9 = mkRepo('repo-prune');
      const now = Date.now();
      const keep = create({ draft: draftFile(), title: 'keep', repo: r9 }, { base: b, now: new Date(now - 40 * 864e5) });
      const old = create({ draft: draftFile(), title: 'old', repo: r9 }, { base: b, now: new Date(now - 35 * 864e5) });
      const fresh = create({ draft: draftFile(), title: 'fresh', repo: r9 }, { base: b, now: new Date(now - 864e5) });
      fs.writeFileSync(path.join(b, 'latest_handoff.txt'), keep.file + '\n');
      const p1 = path.join(b, '20261016-090000-p1.partial'), p25 = path.join(b, '20261016-090000-p25.partial');
      fs.mkdirSync(p1); fs.mkdirSync(p25);
      fs.utimesSync(p1, new Date(now - 36e5), new Date(now - 36e5));
      fs.utimesSync(p25, new Date(now - 25 * 36e5), new Date(now - 25 * 36e5));
      const names = check({ base: b, now: new Date(now) }).candidates.map((c) => c.name).sort();
      assert(JSON.stringify(names) === JSON.stringify([old.id, path.basename(p25)].sort()), names.join(','));
      const dry = prune({ base: b, now: new Date(now) });
      assert(dry.removed.length === 0 && fs.existsSync(path.join(b, old.id)), '--apply なしで消した');
      const r = prune({ base: b, now: new Date(now), apply: true });
      assert(r.removed.length === 2 && !fs.existsSync(path.join(b, old.id)) && fs.existsSync(path.join(b, keep.id)) && fs.existsSync(path.join(b, fresh.id)) && fs.existsSync(p1), JSON.stringify(r));
    });
    t('[H19] git の外: git: none で作り、場所だけ照合する（違う場所なら止める・--accept-repo で続く）。候補は同じ場所の git: none だけ', () => {
      const b = path.join(tmp, 'store-nogit');
      const nogit = path.join(tmp, 'nogit'), nogit2 = path.join(tmp, 'nogit2');
      fs.mkdirSync(nogit); fs.mkdirSync(nogit2);
      const c = create({ draft: draftFile(), title: 'nogit', repo: nogit }, { base: b, now: at(0) });
      const h = parseHeader(fs.readFileSync(c.file, 'utf8'));
      assert(h.git === 'none' && !h['repo-key'] && !h.head && /^[0-9a-f]{16}$/.test(h['dir-key'] || ''), JSON.stringify(h));
      const v = verify(c.id, { base: b, repo: nogit });
      assert(v.ok && v.notes.some((n) => /場所だけを照合/.test(n)), JSON.stringify(v));
      const w = verify(c.id, { base: b, repo: nogit2 });
      assert(!w.ok && w.stops.some((s) => /場所が違う|今の場所が違う/.test(s)), '違う場所で読んだ: ' + JSON.stringify(w.stops));
      assert(verify(c.id, { base: b, repo: nogit2, accept: { repo: true } }).ok, '--accept-repo で続かない');
      assert(list({ base: b, repo: nogit, now: at(10) }).items.length === 1, 'git の外の候補が出ない');
      assert(list({ base: b, repo: nogit2, now: at(10) }).items.length === 0, '違う場所の候補が出た');
    });
    t('[H20] 受領通知: --no-notify なら送らない。作成元が無ければ送らない。旧形式の peer は一致しない', () => {
      const b = path.join(tmp, 'store-notify');
      const r10 = mkRepo('repo-notify');
      const c = create({ draft: draftFile(), title: 'nn', repo: r10, noNotify: true, sourceName: 'n', sourceRef: 'bbbbbb' }, { base: b, now: at(0) });
      const v = verify(c.id, { base: b, repo: r10 });
      assert(v.ok && v.notice === null && v.notes.some((n) => /--no-notify/.test(n)), JSON.stringify(v));
      const pn = peer(c.id, 'n', { base: b });
      assert(pn.match === false && /--no-notify/.test(pn.reason || ''), '--no-notify の引き継ぎで宛先と認めた: ' + JSON.stringify(pn));
      const d = create({ draft: draftFile(), title: 'nosrc', repo: r10 }, { base: b, now: at(5) });
      assert(verify(d.id, { base: b, repo: r10, accept: { older: true } }).notice === null, '作成元なしで通知した');
      fs.writeFileSync(path.join(b, 'legacy-x.md'), 'x');
      assert(peer('legacy-x', 'n', { base: b }).match === false, '旧形式で一致した');
    });
    t('[H21] クリップボード・リンク: Windows は PowerShell の Set-Clipboard に Base64 で渡し（clip.exe は予備）、読み戻して確かめる。道具が無ければ失敗を返す（例外にしない）。リンクは 1 行をエンコードする', () => {
      const L = '/ut-takeover 20261016-100000-a --base "C:\\Users\\試験(a)\\store"';
      const calls = [];
      const ok = clip(L, { platform: 'win32', run: (c, a, i) => { calls.push([c, a, i]); return a.some((x) => /Get-Clipboard/.test(x)) ? { status: 0, stdout: L + '\r\n' } : { status: 0 }; } });
      const cmdArg = (calls[0][1] || []).find((x) => /Set-Clipboard/.test(x)) || '';
      const b64 = (/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(cmdArg) || [])[1] || '';
      assert(ok.ok && ok.verified === true && calls[0][0] === 'powershell.exe' && Buffer.from(b64, 'base64').toString('utf8') === L && calls[0][2] === undefined, JSON.stringify({ ok, calls: calls.map((c) => [c[0], c[1].join(' ').slice(0, 120)]) }));
      assert(/Get-Clipboard/.test(calls[1][1].join(' ')), '読み戻さない: ' + calls[1][1].join(' '));
      // PowerShell が使えなければ clip.exe に文字列で渡す（予備）
      const fb = [];
      const f = clip(L, { platform: 'win32', run: (c, a, i) => { fb.push([c, i]); return c === 'clip.exe' ? { status: 0 } : { status: 1 }; } });
      // 非 ASCII を含む 1 行は、clip.exe を呼ぶ前に断る（呼んだ後に断ると、化けた 1 行が利用者のクリップボードに残る）
      assert(!f.ok && f.verified === false && /非 ASCII/.test(f.reason || '') && !fb.some((x) => x[0] === 'clip.exe'), '非 ASCII の 1 行で clip.exe を呼んだ・成功にした: ' + JSON.stringify({ f, fb }));
      // ASCII だけの 1 行は、読み戻せなくても clip.exe で入れてよい（未検証と報告する）
      const fa = [];
      const fa1 = clip('/ut-takeover 20261016-100000-a', { platform: 'win32', run: (c, a, i) => { fa.push([c, i]); return c === 'clip.exe' ? { status: 0 } : { status: 1 }; } });
      assert(fa1.ok && fa1.verified === false && fa.some((x) => x[0] === 'clip.exe' && x[1] === '/ut-takeover 20261016-100000-a'), 'ASCII の 1 行を clip.exe で入れない: ' + JSON.stringify({ fa1, fa }));
      const ng = clip('/ut-takeover 20261016-100000-a', { platform: 'linux', run: () => ({ status: 1 }) });
      assert(!ng.ok && /使えない/.test(ng.reason), JSON.stringify(ng));
      assert(link('/ut-takeover 20261016-100000-a') === 'vscode://anthropic.claude-code/open?prompt=%2Fut-takeover%2020261016-100000-a', link('/ut-takeover 20261016-100000-a'));
    });
    // Git Bash のパスの変換で壊れた 1 行を、入れたと報告しない（2026-10-18 の事象: "C:/Program Files/Git/ut-takeover <ID>" が入り ok: true だった）
    t('[H35] 1 行の検査: 変換で壊れた形・形の違うものは入れずに理由を返し、正しい形（--base つきも）は通す', () => {
      const localBase = process.platform === 'win32' ? 'C:\\Users\\試験(a)\\store' : path.join(tmp, '試験(a)', 'store');
      for (const s of ['/ut-takeover 20261016-100000-a', `/ut-takeover 20261016-100000-a --base "${localBase}"`]) assert(checkLine(s) === null, '正しい形を止めた: ' + s);
      const winLine = '/ut-takeover 20261016-100000-a --base "C:\\Users\\試験(a)\\store"';
      const posixLine = '/ut-takeover 20261016-100000-a --base "/tmp/試験(a)/store"';
      assert(checkLine(winLine, 'win32') === null && checkLine(posixLine, 'linux') === null && /形が違う/.test(checkLine(winLine, 'linux') || ''), '指定した OS の絶対パスとして判定しない');
      // win32 は、ドライブ名の無いパス（/tmp/x・\foo）を絶対とみなさない（受け取った側の現在のドライブからの相対に解決されて、保存先がずれる）。UNC は通す
      for (const p of ['/tmp/x', '\\foo\\bar']) assert(/形が違う/.test(checkLine('/ut-takeover 20261016-100000-a --base "' + p + '"', 'win32') || ''), 'win32 でドライブ名の無いパスを通した: ' + p);
      assert(checkLine('/ut-takeover 20261016-100000-a --base "\\\\server\\share\\store"', 'win32') === null, 'win32 の UNC を止めた');
      // 変換先は Git の入れ場所（既定は C:/Program Files/Git）。別の場所（D:/Git）でもドライブ名で始まる形で見分ける
      for (const s of ['C:/Program Files/Git/ut-takeover 20261016-100000-a', 'C:\\Program Files\\Git\\ut-takeover 20261016-100000-a --base C;Z:\\', 'D:/Git/ut-takeover 20261016-100000-a']) assert(/パスの変換/.test(checkLine(s) || ''), '変換の跡を理由に出さない: ' + s + ' → ' + checkLine(s));
      for (const s of ['/ut-takeover X', '/ut-takeover 20261016-100000-a --base "store"', '/ut-takeover 20261016-100000-a; echo x', '', '/ut-takeover 20261016-100000-a\n/x']) assert(/形が違う/.test(checkLine(s) || ''), '形の違うものを通した: ' + JSON.stringify(s));
      let wrote = 0;
      const r = clip('C:/Program Files/Git/ut-takeover 20261016-100000-a', { platform: 'win32', run: () => { wrote++; return { status: 0, stdout: '' }; } });
      assert(!r.ok && /パスの変換/.test(r.reason) && wrote === 0, '壊れた 1 行を書いた・成功を返した: ' + JSON.stringify(r) + ' 書き込み ' + wrote);
    });
    t('[H36] 読み戻し: 違う中身なら失敗にし、読み戻せなければ確かめていないことを返す', () => {
      const L = '/ut-takeover 20261016-100000-a';
      const bad = clip(L, { platform: 'win32', run: (c) => (c === 'clip.exe' ? { status: 0 } : { status: 0, stdout: '��/ut-takeover 20261016-100000-a' }) });
      assert(!bad.ok && /読み戻す/.test(bad.reason), '読み戻して違うのに成功を返した: ' + JSON.stringify(bad));
      const none = clip(L, { platform: 'win32', run: (c) => (c === 'clip.exe' ? { status: 0 } : { status: 1 }) });
      assert(none.ok && none.verified === false && /確かめていない/.test(none.note || ''), JSON.stringify(none));
      const mac = clip(L, { platform: 'darwin', run: (c, a, i) => (c === 'pbcopy' ? (i === L ? { status: 0 } : { status: 9 }) : { status: 0, stdout: L }) });
      assert(mac.ok && mac.verified === true, 'pbcopy に文字列で渡して読み戻さない: ' + JSON.stringify(mac));
    });
    // CLI の引数を通る経路（以前の試験は関数を直接呼び、シェルの変換を原理的に捕まえられなかった）。副作用の無い link と、書く前に止まる clip だけを試す
    t('[H37] CLI: --id は保存先の引き継ぎを確かめて 1 行を組み立てる。壊れた --text は止める。Git Bash を通しても --id なら壊れない', () => {
      const rr = mkRepo('r37'), b = path.join(tmp, 'store37');
      const c = create({ draft: draftFile(), title: 'cli', repo: rr }, { base: b, now: at(37) });
      const node = (...a) => spawnSync(process.execPath, [SELF, ...a], { encoding: 'utf8' });
      const j = (r) => { try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; } };
      const l1 = node('link', '--id', c.id, '--base', b);
      assert(l1.status === 0 && j(l1).line === takeoverLine(c.id, b) && j(l1).url === link(takeoverLine(c.id, b)), '--id で 1 行を組み立てない: ' + l1.stdout);
      const l2 = node('link', '--id', '20261016-100000-nothere', '--base', b);
      assert(l2.status === 1 && /保存先/.test(l2.stdout), '保存先に無い ID を通した: ' + l2.stdout);
      const l3 = node('link', '--text', 'C:/Program Files/Git/ut-takeover ' + c.id);
      assert(l3.status === 1 && j(l3).ok === false && /パスの変換/.test(j(l3).reason || ''), '壊れた --text を通した: ' + l3.stdout);
      const c1 = node('clip', '--text', 'C:/Program Files/Git/ut-takeover ' + c.id);
      assert(c1.status === 1 && j(c1).ok === false, '壊れた --text の clip が成功を返した: ' + c1.stdout);
      const c2 = node('clip', '--id', c.id, '--text', '/ut-takeover ' + c.id);
      assert(c2.status === 2 && /どちらか一方/.test(c2.stdout), '--id と --text の両方を受けた: ' + c2.stdout);
      // 実際の Git Bash（MSYS）を通す。Windows で Git for Windows の bash がある時だけ（WSL の bash は使わない）
      if (process.platform !== 'win32') return skip('Git Bash の経路は Windows だけで試す');
      const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
      const bash = ex.status === 0 ? path.join(path.resolve(ex.stdout.trim(), '..', '..', '..'), 'bin', 'bash.exe') : '';
      if (!bash || !fs.existsSync(bash)) return skip('Git Bash が見つからない（Git Bash の経路は試していない）');
      // 変換を止める変数は、空の値でも「定義されている」だけで変換を止めるので、値を空にせず消す
      const noConvOff = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^MSYS_NO_PATHCONV$|^MSYS2_ARG_CONV_EXCL$/i.test(k)));
      const viaBash = (script, ...a) => spawnSync(bash, ['-c', script, '_', process.execPath, SELF, ...a], { encoding: 'utf8', env: noConvOff });
      const t1 = viaBash('"$1" "$2" link --text "/ut-takeover $3"', c.id);
      assert(t1.status === 1 && /パスの変換/.test(t1.stdout), '陽性対照: Git Bash を通した /ut-takeover が変換されず、検査の効き目を確かめられない: ' + t1.stdout + t1.stderr);
      const t2 = viaBash('"$1" "$2" link --id "$3" --base "$4"', c.id, b);
      assert(t2.status === 0 && j(t2).line === takeoverLine(c.id, b), 'Git Bash を通した --id で 1 行が壊れた: ' + t2.stdout + t2.stderr);
    });
    t('[H38] 知らないオプション・同じオプションの 2 回目・値の無い余分な語は exit 2 で止め、使えるものを示す（正しい呼び方は通す）', () => {
      const node = (...a) => spawnSync(process.execPath, [SELF, ...a], { encoding: 'utf8' });
      const bs = path.join(tmp, 'store38');
      for (const [a, re] of [[['verify', '--idd', 'x', '--base', bs], /知らないオプション: --idd/], [['clip', '--name', 'x', '--base', bs], /peer のオプション/], [['peer', '--id', 'a', '--id', 'b', '--base', bs], /2 回指定/], [['list', 'extra', '--base', bs], /余分な引数/], [['prune', '--apply', 'extra', '--base', bs], /余分な引数/]]) {
        const r = node(...a);
        assert(r.status === 2 && re.test(r.stdout), a.join(' ') + ' → exit ' + r.status + ': ' + r.stdout);
      }
      const ok = node('link', '--text', '/ut-takeover 20261016-100000-a', '--base', bs);
      assert(ok.status === 0, '正しい呼び方を止めた: ' + ok.stdout);
    });
    t('[H23] 改名のやり直し: EPERM・EBUSY は数回やり直して通す。ほかの失敗はすぐ投げる。回数を超えたら投げる', () => {
      const mk = (codes) => { let n = 0; return { rename: () => { const c = codes[n++]; if (c) { const e = new Error(c); e.code = c; throw e; } }, count: () => n }; };
      const a = mk(['EPERM', 'EBUSY']);
      renameRetry('x', 'y', { waitMs: 1, rename: a.rename });
      assert(a.count() === 3, 'やり直さなかった: ' + a.count());
      const b = mk(['ENOENT']);
      throwsLike(() => renameRetry('x', 'y', { waitMs: 1, rename: b.rename }), /ENOENT/, 'ENOENT を握りつぶした');
      assert(b.count() === 1, 'ENOENT でやり直した');
      const c = mk(['EPERM', 'EPERM', 'EPERM']);
      throwsLike(() => renameRetry('x', 'y', { tries: 3, waitMs: 1, rename: c.rename }), /EPERM/, '回数を超えても投げない');
    });
    t('[H24] 下書き: 成功したら保存先の .drafts/ の下書きと資料の JSON を消す。外の下書きは消さない。失敗したら残す', () => {
      const b = path.join(tmp, 'store-drafts');
      const r11 = mkRepo('repo-drafts');
      const dd = path.join(b, '.drafts');
      fs.mkdirSync(dd, { recursive: true });
      const d1 = path.join(dd, 'd1.md'); fs.copyFileSync(draftFile(), d1);
      const j1 = path.join(dd, 'f.json'); fs.writeFileSync(j1, '[]');
      const c = create({ draft: d1, title: 'dr', repo: r11, filesJson: j1 }, { base: b, now: at(0) });
      assert(c.ok && !fs.existsSync(d1) && !fs.existsSync(j1), '下書きが残った: ' + JSON.stringify(c.draftRemoved));
      const outside = draftFile();
      assert(create({ draft: outside, title: 'dr2', repo: r11 }, { base: b, now: at(1) }).ok && fs.existsSync(outside), '外の下書きを消した');
      const d2 = path.join(dd, 'd2.md'); fs.copyFileSync(draftFile(), d2);
      const f = create({ draft: d2, title: 'dr3', repo: r11 }, { base: b, now: at(2), fault: (s) => { if (s === 2) throw new Error('x'); } });
      assert(!f.ok && fs.existsSync(d2), '失敗したのに下書きを消した');
    });
    t('[H25] 資料がすべて写らなくても作れる（一覧を書く）。一覧と同名の資料は別名で写し、一覧を上書きしない', () => {
      const b = path.join(tmp, 'store-allskip');
      const rr = mkRepo('repo-allskip');
      const s = path.join(tmp, 'src-allskip');
      fs.mkdirSync(s);
      fs.writeFileSync(path.join(s, 'id_rsa'), 'k');
      const fj = path.join(tmp, 'allskip.json');
      fs.writeFileSync(fj, JSON.stringify([{ path: path.join(s, 'id_rsa'), desc: 'd' }]));
      const c = create({ draft: draftFile(), title: 'allskip', repo: rr, filesJson: fj }, { base: b, now: at(0) });
      assert(c.ok && fs.existsSync(path.join(b, c.id, 'files', INDEX_NAME)) && c.uncopied === 1, JSON.stringify(c));
      fs.writeFileSync(path.join(s, INDEX_NAME), '資料の本文\n');
      fs.writeFileSync(fj, JSON.stringify([{ path: path.join(s, INDEX_NAME), desc: 'd' }]));
      const c2 = create({ draft: draftFile(), title: 'samename', repo: rr, filesJson: fj }, { base: b, now: at(1) });
      const idx = fs.readFileSync(path.join(b, c2.id, 'files', INDEX_NAME), 'utf8');
      assert(c2.ok && c2.copied.length === 1 && c2.copied[0].rel !== INDEX_NAME && idx.startsWith('# 資料の一覧'), JSON.stringify(c2.copied));
    });
    t('[H26] 本文の再開用ブロックが消えた・空なら止める（受領通知を作らない）。写せなかった件数が壊れていても止める', () => {
      const b = path.join(tmp, 'store-noblock');
      const rr = mkRepo('repo-noblock');
      const c = create({ draft: draftFile(), title: 'nb', repo: rr, sourceName: 'n', sourceRef: 'cccccc' }, { base: b, now: at(0) });
      const f = path.join(b, c.id, 'handoff.md');
      const txt = fs.readFileSync(f, 'utf8');
      fs.writeFileSync(f, txt.slice(0, txt.indexOf(BLOCK_END)));
      const v = verify(c.id, { base: b, repo: rr });
      assert(!v.ok && v.notice === null && v.stops.some((s) => /再開用ブロック/.test(s)), JSON.stringify(v));
      fs.writeFileSync(f, txt.replace(/^uncopied: 0$/m, 'uncopied: x'));
      assert(verify(c.id, { base: b, repo: rr }).stops.some((s) => /壊れている/.test(s)), '件数が壊れた見出しを通した');
      fs.writeFileSync(f, txt);
      assert(verify(c.id, { base: b, repo: rr }).ok, '元に戻しても読めない（陽性対照）');
    });
    t('[H27] 入力の検査: 写せなかった件数・作成元の ref と名前（改行で見出しを差し替えさせない）・本文の機微値・git の中の保存先', () => {
      const b = path.join(tmp, 'store-input');
      const rr = mkRepo('repo-input');
      for (const bad of ['x', '-1', '1.5']) throwsLike(() => create({ draft: draftFile(), title: 'u', repo: rr, uncopiedImages: bad }, { base: b, now: at(0) }), /0 以上の整数/, '件数を通した: ' + bad);
      throwsLike(() => create({ draft: draftFile(), title: 'r', repo: rr, sourceName: 'n', sourceRef: 'ab\ngit: none' }, { base: b, now: at(0) }), /source-ref/, '改行入りの ref を通した');
      throwsLike(() => create({ draft: draftFile(), title: 'n', repo: rr, sourceName: 'a\n-->', sourceRef: 'abcdef' }, { base: b, now: at(0) }), /source-name/, '改行入りの名前を通した');
      throwsLike(() => create({ draft: draftFile('接続は ' + ['db', 'pass' + 'word'].join('_') + ' = "' + 'Sup3rSecretValue' + '"'), title: 's', repo: rr }, { base: b, now: at(0) }), /機微値/, '本文の機微値を通した');
      throwsLike(() => create({ draft: draftFile(), title: 'g', repo: rr }, { base: path.join(rr, 'handoffs'), now: at(0) }), /作業ツリーの中/, 'git の中の保存先を通した');
      assert(!fs.existsSync(path.join(rr, 'handoffs')), 'git の中に保存先を作った');
      assert(create({ draft: draftFile(), title: 'ok', repo: rr, uncopiedImages: '2' }, { base: b, now: at(1) }).uncopied === 2, '正しい件数が通らない（陽性対照）');
    });
    t('[H28] 照合を省いたとき（鍵が無い・違う）は --accept-legacy で読めるが、受領通知は「閉じてよい」にしない', () => {
      const b = path.join(tmp, 'store-nokey2');
      const rr = mkRepo('repo-nokey2');
      const c = create({ draft: draftFile(), title: 'nk', repo: rr, sourceName: 'n', sourceRef: 'dddddd' }, { base: b, now: at(0) });
      const kp = keyPath(b), k = fs.readFileSync(kp, 'utf8');
      fs.unlinkSync(kp);
      assert(!verify(c.id, { base: b, repo: rr }).ok, '鍵なしで照合した');
      const v = verify(c.id, { base: b, repo: rr, accept: { legacy: true } });
      assert(v.ok && v.notes.some((n) => /鍵が無い/.test(n)) && v.notice && /閉じないで/.test(v.notice.message) && !/閉じてよい/.test(v.notice.message), JSON.stringify(v));
      fs.writeFileSync(kp, k);
    });
    t('[H29] 新しいセッションで打つ 1 行: 既定の保存先なら ID だけ、ほかの保存先なら --base つき', () => {
      assert(takeoverLine('20261016-100000-a', homeBase()) === '/ut-takeover 20261016-100000-a', takeoverLine('20261016-100000-a', homeBase()));
      const other = path.join(tmp, 'store-x');
      assert(takeoverLine('20261016-100000-a', other) === `/ut-takeover 20261016-100000-a --base "${path.resolve(other)}"`, takeoverLine('20261016-100000-a', other));
    });
    t('[H30] 旧形式: 4 個の囲みの中の 3 個の囲みで切らない', () => {
      const tick = '`';
      const text = ['# 旧', tick.repeat(4) + 'text', 'BEFORE', tick.repeat(3) + 'sql', 'SELECT 1', tick.repeat(3), 'AFTER', tick.repeat(4), '後ろ'].join('\n');
      const blk = firstFence(text);
      assert(blk.includes('BEFORE') && blk.includes('SELECT 1') && blk.includes('AFTER') && !blk.includes('後ろ'), blk);
    });
    t('[H31] 読めない資料は写さずに理由を書き、ほかは写して完成する。読めない引き継ぎがあっても候補の走査は止まらない', () => {
      const s = path.join(tmp, 'src-busy');
      fs.mkdirSync(s);
      const a = path.join(s, 'a.txt'), busy = path.join(s, 'busy.txt');
      fs.writeFileSync(a, 'a'); fs.writeFileSync(busy, 'b');
      const r = copyFiles([{ path: busy, desc: 'd' }, { path: a, desc: 'd' }], path.join(tmp, 'files-busy'), { read: (p) => { if (p === busy) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return fs.readFileSync(p); } });
      assert(r.copied.length === 1 && /読めない（EBUSY）/.test(r.skipped[0].reason), JSON.stringify(r));
      const b = path.join(tmp, 'store-broken2');
      const rr = mkRepo('repo-broken2');
      create({ draft: draftFile(), title: 'good', repo: rr }, { base: b, now: at(0) });
      fs.mkdirSync(path.join(b, '20261016-100005-bad', 'handoff.md'), { recursive: true }); // 本文がフォルダ（読めない）
      assert(list({ base: b, repo: rr, now: at(10) }).items.length === 1, '読めない 1 件で走査が止まった');
    });
    t('[H32] 一覧: 説明の縦棒・改行で列がずれない。写さなかったものは元のパスでなくファイル名だけを書く', () => {
      const s = path.join(tmp, '顧客X');
      fs.mkdirSync(s);
      fs.writeFileSync(path.join(s, 'id_rsa'), 'k');
      fs.writeFileSync(path.join(s, 'm.txt'), 'm');
      const r = copyFiles([{ path: path.join(s, 'm.txt'), desc: 'a|b\nc' }, { path: path.join(s, 'id_rsa'), desc: 'd' }], path.join(tmp, 'files-cell'));
      const idx = renderIndex(r);
      const row = idx.split('\n').find((l) => l.startsWith('| m.txt'));
      assert(row && row.split('|').length === 7, '列がずれた: ' + row);
      assert(!idx.includes('顧客X') && idx.includes('| id_rsa |'), '元のパスが残った: ' + idx);
    });
    t('[H33] 後片付け: 24 時間以上前の残った下書きは候補・新しいものは候補にしない。prune は .drafts/ の直下だけ消す', () => {
      const b = path.join(tmp, 'store-drafts2');
      fs.mkdirSync(path.join(b, '.drafts'), { recursive: true });
      const oldD = path.join(b, '.drafts', 'old.md'), newD = path.join(b, '.drafts', 'new.md');
      fs.writeFileSync(oldD, 'x'); fs.writeFileSync(newD, 'y');
      const now = Date.now();
      fs.utimesSync(oldD, new Date(now - 25 * 36e5), new Date(now - 25 * 36e5));
      const names = check({ base: b, now: new Date(now) }).candidates.map((c) => c.name);
      assert(JSON.stringify(names) === JSON.stringify(['.drafts/old.md']), names.join(','));
      const r = prune({ base: b, now: new Date(now), apply: true });
      assert(r.removed.join(',') === '.drafts/old.md' && !fs.existsSync(oldD) && fs.existsSync(newD), JSON.stringify(r));
    });
    t('[H22] 下書き: 再開用ブロックが無ければ作らない（フォルダも残さない）', () => {
      const b = path.join(tmp, 'store-draft');
      const f = path.join(tmp, 'noblock.md');
      fs.writeFileSync(f, '本文だけ');
      throwsLike(() => create({ draft: f, title: 'x', repo }, { base: b, now: at(0) }), /再開用ブロック/, 'ブロックなしで作った');
      assert(!fs.existsSync(b) || fs.readdirSync(b).filter((n) => !n.startsWith('.')).length === 0, 'フォルダが残った');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.m ? ' | ' + r.m : ''));
  const ng = results.filter((r) => !r.ok).length;
  const sk = results.filter((r) => r.skipped).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng - sk} 件パス / ${ng} 件失敗${sk ? ` / ${sk} 件省略` : ''}`);
  // 全件が省略・0 件のときは、実施していないので成功にしない
  return ng === 0 && results.length - sk > 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv.includes('--selftest')) process.exit((await selftest()) ? 0 : 1);
  process.exit(main(process.argv.slice(2)));
}
