// ut-archive.mjs と ut-archive-win.ps1 に欠陥を1つずつ注入し、ut-archive.mjs --selftest が実際に落ちるかを掃引する負テスト。
// 「selftest が全件パス」を検証済みの根拠にしないため、防御ごとに壊して、その防御を見るテスト（[Axx]）で落ちることを確かめる。
//   node tools/ut-archive-sweep.mjs            （repo ルートで実行する）
//   UT_SWEEP_ONLY=X01,Y01 node tools/ut-archive-sweep.mjs   一部だけ（全件の判定ではない）
// exit: 0 全件 CAUGHT / 1 それ以外（基準実行の失敗・未検出・別理由での検出・異常終了・設計不正）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const NL = String.fromCharCode(10);
const R = String.raw;
const SRC = { mjs: fs.readFileSync('tools/ut-archive.mjs', 'utf8'), ps1: fs.readFileSync('tools/ut-archive-win.ps1', 'utf8') };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uta-sweep-'));

// file: 壊すファイル（既定 mjs）。expect: その防御を見ているテストの識別子（[Axx]）。これで落ちた場合だけ CAUGHT と数える
const mutations = [
  // ---- OneDrive の状態
  { id: 'X01', desc: 'クラウドのみを「一部だけ取得」と取り違える（PARTIAL の旗だけで判定）', expect: '[A01]', find: "return e.alloc === 0 ? 'cloud-only' : 'partial';", to: "return 'partial';" },
  { id: 'X02', desc: '割当が読めないのにクラウドのみと決める', expect: '[A01]', find: "if (typeof e.alloc !== 'number') return 'unknown';", to: '' },
  // ---- 分類
  { id: 'X03', desc: 'リンクを除外しない', expect: '[A02]', find: "if (e.kind === 'link') { ex(REASON.link); continue; }", to: '' },
  { id: 'X04', desc: '属性・ファイルIDを読めなくても判定を続ける', expect: '[A02]', find: 'if (e.detailError !== undefined) { unk(UNKNOWN.detail); continue; }', to: '' },
  { id: 'X05', desc: 'ADS の有無を判定できなくても続ける', expect: '[A02]', find: 'if (e.streamsError !== undefined) { unk(UNKNOWN.streams); continue; }', to: '' },
  { id: 'X06', desc: 'ADS のあるファイルを対象にする（ADS が黙って落ちる）', expect: '[A02]', find: 'if (e.streams > 0) { ex(REASON.ads); continue; }', to: '' },
  { id: 'X07', desc: 'EFS のファイルを対象にする', expect: '[A02]', find: 'if (e.attrs & A.ENCRYPTED) { ex(REASON.efs); continue; }', to: '' },
  { id: 'X08', desc: 'ハードリンクを対象にする', expect: '[A02]', find: 'if (e.links > 1) { ex(REASON.hardlink); continue; }', to: '' },
  { id: 'X09', desc: '同期ルートの下のプレースホルダーでないファイルを対象にする（同期待ちを見逃す）', expect: '[A02]', find: "if (inSyncRoot && st === 'not-placeholder') {", to: 'if (false) {' },
  { id: 'X10', desc: '一部だけ取得されたファイルを対象にする', expect: '[A02]', find: "if (st === 'partial') { ex(REASON.partial); continue; }", to: '' },
  { id: 'X11', desc: '圧縮済み形式を対象にする', expect: '[A02]', find: 'if (PACKED_EXT.has(ext)) { ex(REASON.packed); continue; }', to: '' },
  { id: 'X12', desc: '番号の拡張子を対象にする', expect: '[A02]', find: 'if (NUMBERED_EXT.test(name)) { ex(REASON.numbered); continue; }', to: '' },
  { id: 'X13', desc: '名前の問題を見ない', expect: '[A04]', find: R`if (e.rel.split('\\').some(badSegment)) { ex(REASON.badname); continue; }`, to: '' },
  { id: 'X14', desc: '名前の問題をファイル名だけで見る（途中のフォルダを見逃す）', expect: '[A04]', find: R`if (e.rel.split('\\').some(badSegment))`, to: 'if (badSegment(name))' },
  { id: 'X15', desc: 'OneDrive で使えない名前を見ない', expect: '[A04]', find: 'if (destInSyncRoot && segs.some(oneDriveBadSegment)) { ex(REASON.onedrivename); continue; }', to: '' },
  { id: 'X16', desc: '保存先が OneDrive でなくても OneDrive の名前の制限を当てる', expect: '[A04]', find: 'if (destInSyncRoot && segs.some(oneDriveBadSegment))', to: 'if (segs.some(oneDriveBadSegment))' },
  { id: 'X17', desc: '長すぎる宛先を見ない', expect: '[A04]', find: "if (path.join(destRoot, e.rel + '.7z').length > MAX_DEST_PATH) { ex(REASON.longpath); continue; }", to: '' },
  { id: 'X18', desc: '最終更新が新しいものを対象にする', expect: '[A02]', find: 'if (olderThanDays > 0 && now - base.mtimeMs < olderThanDays * 86400000) { ex(REASON.recent); continue; }', to: '' },
  { id: 'X19', desc: '走査エラーを黙って飛ばす', expect: '[A02]', find: "if (e.type === 'error') { out.push({ rel: e.rel, cls: 'unknown', reason: UNKNOWN.scan, code: e.error }); continue; }", to: "if (e.type === 'error') continue;" },
  // ---- 衝突
  { id: 'X20', desc: '宛先を Windows の比較規則で正規化しない', expect: '[A05]', find: R`const destKey = (rel) => normKey(rel).split('\\').map((s) => s.replace(/[. ]+$/, '')).join('\\');`, to: 'const destKey = (rel) => String(rel);' },
  { id: 'X21', desc: 'Unicode を NFC に正規化しない', expect: '[A05]', find: "String(p).normalize('NFC')", to: 'String(p)' },
  { id: 'X22', desc: '計画内で重なる宛先を見ない', expect: '[A05]', find: 'if (outFiles.has(k)) problems.push(', to: 'if (false) problems.push(' },
  { id: 'X23', desc: '既存のファイルとの衝突を見ない', expect: '[A05]', find: "if (exFiles.has(k)) problems.push({ kind: '宛先に同じ名前のファイル", to: "if (false) problems.push({ kind: '宛先に同じ名前のファイル" },
  { id: 'X24', desc: '既存のフォルダとの衝突を見ない', expect: '[A05]', find: 'if (exDirs.has(k)) problems.push(', to: 'if (false) problems.push(' },
  { id: 'X25', desc: '計画内のファイルとフォルダの衝突を見ない', expect: '[A05]', find: 'if (needDirs.has(k)) problems.push(', to: 'if (false) problems.push(' },
  { id: 'X26', desc: '作るフォルダと既存のファイルの衝突を見ない', expect: '[A05]', find: "if (exFiles.has(k)) problems.push({ kind: '作る必要のあるフォルダ", to: "if (false) problems.push({ kind: '作る必要のあるフォルダ" },
  { id: 'X27', desc: '対象がツールの予約名と重なっても見ない', expect: '[A05]', find: R`if (k.split('\\').some((s) => s.startsWith(RESERVED_PREFIX))) problems.push(`, to: 'if (false) problems.push(' },
  { id: 'X28', desc: '保存先のツールの予約名の残りを見ない', expect: '[A05]', find: R`if (d.rel.split('\\').some((s) => normKey(s).startsWith(RESERVED_PREFIX))) problems.push(`, to: 'if (false) problems.push(' },
  // ---- 補助スクリプトの出力
  { id: 'X29', desc: '途中で切れた出力を受け付ける', expect: '[A06]', find: "if (end.type !== 'end' || end.count !== body.length)", to: 'if (false)' },
  { id: 'X30', desc: 'header の無い出力を受け付ける', expect: '[A06]', find: "if (!lines.length || lines[0].type !== 'header')", to: 'if (!lines.length)' },
  // ---- 同期ルート
  { id: 'X31', desc: '登録の無い OneDrive のフォルダも同期ルートにする', expect: '[A07]', find: 'return accounts.filter((a) => registered.has(normKey(a)));', to: 'return accounts;' },
  { id: 'X32', desc: 'API とレジストリの食い違いを見ない', expect: '[A07]', find: 'if (byApi !== !!byReg) throw', to: 'if (false) throw' },
  { id: 'X33', desc: '登録を読めなくても「登録が無い」として進む', expect: '[A17]', find: 'if (err) throw new InputError(', to: 'if (false) throw new InputError(' },
  // ---- 目的・保存先
  { id: 'X34', desc: 'OneDrive の下で目的が無くても進む', expect: '[A08]', find: 'if (syncRoot && !purpose) throw', to: 'if (false) throw' },
  { id: 'X35', desc: '目的が local-folder でも OneDrive の下で圧縮の計画を作る', expect: '[A08]', find: "if (pur === 'local-folder' && syncRoot) {", to: 'if (false) {' },
  { id: 'X36', desc: '同期ルートの外で cloud を受け付ける', expect: '[A08]', find: "if (pur === 'cloud' && !syncRoot) throw", to: 'if (false) throw' },
  { id: 'X37', desc: '方針に無い目的の値を受け付ける', expect: '[A08]', find: "if (!['cloud', 'local-folder'].includes(pur)) throw", to: 'if (false) throw' },
  { id: 'X38', desc: '元の中の保存先を受け付ける', expect: '[A09]', find: 'if (isWithin(d.path, src)) throw', to: 'if (false) throw' },
  { id: 'X39', desc: '保存先の中の元を受け付ける', expect: '[A09]', find: 'if (isWithin(src, d.path)) throw', to: 'if (false) throw' },
  { id: 'X40', desc: 'cloud で同期ルートの外の保存先を受け付ける', expect: '[A09]', find: 'if (syncRoot && !isWithin(d.path, syncRoot)) throw', to: 'if (false) throw' },
  { id: 'X41', desc: 'UNC を受け付ける', expect: '[A09]', find: R`if (/^\\\\/.test(p)) throw new InputError(` + '`${label} にネットワーク', to: 'if (false) throw new InputError(`${label} にネットワーク' },
  { id: 'X42', desc: 'ドライブの直下を受け付ける', expect: '[A09]', find: R`if (path.parse(r).root.toLowerCase() === r.toLowerCase() || /^[A-Za-z]:\\?$/.test(r)) throw`, to: 'if (false) throw' },
  { id: 'X43', desc: '保存先の親のピン留めを警告しない', expect: '[A18]', find: 'if (st.attrs & A.PINNED) { warnings.push(', to: 'if (false) { warnings.push(' },
  { id: 'X44', desc: '保存先の親の状態が読めなくても進む', expect: '[A18]', find: "if (st.error !== undefined) throw new InputError('保存先の親フォルダの状態を読めない", to: "if (false) throw new InputError('保存先の親フォルダの状態を読めない" },
  // ---- 止める理由と計画ID
  { id: 'X45', desc: '判定できないものがあっても止めない', expect: '[A10]', find: 'if (unknown.length) blockers.push(', to: 'if (false) blockers.push(' },
  { id: 'X46', desc: '衝突があっても止めない', expect: '[A10]', find: 'if (collisions.length) blockers.push(', to: 'if (false) blockers.push(' },
  { id: 'X47', desc: '保存先の走査エラーで止めない', expect: '[A10]', find: 'if (destErrors) blockers.push(', to: 'if (false) blockers.push(' },
  { id: 'X48', desc: "対象 0 件を止めない", expect: '[A10]', find: "if (!targets.length && !settleable && !pendingRelease.length) blockers.push(", to: "if (false) blockers.push(" },
  { id: 'X49', desc: '7-Zip の版が読めなくても止めない', expect: '[A10]', find: "else if (!sevenZip.version) blockers.push('7-Zip の版を読み取れない');", to: '' },
  { id: 'X50', desc: '7-Zip が無くても止めない', expect: '[A16]', find: "if (!sevenZip) blockers.push('7-Zip（7z.exe）が見つからない');", to: 'if (!sevenZip) {}' },
  { id: 'X51', desc: '止める理由があっても計画ID を作る', expect: '[A10]', find: 'p.id = p.valid ? planId(p) : null;', to: 'p.id = planId(p);' },
  { id: 'X52', desc: '計画ID で並びを正規化しない', expect: '[A11]', find: '.sort((a, b) => (normKey(a.rel) < normKey(b.rel) ? -1 : normKey(a.rel) > normKey(b.rel) ? 1 : 0))', to: '' },
  { id: 'X53', desc: '計画ID にクラウドのみかどうかを含める（同期で無意味に変わる）', expect: '[A11]', find: 'i.initial.inSync, i.initial.cloudTag] : null]),', to: 'i.initial.inSync, i.initial.cloudTag, i.cloudOnly] : null]),' },
  { id: 'X54', desc: '計画ID にファイルIDを含めない', expect: '[A11]', find: 'i.mtimeMs ?? null, i.fileId ?? null,', to: 'i.mtimeMs ?? null,' },
  { id: 'X55', desc: '計画ID に更新日時を含めない', expect: '[A11]', find: 'i.size ?? null, i.mtimeMs ?? null,', to: 'i.size ?? null,' },
  { id: 'X56', desc: '計画ID に不変であるべき状態（同期済み・ピン等）を含めない', expect: '[A11]', find: 'i.fileId ?? null,' + NL + '        i.initial ? [i.initial.attrs, i.initial.pin, i.initial.placeholder, i.initial.inSync, i.initial.cloudTag] : null]),', to: 'i.fileId ?? null]),' },
  { id: 'X57', desc: '計画ID に 7z の実体のハッシュを含めない', expect: '[A11]', find: 'version: p.sevenZip.version, sha: p.sevenZip.sha }', to: 'version: p.sevenZip.version }' },
  { id: 'X58', desc: '計画ID に 7z の版を含めない', expect: '[A11]', find: 'version: p.sevenZip.version, sha: p.sevenZip.sha }', to: 'sha: p.sevenZip.sha }' },
  { id: 'X59', desc: '計画ID に日数を含めない', expect: '[A11]', find: 'purpose: p.purpose, olderThanDays: p.olderThanDays,' + NL + '    sevenZip', to: 'purpose: p.purpose,' + NL + '    sevenZip' },
  { id: 'X60', desc: 'クラウドのみ／ローカルで切り替わる属性も不変として扱う', expect: '[A11]', find: 'const VOLATILE_ATTRS = A.RECALL_ON_DATA_ACCESS | A.OFFLINE | 0x200 /* SPARSE */ |', to: 'const VOLATILE_ATTRS = 0 |' },
  { id: 'X61', desc: '再解析タグの変種（取得で変わる）まで比べる', expect: '[A11]', find: 'cloudTag: (e.tag & 0xffff0fff) === 0x9000001a,', to: 'cloudTag: e.tag,' },
  { id: 'X72', desc: '計画ID にサイズを含めない', expect: '[A11]', find: "i.cls, i.reason || '', i.size ?? null, i.mtimeMs ?? null,", to: "i.cls, i.reason || '', i.mtimeMs ?? null," },
  { id: 'X73', desc: '計画ID に目的を含めない', expect: '[A11]', find: '    purpose: p.purpose, olderThanDays: p.olderThanDays,', to: '    olderThanDays: p.olderThanDays,' },
  { id: 'X74', desc: 'OneDrive の中に作る保存先のフォルダの名前を見ない', expect: '[A20]', find: R`if (rel && rel.split(/[\\/]/).some((s) => badSegment(s) || oneDriveBadSegment(s))) throw`, to: 'if (false) throw' },
  { id: 'X75', desc: '保存先にドライブの直下を受け付ける', expect: '[A09]', find: "if (path.parse(want).root.toLowerCase() === path.resolve(want).toLowerCase()) throw", to: 'if (false) throw' },
  // ---- 空き
  { id: 'X62', desc: 'クラウドのみの取得分を見積もりに入れない', expect: '[A12]', find: 'const fetch = t.cloudOnly ? t.size : 0;', to: 'const fetch = 0;' },
  { id: 'X63', desc: '書庫の上限を期待値（0.3）で見積もる', expect: '[A12]', find: 'export const archiveUpper = (size) => Math.ceil(size * 1.001) + MiB;', to: 'export const archiveUpper = (size) => Math.ceil(size * 0.3);' },
  // ---- survey
  { id: 'X64', desc: '属性・ファイルIDを読めなかった件数を数えない', expect: '[A19]', find: 'if (e.detailError !== undefined) s.unknown.detail++;', to: '' },
  { id: 'X65', desc: '割当を読めなかった件数を数えない', expect: '[A19]', find: 'if (typeof e.alloc === \'number\') s.alloc += e.alloc; else s.unknown.alloc++;', to: "if (typeof e.alloc === 'number') s.alloc += e.alloc;" },
  { id: 'X66', desc: '読めなかったものがあっても正常で終える', expect: '[A19]', find: 'return r.stats.errors || unk ? 2 : 0;', to: 'return r.stats.errors ? 2 : 0;' },
  // ---- 引数・実行ファイル
  { id: 'X67', desc: '受け付けない引数を通す', expect: '[A13]', find: '} else throw new InputError(`受け付けない引数: ${a}`);', to: '}' },
  { id: 'X68', desc: '同じ引数の重複を通す', expect: '[A13]', find: 'if (Object.hasOwn(o, k)) throw new InputError(`${a} が2回ある`);', to: '' },
  { id: 'X69', desc: '不正な日数を通す', expect: '[A13]', find: R`if (!/^\d+$/.test(o.olderThan)) throw`, to: 'if (false) throw' },
  { id: 'X70', desc: 'survey で使わない --dest を受け付ける（黙って無視する）', expect: '[A13]', find: "survey: { value: ['--source'], flag:", to: "survey: { value: ['--source', '--dest'], flag:" },
  { id: 'X71', desc: 'PATH の相対パスの場所の 7z を選ぶ', expect: '[A14]', find: '    if (!d || !path.isAbsolute(d)) continue;', to: '    if (!d) continue;' },
  // ---- apply（[A21]〜[A34] が実機の 7-Zip で見る）。also は、同じ害を2重に防いでいる箇所を一緒に外すための追加の置き換え
  { id: 'Z01', desc: '再開のときに、元を記録ではなく今回の計画と比べる', expect: '[A26]', find: 'const why = sameInvariant(recorded(m), fileEntry(srcAbs));', to: 'const why = sameInvariant(t, fileEntry(srcAbs));' },
  { id: 'Z02', desc: '事後の再確認をしない（変わった元の書庫を確定する）', expect: '[A26]', find: 'if (why) { quarantineItem(key); throw new ItemError(`処理の間に元が変わった', to: 'if (false) { quarantineItem(key); throw new ItemError(`処理の間に元が変わった' },
  { id: 'Z03', desc: '書庫の CRC と、展開した中身の SHA-256 の照合を両方外す', expect: '[A32]', find: "if (!m.crc32 || (x.crc || '').toUpperCase() !== m.crc32) throw", to: 'if (false) throw', also: [['if (sha !== m.sha256) throw', 'if (false) throw']] },
  // 上書きの再現は「宛先を消してからリンクする」にする（コピーにするとファイルIDが変わり、確定の後の照合で普通の処理まで止まる）
  { id: 'Z04', desc: '宛先が既にあるかの確認と、上書きしない確定を両方外す（上書きする）', expect: '[A27]', find: '    if (tmpE && !fin) {', to: '    if (tmpE) {', also: [['try { fs.linkSync(tmpA, finalAbs); }', 'try { fs.rmSync(finalAbs, { force: true }); fs.linkSync(tmpA, finalAbs); }']] },
  { id: 'Z05', desc: '一時の領域の記録に無いものを無視して進む', expect: '[A29]', find: 'if (strays.length) throw', to: 'if (false) throw' },
  { id: 'Z06', desc: '所有トークンが合わなくても一時フォルダを動かす', expect: '[A33]', find: "if (!fs.existsSync(owner) || fs.readFileSync(owner, 'utf8') !== m.token) throw", to: 'if (false) throw' },
  { id: 'Z07', desc: '計画ID が今の状態と合わなくても進む', expect: '[A22]', find: 'if (p.id !== expect) throw', to: 'if (false) throw' },
  { id: 'Z08', desc: 'ロックを排他的に作らない', expect: '[A28]', find: "const fd = fs.openSync(f, 'wx');", to: "const fd = fs.openSync(f, 'w');" },
  { id: 'Z09', desc: '実行中のロックも古いとみなして回収する', expect: '[A28]', find: 'if (p.alive && String(p.start) === String(held.start)) throw', to: 'if (false) throw' },
  { id: 'Z10', desc: '別の PC のロックも回収する', expect: '[A28]', find: 'if (held.host !== os.hostname()) throw', to: 'if (false) throw' },
  { id: 'Z11', desc: '状態を戻す直前に元を照合しない（中身の照合の前と、属性を変える直前の両方）', expect: '[A30]', find: "if (why) throw new ItemError(`状態を戻す直前に、元が記録と違う", to: "if (false) throw new ItemError(`状態を戻す直前に、元が記録と違う", also: [["  if (why2) throw", "  if (false) throw"]] },
  { id: 'Z12', desc: '「空き容量を増やす」が実際に付いたかを確かめない', expect: '[A30]', find: "if (!after || !(after.attrs & A.UNPINNED)) throw new ItemError('元に", to: "if (false) throw new ItemError('元に" },
  { id: 'Z13', desc: '記録が壊れても前の世代から戻さない', expect: '[A31]', find: "  const prev = readJson(f + '.prev');" + NL + "  if (prev.value && okManifest(prev.value, src, dest)) return { ...prev.value, recoveredFrom: 'prev' };", to: "  const prev = readJson(f + '.prev');" },
  { id: 'Z14', desc: '記録を書くときに前の世代を残さない', expect: '[A31]', find: "} else if (fs.existsSync(f)) writeAtomic(f + '.prev', fs.readFileSync(f));", to: '}' },
  { id: 'Z15', desc: '空きが足りないときに止まらず残りに進む', expect: '[A34]', find: 'e.stop = true; throw e;', to: 'throw e;' },
  { id: 'Z16', desc: '状態を戻す直前に、元の中身（SHA-256）を照合しない', expect: '[A30]', find: "if ((await fileSha(srcAbs)) !== m.sha256) throw", to: 'if (false) throw' },
  { id: 'Z17', desc: '再開のときに、宛先の書庫の中身を照合し直さない', expect: '[A37]', find: "if ((await fileSha(finalAbs)) !== m.tmpArchive.sha256) throw new ItemError('宛先の書庫が、記録した書庫と違う（書き換えられた）');" + NL + '      await verifyArchiveFile(sz, finalAbs, recorded(m), m);', to: '' },
  { id: 'Z18', desc: '確定した後の失敗を「失敗」で上書きする', expect: '[A35]', find: "if (cur && ['committed', 'restoring'].includes(cur.state)) {", to: 'if (false) {' },
  { id: 'Z19', desc: '前の世代から戻した直後の保存で、壊れた今の世代を前の世代へ写す', expect: '[A40]', find: '  if (recovered) {', to: '  if (false) {' },
  { id: 'Z20', desc: '管理用のフォルダが OneDrive の中でも進む', expect: '[A41]', find: 'if (syncRootOf(work)) throw', to: 'if (false) throw' },
  { id: 'Z21', desc: '隔離の上限を、移す量を足さずに判定する', expect: '[A42]', find: 'if (dirBytes(quarantineDir) + dirBytes(m.tmpDir) > limit) throw', to: 'if (dirBytes(quarantineDir) > limit) throw' },
  { id: 'Z22', desc: '隔離の途中（移動先だけにある）を済みにしない', expect: '[A43]', find: "if (atDst && !atSrc) { save({ state: 'quarantined', tmpDir: null }); return 'done'; }", to: '' },
  { id: 'Z23', desc: '隔離の途中で両方にあっても進む', expect: '[A43]', find: 'if (atSrc && atDst) throw', to: 'if (false) throw' },
  { id: 'Z24', desc: '隔離の途中でどちらにも無くても進む', expect: '[A43]', find: 'if (!atSrc && !atDst) throw', to: 'if (false) throw' },
  { id: 'Z25', desc: '書き込み中に空きを監視しない', expect: '[A46]', find: "      watch: () => (freeBytes(destVolDir) < reserve || freeBytes(path.dirname(srcAbs)) < reserve ? '書き込み中に空き容量が予備を割った（7z を止めた）' : null),", to: '      watch: () => null,' },
  { id: 'Z26', desc: '空きの不足を見つけても 7z を止めない', expect: '[A46]', find: '      if (stopped || interrupted) killTree(child);', to: '      if (interrupted) killTree(child);' },
  { id: 'Z27', desc: 'クラウドのみに戻るのを待たずに「戻した」とする', expect: '[A30]', find: "if (Date.now() > deadline) return 'waiting';", to: "if (Date.now() > deadline) return 'released';" },
  // 後の段の確認（作業用のフォルダを作った後の同期ルートの判定）でも止まるが、それでは書いた後になる。[A50] は「何も書かない」ことで見分ける
  { id: 'Z28', desc: '管理用のフォルダが OneDrive の中かを、書く前に確かめない', expect: '[A50]', find: '  if (syncRootOf(probe)) throw', to: '  if (false) throw' },
  { id: 'Z29', desc: '最初の状態を、空きを待つ前に測る（待つ間の変化を見逃す）', expect: '[A48]', find: '    await waitFree(t, sameVolume, reserve, path.dirname(srcAbs), dst);' + NL + '    const e0 = fileEntry(srcAbs);', to: '    const e0 = fileEntry(srcAbs);' + NL + '    await waitFree(t, sameVolume, reserve, path.dirname(srcAbs), dst);' },
  { id: 'Z30', desc: '確定済みから再開するとき、宛先の書庫の中身を照合し直さない', expect: '[A47]', find: "if ((await fileSha(finalAbs)) !== m.archive.sha256) throw new ItemError('確定済みの書庫が、記録した書庫と違う（書き換えられた。元は解放しない）');" + NL + '      await verifyArchiveFile(sz, finalAbs, recorded(m), m);', to: '' },
  { id: 'Z31', desc: '所有の印が無い一時フォルダを、中身ごと消す', expect: '[A51]', find: "if (fs.readdirSync(m.tmpDir).length) throw new BlockedError('一時フォルダの所有の印が無い（中身がある）。動かさない: ' + m.tmpDir);", to: 'fs.rmSync(m.tmpDir, { recursive: true, force: true }); fs.mkdirSync(m.tmpDir);' },
  { id: 'Z32', desc: '所有の印を消した直後に落ちた空のフォルダを片付けられない（やり直せない）', expect: '[A51]', find: '    if (!fs.existsSync(owner)) {', to: "    if (!fs.existsSync(owner)) { throw new BlockedError('一時フォルダの所有の印が無い');" },
  { id: 'Z33', desc: '元がクラウドのみなら、別のファイルでも「戻した」とする（入口）', expect: '[A49]', find: "    if (sameFile(e)) return 'released';", to: "    return 'released';" },
  { id: 'Z34', desc: 'attrib の後、別のファイルでも「戻した」とする', expect: '[A49]', find: "      if (sameFile(now)) return 'released';", to: "      return 'released';" },
  { id: 'Z35', desc: "同じファイルかの判定で、同期済みかを見ない", expect: '[A49]', find: " && (stableState(x).inSync === m.initial.inSync || (stableState(x).inSync && !m.initial.inSync))", to: "" },
  { id: 'Z36', desc: '同じファイルかの判定で、更新日時を見ない', expect: '[A49]', find: ' && ticksToMs(x.mtime) === m.mtimeMs', to: '' },
  // 中断（Ctrl+C）。[A52] [A53] は process.emit('SIGINT') で受け手を直接呼ぶ（Windows では別プロセスから SIGINT を送れない）
  { id: 'Z37', desc: '中断の受け手を 1 回で外す（2 回目の Ctrl+C で既定の即終了に戻る）', expect: '[A52]', find: "  process.on('SIGINT', onSig);", to: "  process.once('SIGINT', onSig);" },
  // 書き込み中の 7z は、監視の繰り返しと中断の受け手の繰り返しの両方が止める。両方と、後始末の待ちの中の止め直しを一緒に外す
  { id: 'Z38', desc: '中断を受けても、書き込み中の 7z を止めない', expect: '[A52]', find: '      if (stopped || interrupted) killTree(child);', to: '      if (stopped) killTree(child);', also: [['      for (const c of children) killTree(c);' + NL, ''], ['    while (interrupted && children.size) { for (const c of children) killTree(c); await', '    while (interrupted && children.size) { await']] },
  { id: 'Z39', desc: '中断で止まった 7z の終わりを、ふつうの失敗として扱う（巻き戻らずに先へ進む）', expect: '[A52]', find: "if (interrupted) { reject(new InterruptError('中断した（Ctrl+C）。書きかけの書庫は採用しない", to: "if (false) { reject(new InterruptError('中断した（Ctrl+C）。書きかけの書庫は採用しない", also: [['const save = (key, patch) => { checkInterrupt(); manifest.items[key] = { ...(manifest.items[key] || {})', 'const save = (key, patch) => { manifest.items[key] = { ...(manifest.items[key] || {})']] },
  // 7z が書き終えた後の中断は、要所の確認（状態の記録の確認を含む）・展開の検証（7z e）の終わりの確認・ハッシュの計算の中の確認が止める。すべて外す
  // 確定の後の中断は、確定済みの段に入る前の確認と、状態の記録（save）の確認の両方が止める。両方を外す
  { id: 'Z41', desc: '確定の後に中断を受けても、後始末・戻しの記録へ進む', expect: '[A54]', find: 'const save = (key, patch) => { checkInterrupt(); manifest.items[key] = { ...(manifest.items[key] || {})', to: 'const save = (key, patch) => { manifest.items[key] = { ...(manifest.items[key] || {})', also: [['  checkInterrupt();' + NL + "  if (['committed', 'restoring'].includes(m.state)) {", "  if (['committed', 'restoring'].includes(m.state)) {"]] },
  // 元の照合の間の中断は、ハッシュの計算の中・照合の直後・attrib の直前の 3 か所が止める。3 か所を外す
  { id: 'Z42', desc: '元の照合の間に中断を受けても、attrib を呼ぶ', expect: '[A55]', find: "  if (why2) throw new ItemError(`状態を戻す直前に、元が記録と違う（${why2}。何も変えない。要対応）`);\n  checkInterrupt();\n  save({ state: 'restoring' });", to: "  if (why2) throw new ItemError(`状態を戻す直前に、元が記録と違う（${why2}。何も変えない。要対応）`);\n  save({ state: 'restoring' });", also: [["function runAttrib(args) {\n  checkInterrupt();\n", "function runAttrib(args) {\n"], ["  rs.on('data', (b) => { if (interrupted) { rs.destroy(new InterruptError('中断した（Ctrl+C）。続きは plan と apply をやり直す')); return; } h.update(b); });", "  rs.on('data', (b) => { h.update(b); });"]] },
  { id: 'Z43', desc: '戻るのを待っている間の中断を見ずに、「待ち」で終える', expect: '[A55]', find: '  for (;;) {' + NL + '    checkInterrupt();' + NL + '    const now = fileEntry(abs);', to: '  for (;;) {' + NL + '    const now = fileEntry(abs);' },
  { id: 'Z40', desc: '7z が書き終えた後に中断を受けても、検証・確定へ進む', expect: '[A53]', find: 'function checkInterrupt() { if (interrupted) throw', to: 'function checkInterrupt() { if (false) throw', also: [["if (interrupted) { reject(new InterruptError('中断した（Ctrl+C）。書庫の検証を終えていない", "if (false) { reject(new InterruptError('中断した（Ctrl+C）。書庫の検証を終えていない"], ["  rs.on('data', (b) => { if (interrupted) { rs.destroy(new InterruptError('中断した（Ctrl+C）。続きは plan と apply をやり直す')); return; } h.update(b); });", "  rs.on('data', (b) => { h.update(b); });"]] },
  // ---- 完了の判定（status・verify-current）と apply の件数
  { id: 'Z44', desc: 'status: 記録が空でも完了とする', expect: '[A56]', find: 'const complete = restored > 0 && restored === items.length', to: 'const complete = restored === items.length' },
  { id: 'Z45', desc: 'status: 中止・失敗を完了の妨げにしない', expect: '[A56]', find: 'const complete = restored > 0 && restored === items.length', to: "const complete = restored > 0 && items.every((m) => ['restored', 'abandoned', 'failed'].includes(m.state))" },
  { id: 'Z55', desc: "status: 読み直しで取得したままの書庫を完了の妨げにしない", expect: '[A62]', find: " && axes.refetched === 0 && axes.source.localReleasePending === 0;", to: " && axes.source.localReleasePending === 0;" },
  { id: 'Z56', desc: 'status: 元が見つからないと記録を表示しない', expect: '[A56]', find: "    try { fs.lstatSync(p); return false; } catch (e) { if (e.code !== 'ENOENT') throw e; }", to: '    return false;' },
  { id: 'Z46', desc: "apply: 失敗のほか（戻し待ち・未処理・対象外の要対応）を終了コードに反映しない", expect: '[A61]', find: "return counts.failed || counts.pending || counts.notRun || counts.attention || (counts.local", to: "return counts.failed || (counts.local" },
  { id: 'Z47', desc: 'apply: 打ち切った残りを「未処理」として数えない', expect: '[A60]', find: '    counts.notRun = targets.length - i;', to: '' },
  { id: 'Z48', desc: 'verify-current: 保存先の書庫以外のファイル（同期の衝突の別名）を見ない', expect: '[A57]', find: "else if (!expected.has(destKey(rel))) add('保存先に、書庫以外", to: "else if (false) add('保存先に、書庫以外" },
  { id: 'Z49', desc: 'verify-current: 記録上は済みだが今の書庫・元が違うものを、完了の妨げにしない', expect: '[A57]', find: "      else if (m.state === 'restored') add('記録上は済みだが、今の元または書庫が記録と違う', it.rel);" + NL + "      else add('途中で止まった', it.rel);", to: "      else if (m.state !== 'restored') add('途中で止まった', it.rel);" },
  // 書き換えられた書庫は、ファイルの SHA-256 と展開の検証（7z t の CRC）の両方が止める。両方を外す
  { id: 'Z50', desc: 'verify-current --rehash-archives: 書庫を照合しない', expect: '[A58]', find: "        if ((await fileSha(absList[k])) !== m.archive.sha256) throw new ItemError('書庫のファイルの SHA-256 が記録と違う');" + NL + '        await verifyArchiveFile(p.sevenZip, absList[k], { rel: m.rel, size: m.size }, m);', to: '' },
  { id: 'Z51', desc: 'verify-current --rehash-archives: ロックを取らない', expect: '[A58]', find: 'return rehash ? guarded(`verify-current ${src}`, log, run) : run();', to: 'return run();' },
  { id: 'Z52', desc: '同期済みの判定で、同期済み（IN_SYNC）を見ない', expect: '[A59]', find: "if (!(e.ph & PH.IN_SYNC)) return '同期中", to: "if (false) return '同期中" },
  { id: 'Z53', desc: '同期済みの判定で、一部だけ取得を見ない', expect: '[A59]', find: "if (s === 'partial' || s === 'unknown') return '一部だけ取得", to: "if (false) return '一部だけ取得" },
  { id: 'Z54', desc: '同期済みの判定で、ファイルID・サイズを見ない', expect: '[A59]', find: "if (e.fileId !== arc.fileId || e.size !== arc.size) return '書庫が記録と違う（ファイルID・サイズ）';", to: '' },
  { id: 'Z57', desc: 'verify-current: 保存先の書庫の置き場所でないフォルダを見ない', expect: '[A57]', find: "if (kind === 'dir') { if (!expectedDirs.has(destKey(rel))) add(", to: "if (kind === 'dir') { if (false) add(" },
  { id: 'Z58', desc: '--rehash-archives: 読む前に「取得した」と記録しない（失敗・中断の後に戻し直せない）', expect: '[A62]', find: '      if (wasCloud) save(key, { archiveRefetch: { at: new Date(nowMs()).toISOString() } });', to: '' },
  { id: 'Z59', desc: '--rehash-archives: 照合に失敗したら、戻す処理を試みない', expect: '[A62]', find: '        add(e.message, done[k].dest);' + NL + '      }' + NL + '      // 照合の成否によらず', to: '        add(e.message, done[k].dest);' + NL + '        continue;' + NL + '      }' + NL + '      // 照合の成否によらず' },
  { id: 'Z60', desc: '--rehash-archives: 戻した後も「取得した」の記録を消さない', expect: '[A62]', find: "if (r === 'released') save(key, { archiveRefetch: null });", to: "if (r === 'released') {}" },
  { id: 'Z61', desc: '--rehash-archives: 前の読み直しで取得したままの書庫を、戻す対象にしない', expect: '[A62]', find: 'const wasCloud = nowCloud || !!m.archiveRefetch;', to: 'const wasCloud = nowCloud;' },
  { id: 'Z62', desc: 'verify-current: 取得したままの書庫を完了の妨げにしない', expect: '[A62]', find: 'if (m.archiveRefetch && !nowCloud) add(', to: 'if (false) add(' },
  { id: 'Z63', desc: 'verify-current: 今の対象に入らない失敗・中止の記録を数えない', expect: '[A63]', find: 'for (const k of p.settle) add(', to: 'for (const k of []) add(' },
  { id: 'Z64', desc: 'apply: 今の対象に入らない失敗・中止の記録を履歴へ整理しない', expect: '[A63]', find: "      if (!['failed', 'abandoned'].includes(m.state) || liveKeys.has(k)) continue;", to: '      continue;' },
  { id: 'Z65', desc: "plan: 対象が 0 件なら、整理する記録があっても止める", expect: '[A63]', find: "if (!targets.length && !settleable && !pendingRelease.length) blockers.push(", to: "if (!targets.length && !pendingRelease.length) blockers.push(" },
  { id: 'Z66', desc: 'status: 対象の記録が 0 件なら、履歴があっても「まだ動いていない」とする', expect: '[A64]', find: 'if (!r.runs.length && !r.total && !r.history) {', to: 'if (!r.total) {' },
  { id: 'Z67', desc: 'status: 存在する元も「見つからない」として扱い、入力の検証を飛ばす', expect: '[A64]', find: "  if (gone(source, '--source')) {", to: '  if (true) {' },
  { id: 'Z68', desc: 'status: ドライブの直下（存在しないドライブを含む）を拒否しない', expect: '[A64]', find: 'if (path.parse(r).root.toLowerCase() === r.toLowerCase()) throw', to: 'if (false) throw' },
  { id: 'Z70', desc: 'status: UNC を拒否しない', expect: '[A64]', find: R`if (/^[\\/]{2}/.test(p)) throw`, to: 'if (false) throw' },
  { id: 'Z71', desc: 'status: 元が無いとき、保存先の検証（ファイル・リンクの拒否）を飛ばす', expect: '[A64]', find: "    if (!gone(want, '--dest')) return { src: s, dst: resolveDest(s, want).path, found: false };", to: '' },
  { id: 'Z72', desc: '保存先の親がファイルでも「保存先がまだ無い」とする（plan・status）', expect: '[A64]', find: "  if (!fs.statSync(parent).isDirectory()) throw new InputError('--dest の親がフォルダではない');", to: '' },
  { id: 'Z73', desc: 'status: 途中がファイルのパスを「無い」とする（Windows は ENOENT を返す）', expect: '[A64]', find: "        if (!fs.statSync(a).isDirectory()) throw new InputError(`${label} の途中がフォルダではない`);", to: '' },
  // ---- アップロードの確認と書庫の解放（S3-3b）。[A62] [A65] [A66] は OneDrive の模擬で見る
  { id: 'Z74', desc: "apply: 同期を確かめられない書庫も解放する", expect: '[A65]', find: "  if (notSynced(fileEntry(abs), m.archive)) return 'notSynced';", to: "" },
  { id: 'Z75', desc: "apply: 同期済みの書庫を、その場で解放しない", expect: '[A62]', find: "if (r !== 'waiting' && destSyncRoot) await releaseNewArchive(", to: "if (false) await releaseNewArchive(" },
  { id: 'Z76', desc: "release-archives: 確認の無い書庫も解放する", expect: '[A65]', find: "const confirmed = x.machineSynced || (m.archiveSync", to: "const confirmed = true || (m.archiveSync" },
  { id: 'Z77', desc: "確認ID に「機械で同期済みか」を含めない（状態が変わっても ID が変わらない）", expect: '[A65]', find: "return [x.key, a.fileId, a.size, a.sha256, x.machineSynced];", to: "return [x.key, a.fileId, a.size, a.sha256];" },
  { id: 'Z78', desc: "confirm-upload: 確認ID を照合しない", expect: '[A65]', find: "（確認するものが無い）');\n    if (c.id !== expect) throw", to: "（確認するものが無い）');\n    if (false) throw" },
  { id: 'Z79', desc: "release-archives: 確認ID を照合しない", expect: '[A65]', find: "throw new BlockedError('解放していない書庫が無い');\n    if (c.id !== expect) throw", to: "throw new BlockedError('解放していない書庫が無い');\n    if (false) throw" },
  { id: 'Z80', desc: "解放: もうクラウドのみの書庫も読み直して attrib を呼ぶ（取得が起きる）", expect: '[A66]', find: "  if (localState(e) === 'cloud-only' && same(e)) return 'released';", to: "" },
  { id: 'Z81', desc: "解放: 属性を変える直前に書庫の中身を照合しない", expect: '[A66]', find: "if ((await fileSha(abs)) !== arc.sha256) throw new ItemError('状態を戻す直前に、書庫の中身が記録と違う", to: "if (false) throw new ItemError('状態を戻す直前に、書庫の中身が記録と違う" },
  { id: 'Z82', desc: "解放: 指定が付かない書庫を「解放できない」と分けない", expect: '[A66]', find: "const blocked = /指定が付かない/.test(e.message);", to: "const blocked = false;" },
  { id: 'Z83', desc: "release-archives: 古い確認ID に対する利用者の確認でも解放する", expect: '[A65]', find: " && m.archiveSync.uploadId === c.id);", to: ");" },
  { id: 'Z84', desc: "解放: 中身の照合の後、属性を変える直前に書庫のファイルID・サイズを照合し直さない", expect: '[A67]', find: "if (!e2 || e2.kind !== 'file' || e2.fileId !== arc.fileId || e2.size !== arc.size) throw", to: "if (false) throw" },
  { id: 'Z85', desc: "解放: 機械で同期済みを根拠にするとき、属性を変える直前に同期済みを確かめ直さない", expect: '[A67]', find: "if (requireSynced && notSynced(e2, arc)) throw", to: "if (false) throw" },
  { id: 'Z86', desc: "元の状態の復元: 中身の照合の後、属性を変える直前に元を照合し直さない", expect: '[A67]', find: "  if (why2) throw", to: "  if (false) throw" },
  { id: 'Z87', desc: "verify-current: 記録と一致しない書庫があっても確認ID を出す", expect: '[A67]', find: "id: set.length && !anomalies.length ? uploadId(", to: "id: set.length ? uploadId(" },
  { id: 'Z88', desc: "confirm-upload・release-archives: 記録と一致しない書庫があっても進む", expect: '[A67]', find: "  if (anomalies.length) throw new BlockedError(`解放していない書庫のうち", to: "  if (false) throw new BlockedError(`解放していない書庫のうち" },
  { id: 'Z89', desc: "status --json: 解放の列を JSON にできない形のまま出す", expect: '[A67]', find: "release: Object.fromEntries(r.axes.release), source:", to: "release: r.axes.release, source:" },
  { id: 'Z90', desc: "release-archives: 機械で同期済みを根拠にしても、直前の確かめ直しを求めない", expect: '[A67]', find: "rereleaseArchive(abs, m.archive, waitMs, machineSynced)", to: "rereleaseArchive(abs, m.archive, waitMs)" },
  { id: 'Z91', desc: "確認ID の対象から、今の計画で済みにならない記録を黙って外す", expect: '[A67]', find: "if (!doneKeys.has(key)) anomalies.push(", to: "if (false) anomalies.push(" },
  // ---- 削除の前の検査（S3-3c）。[A68] [A69] は手元のフォルダ、[A70] は OneDrive の模擬で見る
  { id: 'Z92', desc: "deletion-check: 削除検査ID を照合しない", expect: '[A68]', find: "if (sc.id !== expect) throw new BlockedError(`削除検査ID が今の状態と合わない", to: "if (false) throw new BlockedError(`削除検査ID が今の状態と合わない" },
  { id: 'Z93', desc: "削除検査ID に、候補にならないファイルの一覧を含めない（増えたファイルで ID が変わらない）", expect: '[A68]', find: "    others: sortBy(others, (o) => normKey(o.rel)).map((o) => [normKey(o.rel), o.cls, o.reason || '']),", to: "    others: []," },
  { id: 'Z94', desc: "deletion-check: 書庫を照合しない", expect: '[A68]', find: "    if ((await fileSha(c.arcAbs)) !== m.archive.sha256) throw new ItemError('書庫のファイルの SHA-256 が記録と違う');\n    await verifyArchiveFile(sc.p.sevenZip, c.arcAbs, { rel: m.rel, size: m.size }, m);", to: "" },
  { id: 'Z95', desc: "deletion-check: 元を読み直して照合しない", expect: '[A68]', find: "    if ((await fileSha(c.srcAbs)) !== m.sha256) throw new ItemError('元の中身が記録と違う');", to: "" },
  { id: 'Z96', desc: "deletion-check: 終わりに範囲を計算し直さない（最後のファイルの後の変更を見逃す）", expect: '[A69]', find: "    if (!changed && !unchanged()) changed = true;", to: "" },
  { id: 'Z97', desc: "deletion-check: 元の状態に戻せなくても一覧を出す", expect: '[A70]', find: "const listValid = !changed && restoreErr.length === 0;", to: "const listValid = !changed;" },
  { id: 'Z98', desc: "deletion-check: 読む前に「取得した」と記録しない", expect: '[A70]', find: "  if (srcCloud || arcCloud) save(c.key, { deletionRefetch: {", to: "  if (false) save(c.key, { deletionRefetch: {" },
  { id: 'Z99', desc: "deletion-check: 前の検査で取得したままのもの（印のある記録）を、範囲・ID の照合より先に戻さない", expect: '[A70]', find: "    if (flagged.length) {", to: "    if (false) {" },
  { id: 'Z100', desc: "deletion-check: 戻した後も「取得した」の印を消さない", expect: '[A70]', find: "  else if (srcCloud || arcCloud) save(c.key, { deletionRefetch: null });", to: "" },
  { id: 'Z101', desc: "deletion-check: 元に残すファイルがあっても、フォルダ単位の deletion-ready を出す", expect: '[A68]', find: " && keep.length === 0;", to: ";" },
  { id: 'Z102', desc: "deletion-check: 書庫が同期済みでなくても候補にする", expect: '[A70]', find: "if (sc.p.destSyncRoot) { const ns = notSynced(a, m.archive); if (ns) return", to: "if (false) { const ns = notSynced(a, m.archive); if (ns) return" },
  { id: 'Z103', desc: "deletion-check: 空きが足りなくても読み直す（取得が起きる）", expect: '[A70]', find: "  if (short) return '空きが足りず、読み直せない';", to: "" },
  { id: 'Z104', desc: "deletion-check: 照合に失敗したら、取得したものを戻す処理を試みない", expect: '[A70]', find: "    if (err instanceof ItemError) why = err.message; else pending = err;", to: "    if (err instanceof ItemError) return err.message; else pending = err;" },
  { id: 'Z105', desc: "取得したものを戻す: 想定外の例外で、もう一方を試さずに止まる", expect: '[A71]', find: "if (!(err instanceof ItemError)) fatal = fatal || err;", to: "if (!(err instanceof ItemError)) throw err;" },
  { id: 'Z107', desc: "戻せなかった量を、戻せた側まで含めて数える", expect: '[A71]', find: "  if (errs.length) restoreErr.push({ rel: c.rel, paths, why: errs.join(' / '), bytes });", to: "  if (errs.length) restoreErr.push({ rel: c.rel, paths, why: errs.join(' / '), bytes: (srcCloud ? m.size : 0) + (arcCloud ? m.archive.size : 0) });" },
  { id: 'Z108', desc: "走査の完全性に、リンク等の特殊なオブジェクトを数えない", expect: '[A71]', find: " && links === 0 && !changed;", to: " && !changed;" },
  { id: 'Z109', desc: "詳細ファイルの「元に残す」に実パスを書かない", expect: '[A71]', find: ".map((o) => ({ ...o, path: path.join(sc.src, o.rel) }));", to: ";" },
  { id: 'Z110', desc: "deletion-check: 各ファイルの直前に範囲を計算し直さない（§9）", expect: '[A69]', find: "      if (!unchanged()) { changed = true; break; }", to: "" },
  { id: 'Z111', desc: "deletion-check: 検査の間に、ほかの実行が記録を書いたこと（世代のずれ）を見ない", expect: '[A69]', find: " && now.manifest.generation === startGen + ownSaves;", to: ";" },
  { id: 'Z112', desc: "削除検査ID に記録の世代を含めない（ほかの実行の書き込みで ID が変わらない）", expect: '[A68]', find: "generation: generation ?? manifest.generation, manifest:", to: "manifest:" },
  { id: 'Z113', desc: 'deletion-check: 印のある記録を戻す途中で、1 件の想定外の例外で残りを戻さずに止まる', expect: '[A72]', find: "          if (err instanceof InterruptError) throw err;\n          failed.add(key);", to: "          throw err;" },
  // ---- 最初からローカルにあった元の解放（--release-local。S3-4）。[A73] は OneDrive の模擬で見る
  { id: 'Z114', desc: "apply --release-local: 解放ID を照合しない", expect: '[A73]', find: "if (p.releaseLocal.id !== expectRelease) throw", to: "if (false) throw" },
  { id: 'Z115', desc: "apply --release-local: 元が OneDrive の外でも受け付ける", expect: '[A73]', find: "if (!p.syncRoot) throw new InputError('--release-local は", to: "if (false) throw new InputError('--release-local は" },
  { id: 'Z116', desc: "最初からローカルの元の解放: 同期済みを確かめない", expect: '[A73]', find: "if (ns) { save({ sourceRelease: { state: 'notSynced'", to: "if (false) { save({ sourceRelease: { state: 'notSynced'" },
  { id: 'Z117', desc: "最初からローカルの元を、指定が無くても解放する", expect: '[A73]', find: "if (r === 'untouched' && releaseLocal) await releaseLocalSource(", to: "if (r === 'untouched') await releaseLocalSource(" },
  { id: 'Z118', desc: "解放ID に対象を含めない（ローカル／クラウドのみが変わっても ID が変わらない）", expect: '[A73]', find: "const items = [...targets].map((t) => [normKey(t.rel), t.fileId, t.size, t.mtimeMs])", to: "const items = [].map((t) => [normKey(t.rel), t.fileId, t.size, t.mtimeMs])" },
  { id: 'Z119', desc: "apply: 指定した元を解放し切れなくても終了コード 0", expect: '[A73]', find: " || (counts.local && counts.local.released !== counts.local.total) ? 2 : 0;", to: " ? 2 : 0;" },
  { id: 'Z120', desc: "--release-local と --expect-release を片方だけでも受け付ける", expect: '[A73]', find: "  if (cmd === 'apply' && (o.releaseLocal || o.expectRelease !== undefined) && !(o.releaseLocal && /^R-[0-9a-f]{16}$/.test(o.expectRelease || ''))) throw", to: "  if (false) throw" },
  { id: 'Z121', desc: "不変の照合で、同期待ち → 同期済みの変化を許さない（アップロードが終わっただけで止まる）", expect: '[A74]', find: "    if (k === 'inSync' && b.inSync === false && a.inSync === true) continue;", to: "" },
  { id: 'Z122', desc: "最初からローカルの元の解放のやり直しで、自分が付けたピンの違いを許さない", expect: '[A74]', find: "const mm = m.releaseAttempted && e && pinState(e.attrs) === 'unpinned' && m.initial.pin !== 'unpinned' ? { ...m, initial: { ...m.initial, pin: 'unpinned' } } : m;", to: "const mm = m;" },
  { id: 'Z123', desc: "plan: 解放し切れていない済みの対象を、解放の別表に含めない", expect: '[A74]', find: "    return !!m && !!m.releaseLocalRequested && !(m.sourceRelease && m.sourceRelease.state === 'released');", to: "    return false;" },
  { id: 'Z124', desc: "apply: 解放を指定されたことを、済みの記録と同時に残さない（直後の中断でやり直せない）", expect: '[A74]', find: ", ...(r === 'untouched' && releaseLocal ? { releaseLocalRequested: true } : {})", to: "" },
  { id: 'Z125', desc: "status: 解放し切れていないものがあっても完了とする", expect: '[A74]', find: " && axes.source.localReleasePending === 0;", to: ";" },
  { id: 'Z126', desc: "verify-current: 解放し切れていないものを完了の妨げにしない", expect: '[A74]', find: "if (m && m.releaseLocalRequested && !(m.sourceRelease && m.sourceRelease.state === 'released')) add(", to: "if (false) add(" },
  { id: 'Z127', desc: "plan --json: 解放の別表と解放ID を出さない", expect: '[A74]', find: ", releaseLocal: { count: p.releaseLocal.count, pending: p.releaseLocal.pending, bytes: p.releaseLocal.bytes, id: p.releaseLocal.id }", to: "" },
  { id: 'Z128', desc: "apply: 解放し切れていない済みの対象を、解放し直さない", expect: '[A74]', find: "      for (const key of p.releaseLocal.pendingKeys) {", to: "      for (const key of []) {" },
  { id: 'Z129', desc: "最初からローカルの元の解放: 属性を変える直前に「試みた」印を残さない（直後の中断から 1 回で戻れない）", expect: '[A74]', find: ", 0, () => save({ releaseAttempted: true }));", to: ", 0, () => {});" },
  { id: 'Z130', desc: "最初からローカルの元の解放: 試みた印が無くてもピンの違いを許す", expect: '[A74]', find: "const mm = m.releaseAttempted && e && pinState(e.attrs) === 'unpinned'", to: "const mm = true && e && pinState(e.attrs) === 'unpinned'" },
  { id: 'Z131', desc: "最初からローカルの元の解放: 「試みた」印を照合の前に残す（照合で止まった試みも、次は利用者のピンの変更を許す）", expect: '[A74]', find: "  const mm = m.releaseAttempted && e && pinState(e.attrs) === 'unpinned' && m.initial.pin !== 'unpinned' ? { ...m, initial: { ...m.initial, pin: 'unpinned' } } : m;\n  try {", to: "  const mm = m.releaseAttempted && e && pinState(e.attrs) === 'unpinned' && m.initial.pin !== 'unpinned' ? { ...m, initial: { ...m.initial, pin: 'unpinned' } } : m;\n  save({ releaseAttempted: true });\n  try {" },
  // ---- 圧縮の候補ルート（roots。S2b-1）。[A75] が補助スクリプトの差し替えと実機で見る
  { id: 'Z132', desc: "roots: 同期ルートの中の既知フォルダも候補にする（同じ所を二重に数える）", expect: '[A75]', find: ".filter((k) => k.exists && !k.inSyncRoot).map((k) => ({ kind: 'known'", to: ".filter((k) => k.exists).map((k) => ({ kind: 'known'" },
  { id: 'Z133', desc: "roots: 存在しない既知フォルダも候補にする", expect: '[A75]', find: ".filter((k) => k.exists && !k.inSyncRoot).map((k) => ({ kind: 'known'", to: ".filter((k) => !k.inSyncRoot).map((k) => ({ kind: 'known'" },
  { id: 'Z134', desc: "roots: 読めなかったものがあっても終了コード 0", expect: '[A75]', find: "      return r.errors.length ? 2 : 0;", to: "      return 0;" },
  { id: 'Z135', desc: "roots: 同期ルートを読めないと例外で止まる（一覧も読めなかったことも返さない）", expect: '[A75]', find: "try { syncs = syncRoots(); } catch (e) { syncs = []; syncsKnown = false; errors.push(`syncroots: ${e.message}`); }", to: "syncs = syncRoots();" },
  { id: 'Z136', desc: "roots: フォルダでない既知フォルダを「無い」として黙って外す", expect: '[A75]', find: "{ state = 'notDir'; errors.push(`knownfolder:${r.name}: フォルダではない`); }", to: "{ state = 'missing'; }" },
  { id: 'Z137', desc: "roots: 既知フォルダの実体（ジャンクションの先）で同期ルートと比べない", expect: '[A75]', find: "else real = fs.realpathSync.native(r.path);", to: "else real = r.path;" },
  { id: 'Z138', desc: "roots: 同期ルートを読めなくても、既知フォルダを候補にする", expect: '[A75]', find: "...(syncsKnown ? known.filter(", to: "...(true ? known.filter(" },
  { id: 'Z139', desc: "同期ルートを実体にせず、登録の表記のまま返す（roots・survey・plan の判定がジャンクションで食い違う）", expect: '[A75]', find: "    try { return fs.realpathSync.native(p); } catch (e) {", to: "    try { return p; } catch (e) {" },
  { id: 'Z140', desc: "survey --summary: リンクの数を出さない（入口と出口の件数を照合できない）", expect: '[A76]', find: " / リンク ${s.links} / 論理 ", to: " / 論理 " },
  { id: 'Z141', desc: "survey --json: リンクの数を出さない", expect: '[A76]', find: "files: r.stats.files, links: r.stats.links, errors:", to: "files: r.stats.files, errors:" },
  { id: 'Z142', desc: "plan --json: 区分ごとの集計（census）を出さない（入口と照合できない）", expect: '[A76]', find: ", census: planCensus(p.items)", to: "" },
  { id: 'Z143', desc: "同期ルート: アカウント側を実体にせずに突き合わせる（アカウント側だけジャンクションだと落ちる）", expect: '[A75]', find: ".filter((r) => r.type === 'account').map((r) => real(r.folder));", to: ".filter((r) => r.type === 'account').map((r) => r.folder);" },
  { id: 'Z144', desc: "同期ルート: 登録側を実体にせずに突き合わせる（登録側だけジャンクションだと落ちる）", expect: '[A75]', find: ".map((r) => normKey(real(r.folder))));", to: ".map((r) => normKey(r.folder)));" },
  { id: 'Z145', desc: "plan --json: 計画を作らないときも計画の形で出そうとする（{noPlan:true} の明示が消える）", expect: '[A08]', find: "  if (p.noPlan) return { noPlan: true };", to: "  if (false) return { noPlan: true };" },
  { id: 'Z69', desc: "status --json: 元の有無・実行回数・3 列・履歴を出さない", expect: '[A64]', find: ", found: r.found, runs: r.runs.length, axes: { ...r.axes, release: Object.fromEntries(r.axes.release), source: { ...r.axes.source, localRelease: Object.fromEntries(r.axes.source.localRelease) } }, history: r.history", to: "" },
  // ---- 補助スクリプト（ut-archive-win.ps1）。[A15] が実機の一時フォルダで見る
  { id: 'Y01', file: 'ps1', desc: 'ジャンクションを link にせず、たどる', expect: '[A15]', find: 'bool link = isReparse && !IsCloudTag(tag);', to: 'bool link = false;' },
  { id: 'Y02', file: 'ps1', desc: 'リンク数を返さない（ハードリンクを見逃す）', expect: '[A15]', find: R`parts.Add("\"links\":" + bi.nNumberOfLinks);`, to: R`parts.Add("\"links\":1");` },
  { id: 'Y03', file: 'ps1', desc: 'ADS を数えない', expect: '[A15]', find: 'if (sd.cStreamName != "::$DATA") n++;', to: 'if (false) n++;' },
  { id: 'Y04', file: 'ps1', desc: 'end の件数を数え違える', expect: '[A15]', find: `$w.WriteLine('{"type":"end","count":' + $n + '}')`, to: `$w.WriteLine('{"type":"end","count":' + ($n + 1) + '}')` },
  { id: 'Y05', file: 'ps1', desc: 'stat で読めないパスをエラーにしない', expect: '[A15]', find: R`if (h == INVALID) return "{\"type\":\"stat\",\"path\":" + Js(full) + ",\"error\":" + Marshal.GetLastWin32Error() + "}";`, to: R`if (h == INVALID) return "{\"type\":\"stat\",\"path\":" + Js(full) + ",\"attrs\":16}";` },
];

{ const ids = mutations.map((m) => m.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }

// only: 変異ごとに、その防御を見る試験だけを動かす（--only）。基準実行は全件を動かす
function runSelftest(file, only = null) {
  return new Promise((resolve) => {
    // 基準実行（全件）は削除の前の検査の試験で 15 分を超える（実測 15.5 分）ので 60 分まで待つ。変異ごとの実行（--only）は 15 分
    execFile(process.execPath, [file, '--selftest', ...(only ? ['--only', only] : [])], { encoding: 'utf8', timeout: only ? 900000 : 3600000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const names = (out.match(/^\s+NG {2}.*$/gm) || []).map((x) => x.replace(/^\s+NG {2}/, '').split(' | ')[0]);
      const total = Number((/selftest: (\d+) 件中/.exec(out) || [])[1] || 0);
      resolve({ out, code, names, total });
    });
  });
}

// 変異ごとに専用のフォルダを作り、mjs と ps1 を（片方だけ壊して）並べる（mjs は横の ps1 を呼ぶ）
async function runMutant(m) {
  const kind = m.file || 'mjs';
  const hits = SRC[kind].split(m.find).length - 1;
  if (hits !== 1) return { ...m, verdict: 'INVALID', detail: 'アンカー一致 ' + hits + ' 件' };
  let mutated = SRC[kind].replace(m.find, () => m.to);
  for (const [f, to] of m.also || []) {
    if (mutated.split(f).length - 1 !== 1) return { ...m, verdict: 'INVALID', detail: '追加のアンカー不一致' };
    mutated = mutated.replace(f, () => to);
  }
  const dir = path.join(tmp, m.id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ut-archive.mjs'), kind === 'mjs' ? mutated : SRC.mjs);
  fs.writeFileSync(path.join(dir, 'ut-archive-win.ps1'), kind === 'ps1' ? mutated : SRC.ps1);
  const r = await runSelftest(path.join(dir, 'ut-archive.mjs'), m.expect.replace(/^\[|\]$/g, ''));
  if (r.names.length === 0 && r.code !== 0) return { ...m, verdict: 'CRASHED', detail: '異常終了(exit=' + r.code + ') ' + r.out.split(NL).filter(Boolean).slice(-2).join(' / ') };
  const hit = r.names.some((n) => n.startsWith(m.expect + ' '));
  return { ...m, verdict: hit ? 'CAUGHT' : r.names.length ? 'OTHER' : 'MISSED', detail: 'NG ' + r.names.length + ' 件', ngNames: r.names };
}

const base = await runSelftest('tools/ut-archive.mjs');
if (base.code !== 0 || base.names.length) {
  console.log('基準実行（変異なし）の selftest が失敗しているため掃引しない: ' + (base.names.join(' / ') || 'exit=' + base.code));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  process.exit(1);
}
console.log('基準実行: selftest ' + base.total + ' 件全件パス');
const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',').map((x) => x.trim())) : null;
if (only) {
  console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
  const unknown = [...only].filter((id) => !mutations.some((m) => m.id === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
}
const rows = [];
const queue = mutations.filter((m) => !only || only.has(m.id));
const jobs = Math.max(1, Math.min(Number(process.env.UT_SWEEP_JOBS) || 8, os.cpus().length));
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) rows.push(await runMutant(queue.shift())); }));
rows.sort((a, b) => a.id.localeCompare(b.id));
console.log('== ut-archive ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(5) + r.verdict.padEnd(8) + r.desc + '  -> ' + r.detail);
  if (r.verdict !== 'CAUGHT') for (const n of (r.ngNames || [])) console.log('          落ちた: ' + n + '（期待: ' + r.expect + '）');
}
const by = (v) => rows.filter((r) => r.verdict === v);
console.log(NL + '検出 ' + by('CAUGHT').length + ' / ' + rows.length + '   未検出 ' + by('MISSED').length + '   別理由で検出 ' + by('OTHER').length +
  '   異常終了 ' + by('CRASHED').length + '   設計不正 ' + by('INVALID').length);
for (const v of ['MISSED', 'OTHER', 'CRASHED', 'INVALID']) if (by(v).length) console.log(v + ': ' + by(v).map((r) => r.id + ' ' + r.detail).join(' / '));
console.log('対象外（selftest で決定的に起こせないもの）:');
console.log('  - マウントポイントの判定（ボリュームの違うフォルダを作れない）');
console.log('  - deletion-check の、元と保存先が別のボリュームのときの空きの確かめ方（ボリュームの違うフォルダを作れない。同じボリュームの合計は Z103 で見る）');
console.log('  - 補助スクリプトの Cloud Files の判定（プレースホルダーを作れない。実機の OneDrive で 1 回確かめた）');
console.log('  - 補助スクリプトの ADS・ファイルの列挙の途中失敗（API の途中の失敗を起こせない）');
console.log('  - 補助スクリプトでファイルを開けなかったときも ADS の判定を続けること（ファイルの属性の読み取りだけを拒否しても、');
console.log('    親フォルダの一覧の権限で暗黙に許されて開けてしまう。実機で確かめた。mjs の側の数え方は [A19] で見る）');
console.log('  - 補助スクリプトのドライブ直下の扱い（mjs がドライブの直下を先に拒否するため、補助スクリプトまで届かない）');
console.log('  - 補助スクリプトの knownfolders で値が無いときの error の行（実機のレジストリの値を消せない。mjs の側の数え方は [A75] で見る）');
console.log('  - レジストリを読めないときの error の行（mjs の側は [A17] で見る。補助スクリプトの側は権限を奪えない）');
console.log('  - 中断の後、処理が巻き戻らないまま一定時間たったときの強制終了（process.exit で selftest ごと終わる）');
console.log('  - 記録の書き込みで改名が一時的に失敗したときのやり直し（ウイルス対策等が一瞬開く状況を決定的に起こせない。試験中に 1 回実際に起きた）');
console.log('  - 保存先の lstat の ENOENT 以外のエラー（権限など）を投げ直すこと（権限のエラーを試験で決定的に作れない。途中がファイルの場合は Windows では ENOENT になり、親の確認で止める＝Z72）');
console.log('  - verify-current の「済みの書庫が 0 件なら完了としない」（記録があって済みが 0・理由も 0 の状態は、apply の後には作れない）');
console.log('  - verify-current --rehash-archives が、記録をロックの後に読むこと（ロック待ちの間に別の実行が記録を変える状況を決定的に作れない）');
console.log('多重の防御（片方だけ外しても別の防御が先に止めるため、単独では差が出ない。外すときは also で一緒に外す）:');
console.log('  - 書庫の CRC と、展開した中身の SHA-256（Z03 で両方を外す。片方だけを外しても、もう片方が止める）');
console.log('  - 宛先が既にあるかの確認と、ハードリンクによる上書きしない確定（Z04 で両方を外す）');
console.log('  - 7z t・エントリが 1 件か・読めた量がサイズと同じか（壊れた書庫・2 エントリ・読み足りないものは、展開した中身の SHA-256 でも止まる）');
console.log('  - 7z a の終了コード 1（読めないファイルを飛ばした警告）を失敗とすること（中身 0 件の書庫は、エントリの数と SHA-256 でも止まる）');
console.log('  - 再開のときの宛先の書庫の照合（ファイル全体の SHA-256 と、展開した中身の検証。Z17 で両方を外す）');
console.log('  - 元の読み込み中の中断の確認（外しても、続いて起動する 7z が監視の最初の回で止められ、中断として巻き戻る）');
console.log('  - 元の照合の間の中断（ハッシュの計算の中・照合の直後・attrib の直前の 3 か所。Z42 で 3 か所を外す）');
console.log('  - 確定の後の中断（確定済みの段に入る前の確認と、状態の記録の確認。Z41 で両方を外す）');
console.log('  - 中断で止まった 7z の終わり（7z a の終わりの確認と、状態の記録の確認。Z39 で両方を外す）');
console.log('  - 7z が書き終えた後の中断（要所の確認・7z e の終わり・ハッシュの計算の中。Z40 ですべて外す）');
console.log('  - 中断のときの 7z の止め直し（監視・中断の受け手・後始末の待ちの 3 か所。Z38 で 3 か所を外す）');
console.log('OneDrive の実機でしか差が出ないもの:');
console.log('  - 実行の直前の状態（クラウドのみかどうか）を最初の状態として記録すること（計画と実行の間に OneDrive が取得・解放したときにだけ差が出る）');
console.log('  - 元が実際にクラウドのみに戻ったことの確認（OneDrive の外のファイルはクラウドのみにならない。[A30] は「待ち」になることを見る）');
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(by('CAUGHT').length === rows.length ? 0 : 1);
