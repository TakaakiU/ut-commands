// /ut-handoff・/ut-takeover の部品（commands/templates/ut-handoff.mjs）の防御を 1 つずつ壊し、
// --selftest が「その防御を見る試験」で落ちるかを確かめる。
//   node tools/ut-handoff-sweep.mjs              （repo ルートで実行する）
//   UT_SWEEP_ONLY=M1,M2 node tools/ut-handoff-sweep.mjs   一部だけ（全件の判定ではない）
// exit: 0 全件 CAUGHT / 1 それ以外
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'commands', 'templates');
const SRC = fs.readFileSync(path.join(TPL, 'ut-handoff.mjs'), 'utf8');
const REVIEW = fs.readFileSync(path.join(TPL, 'ut-review.mjs'), 'utf8'); // 機微値の型を import するので同じフォルダに置く
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-handoff-sweep-'));

// [ID, 内容, 差し込み位置, 置き換え, その防御を見ている試験]
const mutations = [
  // ID・鍵・照合用の値
  ['M1', '保存先の外を指す ID を受け付ける', 'if (!s || /\\.\\.|[\\\\/:]/.test(s)) throw', 'if (!s) throw', '[H01]'],
  ['M2', '短い名前の形を検査しない', "if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw", 'if (false) throw', '[H01]'],
  ['M3', '読む側でも鍵を作る', 'export function loadKey(base, { create = false } = {})', 'export function loadKey(base, { create = true } = {})', '[H02]'],
  ['M4', '照合用の値の大文字・小文字をそろえる', ".update(kind + '\\0' + value).digest('hex').slice(0, 16);", ".update(kind + '\\0' + String(value).toLowerCase()).digest('hex').slice(0, 16);", '[H03]'],
  ['M5', '名前の鍵で前後の空白を除かない', "update(kind + '\\0' + value)", "update(kind + '\\0' + value)", '[H03]', (s) => s.replace("hmac(key, 'name', String(name).trim())", "hmac(key, 'name', String(name))")],
  ['M6', 'Windows 以外でもパスの大文字・小文字をそろえる', "return platform === 'win32' ? s.toLowerCase() : s;", 'return s.toLowerCase();', '[H03]'],
  ['M7', '作成元の名前をそのまま見出しに書く', "'source-name-key': nameKey(key, opts.sourceName)", "'source-name-key': opts.sourceName", '[H04]'],
  ['M8', 'head に SHA でなくブランチ名を書く', "git(['rev-parse', '--short=12', 'HEAD'], dir)", "git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)", '[H04]'],
  ['M9', '同じ ID の引き継ぎを上書きする', 'if (fs.existsSync(final) || fs.existsSync(partial)) throw', 'if (false) throw', '[H04]'],
  // 照合
  ['M10', 'ブランチを照合しない', "if (h['branch-key'] !== cur.branchKey) {", 'if (false) {', '[H06]'],
  ['M11', 'HEAD が祖先でなくても警告だけで続ける', "if (h.head !== 'none' && isAncestor(cur.gi.root, h.head))", 'if (true)', '[H07]'],
  ['M12', 'リポジトリを照合しない', "if (h['repo-key'] !== cur.repoKey) {", 'if (false) {', '[H08]'],
  ['M13', 'worktree を別のリポジトリと見る（共通ディレクトリでなく作業ツリーの場所で鍵を作る）', "const common = git(['rev-parse', '--git-common-dir'], dir).out.trim();", 'const common = root;', '[H08]'],
  ['M14', '作業ツリーの状態に中身を入れない', "${index.get(paths[i]) || '-'}\\t${workOf(paths[i])}", "${index.get(paths[i]) || '-'}", '[H09]'],
  ['M15', '作業ツリーの違いを警告しない', "if (h['tree-state'] !== cur.tree) out.warns.push(", 'if (false) out.warns.push(', '[H09]'],
  ['M16', 'git の欄が無い見出しを通す', "if (!h || !['yes', 'none'].includes(h.git) ||", 'if (!h ||', '[H10]'],
  ['M17', '鍵の識別子が違っても照合する', "if (!accept.legacy) { out.stops.push('鍵が違う（作り直された）", "if (false) { out.stops.push('鍵が違う（作り直された）", '[H10]'],
  ['M18', '入口で鍵を作る', "const key = loadKey(base);" + NL + "  const skipped = [];", "const key = loadKey(base, { create: true });" + NL + "  const skipped = [];", '[H10]'],
  ['M19', 'より新しい引き継ぎがあっても止めない', "else out.stops.push('同じリポジトリ・ブランチに、より新しい引き継ぎがある", "else out.warns.push('同じリポジトリ・ブランチに、より新しい引き継ぎがある", '[H11]'],
  ['M20', '旧形式を明示なしに読む', 'if (!accept.legacy) {' + NL + '      const hints', 'if (false) {' + NL + '      const hints', '[H12]'],
  ['M21', 'git の外の引き継ぎを git の照合に回す', "} else if (h.git === 'none') {", '} else if (false) {', '[H19]'],
  // 候補
  ['M22', '候補を新しい順の 10 本に先に絞ってから照合する', "const match = completed(base).filter((x) => x.h['key-id'] === kid", "const match = completed(base).sort((a, b) => Date.parse(b.h.created) - Date.parse(a.h.created)).slice(0, 10).filter((x) => x.h['key-id'] === kid", '[H13]'],
  ['M23', '14 日を過ぎた候補も出す', "x.h['key-id'] === kid && Date.parse(x.h.created) >= since", "x.h['key-id'] === kid", '[H13]'],
  // 資料
  ['M24', '秘密を含みうる名前を写す', 'if (SECRET_NAMES.some((re) => re.test(name.toLowerCase()))) { skip(', 'if (false) { skip(', '[H14]'],
  ['M25', '中身に機微値があっても写す', 'if (hits.length) { skip(', 'if (false) { skip(', '[H14]'],
  ['M26', '中身を確かめられない形式を既定で写す', "else { skip('中身を確かめられない形式（--include で写せる）', st.size); continue; }", "else mark = '';", '[H14]'],
  ['M27', '画像に印を付けない', "if (IMAGE_EXT.has(ext)) mark = 'マスク未確認（画像）';", "if (IMAGE_EXT.has(ext)) mark = '';", '[H14]'],
  ['M28', '--exclude を無視する', "if (exclude.some((x) => sameFile(x, src))) { skip('利用者が除外した'); continue; }", '', '[H14]'],
  ['M29', '一覧の説明をマスクしない', "const desc = cell(mask(String(it.desc || '')));", "const desc = cell(String(it.desc || ''));", '[H15]'],
  ['M30', '写し先の名前の重複を避けない', 'while (used.has(rel.toLowerCase()))', 'while (false)', '[H15]'],
  ['M31', '写せなかった件数に除外した資料を数えない', 'const uncopied = res.skipped.length + unc;', 'const uncopied = unc;', '[H15]'],
  ['M32', '警告・写せなかった資料があっても「閉じてよい」と伝える', 'const message = issues.length', 'const message = false', '[H15]'],
  // 書く順序・ポインタ・後片付け
  ['M33', '段 2 の失敗の後も続けてポインタを更新する', '} catch (e) { return fail(2, e); }', '} catch (e) { /* 続ける */ }', '[H16]'],
  ['M34', '段 4（ポインタ）の失敗を引き継ぎの失敗にする', "r.ok = true; r.pointer = 'failed';", "r.pointer = 'failed';", '[H16]'],
  ['M35', '別の完成済みの引き継ぎが後から書いたポインタを失敗にする', "else if (/[\\\\/]handoff\\.md$/.test(now2) && fs.existsSync(now2)", 'else if (false', '[H17]'],
  ['M36', '作成中の .partial を後片付けの候補にする', 'if (now - st.mtimeMs > LIMITS.partialHours * 36e5)', 'if (true)', '[H18]'],
  ['M37', 'ポインタの指し先を後片付けの候補にする', 'if (!ID_RE.test(n) || sameFile(p, pointed)) continue;', 'if (!ID_RE.test(n)) continue;', '[H18]'],
  ['M38', '--apply なしで消す', 'if (!apply) return { removed: [], candidates };', '', '[H18]'],
  // 受領通知・道具
  ['M39', '名前を照合せずに宛先と認める', "return { match: nameKey(key, name) === h['source-name-key'] };", 'return { match: true };', '[H05]'],
  ['M40', '--no-notify を無視する', "if (h.notify !== 'off' && h['source-ref'] && h['source-name-key']) {", "if (h['source-ref'] && h['source-name-key']) {", '[H20]'],
  ['M41', 'クリップボードの道具の失敗を成功と扱う', 'if (!r || r.status !== 0) continue;', 'if (!r) continue;', '[H21]'],
  ['M42', '改名で EPERM 以外もやり直す', "if (i + 1 >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;", 'if (i + 1 >= tries) throw e;', '[H23]'],
  ['M43', '保存先の外の下書きも消す', 'if (normRepoPath(path.dirname(p)) !== dir) continue;', '', '[H24]'],
  ['M44', '再開用ブロックが無い下書きで作る', "if (block === null || !block.trim()) throw new InputError(", 'if (false) throw new InputError(', '[H22]'],
  // 実装のレビュー（2026-10-16）の指摘で足した防御
  ['M45', '資料がすべて写らないとき files/ を作らない', "fs.mkdirSync(filesDir, { recursive: true }); // すべて写さなかったときも一覧は書く", '', '[H25]'],
  ['M46', '一覧の名前を予約しない', 'const used = new Set([INDEX_NAME.toLowerCase()]);', 'const used = new Set();', '[H25]'],
  ['M47', '再開用ブロックが無い本文を読む', "if (block === null || !block.trim()) { out.stops.push('再開用ブロックが無い・空", "if (false) { out.stops.push('再開用ブロックが無い・空", '[H26]'],
  ['M48', '写せなかった件数の壊れを通す', " || !/^\\d+$/.test(String(h.uncopied || ''))) { out.stops.push('見出しが壊れている", ") { out.stops.push('見出しが壊れている", '[H26]'],
  ['M49', '写せなかった件数を検査しない', 'if (!Number.isInteger(unc) || unc < 0) throw', 'if (false) throw', '[H27]'],
  ['M50', '作成元の ref を検査しない', "if (opts.sourceRef !== undefined && !/^[0-9a-f]{4,16}$/i.test(String(opts.sourceRef))) throw", 'if (false) throw', '[H27]'],
  ['M51', '本文の機微値を見ない', 'if (draftHits.length) throw', 'if (false) throw', '[H27]'],
  ['M52', 'git の中の保存先を通す', "if (gitInfo(fs.existsSync(base) ? base : path.dirname(base)).git) throw", 'if (false) throw', '[H27]'],
  ['M53', '照合を省いたことを受領通知に入れない', "const issues = [...skipped.map(", "const issues = [...[].map(", '[H28]'],
  ['M54', '既定でない保存先でも 1 行に --base を入れない', "return normRepoPath(base) === normRepoPath(homeBase()) ? '/ut-takeover ' + id :", "return true ? '/ut-takeover ' + id :", '[H29]'],
  ['M55', '旧形式の囲みの長さを見ない', "const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\\\s*$');", "const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{3,}\\\\s*$');", '[H30]'],
  ['M56', '読めない資料で全体を止める', "try { buf = read(src); } catch (e) { skip('読めない（' + (e.code || e.message) + '）', st.size); continue; }", 'buf = read(src);', '[H31]'],
  ['M57', '読めない引き継ぎで走査を止める（ファイルかの確認と try の両方をはずす）', '} catch { /* 読めないものは候補にしない */ }', '}', '[H31]', (s) => s.replace("try { // 読めない 1 件で走査全体を止めない" + NL + "      if (!isDir(path.join(base, n)) || !fs.statSync(f).isFile()) continue;", "{" + NL + "      if (!isDir(path.join(base, n)) || !fs.existsSync(f)) continue;")],
  ['M58', '写さなかったものの元のパスを書く', "for (const s of skipped) L.push(`| ${cell(mask(path.basename(s.src)))} |", "for (const s of skipped) L.push(`| ${cell(mask(s.src))} |", '[H32]'],
  ['M59', '説明の縦棒・改行をそのまま表に書く', "const cell = (s) => String(s).replace(/[\\r\\n]+/g, ' ').replace(/\\|/g, '／');", 'const cell = (s) => String(s);', '[H32]'],
  ['M60', '残った下書きを後片付けの候補にしない', "if (st.isFile() && now - st.mtimeMs > LIMITS.partialHours * 36e5) out.push({ name: '.drafts/' + n", "if (false) out.push({ name: '.drafts/' + n", '[H33]'],
  ['M61', 'git の外の引き継ぎで場所を照合しない', "if (cur.git || h['dir-key'] !== cur.dirKey) {", 'if (false) {', '[H19]'],
  ['M62', '警告を受領通知に入れない', "...out.warns.map((w) => w.split('（')[0]),", '', '[H07]'],
  ['M63', 'リポジトリで作った引き継ぎを git の外で --accept-repo なら読む', "if (!cur.git) out.stops.push(", "if (!cur.git && !accept.repo) out.stops.push(", '[H34]'],
  ['M64', '--no-notify の引き継ぎでも peer が宛先と認める', "if (h.notify === 'off') return { match: false", "if (false) return { match: false", '[H20]'],
  // クリップボードの 1 行（Git Bash のパスの変換。2026-10-18 の事象）
  ['M65', 'clip が 1 行の形を検査せずに書く', '  if (bad) return { ok: false, reason: bad };', '', '[H35]'],
  ['M66', '変換の跡を理由に出さない', "(msys ? 'シェル", "(false ? 'シェル", '[H35]'],
  ['M74', 'Git を別の場所に入れたときの変換の跡（D:/Git/…）を見分けない', '/^[A-Za-z]:[\\\\/]/.test(s) || ', '', '[H35]'],
  ["M78", "win32 で、ドライブ名の無いパス（/tmp/x）も絶対パスとして通す", "&& path.win32.isAbsolute(p)", "|| path.win32.isAbsolute(p)", "[H35]"],
  ['M67', 'Windows で clip.exe を先に使う（日本語が化ける・BOM が文字として残る）', "platform === 'win32' ? [['powershell.exe', ", "platform === 'win32' ? [['clip.exe', []], ['powershell.exe', ", '[H21]'],
  ['M68', '読み戻して違っても成功を返す', 'return got === text ? {', 'return true ? {', '[H36]'],
  ['M69', '--id の引き継ぎが保存先に無くても 1 行を作る', "if (!fs.existsSync(path.join(base, id, 'handoff.md'))) throw", 'if (false) throw', '[H37]'],
  ['M70', '--id と --text の両方（どちらも無し）を受ける', 'if ((id === undefined) === (text === undefined)) throw', 'if (false) throw', '[H37]'],
  ['M71', 'link が --text の 1 行を検査しない', '      if (bad) { out({ ok: false, reason: bad, line }); return 1; }', '', '[H37]'],
  ['M72', '知らないオプションを止めない', 'if (Object.hasOwn(SUB_OPTS, cmd)) checkSubOpts(cmd, argv.slice(1));', '', '[H38]'],
  ['M73', '同じオプションの 2 回目を止めない', "    if (seen.has(a)) throw new InputError(`${a} を 2 回指定した", "    if (false) throw new InputError(`${a} を 2 回指定した", '[H38]'],
  ['M75', '1 行の --base を指定した OS の絶対パスとして判定しない', "const isAbsolute = platform === 'win32' ?", "const isAbsolute = path.isAbsolute; const _unused = platform === 'win32' ?", '[H35]'],
  ['M76', '非 ASCII の 1 行を clip.exe で読み戻せなくても成功にする', "if (cmd === 'clip.exe' && /[^\\x00-\\x7f]/.test(text)) return", 'if (false) return', '[H21]'],
  ['M77', '値を取らない --apply を値つきとして扱い、次の余分な語を読み飛ばす', "prune: { values: ['--base'], flags: ['--apply'] }", "prune: { values: ['--apply', '--base'], flags: [] }", '[H38]'],
];

const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',').map((s) => s.trim()).filter(Boolean)) : null;
if (only && !only.size) { console.log('UT_SWEEP_ONLY に ID が無い'); process.exit(1); }
if (only) {
  console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
  const unknown = [...only].filter((id) => !mutations.some((m) => m[0] === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
}

function layout(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ut-handoff.mjs'), body);
  fs.writeFileSync(path.join(dir, 'ut-review.mjs'), REVIEW);
  return path.join(dir, 'ut-handoff.mjs');
}
function runSelftest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, '--selftest'], { cwd: path.dirname(file) });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill(), 300000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
async function runMutant([id, desc, find, to, expect, post]) {
  const hits = SRC.split(find).length - 1;
  if (hits !== 1) return { id, desc, verdict: 'INVALID', detail: `差し込み位置の一致 ${hits} 件` };
  let body = SRC.replace(find, () => to);
  if (post) { const before = body; body = post(body); if (body === before) return { id, desc, verdict: 'INVALID', detail: '後から当てる置き換えが効かない' }; }
  const { code, out } = await runSelftest(layout(path.join(tmp, id), body));
  const ng = out.split(NL).filter((l) => l.trimStart().startsWith('NG'));
  const hit = ng.some((l) => l.trimStart().startsWith('NG  ' + expect + ' '));
  const verdict = hit ? 'CAUGHT' : ng.length ? 'OTHER' : code !== 0 ? 'CRASHED' : 'MISSED';
  return { id, desc, verdict, expect, detail: `NG ${ng.length} 件`, ngNames: ng.map((l) => l.trim().slice(4).split(' | ')[0]), tail: verdict === 'CRASHED' ? out.trim().split(NL).slice(-2).join(' / ') : '' };
}

// 基準実行: 変異を入れない写しで selftest が通ること
{
  const { code, out } = await runSelftest(layout(path.join(tmp, 'base'), SRC));
  if (code !== 0) { console.log('基準実行で失敗: ' + out.split(NL).filter((l) => /NG|selftest:/.test(l)).join(' / ')); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  console.log('基準実行: ' + (out.split(NL).find((l) => l.startsWith('selftest:')) || ''));
}
const queue = mutations.filter((m) => !only || only.has(m[0]));
const rows = [];
const jobs = Math.max(1, Math.min(Number(process.env.UT_SWEEP_JOBS) || 4, os.cpus().length));
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) rows.push(await runMutant(queue.shift())); }));
fs.rmSync(tmp, { recursive: true, force: true });
const order = mutations.map((m) => m[0]);
rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
console.log('== ut-handoff ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log(`  ${r.id.padEnd(6)}${r.verdict.padEnd(8)}${r.desc}  -> ${r.detail}`);
  if (r.verdict !== 'CAUGHT') { for (const n of (r.ngNames || [])) console.log(`          落ちた: ${n}（期待: ${r.expect}）`); if (r.tail) console.log('          ' + r.tail); }
}
const caught = rows.filter((r) => r.verdict === 'CAUGHT').length;
console.log(`${NL}検出 ${caught} / ${rows.length}`);
console.log('対象外: シンボリックリンク・ジャンクションの除外（作る権限が無い環境では selftest がその試験を省く）、本文の一時名での読み直し（読み直しの不一致を起こす手段が無い）、prune が保存先の直下だけを消すこと');
console.log('対象外: LLM が守る決まり（/ut-takeover のターンで許した呼び出しだけを使う）。実機の試験で会話の記録を数えて確かめる');
process.exit(caught === rows.length ? 0 : 1);
