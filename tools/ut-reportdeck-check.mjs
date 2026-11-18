#!/usr/bin/env node
// /ut-reportdeck の任意の表示検査。Playwright がある環境でだけ動く（この道具は Playwright を導入しない。導入は利用者が決める）。
//
//   node tools/ut-reportdeck-check.mjs <資料.html> [--playwright-dir <Playwright を入れたフォルダ>] [--shots <スクリーンショットの出力先>]
//   node tools/ut-reportdeck-check.mjs --selftest
//
// Playwright は作業フォルダ（または --playwright-dir）から探す（この道具の場所からは探さない。配備先には入っていないため）。
// 見るもの: PC 1100px・スマホ 390px・ダーク（colorScheme と data-theme の両方）で開き、
//   エラー（pageerror・console.error）、外部への通信（すべての通信を遮断して記録する。実際には外へ出ない）、
//   ページの横はみ出し（横スクロールの枠 .wide・.tw の中は除く）、明暗が切り替わること。
// 外部通信の検出は、毎回、外部の画像を含む見本で拾えることを確かめてから使う（陽性対照）。
// exit: 0 問題なし / 1 問題あり / 2 未検査（Playwright・ブラウザが無い、入力の誤り）。2 を通過として扱わない
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
export const VIEWS = [
  { name: 'PC', width: 1100, scheme: 'light' },
  { name: 'スマホ', width: 390, scheme: 'light' },
  { name: 'ダーク（colorScheme）', width: 1100, scheme: 'dark' },
  { name: 'ダーク（data-theme）', width: 1100, scheme: 'light', theme: 'dark' },
];
const LOCAL = /^(file|data|about|blob):/i;

// 検査の結果から問題の一覧を作る（Playwright に依存しない部分。selftest で確かめる）
export function judge(views) {
  const p = [];
  // 決めた表示（PC・スマホ・ダーク 2 通り）をすべて見たこと自体を確かめる（0 通りを「問題なし」にしない）
  for (const v of VIEWS) if (!views.some((x) => x.name === v.name)) p.push(`${v.name}: この表示を検査していない`);
  for (const v of views) {
    // ページが 0 枚なら、渡すファイルを取り違えている（数字の一覧や空のページ）。問題なしにしない
    if (!(v.slides > 0)) p.push(`${v.name}: ページ（section.slide）が 0 枚。ut-reportdeck の資料ではない`);
    for (const e of v.errors) p.push(`${v.name}: エラー ${e}`);
    for (const u of v.external) p.push(`${v.name}: 外部への通信 ${u}`);
    if (v.pageOverflow) p.push(`${v.name}: ページが横にはみ出す（${v.pageOverflow}px）`);
    for (const o of v.overflow) p.push(`${v.name}: 要素が横にはみ出す ${o}`);
  }
  const light = views.find((v) => v.scheme === 'light' && !v.theme), dark = views.filter((v) => v.scheme === 'dark' || v.theme === 'dark');
  for (const d of dark) if (light && d.background === light.background) p.push(`${d.name}: 明暗が切り替わらない（背景色が明るいときと同じ）`);
  return p;
}

export function loadPlaywright(dir) {
  try {
    const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
    return { file: req.resolve('playwright') };
  } catch { return null; }
}

async function inspect(chromium, file, shots) {
  let browser;
  try { browser = await chromium.launch(); } catch {
    try { browser = await chromium.launch({ channel: 'chrome' }); } catch (e) { return { unchecked: 'ブラウザを起動できない（' + String(e.message || e).split('\n')[0].slice(0, 80) + '）' }; }
  }
  try {
    const open = async (url, v, content) => {
      const page = await browser.newPage({ viewport: { width: v.width, height: 900 }, colorScheme: v.scheme });
      const errors = [], external = [];
      page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 120)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
      // すべての通信を遮断し、ローカル以外を記録する（実際には外へ出さない）
      await page.route('**/*', (r) => { const u = r.request().url(); if (LOCAL.test(u)) return r.continue(); external.push(u.slice(0, 120)); return r.abort(); });
      if (content !== undefined) await page.setContent(content); else await page.goto(url);
      if (v.theme) await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), v.theme);
      await page.waitForTimeout(100);
      const m = await page.evaluate(() => {
        const de = document.documentElement, cw = de.clientWidth;
        const over = [];
        for (const el of document.querySelectorAll('main *')) {
          if (el.closest('.wide, .tw')) continue;
          const r = el.getBoundingClientRect();
          if (r.right > cw + 1 && over.length < 5) over.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
        }
        return { pageOverflow: Math.max(0, de.scrollWidth - cw - 1), overflow: over, background: getComputedStyle(document.body).backgroundColor, slides: document.querySelectorAll('section.slide').length };
      });
      return { page, errors, external, ...m };
    };
    // 陽性対照: 外部の画像を含む見本で、外部通信の記録が働くこと
    const probe = await open(null, VIEWS[0], '<img src="https://example.invalid/probe.png">');
    await probe.page.close();
    if (!probe.external.length) return { unchecked: '外部通信の検出が働かない（陽性対照）' };
    const url = pathToFileURL(path.resolve(file)).href;
    const views = [];
    for (const v of VIEWS) {
      const r = await open(url, v);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        const tag = v.name.replace(/[^\w]/g, '') || 'view';
        const els = await r.page.$$('header.cover, section.slide');
        for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: path.join(shots, `${v.width}-${v.scheme}${v.theme ? '-theme' : ''}-${tag}-${String(i).padStart(2, '0')}.png`) });
      }
      await r.page.close();
      views.push({ ...v, errors: r.errors, external: r.external, pageOverflow: r.pageOverflow, overflow: r.overflow, background: r.background, slides: r.slides });
    }
    return { views };
  } finally { await browser.close(); }
}

export async function main(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--playwright-dir' || argv[i] === '--shots') { const v = argv[++i]; if (!v) { console.log('表示の検査: 未検査（' + argv[i - 1] + ' に値が無い）'); return 2; } o[argv[i - 1] === '--shots' ? 'shots' : 'pwDir'] = v; }
    else pos.push(argv[i]);
  }
  if (pos.length !== 1 || !fs.existsSync(pos[0])) { console.log('表示の検査: 未検査（使い方: node ut-reportdeck-check.mjs <資料.html> [--playwright-dir <dir>] [--shots <dir>]）'); return 2; }
  const pw = loadPlaywright(o.pwDir || process.cwd());
  if (!pw) { console.log('表示の検査: 未検査（Playwright が見つからない。作業フォルダか --playwright-dir に入れた環境で実行する。導入は利用者が決める）'); return 2; }
  let mod;
  try { mod = await import(pathToFileURL(pw.file).href); } catch { console.log('表示の検査: 未検査（Playwright を読み込めない）'); return 2; }
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  if (!chromium) { console.log('表示の検査: 未検査（Playwright に chromium が無い）'); return 2; }
  const r = await inspect(chromium, pos[0], o.shots);
  if (r.unchecked) { console.log('表示の検査: 未検査（' + r.unchecked + '）'); return 2; }
  const problems = judge(r.views);
  for (const v of r.views) console.log(`  ${v.name} ${v.width}px: エラー ${v.errors.length} / 外部通信 ${v.external.length} / はみ出し ${v.pageOverflow ? 1 : 0}+${v.overflow.length} / ページ ${v.slides}`);
  console.log('外部通信の検出: 陽性対照 OK');
  if (problems.length) { console.log('表示の検査: 問題 ' + problems.length + ' 件'); for (const p of problems) console.log('  - ' + p); return 1; }
  console.log('表示の検査: 問題なし（' + r.views.length + ' 通りの表示）');
  return 0;
}

function selftest() {
  const results = [];
  const t = (name, fn) => { try { results.push({ ok: true, name, m: fn() || '' }); } catch (e) { results.push({ ok: false, name, m: String((e && e.message) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const ok = (over = {}) => VIEWS.map((v) => ({ ...v, errors: [], external: [], pageOverflow: 0, overflow: [], slides: 3, background: v.scheme === 'dark' || v.theme === 'dark' ? 'rgb(22, 25, 29)' : 'rgb(255, 255, 255)', ...(over[v.name] || {}) }));
  t('[C01] 問題が無ければ 0 件', () => { assert(judge(ok()).length === 0, judge(ok()).join(' / ')); });
  t('[C02] エラー・外部通信・ページと要素のはみ出しを拾う', () => {
    const p = judge(ok({ PC: { errors: ['x'] }, 'スマホ': { external: ['https://a.invalid/'], pageOverflow: 30, overflow: ['div.cards'] } }));
    assert(p.length === 4, p.join(' / '));
  });
  t('[C03] 明暗が切り替わらなければ拾う（colorScheme・data-theme のどちらも）', () => {
    const same = 'rgb(255, 255, 255)';
    const p = judge(ok({ 'ダーク（colorScheme）': { background: same }, 'ダーク（data-theme）': { background: same } }));
    assert(p.length === 2 && p.every((x) => x.includes('明暗')), p.join(' / '));
  });
  t('[C07] 表示を 1 つでも検査していなければ問題にする（0 通りを「問題なし」にしない）', () => {
    assert(judge([]).length === VIEWS.length && judge(ok().slice(1)).length === 1, judge([]).join(' / '));
  });
  t('[C06] ページが 0 枚なら問題にする（取り違えたファイルを「問題なし」にしない）', () => {
    const p = judge(ok({ PC: { slides: 0 } }));
    assert(p.length === 1 && p[0].includes('0 枚'), p.join(' / '));
  });
  t('[C04] Playwright が無ければ「未検査」で exit 2（通過扱いにしない）', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-reportdeck-chk-'));
    try {
      const html = path.join(empty, 'a.html'); fs.writeFileSync(html, '<p>x</p>');
      const r = spawnSync(process.execPath, [SELF, html, '--playwright-dir', empty], { encoding: 'utf8', cwd: empty });
      assert(r.status === 2 && r.stdout.includes('未検査'), `exit=${r.status} ${r.stdout}`);
      const r2 = spawnSync(process.execPath, [SELF, path.join(empty, 'none.html')], { encoding: 'utf8', cwd: empty });
      assert(r2.status === 2 && r2.stdout.includes('未検査'), '入力が無いのに 2 でない');
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
  t('[C05] 探す場所は作業フォルダ側（この道具の場所ではない）', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-reportdeck-chk-'));
    try {
      fs.mkdirSync(path.join(empty, 'node_modules', 'playwright'), { recursive: true });
      fs.writeFileSync(path.join(empty, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
      fs.writeFileSync(path.join(empty, 'node_modules', 'playwright', 'index.js'), 'module.exports = {};');
      const got = loadPlaywright(empty);
      assert(got && got.file.startsWith(fs.realpathSync.native(empty)) || (got && got.file.startsWith(empty)), '作業フォルダの Playwright を見つけない: ' + JSON.stringify(got));
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.m ? ' | ' + r.m : ''));
  const ng = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length} 件中 ${results.length - ng} 件パス / ${ng} 件失敗`);
  return ng === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  process.exit(await main(process.argv.slice(2)));
}
