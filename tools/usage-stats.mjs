#!/usr/bin/env node
// ut-* コマンドの実呼び出し回数を、セッション記録から集計する。
//
//   node tools/usage-stats.mjs
//
// 数えるのは「コマンド名」と「日付」だけで、会話本文は一切保持しない。
//
// **Claude 側だけを見ると数を取りこぼす。** 呼び出し経路が3つあるため。
//   1. Claude で `/ut-xxx` と打つ        → transcript に <command-name> が入る
//   2. Claude で `ut-xxx` と打つ(スラッシュ無し) → <command-name> が入らない
//   3. Codex から codex-prompts/ut.md 経由 → Claude 側の記録に残らない
// 実測では 1 だけを数えて 49 回、3経路すべてで 123 回だった。
// 経路を1つ落とすと、そのコマンドが「未使用」に見える。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOME = process.env.USERPROFILE || process.env.HOME;
const REPO_ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const CMD_DIR = path.join(REPO_ROOT, 'commands');

const NAMES = fs.readdirSync(CMD_DIR)
  .filter((f) => f.startsWith('ut-') && f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''));
if (!NAMES.length) { console.error('commands/ut-*.md が見つかりません。'); process.exit(1); }

const stats = new Map(NAMES.map((n) => [n, { claude: 0, codex: 0, days: new Set(), first: null, last: null }]));
function bump(name, day, kind) {
  const s = stats.get(name);
  if (!s) return;
  s[kind]++;
  if (!day) return;
  s.days.add(day);
  if (!s.first || day < s.first) s.first = day;
  if (!s.last || day > s.last) s.last = day;
}

function listJsonl(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  })(root);
  return out;
}

const MARK = '<command-name>';
const claudeFiles = listJsonl(path.join(HOME, '.claude', 'projects'));
for (const f of claudeFiles) {
  const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('ut-')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'user' || !j.message) continue;
    const c = j.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).join('\n')
      : '';
    if (!text) continue;
    const day = j.timestamp ? j.timestamp.slice(0, 10) : null;
    const i = text.indexOf(MARK);
    if (i >= 0) {
      const end = text.indexOf('</command-name>', i);
      if (end > 0) { bump(text.slice(i + MARK.length, end).trim().replace(/^\//, ''), day, 'claude'); continue; }
    }
    const head = text.trimStart();
    for (const n of NAMES) {
      if (head.startsWith(n) || head.startsWith('/' + n)) { bump(n, day, 'claude'); break; }
    }
  }
}

// Codex 側は 1セッション内の同一コマンドを1回として数える(実行粒度に合わせる)
const codexFiles = [
  ...listJsonl(path.join(HOME, '.codex', 'sessions')),
  ...listJsonl(path.join(HOME, '.codex', 'archived_sessions')),
];
const seen = new Set();
for (const f of codexFiles) {
  const day = (path.basename(f).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('CMD=ut-')) continue;
    for (const m of line.matchAll(/CMD=(ut-[A-Za-z0-9-]+)/g)) {
      const key = f + '|' + m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      bump(m[1], day, 'codex');
    }
  }
}

console.log('走査: Claude ' + claudeFiles.length + ' ファイル / Codex ' + codexFiles.length + ' ファイル');
console.log('');
const rows = [...stats.entries()].map(([n, s]) => ({ n, ...s, total: s.claude + s.codex }))
  .sort((a, b) => b.total - a.total || a.n.localeCompare(b.n));
console.log('| コマンド | 合計 | Claude | Codex | 使用日数 | 初回 | 最終 |');
console.log('|---|---:|---:|---:|---:|---|---|');
for (const r of rows) {
  console.log('| `/' + r.n + '` | ' + r.total + ' | ' + r.claude + ' | ' + r.codex + ' | ' +
    r.days.size + ' | ' + (r.first || '-') + ' | ' + (r.last || '-') + ' |');
}
const used = rows.filter((r) => r.total > 0).length;
console.log('');
console.log('合計 ' + rows.reduce((a, r) => a + r.total, 0) + ' 回 / 実績のあるコマンド ' + used + ' / ' + NAMES.length + ' 本');
console.log('');
console.log('0回のコマンドは「未使用」と断定しない。作成直後・他コマンドから内部的に呼ばれる・');
console.log('記録の範囲外、のいずれかでありうる。判定にはコマンドの作成日と記録の期間を併せて見る。');
