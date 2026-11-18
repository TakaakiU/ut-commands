// /ut-reportdeck の部品（commands/templates/ut-reportdeck.mjs）と表示検査（tools/ut-reportdeck-check.mjs）の防御を 1 つずつ壊し、
// それぞれの --selftest が「その防御を見る試験」で落ちるかを確かめる。「selftest が全件パス」を検証済みの根拠にしないため。
//   node tools/ut-reportdeck-sweep.mjs            （repo ルートで実行する）
//   UT_SWEEP_ONLY=R1,C2 node tools/ut-reportdeck-sweep.mjs   一部だけ（全件の判定ではない）
// exit: 0 全件 CAUGHT / 1 それ以外
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  deck: path.join(ROOT, 'commands', 'templates', 'ut-reportdeck.mjs'),
  check: path.join(ROOT, 'tools', 'ut-reportdeck-check.mjs'),
};
const TEMPLATE = path.join(ROOT, 'commands', 'templates', 'ut-reportdeck-template.html');
const SRC = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-reportdeck-sweep-'));

// [ID, 対象, 内容, 差し込み位置, 置き換え, その防御を見ている試験]
const mutations = [
  ['R1', 'deck', '縦軸を 0 から始めない', 'for (let v = 0; v <= ymax', 'for (let v = step; v <= ymax', '[R01]'],
  ['R3', 'deck', '平均線を期間でなく全幅に引く', 'const x1 = ML + (PW / n) * a.from, x2 = ML + (PW / n) * a.to', 'const x1 = ML, x2 = W - MR', '[R03]'],
  ['R4', 'deck', '途中の棒を薄くしない', "const partial = f.partialLast && i === n - 1 ? ' partial' : '';", "const partial = '';", '[R03]'],
  ['R5', 'deck', '予定を点線で描かない', 'if (cut < n) s += ', 'if (false) s += ', '[R04]'],
  ['R6', 'deck', '構造図で確度の線種を付けない', 'class="node ${n.state}"', 'class="node"', '[R05]'],
  ['R7', 'deck', '矢印を箱の縁で切らない', 'const [x1, y1] = clip(at[a], at[b]), [x2, y2] = clip(at[b], at[a]);', 'const [x1, y1] = [at[a].x + bw / 2, at[a].y + bh / 2], [x2, y2] = [at[b].x + bw / 2, at[b].y + bh / 2];', '[R05]'],
  ['R8', 'deck', '図が答える問いを出さない', '<p class="q">この図が答える問い: ${esc(f.question)}</p>', '', '[R06]'],
  ['R9', 'deck', '図の表（数値で見る）を出さない', '${legend(f)}${figureTable(f)}', '${legend(f)}', '[R06]'],
  ['R10', 'deck', '未知の図の種別を通す', "need(FIGURE_TYPES.includes(f.type), '未知の図の種別 '", "need(true, '未知の図の種別 '", '[R07]'],
  ['R11', 'deck', '図の問いの欠けを通す', "need(isStr(f.question), 'question", "need(true, 'question", '[R07]'],
  ['R12', 'deck', '図の出典の欠けを通す', "need(isStr(f.source), 'source（数字の出典）", "need(true, 'source（数字の出典）", '[R07]'],
  ['R13', 'deck', '根拠のラベルの誤りを通す', 'labels.every((l) => Object.hasOwn(LABELS, l))', 'true', '[R07]'],
  ['R14', 'deck', '「言えないこと」の章の欠けを通す', "need(d.slides.some((s) => s && s.role === 'limits'),", 'need(true,', '[R07]'],
  ['R15', 'deck', '負の値を通す', 'arr.every((v) => isNum(v) && v >= 0)', 'arr.every((v) => isNum(v))', '[R08]'],
  ['R16', 'deck', 'labels と values の数の違いを通す', "f.labels.length === f.values.length, 'labels と values", "true, 'labels と values", '[R08]'],
  ['R17', 'deck', '構造図の id の重複を通す', 'if (ids.has(n.id)) errs.push(', 'if (false) errs.push(', '[R08]'],
  ['R18', 'deck', '書き方の誤ったトークンを通す', "if (out.includes('[[') || out.includes(']]')) throw", 'if (false) throw', '[R09]'],
  ['R19', 'deck', 'マスク版でも実名に展開する', "(variant === 'real' ? real : mask)", "(variant === 'real' ? real : real)", '[R09]'],
  ['R20', 'deck', 'ページ内の参照（#）を外部と誤る href の判定', "/\\shref\\s*=\\s*(?![\"']?#)/i", "/\\shref\\s*=\\s*[\"']?(?!#)/i", '[R10]'],
  ['R21', 'deck', '外部参照の陽性対照で止めない', "if (broken.length) throw new CheckError('外部参照の検出が働かない", "if (false) throw new CheckError('外部参照の検出が働かない", '[R21]'],
  ['R22', 'deck', 'src の検出が働かない（陽性対照が build を止める）', '/\\ssrc\\s*=/i', '/\\ssrcNEVER=/i', '[R14]'],
  ['R23', 'deck', '@import の形を検出から外す', "  ['@import', /@import\\b/i, '@import \"a.css\";'],", '', '[R17]'],
  ["R24", 'deck', "全角半角の揺れを除かない", "String(s).normalize('NFKC').toLowerCase()", "String(s).toLowerCase()", "[R11]"],
  ["R25", 'deck', "空白の揺れを除かない", ".replace(/[\\s\\u3000]+/g, '')", "", "[R11]"],
  ['R26', 'deck', 'エンティティを戻さずに照合する（そのままの形・タグを除いた形の両方）', "[normWord(unesc(html)), normWord(unesc(String(html).replace(/<[^>]*>/g, ''))),", "[normWord(html), normWord(String(html).replace(/<[^>]*>/g, '')),", '[R11]'],
  ['R27', 'deck', '出力のファイル名を照合しない', '...names.map(normWord)', '', '[R11]'],
  ['R28', 'deck', 'マスク漏れの陽性対照で止めない', "if (broken.length) throw new CheckError('マスク漏れの検出が働かない", "if (false) throw new CheckError('マスク漏れの検出が働かない", '[R22]'],
  ['R29', 'deck', 'viewport の欠けを通す', 'if (!/<meta\\s+name="viewport"/i.test(html)) p.push', 'if (false) p.push', '[R12]'],
  ['R30', 'deck', 'SVG の固定幅を見ない', "if (Number(m[1]) > 390) p.push('SVG", "if (false) p.push('SVG", '[R12]'],
  ["R31", 'deck', "数字の一覧に構造図の座標を含める", "new Set(['x', 'y', 'from'", "new Set(['from'", "[R13]"],
  ['R32', 'deck', '既定で実名版も作る', "variants = 'masked', maskWordsFile", "variants = 'both', maskWordsFile", '[R14]'],
  ['R33', 'deck', '伏せる語の一覧なしでマスク版を作る', 'if (wantMasked && !maskWordsFile && !maskWordsNone) throw', 'if (false) throw', '[R14]'],
  ['R34', 'deck', 'マスク版に残った語で止めない', "if (leaks.length) throw new CheckError('マスク版に伏せる語", "if (false) throw new CheckError('マスク版に伏せる語", '[R15]'],
  ['R35', 'deck', 'テンプレートの外部参照で止めない', 'if (tplRefs.length) throw', 'if (false) throw', '[R17]'],
  ['R36', 'deck', '形の誤りで止めない', "if (errs.length) throw new CheckError('deck.json の形の誤り", "if (false) throw new CheckError('deck.json の形の誤り", '[R17]'],
  ['R37', 'deck', '出力の外部参照で止めない', 'if (refs.length) throw new CheckError(`外部参照がある', 'if (false) throw new CheckError(`外部参照がある', '[R18]'],
  ['R38', 'deck', '表示の静的な検査で止めない', 'if (layout.length) throw', 'if (false) throw', '[R23]'],
  ['R39', 'deck', '検査で止めたときも exit 2 にする', 'return e instanceof CheckError ? 1 : 2;', 'return 2;', '[R19]'],
  ['R40', 'deck', '空の語の一覧を通す', "if (!words.length) throw new InputError('伏せる語の一覧が空", "if (false) throw new InputError('伏せる語の一覧が空", '[R20]'],
  ['R41', 'deck', '--mask-words と --mask-words-none の両方を通す', 'if (maskWordsFile && maskWordsNone) throw', 'if (false) throw', '[R20]'],
  ["R42", 'deck', "数字の件数を 0 と書く", "JSON.stringify({ count: numbers.length", "JSON.stringify({ count: 0", "[R16]"],
  ['R43', 'deck', '矢印の既定を確認済み（実線）にする', "for (const [a, b, st = 'no'] of f.edges || [])", "for (const [a, b, st = 'ok'] of f.edges || [])", '[R05]'],
  ['R44', 'deck', '表紙の読み方に使っていないラベルも並べる', '.filter(([k]) => used.has(k))', '', '[R24]'],
  ['R45', 'deck', '数字を 1 桁に丸めて表示する', "return n.toLocaleString('en-US', { maximumFractionDigits: 20 });", "return n.toLocaleString('en-US', { maximumFractionDigits: 1 });", '[R02]'],
  ['R46', 'deck', '数字の一覧に図の題・構造図の文字を入れない', "walk(`${where}.${k}`, x, inFigure || k === 'figure');", "if (!['title', 'text'].includes(k)) walk(`${where}.${k}`, x, inFigure || k === 'figure');", '[R25]'],
  ['R47', 'deck', '全角の数字を拾わない', "[...String(s).normalize('NFKC').matchAll(NUM_RE)]", '[...String(s).matchAll(NUM_RE)]', '[R25]'],
  ["R48", 'deck', "数字の一覧の網羅で止めない", "if (miss.length) throw new CheckError(`数字の一覧から漏れた", "if (false) throw new CheckError(`数字の一覧から漏れた", "[R32]"],
  ['R49', 'deck', '網羅の照合で目盛りを除かない', ".replace(/<text class=\"tick\"[^>]*>[^<]*<\\/text>/g, '')", '', '[R25]'],
  ['R50', 'deck', '本文の要素の中身を見ない', '  const v = b[keys[0]];', '  return; const v = b[keys[0]];', '[R26]'],
  ['R51', 'deck', '軸のラベルの文字数を見ない', 'arr.every((l) => isStr(l) && len(l) <= MAX_LEN.axisLabel)', 'arr.every((l) => isStr(l))', '[R26]'],
  ['R52', 'deck', '形の検査の陽性対照で止めない', "if (miss.length) throw new CheckError('形の検査が働かない", "if (false) throw new CheckError('形の検査が働かない", '[R26]'],
  ['R53', 'deck', 'ゼロ幅の文字を除かない', ".replace(/\\p{Cf}/gu, '')", '', '[R27]'],
  ['R55', 'deck', 'UNC の形を検出から外す', "  ['UNC', /\\\\\\\\[a-z0-9_.$-]+\\\\/i, '\\\\\\\\server\\\\share'],", '', '[R28]'],
  ['R56', 'deck', '<style> の中の固定幅を見ない', "for (const st of html.matchAll(/<style\\b[^>]*>([\\s\\S]*?)<\\/style>/gi)) {", 'for (const st of []) {', '[R29]'],
  ['R57', 'deck', '表示の静的な検査の陽性対照で止めない', "if (broken.length) throw new CheckError('表示の静的な検査が働かない", "if (false) throw new CheckError('表示の静的な検査が働かない", '[R29]'],
  ['R58', 'deck', '出力先の中の構成を受け付ける', "if (inside(deckFile, outDir)) throw", 'if (false) throw', '[R30]'],
  ['R59', 'deck', '今回作らない古い実名版が残っていても作る', "if (!made.includes(v) && fs.existsSync(path.join(outDir, `${name}.${v}.html`))) throw", 'if (false) throw', '[R30]'],
  ['R61', 'deck', '数字の一覧の網羅の陽性対照で止めない', "if (!check('<p>件数は 30 件、比は 2 倍</p>', [{ value: '30' }]).includes('2')) throw", 'if (false) throw', '[R25]'],
  ['R62', 'deck', 'planFrom の範囲を見ない', 'f.planFrom >= 1 && f.planFrom < (f.labels || []).length', 'true', '[R08]'],
  ['R63', 'deck', '構造図の x の範囲を見ない', 'n.x >= 0 && n.x <= 540', 'n.x >= 0', '[R08]'],
  ['R64', 'deck', 'deck・ページの知らないキーを通す', "for (const k of extraKeys(s, KEYS.slide)) errs.push(", 'for (const k of []) errs.push(', '[R34]'],
  ['R65', 'deck', '構造図の辺の id を数字の一覧に入れる', "'id', 'edges', 'kind'", "'id', 'kind'", '[R34]'],
  ['R66', 'deck', '出力先の中の判定で実体のパスにしない', 'try { cur = fs.realpathSync.native(cur); } catch', 'try { cur = cur; } catch', '[R35]'],
  ['R67', 'deck', '「..x」という名前を外と判定する', "r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)", "r.startsWith('..') || path.isAbsolute(r)", '[R35]'],
  ['R68', 'deck', '前の実行の残りがあっても作る', 'if (leftovers.length) throw', 'if (false) throw', '[R36]'],
  ['R69', 'deck', '別の名前の実名版を報告しない', 'if (otherReal.length) report.push(', 'if (false) report.push(', '[R36]'],
  ['R70', 'deck', '.wide と並んだ規則も除く', "if (sel.split(',').every((x) => /^\\.(wide|tw)(?![\\w-])/.test(x.trim()))) continue;", 'if (/^\\.(wide|tw)/.test(sel)) continue;', '[R29]'],
  ['R71', 'deck', 'タイルなどの label を数字の一覧に入れない', "'kind', 'role', 'partialLast']);", "'kind', 'role', 'label', 'partialLast']);", '[R37]'],
  ['R72', 'deck', 'タグを除いて続けた形で照合しない', ", normWord(unesc(String(html).replace(/<[^>]*>/g, '')))", '', '[R38]'],
  ['R73', 'deck', '16 進の文字参照を戻さない', ".replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))", '', '[R38]'],
  ['R74', 'deck', '安全な範囲を超える整数を通す', '(!Number.isInteger(x) || Number.isSafeInteger(x))', 'true', '[R39]'],
  ['R75', 'deck', '文字列の partialLast を通す', "need(typeof f.partialLast === 'boolean'", 'need(true', '[R39]'],
  ['R76', 'deck', '2 本並びの系列名の長さを見ない', 'f.names.every((x) => isStr(x) && len(x) <= MAX_LEN.seriesName)', 'f.names.every(isStr)', '[R39]'],
  ['R77', 'deck', '正式な名前にする途中の失敗で前の出力を戻さない', 'for (const [b, dst] of backups) { try { fsx.renameSync(b, dst); }', 'for (const [b, dst] of []) { try { fsx.renameSync(b, dst); }', '[R40]'],
  ['R78', 'deck', '前の出力の退避を消せなくても成功にする', "if (stuck.length) { const e = new CheckError(", "if (false) { const e = new CheckError(", '[R41]'],
  ['R79', 'deck', 'inline-size の固定幅を見ない', '(?:width|inline-size)', '(?:width)', '[R29]'],
  ['R80', 'deck', '年表の凡例に「確認済み」の語を出す（structure の凡例と同じ語）', '<span><span class="sw line"></span>実線の枠＝済み</span>', '<span><span class="sw line"></span>確認済み</span>', '[R44]'],
  ['R81', 'deck', '年表の凡例に structure の凡例も出す', "if (f.type === 'structure') {\n    // 凡例には", "if (f.type === 'structure' || f.type === 'timeline') {\n    // 凡例には", '[R44]'],
  ['R82', 'deck', '年表の予定も実線（済み）の枠で描く', 'class="ev ${ev.state}"', 'class="ev done"', '[R43]'],
  ['R83', 'deck', '年表の矢印のツールチップを「（確認済み）」にする', '（日付の順）</title></path>', '（確認済み）</title></path>', '[R43]'],
  ['R84', 'deck', '年表の矢印を引かない', 'if (i + 1 < f.events.length) s +=', 'if (false) s +=', '[R43]'],
  ['R85', 'deck', '年表の表の列名を「確度」に戻す', "head = ['日付', '出来事', '状態']", "head = ['日付', '出来事', '確度']", '[R45]'],
  ['R86', 'deck', '年表を structure の表で出す（timeline の分岐を外す）', "else if (f.type === 'timeline') { head", 'else if (false) { head', '[R45]'],
  ['R87', 'deck', '年表の state の値を見ない', "need(['done', 'plan'].includes(ev.state)", 'need(true', '[R46]'],
  ['R88', 'deck', '年表の件数の上限（12）を外す', 'f.events.length >= 2 && f.events.length <= 12', 'f.events.length >= 2', '[R46]'],
  ['R89', 'deck', '年表の件数の下限（2）を外す', 'f.events.length >= 2 && f.events.length <= 12', 'f.events.length <= 12', '[R46]'],
  ['R90', 'deck', '年表の date の空を通す', 'isStr(ev.date) && len(ev.date)', 'len(ev.date)', '[R46]'],
  ['R91', 'deck', '年表の text の行数を見ない', "String(ev.text).split('\\n').length <= 2 && ", '', '[R46]'],
  ['R92', 'deck', '年表の events の要素の知らないキーを通す', "'groups', 'nodes', 'events']) if (arrOf(f[k]))", "'groups', 'nodes']) if (arrOf(f[k]))", '[R46]'],
  ['R93', 'deck', '年表の許可キーに events を入れない', "timeline: ['events'] },", 'timeline: [] },', '[R46]'],
  ['R94', 'deck', '年表の date を数字の一覧に入れない', "'kind', 'role', 'partialLast']);", "'kind', 'role', 'date', 'partialLast']);", '[R47]'],
  ['R95', 'deck', '年表の viewBox の幅を 720 に戻す', "'chart tl', TL_W)", "'chart tl', W)", '[R43]'],
  ['R96', 'deck', '年表の svg から class tl を外す', "'chart tl', TL_W)", "'chart', TL_W)", '[R43]'],
  ['R97', 'deck', '年表の出来事の 1 行の上限を 12 に戻す', 'len(l) <= MAX_LEN.eventLine', 'len(l) <= MAX_LEN.nodeLine', '[R46]'],
  ['R98', 'deck', '年表の枠が viewBox の幅を超える', 'bx = 128, bw = 322', 'bx = 128, bw = 422', '[R43]'],
  ['R99', 'deck', '年表以外の図の既定の器に class tl を付ける', "cls = 'chart', w = W)", "cls = 'chart tl', w = W)", '[R43]'],
  ['R100', 'deck', '長い日付を日付の列に収めない', 'c.charCodeAt(0) < 256 ? 7.5 : 13), 0) > 112', 'c.charCodeAt(0) < 256 ? 7.5 : 13), 0) > 112 && false', '[R43]'],
  ['R101', 'deck', '年表の date の長さの上限を外す', 'isStr(ev.date) && len(ev.date) <= MAX_LEN.nodeLine', 'isStr(ev.date)', '[R46]'],
  ['R102', 'deck', '短い日付も textLength で引き伸ばす', 'c.charCodeAt(0) < 256 ? 7.5 : 13), 0) > 112', 'c.charCodeAt(0) < 256 ? 7.5 : 13), 0) > -1', '[R43]'],
  ["R103", 'deck', "資料の型の欠け・誤りを通す", "need(Object.hasOwn(DECK_TYPES, d.type),", "need(true,", "[R48]"],
  ["R104", 'deck', "1 ページ目が結論の章でなくても通す", "need(d.slides[0] && d.slides[0].role === 'conclusion',", "need(true,", "[R48]"],
  ["R105", 'deck', "型ごとの必須の章（比較・確認したいこと・次の調査）を見ない", "for (const r of type.need) need(", "for (const r of []) need(", "[R48]"],
  ["R106", 'deck', "障害の型の 1 ページ目の 3 点を見ない", "need(three, ", "need(true, ", "[R48]"],
  ["R107", 'deck', "障害の型の時系列（timeline）を見ない", "need(d.slides.some((s) => s && s.figure && s.figure.type === 'timeline'),", "need(true,", "[R48]"],
  ["R108", 'deck', "読本の 1 ページ目の全体像の図を見ない", "need(!!first.figure,", "need(true,", "[R48]"],
  ["R109", 'deck', "読本の用語表を見ない", "need(d.slides.some((s) => s && (s.body || []).some((b) => b && b.terms)),", "need(true,", "[R48]"],
  ["R110", 'deck', "読本の章のゴールの件数を見ない", "need(arrOf(s.goal) && s.goal.length >= 2 && s.goal.length <= 4,", "need(true,", "[R48]"],
  ["R111", 'deck', "読本の確認の問いの欠けを通す", "need(arrOf(s.checks) && s.checks.length >= 1,", "need(true,", "[R48]"],
  ["R112", 'deck', "未知の role を通す", "need(s.role === undefined || ROLES.includes(s.role),", "need(true,", "[R48]"],
  ["R113", 'deck', "確認の問いの答えの欠けを通す", "s.checks.every((c) => c && isStr(c.q) && isStr(c.a)", "s.checks.every((c) => c", "[R48]"],
  ["R114", 'deck', "用語表の意味の欠け・単位の型を見ない", "v.every((t) => t && isStr(t.word) && isStr(t.means) && (t.unit === undefined || typeof t.unit === 'string')", "v.every((t) => t", "[R48]"],
  ["R115", 'deck', "表紙に資料の型を出さない", "(ty ? `<p class=\"doctype\">", "(false ? `<p class=\"doctype\">", "[R49]"],
  ["R116", 'deck', "確認の問いの答えを折りたたまない", "<details><summary>${esc(c.q)}</summary><p>${esc(c.a)}</p></details>", "<p>${esc(c.q)}</p><p>${esc(c.a)}</p>", "[R49]"],
  ["R117", 'deck', "章のゴールを出さない", "${s.goal ? `<div class=\"goal\">", "${false ? `<div class=\"goal\">", "[R49]"],
  ["R118", 'deck', "結論の章の印を付けない", "${s.role === 'conclusion' ? ' conclusion' : ''}", "", "[R49]"],
  ["R119", 'deck', "用語表に「1 行が指すもの」の列を出さない", "<th>1 行が指すもの</th>", "", "[R49]"],
  ["R120", 'deck', 'カードが 3 件でも 3 列の印を付けない', "b.cards.length === 3 ? ' n3' : ''", "''", "[R50]"],
  ["R121", 'deck', '構造図の凡例に使っていない線種も並べる', "if (used.has(st)) items.push(", "if (true) items.push(", "[R51]"],
  ['C8', 'check', '検査しなかった表示を問題にしない', "for (const v of VIEWS) if (!views.some((x) => x.name === v.name)) p.push(", 'for (const v of []) if (!views.some((x) => x.name === v.name)) p.push(', '[C07]'],
  ['C7', 'check', 'ページが 0 枚でも問題にしない', 'if (!(v.slides > 0)) p.push(', 'if (false) p.push(', '[C06]'],
  ['C1', 'check', 'エラーを問題にしない', 'for (const e of v.errors) p.push(', 'for (const e of []) p.push(', '[C02]'],
  ['C2', 'check', '外部通信を問題にしない', 'for (const u of v.external) p.push(', 'for (const u of []) p.push(', '[C02]'],
  ['C3', 'check', 'ページのはみ出しを問題にしない', 'if (v.pageOverflow) p.push(', 'if (false) p.push(', '[C02]'],
  ['C4', 'check', '明暗が切り替わらなくても通す', 'if (light && d.background === light.background) p.push(', 'if (false) p.push(', '[C03]'],
  ['C5', 'check', 'Playwright が無いときに通過（exit 0）にする', '導入は利用者が決める）\'); return 2; }', '導入は利用者が決める）\'); return 0; }', '[C04]'],
  ['C6', 'check', 'Playwright を道具の場所から探す', "const req = createRequire(path.join(path.resolve(dir), 'noop.js'));", 'const req = createRequire(SELF);', '[C05]'],
];

{ const ids = mutations.map((m) => m[0]); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }
const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',')) : null;
if (only) {
  console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
  const unknown = [...only].filter((id) => !mutations.some((m) => m[0] === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
}

function runSelftest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, '--selftest'], { cwd: path.dirname(file) });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill(), 300000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
async function runMutant([id, target, desc, find, to, expect]) {
  const hits = SRC[target].split(find).length - 1;
  if (hits !== 1) return { id, desc, verdict: 'INVALID', detail: `差し込み位置の一致 ${hits} 件` };
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir);
  // 変異版の横にテンプレートを置く（部品は自分の場所からテンプレートを読む）
  fs.copyFileSync(TEMPLATE, path.join(dir, path.basename(TEMPLATE)));
  const f = path.join(dir, path.basename(FILES[target]));
  fs.writeFileSync(f, SRC[target].replace(find, () => to));
  const { code, out } = await runSelftest(f);
  const ng = out.split(NL).filter((l) => l.trimStart().startsWith('NG'));
  const hit = ng.some((l) => l.trimStart().startsWith('NG  ' + expect + ' '));
  const verdict = hit ? 'CAUGHT' : ng.length ? 'OTHER' : code !== 0 ? 'CRASHED' : 'MISSED';
  return { id, desc, verdict, expect, detail: `NG ${ng.length} 件`, ngNames: ng.map((l) => l.trim().slice(4).split(' | ')[0]) };
}

// 基準実行: 変異を入れない版がすべて通ること（通らなければ掃引の結果を信用しない）
for (const [k, f] of Object.entries(FILES)) {
  const { code, out } = await runSelftest(f);
  if (code !== 0) { console.log(`基準実行で失敗（${k}）: ` + out.split(NL).filter((l) => /NG|selftest:/.test(l)).join(' / ')); process.exit(1); }
  console.log(`基準実行（${k}）: ` + (out.split(NL).find((l) => l.startsWith('selftest:')) || ''));
}
const queue = mutations.filter((m) => !only || only.has(m[0]));
const rows = [];
const jobs = Math.max(1, Math.min(Number(process.env.UT_SWEEP_JOBS) || 6, os.cpus().length));
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) rows.push(await runMutant(queue.shift())); }));
fs.rmSync(tmp, { recursive: true, force: true });
const order = mutations.map((m) => m[0]);
rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
console.log('== ut-reportdeck ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log(`  ${r.id.padEnd(4)}${r.verdict.padEnd(8)}${r.desc}  -> ${r.detail}`);
  if (r.verdict !== 'CAUGHT') for (const n of (r.ngNames || [])) console.log(`          落ちた: ${n}（期待: ${r.expect}）`);
}
const caught = rows.filter((r) => r.verdict === 'CAUGHT').length;
console.log(`${NL}検出 ${caught} / ${rows.length}`);
console.log('対象外: 書いた後の読み直しの照合と、正式な名前にする途中で失敗したときの戻し（ファイルシステムの失敗でしか差が出ず、決定的に起こせない。一時の名前で書くことは [R31] で、置き換えは [R33] で見る）');
console.log('対象外: 表示検査のブラウザでの部分（外部通信の陽性対照・はみ出しの測定・スクリーンショット）。Playwright が無い環境では動かせない。判定の部分（judge）は C1〜C4 で見る');
process.exit(caught === rows.length ? 0 : 1);
