// /ut-review の部品（commands/templates/ut-review.mjs・ut-review-codex.mjs・ut-review-checks.json）と題材集の採点（tools/ut-review-bench.mjs）の
// 防御を 1 つずつ壊し、--selftest が「その防御を見る試験」で落ちるかを確かめる。決定表は規則の行を 1 つずつ消す。
//   node tools/ut-review-sweep.mjs              （repo ルートで実行する）
//   UT_SWEEP_ONLY=A1,R-PLAN node tools/ut-review-sweep.mjs   一部だけ（全件の判定ではない）
//   UT_SWEEP_CHECK=1 node tools/ut-review-sweep.mjs           差し込み位置だけを確かめる（selftest は走らせない。部品を直した後に、位置が見つからない変異を先に洗い出す）
// exit: 0 全件 CAUGHT / 1 それ以外（CAUGHT でないもの・基準実行の失敗・途中の例外）/ 2 部分実行で、選んだものが全件 CAUGHT（全件の合格ではない）
// 一時フォルダは、正常終了・例外・中断（SIGINT・SIGTERM・SIGHUP・SIGBREAK）で消す（消せなければ警告だけ出し、結果は失わない）。
// 強制終了（SIGKILL・taskkill /F・電源断）では消せない。残りは os.tmpdir() の ut-review-sweep-* に残る
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const BS = (n) => '\\'.repeat(n); // 差し込み位置の \ の数を数え間違えないように
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'commands', 'templates');
const FILES = { core: 'ut-review.mjs', codex: 'ut-review-codex.mjs', checks: 'ut-review-checks.json', guide: 'ut-review-guide.txt' };
// 改行は LF にそろえて読む（.gitattributes で LF に固定していない拡張子（.txt）が CRLF で取り出されても、複数行の差し込み位置が外れないように）
const readLf = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, NL);
const SRC = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readLf(path.join(TPL, f))]));
SRC.bench = readLf(path.join(ROOT, 'tools', 'ut-review-bench.mjs'));
// 手順書・設計の記録（部品の selftest の [V65] が決定表と照らす）。変異の対象にもする
const DOCS = { cmd: path.join('commands', 'ut-review.md'), docs: path.join('docs', 'ut-review.md') };
for (const [k, f] of Object.entries(DOCS)) SRC[k] = readLf(path.join(ROOT, f));
// 一時フォルダは ID の検査を通った後に作る。後始末は 1 か所（done と exit のとき）で行う
let tmp = null;
const children = new Set();
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* すでに終了 */ } }
  }
}
const removeTmp = () => {
  if (!tmp) return;
  const t = tmp;
  tmp = null;
  for (const child of children) killTree(child);
  try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) { console.log(`警告: 一時フォルダを消せなかった（${e.code || e.message}）: ${t}`); }
};
process.on('exit', removeTmp);
const done = (code) => { removeTmp(); process.exit(code); };
// Node の既定では SIGTERM・SIGHUP（Windows でコンソールの窓を閉じたとき）・SIGBREAK は exit を出さずに終わるので、ここで受けて消す
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGBREAK', 149]]) { try { process.on(sig, () => done(code)); } catch { /* この OS に無いシグナル */ } }

// [ID, 壊す対象, 走らせる selftest, 内容, 差し込み位置, 置き換え, その防御を見ている試験, （任意）置き換えの後に当てるもの]
// 後に当てるものは [差し込み位置, 置き換え]（差し込み位置と同じく一致がちょうど 1 件であることを確かめる）か、関数（中身が変わったことを確かめる）
const mutations = [
  // 決定表・選定
  ['A1', 'core', 'core', '決定表の規則 ID の重複を通す', 'else if (ids.has(r.id)) p.push(', 'else if (false) p.push(', '[V01]'],
  ['A2', 'core', 'core', '空の規則を通す', 'if (!(r.add || []).length && !(r.groups || []).length) p.push(', 'if (false) p.push(', '[V01]'],
  ['A3', 'core', 'core', 'カナリアの欠けを通す', "for (const f of ['file', 'text', 'lines', 'keywords', 'hint', 'req', 'okHint', 'okLine', 'okReq']) if", "for (const f of []) if", '[V01]'],
  ['A4', 'core', 'core', '種類が当たらないとき文書（一般）にしない', '  return cfg.defaultKind;' + NL + '}' + NL + 'export function extractFeatures', "  return 'code';" + NL + '}' + NL + 'export function extractFeatures', '[V02]'],
  ['A5', 'core', 'core', '利用者の除外を記録しない', 'if (userDrop.includes(c)) { rows.push(', 'if (false) { rows.push(', '[V03]'],
  ['A6', 'core', 'core', '必須のチェックを外せる', "if (m[1] === '-' && cfg.floor.includes(m[2])) throw", 'if (false) throw', '[V03]'],
  ['A7', 'core', 'core', '深さで役を絞らない', 'if (cfg.checks[c].role && !roles.has(c)) {', 'if (false) {', '[V03]'],
  ['A8', 'core', 'core', '知らない --checks を通す', 'if (!m || !cfg.checks[m[2]]) throw', 'if (!m) throw', '[V03]'],
  ['A9', 'core', 'core', '要件なしの requirements を実施と表示する', "if (r.check === 'requirements' && !requirements) {", 'if (false) {', '[V03]'],
  // 目録
  ['A10', 'core', 'core', 'バイナリを対象に入れる', 'if (buf.subarray(0, 8192).includes(0)) return null;', '', '[V04]'],
  ['A11', 'core', 'core', '1 ファイルの上限を見ない', 'if (st.size > lim.maxFileBytes) {', 'if (false) {', '[V04]'],
  ['A12', 'core', 'core', 'リンク・ジャンクションをたどる', 'if (st.isSymbolicLink()) { acc.push({ abs, link: true }); return; }', '', '[V04]'],
  ['A13', 'core', 'core', 'root の外を受け付ける', 'if (!inside(root, abs) && path.resolve(root) !== abs) throw', 'if (false) throw', '[V04]'],
  ['A14', 'core', 'core', 'ジャンクションの下のファイルの直接指定をたどる', 'if (abs !== path.resolve(root) && linkOnPath(root, path.dirname(abs)) && path.dirname(abs) !== path.resolve(root)) { list.push({ abs, link: true }); continue; }', '', '[V04]'],
  ['A15', 'core', 'core', '自動で飛ばすディレクトリを記録しない', 'if (SKIP_DIRS.has(n)) { acc.push({ abs: path.join(abs, n), skipped: true }); continue; }', 'if (SKIP_DIRS.has(n)) continue;', '[V04]'],
  ['A16', 'core', 'core', 'git の差分をリポジトリのトップ基準で読む', "'--no-renames', '--relative', ...DIFF_SAFE, ref]", "'--no-renames', ...DIFF_SAFE, ref]", '[V22]'],
  ['A17', 'core', 'core', '削除されたファイルを黙って落とす', "if (e.status.startsWith('D')) { list.push({ abs, deleted: true }); continue; }", "if (e.status.startsWith('D')) continue;", '[V22]'],
  ['A18', 'core', 'core', 'git の差分でリンクの下を読む', 'if (st.isSymbolicLink() || linkOnPath(root, abs)) { list.push({ abs, link: true }); continue; }', '', '[V22]'],
  // 返答の照合・カナリア・引用
  ['A19', 'core', 'core', '入力のハッシュを照合しない', 'if (reply.inputHash !== task.inputHash) p.push(', 'if (false) p.push(', '[V05]'],
  ['A20', 'core', 'core', '期待した観点の判定を求めない', 'for (const id of task.expect || []) if (!got.has(id)) p.push(', 'for (const id of []) if (!got.has(id)) p.push(', '[V05]'],
  ['A21', 'core', 'core', '読んでいない範囲を出さない', 'if (pos <= r.to) out.push(', 'if (false) out.push(', '[V05]'],
  ['A22', 'core', 'core', '配列でない findings を通す', "if (!Array.isArray(reply.findings)) p.push('findings が配列でない');", "if (false) p.push('findings が配列でない');", '[V05]'],
  ['A23', 'core', 'core', 'カナリアの採点でファイルを見ない', 'normPath(f.file) === normPath(file) && ', '', '[V06]'],
  ['A24', 'core', 'core', 'カナリアの採点で引用の語も数える', "`${f.scenario || ''} ${f.fix || ''}`.toLowerCase()", "`${f.quote || ''} ${f.scenario || ''} ${f.fix || ''}`.toLowerCase()", '[V06]'],
  ['A25', 'core', 'core', 'カナリアの採点で行を見ない', ' && def.lines.includes(f.line)', '', '[V06]'],
  ['A26', 'core', 'core', '引用が無くても成立にする', '  return { ok: false };' + NL + '}' + NL + 'export function quoteSelfCheck', '  return { ok: true, line };' + NL + '}' + NL + 'export function quoteSelfCheck', '[V07]'],
  ['A27', 'core', 'core', '短い引用を通す', '(q.length >= 8 || q === nl)', 'true', '[V07]'],
  ['A28', 'core', 'core', '引用の照合の陽性対照で止めない', "|| check(t, 4, 'x').ok) throw", '&& false) throw', '[V07]'],
  // 統合・等式・表示
  ['A29', 'core', 'core', '統合で指摘を落とす（1 つの返答から 1 件だけ）', "if (x.res.ok) for (const f of x.res.findings || []) raw.push(", "if (x.res.ok) for (const f of (x.res.findings || []).slice(0, 1)) raw.push(", '[V08]'],
  ['A30', 'core', 'core', '統合案の重複を通す', "else if (n > 1) p.push('2 回以上入った指摘: '", "else if (false) p.push('2 回以上入った指摘: '", '[V08]'],
  ['A31', 'core', 'core', '判断の等式を検査しない', 'if (findings.length !== by.確認 + by.棄却 + by.未確定) p.push(', 'if (false) p.push(', '[V09]'],
  ['A32', 'core', 'core', '表示の等式を検査しない', 'if (JSON.stringify(want) !== JSON.stringify(got)) p.push(', 'if (false) p.push(', '[V09]'],
  ['A33', 'core', 'core', '表示を根本原因の案でまとめない', "const k = Number.isInteger(f.cluster) ? 'C:' + f.cluster : 'F:' + (f.id || '#' + i);", "const k = 'F:' + (f.id || '#' + i);", '[V20]'],
  ['A34', 'core', 'core', 'まとまりで確認済みを優先して重大度を選ぶ', 'SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || vr(a.verdict) - vr(b.verdict))[0];', 'vr(a.verdict) - vr(b.verdict) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))[0];', '[V20]'],
  ['A35', 'core', 'core', 'まとまりの一致の数を数えない', "roles.size > 1 ? `${roles.size} つの役が一致` : '1 つの役のみ'", "'1 つの役のみ'", '[V20]'],
  ['A36', 'core', 'core', '折りたたんだ分の ID を数えない', '${oneLine(g.summary)}`); ids.push(...g.ids); }', '${oneLine(g.summary)}`); }', '[V20]'],
  ['A37', 'core', 'core', '上限を超えた指摘を区別しない', 'if (merged.length > lim) {', 'if (false) {', '[V19]'],
  // マスク
  ['A38', 'core', 'core', '鍵・資格情報の代入の型を外す', "{ name: '鍵・資格情報の代入', keep: true, re: keyedSecretRe() },", "{ name: '鍵・資格情報の代入', keep: true, re: /(?!)(x)/g },", '[V10]'],
  ['A39', 'core', 'core', '再走査で伏せる語を見ない', "if (findWordRanges(text, words).length) hits.push('伏せる語');", '', '[V10]'],
  ['A40', 'core', 'core', 'マスクの陽性対照で止めない', "if (find(m, words).length) throw", "if (false) throw", '[V10]'],
  ['A41', 'core', 'core', '型の網羅を確かめない', 'if (missing.length) throw', 'if (false) throw', '[V10]'],
  ['A42', 'core', 'core', '鍵の名前も伏せる', "const keep = p.keep && typeof m[1] === 'string' ? m[1].length : 0;", "const keep = 0;", '[V10]'],
  ['A43', 'core', 'core', '伏字に置き換えると行数が変わる', "for (const [s, e] of merged) { out += text.slice(last, s) + token + nl(text.slice(s, e)); last = e; }", "for (const [s, e] of merged) { out += text.slice(last, s) + token; last = e; }", '[V10]'],
  ['A44', 'core', 'core', 'UTF-8 で読めない語のファイルを通す', "if (t === null) throw new InputError('伏せる語のファイルを UTF-8", "if (false) throw new InputError('伏せる語のファイルを UTF-8", '[V10]'],
  ['A45', 'core', 'core', '「#」で始まる語を注記として捨てる', "!/^#\\s/.test(s)", "!s.startsWith('#')", '[V10]'],
  ['A46', 'core', 'core', '語の照合で本文を正規化する', "export function maskText(text, words, token = '［伏字］') {\n  const ranges", "export function maskText(text, words, token = '［伏字］') {\n  text = text.normalize('NFKC');\n  const ranges", '[V10]'],
  ['A47', 'core', 'core', 'パスを伏せない', "const sendRel = sendPath(t.rel);", "const sendRel = t.rel;", '[V23]'],
  ['A48', 'core', 'core', 'マスクの段で陽性対照を呼ばない', '  check(all);' + NL, '', '[V23]'],
  ['A49', 'core', 'core', '伏字の行の Codex の引用を写しで照合しない', "if (String(f.source).startsWith('codex') && sendByRel.has(t.rel)) {", 'if (false) {', '[V21]'],
  ['A50', 'core', 'core', '検証役に元の行を見せない', 'out.quoteForVerify = splitLines(orig)[q.line - 1];', '', '[V21]'],
  ['A51', 'core', 'core', '写しのハッシュを記録の値で済ませる', "sha(fs.readFileSync(path.join(folder, ...f.sendRel.split('/'))))", 'f.sha', '[V15]'],
  // 段・状態・予定と実績
  ['A52', 'core', 'core', '対象の本文を印で囲まない', 'return `BEGIN-${mark} file=', 'return `file=', '[V11]'],
  ['A53', 'core', 'core', 'ペルソナを同じ出所にする', 'role: `persona#${i + 1}`', "role: 'persona'", '[V11]'],
  ['A54', 'core', 'core', '後始末で消さない', 'try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { removed: false', 'try { } catch (e) { return { removed: false', '[V11]'],
  ['A55', 'core', 'core', 'accept が state.json を書く', '  fs.mkdirSync(path.join(dir, \'results\'), { recursive: true });' + NL + '  writeJsonAtomic(resultFile(dir, taskId)', '  saveState(dir, { ...st, touched: true });' + NL + '  fs.mkdirSync(path.join(dir, \'results\'), { recursive: true });' + NL + '  writeJsonAtomic(resultFile(dir, taskId)', '[V24]'],
  ['A56', 'core', 'core', 'やり直した返答で古い結果を残す', 'writeJsonAtomic(resultFile(dir, taskId), { ...res,', "writeJsonAtomic(resultFile(dir, taskId), { ...(fs.existsSync(resultFile(dir, taskId)) ? JSON.parse(fs.readFileSync(resultFile(dir, taskId), 'utf8')) : {}), ...res,", '[V24]'],
  ['A57', 'core', 'core', '指示を作っていないことを出さない', 'if (!st.stages.tasks) { st.notRun.unshift(', 'if (false) { st.notRun.unshift(', '[V25]'],
  ['A58', 'core', 'core', 'merge なしで報告する', 'if (!st.mergeId && (withFindings.length || codexFiles.length)) throw', 'if (false) throw', '[V25]'],
  ['A59', 'core', 'core', 'merge の後の受理を黙って落とす', 'if (key(nowFrom) !== key(st.mergedFrom)) throw', 'if (false) throw', '[V25]'],
  ['A60', 'core', 'core', '検証の指示を作っていないことを出さない', "if (st.mergeId && st.stages.verifyTasks !== st.mergeId && on('verify') && st.findings.some((f) => f.quoteOk && !f.overLimit && !f.outOfScope)) st.notRun.push(", "if (false) st.notRun.push(", '[V25]'],
  ['A61', 'core', 'core', 'mask をしていない Codex の未実施を出さない', "if (!st.masked) st.notRun.push(`Codex: 未実施", "if (false) st.notRun.push(`Codex: 未実施", '[V25]'],
  ['A62', 'core', 'core', '前回の指摘の不十分を対応 OK にする', "if (vs.some((v) => v.result === '該当あり')) return { result: labels.bad, reason };", "", '[V26]'],
  ['A63', 'core', 'core', '見送りの再審を求めない', "expect = [...ps.map((p) => p.id), ...ws.map((w) => 'WAIVE-' + w.id)];", "expect = [...ps.map((p) => p.id)];", '[V26]'],
  ['A64', 'core', 'core', '要件の判定を報告に出さない', "const j = judgeItem(q.id, qt, results, { ok: '満たす', bad: '満たさない（一部を含む）', none: '判定なし（未実施）' });", "const j = { result: '満たす', reason: '' };", '[V26]'],
  ['A65', 'core', 'core', 'カナリアを拾えない役を人へ上げない', 'if (!(r && r.ok && r.caught === true)) { weakRoles.add(t.forRole); st.escalations.push(', 'if (false) { weakRoles.add(t.forRole); st.escalations.push(', '[V12]'],
  ['A66', 'core', 'core', '引用の無い指摘を棄却しない', "if (!f.quoteOk) { f.verdict = '棄却';", "if (false) { f.verdict = '棄却';", '[V12]'],
  ['A67', 'core', 'core', '照合に外れた返答を受け入れる', 'res = { task: taskId, ok: r.ok,', 'res = { task: taskId, ok: true,', '[V12]'],
  ['A68', 'core', 'core', '前回の残りを消さない', "if (old(d, ['', 'state.json', 'lock.json', 'results'])) rm(d, n);", "if (false) rm(d, n);", '[V13]'],
  ['A69', 'core', 'core', '動いている別のレビューの作業フォルダも消す', "if (old(d, ['', 'state.json', 'lock.json', 'results'])) rm(d, n);", "rm(d, n);", '[V13]'],
  ['A70', 'core', 'core', '消された実行で止まらない', "if (!fs.existsSync(f)) throw new InputError('作業フォルダが無い", "if (false) throw new InputError('作業フォルダが無い", '[V13]'],
  ['A71', 'core', 'core', '対象が変わったことを出さない', 'if (changed.length) { st.alerts.unshift(', 'if (false) { st.alerts.unshift(', '[V14]'],
  ['A72', 'core', 'core', '必須の段の時間を予約しない', 'optionalAllowed: left > reserve', 'optionalAllowed: true', '[V16]'],
  // 検証の指示
  ['A73', 'core', 'core', '検証に対象の全文を渡す', 'const VERIFY_WINDOW = 15;', 'const VERIFY_WINDOW = 100000;', '[V27]'],
  ['A74', 'core', 'core', '指摘の一覧を印で囲まない', "mk('verify', g.verify + '\\n\\n' + dataBlock('指摘（FINDINGS）', b.map((x) => line(x.f)).join('\\n'), mark),", "mk('verify', g.verify + '\\n\\n' + b.map((x) => line(x.f)).join('\\n'),", '[V27]'],
  ['A75', 'core', 'core', 'まとめの指示に本文を渡す', "mk('merge', g.merge + '\\n\\n' + dataBlock('指摘（FINDINGS）', clusterable.map(line).join('\\n')), '',", "mk('merge', g.merge + '\\n\\n' + dataBlock('指摘（FINDINGS）', clusterable.map(line).join('\\n')), targetBlock(clusterable.map((f) => ctx(f)), fenceMark()),", '[V27]'],
  ['A76', 'core', 'core', '作者の確認と検証の棄却が割れても棄却にする', "if (set.size > 1 || (set.has('棄却') && authorConfirms)) {", 'if (set.size > 1) {', '[V27]'],
  // Codex の段の報告
  ['A77', 'core', 'codex', '報告に Codex の未実施を出さない', "if (r.status !== 'ok') st.notRun.push(`Codex（${r.pass}）: 未実施", "if (false) st.notRun.push(`Codex（${r.pass}）: 未実施", '[X07]'],
  ['A78', 'core', 'codex', '報告に Codex の読んでいない範囲を出さない', 'for (const u of r.unread || []) st.notRun.push(`Codex', 'for (const u of []) st.notRun.push(`Codex', '[X08]'],
  ['A79', 'core', 'codex', 'Codex がカナリアを拾えなくても人へ上げない', "if (r.status === 'ok' && (!r.canary || r.canary.caught !== true)) {", 'if (false) {', '[X09]'],
  ['A80', 'core', 'codex', '検証していない指摘に検出力: 未確認の印を付けない', '    f.weak = (f.sources || []).length > 0 && f.sources.every((s) => weakSources.has(String(s)));', '    f.weak = false;', '[X09]'],
  ['A81', 'core', 'codex', '読めなかった Codex の指摘の行を報告に出さない', 'if ((r.broken || []).length) {', 'if (false) {', '[X10]'],
  // Codex のアダプタ
  ['C1', 'codex', 'codex', '了承した写しと送る写しのハッシュを照合しない', "if (hashFiles(tdir, st.masked.files) !== expect) throw", "if (false) throw", '[X04]'],
  ['C2', 'codex', 'codex', '読み取り専用の sandbox を付けない', "'--ephemeral', '--sandbox', 'read-only', ", "'--ephemeral', ", '[X01]'],
  ['C3', 'codex', 'codex', '利用者の設定を読ませる', "'--skip-git-repo-check', '--ignore-user-config', ", "'--skip-git-repo-check', ", '[X01]'],
  ['C4', 'codex', 'codex', '最初の TASK 行を照合しない', 'else if (!p.taskOk || !p.ended)', 'else if (!p.ended)', '[X02]'],
  ['C5', 'codex', 'codex', '最後の REVIEW_END を照合しない', 'else if (!p.taskOk || !p.ended)', 'else if (!p.taskOk)', '[X02]'],
  ['C6', 'codex', 'codex', 'クレジット切れを区別しない', "if (/out of credits/i.test(all)) return 'クレジット切れ';", '', '[X03]'],
  ['C7', 'codex', 'codex', '作業場所を実行フォルダの中に作る', "const made = fs.mkdtempSync(path.join(codexTmpBase(), 'ut-review-codex-'));", "const made = fs.mkdtempSync(path.join(dir, 'codex-work-'));", '[X01]'],
  ['C8', 'codex', 'codex', '外を指すコマンドを拾わない', 'refs.push(`${s} ← ${cmd}`);', '', '[X05]'],
  ['C9', 'codex', 'codex', '実行ファイル自体のパスも外の参照と数える', '{ cmd = raw; rest = dropProgram(raw); }', '{ cmd = raw; rest = raw; }', '[X05]'],
  ['C10', 'codex', 'codex', '外の判定を前方一致で行う', 'if (within(P, w, abs)) continue;', 'if (abs.toLowerCase().startsWith(w.toLowerCase())) continue;', '[X05]'],
  ['C11', 'codex', 'codex', '読んだ範囲が無い 0 件を ok にする', "else if (!p.reads.length) { status = '未実施';", "else if (false) { status = '未実施';", '[X08]'],
  ['C12', 'codex', 'codex', '読んでいない範囲を数えない', 'out.push(...unreadOf(', 'if (false) out.push(...unreadOf(', '[X08]'],
  ['C13', 'codex', 'codex', 'カナリアの指摘を報告に入れる', 'p.findings.filter((f) => !isCan(f)).map(', 'p.findings.map(', '[X09]'],
  ['C14', 'codex', 'codex', 'Codex にカナリアを置かない', "fs.writeFileSync(canAbs, cdef.text, { flag: 'wx' });", '', '[X01]'],
  ['C15', 'codex', 'codex', 'カナリアの置き場所が対象と衝突する', 'if (ok(cdefFile)) return cdefFile;', 'return cdefFile;', '[X09]'],
  ['C16', 'codex', 'codex', '前回の出力を消さずに起動する', 'fs.rmSync(last, { force: true });', '', '[X02]'],
  ['C17', 'codex', 'codex', '失敗の分類で対象の本文を読んだ出力まで見る', "if (ev && /error|fail/i.test(String(ev.type || '') + ' ' + String((ev.item || {}).type || ''))) errs.push(", "if (ev) errs.push(", '[X03]', ['const fail = failed && !timedOut ? classifyFailure(stdout, stderr) : null;', 'const fail = !timedOut ? classifyFailure(stdout, stderr) : null;']],
  ['C18', 'codex', 'codex', '形の誤った FINDING を通す', 'if (!f || findingProblems(f).length) { broken.push(l.slice(0, 80)); continue; }', 'if (!f) { broken.push(l.slice(0, 80)); continue; }', '[X10]'],
  ['C19', 'codex', 'codex', 'Codex の返すパスを手元のパスに戻さない', ".map((f) => (back.has(tail(f.file, work)) ? { ...f, file: back.get(tail(f.file, work)), pathUnmapped: undefined } : { ...f, pathUnmapped: true }))", "", '[X10]'],
  // 2 回目のクロスチェックで直した所
  ['R1', 'core', 'core', '語を先に伏せてから型を当てる（鍵の名前が消えて値が型に当たらない）', 'const ranges = findWordRanges(text, words);' + NL + '  for (const p of SECRET_PATTERNS) {', 'const ranges = findWordRanges(text, words);' + NL + "  text = text.replace(/password/gi, (x) => '#'.repeat(x.length));" + NL + '  for (const p of SECRET_PATTERNS) {', '[V28]'],
  ['R2', 'core', 'core', '引用符の値に過大な最短長を要求する', 'minQuoted = 1, simpleQuoted = false', 'minQuoted = 99, simpleQuoted = false', '[V28]'],
  ['R3', 'core', 'core', '結合文字・半角の濁点をまとめずに正規化する', '/[\\s\\S][\\p{M}\\uFF9E\\uFF9F]*/gu', '/[\\s\\S]/gu', '[V28]'],
  ['R4', 'core', 'core', '伏字のパスの衝突を分けない', 'for (let n = 2; usedMasked.has(cand.toLowerCase()); n++) cand = base.replace(', 'for (let n = 2; false; n++) cand = base.replace(', '[V28]'],
  ['R5', 'core', 'core', '括弧の前の名前を自動で伏せない', "b.replace(/\\s*[（(].*$/, ''), user]", 'user]', '[V28]'],
  ['R6', 'core', 'core', '差分の変換（textconv）を止めない', "const DIFF_SAFE = ['--no-textconv', '--no-ext-diff', '--no-color'];", "const DIFF_SAFE = ['--no-color'];", '[V29]'],
  ['R7', 'core', 'core', '差分のときに自動で飛ばすディレクトリを除かない', "if (e.name.split('/').slice(0, -1).some((s) => SKIP_DIRS.has(s))) { list.push({ abs, skipped: true }); continue; }", '', '[V29]'],
  ['R8', 'core', 'core', '「..」で始まる名前を root の外とする', "r !== '..' && !r.startsWith('..' + path.sep) && !r.startsWith('../')", "!r.startsWith('..')", '[V29]'],
  ['R9', 'core', 'core', '前回の指摘を関係の無いファイルの塊にも渡す', 'const prevForChunk = (prev, ch) => (prev || []).filter((p) => ofFile(p, ch));', 'const prevForChunk = (prev, ch) => (prev || []).filter((p) => ofFile(p, ch) || true);', '[V30]'],
  ['R10', 'core', 'core', '修正の確認のカナリアを「該当あり」だけで拾えた扱いにする', "t.canaryJudge.ok.every((id) => vr(id) === '該当なし')", 'true', '[V30]'],
  ['R11', 'core', 'core', '要件の項目の判定を全部は求めない', "canarySection: g['role:requirements'] + '\\n\\n' + dataBlock('要件（REQ）', reqList([", "expectPrefix: ['REQ-'], canarySection: g['role:requirements'] + '\\n\\n' + dataBlock('要件（REQ）', reqList([", '[V30]', ["expect: st.reqItems.map((q) => q.id), expectPrefix: [],", 'expect: [], ']],
  ['R12', 'core', 'core', '確認済みの件数をまとまりの判断で数える', 'const confG = groups.filter((g) => g.confTop);', "const confG = groups.filter((g) => g.verdict === '確認');", '[V31]'],
  ['R13', 'core', 'core', '表示の等式を申告の ID で数える', 'const dp = displayProblems(st.findings, displayIdsFromMd(md), displayIdsFromMd(md, OUT_OF_SCOPE_HEADING));', 'const dp = displayProblems(st.findings, st.findings.filter((f) => f.verdict !== \'棄却\' && !f.outOfScope).map((f) => f.id), st.findings.filter((f) => f.verdict !== \'棄却\' && f.outOfScope).map((f) => f.id));', '[V31]', ["const m = /^\\| (F\\d+(?:, F\\d+)*) \\|/.exec(l) || /^- (F\\d+(?:, F\\d+)*) /.exec(l);", "const m = /^XX/.exec(l);"]],
  ['R14', 'core', 'core', '行番号を数えずに分ける', 'const cost = (line, n) => Buffer.byteLength(line) + String(n).length + 3;', 'const cost = (line, n) => Buffer.byteLength(line) + 1;', '[V32]', ['export const chunkMaxBytes = (maxCallBytes) => Math.max(4096, maxCallBytes - PROMPT_OVERHEAD);', 'export const chunkMaxBytes = (maxCallBytes) => maxCallBytes;']],
  ['R15', 'core', 'core', '了承を待つ時間を予算に数える', 'Date.parse(st.stages.tasks || st.startedAt)', 'Date.parse(st.startedAt)', '[V32]'],
  ['R16', 'core', 'core', 'merge をしていないことを出さない', "if (st.stages.tasks && !st.mergeId) st.notRun.push(", 'if (false) st.notRun.push(', '[V33]'],
  ['R17', 'core', 'core', '網羅性の監査をしていないことを出さない', "if (on('coverage') && meta.gaps === null) st.notRun.push(", 'if (false) st.notRun.push(', '[V33]'],
  ['R18', 'core', 'core', '形の誤った指摘 1 件で返答全体を外す', "if (fp.length) broken.push(`findings[${i}]: ${fp.join('・')}`); else findings.push(f);", "if (fp.length) p.push(`findings[${i}]: ${fp.join('・')}`); else findings.push(f);", '[V05]'],
  ['R19', 'core', 'core', '返答の中の ``` で JSON を切る', "const m = /^```(?:json)?[ \\t]*\\r?\\n([\\s\\S]*)\\r?\\n```$/.exec(t);", 'const m = /```json\\s*([\\s\\S]*?)```/.exec(t);', '[V05]', ["  try { return JSON.parse(t); } catch { /* \\u56F2\\u307F\\u3092\\u5916\\u3057\\u3066\\u8AAD\\u3080 */ }\n", '']],
  ['R20', 'core', 'core', '形の違う統合案を通す', "if (!c || typeof c !== 'object' || !Array.isArray(c.ids) || typeof c.root !== 'string') p.push(", 'if (false) p.push(', '[V08]'],
  ['R21', 'core', 'core', '前のマスクの写しへの Codex の結果を使う', "if (r.status === 'ok' && st.masked && r.maskedSetHash !== st.masked.setHash) { st.codexStale.push(r.pass); continue; }", '', '[V21]'],
  ['C20', 'codex', 'codex', '時間切れでプロセスを止めない', "const r = spawnSync(node, ['-e', WRAP, String(ms), ...argv], { cwd: work, input: prompt, encoding: 'utf8', timeout: ms + 120e3,", "const r = spawnSync(node, argv, { cwd: work, input: prompt, encoding: 'utf8', timeout: ms + 120e3,", '[X11]'],
  ['C21', 'codex', 'codex', '写しを作業場所の直下に置く', "const tdir = path.join(work, SUB);", 'const tdir = work;', '[X12]'],
  ['C22', 'codex', 'codex', 'プロジェクトの指示（AGENTS.md）を読ませる', "'-c', 'project_doc_max_bytes=0', ", '', '[X12]'],
  ['C23', 'codex', 'codex', '作業場所に置く前の写しでハッシュを取る', 'if (hashFiles(tdir, st.masked.files) !== expect) throw', "if (hashFiles(path.join(dir, 'masked'), st.masked.files) !== expect) throw", '[X12]'],
  ['C24', 'codex', 'codex', '作業場所のパスのユーザー名を記録しない', 'const workPathHasUser = autoWords().some(', 'const workPathHasUser = false && autoWords().some(', '[X13]'],
  ['A82', 'core', 'codex', '残った Codex の作業場所を消さない', "try { for (const n of fs.readdirSync(tmpBase).filter((x) => x.startsWith('ut-review-codex-'))) { const d = path.join(tmpBase, n); if (old(d, [''])) rm(d, n); } } catch { /* 置き場が読めなくても準備は続ける */ }", '', '[X13]'],
  ['C25', 'codex', 'codex', '引用符付きの空白を含むパスを切って外と数える', "const stripped = rest.replace(QUOTED_ABS, ' ');", 'const stripped = rest;', '[X05]', ['const tokens = [...quoted, ...', 'const tokens = [...']],
  ['C26', 'codex', 'codex', 'UNC の判定を緩めて書式文字列を外と数える', '${BC}' + BS(4) + '${SEG}+' + BS(2) + '(?!' + BS(2) + ')${T}+', '${BC}' + BS(4) + '${T}+', '[X05]'],
  ['C27', 'codex', 'codex', 'カナリアが対象とフォルダを共有するだけで別の場所に避ける', "if (files.has(segs.join('/')) || dirs.has(segs.join('/'))) return false;", "if (files.has(segs.join('/')) || dirs.has(segs.join('/')) || dirs.has(segs.slice(0, -1).join('/'))) return false;", '[X09]'],
  ['G1', 'guide', 'core', '較正の例にカナリアの欠陥の行を書く', '良い指摘の例: 「schedule.md:3 `提出の締め切りは 2027-02-30 とする`', '良い指摘の例: 「x.js:4 `for (let i = 0; i <= values.length; i++) {`', '[V17]'],
  ['G2', 'guide', 'core', 'データのペルソナを深さの人数より少なくする', '3. 変える人: この設定・データを後から書き換える人として', '変える人: この設定・データを後から書き換える人として', '[V17]'],
  ['B1', 'bench', 'bench', '採点で行を見ない', 'd.lines.includes(f.line) && ', '', '[B04]'],
  ['B2', 'bench', 'bench', '採点で棄却も命中にする', "['確認', '未確定'].includes(f.verdict)", 'true', '[B04]'],
  // 3 回目の指摘で直した所（エスケープした JSON のマスク・伏字の後ろの判定・未回答の merge・監査に渡すもの・UNC と外の参照の記録）
  ['A83', 'core', 'core', '鍵の名前の後ろのエスケープした引用符（\\" など）を見ない', '${KEY_NAMES}' + String.raw`(?:\\\\*["'])?\\s*`, '${KEY_NAMES}' + String.raw`["']?\\s*`, '[V34]'],
  ['A84', 'core', 'core', 'マスクにも push 前検査用の単純な引用値だけを使う', 'minQuoted = 1, simpleQuoted = false', 'minQuoted = 1, simpleQuoted = true', '[V34]'],
  ['A85', 'core', 'core', 'マスクの陽性対照からエスケープした JSON の見本を外す', String.raw`['"{\\"api_' + 'key\\": \\"abcdefgh12\\"}"', 'abcdefgh12']`, String.raw`['"{"api_' + 'key": "abcdefgh12"}"', 'abcdefgh12']`, '[V34]'],
  ['A86', 'core', 'core', '伏字で始まる値も普通の値として判定する', "(?![=>\"'])(?!［伏字］)[^", "(?![=>\"'])[^", '[V35]'],
  ['A87', 'core', 'core', '伏字の後ろに残った生の値を見ない', String.raw`|［伏字］[A-Za-z0-9][^\\s"';,)}\\]]{$` + '{minUnquoted - 1},}', '', '[V35]'],
  ['A88', 'core', 'core', '返答の無いタスクがあっても merge を通す', 'if (pending.length && !partial) throw', 'if (false) throw', '[V36]'],
  ['A89', 'core', 'core', 'カナリアの未回答を数えない', 'filter((t) => !t.kind && !results[t.id])', 'filter((t) => !t.kind && !t.canary && !results[t.id])', '[V36]'],
  ['A90', 'core', 'core', '--partial の未回答を記録しない', 'if (pending.length) st.notRun.push(', 'if (false) st.notRun.push(', '[V36]'],
  ['A91', 'core', 'core', 'merge をやり直すと未回答の記録が重なる', "  st.notRun = st.notRun.filter((n) => !/^merge 時点で未回答/.test(n));" + NL, '', '[V36]'],
  ['A92', 'core', 'core', 'CLI で --partial を渡さない', "{ partial: has(argv, '--partial') }", '{ partial: false }', '[V36]'],
  ['A93', 'core', 'core', '網羅性の監査に Codex の結果を渡さない', " + '\\n\\n' + dataBlock('Codex の結果（CODEX）', codexSummary(dir, st, cfg, on).join('\\n'))", '', '[V37]'],
  ['A94', 'core', 'core', '網羅性の監査に要件の一覧を渡さない', " + '\\n\\n' + dataBlock('要件（REQ）', req)", '', '[V37]'],
  ['A95', 'core', 'core', '網羅性の監査に Codex のカナリアの範囲を渡す', '.filter((x) => !(r.canary && normPath(x.file) === normPath(r.canary.file)))', '', '[V37]'],
  ['A96', 'core', 'core', '網羅性の監査に Codex の未実施の理由を渡さない', "    if (r.status !== 'ok') return `Codex（${ps}）: 未実施（${r.reason}）`;" + NL, '', '[V37]'],
  ['A97', 'core', 'core', '網羅性の監査に Codex の読んだ範囲を送ったパスのまま渡す', 'const at = (x) => `${back.get(normPath(x.file)) || x.file}:', 'const at = (x) => `${x.file}:', '[V37]'],
  ['A98', 'core', 'codex', '報告に Codex の外の参照の件数とコマンドの数を出さない', "参照 ${refs.length} 件（うち絶対パス・UNC で外と確かめたもの ${refs.filter((x) => x.sure).length} 件${r.outsideCommands ? `。${r.outsideCommands} 回のコマンドから` : ''}。", '', '[X07]'],
  ['G3', 'guide', 'core', '監査役の指示に Codex の結果・要件を読ませない', '「読んだ範囲（READ）」「Codex の結果（CODEX）」「要件（REQ）」「選定」', '「読んだ範囲（READ）」「選定」', '[V37]'],
  ['C28', 'codex', 'codex', 'UNC のホスト名の後ろに \\ が続いてもよいとする（書式文字列の \\\\n…\\\\n を外と数える）', '${SEG}+' + BS(2) + '(?!' + BS(2) + ')${T}+', '${SEG}+' + BS(2) + '${T}+', '[X14]'],
  ['C29', 'codex', 'codex', 'UNC の前の区切りを見ない（語の途中の \\\\ を外と数える）', '${BC}' + BS(4) + '${SEG}', BS(4) + '${SEG}', '[X14]'],
  ['C30', 'codex', 'codex', '1 つのコマンドで最初の外の参照だけを記録する', '      sure.push((resolvable && !(P === path.win32 && /^\\/[^\\\\/.]+$/.test(s))) || sureOutside(s));' + NL, '      sure.push((resolvable && !(P === path.win32 && /^\\/[^\\\\/.]+$/.test(s))) || sureOutside(s));' + NL + '      break;' + NL, '[X14]'],
  ['C31', 'codex', 'codex', '同じ外の参照を重ねて記録する', '      if (seen.has(key)) continue;' + NL, '', '[X14]'],
  // 4 回目の指摘で直した所（外の参照の拾い方・記録・報告、監査に渡す読んでいない範囲、試験の抜け）
  ['C32', 'codex', 'codex', 'ドライブ名の前の境界を見ない（https:// の s:// や Total:\\n を外と数える）', '(?<![A-Za-z0-9])[A-Za-z]:', '[A-Za-z]:', '[X15]'],
  ['C33', 'codex', 'codex', 'ドライブ名の後ろが // のもの（URL の形）も拾う', '[A-Za-z]:(?:' + BS(2) + '|/(?!/))', '[A-Za-z]:[' + BS(2) + '/]', '[X15]'],
  ['C57', 'codex', 'codex', '引用符で囲んだドライブ名つきのパスで、後ろが // のもの（URL の形）も拾う', String.raw`/"([A-Za-z]:(?:\\|\/(?!\/))[^"]*)"|'([A-Za-z]:(?:\\|\/(?!\/))[^']*)'/g`, String.raw`/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'/g`, '[X15]'],
  ['C34', 'codex', 'codex', 'スラッシュの UNC（//host/share）を拾わない', '  String.raw`${B}//${SEG}+/(?!/)${T}+`,' + NL, '', '[X14]'],
  ['C35', 'codex', 'codex', 'スラッシュの UNC をコロンの後ろでも拾う（URL を外と数える）', '${B}//${SEG}', '${BC}//${SEG}', '[X14]'],
  ['C36', 'codex', 'codex', 'UNC のホスト名を ASCII に戻す（\\\\?\\UNC\\・ASCII 以外のホスト名を拾わない）', '${BC}' + BS(4) + '${SEG}+', '${BC}' + BS(4) + '[A-Za-z0-9._$-]+', '[X14]'],
  ['C37', 'codex', 'codex', 'UNC をコロンの後ろで拾わない（-Path:\\\\srv\\s）', '${BC}' + BS(4) + '${SEG}+' + BS(2) + '(?!', '${B}' + BS(4) + '${SEG}+' + BS(2) + '(?!', '[X14]'],
  ['C38', 'codex', 'codex', 'エスケープした UNC（\\\\\\\\host\\\\）を拾わない', '${B}' + BS(8) + '${SEG}', '${B}(?!)' + BS(8) + '${SEG}', '[X14]'],
  ['C39', 'codex', 'codex', '前の区切りにカンマを含めない（a.js,/x を拾わない）', String.raw`(?<=^|[\s"'(=,;|&\[{<>])` + '`, BC = String.raw`' + String.raw`(?<=^|[\s"'(=,;|&\[{<>:])`, String.raw`(?<=^|[\s"'(=;|&\[{<>])` + '`, BC = String.raw`' + String.raw`(?<=^|[\s"'(=;|&\[{<>:])`, '[X16]'],
  ['C40', 'codex', 'codex', '.. の前の区切りにカンマを含めない', String.raw`(?<=^|[\s"'(=;,:\\/])\.\.`, String.raw`(?<=^|[\s"'(=;:\\/])\.\.`, '[X16]'],
  ['C41', 'codex', 'codex', '\\ で始まるルート直下の 1 段（\\secret.txt）を拾わない', '  String.raw`${BC}' + BS(2) + '${SEG}{2,}${END}`,' + NL, '', '[X16]'],
  ['C42', 'codex', 'codex', '/ で始まるルート直下の 1 段（/flag）を拾わない', '${B}/(?=${SEG}*\\.|${SEG}{3})', '${B}/(?!)(?=${SEG}*\\.|${SEG}{3})', '[X16]'],
  ['C43', 'codex', 'codex', '/ の 1 段をオプション（cmd /c）と区別しない', '${B}/(?=${SEG}*\\.|${SEG}{3})', '${B}/', '[X16]'],
  ['C44', 'codex', 'codex', 'ルートの \\ だけ（dir \\）を拾わない', '  String.raw`${BC}' + BS(2) + String.raw`(?=$|[\s|;,)])` + '`,' + NL, '', '[X16]'],
  ['C45', 'codex', 'codex', '1 本の \\ の書式文字列（\\nfoo\\n）を外と数える', '      if (q && /^' + BS(2) + '(?!' + BS(2) + ')/.test(s) && ESCAPES_ONLY.test(s)) continue;' + NL, '', '[X14]'],
  ['C46', 'codex', 'codex', '変数の名前の大文字小文字を区別する（$home・$Env: を拾わない）', "].join('|'), 'gi');", "].join('|'), 'g');", '[X17]'],
  ['C47', 'codex', 'codex', 'ドライブ名なしの絶対パスを中かどうか確かめずに外と数える', 'const resolvable = /^[A-Za-z]:[' + BS(2) + '/]/.test(local) || (', 'const resolvable = /^[A-Za-z]:[' + BS(2) + '/]/.test(local) || false && (', '[X18]'],
  ['C48', 'codex', 'codex', 'POSIX の作業場所でも Windows の規則で中かを判定する（大文字小文字を区別しない）', "const P = String(workDir).startsWith('/') ? path.posix : path.win32;", 'const P = path.win32;', '[X18]'],
  ['C49', 'codex', 'codex', '\\\\?\\C:\\ の形を UNC として外と数える（作業場所の中でも）', "s.replace(/^" + BS(4) + "[?.]" + BS(2) + "(?=[A-Za-z]:)/, '')", 's', '[X18]'],
  ['C50', 'codex', 'codex', '配列の command を飛ばす', 'else if (Array.isArray(raw) && raw.length) {', 'else if (false) {', '[X19]'],
  ['C51', 'codex', 'codex', '配列の command の先頭（プログラム）も外の参照と数える', "rest = ' ' + raw.slice(1).map(String).join(' ');", "rest = ' ' + raw.map(String).join(' ');", '[X19]'],
  ['C52', 'codex', 'codex', '判定できないコマンドの出来事を数えない', 'else { bad.add(id); continue; }', 'else continue;', '[X19]'],
  ['C53', 'codex', 'codex', 'コマンドでない出来事も判定できないと数える', "const isCmd = type === 'command_execution' || type === 'exec_command_begin' || 'command' in item;", 'const isCmd = true;', '[X19]'],
  ['C54', 'codex', 'codex', '判定できなかった出来事の件数を結果に残さない', 'outsideUnjudged: outside.unjudged, ', '', '[X19]'],
  ['A99', 'core', 'codex', '報告に判定できなかった出来事を出さない', 'if (r.outsideUnjudged) st.alerts.push(', 'if (false) st.alerts.push(', '[X19]'],
  ['C55', 'codex', 'codex', '同じ参照をコマンドごとに記録する（コマンドをまたいでまとめない）', 'const key = normPath(s);', 'const key = normPath(s) + cmd;', '[X20]'],
  ['C56', 'codex', 'codex', '外の参照が当たったコマンドの数を数えない', '      hits.add(id);' + NL, '', '[X20]'],
  ['A100', 'core', 'codex', '報告の JSON に外の参照を残さない', 'outsideReads: outside, equations', 'equations', '[X20]'],
  ['A101', 'core', 'codex', '外の参照を確度の順に並べない', '  outside.sort((a, b) => b.sure - a.sure);' + NL, '', '[X20]', ['})).sort((a, b) => b.sure - a.sure);', '}));']],
  ['A102', 'core', 'codex', 'md に外の参照の全件を出さない', 'if (outs.length || extra.codexSent) {', 'if (false) {', '[X20]'],
  ['A103', 'core', 'codex', 'UNC を確度の高い参照に入れない', '|' + BS(4) + '|' + BS(1) + '/' + BS(1) + '/)/.test(String(x))', ')/.test(String(x))', '[X20]'],
  ['A104', 'core', 'core', '網羅性の監査に Codex の読んでいない範囲を送ったパスのまま渡す', 'const unread = (r.unread || []).map(at);', 'const unread = (r.unread || []).map((u) => `${u.file}:${u.from}-${u.to}`);', '[V37]'],
  ['A105', 'core', 'core', '未回答のカナリアの役を検出力: 未確認にしない', 'if (t.canary) { if (!(r && r.ok && r.caught === true)) {', 'if (t.canary) { if (r && !(r.ok && r.caught === true)) {', '[V36]'],
  // 一重引用符の枝だけを 3 乗の遅さにする（指数的にすると selftest が止まらず、試験で落ちたことにならない。5000 個の \ で数十秒）
  ['A106', 'core', 'core', 'エスケープした一重引用符の値の照合を遅くする', String.raw`|\\\\(?!\\\\*'))`, String.raw`|\\\\(?!\\\\*\\\\*'))`, '[V34]'],
  // 5 回目の指摘で直した所（外の参照の拾い方・確度・記録・数え方、パスの戻し、送った記録、終了コード、READ の丸め、分割・見積もり、マスクのやり直し）
  ['C58', 'codex', 'codex', '文字列の外の \\temp\\x も書式文字列として捨てる', '      if (q && /^', '      if (/^', '[X21]'],
  ['C59', 'codex', 'codex', 'エスケープした引用符の前の \\ をルートと数える', '${BC}' + BS(2) + String.raw`(?=$|[\s|;,)])`, '${BC}' + BS(2) + '${END}', '[X21]'],
  ['C60', 'codex', 'codex', '\\" を " と同じ引用符として数える（包みの中の node -e の文字列の深さを誤る）', "const kind = (b % 2 ? '\\\\' : '') + c;", 'const kind = c;', '[X21]'],
  ['C61', 'codex', 'codex', 'pwsh -Command "…" の包みの引用符も文字列に数える', 'const need = WRAPPED.test(stripped) ? 2 : 1;', 'const need = 1;', '[X21]'],
  ['C62', 'codex', 'codex', '.. の前の区切りにコロンを含めない（-Path:..\\x を拾わない）', String.raw`(?<=^|[\s"'(=;,:\\/])\.\.`, String.raw`(?<=^|[\s"'(=;,\\/])\.\.`, '[X22]'],
  ['C63', 'codex', 'codex', '~ の後ろを区切りと行末だけにする（cd ~; … を拾わない）', String.raw`~(?=[\\/]|$|[\s;|&)"'])`, String.raw`~(?=[\\/]|$)`, '[X22]'],
  ['C64', 'codex', 'codex', '${HOME} を拾わない', String.raw`|\$\{HOME\}`, '', '[X22]'],
  ['C65', 'codex', 'codex', '~ の前の区切りにコロンを含めない（-Path:~\\x を拾わない）', String.raw`(?<=^|[\s"'(,:])~`, String.raw`(?<=^|[\s"'(,])~`, '[X22]'],
  ['C66', 'codex', 'codex', '確度を文字列の形だけで決める（確かめた外のパスを要確認にする）', 'sure.push((resolvable && !(P === path.win32 && /^\\/[^\\\\/.]+$/.test(s))) || sureOutside(s));', 'sure.push(sureOutside(s));', '[X23]'],
  ['A107', 'core', 'codex', '報告でアダプタの確かめた確度を使わない', 'Array.isArray(r.outsideSure) ? r.outsideSure[i] === true : sureOutside(x)', 'sureOutside(x)', '[X23]'],
  ['A108', 'core', 'core', '外の参照をパスをまたいで並べない（パスの中だけ）', '  outside.sort((a, b) => b.sure - a.sure);' + NL, '', '[V45]'],
  ['C67', 'codex', 'codex', '外の参照のパス・コマンドを切って記録する', 'refs.push(`${s} ← ${cmd}`);', 'refs.push(`${s.slice(0, 80)} ← ${cmd.slice(0, 100)}`);', '[X24]'],
  ['A109', 'core', 'codex', '先に見ることの外の参照を表示で切らない', 'refs.slice(0, 3).map((x) => shortRef(x.ref))', 'refs.slice(0, 3).map((x) => x.ref)', '[X24]'],
  ['C68', 'codex', 'codex', 'コマンドを item.id で 1 回に数えない（出来事ごとに数える）', "const id = item.id || item.call_id || (ev && ev.call_id) || '#' + n++;", "const id = '#' + n++;", '[X25]'],
  ['C69', 'codex', 'codex', 'exec_command_end なども判定できないコマンドと数える', "type === 'exec_command_begin'", '/exec_command/.test(type)', '[X25]'],
  ['C70', 'codex', 'codex', '見分けたコマンドの数を結果に残さない', 'outsideSeen: outside.total, ', '', '[X25]'],
  ['A110', 'core', 'codex', 'コマンドを 1 件も見分けられない完走を先に見ることに出さない', "if (r.status === 'ok' && (r.reads || []).length && r.outsideSeen === 0) st.alerts.push(", 'if (false) st.alerts.push(', '[X25]'],
  ['C71', 'codex', 'codex', '作業場所の絶対パスを外さずに照合する', "  if (w && s.startsWith(w + '/')) s = s.slice(w.length + 1);" + NL, '', '[X26]'],
  ['A111', 'core', 'codex', 'パスを戻せない Codex の指摘を棄却にする', "if (f.pathUnmapped) { f.verdict = '未確定';", "if (false) { f.verdict = '未確定';", '[X26]'],
  ['A112', 'core', 'codex', 'パスを戻せなかったことを人へ上げない', 'if ((r.unmappedFiles || []).length) st.escalations.push(', 'if (false) st.escalations.push(', '[X26]'],
  ['C72', 'codex', 'codex', '送った後の例外で「送った」記録を残さない', 'if ((sent || presaved) && !result) {', 'if (false) {', '[X27]'],
  ['C73', 'codex', 'codex', '想定外の失敗を入力の誤りと同じ 2 で返す（アダプタ）', 'return e instanceof CheckError ? 1 : e instanceof InputError ? 2 : 3;', 'return e instanceof CheckError ? 1 : 2;', '[X28]'],
  ['A113', 'core', 'core', '想定外の失敗を入力の誤りと同じ 2 で返す（部品）', 'return e instanceof CheckError ? 1 : e instanceof InputError ? 2 : 3;', 'return e instanceof CheckError ? 1 : 2;', '[V46]'],
  // C74（アダプタの側で READ の申告を絞る処理を壊す）は外した: 同じ守りを core の unreadOf に 1 か所にまとめたので、アダプタの側の処理は消した（守りは A176 が見る）
  ['A114', 'core', 'codex', '使えなかった READ の申告を報告に出さない', 'if ((r.badReads || []).length) st.notRun.push(', 'if (false) st.notRun.push(', '[X29]'],
  ['C75', 'codex', 'codex', '試験で UT_REVIEW_CODEX_TMP を退避しない', '  delete process.env.UT_REVIEW_CODEX_TMP;' + NL + '  const tmp = fs.mkdtempSync(', '  const tmp = fs.mkdtempSync(', '[X30]'],
  ['A115', 'core', 'core', '塊の差分のある行を塊の範囲で絞らない', 'const inRange = (t.changed || []).filter(([a, b]) => b >= t.from && a <= t.to).map(([a, b]) => [Math.max(a, t.from), Math.min(b, t.to)]);', 'const inRange = t.changed || [];', '[V38]'],
  ['A116', 'core', 'core', 'Claude の役の READ をパスの完全一致で照合する', 'normPath(x.file) === normPath(r.file)', 'x.file === r.file', '[V39]'],
  ['A117', 'core', 'core', '網羅性の監査に渡す予定の Codex のパスを別の式で数える', 'const passes = [...new Set([...plannedCodexPasses(st, cfg, on), ...have])];', "const passes = [...new Set([...['free', 'checklist'].slice(0, cfg.depth[st.depth].codexPasses || 1), ...have])];", '[V40]'],
  ['A118', 'core', 'core', '大文字小文字だけが違う別のファイルを黙って落とす', '      excluded.push({ rel, reason: `大文字小文字だけが違う別のファイル（', '      if (0) excluded.push({ rel, reason: `大文字小文字だけが違う別のファイル（', '[V41]'],
  ['A119', 'core', 'core', '見積もりを総バイト数だけで数える', "const review = winRoles * chunks + (own('requirements') ? sets.full.length : 0)", "const review = roles * Math.max(1, Math.ceil(items.reduce((n, t) => n + t.bytes, 0) / cfg.limits.maxCallBytes)) + 0 * (own('requirements') ? sets.full.length : 0)", '[V42]'],
  ['A120', 'core', 'core', '上限を超える 1 行を黙って 1 つの塊にする', 'if (one > maxBytes) throw', 'if (false) throw', '[V43]'],
  ['A121', 'core', 'core', '上限を超える行のある対象を準備で外さない', 'const ln = oversizeLine(t.text, cfg.limits.maxCallBytes, t);', 'const ln = 0;', '[V43]'],
  ['A122', 'core', 'core', 'merge の後のマスクのやり直しで report を止めない', "if ((st.masked ? st.masked.setHash : null) !== (st.mergedMask ?? null)) throw", 'if (false) throw', '[V44]'],
  // F024（Codex の読み取りの範囲の明記）
  ['A123', 'core', 'core', 'mask の出力に Codex の読み取りの範囲を入れない', ', codexReadScope: CODEX_READ_SCOPE };', ' };', '[V47]'],
  ['A124', 'core', 'core', 'Codex に送った実行で、外の参照 0 件のときに先に見ることへ出さない', 'if (codexSent) st.alerts.push(', 'if (codexSent && outside.length) st.alerts.push(', '[V47]'],
  ['A125', 'core', 'core', 'Codex に送る前に止まった実行でも読み取りの範囲を出す', "if (r.sent === true || r.status === 'ok') codexSent = true;", 'codexSent = true;', '[V47]'],
  // 知らないオプションを止める（ID は A5 の設計で予約した A126〜A142・C76〜C78 を避けた）
  ['A143', 'core', 'core', '段のオプションを検査しない', '    if (Object.hasOwn(STAGE_OPTS, cmd)) checkOpts(cmd, argv.slice(1));' + NL, '', '[V55]'],
  ['A144', 'core', 'core', '知らないオプションを通す', '    if (!ok.includes(a)) {', '    if (false) {', '[V55]'],
  ['A145', 'core', 'core', '--files と --base の同時指定を通す', "if (seen.has('--files') && seen.has('--base')) throw", 'if (false) throw', '[V55]'],
  ['A146', 'core', 'core', '段を区別せず、どの段のオプションも許す', 'const ok = Object.hasOwn(table, cmd) ? table[cmd] : [];', 'const ok = Object.values(table).flat();', '[V55]'],
  ['A147', 'core', 'core', '値を取らないオプションの後ろの語も値として読み飛ばす', '    if (flags.includes(a)) continue;' + NL, '', '[V55]'],
  ['A148', 'core', 'core', '同じオプションの 2 回目を通す', 'if (seen.has(a)) throw', 'if (false) throw', '[V55]'],
  ['A149', 'core', 'core', '余分な引数を知らないオプションと同じに扱う', "if (!a.startsWith('--')) throw new InputError(`余分な引数", "if (false) throw new InputError(`余分な引数", '[V55]'],
  // A5（差分の周辺だけのレビュー）
  ['A126', 'core', 'core', '差分の窓の隣り合い（[1,40] と [41,…]）を結合しない', 'r[0] < l[1] + gap', 'r[0] < l[1]', '[V48]'],
  ['A127', 'core', 'core', '差分の窓の行数を設定によらず 30 に固定する', 'const [s, e] = aroundLines(a, b, lines, ctx);', 'const [s, e] = aroundLines(a, b, lines, 30);', '[V48]'],
  ['A156', 'core', 'core', '空のファイル（行数 0）にも窓を作る', '  if (!lines) return [];' + NL, '', '[V48]'],
  ['A157', 'core', 'core', '差分の窓を 1〜行数に切らない', 'const a = Math.min(Math.max(1, a0), lines), b = Math.min(Math.max(a, b0), lines);', 'const a = a0, b = b0;', '[V48]'],
  ['A128', 'core', 'core', '先頭の削除（+0,0）を 1 行目に寄せない', 'n === 0 ? [Math.max(1, c), Math.max(1, c)]', 'n === 0 ? [c, c]', '[V49]'],
  ['A129', 'core', 'core', '未追跡の新しいファイルを全行の差分にしない', "      if (e.status === '?') { changed[rel] = 'whole'; continue; }" + NL, '', '[V49]'],
  ['A152', 'core', 'core', '行の差分を取れない（git の失敗）ことを記録しない', "if (d === null) { diffFailed.set(rel, '差分の行を取れなかった（git の失敗）'); continue; }", 'if (d === null) continue;', '[V49]'],
  ['A130', 'core', 'core', '塊を作るときに窓を見ない（差分のときもファイル全体を渡す）', 'for (const [ws, we] of t.windows || [[1, n]]) {', 'for (const [ws, we] of [[1, n]]) {', '[V50]'],
  ['A158', 'core', 'core', '窓 []（渡す行なし）を全体として扱う', 'for (const [ws, we] of t.windows || [[1, n]]) {', 'for (const [ws, we] of (t.windows && t.windows.length ? t.windows : [[1, n]])) {', '[V50]'],
  ['A162', 'core', 'core', '不正な窓（1 ≤ 開始 ≤ 終了 ≤ 行数 でない）を止めない', 'if (!(Number.isInteger(ws) && Number.isInteger(we) && ws >= 1 && ws <= we && we <= n)) throw', 'if (false) throw', '[V50]'],
  ['A131', 'core', 'core', '塊の見出し・END の行の分を上限に数えない', 'const head = blockOverhead(t, from, we, n);', 'const head = 0;', '[V50]'],
  ['A159', 'core', 'core', 'ファイルの一部の塊の見出しに of=<全行数> を出さない', "const of = t.from > 1 || t.to < n ? ` of=${n}` : '';", "const of = '';", '[V50]'],
  ['A166', 'core', 'core', '見積もりで要件の突き合わせを窓の塊で数える', "(own('requirements') ? sets.full.length : 0)", "(own('requirements') ? sets.win.length : 0)", '[V50]'],
  ['A132', 'core', 'core', '--files でも差分の窓を作る', "const mode = files || scopeArg === 'file' ? 'full' : 'diff';", "const mode = scopeArg === 'file' ? 'full' : 'diff';", '[V51]'],
  ['A133', 'core', 'core', '--scope file を無視する', "const mode = files || scopeArg === 'file' ? 'full' : 'diff';", "const mode = files ? 'full' : 'diff';", '[V51]'],
  ['A160', 'core', 'core', '知らない --scope の値を通す', "if (scopeArg !== undefined && !['diff', 'file'].includes(scopeArg)) throw", 'if (false) throw', '[V51]'],
  ['A164', 'core', 'core', '--files と --scope diff の組み合わせを通す', "if (files && scopeArg === 'diff') throw", 'if (false) throw', '[V51]'],
  ['A153', 'core', 'core', 'hunk 0 件（内容の差分なし）のファイルを対象外にしない', 'if (!w.length) { excluded.push(', 'if (false) { excluded.push(', '[V51]'],
  ['A163', 'core', 'core', '空のファイルを 1 行として窓を作る', "diffWindows(t.changed, t.text === '' ? 0 : t.lines, ctx)", 'diffWindows(t.changed, t.lines, ctx)', '[V51]'],
  ['A161', 'core', 'core', '行の差分を取れなかったファイルを全体にしない', 'if (t.wholeReason) { targets.push({ ...t, windows: null }); wholeNotes.push(', 'if (false) { targets.push({ ...t, windows: null }); wholeNotes.push(', '[V51]'],
  ['A165', 'core', 'core', '全体に広げた理由を未実施に出さない', '  st.notRun.push(...wholeNotes);' + NL, '', '[V51]'],
  ['A151', 'core', 'core', '差分の周辺のときに手引きの scope:diff を前置きに入れない', ", ...(diff ? [g['scope:diff']] : [])", '', '[V51]'],
  ['G4', 'guide', 'core', '手引きの scope:diff の節を消す', '=== 節: scope:diff ===', '=== 節: scope-diff-removed ===', '[V17]'],
  ['A134', 'core', 'core', '窓の外の行を指す指摘に範囲外の印を付けない', 'if (cand.every((l) => !inWindows(l, t.windows))) out.outOfScope = true;', 'if (false) out.outOfScope = true;', '[V52]'],
  ['A154', 'core', 'core', '範囲外を補正後の行だけで決める（境目で曖昧な指摘を範囲外にする）', 'const cand = [f.line, ...quoteHits(qText, f.line, f.quote)];', 'const cand = [out.line];', '[V52]'],
  ['A135', 'core', 'core', '範囲外の指摘も検証にかける', 'if (!f.quoteOk || f.overLimit || f.outOfScope) continue;', 'if (!f.quoteOk || f.overLimit) continue;', '[V52]'],
  ['A168', 'core', 'core', '範囲外の指摘も根本原因のまとめに入れる', 'const clusterable = st.findings.filter((f) => f.quoteOk && !f.outOfScope);', 'const clusterable = st.findings.filter((f) => f.quoteOk);', '[V52]'],
  ['A167', 'core', 'core', '範囲外の指摘を「範囲外（検証していない）」の理由で未確定にしない', "    if (f.outOfScope) { f.verdict = '未確定'; f.verdictReason = OUT_OF_SCOPE_REASON; continue; }" + NL, '', '[V52]'],
  ['A136', 'core', 'core', '範囲外の指摘も表にまとめる', "findings.filter((x) => x.verdict !== '棄却' && !x.outOfScope).entries()", "findings.filter((x) => x.verdict !== '棄却').entries()", '[V52]'],
  ['A137', 'core', 'core', '表示の等式で範囲外の節を見ない', 'if (JSON.stringify(wantOut) !== JSON.stringify(gotOut)) p.push(', 'if (false) p.push(', '[V52]'],
  ['A138', 'core', 'core', '範囲外なのに確認・棄却の指摘を等式で止めない', 'if (bad.length) p.push(`範囲外', 'if (false) p.push(`範囲外', '[V52]'],
  ['A155', 'core', 'core', '範囲外の Critical・High を人へ上げない', 'if (outHigh.length) st.escalations.push(', 'if (false) st.escalations.push(', '[V52]'],
  ['A169', 'core', 'core', 'まとめに範囲外の内訳を出さない', "${eq.outOfScope ? `（うち範囲外 ${eq.outOfScope}）` : ''}", '', '[V52]'],
  ['A171', 'core', 'core', '範囲外の指摘だけでも「検証の指示を作っていない」と出す', "st.findings.some((f) => f.quoteOk && !f.overLimit && !f.outOfScope)) st.notRun.push(", "st.findings.some((f) => f.quoteOk && !f.overLimit)) st.notRun.push(", '[V52]'],
  ['B3', 'bench', 'bench', '採点で範囲外の指摘も命中にする', "['確認', '未確定'].includes(f.verdict) && !f.outOfScope", "['確認', '未確定'].includes(f.verdict)", '[B04]'],
  ['A139', 'core', 'core', '差分のときに修正の確認へ窓だけを渡す（窓の外の前回の指摘を受け持たない）', "r.role === 'recheck' ? sets.recheck : ", '', '[V53]'],
  ['A150', 'core', 'core', '差分のときに要件の突き合わせへ窓だけを渡す', "r.role === 'requirements' ? sets.full : ", '', '[V53]'],
  ['A173', 'core', 'core', '修正の確認に前回の指摘が無いファイルまで渡す', 'chunkTargets(whole(items.filter((t) => prevFiles.has(normPath(t.rel)))), max)', 'chunkTargets(whole(items), max)', '[V53]'],
  ['A170', 'core', 'core', 'ファイル全体を渡した役の指摘も窓で範囲外にする', ' && !(tk && tk.whole)) {', ') {', '[V53]'],
  ['A172', 'core', 'core', 'ファイル全体を渡したタスクに印（whole）を付けない', ', ...(diff && set !== sets.win ? { whole: true } : {})', '', '[V53]'],
  ['A140', 'core', 'core', '網羅性の監査に渡した範囲を渡さない', 'const files = st.targets.map((t) => `${t.rel}（${t.lines} 行・${t.kind}${scopeOf(t)}）`)', 'const files = st.targets.map((t) => `${t.rel}（${t.lines} 行・${t.kind}）`)', '[V54]'],
  ['A174', 'core', 'core', '網羅性の監査の選定に範囲を渡さない', "...(st.scope && st.scope.mode === 'diff' ? [`範囲: 差分の周辺だけ（前後 ${st.scope.context} 行）`] : []), ", '', '[V54]'],
  ['A141', 'core', 'core', '未実施に範囲の外の行数を出さない', "if (!st.scope || st.scope.mode !== 'diff' || st.scope.linesInScope >= st.scope.linesTotal) return null;", 'if (true) return null;', '[V54]'],
  ['A224', 'core', 'core', 'add-checks 後に範囲の注記を現在の選定で作り直さない', '  st.notRun = st.notRun.filter((n) => !n.startsWith(SCOPE_NOT_RUN_PREFIX));' + NL, '', '[V54]'],
  ['G5', 'guide', 'core', '監査役の指示から範囲の外の扱いを消す', '対象のファイルに「渡した範囲」があるとき（差分の周辺だけを渡したとき）は、範囲の外を読んでいないこと自体は欠けではありません。', '', '[V54]'],
  ['C76', 'codex', 'codex', 'Codex の指示に対象の行の範囲を書かない', 'const scope = scoped.length ?', 'const scope = false ?', '[X31]'],
  ['C77', 'codex', 'codex', 'Codex の読んでいない範囲を、窓でなくファイル全体を基準に数える', 'f.ranges || [[1, f.lines]]', '[[1, f.lines]]', '[X31]'],
  ['C78', 'codex', 'codex', 'Codex のカナリアに範囲を付けない', 'ranges: scoped ? [[1, canLines]] : null', 'ranges: null', '[X31]'],
  ['C81', 'codex', 'codex', 'runCodex が対象の窓を範囲として渡さない', 'ranges: winOf.get(f.rel) || null', 'ranges: null', '[X31]'],
  ['A142', 'core', 'core', '決定表の差分の周辺の行数を検査しない', 'if (!Number.isInteger(dc) || dc < 0 || dc > 1000) p.push(', 'if (false) p.push(', '[V01]'],
  ['C79', 'codex', 'codex', 'アダプタで知らないオプションを検査しない', "    core.checkOpts('run', argv.slice(1), RUN_OPTS, []);" + NL, '', '[X32]'],
  ['C80', 'codex', 'codex', 'アダプタで ut-review.mjs の段のオプションも許す', "export const RUN_OPTS = { run: ['--run', '--pass', '--expect', '--model', '--codex-js'] };", "export const RUN_OPTS = { run: ['--run', '--pass', '--expect', '--model', '--codex-js', ...Object.values(core.STAGE_OPTS).flat()] };", '[X32]'],
  // 2026-10-19 の再レビューの残りで直した所（READ の条件の共有・オプションの値・直して続ける印・git の差分の読み方・改名・修正の確認の割り当て・
  // ファイル全体を読む役の注記・送った記録・裁定の分割・文書と決定表の照合・試験の数え方・Codex の READ・作業場所の実パス・確度）
  ['A175', 'core', 'core', 'Claude の役の READ に使える申告の条件をかけない', 'const usable = reads.filter((x) => { const f = files.find((y) => normPath(y.rel) === normPath(x.file)); return f && usableRead(x, f); });', 'const usable = reads;', '[V56]'],
  ['A176', 'core', 'core', 'unreadOf が逆転・0 行目の申告も読んだ範囲に数える', 'for (const x of reads.filter((y) => Number.isInteger(y.from) && Number.isInteger(y.to) && y.from >= 1 && y.from <= y.to).sort((a, b) => a.from - b.from)) {', 'for (const x of reads.filter((y) => Number.isInteger(y.from) && Number.isInteger(y.to)).sort((a, b) => a.from - b.from)) {', '[V56]'],
  ['A226', 'core', 'core', 'accept で --file の指定自体が無くても、読む段まで進む', "if (file === undefined) throw new InputError('--file <返答のファイル> が要る');", "if (false) throw new InputError('--file <返答のファイル> が要る');", '[V57]'],
  ['A227', 'core', 'core', 'mask で --words も --none も無い指定を専用の理由で止めない', "if (!has(argv, '--none') && !has(argv, '--words')) throw new InputError('--words <伏せる語のファイル> か --none のどちらかが要る');", "if (false) throw new InputError('--words <伏せる語のファイル> か --none のどちらかが要る');", '[V57]'],
  ['A177', 'core', 'core', 'Claude の役の使えなかった READ の申告を報告に出さない', 'if (r && (r.badReads || []).length) st.notRun.push(', 'if (false) st.notRun.push(', '[V56]'],
  ['A178', 'core', 'core', '返答の READ を検査せずにそのまま保存する', 'res.read = r.read;', 'res.read = reply.read;', '[V56]'],
  ['A179', 'core', 'core', '形の違う観点の要素を照合で外さない', 'vpRaw.forEach((v, i) => { if (!viewpointOk(v)) p.push(', 'vpRaw.forEach((v, i) => { if (false) p.push(', '[V56]'],
  ['A180', 'core', 'core', '段の検査で値の欠けたオプションを止めない', "if (i + 1 >= rest.length || String(rest[i + 1]).startsWith('--')) throw new InputError(`${a} に値が無い`);", "if (i + 1 >= rest.length || String(rest[i + 1]).startsWith('--')) continue;", '[V57]'],
  ['A181', 'core', 'core', '段の検査で空の値のオプションを止めない', 'if (!String(rest[i + 1]).trim()) throw', 'if (false) throw', '[V57]'],
  ['A182', 'core', 'core', '「,」だけの --files を止めない', "if (files && !files.length) throw new InputError('--files に対象が無い", "if (false) throw new InputError('--files に対象が無い", '[V57]'],
  ['A183', 'core', 'core', '--recheck の無い --waivers を通す', 'if (waiversFile !== undefined && recheckFile === undefined) throw', 'if (false) throw', '[V57]'],
  ['A184', 'core', 'core', '形の違う見送りの要素を通す', "if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id.trim() || typeof w.reason !== 'string' || !w.reason.trim()) throw", 'if (false) throw', '[V57]'],
  ['A185', 'core', 'core', '前回の指摘に無い見送りの ID を通す', 'if (!prevIds.has(w.id)) throw', 'if (false) throw', '[V57]'],
  ['A186', 'core', 'core', '修正の確認を実施しないのに見送りを通す', "if (waivers.length && !selection.rows.some((r) => r.check === 'recheck' && r.run)) throw", 'if (false) throw', '[V57]'],
  ['A187', 'core', 'core', '入力の検査の前に前回の残りを消す', '  const stale = cleanStale(base, cfg, now.getTime());' + NL + '  const id = newRunId(now);', '  const id = newRunId(now);', '[V57]', ["  const collected = collectTargets({ root, files, base: arg(argv, '--base') }", "  const stale = cleanStale(base, cfg, now.getTime());" + NL + "  const collected = collectTargets({ root, files, base: arg(argv, '--base') }"]],
  ['A188', 'core', 'core', '後の段の入力の誤りに直して続ける印を付けない', "(e instanceof InputError && !['prepare', 'cleanup'].includes(cmd) && Object.hasOwn(STAGE_OPTS, cmd))", '(false)', '[V58]'],
  ['A189', 'core', 'core', '直せる検査（merge の未回答・report の merge の前後）に印を付けない', 'export const resumable = (msg) => Object.assign(new CheckError(msg), { resume: true });', 'export const resumable = (msg) => new CheckError(msg);', '[V58]'],
  ['A190', 'core', 'core', 'prepare の入力の誤りにも直して続ける印を付ける', "!['prepare', 'cleanup'].includes(cmd)", "cmd !== 'cleanup'", '[V58]'],
  ['A191', 'core', 'core', 'git の差分で色を止めない（--no-color を付けない）', "'--no-ext-diff', '--no-color'];", "'--no-ext-diff'];", '[V59]'],
  ['A192', 'core', 'core', '行の差分で --text を付けない（.gitattributes の -diff で hunk が出ない）', "['diff', '-U0', '--text', ...DIFF_SAFE", "['diff', '-U0', ...DIFF_SAFE", '[V59]'],
  ['A193', 'core', 'core', 'hunk を読めない出力を「差分なし」にする', 'if (!hs.length && String(d).trim() && !/^(?:old|new) mode \\d+$/m.test(d)) return null;', '', '[V59]'],
  ['A194', 'core', 'core', '対象外の項目も重なりの判定に登録する（大文字小文字だけの改名で今あるファイルを落とす）', "    if (why) { if (!seenExcluded.has(lk + '\\0' + why))", "    if (why) { once.set(lk, it.abs); if (!seenExcluded.has(lk + '\\0' + why))", '[V60]'],
  ['A195', 'core', 'core', '前回の指摘を前回の行を含む塊にだけ渡す', 'const prevForChunk = (prev, ch) => (prev || []).filter((p) => ofFile(p, ch));', 'const prevForChunk = (prev, ch) => (prev || []).filter((p) => ch.some((c) => normPath(c.rel) === normPath(p.file) && p.line >= c.from && p.line <= c.to));', '[V30]'],
  ['A196', 'core', 'core', '修正の確認の注記を前回の指摘の無いファイルにも付ける', "...(rc && st.prev.some((p) => normPath(p.file) === normPath(rel)) ? ['修正の確認'] : [])", "...(rc ? ['修正の確認'] : [])", '[V54]'],
  ['A197', 'core', 'core', '要件の突き合わせの注記を、役を実施しない実行にも付ける', "const req = on('requirements') && !!st.reqItems,", 'const req = true,', '[V54]'],
  ['A228', 'core', 'core', '別の役へ統合された要件を、独立してファイル全体を読む役として注記する', "  const on = (c) => ((st.selection && st.selection.rows) || []).some((r) => r.check === c && r.run && !r.merged);", "  const on = (c) => ((st.selection && st.selection.rows) || []).some((r) => r.check === c && r.run);", '[V54]'],
  ['A235', 'core', 'core', 'URL のユーザー情報の型を外す', "  { name: 'URL のユーザー情報', keep: true, re: /((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\\/\\/[^\\/\\s:@\"'<>]*:)(?!［伏字］)([^@\\s\\/\"'<>]+)(?=@)/g },", "  { name: 'URL のユーザー情報', keep: true, re: /(?!)(x)/g },", '[V10]'],
  ['A236', 'core', 'core', 'Basic 認証の型を外す', "  { name: 'Basic 認証', keep: true, re: /((?<![A-Za-z0-9])Authorization[\"']?[ \\t]*[:=][ \\t]*[\"']?Basic[ \\t]+)(?!［伏字］)([A-Za-z0-9+/_\\-]{4,}={0,2})/gi },", "  { name: 'Basic 認証', keep: true, re: /(?!)(x)/g },", '[V10]'],
  ['A237', 'core', 'core', '判定不能が残っていても、該当なしが 1 つあれば OK にする', "  if (vs.some((v) => v.result === '判定不能') || (vs.length && vs.every((v) => v.result === '該当箇所なし'))) return { result: '判定不能', reason };", "  if (vs.length && vs.every((v) => v.result === '判定不能' || v.result === '該当箇所なし')) return { result: '判定不能', reason };", '[V05]'],
  ['A238', 'core', 'core', '該当箇所なしだけが並んでも OK にする', "  if (vs.some((v) => v.result === '判定不能') || (vs.length && vs.every((v) => v.result === '該当箇所なし'))) return { result: '判定不能', reason };", "  if (vs.some((v) => v.result === '判定不能')) return { result: '判定不能', reason };", '[V05]'],
  ['A239', 'core', 'core', '返答の指摘の内部の欄（検証・範囲外・ID など）をそのまま取り込む', "    const f = pickFinding(f0);", "    const f = f0;", '[V52]'],
  ['A198', 'core', 'core', 'sent の無い完走の結果を送っていないとする', "if (r.sent === true || r.status === 'ok') codexSent = true;", 'if (r.sent === true) codexSent = true;', '[V47]'],
  ['A199', 'core', 'core', '裁定の指示を 1 回に渡す量で分けない', 'const batches = packBatches(pool.filter((x) => head + x.size <= max), (x) => x.size, max - head);', 'const batches = [pool.filter((x) => head + x.size <= max)].filter((b) => b.length);', '[V61]'],
  ['A225', 'core', 'core', '検証結果を差し替えた後も前の検証を前提にした裁定を使う', 'if (t.verifyResultsHash !== currentVerifyHash) { staleAdjudicate.push(t.id); continue; }', 'if (false) { staleAdjudicate.push(t.id); continue; }', '[V27]'],
  ['A200', 'core', 'core', '検証の指示の大きさに前置きの分を数えない', 'const vHead = metaHeadBytes(g, g.verify);', 'const vHead = 0;', '[V61]'],
  ['A204', 'core', 'core', '文書の照合で、出所の無い時間の数字を止めない', 'if (/作業フォルダ/.test(l) && /\\d+ 時間/.test(l) && !/staleIdleHours/.test(l)) out.push(', 'if (false) out.push(', '[V65]'],
  ['A205', 'core', 'core', '試験の数え方で、省略をパスに数える', 'results.push(m && m[SKIPPED] ? { ok: true, skip: true, name, m: m.reason } :', 'results.push(m && m[SKIPPED] ? { ok: true, name, m: m.reason } :', '[V66]'],
  ['A223', 'core', 'core', '全件省略・試験 0 件でも自己テストを成功にする', 'return results.some((r) => r.ok && !r.skip) && results.every((r) => r.ok);', 'return results.every((r) => r.ok);', '[V66]'],
  ['A206', 'core', 'core', '引用が実在しない窓の外の指摘も範囲外にする', 'if (q.ok && st.scope && st.scope.mode === ', 'if (st.scope && st.scope.mode === ', '[V52]'],
  // 削除だけの塊の印（F070）と、監査役に渡したデータだけで判断させる指示（F064）
  ['A207', 'core', 'core', '削除だけの塊を見出しに出さない', '${of}${focus}${del}`;', '${of}${focus}`;', '[V67]'],
  ['A208', 'core', 'core', '目録の段で削除の位置を対象に持たせない', '      if (dl.length) deleted[rel] = dl;' + NL, '', '[V67]'],
  ['A209', 'core', 'core', '削除の位置を git の差分から読まない', '\\+(\\d+),0 @@/gm)]', '\\+(\\d+),9 @@/gm)]', '[V67]'],
  ['A210', 'guide', 'core', '手引きに削除の評価を書かない', '- 見出しの「削除: N 行目の後で M 行」は', '- 見出しの「削除（N 行目の後で M 行）」は', '[V67]'],
  ['A211', 'guide', 'core', '監査役に、渡していない中身の推測で gaps を出させる', '範囲の外への影響は、渡したデータ（ファイル名・範囲・READ・要件・選定）から根拠を示せるときだけ gaps に出します', 'ただし、差分が範囲の外（呼び出し元・定義・設定）に影響しうるなら gaps に出します', '[V67]'],
  ['A220', 'core', 'core', '前回の報告の findings の要素の形を確かめない', '    prev.findings.forEach((f, i) => {', '    [].forEach((f, i) => {', '[V57]'],
  ['A221', 'core', 'core', 'accept の照合外れに直して続ける印を付けない', '      if (!r.ok) console.log(RESUME_NOTE);', '      if (false) console.log(RESUME_NOTE);', '[V58]'],
  // 2026-10-20: Codex を使わない理由（skip-codex）。記録が無ければ部品に分かる事実だけを言う
  ['A212', 'core', 'core', '残した理由を使わない', '(st.codexSkip ? st.codexSkip.reason : ', '(false ? st.codexSkip.reason : ', '[V68]'],
  ['A213', 'core', 'core', '記録の無いときに了承が無いと推測で書く', "'mask〔送る内容の提示と了承〕をしていない。理由は記録されていない'", "'了承が無い・マスクしていない'", '[V68]'],
  ['A214', 'core', 'core', '空の理由を受け付ける', "if (!r) throw new InputError('--reason が要る（Codex", "if (false) throw new InputError('--reason が要る（Codex", '[V68]'],
  ['A215', 'core', 'core', '改行のある理由を受け付ける', '/[\\r\\n]/.test(r) || r.length > 200) throw', 'false || r.length > 200) throw', '[V68]'],
  ['A222', 'core', 'core', '長すぎる理由を受け付ける', '/[\\r\\n]/.test(r) || r.length > 200) throw', '/[\\r\\n]/.test(r) || false) throw', '[V68]'],
  ['A216', 'core', 'core', '選んでいない Codex の理由を受け付ける', "if (!st.selection.rows.some((x) => x.check === 'codex' && x.run)) throw", 'if (false) throw', '[V68]'],
  ['A217', 'core', 'core', 'mask の後の結果の無いパスに、残した理由を出さない', "if (!codexFiles.includes(ps + '.json')) st.notRun.push(`Codex（${ps}）: 未実施（${codexNotRunReason(st)}）`);", "if (!codexFiles.includes(ps + '.json')) st.notRun.push(`Codex（${ps}）: 未実施（実行していない）`);", '[V68]'],
  ['A218', 'core', 'core', '監査に渡す Codex の実績で、理由を推測で書く', "return `Codex（${ps}）: 未実施（${codexNotRunReason(st)}）`;", "return `Codex（${ps}）: 未実施（${st.masked ? '実行していない' : '了承が無い・マスクしていない'}）`;", '[V37]'],
  ['A219', 'core', 'core', 'skip-codex の段のオプションを許さない', "  'skip-codex': ['--run', '--reason'], status:", '  status:', '[V55]'],
  ["A229", "core", "core", "鍵の名前の直前に英数字が続くもの（accessToken・clientSecret・dbPassword）を拾わない", "{0,6}[A-Za-z0-9]*${KEY_NAMES}", "{0,6}${KEY_NAMES}", "[V69]"],
  ["A230", "core", "core", "C10 の形で、記号入りの引用符つきの値を拾わない", ";~%!#$^&*?<>(){}|,", ";~%", "[V69]"],
  ["A231", "core", "core", "C10 の形で、記号入りの引用符なしの値を拾わない", "@~%!#^&*?|,", "@~%", "[V69]"],
  ["A232", "core", "core", "鍵の名前の前の語を無制限にする（区切りの続く長い列で 2 乗の時間）", "(?:[A-Za-z0-9]+[_.-]){0,6}", "(?:[A-Za-z0-9]+[_.-])*", "[V69]"],
  ["A233", "core", "core", "git に、設定のフィルタを空にする指定を付けない", "...filterOverrides(root), ...args", "...args", "[V70]"],
  ["A234", "core", "core", "task ID に Object の名前（constructor など）を受ける", "Object.hasOwn(st.tasks, taskId) ? st.tasks[taskId] : undefined", "st.tasks[taskId]", "[V71]"],
  ['A202', 'docs', 'core', '設計の記録に窓の幅を数字だけで書く', '  - 窓は差分のある行の前後 N 行（決定表の `limits.diffContextLines`、既定 30）の決まった幅で', '  - 窓は差分のある行の前後 30 行の固定で', '[V65]'],
  ['A203', 'cmd', 'core', '手順書に前回の残りを消す時間を数字だけで書く', '決定表の `limits.staleIdleHours`（既定 72）時間を超えた作業フォルダは', '72 時間を超えた作業フォルダは', '[V65]'],
  ['C82', 'codex', 'codex', 'READ の行で範囲を 1 つしか読まない（並べた範囲をファイル名の一部と読む）', 'const r = /^READ (.+?) (\\d+-\\d+(?:\\s*,\\s*\\d+-\\d+)*)$/.exec(l);', 'const r = /^READ (.+?) (\\d+)-(\\d+)$/.exec(l);', '[X34]', ['for (const m of r[2].matchAll(/(\\d+)-(\\d+)/g)) reads.push({ file: r[1], from: Number(m[1]), to: Number(m[2]) });', 'reads.push({ file: r[1], from: Number(r[2]), to: Number(r[3]) });']],
  ['C83', 'codex', 'codex', '手引きに codex:scope が無いのに範囲を黙って落とす', "if (scoped.length && !(g['codex:scope'] || '').includes('{範囲}')) throw", 'if (false) throw', '[X31]'],
  ['C84', 'codex', 'codex', '送る直前に「送った」の記録を書かない', "    save({ ...base, status: '未実施', reason: '送った後に結果が書かれていない", "    ({ ...base, status: '未実施', reason: '送った後に結果が書かれていない", '[X35]'],
  ['C85', 'codex', 'codex', '起動・実行の失敗の理由を残さない（終了コード null にする）', "    else if (r.error) { status = '未実施'; reason =", "    else if (false) { status = '未実施'; reason =", '[X35]'],
  ['C86', 'codex', 'codex', '起動に失敗しても送ったとする', '    if (r.error && !r.pid) sent = false;' + NL, '', '[X35]'],
  ['C87', 'codex', 'codex', 'CLI の場所を絶対パスにしない（相対パスが作業場所から解決される）', '  codexJs = path.resolve(codexJs);' + NL, '', '[X35]'],
  ['C88', 'codex', 'codex', '作業場所を実パスにそろえない', '  try { work = fs.realpathSync.native(made); } catch', '  try { } catch', '[X36]'],
  ['C89', 'codex', 'codex', 'Windows の作業場所で / の 1 段（オプションと区別できない）も確かめた外のパスにする', '(resolvable && !(P === path.win32 && /^\\/[^\\\\/.]+$/.test(s)))', 'resolvable', '[X37]'],
  ['G6', 'guide', 'codex', 'Codex の READ の書式を「ファイルごとに 1 行」に戻す', '続けて、実際に読んだ範囲を、範囲ごとに 1 行ずつ書きます', '続けて、実際に読んだ範囲をファイルごとに 1 行ずつ書きます', '[X34]'],
  ['G7', 'guide', 'core', '手引きの codex:scope の節を消す', '=== 節: codex:scope ===', '=== 節: codex-scope-removed ===', '[V17]'],
  ['B4', 'bench', 'bench', '採点で引用の語も鍵語に数える', "d.keywords.some((k) => `${f.scenario || ''} ${f.fix || ''}`", "d.keywords.some((k) => `${f.quote || ''} ${f.scenario || ''} ${f.fix || ''}`", '[B06]'],
];
// 決定表の規則を 1 つずつ消す（その規則だけが選ぶ入力が [V18] にある）。行の書き方（字下げ・1 行に 1 規則・ID の形）に頼らず、JSON として読んで作る。
// 差し込み位置は使わず（null）、規則を除いた JSON を作り直す
const RULE_DEFS = JSON.parse(SRC.checks).rules;
// 規則 ID は、一時フォルダの下のフォルダ名になる。空・文字列でないもの・区切りや .. を含むもの（一時フォルダの外へ書き出す）は止める
const badRuleIds = RULE_DEFS.map((r) => r && r.id).filter((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..'));
if (badRuleIds.length) { console.log(`決定表に空・文字列でない・使えない文字を含む規則 ID が ${badRuleIds.length} 件ある。掃引を始めない`); process.exit(1); }
const RULE_IDS = RULE_DEFS.map((r) => r.id);
for (const rid of RULE_IDS) {
  mutations.push([rid, 'checks', 'core', `決定表から規則 ${rid} を消す`, null, null, '[V18]', (s) => { const j = JSON.parse(s), n = j.rules.length; j.rules = j.rules.filter((r) => r.id !== rid); return j.rules.length === n - 1 ? JSON.stringify(j, null, 2) + NL : s; }]);
}
// 規則ごとに、規則を消す変異（差し込み位置が null の 'checks' の変異）がちょうど 1 件あることを照らす（規則が 0 件・ID の重複・欠けなら、
// 決定表を検証しないまま合格になるので止める）。決定表の値を変える手書きの変異（差し込み位置のある 'checks' の変異）は数えない
{
  const ruleMuts = mutations.filter((m) => m[1] === 'checks' && m[4] === null).map((m) => m[0]);
  const bad = RULE_IDS.filter((r) => ruleMuts.filter((x) => x === r).length !== 1);
  if (!RULE_IDS.length || bad.length || ruleMuts.length !== RULE_IDS.length || new Set(RULE_IDS).size !== RULE_IDS.length) { console.log(`決定表の規則 ${RULE_IDS.length} 件に対し、規則を消す変異が ${ruleMuts.length} 件（合わない規則: ${bad.join(',') || 'なし'}、または規則 ID の重複）。掃引を始めない`); process.exit(1); }
}

{ const ids = mutations.map((m) => m[0]); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }
// 変異の本文を作る。差し込み位置・後に当てるものの一致がちょうど 1 件でない、後に当てる関数が何も変えない、全体で何も変わらない、は INVALID
function mutantBody([, target, , , find, to, , post]) {
  const src = SRC[target];
  if (typeof src !== 'string') return { invalid: `壊す対象が無い: ${String(target)}` };
  let body = src;
  if (find !== null) {
    const hits = src.split(find).length - 1;
    if (hits !== 1) return { invalid: `差し込み位置の一致 ${hits} 件` };
    body = src.replace(find, () => to);
  }
  if (Array.isArray(post)) {
    const hits = body.split(post[0]).length - 1;
    if (hits !== 1) return { invalid: `後に当てる差し込み位置の一致 ${hits} 件` };
    body = body.replace(post[0], () => post[1]);
  } else if (post) {
    const b2 = post(body);
    if (b2 === body) return { invalid: '後に当てる関数が何も変えない' };
    body = b2;
  }
  if (body === src) return { invalid: '何も変わらない' };
  return { body };
}
if (process.env.UT_SWEEP_CHECK) {
  const bad = mutations.map((m) => [m[0], mutantBody(m)]).filter(([, r]) => r.invalid);
  for (const [id, r] of bad) console.log(`  ${id.padEnd(10)}INVALID ${r.invalid}`);
  console.log(`差し込み位置の確かめ: ${mutations.length} 件中 INVALID ${bad.length} 件（selftest は走らせていない）`);
  process.exit(bad.length ? 1 : 0);
}
const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',').map((s) => s.trim()).filter(Boolean)) : null;
if (only) {
  console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
  const unknown = [...only].filter((id) => !mutations.some((m) => m[0] === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
  if (!only.size) { console.log('UT_SWEEP_ONLY に ID が無い'); process.exit(1); }
}
tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-review-sweep-'));
// Codex の selftest が UT_REVIEW_CODEX_TMP に左右されないことも確かめる（設定したまま走らせ、試験の側で退避しているかを [X30] で見る）
const CODEX_TMP_ENV = path.join(tmp, 'codex-tmp-env');
fs.mkdirSync(CODEX_TMP_ENV, { recursive: true });

function layout(dir, target, body) {
  // 写しの構成: <dir>/commands/templates/<4 本>、<dir>/tools/ut-review-bench.{mjs,json}、<dir>/commands/ut-review.md・<dir>/docs/ut-review.md
  const t = path.join(dir, 'commands', 'templates');
  fs.mkdirSync(t, { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  for (const [k, f] of Object.entries(FILES)) fs.writeFileSync(path.join(t, f), k === target ? body : SRC[k]);
  for (const [k, f] of Object.entries(DOCS)) fs.writeFileSync(path.join(dir, f), k === target ? body : SRC[k]);
  fs.writeFileSync(path.join(dir, 'tools', 'ut-review-bench.mjs'), target === 'bench' ? body : SRC.bench);
  fs.copyFileSync(path.join(ROOT, 'tools', 'ut-review-bench.json'), path.join(dir, 'tools', 'ut-review-bench.json'));
  return { core: path.join(t, FILES.core), codex: path.join(t, FILES.codex), bench: path.join(dir, 'tools', 'ut-review-bench.mjs') };
}
function runSelftest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, '--selftest'], { cwd: path.dirname(file), detached: process.platform !== 'win32', env: { ...process.env, UT_REVIEW_CODEX_TMP: CODEX_TMP_ENV } });
    children.add(child);
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => killTree(child), 300000);
    child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code, out }); });
  });
}
async function runMutant(m) {
  const [id, target, runner, desc, , , expect] = m;
  const { body, invalid } = mutantBody(m);
  if (invalid) return { id, desc, verdict: 'INVALID', detail: invalid };
  const files = layout(path.join(tmp, id), target, body);
  const { code, out } = await runSelftest(files[runner]);
  const ng = out.split(NL).filter((l) => l.trimStart().startsWith('NG'));
  const hit = ng.some((l) => l.trimStart().startsWith('NG  ' + expect + ' '));
  const verdict = hit ? 'CAUGHT' : ng.length ? 'OTHER' : code !== 0 ? 'CRASHED' : 'MISSED';
  return { id, desc, verdict, expect, detail: `NG ${ng.length} 件`, ngNames: ng.map((l) => l.trim().slice(4).split(' | ')[0]), tail: verdict === 'CRASHED' ? out.trim().split(NL).slice(-2).join(' / ') : '' };
}

const jobs = Math.max(1, Math.min(Number(process.env.UT_SWEEP_JOBS) || 6, os.cpus().length));
const rows = [];
try {
  // 基準実行: 変異を入れない写しで、3 つの selftest がすべて通ること。変異と同じ並列の数で同時に走らせる
  // （時間で判定する試験が、変異のときと同じ負荷の下でも通ることを先に確かめる。負荷で落ちる試験を変異の検出と数えない）
  const files = layout(path.join(tmp, 'base'), null, null);
  const kinds = ['core', 'codex', 'bench'];
  const base = await Promise.all(Array.from({ length: Math.max(kinds.length, jobs) }, (_, i) => kinds[i % kinds.length]).map(async (k) => ({ k, ...(await runSelftest(files[k])) })));
  for (const { k, code, out } of base) {
    if (code === 0) continue;
    const ng = out.split(NL).filter((l) => /NG|selftest:/.test(l));
    // NG の行が無い（例外・構文の誤り・時間切れで止まった）ときは、出力の最後の行と終了コードを出す（null は時間切れで止めた）
    const lines = out.trim().split(NL).filter((l) => l.trim());
    const err = lines.find((l) => /\b\w*Error\b/.test(l));
    console.log(`基準実行で失敗（${k}・並列 ${base.length} 本の下で。終了コード ${code === null ? 'null（時間切れで止めた）' : code}）: ` + (ng.length ? ng.join(' / ') : [...(err ? [err] : []), ...lines.slice(-3)].join(' / ') || '（出力なし）'));
    done(1);
  }
  for (const k of kinds) console.log(`基準実行（${k}）: ` + ((base.find((x) => x.k === k).out.split(NL).find((l) => l.startsWith('selftest:'))) || '') + `（並列 ${base.length} 本）`);
  const queue = mutations.filter((m) => !only || only.has(m[0]));
  await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) rows.push(await runMutant(queue.shift())); }));
} catch (e) {
  console.log('掃引が途中で止まった: ' + ((e && e.stack) || e));
  done(1);
}
const order = mutations.map((m) => m[0]);
rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
console.log('== ut-review ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log(`  ${r.id.padEnd(10)}${r.verdict.padEnd(8)}${r.desc}  -> ${r.detail}`);
  if (r.verdict !== 'CAUGHT') { for (const n of (r.ngNames || [])) console.log(`          落ちた: ${n}（期待: ${r.expect}）`); if (r.tail) console.log('          ' + r.tail); }
}
const caught = rows.filter((r) => r.verdict === 'CAUGHT').length;
console.log('対象外: LLM が行う判断（ペルソナ・検証・裁定・網羅性の監査）の質。題材集の検出の再現率（tools/ut-review-bench.mjs score）で、実際の実行ごとに測る');
console.log('対象外: Codex の実物の起動（偽の codex で確かめる）。実物はクレジットを消費し、出力が決定的でないため');
// 一時フォルダは結果を出した後に消す（消せなくても結果は失わない）
removeTmp();
// 最後の行に結果を書く。部分実行は、全件 CAUGHT でも 0 にしない（終了コードだけを見る呼び出し元が全件の合格と読み違えないように）
console.log(`${NL}検出 ${caught} / ${rows.length}${only ? `（部分実行: 全 ${mutations.length} 件のうち ${rows.length} 件だけ。全件の判定ではない）` : ''}`);
done(caught !== rows.length ? 1 : only ? 2 : 0);
