#!/usr/bin/env node
// /ut-reportdeck の生成部品。正本（一次報告）から作った構成（deck.json）を、プレゼン用の資料（縦に読む 1 ファイルの HTML）にする。依存なし。
//
//   node ut-reportdeck.mjs build <deck.json> <出力先フォルダ> (--mask-words <語の一覧> | --mask-words-none) [--variants masked|real|both] [--name <基本名>]
//   器（テンプレート）は同じフォルダの ut-reportdeck-template.html に固定する（差し替えた器の CSS の書き方次第で外部参照・固定幅の検査をすり抜けうるため）
//   node ut-reportdeck.mjs --selftest
//
// 既定はマスク版だけを作る（実名版は --variants real|both を明示したときだけ）。
// 書き出す前に、毎回次を検査し、1 つでも外れたら何も書かずに終える（exit 1）。どの検査も、実行のたびに、
// わざと問題を入れた見本で検出できることを確かめてから使う（陽性対照）:
//   - deck.json の形（未知の図の種別、根拠ラベル・図の問い・出典の欠け、「言えないこと」の章の欠け、本文の要素の中身、文字数の上限）
//   - 外部参照（URL・UNC・mailto・src・href・url()・@import・script・link・iframe・img など）が 0
//   - マスク版に「伏せる語」が残っていない（本文・属性・SVG の title・表・出力のファイル名。全角半角・空白・ゼロ幅の文字・ダッシュの揺れも同じ語とみなす）
//   - 表示の静的な検査（viewport の指定、390px を超える固定幅が無い。属性・style 属性・<style> の中を見る）
//   - 数字の一覧の網羅（資料に見えている数字が、すべて <基本名>.numbers.json に入っていること。目盛りとページ番号は除く）
// 書き出しは、すべて一時の名前で書いて読み直しの照合が通ってから正式な名前にする。正式な名前にする途中で失敗したら前の出力に戻す。
// 例外: 新しい出力に置き換えた後で、前の出力の退避（*.tmp-xxxxxxxx.prev）を消せなかったときは、新しい出力と退避が残る。
// このときは「一部のファイルが残っている」として exit 1 で止め、残ったファイルを示す（次の実行も、退避が残っている間は止まる）。
// exit: 0 成功 / 1 検査で止めた（上の例外を除き、何も書いていない） / 2 使い方・入力の誤り
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const DEFAULT_TEMPLATE = path.join(HERE, 'ut-reportdeck-template.html');

export class InputError extends Error {}
export class CheckError extends Error {}

// ---------------------------------------------------------------- 文字列
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
// 数字の表示。3 桁区切りを付けるだけで、丸めない（正本の値と照合するため。桁を変えたいなら正本の値の側で決める）
export function fmt(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 20 });
}
// 縦軸の上限と目盛り。縦軸は必ず 0 から始める
export function niceScale(max) {
  if (!(max > 0)) return { ymax: 1, ticks: [0, 1] };
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const ymax = step * Math.ceil(max / step);
  const ticks = [];
  for (let v = 0; v <= ymax + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ymax, ticks };
}

// ---------------------------------------------------------------- 実名とマスクのトークン
// [[実名|マスク表記]]。マスク表記は空でもよい（その部分が消える）。文の単位で置く（語の単位で置くと文が崩れる。ガイドの「マスクの書き方」）
const TOKEN_RE = /\[\[([^[\]|]*)\|([^[\]]*)\]\]/g;
export function expandTokens(s, variant) {
  const out = String(s).replace(TOKEN_RE, (_, real, mask) => (variant === 'real' ? real : mask));
  if (out.includes('[[') || out.includes(']]')) throw new InputError('トークンの書き方の誤り（[[実名|マスク表記]] の形になっていない）: ' + String(s).slice(0, 60));
  return out;
}
function mapStrings(v, f) {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

// ---------------------------------------------------------------- 構成（deck.json）の形
export const LABELS = { fact: '事実（数値）', view: '関係者の認識', hyp: '仮説', prop: '提案', ai: 'AI 分析のたたき台' };
// 資料の型（読み手が読んだ後にできることで決める）。どの型にも「結論の章」（1 ページ目）と「言えないこと」の章が要る
export const DECK_TYPES = {
  decision: { name: '決裁・提案', can: '採るか採らないかを決める', need: ['compare', 'decide'] },
  incident: { name: '障害・不具合', can: '何が起き、なぜで、何をするかを言う', need: [] },
  investigation: { name: '調査報告', can: '何が分かり、何が分からないかを言う', need: ['next'] },
  reader: { name: '読本・解説', can: '仕組みを説明でき、止まったとき調べられる', need: [] },
};
// 章の役割。conclusion=1 ページ目、compare=案の比較、decide=確認したいこと（決裁事項）、next=次の調査、limits=言えないこと、appendix=付録
export const ROLES = ['conclusion', 'compare', 'decide', 'next', 'limits', 'appendix'];
const FIGURE_TYPES = ['bar', 'line', 'step', 'hbar', 'pair', 'structure', 'timeline'];
const BLOCK_KEYS = ['p', 'list', 'tiles', 'cards', 'terms'];
// 整数は安全な範囲（2^53 未満）だけ。超えると JSON を読んだ時点で別の値になり、黙って違う数字を表示するため
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && (!Number.isInteger(x) || Number.isSafeInteger(x));
const isStr = (x) => typeof x === 'string' && x.trim() !== '';
// 図の中の文字の上限（これを超えると viewBox の外へ切れる・重なる）。全角で数える
const MAX_LEN = { axisLabel: 10, hbarLabel: 16, hbarNote: 8, nodeLine: 12, eventLine: 16, figTitle: 60, avgLabel: 12, noteText: 16, seriesName: 10 };
const len = (s) => [...String(s)].length;
const arrOf = (x) => Array.isArray(x);
// 決めたキーのほかは受け付けない（描かれない値が数字の一覧に入って照合が合わなくなる・書き間違いが黙って無視されるため）
const KEYS = {
  deck: ['title', 'type', 'eyebrow', 'lead', 'byline', 'slides'],
  slide: ['kicker', 'head', 'label', 'source', 'role', 'body', 'note', 'figure', 'goal', 'checks'],
  figure: { common: ['type', 'title', 'question', 'source', 'unit'], bar: ['labels', 'values', 'avg', 'partialLast'], line: ['labels', 'values', 'notes'], step: ['labels', 'series', 'planFrom'], hbar: ['rows'], pair: ['names', 'groups'], structure: ['nodes', 'edges'], timeline: ['events'] },
  avg: ['from', 'to', 'value', 'label'], notes: ['from', 'to', 'text'], series: ['name', 'values'], rows: ['label', 'value', 'note'], groups: ['label', 'a', 'b'], nodes: ['id', 'text', 'x', 'y', 'state'], events: ['date', 'text', 'state'],
  tiles: ['value', 'label'], cards: ['title', 'text', 'mark', 'kind'], terms: ['word', 'means', 'unit'], checks: ['q', 'a'],
};
const extraKeys = (o, allowed) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).filter((k) => !allowed.includes(k)) : []);
function validateBlock(b, at, need) {
  if (typeof b === 'string') { need(isStr(b), at + ' が空の文字列'); return; }
  const keys = b && typeof b === 'object' ? Object.keys(b) : [];
  if (!(keys.length === 1 && BLOCK_KEYS.includes(keys[0]))) { need(false, `${at} は文字列か {${BLOCK_KEYS.join('|')}: …} のどれか 1 つ`); return; }
  const v = b[keys[0]];
  if (keys[0] === 'p') need(isStr(v), at + '.p は空でない文字列');
  if (keys[0] === 'list') need(arrOf(v) && v.length > 0 && v.every(isStr), at + '.list は空でない文字列の配列');
  if (keys[0] === 'tiles') need(arrOf(v) && v.length > 0 && v.every((t) => t && isStr(t.value) && isStr(t.label) && !extraKeys(t, KEYS.tiles).length), at + '.tiles は {value, label}（どちらも文字列）の配列');
  if (keys[0] === 'terms') need(arrOf(v) && v.length > 0 && v.every((t) => t && isStr(t.word) && isStr(t.means) && (t.unit === undefined || typeof t.unit === 'string') && !extraKeys(t, KEYS.terms).length), at + '.terms は {word, means, unit?}（unit＝1 行が何を指すか）の配列');
  if (keys[0] === 'cards') need(arrOf(v) && v.length > 0 && v.every((c) => c && isStr(c.title) && (c.text === undefined || typeof c.text === 'string') && (c.mark === undefined || typeof c.mark === 'string') && (c.kind === undefined || ['good', 'bad', 'open'].includes(c.kind)) && !extraKeys(c, KEYS.cards).length), at + '.cards は {title, text?, mark?, kind?: good|bad|open} の配列');
}

export function validateDeck(d) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(d && typeof d === 'object', 'deck.json がオブジェクトではない');
  if (!d || typeof d !== 'object') return errs;
  need(isStr(d.title), 'title が無い');
  for (const k of ['eyebrow', 'lead', 'byline']) if (d[k] !== undefined) need(typeof d[k] === 'string', k + ' は文字列');
  for (const k of extraKeys(d, KEYS.deck)) errs.push('知らないキー: ' + k);
  need(Array.isArray(d.slides) && d.slides.length > 0, 'slides が無い（1 枚以上）');
  if (!Array.isArray(d.slides)) return errs;
  // 「言えないこと」（因果は未証明・代理指標・測れていないもの）の章を必ず置く
  need(d.slides.some((s) => s && s.role === 'limits'), '「言えないこと」の章（role: "limits"）が無い');
  // 型ごとの必須の節（型が決まらないと、読み手に合わない構成が検査を通る）
  const type = DECK_TYPES[d.type];
  need(Object.hasOwn(DECK_TYPES, d.type), 'type（資料の型）が無いか、決めた値（' + Object.keys(DECK_TYPES).join('・') + '）でない');
  need(d.slides[0] && d.slides[0].role === 'conclusion', '1 ページ目に role: "conclusion"（結論の章）が要る');
  if (type) {
    for (const r of type.need) need(d.slides.some((s) => s && s.role === r), `型「${type.name}」に必要な章（role: "${r}"）が無い`);
    const first = d.slides[0] || {};
    if (d.type === 'incident') {
      const three = (first.body || []).some((b) => b && ((b.cards && b.cards.length === 3) || (b.tiles && b.tiles.length === 3)));
      need(three, '障害・不具合の型: 1 ページ目に「事象・原因・対応」の 3 点（cards か tiles を 3 件）が要る');
      need(d.slides.some((s) => s && s.figure && s.figure.type === 'timeline'), '障害・不具合の型: 日付つきの時系列（timeline 型の図）が要る');
    }
    if (d.type === 'reader') {
      need(!!first.figure, '読本・解説の型: 1 ページ目に全体像の図が要る');
      need(d.slides.some((s) => s && (s.body || []).some((b) => b && b.terms)), '読本・解説の型: 用語表（terms）が要る');
      d.slides.forEach((s, i) => {
        if (!s || ['conclusion', 'limits', 'appendix'].includes(s.role)) return;
        need(arrOf(s.goal) && s.goal.length >= 2 && s.goal.length <= 4, `slides[${i}]: 読本・解説の型は章のゴール（goal: 2〜4 件）が要る`);
        need(arrOf(s.checks) && s.checks.length >= 1, `slides[${i}]: 読本・解説の型は確認の問い（checks: 1 件以上）が要る`);
      });
    }
  }
  d.slides.forEach((s, i) => {
    const at = `slides[${i}]`;
    if (!s || typeof s !== 'object') { errs.push(at + ' がオブジェクトではない'); return; }
    need(isStr(s.kicker), at + '.kicker（区分）が無い');
    need(isStr(s.head), at + '.head（言いたいことの 1 文）が無い');
    need(isStr(s.source), at + '.source（出典＝正本の章）が無い');
    const labels = Array.isArray(s.label) ? s.label : [s.label];
    need(labels.length > 0 && labels.every((l) => Object.hasOwn(LABELS, l)), at + '.label（根拠の強さ）が無いか、決めた値（' + Object.keys(LABELS).join('・') + '）でない');
    for (const [j, b] of (Array.isArray(s.body) ? s.body : []).entries()) validateBlock(b, `${at}.body[${j}]`, need);
    if (s.body !== undefined) need(Array.isArray(s.body), at + '.body は配列');
    if (s.note !== undefined) need(isStr(s.note), at + '.note は空でない文字列');
    need(s.role === undefined || ROLES.includes(s.role), at + '.role は決めた値（' + ROLES.join('・') + '）のどれか');
    if (s.goal !== undefined) need(arrOf(s.goal) && s.goal.length > 0 && s.goal.every(isStr), at + '.goal は空でない文字列の配列（「〜が言える」「〜が分かる」）');
    if (s.checks !== undefined) need(arrOf(s.checks) && s.checks.length > 0 && s.checks.every((c) => c && isStr(c.q) && isStr(c.a) && !extraKeys(c, KEYS.checks).length), at + '.checks は {q, a}（問いと答え）の配列');
    for (const k of extraKeys(s, KEYS.slide)) errs.push(at + ': 知らないキー: ' + k);
    if (s.figure !== undefined) errs.push(...validateFigure(s.figure, at + '.figure'));
  });
  return errs;
}
function validateFigure(f, at) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(at + ': ' + msg); };
  if (!f || typeof f !== 'object') return [at + ' がオブジェクトではない'];
  need(FIGURE_TYPES.includes(f.type), '未知の図の種別 ' + JSON.stringify(f.type) + '（' + FIGURE_TYPES.join('・') + '）');
  // 図の採否の基準: この図が答える問いと、数字の出典の両方が書けない図は入れない
  need(isStr(f.question), 'question（この図が答える問い）が無い');
  need(isStr(f.source), 'source（数字の出典）が無い');
  need(isStr(f.title) && len(f.title) <= MAX_LEN.figTitle, `title（図の題。読み上げに使う）が無いか、${MAX_LEN.figTitle} 文字を超える`);
  if (f.unit !== undefined) need(typeof f.unit === 'string', 'unit は文字列');
  if (FIGURE_TYPES.includes(f.type)) for (const k of extraKeys(f, [...KEYS.figure.common, ...KEYS.figure[f.type]])) errs.push(at + ': この図の種別で使わないキー: ' + k);
  for (const k of ['avg', 'notes', 'series', 'rows', 'groups', 'nodes', 'events']) if (arrOf(f[k])) f[k].forEach((o, i) => { for (const x of extraKeys(o, KEYS[k])) errs.push(`${at}.${k}[${i}]: 知らないキー: ${x}`); });
  if (arrOf(f.avg)) for (const a of f.avg) need(!a || !isStr(a.label) || len(a.label) <= MAX_LEN.avgLabel, `avg の label は ${MAX_LEN.avgLabel} 文字まで`);
  if (arrOf(f.notes)) for (const n of f.notes) need(!n || !isStr(n.text) || len(n.text) <= MAX_LEN.noteText, `notes の text は ${MAX_LEN.noteText} 文字まで`);
  if (arrOf(f.series)) for (const s of f.series) need(!s || !isStr(s.name) || len(s.name) <= MAX_LEN.seriesName, `series の name は ${MAX_LEN.seriesName} 文字まで`);
  const nonneg = (arr, what) => need(Array.isArray(arr) && arr.length > 0 && arr.every((v) => isNum(v) && v >= 0), what + ' は 0 以上の数の配列（縦軸は 0 から始めるため負の値は扱わない）');
  if (f.partialLast !== undefined) need(typeof f.partialLast === 'boolean', 'partialLast は true か false（"false" のような文字列は「途中」と表示されてしまう）');
  const axisLabels = (arr) => need(arrOf(arr) && arr.every((l) => isStr(l) && len(l) <= MAX_LEN.axisLabel), `labels は ${MAX_LEN.axisLabel} 文字までの文字列`);
  for (const k of ['avg', 'notes', 'edges', 'rows', 'groups', 'nodes', 'series', 'events']) if (f[k] !== undefined) need(arrOf(f[k]), k + ' は配列');
  if (['bar', 'line'].includes(f.type)) {
    need(Array.isArray(f.labels) && f.labels.length > 0, 'labels が無い');
    axisLabels(f.labels);
    nonneg(f.values, 'values');
    need(!Array.isArray(f.labels) || !Array.isArray(f.values) || f.labels.length === f.values.length, 'labels と values の数が違う');
    for (const a of arrOf(f.avg) ? f.avg : []) need(a && Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 0 && a.from < a.to && a.to <= (f.values || []).length && isNum(a.value) && a.value >= 0 && isStr(a.label), 'avg は {from, to（含まない）, value（0 以上）, label}');
    for (const n of arrOf(f.notes) ? f.notes : []) need(n && Number.isInteger(n.from) && Number.isInteger(n.to) && n.from >= 0 && n.from <= n.to && n.to < (f.values || []).length && isStr(n.text), 'notes は {from, to, text}');
  }
  if (f.type === 'step') {
    need(Array.isArray(f.labels) && f.labels.length > 1, 'labels が無い（2 つ以上）');
    axisLabels(f.labels);
    need(Array.isArray(f.series) && f.series.length > 0 && f.series.length <= 2, 'series は 1〜2 系列');
    for (const s of arrOf(f.series) ? f.series : []) { if (!s || typeof s !== 'object') { need(false, 'series の要素がオブジェクトではない'); continue; } need(isStr(s.name), 'series の name が無い'); nonneg(s.values, 'series の values'); need(!Array.isArray(s.values) || s.values.length === (f.labels || []).length, 'series の values と labels の数が違う'); }
    if (f.planFrom !== undefined) need(Number.isInteger(f.planFrom) && f.planFrom >= 1 && f.planFrom < (f.labels || []).length, 'planFrom は 1 以上・labels の数未満の整数');
  }
  if (f.type === 'hbar') {
    need(Array.isArray(f.rows) && f.rows.length > 0, 'rows が無い');
    for (const r of arrOf(f.rows) ? f.rows : []) need(r && isStr(r.label) && len(r.label) <= MAX_LEN.hbarLabel && isNum(r.value) && r.value >= 0 && (r.note === undefined || (typeof r.note === 'string' && len(r.note) <= MAX_LEN.hbarNote)), `rows は {label（${MAX_LEN.hbarLabel} 文字まで）, value（0 以上）, note?（${MAX_LEN.hbarNote} 文字まで）}`);
  }
  if (f.type === 'pair') {
    need(Array.isArray(f.names) && f.names.length === 2 && f.names.every((x) => isStr(x) && len(x) <= MAX_LEN.seriesName), `names は 2 つの系列名（${MAX_LEN.seriesName} 文字まで）`);
    need(Array.isArray(f.groups) && f.groups.length > 0, 'groups が無い');
    for (const g of arrOf(f.groups) ? f.groups : []) need(g && isStr(g.label) && len(g.label) <= MAX_LEN.axisLabel && isNum(g.a) && g.a >= 0 && isNum(g.b) && g.b >= 0, `groups は {label（${MAX_LEN.axisLabel} 文字まで）, a, b}（0 以上）`);
  }
  if (f.type === 'structure') {
    need(Array.isArray(f.nodes) && f.nodes.length > 0, 'nodes が無い');
    const ids = new Set();
    for (const n of arrOf(f.nodes) ? f.nodes : []) {
      if (!n || typeof n !== 'object') { need(false, 'nodes の要素がオブジェクトではない'); continue; }
      need(isStr(n.id) && isStr(n.text) && isNum(n.x) && isNum(n.y) && n.x >= 0 && n.x <= 540 && n.y >= 0 && n.y <= 2000, 'nodes は {id, text, x（0〜540）, y（0〜2000）, state}');
      need(isStr(n.text) && String(n.text).split('\n').length <= 2 && String(n.text).split('\n').every((l) => len(l) <= MAX_LEN.nodeLine), `nodes の text は 2 行まで・1 行 ${MAX_LEN.nodeLine} 文字まで（改行は \\n）`);
      need(['ok', 'ind', 'no'].includes(n.state), 'nodes の state は ok（確認済み）・ind（間接的）・no（未確認）');
      if (ids.has(n.id)) errs.push(at + ': nodes の id が重複: ' + n.id);
      ids.add(n.id);
    }
    for (const e of arrOf(f.edges) ? f.edges : []) need(Array.isArray(e) && (e.length === 2 || (e.length === 3 && ['ok', 'ind', 'no'].includes(e[2]))) && ids.has(e[0]) && ids.has(e[1]), 'edges は [元の id, 先の id] か [元, 先, 確度 ok|ind|no]（確度の既定は no＝因果は未確認）');
  }
  // 年表。並びは配列の順（日付順に並べるのは入力側。自動では並べ替えない）。state は「済み／予定」で、事実の確度ではない
  if (f.type === 'timeline') {
    need(Array.isArray(f.events) && f.events.length >= 2 && f.events.length <= 12, 'events は 2〜12 件の配列');
    for (const [i, ev] of (arrOf(f.events) ? f.events : []).entries()) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { need(false, `events[${i}] がオブジェクトではない`); continue; }
      need(isStr(ev.date) && len(ev.date) <= MAX_LEN.nodeLine, `events[${i}] の date は空でない文字列・${MAX_LEN.nodeLine} 文字まで`);
      need(isStr(ev.text) && String(ev.text).split('\n').length <= 2 && String(ev.text).split('\n').every((l) => len(l) <= MAX_LEN.eventLine), `events[${i}] の text は空でない文字列・2 行まで・1 行 ${MAX_LEN.eventLine} 文字まで（改行は \\n）`);
      need(['done', 'plan'].includes(ev.state), `events[${i}] の state は done（済み）・plan（予定）`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------- SVG の部品
const W = 720, H = 300, ML = 48, MR = 16, MT = 24, MB = 46;
const PW = W - ML - MR, PH = H - MT - MB;
const TL_W = 460;
const svgOpen = (title, h = H, cls = 'chart', w = W) => `<svg class="${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
function frame(ymax, ticks, unit) {
  let s = '';
  for (const t of ticks) {
    const y = MT + PH * (1 - t / ymax);
    s += `<line class="grid" x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}"/><text class="tick" x="${ML - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`;
  }
  s += `<text class="unit" x="${ML}" y="${MT - 8}">${esc(unit || '')}</text>`;
  s += `<line class="axis" x1="${ML}" y1="${MT + PH}" x2="${W - MR}" y2="${MT + PH}"/>`;
  return s;
}
const bandX = (n, i) => ML + (PW / n) * (i + 0.5);
const yOf = (v, ymax) => MT + PH * (1 - v / ymax);
function xLabels(labels) {
  const n = labels.length;
  const every = Math.ceil(n / 12);
  return labels.map((l, i) => (i % every === 0 || i === n - 1 ? `<text x="${bandX(n, i).toFixed(1)}" y="${MT + PH + 18}" text-anchor="middle">${esc(l)}</text>` : '')).join('');
}
export function barChart(f) {
  const n = f.values.length;
  const { ymax, ticks } = niceScale(Math.max(...f.values, ...(f.avg || []).map((a) => a.value)));
  const bw = (PW / n) * 0.6;
  let s = svgOpen(f.title) + frame(ymax, ticks, f.unit);
  f.values.forEach((v, i) => {
    const x = bandX(n, i) - bw / 2, y = yOf(v, ymax);
    const partial = f.partialLast && i === n - 1 ? ' partial' : '';
    s += `<rect class="s1${partial}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(MT + PH - y).toFixed(1)}" rx="3"><title>${esc(f.labels[i])}: ${esc(fmt(v))}${esc(f.unit || '')}${partial ? '（途中）' : ''}</title></rect>`;
  });
  // 比べる期間の平均線は、その期間の幅だけ引く（比較の期間を図に描き込む）
  for (const a of f.avg || []) {
    const x1 = ML + (PW / n) * a.from, x2 = ML + (PW / n) * a.to, y = yOf(a.value, ymax);
    s += `<line class="avg" x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="avgl" x="${((x1 + x2) / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${esc(a.label)}</text>`;
  }
  return s + xLabels(f.labels) + '</svg>';
}
export function lineChart(f) {
  const n = f.values.length;
  const { ymax, ticks } = niceScale(Math.max(...f.values));
  const pts = f.values.map((v, i) => [bandX(n, i), yOf(v, ymax)]);
  let s = svgOpen(f.title) + frame(ymax, ticks, f.unit);
  s += `<path class="ls1" d="${pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ')}"/>`;
  pts.forEach(([x, y], i) => { s += `<circle class="s1" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"><title>${esc(f.labels[i])}: ${esc(fmt(f.values[i]))}${esc(f.unit || '')}</title></circle>`; });
  for (const nt of f.notes || []) {
    const x1 = bandX(n, nt.from) - 8, x2 = bandX(n, nt.to) + 8, y = MT + 4;
    s += `<path class="brk" d="M${x1.toFixed(1)} ${y + 8} V${y} H${x2.toFixed(1)} V${y + 8}"/><text x="${((x1 + x2) / 2).toFixed(1)}" y="${y - 2}" text-anchor="middle">${esc(nt.text)}</text>`;
  }
  return s + xLabels(f.labels) + '</svg>';
}
// 段階の折れ線。planFrom より後（予定・見込み）は点線で描く（実績と区別する）
export function stepChart(f) {
  const n = f.labels.length;
  const { ymax, ticks } = niceScale(Math.max(...f.series.flatMap((s) => s.values)));
  let s = svgOpen(f.title) + frame(ymax, ticks, f.unit);
  f.series.forEach((se, k) => {
    const pts = se.values.map((v, i) => [bandX(n, i), yOf(v, ymax)]);
    const path = (from, to) => pts.slice(from, to).map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
    const cut = f.planFrom === undefined ? n : f.planFrom;
    s += `<path class="ls${k + 1}" d="${path(0, cut)}"/>`;
    if (cut < n) s += `<path class="ls${k + 1} plan" d="${path(cut - 1, n)}"/>`;
    pts.forEach(([x, y], i) => { s += `<circle class="hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"><title>${esc(se.name)} ${esc(f.labels[i])}: ${esc(fmt(se.values[i]))}${esc(f.unit || '')}${i >= cut ? '（予定）' : ''}</title></circle>`; });
  });
  return s + xLabels(f.labels) + '</svg>';
}
export function hbarChart(f) {
  const rowH = 34, top = 16, left = 230, right = 130;
  const h = top + f.rows.length * rowH + 12;
  const max = Math.max(...f.rows.map((r) => r.value)) || 1;
  let s = svgOpen(f.title, h);
  f.rows.forEach((r, i) => {
    const y = top + i * rowH, w = ((W - left - right) * r.value) / max;
    s += `<text x="${left - 8}" y="${y + 17}" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect class="s1" x="${left}" y="${y + 5}" width="${w.toFixed(1)}" height="18" rx="3"><title>${esc(r.label)}: ${esc(fmt(r.value))}${esc(f.unit || '')}</title></rect>`;
    s += `<text x="${(left + w + 6).toFixed(1)}" y="${y + 18}">${esc(fmt(r.value))}${esc(f.unit || '')}${r.note ? '\u3000' + esc(r.note) : ''}</text>`;
  });
  return s + '</svg>';
}
export function pairChart(f) {
  const n = f.groups.length;
  const { ymax, ticks } = niceScale(Math.max(...f.groups.flatMap((g) => [g.a, g.b])));
  const bw = (PW / n) * 0.3;
  let s = svgOpen(f.title) + frame(ymax, ticks, f.unit);
  f.groups.forEach((g, i) => {
    [[g.a, 's1', -1, f.names[0]], [g.b, 's2', 0, f.names[1]]].forEach(([v, c, off, name]) => {
      const x = bandX(n, i) + off * bw, y = yOf(v, ymax);
      s += `<rect class="${c}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(MT + PH - y).toFixed(1)}" rx="3"><title>${esc(g.label)} ${esc(name)}: ${esc(fmt(v))}${esc(f.unit || '')}</title></rect>`;
      s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${esc(fmt(v))}</text>`;
    });
  });
  return s + xLabels(f.groups.map((g) => g.label)) + '</svg>';
}
// 構造図。確度は枠の線の種類で示す（確認済み＝実線の太線／間接的＝破線／未確認＝点線。色だけに頼らない）。
// 矢印（因果）も同じ線種で示し、既定は未確認（点線）。確かめた因果だけ、明示して実線にする（実線の矢印が「確認済み」と読まれるため）
const STATE_TAG = { ok: '確認済み', ind: '間接的', no: '未確認' };
export function structureChart(f) {
  const bw = 180, bh = 56;
  const h = Math.max(...f.nodes.map((n) => n.y)) + bh + 24;
  const at = Object.fromEntries(f.nodes.map((n) => [n.id, n]));
  const clip = (a, b) => {
    const cx = a.x + bw / 2, cy = a.y + bh / 2, dx = b.x + bw / 2 - cx, dy = b.y + bh / 2 - cy;
    const t = Math.min(Math.abs(bw / 2 / (dx || 1e-9)), Math.abs(bh / 2 / (dy || 1e-9)));
    return [cx + dx * t, cy + dy * t];
  };
  let s = svgOpen(f.title, h) + '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0 0L10 5L0 10z"/></marker></defs>';
  for (const [a, b, st = 'no'] of f.edges || []) {
    const [x1, y1] = clip(at[a], at[b]), [x2, y2] = clip(at[b], at[a]);
    s += `<path class="edge ${st}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}" marker-end="url(#ah)"><title>${esc(at[a].text.replace(/\n/g, ' '))} → ${esc(at[b].text.replace(/\n/g, ' '))}（${STATE_TAG[st]}）</title></path>`;
  }
  for (const n of f.nodes) {
    s += `<rect class="node ${n.state}" x="${n.x}" y="${n.y}" width="${bw}" height="${bh}" rx="8"><title>${esc(n.text)}（${STATE_TAG[n.state]}）</title></rect>`;
    String(n.text).split('\n').slice(0, 2).forEach((line, i, all) => { s += `<text x="${n.x + bw / 2}" y="${n.y + (all.length === 1 ? 30 : 22 + i * 16)}" text-anchor="middle">${esc(line)}</text>`; });
    s += `<text class="tag" x="${n.x + bw - 6}" y="${n.y + bh - 6}" text-anchor="end">${STATE_TAG[n.state]}</text>`;
  }
  return s + '</svg>';
}
// 年表。枠の線種は「済み／予定」（事実の確度ではない）。済み＝実線の太線／予定＝破線。矢印は日付の順番（上から下）で、因果の確かさは表さない
const EVENT_TAG = { done: '済み', plan: '予定' };
export function timelineChart(f) {
  // 年表は文字が主なので、幅の狭い専用の viewBox（スマホで縮んでも読める大きさにする）。class tl で文字を大きくする
  const bx = 128, bw = 322, bh = 60, gap = 28, top = 8;
  const h = top + f.events.length * (bh + gap) - gap + 8;
  let s = svgOpen(f.title, h, 'chart tl', TL_W) + '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0 0L10 5L0 10z"/></marker></defs>';
  const yOfEv = (i) => top + i * (bh + gap);
  f.events.forEach((ev, i) => {
    if (i + 1 < f.events.length) s += `<path class="edge seq" d="M${bx + bw / 2} ${yOfEv(i) + bh} L${bx + bw / 2} ${yOfEv(i + 1)}" marker-end="url(#ah)"><title>${esc(ev.text.replace(/\n/g, ' '))} → ${esc(f.events[i + 1].text.replace(/\n/g, ' '))}（日付の順）</title></path>`;
  });
  f.events.forEach((ev, i) => {
    const y = yOfEv(i);
    // 日付の列は幅 112。全角 13・半角 7.5 の概算が超える長い日付だけ textLength で列に収める（短い日付を引き伸ばさない）（枠の外・図の外へ出さない）
    const dl = [...ev.date].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 7.5 : 13), 0) > 112 ? ' textLength="112" lengthAdjust="spacingAndGlyphs"' : '';
    s += `<text class="evdate" x="${bx - 10}" y="${y + bh / 2 + 5}" text-anchor="end"${dl}>${esc(ev.date)}</text>`;
    s += `<rect class="ev ${ev.state}" x="${bx}" y="${y}" width="${bw}" height="${bh}" rx="8"><title>${esc(ev.date)} ${esc(ev.text.replace(/\n/g, ' '))}（${EVENT_TAG[ev.state]}）</title></rect>`;
    String(ev.text).split('\n').slice(0, 2).forEach((line, j, all) => { s += `<text x="${bx + bw / 2}" y="${y + (all.length === 1 ? 35 : 25 + j * 19)}" text-anchor="middle">${esc(line)}</text>`; });
    s += `<text class="tag" x="${bx + bw - 6}" y="${y + bh - 5}" text-anchor="end">${EVENT_TAG[ev.state]}</text>`;
  });
  return s + '</svg>';
}
const RENDER = { bar: barChart, line: lineChart, step: stepChart, hbar: hbarChart, pair: pairChart, structure: structureChart, timeline: timelineChart };

// 図の表ビュー（「数値で見る（表）」。読み上げ・誤読の確認にも使う）
export function figureTable(f) {
  let head, rows;
  if (f.type === 'bar' || f.type === 'line') { head = ['', f.unit || '値']; rows = f.labels.map((l, i) => [l, fmt(f.values[i])]); }
  else if (f.type === 'step') { head = ['', ...f.series.map((s) => s.name)]; rows = f.labels.map((l, i) => [l + (f.planFrom !== undefined && i >= f.planFrom ? '（予定）' : ''), ...f.series.map((s) => fmt(s.values[i]))]); }
  else if (f.type === 'hbar') { head = ['', f.unit || '値', '注記']; rows = f.rows.map((r) => [r.label, fmt(r.value), r.note || '']); }
  else if (f.type === 'pair') { head = ['', ...f.names]; rows = f.groups.map((g) => [g.label, fmt(g.a), fmt(g.b)]); }
  else if (f.type === 'timeline') { head = ['日付', '出来事', '状態']; rows = f.events.map((ev) => [ev.date, ev.text.replace(/\n/g, ' '), EVENT_TAG[ev.state]]); }
  else { head = ['項目', '確度']; rows = f.nodes.map((n) => [n.text.replace(/\n/g, ' '), STATE_TAG[n.state]]); }
  return `<details><summary>${f.type === 'structure' || f.type === 'timeline' ? '表で見る' : '数値で見る（表）'}</summary><div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
function legend(f) {
  const items = [];
  if (f.type === 'bar') { if ((f.avg || []).length) items.push('<span><span class="sw dash"></span>期間の平均</span>'); if (f.partialLast) items.push('<span><span class="sw pt"></span>途中の値（集計の途中まで）</span>'); }
  if (f.type === 'step') { f.series.forEach((s, k) => items.push(`<span><span class="sw s${k + 1}"></span>${esc(s.name)}</span>`)); if (f.planFrom !== undefined) items.push('<span><span class="sw dash"></span>予定・見込み</span>'); }
  if (f.type === 'pair') f.names.forEach((nm, k) => items.push(`<span><span class="sw s${k + 1}"></span>${esc(nm)}</span>`));
  if (f.type === 'structure') {
    // 凡例には、この図で使った確度だけを並べる（使わない線種を並べると、どこにあるのかと読み手が探す）
    const used = new Set([...f.nodes.map((n) => n.state), ...(f.edges || []).map((e) => e[2] || 'no')]);
    for (const [st, sw, name] of [['ok', 'line', '確認済み'], ['ind', 'dash', '間接的'], ['no', 'dot', '未確認']]) if (used.has(st)) items.push(`<span><span class="sw ${sw}"></span>${name}</span>`);
    items.push('<span>枠は事実の確度、矢印は因果の確度（どちらも同じ線種で示す）</span>');
  }
  if (f.type === 'timeline') items.push('<span><span class="sw line"></span>実線の枠＝済み</span>', '<span><span class="sw dash"></span>破線の枠＝予定</span>', '<span>矢印は日付の順番（因果の確かさではない）</span>');
  return items.length ? `<div class="legend">${items.join('')}</div>` : '';
}
export function renderFigure(f) {
  const svg = RENDER[f.type](f);
  const body = f.type === 'structure' ? `<div class="wide">${svg}</div>` : svg;
  return `<div class="fig"><p class="q">この図が答える問い: ${esc(f.question)}</p>${body}${legend(f)}${figureTable(f)}<p class="src">図の出典: ${esc(f.source)}</p></div>`;
}

// ---------------------------------------------------------------- 1 ページの型
function renderBlock(b) {
  if (typeof b === 'string') return `<p>${esc(b)}</p>`;
  if (b.p !== undefined) return `<p>${esc(b.p)}</p>`;
  if (b.list) return `<ul class="items">${b.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (b.tiles) return `<div class="tiles">${b.tiles.map((t) => `<div class="tile"><div class="v">${esc(t.value)}</div><div class="l">${esc(t.label)}</div></div>`).join('')}</div>`;
  if (b.cards) return `<div class="cards${b.cards.length === 3 ? ' n3' : ''}">${b.cards.map((c) => `<div class="card ${['good', 'bad', 'open'].includes(c.kind) ? c.kind : ''}"><h3>${c.mark ? `<span class="mark">${esc(c.mark)}</span>` : ''}${esc(c.title)}</h3><p>${esc(c.text || '')}</p></div>`).join('')}</div>`;
  if (b.terms) return `<div class="tw"><table class="terms"><thead><tr><th>言葉</th><th>意味</th><th>1 行が指すもの</th></tr></thead><tbody>${b.terms.map((t) => `<tr><td>${esc(t.word)}</td><td>${esc(t.means)}</td><td>${esc(t.unit || '')}</td></tr>`).join('')}</tbody></table></div>`;
  return '';
}
export function renderSlide(s, i) {
  const no = String(i + 1).padStart(2, '0');
  const labels = Array.isArray(s.label) ? s.label : [s.label];
  const chips = labels.map((l) => `<span class="chip ${l}">${LABELS[l]}</span>`).join('');
  return `<section class="slide${s.role === 'limits' ? ' limits' : ''}${s.role === 'conclusion' ? ' conclusion' : ''}" id="s${no}"><div class="kick"><span class="no">${no}</span><span>${esc(s.kicker)}</span>${chips}</div>`
    + `<h2>${esc(s.head)}</h2>${s.goal ? `<div class="goal"><p class="gt">この章のゴール</p><ul class="items">${s.goal.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}${s.figure ? renderFigure(s.figure) : ''}${(s.body || []).map(renderBlock).join('')}${s.checks ? `<div class="checks"><p class="gt">これに答えられたら次へ</p>${s.checks.map((c) => `<details><summary>${esc(c.q)}</summary><p>${esc(c.a)}</p></details>`).join('')}</div>` : ''}`
    + `${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}<p class="src">出典: ${esc(s.source)}</p></section>`;
}
export function renderDeck(d, template, variant, generatedAt) {
  const sens = variant === 'real' ? '機微区分: 実名版（共有の前に必ず確認）' : '機微区分: マスク版';
  // 読み方には、この資料で使ったラベルだけを並べる（使わないラベルを並べると、どこにあるのかと読み手が探す）
  const used = new Set(d.slides.flatMap((s) => (Array.isArray(s.label) ? s.label : [s.label])));
  const howto = Object.entries(LABELS).filter(([k]) => used.has(k)).map(([k, v]) => `<span class="chip ${k}">${v}</span>`).join(' ');
  const ty = DECK_TYPES[d.type];
  const cover = `<header class="cover">${d.eyebrow ? `<p class="eyebrow">${esc(d.eyebrow)}</p>` : ''}<h1>${esc(d.title)}</h1>${d.lead ? `<p class="lead">${esc(d.lead)}</p>` : ''}`
    + (ty ? `<p class="doctype"><span class="chip">資料の型: ${esc(ty.name)}</span> 読んだ後にできること: ${esc(ty.can)}</p>` : '')
    + `<div class="howto">各ページの見出しは、そのページで言いたいことです。右上のラベルは根拠の強さを示します: ${howto}</div>`
    + `${d.byline ? `<p class="byline">${esc(d.byline)}</p>` : ''}<p class="sensitivity">${sens}</p></header>`;
  const fill = { TITLE: esc(d.title), COVER: cover, SLIDES: d.slides.map(renderSlide).join('\n'), GENERATED_AT: esc(generatedAt), SENSITIVITY: sens };
  const missing = Object.keys(fill).filter((k) => !template.includes('{{' + k + '}}'));
  if (missing.length) throw new InputError('テンプレートに差し込み口が無い: ' + missing.join(', '));
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(fill, k) ? fill[k] : m));
}

// ---------------------------------------------------------------- 機械の検査
// 外部参照の形。1 つでも当たれば外部参照ありとする（テキストとしての URL・UNC も、共有物に載せないため止める）
export const EXTERNAL_PATTERNS = [
  ['URL（スキームつき）', /\b[a-z][a-z0-9+.-]{1,15}:\/\//i, 'see https://example.invalid/x'],
  ['mailto', /\bmailto:/i, 'mailto:a' + '@' + 'example.invalid'],
  ['UNC', /\\\\[a-z0-9_.$-]+\\/i, '\\\\server\\share'],
  ['プロトコル相対', /(?:["'(=\s])\/\/[a-z0-9-]+\.[a-z0-9.-]+/i, '<a href="//cdn.example.invalid/a.js">'],
  ['url()', /url\(\s*['"]?(?!#)[^)'"\s]/i, 'background:url(img/a.png)'],
  ['src', /\ssrc\s*=/i, '<x src="a.js">'],
  ['srcset', /\ssrcset\s*=/i, '<x srcset="a.png 2x">'],
  ['href', /\shref\s*=\s*(?!["']?#)/i, '<a href="a.html">'],
  ['xlink:href', /\sxlink:href\s*=\s*(?!["']?#)/i, '<use xlink:href="a.svg#b"/>'],
  ['@import', /@import\b/i, '@import "a.css";'],
  ['script', /<script\b/i, '<script>x</script>'],
  ['link', /<link\b/i, '<link rel="stylesheet">'],
  ['iframe', /<iframe\b/i, '<iframe></iframe>'],
  ['img', /<img\b/i, '<img alt="">'],
  ['object・embed', /<(?:object|embed)\b/i, '<embed>'],
  ['音声・動画', /<(?:audio|video|source)\b/i, '<video></video>'],
];
export function findExternalRefs(html) {
  return EXTERNAL_PATTERNS.filter(([, re]) => re.test(html)).map(([name]) => name);
}
// 陽性対照: 各形の見本を、その形の検出が拾うこと。拾えない形があれば検査そのものを信用しない
export function externalSelfCheck(finder = findExternalRefs) {
  const broken = EXTERNAL_PATTERNS.filter(([name, , sample]) => !finder(sample).includes(name)).map(([n]) => n);
  if (broken.length) throw new CheckError('外部参照の検出が働かない形がある（陽性対照）: ' + broken.join(', '));
  return EXTERNAL_PATTERNS.length;
}
// 語の照合は、全角半角（NFKC）・大文字小文字・空白（全角を含む）・ゼロ幅などの書式文字・ダッシュの揺れを除いてから行う。
// 異体字（髙と高など）・姓だけ・ローマ字は同じ語にならないので、一覧の側に入れる（手引きの §7）
export const normWord = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').replace(/[\u2010-\u2015\u2212\uff0d-]/g, '-').replace(/[\s\u3000]+/g, '');
// 伏せる語の一覧。1 行 1 語、# で始まる行と空行は無視する
export function readMaskWords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new InputError('伏せる語の一覧を読めない（' + (e.code || 'error') + '）'); }
  const words = text.replace(/^\ufeff/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!words.length) throw new InputError('伏せる語の一覧が空（語が無いなら --mask-words-none を明示する）');
  return words;
}
// HTML の本文・属性（title・aria-label を含む）とファイル名を、エンティティを戻してから照合する
// あわせて、タグを取り除いて表示の文字を続けた形でも照合する（<span>北山</span>商店 のように、表示ではつながる語を見落とさない）
export function findMaskLeaks(html, words, names = []) {
  const hay = [normWord(unesc(html)), normWord(unesc(String(html).replace(/<[^>]*>/g, ''))), ...names.map(normWord)];
  return words.filter((w) => { const k = normWord(w); return k && hay.some((h) => h.includes(k)); });
}
// 陽性対照: 各語を、本文・属性・SVG の title・空白を挟んだ形・ゼロ幅の文字を挟んだ形・ファイル名に仕込んだ見本で、どれも拾えること
export function maskSelfCheck(words, finder = findMaskLeaks) {
  const broken = [];
  for (const w of words) {
    const spaced = [...w].join(' '), zw = [...w].join('\u200b');
    const chars = [...w];
    const split = chars.length > 1 ? `<h3><span class="mark">${esc(chars[0])}</span>${esc(chars.slice(1).join(''))}</h3>` : `<p>${esc(w)}</p>`;
    const hex = chars.map((c) => `&#x${c.codePointAt(0).toString(16)};`).join('');
    const probes = [`<p>${esc(w)}</p>`, `<svg aria-label="${esc(w)}"></svg>`, `<rect><title>${esc(w)}</title></rect>`, `<td>${esc(spaced)}</td>`, `<p>${esc(zw)}</p>`, split, `<p>${hex}</p>`];
    for (const p of probes) if (!finder(p, [w]).length) broken.push(w);
    if (!finder('', [w], [`deck-${w}.html`]).length) broken.push(w);
  }
  if (broken.length) throw new CheckError('マスク漏れの検出が働かない（陽性対照）: ' + broken.length + ' 件');
  return words.length;
}
// 表示の静的な検査: viewport の指定があること、390px を超える固定幅が無いこと。
// 見るのは SVG の width 属性・style 属性・<style> の中の規則（横スクロールの枠 .wide・.tw の規則と max-width は除く）
const FIXED_WIDTH = /(?<![\w-])(?:min-)?(?:width|inline-size):\s*(\d+)px/gi;
export function staticLayoutProblems(html) {
  const p = [];
  if (!/<meta\s+name="viewport"/i.test(html)) p.push('viewport の指定が無い');
  for (const m of html.matchAll(/<svg\b[^>]*\swidth="(\d+)/gi)) if (Number(m[1]) > 390) p.push('SVG に 390px を超える固定幅: ' + m[1]);
  for (const m of html.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) for (const w of (m[1] ?? m[2] ?? m[3]).matchAll(FIXED_WIDTH)) if (Number(w[1]) > 390) p.push('要素に 390px を超える固定幅: ' + w[1]);
  for (const st of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rule of st[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = rule[1].trim();
      // 除くのは、すべてのセレクタが横スクロールの枠（.wide・.tw）の中を指す規則だけ（「.wide, main」のような並びは除かない）
      if (sel.split(',').every((x) => /^\.(wide|tw)(?![\w-])/.test(x.trim()))) continue;
      for (const w of rule[2].matchAll(FIXED_WIDTH)) if (Number(w[1]) > 390) p.push(`<style> の ${sel.slice(0, 40)} に 390px を超える固定幅: ${w[1]}`);
    }
  }
  return p;
}
// 陽性対照: 各形の見本を拾えること
export function layoutSelfCheck(check = staticLayoutProblems) {
  const ok = '<meta name="viewport">';
  const samples = [['viewport', '<p>x</p>'], ['SVG', ok + '<svg width="720"></svg>'], ['style 属性', ok + '<div style="min-width: 900px"></div>'], ['style 属性（単引用符）', ok + "<div style='inline-size:900px'></div>"], ['<style>', ok + '<style>main { width: 1000px; }</style>']];
  const broken = samples.filter(([, s]) => !check(s).length).map(([n]) => n);
  if (check(ok + '<style>.wide .chart { min-width: 720px; } main { max-width: 980px; }</style>').length) broken.push('除外（.wide・max-width）');
  if (!check(ok + '<style>.wide, main { width: 2000px; }</style>').length) broken.push('除外のしすぎ（.wide と並んだ規則）');
  if (broken.length) throw new CheckError('表示の静的な検査が働かない（陽性対照）: ' + broken.join(', '));
  return samples.length;
}
// 形の検査の陽性対照: 壊した構成の見本で、決めた項目を拾うこと
export function schemaSelfCheck(validate = validateDeck) {
  const bad = { title: 't', slides: [{ kicker: 'k', head: 'h', label: 'x', source: '', figure: { type: 'pie', title: 't' }, body: [{ list: 'x' }] }] };
  const e = validate(bad).join('\n');
  const want = ['言えないこと', 'label', 'source', '未知の図の種別', 'question', 'list'];
  const miss = want.filter((k) => !e.includes(k));
  if (miss.length) throw new CheckError('形の検査が働かない（陽性対照）: ' + miss.join(', '));
  return want.length;
}

// 資料の中の数字の一覧（第三者の照合の件数と突き合わせる）。表示されるすべての文字列と図のデータから取る。
// 全角の数字も NFKC で半角にしてから拾う
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
const numsIn = (s) => [...String(s).normalize('NFKC').matchAll(NUM_RE)].map((m) => m[0].replace(/,$/, ''));
export function collectNumbers(d) {
  const out = [];
  // 除くのは表示されない制御の値だけ。label は除かない（タイルや系列のラベルは表示され、数字を含みうる。根拠のラベルは記号なので数字を含まない）
  const SKIP = new Set(['x', 'y', 'from', 'to', 'planFrom', 'type', 'state', 'id', 'edges', 'kind', 'role', 'partialLast']);
  const walk = (where, v, inFigure) => {
    if (typeof v === 'string') { for (const n of numsIn(v)) out.push({ where, value: n }); }
    else if (typeof v === 'number') out.push({ where, value: fmt(v) });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${where}[${i}]`, x, inFigure));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      // 図の制御の値（座標・区間の添字・種別）は表示されないので数えない。ラベル（根拠の強さ）は記号
      if (SKIP.has(k)) continue;
      walk(`${where}.${k}`, x, inFigure || k === 'figure');
    }
  };
  for (const k of ['eyebrow', 'title', 'lead', 'byline']) if (d[k] !== undefined) walk(k, d[k], false);
  d.slides.forEach((s, i) => walk(`slides[${i}]`, s, false));
  return out;
}
// 資料に見えている数字（目盛り・ページ番号・生成日時・CSS を除く）。数字の一覧の網羅の照合に使う
export function visibleNumbers(html) {
  const body = html.replace(/<head\b[\s\S]*?<\/head>/i, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<footer\b[\s\S]*?<\/footer>/i, '')
    .replace(/<text class="tick"[^>]*>[^<]*<\/text>/g, '').replace(/<span class="no">[^<]*<\/span>/g, '').replace(/\sid="s\d+"/g, '');
  const attrs = [...body.matchAll(/\saria-label="([^"]*)"/g)].map((m) => m[1]).join(' ');
  const text = unesc(body.replace(/<[^>]+>/g, ' ') + ' ' + attrs);
  return numsIn(text);
}
// 網羅の照合: 見えている数字がすべて一覧にあること。一覧に無い数字があれば、照合の件数が合っても検証にならない
export function missingNumbers(html, numbers) {
  const have = new Set(numbers.map((n) => n.value.replace(/,/g, '')));
  return [...new Set(visibleNumbers(html).map((n) => n.replace(/,/g, '')))].filter((n) => !have.has(n));
}
export function numbersSelfCheck(check = missingNumbers) {
  if (!check('<p>件数は 30 件、比は 2 倍</p>', [{ value: '30' }]).includes('2')) throw new CheckError('数字の一覧の網羅の照合が働かない（陽性対照）');
  if (check('<svg><text class="tick" x="1">250</text></svg><span class="no">07</span>', []).length) throw new CheckError('数字の一覧の網羅の照合が目盛り・ページ番号を数える（陽性対照）');
  return 2;
}

// ---------------------------------------------------------------- build
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
// 実体のパスで比べる（ジャンクション・8.3 の短い名前・subst で、中にあるのに外と判定しない）。まだ無い部分は、在る祖先を実体にしてから足す
const realish = (p) => {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) break; rest.unshift(path.basename(cur)); cur = up; }
  try { cur = fs.realpathSync.native(cur); } catch { /* 実体にできなければ表記のまま比べる */ }
  return path.join(cur, ...rest);
};
export const inside = (child, parent) => {
  const r = path.relative(realish(parent), realish(child));
  return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
};
// fsx: 書き出しに使うファイル操作（試験で失敗を差し込むため。既定は fs そのもの）。template は試験用（CLI からは差し替えられない）
export function build({ deckFile, outDir, variants = 'masked', maskWordsFile = null, maskWordsNone = false, name = 'deck', template = DEFAULT_TEMPLATE, now = new Date(), fsx = fs }) {
  if (!['masked', 'real', 'both'].includes(variants)) throw new InputError('--variants は masked・real・both のどれか');
  if (!NAME_RE.test(name)) throw new InputError('--name は英数字・. _ - だけ（80 文字まで）');
  const wantMasked = variants !== 'real';
  if (wantMasked && !maskWordsFile && !maskWordsNone) throw new InputError('マスク版には伏せる語の一覧が要る（--mask-words <ファイル>。伏せる語が無いなら --mask-words-none を明示する）');
  if (maskWordsFile && maskWordsNone) throw new InputError('--mask-words と --mask-words-none は同時に指定できない');
  // 実名を含みうる構成と伏せる語の一覧を、出力先（共有されうる場所）に置かない
  if (inside(deckFile, outDir)) throw new InputError('deck.json が出力先の中にある（実名を含みうるため、出力先の外の作業フォルダに置く）');
  if (maskWordsFile && inside(maskWordsFile, outDir)) throw new InputError('伏せる語の一覧が出力先の中にある（出力先の外に置く）');
  let deck;
  try { deck = JSON.parse(fs.readFileSync(deckFile, 'utf8').replace(/^\ufeff/, '')); } catch (e) { throw new InputError('deck.json を読めない: ' + (e.code || e.message)); }
  let tpl;
  try { tpl = fs.readFileSync(template, 'utf8'); } catch (e) { throw new InputError('テンプレートを読めない（' + (e.code || 'error') + '）。記憶で作らずに止める'); }
  const report = [];
  const extForms = externalSelfCheck();
  const layoutForms = layoutSelfCheck();
  const schemaForms = schemaSelfCheck();
  numbersSelfCheck();
  const tplRefs = findExternalRefs(tpl);
  if (tplRefs.length) throw new CheckError('テンプレートに外部参照がある: ' + tplRefs.join(', '));
  const words = maskWordsFile ? readMaskWords(maskWordsFile) : [];
  if (words.length) maskSelfCheck(words);
  const outputs = [];
  const at = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const made = variants === 'both' ? ['masked', 'real'] : [variants];
  // 前に作った別の版（とくに実名版）が出力先に残っていたら止める（作り直したつもりで古い実名版が共有されないように）
  for (const v of ['masked', 'real']) if (!made.includes(v) && fs.existsSync(path.join(outDir, `${name}.${v}.html`))) throw new CheckError(`出力先に、今回は作らない ${v === 'real' ? '実名版' : 'マスク版'}（${name}.${v}.html）が残っている。消すか、別の出力先にする`);
  // 前の実行が途中で止まって残した一時のファイル・退避（実名版を含みうる）があれば止める
  const present = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const leftovers = present.filter((n) => /\.tmp-[0-9a-f]{8}(\.prev)?$/.test(n));
  if (leftovers.length) throw new CheckError(`出力先に、前の実行の一時のファイル・退避が ${leftovers.length} 件残っている（実名版を含みうる。中身を確かめて消す）`);
  const otherReal = present.filter((n) => n.endsWith('.real.html') && !(made.includes('real') && n === `${name}.real.html`));
  if (otherReal.length) report.push(`注意            : 出力先に、別の名前の実名版が ${otherReal.length} 本ある（共有の前に確かめる）`);
  let numbers = null;
  for (const v of made) {
    const d = mapStrings(deck, (s) => expandTokens(s, v));
    const errs = validateDeck(d);
    if (errs.length) throw new CheckError('deck.json の形の誤り ' + errs.length + ' 件:\n  - ' + errs.join('\n  - '));
    const html = renderDeck(d, tpl, v, at);
    const refs = findExternalRefs(html);
    if (refs.length) throw new CheckError(`外部参照がある（${v}）: ` + refs.join(', '));
    const layout = staticLayoutProblems(html);
    if (layout.length) throw new CheckError(`表示の静的な検査で外れた（${v}）: ` + layout.join(' / '));
    const file = `${name}.${v}.html`;
    if (v === 'masked') {
      const leaks = findMaskLeaks(html, words, [file, path.basename(path.resolve(outDir))]);
      if (leaks.length) throw new CheckError('マスク版に伏せる語が残っている: ' + leaks.length + ' 語（語は表示しない。トークンで包む・言い換える）');
    }
    const nums = collectNumbers(d);
    const miss = missingNumbers(html, nums);
    if (miss.length) throw new CheckError(`数字の一覧から漏れた数字がある（${v}）: ${miss.length} 件（一覧が網羅していないと、照合の件数が合っても検証にならない）`);
    // 数字の一覧は最初の版（マスク版を作るならマスク版）のものを出す（実名を一覧に書かない）
    if (!numbers) numbers = nums;
    outputs.push({ file, body: html });
  }
  outputs.push({ file: `${name}.numbers.json`, body: JSON.stringify({ count: numbers.length, numbers }, null, 1) });
  report.push(`形の検査        : 陽性対照 OK（${schemaForms} 項目）`);
  report.push(`外部参照の検査  : 陽性対照 OK（${extForms} 形）／ テンプレート・出力とも 0 件`);
  report.push(wantMasked ? (words.length ? `マスク漏れの検査: 陽性対照 OK ／ 伏せる語 ${words.length} 語 ／ マスク版に残った語 0` : 'マスク漏れの検査: 伏せる語なし（利用者が --mask-words-none で明示）') : 'マスク漏れの検査: 実名版だけのため対象外');
  report.push(`表示の静的な検査: 陽性対照 OK（${layoutForms} 形）／ viewport あり ／ 390px を超える固定幅 0`);
  // 書き出し: すべて一時の名前で書いて読み直しの照合が通ってから、正式な名前にする（一部だけの出力を残さない）。
  // 正式な名前にする途中で失敗したら、置き換えた分を元に戻す（前の出力は退避しておき、失敗したら戻す）
  fsx.mkdirSync(outDir, { recursive: true });
  const tag = '.tmp-' + crypto.randomBytes(4).toString('hex');
  const temps = [], placed = [], backups = [];
  try {
    for (const o of outputs) {
      const t = path.join(outDir, o.file + tag);
      fsx.writeFileSync(t, o.body, { flag: 'wx' });
      temps.push(t);
      if (fsx.readFileSync(t, 'utf8') !== o.body) throw new CheckError('書いた内容を読み直すと一致しない: ' + o.file);
    }
    for (const o of outputs) {
      const dst = path.join(outDir, o.file);
      if (fsx.existsSync(dst)) { const b = dst + tag + '.prev'; fsx.renameSync(dst, b); backups.push([b, dst]); }
      fsx.renameSync(dst + tag, dst);
      placed.push(dst);
    }
  } catch (e) {
    const left = [];
    for (const d of placed) { try { fsx.rmSync(d, { force: true }); } catch { left.push(path.basename(d)); } }
    for (const [b, dst] of backups) { try { fsx.renameSync(b, dst); } catch { left.push(path.basename(b)); } }
    for (const t of temps) { try { fsx.rmSync(t, { force: true }); } catch { left.push(path.basename(t)); } }
    if (left.length) { e.message += `（戻せなかったファイル: ${left.join(', ')}）`; e.partial = true; }
    throw e;
  }
  // 前の出力の退避（前の実名版を含みうる）を消せなければ、成功として終えない（正式な出力は新しい版になっている）
  const stuck = [];
  for (const [b] of backups) { try { fsx.rmSync(b, { force: true }); } catch { stuck.push(path.basename(b)); } }
  if (stuck.length) { const e = new CheckError(`出力は新しい版に置き換えたが、前の出力の退避を消せなかった: ${stuck.join(', ')}（前の実名版を含みうる。手で消す）`); e.partial = true; throw e; }
  report.push(`数字の一覧      : ${numbers.length} 件 → ${name}.numbers.json（資料に見えている数字をすべて含む。第三者の照合は、この件数と照合件数を突き合わせる）`);
  report.push('出力            : ' + outputs.map((o) => o.file).join(', '));
  return { report, written: outputs.map((o) => o.file), numbers: numbers.length };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const x = argv[++i]; if (x === undefined || x.startsWith('--')) throw new InputError(a + ' に値が無い'); return x; };
    if (a === '--variants') o.variants = val();
    else if (a === '--mask-words') o.maskWordsFile = val();
    else if (a === '--mask-words-none') o.maskWordsNone = true;
    else if (a === '--name') o.name = val();
    else if (a.startsWith('--')) throw new InputError('知らない指定: ' + a);
    else o.pos.push(a);
  }
  return o;
}
export function main(argv) {
  try {
    const o = parseArgs(argv);
    if (o.pos[0] !== 'build' || o.pos.length !== 3) throw new InputError('使い方: node ut-reportdeck.mjs build <deck.json> <出力先> (--mask-words <ファイル> | --mask-words-none) [--variants masked|real|both] [--name <基本名>]');
    const r = build({ deckFile: o.pos[1], outDir: o.pos[2], variants: o.variants, maskWordsFile: o.maskWordsFile, maskWordsNone: o.maskWordsNone, name: o.name });
    for (const l of r.report) console.log(l);
    return 0;
  } catch (e) {
    console.log((e.partial ? '止めた（一部のファイルが残っている。下の一覧を確かめる）: ' : e instanceof CheckError ? '検査で止めた（何も書いていない）: ' : e instanceof InputError ? '入力の誤り: ' : '中断: ') + e.message);
    return e instanceof CheckError ? 1 : 2;
  }
}

// ---------------------------------------------------------------- selftest
async function selftest() {
  const results = [];
  const t = (name, fn) => { try { results.push({ ok: true, name, m: fn() || '' }); } catch (e) { results.push({ ok: false, name, m: String((e && e.message) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const throwsLike = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(m + '（別の理由で失敗: ' + e.message + '）'); } throw new Error(m); };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-reportdeck-st-'));
  // 架空の題材（実在の案件の値ではない）
  const fig = { type: 'bar', title: '週ごとの問い合わせ件数', question: '問い合わせは増えたか', source: '正本 3.1', unit: '件', labels: ['1週', '2週', '3週', '4週'], values: [12, 15, 30, 8], avg: [{ from: 0, to: 2, value: 13.5, label: '前半平均 13.5' }], partialLast: true };
  const sample = () => ({
    title: '架空の窓口の [[北山商店|ある店舗]] の問い合わせの状況', type: 'investigation', lead: '問い合わせが 2 倍に増えた。', slides: [
      { kicker: '結論', head: '問い合わせは前半の 2 倍に増えた', label: 'fact', role: 'conclusion', source: '正本 2', figure: JSON.parse(JSON.stringify(fig)), body: ['[[北山商店の担当の 2 名が|担当の 2 名が]]対応した。', { tiles: [{ value: '30 件', label: '3 週目' }] }] },
      { kicker: '次の調査', head: '原因は手続きの変更との時期の突き合わせで確かめる', label: ['hyp'], role: 'next', source: '正本 7', body: [{ list: ['変更の前後で件数を比べる'] }] },
      { kicker: '言えないこと', head: '増えた原因は確かめていない', label: ['hyp'], role: 'limits', source: '正本 6', body: [{ list: ['因果は未証明'] }] },
    ],
  });
  const tpl = fs.readFileSync(DEFAULT_TEMPLATE, 'utf8');
  const writeJson = (n, v) => { const f = path.join(base, n); fs.writeFileSync(f, JSON.stringify(v)); return f; };
  const wordsFile = path.join(base, 'words.txt');
  fs.writeFileSync(wordsFile, '# 伏せる語\n北山商店\n');
  try {
    t('[R01] 縦軸は 0 から始まり、上限は最大値以上', () => {
      for (const m of [1, 7, 13.5, 99, 100, 1234]) { const { ymax, ticks } = niceScale(m); assert(ticks[0] === 0 && ymax >= m && ticks[ticks.length - 1] === ymax && ticks.length <= 7, JSON.stringify({ m, ymax, ticks })); }
      assert(niceScale(0).ymax === 1, '最大値 0 で上限が 1 にならない');
    });
    t('[R02] 数字の表示: 3 桁区切りだけで、丸めない（正本の値のまま）', () => { assert(fmt(1234) === '1,234' && fmt(13.45) === '13.45' && fmt(0.04) === '0.04' && fmt(2) === '2', [fmt(1234), fmt(13.45), fmt(0.04), fmt(2)].join(' ')); });
    t('[R03] 棒グラフ: 平均線は期間の幅だけ、途中の棒は薄く、各棒に title', () => {
      const s = barChart(fig);
      assert(/viewBox="0 0 720 300"/.test(s) && /role="img"/.test(s) && s.includes('aria-label="週ごとの問い合わせ件数"'), '器の属性');
      assert((s.match(/<rect /g) || []).length === 4 && s.includes('class="s1 partial"') && s.includes('（途中）'), '途中の棒');
      const m = s.match(/<line class="avg" x1="([\d.]+)"[^>]*x2="([\d.]+)"/);
      assert(m && Math.abs(Number(m[2]) - Number(m[1]) - (PW / 4) * 2) < 0.2, '平均線の幅が期間と違う: ' + (m && m.slice(1)));
    });
    t('[R04] 段階の折れ線: planFrom から後は点線、title に（予定）', () => {
      const s = stepChart({ type: 'step', title: 't', labels: ['a', 'b', 'c', 'd'], series: [{ name: '人数', values: [3, 3, 4, 5] }], planFrom: 2 });
      assert(/class="ls1 plan" d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L/.test(s), '予定の点線が無い（前の点から続いていない）');
      assert((s.match(/（予定）/g) || []).length === 2, '予定の点の数');
    });
    t('[R05] 構造図: 確度ごとに枠の線種が違い、矢印は箱の縁で切る', () => {
      const s = structureChart({ type: 'structure', title: 't', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }, { id: 'b', text: 'B', x: 400, y: 0, state: 'no' }], edges: [['a', 'b']] });
      assert(s.includes('class="node ok"') && s.includes('class="node no"') && s.includes('未確認'), '線種の class');
      // 矢印（因果）の既定は未確認（点線）。確かめた因果だけ明示で実線
      assert(s.includes('class="edge no"') && s.includes('A → B（未確認）'), '矢印の既定が未確認でない');
      assert(structureChart({ type: 'structure', title: 't', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }, { id: 'b', text: 'B', x: 400, y: 0, state: 'ok' }], edges: [['a', 'b', 'ok']] }).includes('class="edge ok"'), '明示した確度を使わない');
      const m = s.match(/class="edge[^"]*" d="M([\d.]+) [\d.]+ L([\d.]+)/);
      assert(m && Number(m[1]) === 180 && Number(m[2]) === 400, '矢印が縁で切れていない: ' + (m && m.slice(1)));
    });
    t('[R06] 図には問い・凡例・表（details）・出典が付く', () => {
      const h = renderFigure(fig);
      assert(h.includes('この図が答える問い: 問い合わせは増えたか') && h.includes('<details><summary>数値で見る（表）') && h.includes('図の出典: 正本 3.1') && h.includes('期間の平均'), '付属物の欠け');
    });
    t('[R07] 形の検査: 未知の図・問いと出典の欠け・ラベルの誤り・「言えないこと」の欠けを拾う', () => {
      const d = sample();
      d.slides[0].figure.type = 'pie'; delete d.slides[0].figure.question; d.slides[0].figure.source = ' ';
      d.slides[0].label = 'strong'; d.slides[2].role = 'x';
      const e = validateDeck(d).join('\n');
      for (const k of ['未知の図の種別', 'question', 'source（数字の出典）', 'label（根拠の強さ）', '言えないこと']) assert(e.includes(k), '拾わない: ' + k + '\n' + e);
    });
    t('[R08] 形の検査: 負の値・数の不一致・存在しない辺・重複した id を拾い、正しい構成は通す', () => {
      assert(validateDeck(sample()).length === 0, '正しい構成を止めた: ' + validateDeck(sample()).join(' / '));
      const e1 = validateFigure({ ...fig, values: [1, -2, 3, 4] }, 'f').join(' ');
      const e2 = validateFigure({ ...fig, labels: ['a'] }, 'f').join(' ');
      const e3 = validateFigure({ type: 'structure', title: 't', question: 'q', source: 's', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }, { id: 'a', text: 'B', x: 0, y: 0, state: 'ok' }], edges: [['a', 'z']] }, 'f').join(' ');
      assert(/0 以上/.test(e1) && /数が違う/.test(e2) && /重複/.test(e3) && /edges/.test(e3), [e1, e2, e3].join(' | '));
      const e4 = validateFigure({ type: 'step', title: 't', question: 'q', source: 's', labels: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }], planFrom: 2 }, 'f').join(' ');
      const e5 = validateFigure({ type: 'structure', title: 't', question: 'q', source: 's', nodes: [{ id: 'a', text: 'A', x: 600, y: 0, state: 'ok' }] }, 'f').join(' ');
      assert(/planFrom/.test(e4) && /x（0〜540）/.test(e5), [e4, e5].join(' | '));
    });
    t('[R09] トークン: 実名版・マスク版に展開し、書き方の誤りは止める', () => {
      assert(expandTokens('a[[実|伏]]b', 'real') === 'a実b' && expandTokens('a[[実|伏]]b', 'masked') === 'a伏b' && expandTokens('[[実|]]x', 'masked') === 'x', '展開');
      throwsLike(() => expandTokens('a[[実]]b', 'masked'), /トークン/, '| の無いトークンを通した');
      throwsLike(() => expandTokens('a[[実|伏b', 'masked'), /トークン/, '閉じていないトークンを通した');
    });
    t('[R10] 外部参照: 各形を拾い（陽性対照）、テンプレートと正しい出力は 0 件', () => {
      assert(externalSelfCheck() === EXTERNAL_PATTERNS.length, '陽性対照');
      assert(findExternalRefs(tpl).length === 0, 'テンプレートに外部参照: ' + findExternalRefs(tpl).join(','));
      const d = mapStrings(sample(), (s) => expandTokens(s, 'masked'));
      assert(findExternalRefs(renderDeck(d, tpl, 'masked', 'x')).length === 0, '出力に外部参照');
      assert(findExternalRefs('<a href="#s01">').length === 0 && findExternalRefs('marker-end="url(#ah)"').length === 0, 'ページ内の参照を外部とした');
    });
    t('[R11] マスク漏れ: 本文・属性・title・空白を挟んだ形・全角・ファイル名で拾う', () => {
      const w = ['ABC商事'];
      assert(findMaskLeaks('<p>ＡＢＣ商事</p>', w).length === 1, '全角');
      assert(findMaskLeaks('<td>A B C 商 事</td>', w).length === 1, '空白を挟んだ形');
      assert(findMaskLeaks('<svg aria-label="ABC商事"></svg>', w).length === 1, '属性');
      assert(findMaskLeaks('<x>abc&amp;商事</x>', ['abc&商事']).length === 1, 'エンティティ');
      assert(findMaskLeaks('', w, ['deck-abc商事.html']).length === 1, 'ファイル名');
      assert(findMaskLeaks('<p>別の店</p>', w).length === 0, '誤検出');
      assert(maskSelfCheck(w) === 1, '陽性対照');
    });
    t('[R12] 表示の静的な検査: viewport の欠けと 390px を超える固定幅を拾う', () => {
      assert(staticLayoutProblems(tpl.replace(/<meta name="viewport"[^>]*>/, '')).length === 1, 'viewport の欠け');
      assert(staticLayoutProblems('<meta name="viewport"><svg width="720"></svg>').length === 1 && staticLayoutProblems('<meta name="viewport"><div style="min-width: 900px"></div>').length === 1, '固定幅');
      assert(staticLayoutProblems(tpl).length === 0, 'テンプレートを止めた');
    });
    t('[R13] 数字の一覧: 本文と図のデータから取り、目盛り・座標は含めない', () => {
      const d = mapStrings(sample(), (s) => expandTokens(s, 'masked'));
      const vals = collectNumbers(d).map((n) => n.value);
      for (const v of ['2', '12', '15', '30', '8', '13.5']) assert(vals.includes(v), '取れない: ' + v + ' / ' + vals.join(','));
      assert(!collectNumbers({ title: 'x', slides: [{ head: 'h', figure: { type: 'structure', nodes: [{ id: 'a', text: 'A', x: 123, y: 456, state: 'ok' }] } }] }).some((n) => n.value === '123' || n.value === '456'), '座標を数字に含めた');
    });
    t('[R14] build: 既定はマスク版だけを書き、伏せる語の一覧が無ければ止める', () => {
      const deck = writeJson('d1.json', sample());
      const out = path.join(base, 'o1');
      throwsLike(() => build({ deckFile: deck, outDir: out }), /伏せる語の一覧が要る/, '一覧なしでマスク版を作った');
      const r = build({ deckFile: deck, outDir: out, maskWordsFile: wordsFile });
      const files = fs.readdirSync(out).sort();
      assert(JSON.stringify(files) === JSON.stringify(['deck.masked.html', 'deck.numbers.json']), '既定で作ったファイル: ' + files.join(','));
      const html = fs.readFileSync(path.join(out, 'deck.masked.html'), 'utf8');
      assert(!html.includes('北山商店') && html.includes('ある店舗') && html.includes('マスク版'), 'マスクの展開');
      assert(r.report.some((l) => l.includes('陽性対照 OK') && l.includes('伏せる語 1 語')), '報告に陽性対照が無い');
    });
    t('[R15] build: トークンで包み忘れた語が残れば、何も書かずに止める', () => {
      const d = sample(); d.slides[0].figure.title = '北山商店の件数';
      const out = path.join(base, 'o2');
      throwsLike(() => build({ deckFile: writeJson('d2.json', d), outDir: out, maskWordsFile: wordsFile }), /伏せる語が残っている/, '包み忘れを通した');
      assert(!fs.existsSync(out), '止めたのに書いた');
    });
    t('[R16] build: 実名版は明示したときだけ。both は 2 本、数字の件数を返す', () => {
      const out = path.join(base, 'o3');
      const r = build({ deckFile: writeJson('d3.json', sample()), outDir: out, variants: 'both', maskWordsFile: wordsFile, name: 'x' });
      assert(fs.existsSync(path.join(out, 'x.real.html')) && fs.existsSync(path.join(out, 'x.masked.html')), '2 本作らない');
      assert(fs.readFileSync(path.join(out, 'x.real.html'), 'utf8').includes('北山商店'), '実名版に実名が無い');
      const nj = JSON.parse(fs.readFileSync(path.join(out, 'x.numbers.json'), 'utf8'));
      assert(nj.count === r.numbers && nj.count === nj.numbers.length && nj.count > 0, '数字の件数');
    });
    t('[R17] build: 形の誤り・外部参照のあるテンプレート・読めないテンプレートでは書かない', () => {
      const d = sample(); delete d.slides[0].source;
      throwsLike(() => build({ deckFile: writeJson('d4.json', d), outDir: path.join(base, 'o4'), maskWordsNone: true }), /形の誤り/, '形の誤りを通した');
      const bad = path.join(base, 'bad.html'); fs.writeFileSync(bad, tpl.replace('</style>', '@import "x.css";</style>'));
      throwsLike(() => build({ deckFile: writeJson('d5.json', sample()), outDir: path.join(base, 'o5'), maskWordsNone: true, template: bad }), /テンプレートに外部参照/, '外部参照のあるテンプレートを通した');
      throwsLike(() => build({ deckFile: writeJson('d6.json', sample()), outDir: path.join(base, 'o6'), maskWordsNone: true, template: path.join(base, 'none.html') }), /テンプレートを読めない/, '読めないテンプレートで続けた');
      assert(!['o4', 'o5', 'o6'].some((n) => fs.existsSync(path.join(base, n))), '止めたのに書いた');
    });
    t('[R18] build: 本文に URL・外部の参照を書くと止める（文字として書いても止める）', () => {
      const d = sample(); d.slides[0].body.push('詳しくは https://example.invalid/a を見る');
      throwsLike(() => build({ deckFile: writeJson('d7.json', d), outDir: path.join(base, 'o7'), maskWordsNone: true }), /外部参照がある/, '本文の URL を通した');
    });
    t('[R19] CLI: 終了コード（成功 0・検査で止めた 1・入力の誤り 2）', () => {
      const run = (args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8' });
      assert(run(['build', writeJson('d8.json', sample()), path.join(base, 'o8'), '--mask-words', wordsFile]).status === 0, '成功が 0 でない');
      const d = sample(); d.title = '北山商店';
      assert(run(['build', writeJson('d9.json', d), path.join(base, 'o9'), '--mask-words', wordsFile]).status === 1, '漏れが 1 でない');
      assert(run(['build', writeJson('d10.json', sample()), path.join(base, 'o10')]).status === 2, '一覧なしが 2 でない');
      assert(run(['build', 'x']).status === 2 && run(['build', 'a', 'b', '--variants']).status === 2, '使い方の誤りが 2 でない');
    });
    t('[R20] 伏せる語の一覧: 空・読めない・両方の指定は止める', () => {
      const empty = path.join(base, 'empty.txt'); fs.writeFileSync(empty, '# だけ\n\n');
      throwsLike(() => readMaskWords(empty), /空/, '空の一覧を通した');
      throwsLike(() => readMaskWords(path.join(base, 'nope.txt')), /読めない/, '読めない一覧を通した');
      throwsLike(() => build({ deckFile: writeJson('d11.json', sample()), outDir: path.join(base, 'o11'), maskWordsFile: wordsFile, maskWordsNone: true }), /同時に指定できない/, '両方の指定を通した');
    });
    t('[R24] 表紙の読み方には、使ったラベルだけを並べる', () => {
      const d = mapStrings(sample(), (s) => expandTokens(s, 'masked'));
      const h = renderDeck(d, tpl, 'masked', 'x');
      const cover = h.slice(h.indexOf('<header class="cover">'), h.indexOf('</header>'));
      assert(cover.includes('chip fact') && cover.includes('chip hyp') && !cover.includes('chip ai') && !cover.includes('chip prop'), '使っていないラベルを並べた');
    });
    t('[R25] 数字の一覧の網羅: 図の題・ラベル・構造図の文字・全角の数字も一覧に入り、資料に見えている数字はすべて一覧にある', () => {
      const d = mapStrings(sample(), (s) => expandTokens(s, 'masked'));
      d.slides[0].figure.title = '２０２５年度の週ごとの件数';
      d.slides.push({ kicker: '構造', head: 'h', label: 'hyp', source: '正本 5', figure: { type: 'structure', title: '構造', question: 'q', source: 's', nodes: [{ id: 'a', text: '待ち 45 分', x: 0, y: 0, state: 'ind' }] } });
      const nums = collectNumbers(d).map((n) => n.value);
      for (const v of ['2025', '45', '1', '5']) assert(nums.includes(v), '一覧に入らない: ' + v);
      const html = renderDeck(d, tpl, 'masked', '2026-01-01 00:00 UTC');
      assert(missingNumbers(html, collectNumbers(d)).length === 0, '見えている数字が一覧に無い: ' + missingNumbers(html, collectNumbers(d)).join(','));
      assert(missingNumbers(html, collectNumbers(d).filter((n) => n.value !== '45')).includes('45'), '一覧から抜いた数字を拾わない');
      assert(numbersSelfCheck() === 2, '陽性対照');
      throwsLike(() => numbersSelfCheck(() => []), /働かない/, '働かない網羅の照合を通した');
    });
    t('[R26] 形の検査: 本文の要素の中身・文字数の上限・配列でない値を拾う（undefined・null を描かない）', () => {
      const d = sample();
      d.slides[0].body.push({ cards: [{ text: 'x' }] }, { tiles: [{ value: '1' }] }, { p: null }, { list: 'abc' });
      d.slides[0].figure.labels[0] = '十一文字を超えるとても長い軸ラベル';
      d.slides[0].figure.avg = { from: 0 };
      const e = validateDeck(d).join('\n');
      for (const k of ['cards', 'tiles', '.p は', '.list は', 'labels は', 'avg は配列']) assert(e.includes(k), '拾わない: ' + k + '\n' + e);
      assert(schemaSelfCheck() > 0, '陽性対照');
      throwsLike(() => schemaSelfCheck(() => []), /働かない/, '働かない形の検査を通した');
    });
    t('[R27] マスク漏れ: ゼロ幅の文字・ダッシュの異体を挟んでも拾う', () => {
      assert(findMaskLeaks('<p>北山\u200b商店</p>', ['北山商店']).length === 1, 'ゼロ幅');
      assert(findMaskLeaks('<p>A\u2010B 社</p>', ['A-B社']).length === 1, 'ダッシュの異体');
    });
    t('[R28] 外部参照: ftp・file・mailto・UNC の形も拾う', () => {
      for (const s of ['ftp://a.invalid/x', 'file:///C:/x', 'mailto:a' + '@' + 'b.invalid', '\\\\server\\share\\x']) assert(findExternalRefs(s).length > 0, '拾わない: ' + s);
    });
    t('[R29] 表示の静的な検査: <style> の中の固定幅を拾い、.wide の規則と max-width は除く', () => {
      assert(staticLayoutProblems('<meta name="viewport"><style>main { width: 1000px; }</style>').length === 1, '<style> の固定幅');
      assert(staticLayoutProblems('<meta name="viewport"><style>.wide .chart { min-width: 720px; } main { max-width: 980px; }</style>').length === 0, '除外の誤り');
      assert(staticLayoutProblems("<meta name=\"viewport\"><div style='inline-size:900px'></div>").length === 1, '単引用符・inline-size');
      assert(layoutSelfCheck() === 5, '陽性対照');
      throwsLike(() => layoutSelfCheck(() => []), /働かない/, '働かない検査を通した');
    });
    t('[R30] build: 構成・伏せる語の一覧が出力先の中にあれば止め、今回作らない古い実名版が残っていれば止める', () => {
      const out = path.join(base, 'o13');
      fs.mkdirSync(out, { recursive: true });
      const inDeck = path.join(out, 'deck.json'); fs.writeFileSync(inDeck, JSON.stringify(sample()));
      throwsLike(() => build({ deckFile: inDeck, outDir: out, maskWordsFile: wordsFile }), /出力先の中にある/, '出力先の中の構成を受け付けた');
      const inWords = path.join(out, 'w.txt'); fs.writeFileSync(inWords, '北山商店\n');
      throwsLike(() => build({ deckFile: writeJson('d13.json', sample()), outDir: out, maskWordsFile: inWords }), /出力先の中にある/, '出力先の中の一覧を受け付けた');
      fs.rmSync(inDeck); fs.rmSync(inWords);
      fs.writeFileSync(path.join(out, 'deck.real.html'), 'old');
      throwsLike(() => build({ deckFile: writeJson('d14.json', sample()), outDir: out, maskWordsFile: wordsFile }), /残っている/, '古い実名版が残っていても作った');
      assert(!fs.existsSync(path.join(out, 'deck.masked.html')) && fs.readdirSync(out).every((n) => !n.includes('.tmp-')), '止めたのに書いた');
    });
    t('[R31] build: 一時の名前で書いてから改名し、数字の一覧も同じく照合する（一時のファイルを残さない）', () => {
      const out = path.join(base, 'o14');
      build({ deckFile: writeJson('d15.json', sample()), outDir: out, maskWordsFile: wordsFile });
      const files = fs.readdirSync(out);
      assert(files.every((n) => !n.includes('.tmp-')) && files.includes('deck.numbers.json'), '一時のファイルが残った: ' + files.join(','));
    });
    t('[R32] build: 一覧に無い数字が資料に見えていれば止める（描き方を変えて一覧と食い違ったとき）', () => {
      const t2 = path.join(base, 'num.html'); fs.writeFileSync(t2, tpl.replace('{{SLIDES}}', '<p>注 987</p>{{SLIDES}}'));
      throwsLike(() => build({ deckFile: writeJson('d16.json', sample()), outDir: path.join(base, 'o16'), maskWordsNone: true, template: t2 }), /数字の一覧から漏れた/, '一覧に無い数字を通した');
      assert(!fs.existsSync(path.join(base, 'o16')), '止めたのに書いた');
    });
    t('[R33] build: 作り直しでは前の出力を置き換え、退避も一時のファイルも残さない', () => {
      const out = path.join(base, 'o17');
      build({ deckFile: writeJson('d17.json', sample()), outDir: out, maskWordsFile: wordsFile });
      const d = sample(); d.title = '作り直した題';
      build({ deckFile: writeJson('d18.json', d), outDir: out, maskWordsFile: wordsFile });
      assert(fs.readFileSync(path.join(out, 'deck.masked.html'), 'utf8').includes('作り直した題'), '置き換わらない');
      assert(fs.readdirSync(out).every((n) => !n.includes('.tmp-')), '退避・一時のファイルが残った: ' + fs.readdirSync(out).join(','));
    });
    t('[R34] 形の検査: 知らないキーを止め、構造図の辺の id は数字の一覧に入れない', () => {
      const d = sample(); d.memo = '30'; d.slides[0].extra = 1; d.slides[0].figure.edges = [];
      const e = validateDeck(d).join('\n');
      assert(/知らないキー: memo/.test(e) && /知らないキー: extra/.test(e) && /使わないキー: edges/.test(e), e);
      const nums = collectNumbers({ title: 't', slides: [{ head: 'h', figure: { type: 'structure', nodes: [{ id: 'n1', text: 'A', x: 0, y: 0, state: 'ok' }, { id: 'n2', text: 'B', x: 300, y: 0, state: 'ok' }], edges: [['n1', 'n2']] } }] });
      assert(!nums.some((n) => n.value === '1' || n.value === '2'), '辺の id を数字に含めた: ' + nums.map((n) => n.value).join(','));
    });
    t('[R35] 出力先の中の判定: ジャンクション越し・「..x」という名前のフォルダも中と判定する', () => {
      const out = path.join(base, 'o18'); fs.mkdirSync(path.join(out, '..x'), { recursive: true });
      const link = path.join(base, 'o18link'); fs.symlinkSync(out, link, 'junction');
      assert(inside(path.join(link, 'deck.json'), out), 'ジャンクション越しを外とした');
      assert(inside(path.join(out, '..x', 'deck.json'), out), '「..x」を外とした');
      assert(!inside(path.join(base, 'elsewhere', 'deck.json'), out), '外を中とした');
    });
    t('[R36] build: 前の実行の一時のファイル・退避が残っていれば止め、別の名前の実名版は注意として報告する', () => {
      const out = path.join(base, 'o19'); fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'deck.masked.html.tmp-0123abcd'), 'x');
      throwsLike(() => build({ deckFile: writeJson('d19.json', sample()), outDir: out, maskWordsFile: wordsFile }), /一時のファイル・退避/, '残りがあっても作った');
      fs.rmSync(path.join(out, 'deck.masked.html.tmp-0123abcd'));
      fs.writeFileSync(path.join(out, 'other.real.html'), 'x');
      const r = build({ deckFile: writeJson('d20.json', sample()), outDir: out, maskWordsFile: wordsFile });
      assert(r.report.some((l) => l.includes('別の名前の実名版が 1 本')), '別の実名版を報告しない');
    });
    t('[R37] 数字の一覧: タイルのラベルの数字も入る（同じ値が 2 か所に見えるときは 2 件）', () => {
      const d = { title: 't', slides: [{ kicker: 'k', head: 'h', label: 'fact', source: 's', body: [{ tiles: [{ value: '30 件', label: '第 30 週' }] }] }] };
      assert(collectNumbers(d).filter((n) => n.value === '30').length === 2, '2 か所の 30 を 1 件にした: ' + JSON.stringify(collectNumbers(d)));
    });
    t('[R38] マスク漏れ: タグをまたいで表示ではつながる語・16 進の文字参照も拾う', () => {
      assert(findMaskLeaks('<h3><span class="mark">北山</span>商店</h3>', ['北山商店']).length === 1, 'タグをまたぐ語');
      assert(findMaskLeaks('<p>&#x5317;&#x5c71;商店</p>', ['北山商店']).length === 1, '16 進の文字参照');
    });
    t('[R39] 形の検査: 安全な範囲を超える整数・文字列の partialLast・長すぎる系列名（2 本並び）を止める', () => {
      const e1 = validateFigure({ ...fig, values: [1, 2, 3, 9007199254740993] }, 'f').join(' ');
      const e2 = validateFigure({ ...fig, partialLast: 'false' }, 'f').join(' ');
      const e3 = validateFigure({ type: 'pair', title: 't', question: 'q', source: 's', names: ['とても長い系列の名前です', 'b'], groups: [{ label: 'g', a: 1, b: 2 }] }, 'f').join(' ');
      assert(/0 以上の数/.test(e1) && /partialLast/.test(e2) && /names/.test(e3), [e1, e2, e3].join(' | '));
    });
    t('[R40] 書き出し: 正式な名前にする途中で失敗したら、前の出力を戻し、一時のファイルを残さない', () => {
      const out = path.join(base, 'o20');
      build({ deckFile: writeJson('d21.json', sample()), outDir: out, maskWordsFile: wordsFile });
      const before = fs.readFileSync(path.join(out, 'deck.masked.html'), 'utf8');
      // 2 本目（numbers.json）を正式な名前にするところで失敗させる
      const fsx = { ...fs, renameSync: (a, b) => { if (String(b).endsWith('deck.numbers.json') && String(a).includes('.tmp-') && !String(a).endsWith('.prev')) throw new Error('注入した失敗'); return fs.renameSync(a, b); } };
      const d = sample(); d.title = '新しい題';
      throwsLike(() => build({ deckFile: writeJson('d22.json', d), outDir: out, maskWordsFile: wordsFile, fsx }), /注入した失敗/, '失敗を伝えない');
      assert(fs.readFileSync(path.join(out, 'deck.masked.html'), 'utf8') === before, '前の出力に戻っていない');
      assert(fs.readdirSync(out).every((n) => !n.includes('.tmp-')), '一時のファイル・退避が残った: ' + fs.readdirSync(out).join(','));
    });
    t('[R41] 書き出し: 前の出力の退避を消せなければ、成功として終えない（一部が残る状態として止める）', () => {
      const out = path.join(base, 'o21');
      build({ deckFile: writeJson('d23.json', sample()), outDir: out, maskWordsFile: wordsFile });
      const fsx = { ...fs, rmSync: (p, o) => { if (String(p).endsWith('.prev')) throw new Error('消せない'); return fs.rmSync(p, o); } };
      let err = null;
      try { build({ deckFile: writeJson('d24.json', sample()), outDir: out, maskWordsFile: wordsFile, fsx }); } catch (e) { err = e; }
      assert(err && err.partial && /退避を消せなかった/.test(err.message), '退避が残っても成功にした: ' + (err && err.message));
      for (const n of fs.readdirSync(out).filter((x) => x.endsWith('.prev'))) fs.rmSync(path.join(out, n));
    });
    t('[R42] CLI: 器（テンプレート）は差し替えられない', () => {
      const r = spawnSync(process.execPath, [SELF, 'build', writeJson('d25.json', sample()), path.join(base, 'o22'), '--mask-words-none', '--template', DEFAULT_TEMPLATE], { encoding: 'utf8' });
      assert(r.status === 2 && /知らない指定: --template/.test(r.stdout), `--template を受け付けた（exit=${r.status}）`);
    });
    // 年表（timeline）。structure とは凡例・表の列名・矢印の意味が別（済み／予定であって、確度ではない）
    const tlFig = (over = {}) => ({ type: 'timeline', title: '対応の経過', question: 'いつ何があり、何が予定か', source: '正本 4', events: [{ date: '10月1日', text: '受付開始', state: 'done' }, { date: '10月8日', text: '窓口の拡充\n（2 名）', state: 'done' }, { date: '11月1日', text: '見直し会', state: 'plan' }], ...over });
    const tlErr = (over) => validateFigure(tlFig(over), 'f').join(' | ');
    t('[R43] 年表: 済みは実線・予定は破線の class、矢印は日付の順（確度の語を出さない）', () => {
      const s = timelineChart(tlFig());
      assert((s.match(/class="ev done"/g) || []).length === 2 && (s.match(/class="ev plan"/g) || []).length === 1, '枠の class');
      assert(s.includes('（済み）') && s.includes('（予定）') && s.includes('class="tag"'), '色以外の手がかり（文字）');
      assert((s.match(/class="edge seq"/g) || []).length === 2 && s.includes('受付開始 → 窓口の拡充 （2 名）（日付の順）'), '矢印は件数 - 1 本で日付の順');
      assert(/role="img"/.test(s) && s.includes('aria-label="対応の経過"'), '器の属性');
      assert(/^<svg class="chart tl" viewBox="0 0 460 /.test(s), '年表専用の幅（460）と class tl でない: ' + s.slice(0, 60));
      assert(!/<svg class="chart" /.test(s) && /^<svg class="chart" viewBox="0 0 720 /.test(structureChart({ type: 'structure', title: 't', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }], edges: [] })), '年表以外の図の器が変わった');
      const xs = [...s.matchAll(/<rect class="ev [a-z]+" x="(\d+)" y="\d+" width="(\d+)"/g)].map((m) => Number(m[1]) + Number(m[2]));
      assert(xs.length === 3 && xs.every((x) => x <= 460), '枠が viewBox の幅を超える: ' + xs);
      const ln = timelineChart(tlFig({ events: [{ date: 'あ'.repeat(12), text: 'あ', state: 'done' }, { date: 'b', text: 'c', state: 'plan' }] }));
      assert(/class="evdate"[^>]*textLength="112"/.test(ln) && !/class="evdate"[^>]*textLength[^>]*>b</.test(ln) && !/textLength/.test(timelineChart(tlFig())), '長い日付だけ列に収める（短い日付は引き伸ばさない）');
      assert(!/確認済み|間接的|未確認/.test(s), '確度の語が年表に出た');
      const ys = [...s.matchAll(/<rect class="ev [a-z]+" x="\d+" y="(\d+)"/g)].map((m) => Number(m[1]));
      assert(ys.length === 3 && ys[0] < ys[1] && ys[1] < ys[2], '上から下の並びでない: ' + ys);
    });
    t('[R44] 年表: 凡例は専用（済み・予定・順番）で、structure の凡例を含まない。structure の凡例は変わらない', () => {
      const h = renderFigure(tlFig());
      const lg = h.match(/<div class="legend">[\s\S]*?<\/div>/)[0];
      assert(lg.includes('実線の枠＝済み') && lg.includes('破線の枠＝予定') && lg.includes('矢印は日付の順番（因果の確かさではない）'), '専用の凡例の欠け: ' + lg);
      assert(!/確認済み|間接的|未確認|確度/.test(lg), 'structure の凡例が混ざった: ' + lg);
      const sl = renderFigure({ type: 'structure', title: 't', question: 'q', source: 's', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }, { id: 'b', text: 'B', x: 200, y: 0, state: 'ind' }, { id: 'c', text: 'C', x: 400, y: 0, state: 'no' }], edges: [] });
      assert(sl.includes('確認済み') && sl.includes('間接的') && sl.includes('未確認') && sl.includes('枠は事実の確度') && sl.includes('<th>確度</th>') && sl.includes('<summary>表で見る') && !sl.includes('済み、') && !sl.includes('実線の枠＝済み'), 'structure の表示が変わった');
    });
    t('[R45] 年表: 表で見る の列は 日付・出来事・状態（済み／予定）で、「確度」「確認済み」を出さない', () => {
      const h = renderFigure(tlFig());
      const tb = h.match(/<details>[\s\S]*<\/details>/)[0];
      assert(tb.includes('<summary>表で見る') && tb.includes('<th>日付</th><th>出来事</th><th>状態</th>'), '列名: ' + tb);
      assert(tb.includes('<td>10月1日</td><td>受付開始</td><td>済み</td>') && tb.includes('<td>窓口の拡充 （2 名）</td>') && tb.includes('<td>予定</td>'), '行の内容');
      assert(!/確度|確認済み|間接的|未確認/.test(h.replace(/<p class="q">[\s\S]*?<\/p>/, '')), '年表の出力に確度の語: ');
    });
    t('[R46] 年表の形の検査: 正しい構成は通し、件数・型・state・空・長さ・知らないキー・使わないキーを止める', () => {
      assert(validateFigure(tlFig(), 'f').length === 0, '正しい年表を止めた: ' + tlErr({}));
      const ev = (n) => Array.from({ length: n }, (_, i) => ({ date: `${i + 1}日`, text: 'あ', state: 'done' }));
      assert(validateFigure(tlFig({ events: ev(2) }), 'f').length === 0 && validateFigure(tlFig({ events: ev(12) }), 'f').length === 0, '2・12 件の境界を止めた');
      assert(/2〜12 件/.test(tlErr({ events: ev(1) })) && /2〜12 件/.test(tlErr({ events: ev(13) })) && /2〜12 件/.test(tlErr({ events: undefined })) && /2〜12 件/.test(tlErr({ events: 'x' })), '件数');
      assert(/state は done/.test(tlErr({ events: [{ date: 'a', text: 'b', state: 'ok' }, { date: 'c', text: 'd', state: 'plan' }] })), 'state（structure の値は通さない）');
      assert(/date は空でない/.test(tlErr({ events: [{ date: ' ', text: 'b', state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] })) && /text は空でない/.test(tlErr({ events: [{ date: 'a', text: '', state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] })), '空');
      assert(/date は空でない.*12 文字/.test(tlErr({ events: [{ date: 'あ'.repeat(13), text: 'b', state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] })) && validateFigure(tlFig({ events: [{ date: 'a', text: 'あ'.repeat(16) + '\n' + 'い'.repeat(16), state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] }), 'f').length === 0 && /2 行まで/.test(tlErr({ events: [{ date: 'a', text: 'a\nb\nc', state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] })) && /1 行 16 文字/.test(tlErr({ events: [{ date: 'a', text: 'あ'.repeat(17), state: 'done' }, { date: 'c', text: 'd', state: 'plan' }] })), '長さ・行数');
      assert(/events\[0\]: 知らないキー: x/.test(tlErr({ events: [{ date: 'a', text: 'b', state: 'done', x: 1 }, { date: 'c', text: 'd', state: 'plan' }] })) && /events\[1\] がオブジェクトではない/.test(tlErr({ events: [{ date: 'a', text: 'b', state: 'done' }, 'x'] })), '知らないキー・型');
      assert(/使わないキー: nodes/.test(tlErr({ nodes: [] })) && /使わないキー: events/.test(validateFigure({ type: 'structure', title: 't', question: 'q', source: 's', nodes: [{ id: 'a', text: 'A', x: 0, y: 0, state: 'ok' }], events: [] }, 'f').join(' ')), '型をまたぐキー');
      assert(!/ev\.date|undefined/.test(tlErr({ events: [null, 3] })) && /events\[0\] がオブジェクトではない/.test(tlErr({ events: [null, 3] })), 'null・数値の要素で落ちない');
    });
    t('[R47] 年表の数字の一覧: date と text の数字は入り、state は入らない。並びは配列の順のまま', () => {
      const d = { title: 't', slides: [{ head: 'h', figure: tlFig({ events: [{ date: '2026年11月3日', text: '会議 45 分', state: 'plan' }, { date: '10月1日', text: 'あ', state: 'done' }] }) }] };
      const vals = collectNumbers(d).map((n) => n.value);
      for (const v of ['2026', '11', '3', '45', '10', '1']) assert(vals.includes(v), '取れない: ' + v + ' / ' + vals.join(','));
      assert(timelineChart(d.slides[0].figure).indexOf('2026年11月3日') < timelineChart(d.slides[0].figure).indexOf('10月1日'), '自動で並べ替えた');
      const h = renderDeck({ title: 't', slides: [{ kicker: 'k', head: 'h', label: 'fact', source: 's', figure: d.slides[0].figure }] }, tpl, 'masked', 'x');
      assert(missingNumbers(h, collectNumbers({ title: 't', slides: [{ kicker: 'k', head: 'h', label: 'fact', source: 's', figure: d.slides[0].figure }] })).length === 0, '表示された数字が一覧に無い');
    });
    // 型ごとの見本（架空の題材）。正しい構成を通し、1 つ欠けるごとに拾うことを確かめる
    const typed = (type) => {
      const lim = { kicker: '言えないこと', head: '原因は確かめていない', label: 'hyp', role: 'limits', source: '正本 6', body: [{ list: ['因果は未証明'] }] };
      const con = (body, extra = {}) => ({ kicker: '結論', head: '結論の 1 文', label: 'fact', role: 'conclusion', source: '正本 1', body, ...extra });
      const tl = { type: 'timeline', title: '経過', question: 'いつ何が起きたか', source: '正本 2', events: [{ date: '1月5日', text: '発生', state: 'done' }, { date: '1月9日', text: '対応', state: 'plan' }] };
      const three = [{ cards: [{ title: '事象', text: 'a' }, { title: '原因', text: 'b' }, { title: '対応', text: 'c' }] }];
      if (type === 'decision') return { title: 't', type, slides: [con(['採る案は A']), { kicker: '比較', head: 'A と B の比較', label: 'fact', role: 'compare', source: '正本 3', body: [{ cards: [{ title: 'A', mark: '採る', kind: 'good' }, { title: 'B', mark: '採らない', kind: 'bad' }] }] }, { kicker: '確認したいこと', head: '決めてほしいこと', label: 'prop', role: 'decide', source: '正本 4', body: [{ list: ['A で進めてよいか'] }] }, lim] };
      if (type === 'incident') return { title: 't', type, slides: [con(three), { kicker: '事象', head: '経過', label: 'fact', source: '正本 2', figure: tl }, lim] };
      if (type === 'investigation') return { title: 't', type, slides: [con(['分かったこと']), { kicker: '次の調査', head: '次に確かめる', label: 'prop', role: 'next', source: '正本 5', body: ['x'] }, lim] };
      const chap = { kicker: '第 1 章', head: '仕組みは A が B を作る', label: 'fact', source: '正本 3', goal: ['A が言える', 'B が分かる'], checks: [{ q: '問い', a: '答え' }], body: ['x'] };
      return { title: 't', type: 'reader', slides: [con([{ terms: [{ word: '依頼', means: '送信の注文', unit: '1 行＝1 件の注文' }] }], { figure: JSON.parse(JSON.stringify(fig)) }), chap, lim] };
    };
    t('[R48] 型の検査: 4 つの型の正しい構成は通し、型・結論の章・型ごとの必須の節の欠けを拾う', () => {
      for (const ty of ['decision', 'incident', 'investigation', 'reader']) assert(validateDeck(typed(ty)).length === 0, ty + ' を止めた: ' + validateDeck(typed(ty)).join(' / '));
      const err = (fn) => { const d = typed(fn.type); fn.mut(d); return validateDeck(d).join('\n'); };
      const cases = [
        ['type が無い', 'investigation', (d) => { delete d.type; }, 'type（資料の型）'],
        ['未知の型', 'investigation', (d) => { d.type = 'memo'; }, 'type（資料の型）'],
        ['結論の章が 1 ページ目に無い', 'investigation', (d) => { delete d.slides[0].role; }, 'conclusion'],
        ['未知の role', 'investigation', (d) => { d.slides[1].role = 'x'; }, 'role は決めた値'],
        ['決裁: 比較が無い', 'decision', (d) => { d.slides[1].role = 'appendix'; }, 'role: "compare"'],
        ['決裁: 確認したいことが無い', 'decision', (d) => { d.slides[2].role = 'appendix'; }, 'role: "decide"'],
        ['調査: 次の調査が無い', 'investigation', (d) => { d.slides[1].role = 'appendix'; }, 'role: "next"'],
        ['障害: 3 点が 2 点', 'incident', (d) => { d.slides[0].body[0].cards.pop(); }, '3 点'],
        ['障害: 時系列が無い', 'incident', (d) => { delete d.slides[1].figure; }, 'timeline'],
        ['読本: 全体像の図が無い', 'reader', (d) => { delete d.slides[0].figure; }, '全体像の図'],
        ['読本: 用語表が無い', 'reader', (d) => { d.slides[0].body = ['x']; }, '用語表'],
        ['読本: ゴールが 1 件', 'reader', (d) => { d.slides[1].goal = ['A が言える']; }, 'goal'],
        ['読本: 確認の問いが無い', 'reader', (d) => { delete d.slides[1].checks; }, 'checks'],
        ['読本: 確認の問いの答えが無い', 'reader', (d) => { d.slides[1].checks = [{ q: '問い' }]; }, 'checks は'],
        ['用語表の単位が文字列でない', 'reader', (d) => { d.slides[0].body[0].terms[0].unit = 3; }, 'terms'],
      ];
      for (const [name, ty, mut, key] of cases) assert(err({ type: ty, mut }).includes(key), '拾わない: ' + name + '\n' + err({ type: ty, mut }));
    });
    t('[R49] 型の表示: 表紙に型と「読んだ後にできること」、章のゴール・確認の問い（答えは折りたたみ）・用語表・結論の章の印が出る', () => {
      const d = mapStrings(typed('reader'), (x) => expandTokens(x, 'masked'));
      const h = renderDeck(d, tpl, 'masked', 'x');
      const cover = h.slice(h.indexOf('<header class="cover">'), h.indexOf('</header>'));
      assert(cover.includes('資料の型: 読本・解説') && cover.includes('読んだ後にできること: 仕組みを説明でき'), '表紙に型が出ない');
      assert(h.includes('<div class="goal"><p class="gt">この章のゴール</p>') && h.includes('A が言える'), 'ゴールが出ない');
      assert(h.includes('<div class="checks"><p class="gt">これに答えられたら次へ</p><details><summary>問い</summary><p>答え</p></details>'), '確認の問いが折りたたみで出ない');
      assert(h.includes('<table class="terms">') && h.includes('1 行が指すもの') && h.includes('1 行＝1 件の注文'), '用語表が出ない');
      assert(h.includes('class="slide conclusion"'), '結論の章の印が無い');
      assert(!h.includes('<script') && findExternalRefs(h).length === 0, '外部参照が入った');
    });
    t('[R50] カード: ちょうど 3 件のときだけ 3 列の印（n3）が付く（事象・原因・対応を 1 画面で並べるため）', () => {
      const r = (n) => renderBlock({ cards: Array.from({ length: n }, (_, i) => ({ title: 't' + i })) });
      assert(r(3).startsWith('<div class="cards n3">'), '3 件に n3 が付かない');
      assert(r(2).startsWith('<div class="cards">') && r(4).startsWith('<div class="cards">'), '3 件以外に n3 が付いた');
    });
    t('[R51] 構造図の凡例: この図で使った確度だけを並べる（矢印の既定は未確認なので、辺の確度を書かない辺は未確認を使ったとみなす）', () => {
      const lg = (nodes, edges) => renderFigure({ type: 'structure', title: 't', question: 'q', source: 's', nodes, edges }).match(/<div class="legend">[\s\S]*?<\/div>/)[0];
      const n = (id, x, state) => ({ id, text: id, x, y: 0, state });
      const onlyOk = lg([n('a', 0, 'ok'), n('b', 200, 'ok')], [['a', 'b', 'ok']]);
      assert(onlyOk.includes('確認済み') && !onlyOk.includes('間接的') && !onlyOk.includes('未確認'), '使っていない線種を並べた: ' + onlyOk);
      const dflt = lg([n('a', 0, 'ok'), n('b', 200, 'ok')], [['a', 'b']]);
      assert(dflt.includes('確認済み') && dflt.includes('未確認') && !dflt.includes('間接的'), '辺の既定（未確認）が凡例に出ない: ' + dflt);
      assert(onlyOk.includes('枠は事実の確度'), '読み方の注意が消えた');
    });
    t('[R21] 外部参照の陽性対照: 検出が働かない形があれば止める', () => {
      throwsLike(() => externalSelfCheck(() => []), /検出が働かない/, '働かない検出を通した');
      throwsLike(() => externalSelfCheck((s) => findExternalRefs(s).filter((n) => n !== 'srcset')), /srcset/, '1 形だけ働かない検出を通した');
    });
    t('[R22] マスク漏れの陽性対照: 検出が働かなければ止める', () => {
      throwsLike(() => maskSelfCheck(['語'], () => []), /検出が働かない/, '働かない検出を通した');
      throwsLike(() => maskSelfCheck(['語'], (h, w, names = []) => (names.length ? [] : findMaskLeaks(h, w))), /検出が働かない/, 'ファイル名だけ働かない検出を通した');
    });
    t('[R23] build: viewport の無いテンプレートでは書かない', () => {
      const nv = path.join(base, 'nv.html'); fs.writeFileSync(nv, tpl.replace(/<meta name="viewport"[^>]*>/, ''));
      throwsLike(() => build({ deckFile: writeJson('d12.json', sample()), outDir: path.join(base, 'o12'), maskWordsNone: true, template: nv }), /表示の静的な検査/, 'viewport の無い出力を書いた');
      assert(!fs.existsSync(path.join(base, 'o12')), '止めたのに書いた');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.m ? ' | ' + r.m : ''));
  const ng = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng} 件パス / ${ng} 件失敗`);
  return ng === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv.includes('--selftest')) process.exit((await selftest()) ? 0 : 1);
  process.exit(main(process.argv.slice(2)));
}
