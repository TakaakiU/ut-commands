// ut-clean.mjs の --selftest に欠陥を1つずつ注入し、実際に落ちるかを掃引する負テスト。
// 「selftest が全件パス」を検証済みの根拠にしないため、防御ごとに壊して、その防御を見るテスト（[Cxx]）で落ちることを確かめる。
//   node tools/ut-clean-sweep.mjs            （repo ルートで実行する）
// exit: 0 全件 CAUGHT / 1 それ以外（基準実行の失敗・未検出・別理由での検出・異常終了・設計不正）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const NL = String.fromCharCode(10);
const R = String.raw;
const SRC = fs.readFileSync('tools/ut-clean.mjs', 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'utcl-sweep-'));

// expect: その防御を見ているテストの識別子。これで落ちた場合だけ CAUGHT と数える。also: 同じ結果になる重複防御を同時に壊す
const mutations = [
  // ---- パスの比較
  { id: 'K01', desc: 'パスの鍵で大文字小文字を揃えない', expect: '[C07]', find: R`.replace(/[\\/]+$/, '').toLowerCase();`, to: R`.replace(/[\\/]+$/, '');` },
  { id: 'K02', desc: 'パスの鍵で末尾の区切りを揃えない', expect: '[C07]', find: R`.replace(/^([A-Za-z]:)\.$/, '$1').replace(/[\\/]+$/, '')`, to: R`.replace(/^([A-Za-z]:)\.$/, '$1')` },
  { id: 'K03', desc: '境界を見ずに前方一致で比べる（C:\\Temp が C:\\TempX に当たる）', expect: '[C07]', find: "c.startsWith(p + '\\\\')", to: 'c.startsWith(p)' },
  { id: 'K04', desc: 'ドライブ文字だけの形（C:）を揃えない', expect: '[C09]', find: R`.replace(/^([A-Za-z]:)\.$/, '$1')`, to: '' },
  // ---- 候補にしてはいけない場所
  { id: 'Z01', desc: 'UNC を除かない', expect: '[C09]', find: "if (/^[\\\\/]{2}/.test(p)) return 'ネットワークパス（UNC）';", to: '' },
  { id: 'Z02', desc: '別ドライブを除かない', expect: '[C09]', find: "if (m[1].toUpperCase() + ':' !== String(cfg.drive).toUpperCase()) return '対象ドライブ（' + cfg.drive + '）以外';", to: '' },
  { id: 'Z03', desc: '相対表記を除かない', expect: '[C09]', find: "if (/(^|[\\\\/])\\.\\.?([\\\\/]|$)/.test(p)) return '相対表記を含む';", to: '' },
  { id: 'Z04', desc: 'ドライブ直下を除かない', expect: '[C09]', find: "if (key(p) === key(cfg.driveRoot)) return 'ドライブ直下';", to: '' },
  { id: 'Z05', desc: '同期フォルダの配下を除かない', expect: '[C10]', find: "if (isWithin(p, z)) return '同期フォルダ（OneDrive 等）';", to: '' },
  { id: 'Z06', desc: '同期フォルダを含む祖先を除かない', expect: '[C10]', find: "if (isWithin(z, p)) return '同期フォルダを含む';", to: '' },
  { id: 'Z07', desc: '.git を除かない', expect: '[C09]', find: "if (key(p).split('\\\\').includes('.git')) return '.git';", to: '' },
  { id: 'Z08', desc: '除外対象の配下を除かない', expect: '[C06]', find: "if (isWithin(p, z.p) && !(z.except || []).some((e) => isWithin(p, e))) return '除外対象';", to: '' },
  { id: 'Z09', desc: '除外対象の例外（except）を無視して全部除く', expect: '[C06]', find: 'isWithin(p, z.p) && !(z.except || []).some((e) => isWithin(p, e))', to: 'isWithin(p, z.p)' },
  { id: 'Z10', desc: '除外対象を含む祖先を除かない', expect: '[C08]', find: "if (isWithin(z.p, p)) return '除外対象を含む';", to: '' },
  // ---- 測定
  { id: 'M01', desc: '中のリンクをたどらずに数える処理をやめる（リンクが実体のように数えられる）', expect: '[C12]', find: 'if (s.isSymbolicLink()) { out.links++; continue; }', to: '' },
  { id: 'M02', desc: 'ハードリンクを数えない', expect: '[C13]', find: 'if (s.nlink > 1) out.hardlinks++;', to: '' },
  { id: 'M03', desc: '読めない一覧を数えない（0 として扱う）', expect: '[C14]', find: 'try { names = readdir(d); } catch (e) { out.errors++; if', to: 'try { names = readdir(d); } catch (e) { if' },
  { id: 'M04', desc: '要素数の上限を見ない', expect: '[C15]', find: 'if (out.count >= max) { out.truncated = true; return out; }', to: '' },
  { id: 'M05', desc: '測定不能を確認が必要にしない', expect: '[C14]', find: 'if (m.errors || m.truncated) { safety = S.CONFIRM;', to: 'if (false) { safety = S.CONFIRM;' },
  { id: 'M06', desc: 'リンク・ハードリンクを含む候補を確認が必要にしない', expect: '[C12]', find: 'else if (m.links || m.hardlinks) { safety = S.CONFIRM;', to: 'else if (false) { safety = S.CONFIRM;' },
  // ---- 候補の列挙
  { id: 'C01', desc: '候補そのものがリンクでも除かない（解決後の食い違いの検査も外す）', expect: '[C11]',
    find: "if (st.isSymbolicLink()) { excluded.push({ path: abs, reason: 'リンク（たどらない）' }); return; }", to: '',
    also: ["if (key(real) !== key(abs)) { excluded.push({ path: abs, reason: 'リンクを経由するパス（解決後と一致しない）' }); return; }", ''] },
  { id: 'C02', desc: '同じ場所を指す一時フォルダを重複して列挙する', expect: '[C03]', find: 'if (seen.has(key(real))) continue;', to: '' },
  { id: 'C03', desc: '入れ子の候補を外側にまとめない', expect: '[C16]', find: 'if (kept.some((k) => isWithin(it.path, k.path))) { nested++; continue; }', to: '' },
  { id: 'C04', desc: '下限で絞らない', expect: '[C16]', find: 'if (it.size !== null && it.size < minBytes) { filtered++; return false; }', to: '' },
  { id: 'C05', desc: '容量順に並べない', expect: '[C17]', find: '(b.size ?? 0) - (a.size ?? 0) ||', to: '' },
  { id: 'C06', desc: '除外名のプロジェクトも走査する', expect: '[C05]', find: "|| skip.has(d.name.toLowerCase())) continue;", to: ') continue;' },
  { id: 'C07', desc: 'マーカーの無いフォルダも走査する', expect: '[C05]', find: 'if (marked) walk(proj, 0);', to: 'walk(proj, 0);' },
  { id: 'C08', desc: '.git の下も走査する', expect: '[C05]', find: "if (lower === '.git') continue;", to: '' },
  // ---- 計画ID・保存・読み込み
  { id: 'P01', desc: '計画ID に容量を含めない', expect: '[C18]', find: 'i.safety, i.kind, i.size, i.count,', to: 'i.safety, i.kind, i.count,' },
  { id: 'P02', desc: '計画ID に安全度を含めない', expect: '[C18]', find: '[i.key, i.safety, i.kind,', to: '[i.key, i.kind,' },
  { id: 'P03', desc: '計画ID に下限を含めない', expect: '[C18]', find: "{ v: 1, params: { minSize: Number(params.minSizeGB || 0) }, items: rows }", to: '{ v: 1, items: rows }' },
  { id: 'P04', desc: '計画を保存できなくても計画ID を出す', expect: '[C19]', find: "} catch (e) { throw new InputError('計画を保存できない（' + ((e && e.code) || 'ERR') + '）。削除へ進めない'); }", to: '} catch { /* 握り潰す */ }' },
  { id: 'P05', desc: '計画の内容と計画ID の一致を見ない', expect: '[C20]', find: 'if (planId(plan.items, plan.params) !== expect || plan.id !== expect) throw new InputError(', to: 'if (false) throw new InputError(' },
  { id: 'P06', desc: '古い計画を受け付ける', expect: '[C20]', find: 'if (age > PLAN_MAX_AGE_MS) throw', to: 'if (false) throw' },
  { id: 'P07', desc: '未来の計画を受け付ける', expect: '[C20]', find: 'if (age < -PLAN_FUTURE_SKEW_MS) throw', to: 'if (false) throw' },
  { id: 'P08', desc: '承認番号の範囲の検査をしない', expect: '[C21]', find: "if (!plan.items.some((i) => i.id === id)) throw", to: 'if (false) throw' },
  { id: 'P09', desc: 'high-mid に確認が必要も入れる', expect: '[C21]', find: "pick: (i) => i.safety === S.HIGH || i.safety === S.MID }", to: 'pick: () => true }' },
  // ---- 削除の直前の確認
  { id: 'D01', desc: '削除の直前に除外対象の検査をしない（改ざんされた計画を通す）', expect: '[C29]',
    find: "const why = classifyPath(item.path, cfg);\n  if (why) return { ok: false, status: '拒否', reason: why };", to: '',
    also: ["const why2 = classifyPath(real, cfg);\n  if (why2) return { ok: false, status: '拒否', reason: why2 };", ''] },
  { id: 'D02', desc: '承認時に測定不能だったものを拒否しない', expect: '[C30]', find: 'if (item.size === null || item.count === null) return', to: 'if (false) return' },
  { id: 'D03', desc: 'リンクへの置き換えを見ない（解決後の食い違いの検査は残す）', expect: '[C27]', find: "if (st.isSymbolicLink()) return { ok: false, status: '拒否', reason: 'リンクに置き換わっている' };", to: '' },
  { id: 'D04', desc: '解決後のパスの食い違いを見ない', expect: '[C28]', find: "if (key(real) !== item.key) return { ok: false, status: '拒否', reason: '解決後のパスが承認時と違う' };", to: '' },
  { id: 'D05', desc: '測り直せなくても進める', expect: '[C41]', find: "if (m.errors || m.truncated) return { ok: false, status: '再承認'", to: "if (false) return { ok: false, status: '再承認'" },
  { id: 'D06', desc: '中に増えたリンクを見ない', expect: '[C40]', find: "if (m.links || m.hardlinks) return { ok: false, status: '再承認'", to: "if (false) return { ok: false, status: '再承認'" },
  { id: 'D07', desc: '容量の変化を見ない', expect: '[C25]', find: 'if (Math.abs(m.size - item.size) > sizeTol)', to: 'if (false)' },
  { id: 'D08', desc: '件数の変化を見ない', expect: '[C26]', find: 'if (Math.abs(m.count - item.count) > countTol)', to: 'if (false)' },
  { id: 'D09', desc: '不在を別の状態にする', expect: '[C31]', find: "if (e && e.code === 'ENOENT') return { ok: false, status: '不在'", to: "if (e && e.code === 'ENOENTX') return { ok: false, status: '不在'" },
  // ---- 結果の判定
  { id: 'R01', desc: '--dry-run でも消す', expect: '[C22]', find: 'if (dryRun) { results.push', to: 'if (false) { results.push' },
  { id: 'R02', desc: '一部でも消えたら成功にする（失敗と部分成功を分けない）', expect: '[C33]', find: 'const progressed = removed > 0 || (remain.count != null && remain.count < rc.m.count);', to: 'const progressed = true;' },
  { id: 'R03', desc: '残りがあっても「失敗」にする（部分成功を作らない）', expect: '[C32]', find: 'const progressed = removed > 0 || (remain.count != null && remain.count < rc.m.count);', to: 'const progressed = false;' },
  { id: 'R04', desc: '0 件でも成功にする', expect: '[C34]', find: 'const allOk = selected.length > 0 &&', to: 'const allOk =' },
  { id: 'R05', desc: '成功以外が混ざっていても成功にする', expect: '[C32]', find: ": r.status === '成功'));", to: ": r.status !== ''));" },
  { id: 'R06', desc: '申告量と実測の食い違いを出さない', expect: '[C35]', find: 'freedDiffers: !dryRun && Math.abs(measuredFreed - reported) > diffTol,', to: 'freedDiffers: false,' },
  // ---- 表示・引数
  { id: 'V01', desc: '表示で実ユーザー名を戻さない', expect: '[C36]', find: 'cfg.profile && isWithin(p, cfg.profile) ?', to: 'false ?' },
  { id: 'V02', desc: '知らないオプションを受け付ける', expect: '[C37]', find: "} else throw new InputError('知らないオプション: ' + a);", to: '}' },
  { id: 'V03', desc: '同じオプションの 2 回目を受け付ける', expect: '[C37]', find: "if (a !== '--extra' && seen.has(a)) throw", to: 'if (false) throw' },
  { id: 'V04', desc: '値の無いオプションを受け付ける', expect: '[C37]', find: "if (v === undefined || v === '' || v.startsWith('--')) throw", to: 'if (false) throw' },
  { id: 'V05', desc: 'apply に --expect・--scope が無くても進む', expect: '[C37]', find: "if (!o.expect || !o.scope) throw", to: 'if (false) throw' },
  { id: 'V06', desc: 'scan に apply のオプションを受け付ける', expect: '[C37]', find: 'if (o.expect || o.scope || o.dryRun) throw', to: 'if (false) throw' },
];

{ const ids = mutations.map((m) => m.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }

function runSelftest(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, '--selftest'], { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const names = (out.match(/^NG {2}.*$/gm) || []).map((x) => x.replace(/^NG {2}/, '').split(' — ')[0]);
      const total = Number((/selftest: (\d+) 件中/.exec(out) || [])[1] || 0);
      resolve({ out, code, names, total });
    });
  });
}

async function runMutant(m) {
  const hits = SRC.split(m.find).length - 1;
  if (hits !== 1) return { ...m, verdict: 'INVALID', detail: 'アンカー一致 ' + hits + ' 件' };
  const f = path.join(tmp, m.id + '.mjs');
  let src = SRC.replace(m.find, () => m.to);
  if (m.also) {
    if (src.split(m.also[0]).length - 1 !== 1) return { ...m, verdict: 'INVALID', detail: '追加アンカー不一致' };
    src = src.replace(m.also[0], () => m.also[1]);
  }
  fs.writeFileSync(f, src);
  const r = await runSelftest(f);
  if (r.names.length === 0 && r.code !== 0) return { ...m, verdict: 'CRASHED', detail: '異常終了(exit=' + r.code + ') ' + r.out.split(NL).filter(Boolean).slice(-2).join(' / ') };
  const hit = r.names.some((n) => n.includes(m.expect));
  const verdict = hit ? 'CAUGHT' : r.names.length ? 'OTHER' : 'MISSED';
  return { ...m, verdict, detail: 'NG ' + r.names.length + ' 件', ngNames: r.names };
}

// 基準（無変更）が全件パスすること
const base = await runSelftest('tools/ut-clean.mjs');
if (base.code !== 0 || base.names.length) { console.log('基準実行が通らない: ' + base.names.join(' / ')); process.exit(1); }
console.log('基準: selftest ' + base.total + ' 件パス');

const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',')) : null;
const todo = mutations.filter((m) => !only || only.has(m.id));
const rows = [];
const CONC = 4;
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < todo.length) { const m = todo[next++]; const r = await runMutant(m); rows.push(r); console.log(r.verdict.padEnd(8) + r.id + ' ' + r.desc + (r.verdict === 'CAUGHT' ? '' : ' — ' + r.detail)); }
}));
const by = (v) => rows.filter((r) => r.verdict === v);
console.log(NL + '検出 ' + by('CAUGHT').length + ' / ' + rows.length + '   未検出 ' + by('MISSED').length + '   別理由で検出 ' + by('OTHER').length + '   異常終了 ' + by('CRASHED').length + '   アンカー不一致 ' + by('INVALID').length);
for (const v of ['MISSED', 'OTHER', 'CRASHED', 'INVALID']) {
  for (const r of by(v)) console.log(v + ': ' + r.id + ' ' + r.desc + (v === 'OTHER' ? '（期待: ' + r.expect + '。落ちた: ' + (r.ngNames || []).join(' / ') + '）' : ' ' + r.detail));
}
console.log(NL + '掃引の対象外（同じ結果になる重複防御で、片方だけでは検出できないもの）:');
console.log('  - 候補の形だけの事前検査（why0）と、実体を解決した後の検査（why1）は、どちらかを外しても同じ候補が除かれる');
console.log('  - 削除の直前の、承認番号の重複の検査と計画ID の一致の検査（片方を外しても、もう片方が止める）');
console.log('  - 起動中のプロセスが掴むファイルの削除失敗（selftest では注入した失敗で代用。実機の排他は再現できない）');
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(todo.length === rows.length && by('CAUGHT').length === rows.length ? 0 : 1);
