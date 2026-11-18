#!/usr/bin/env node
// /ut-review の題材集（tools/ut-review-bench.json）を使って、選定の再現率と、検出の再現率を測る。
//   node tools/ut-review-bench.mjs selection             選定（チェックのチェック）が、題材ごとの必須のチェック・観点の群を選ぶか（機械で判定）
//   node tools/ut-review-bench.mjs materialize <題材 ID> <出力先>   題材のファイルを書き出す（実際に /ut-review をかけるため）
//   node tools/ut-review-bench.mjs score <題材 ID> <報告.json>      報告の指摘が、仕込んだ欠陥をいくつ拾ったか（N 件中 M 件）
//   node tools/ut-review-bench.mjs --selftest
// 命中とみなすのは、判断が確認か未確定で、ファイルが同じ・行が欠陥の行のどれか・説明（筋書き・直し方）が鍵語のどれかを含むものだけ。
// 引用（欠陥の行の原文）は鍵語を含みがちなので数えない（行を指しただけで命中にしない。部品のカナリアの採点 scoreCanary と同じ）。
// 範囲外の指摘（差分の周辺の外。outOfScope。検証していない）は、判断が未確定でも命中に数えない（範囲を絞ったことで採点が上がらないように）。
// exit: 0 全件 / 1 取りこぼしあり / 2 入力の誤り
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const core = await import(pathToFileURL(path.join(ROOT, 'commands', 'templates', 'ut-review.mjs')).href);
export const loadBench = (file = path.join(ROOT, 'tools', 'ut-review-bench.json')) => JSON.parse(fs.readFileSync(file, 'utf8'));
// 機微の型は、リポジトリの検査を通すため実行時に組み立てる
const expand = (s) => s.replace(/\{\{PW\}\}/g, 'pass' + 'word');

export function materialize(c, dir) {
  for (const f of c.files) {
    const to = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, expand(f.text));
  }
  return c.files.map((f) => f.rel);
}
export function selectionFor(c, cfg = core.loadChecks()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-review-bench-'));
  try {
    const files = materialize(c, tmp);
    const { targets } = core.collectTargets({ root: tmp, files }, cfg);
    const kinds = [...new Set(targets.map((t) => t.kind))];
    const features = core.extractFeatures(targets.map((t) => t.text), cfg, {});
    const s = core.selectChecks(cfg, { kinds, features, depth: c.depth || 'standard' });
    const on = s.rows.filter((r) => r.run).map((r) => r.check);
    return { kinds, missingChecks: c.expectChecks.filter((x) => !on.includes(x)), missingGroups: c.expectGroups.filter((x) => !s.groups.includes(x)) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export function score(c, report) {
  const fsx = (report.findings || []).filter((f) => ['確認', '未確定'].includes(f.verdict) && !f.outOfScope);
  const hits = c.defects.map((d) => ({ id: d.id, hit: fsx.some((f) => f.file === d.file && d.lines.includes(f.line) && d.keywords.some((k) => `${f.scenario || ''} ${f.fix || ''}`.toLowerCase().includes(k.toLowerCase()))) }));
  return { caught: hits.filter((h) => h.hit).length, total: hits.length, missed: hits.filter((h) => !h.hit).map((h) => h.id) };
}

function main(argv) {
  const bench = loadBench();
  const find = (id) => { const c = bench.cases.find((x) => x.id === id); if (!c) { console.log('知らない題材: ' + id); process.exit(2); } return c; };
  if (argv[0] === 'selection') {
    let bad = 0;
    for (const c of bench.cases) {
      const r = selectionFor(c);
      const ok = !r.missingChecks.length && !r.missingGroups.length;
      if (!ok) bad++;
      console.log(`  ${ok ? 'OK  ' : 'NG  '}${c.id}（${r.kinds.join(',')}）${ok ? '' : ' 選ばれなかった: ' + [...r.missingChecks, ...r.missingGroups.map((g) => '群:' + g)].join(', ')}`);
    }
    console.log(`選定の再現率: ${bench.cases.length - bad} / ${bench.cases.length}`);
    return bad ? 1 : 0;
  }
  if (argv[0] === 'materialize' && argv[2]) { console.log(materialize(find(argv[1]), path.resolve(argv[2])).join('\n')); return 0; }
  if (argv[0] === 'score' && argv[2]) {
    const r = score(find(argv[1]), JSON.parse(fs.readFileSync(argv[2], 'utf8')));
    console.log(`検出の再現率: ${r.caught} / ${r.total}${r.missed.length ? '（取りこぼし: ' + r.missed.join(', ') + '）' : ''}`);
    return r.missed.length ? 1 : 0;
  }
  console.log('使い方: node tools/ut-review-bench.mjs selection | materialize <題材 ID> <出力先> | score <題材 ID> <報告.json> | --selftest');
  return 2;
}

function selftest() {
  const { t, finish } = core.testRunner();
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const bench = loadBench();
  t('[B01] 題材集の形: 種類が 5 つ以上・各題材に欠陥と必須のチェック・欠陥の行は本文の中', () => {
    const cfg = core.loadChecks();
    assert(bench.cases.length >= 5, '題材が少ない');
    for (const c of bench.cases) {
      assert(c.defects.length && c.expectChecks.length, '欠陥・必須が無い: ' + c.id);
      for (const x of c.expectChecks) assert(cfg.checks[x], '知らないチェック: ' + x);
      for (const d of c.defects) { const f = c.files.find((y) => y.rel === d.file); assert(f && d.lines.every((l) => l >= 1 && l <= f.text.split('\n').length), '欠陥の行が本文の外: ' + c.id + ' ' + d.id); }
    }
  });
  t('[B02] 選定の再現率: 今の決定表は全題材の必須のチェックと観点の群を選ぶ', () => {
    for (const c of bench.cases) { const r = selectionFor(c); assert(!r.missingChecks.length && !r.missingGroups.length, `${c.id}: ${[...r.missingChecks, ...r.missingGroups].join(',')}`); }
  });
  t('[B03] 選定の再現率: 決定表の規則を外すと取りこぼしを検出する（陽性対照）', () => {
    const cfg = core.loadChecks();
    for (const rid of ['R-PLAN', 'R-IRREV', 'R-LLM', 'R-CODE', 'R-DOC']) {
      const broken = { ...cfg, rules: cfg.rules.filter((r) => r.id !== rid) };
      assert(bench.cases.some((c) => { const r = selectionFor(c, broken); return r.missingChecks.length || r.missingGroups.length; }), `規則 ${rid} を外しても取りこぼしにならない（題材が規則を検証していない）`);
    }
  });
  t('[B04] 採点: 行・ファイル・鍵語・判断がそろったものだけ命中', () => {
    const c = bench.cases.find((x) => x.id === 'code-js');
    const r = score(c, { findings: [
      { verdict: '確認', file: 'src/stats.js', line: 4, quote: 'for (let i = 0; i <= scores.length; i++) {', scenario: '範囲外を読む' },
      { verdict: '棄却', file: 'src/stats.js', line: 15, quote: 'catch', scenario: '握り潰す' },
      { verdict: '確認', file: 'src/other.js', line: 7, quote: 'x', scenario: '空の配列' },
      { verdict: '確認', file: 'src/stats.js', line: 1, quote: '// 点数の一覧', scenario: 'catch で握り潰す' },
    ] });
    assert(r.caught === 1 && r.missed.includes('D2') && r.missed.includes('D3'), JSON.stringify(r));
    // 範囲外の指摘（未確定・検証していない）は、行・ファイル・鍵語がそろっても命中に数えない。同じ指摘が範囲の中なら命中（陽性対照）
    const d2 = c.defects.find((d) => d.id === 'D2');
    const f2 = { verdict: '未確定', file: d2.file, line: d2.lines[0], quote: 'x', scenario: d2.keywords[0] };
    assert(score(c, { findings: [{ ...f2, outOfScope: true }] }).caught === 0, '範囲外の指摘を命中に数えた');
    assert(score(c, { findings: [f2] }).caught === 1, '範囲の中の同じ指摘を命中に数えない（陽性対照）');
  });
  t('[B06] 採点: 鍵語は筋書き・直し方だけで照合する（引用の語だけでは命中にしない。カナリアの採点と同じ）', () => {
    const c = bench.cases.find((x) => x.id === 'code-js');
    const d1 = c.defects.find((d) => d.id === 'D1');
    const q = { verdict: '確認', file: d1.file, line: d1.lines[0], quote: 'for (let i = 0; i <= scores.length; i++) {', scenario: '変数名が短い', fix: '名前を変える' };
    assert(score(c, { findings: [q] }).caught === 0, '引用の語（<=）だけで命中にした');
    assert(score(c, { findings: [{ ...q, scenario: '<= で範囲外を読む' }] }).caught === 1 && score(c, { findings: [{ ...q, fix: 'off-by-one を直す' }] }).caught === 1, '筋書き・直し方の鍵語で命中にしない（陽性対照）');
  });
  t('[B05] 機微の型は実行時に組み立て、リポジトリの JSON には生の形を置かない', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'tools', 'ut-review-bench.json'), 'utf8');
    assert(!/pass[w]ord\s*=/i.test(raw) && expand('{{PW}}=x') === 'pass' + 'word=x', '生の形がある');
  });
  return finish();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  process.exit(main(process.argv.slice(2)));
}
