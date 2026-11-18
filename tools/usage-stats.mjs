#!/usr/bin/env node
// ut-* コマンドの実呼び出し回数を、セッション記録から集計する。
//
//   node tools/usage-stats.mjs
//   node tools/usage-stats.mjs --selftest   # 一時ホームの作った記録で、数え方を確かめる
//
// 数えるのは「コマンド名」と「日付」だけで、会話本文は一切保持しない。
//
// **Claude 側だけを見ると数を取りこぼす。** 呼び出し経路が3つあるため。
//   1. Claude で `/ut-<名前>` と打つ        → transcript に <command-name> が入る
//   2. Claude で `ut-<名前>` と打つ(スラッシュ無し) → <command-name> が入らない
//   3. Codex から ut ラッパー経由（skills の $ut。2026-09-30 より前の記録は旧 custom prompts の /prompts:ut。どちらも CMD=ut-<名前> の形）→ Claude 側の記録に残らない
// 実測では 1 だけを数えて 49 回、3経路すべてで 123 回だった。
// 経路を1つ落とすと、そのコマンドが「未使用」に見える。
//
// 今の commands/ に無い ut- の名前（改名・廃止した名前、打ち間違い）の記録は、黙って捨てずに件数を出す。
// 捨てた分を表示しないと、改名したコマンドが「使われていない」ように見える。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const CMD_DIR = path.join(REPO_ROOT, 'commands');

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

// home の下の Claude・Codex の記録を数える。names は今の commands/ にあるコマンド名
async function collect(home, names) {
  const stats = new Map(names.map((n) => [n, { claude: 0, codex: 0, days: new Set(), first: null, last: null }]));
  // 今の commands/ に無い ut- の名前: kind ごとに 名前 → 件数
  const dropped = { claude: new Map(), codex: new Map() };
  function bump(name, day, kind) {
    const s = stats.get(name);
    if (!s) {
      // ut- 以外（/clear や他のプラグインのコマンド）は最初から集計の対象外なので数えない
      if (name.startsWith('ut-')) dropped[kind].set(name, (dropped[kind].get(name) || 0) + 1);
      return;
    }
    s[kind]++;
    if (!day) return;
    s.days.add(day);
    if (!s.first || day < s.first) s.first = day;
    if (!s.last || day > s.last) s.last = day;
  }

  const MARK = '<command-name>';
  const claudeFiles = listJsonl(path.join(home, '.claude', 'projects'));
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
      // スラッシュ無しで打った場合: 先頭から名前を1つだけ取り出し、今あるコマンドかどうかは bump に振り分けさせる。
      // 今ある名前との前方一致で探すと、無い名前（ut-diskclean …）は黙って消え、
      // 今ある名前を接頭辞に持つ名前（ut-plan-old …）は ut-plan として誤って数える
      const m = text.trimStart().match(HEAD_NAME_RE);
      if (m) bump(m[1], day, 'claude');
    }
  }

  // Codex 側は 1セッション内の同一コマンドを1回として数える(実行粒度に合わせる)。捨てた件数も重複を除いた後で数える
  const codexFiles = [
    ...listJsonl(path.join(home, '.codex', 'sessions')),
    ...listJsonl(path.join(home, '.codex', 'archived_sessions')),
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
  return { stats, dropped, claudeFiles: claudeFiles.length, codexFiles: codexFiles.length };
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
// 行頭の ut- の名前を、名前に使う文字（英数字・ハイフン・下線）の並びとして丸ごと取る。
// 途中で切ると、ut-plan_x を ut-plan として数え、切れ目で一致を諦めると、どこにも数えずに消える
const HEAD_NAME_RE = /^\/?(ut-[A-Za-z0-9_-]+)/;

async function main() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const names = fs.readdirSync(CMD_DIR)
    .filter((f) => f.startsWith('ut-') && f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  if (!names.length) { console.error('commands/ut-*.md が見つかりません。'); return 1; }

  const { stats, dropped, claudeFiles, codexFiles } = await collect(home, names);
  console.log('走査: Claude ' + claudeFiles + ' ファイル / Codex ' + codexFiles + ' ファイル');
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
  console.log('合計 ' + rows.reduce((a, r) => a + r.total, 0) + ' 回 / 実績のあるコマンド ' + used + ' / ' + names.length + ' 本');
  console.log('');
  console.log('今の commands/ に無い ut- の名前（改名・廃止した名前、打ち間違い、行頭の ut- で始まる語）: Claude ' + sum(dropped.claude) + ' 件 / Codex ' + sum(dropped.codex) + ' 件（Codex はセッション内の重複を除いた後）');
  const unknown = [...new Set([...dropped.claude.keys(), ...dropped.codex.keys()])].sort();
  for (const n of unknown) console.log('  - ' + n + ': Claude ' + (dropped.claude.get(n) || 0) + ' / Codex ' + (dropped.codex.get(n) || 0));
  console.log('');
  console.log('0回のコマンドは「未使用」と断定しない。作成直後・他コマンドから内部的に呼ばれる・');
  console.log('記録の範囲外、のいずれかでありうる。判定にはコマンドの作成日と記録の期間を併せて見る。');
  return 0;
}

// ---- 自己テスト: 一時ホームに作った記録で、数え方と捨てた件数を確かめる ----
async function selftest() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-usage-st-'));
  const results = [];
  const t = (name, ok, msg) => results.push({ name, ok, msg });
  try {
    const W = (p, lines) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };
    const u = (text, ts = '2026-10-01T00:00:00Z') => ({ type: 'user', timestamp: ts, message: { content: text } });
    // 架空の名前は組み立てて使う（ソースに「/」と名前が並ぶと、公開ツールの案内の検査が拾う）
    const OLD = 'ut-' + 'oldname';
    W(path.join(home, '.claude', 'projects', 'p', 'a.jsonl'), [
      u('<command-name>/ut-plan</command-name>'),
      u(`<command-name>/${OLD}</command-name>`),
      u(`<command-name>/${OLD}</command-name>`),
      // 本文に ut- を含めておく（含まない行は読み込みの入口で外れ、ut- 以外を除く判定まで届かない）
      u('<command-name>/clear</command-name> ut-plan の続き'),
      u('ut-plan をお願い'),
      u('ut-diskclean を打った（スラッシュ無しの、今は無い名前）'),
      u('ut-plan-old を打った（今ある名前を接頭辞に持つ、無い名前）'),
      u('ut-plan_x を打った（下線を含む、無い名前）'),
    ]);
    const codexLine = (s) => ({ type: 'event', text: s });
    // 架空の名前は組み立てて使う。ソースに「CMD=」と名前が並んで書かれていると、
    // 公開ツールの案内の検査（publish.mjs）が、公開物に無いコマンドへの案内として拾う
    const PLAN = 'ut-' + 'plan';
    const GONE = 'ut-' + 'gone';
    W(path.join(home, '.codex', 'sessions', 's-2026-10-02.jsonl'), [
      codexLine(`$ut CMD=${PLAN} ARGS=x`), codexLine(`CMD=${PLAN} again`),
      codexLine(`CMD=${GONE} first`), codexLine(`CMD=${GONE} second`),
    ]);
    W(path.join(home, '.codex', 'sessions', 's2-2026-10-03.jsonl'), [codexLine(`CMD=${GONE}`)]);
    const { stats, dropped } = await collect(home, ['ut-plan']);
    const p = stats.get('ut-plan');
    t('Claude: <command-name> とスラッシュ無しの両方を数える', p.claude === 2, 'claude=' + p.claude);
    t('Codex: 1セッション内の重複は1回', p.codex === 1, 'codex=' + p.codex);
    t('Claude: 今の commands/ に無い ut- の名前を捨てた件数として数える', dropped.claude.get(OLD) === 2, JSON.stringify([...dropped.claude]));
    t('Claude: ut- 以外のコマンド（/clear）は捨てた件数に入れない', !dropped.claude.has('clear'), JSON.stringify([...dropped.claude]));
    t('Claude: スラッシュ無しの、今は無い名前も捨てた件数として数える', dropped.claude.get('ut-diskclean') === 1, JSON.stringify([...dropped.claude]));
    t('Claude: 今ある名前を接頭辞に持つ無い名前を、今ある名前として数えない', dropped.claude.get('ut-plan-old') === 1 && p.claude === 2, 'claude=' + p.claude + ' ' + JSON.stringify([...dropped.claude]));
    t('Claude: 下線を含む無い名前を、今ある名前として数えず、消しもしない', dropped.claude.get('ut-plan_x') === 1 && p.claude === 2, 'claude=' + p.claude + ' ' + JSON.stringify([...dropped.claude]));
    t('Claude: 捨てた件数の合計が、作った記録の数と合う（5件）', sum(dropped.claude) === 5, JSON.stringify([...dropped.claude]));
    t('Codex: 捨てた件数はセッション内の重複を除いた後（2セッションで2件）', dropped.codex.get(GONE) === 2, JSON.stringify([...dropped.codex]));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const r of results) console.log('  ' + (r.ok ? 'OK  ' : 'NG  ') + r.name + (r.ok ? '' : ' | ' + r.msg));
  const ng = results.filter((r) => !r.ok).length;
  console.log('selftest: ' + results.length + ' 件中 ' + (results.length - ng) + ' 件パス / ' + ng + ' 件失敗');
  return ng === 0;
}

if (process.argv.includes('--selftest')) process.exit((await selftest()) ? 0 : 1);
process.exit(await main());
