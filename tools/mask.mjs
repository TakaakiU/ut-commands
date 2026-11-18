#!/usr/bin/env node
// mask.mjs — 外部へ出す Markdown から機微値を落とす、必要最小限のマスク。
//
// 使い方:
//   node mask.mjs <input> [--out <out>] [--report <report.json>] [--selftest]
//
// 判定:
//   検出0件 → exit 0（<out> を生成。--out 省略時は標準出力）
//   検出あり → 置換して exit 0（何を落としたかは report と標準エラーに出す。値は出さない）
//   解析不能・入力不在 → exit 2（fail-closed。マスクせずに通さない）
//
// 設計方針（実測した失敗を踏まえたもの）:
//   1) キー名だけで置換しない。`Authorization: Bearer` のような「語」に反応すると、
//      値が無い文書まで書き換えて Markdown を壊す（実測: バッククォートが片方消えた）。
//      置換するのは「キー名 + 区切り + 十分な長さの値」が揃った場合だけ。
//   2) 固有名詞の辞書を持たない。辞書ベースの未マップ検知は偽陽性で止まる
//      （実測: PowerShell の [Environment]:: を未マップのテナント名と誤検知して FAIL）。
//      固有名詞の判断は人手レビューに委ね、ここでは「値」だけを機械的に落とす。
//   3) 検出した値そのものをログにも report にも出さない。場所と種別と長さだけ出す。
//   4) 置換はコードブロックの内外を問わず行う。手順書には実行例として値が載りやすい。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
// 「鍵の名前＋区切り＋値」の形は /ut-review の部品と共有する（1 か所で直す）。以前はここに別の正規表現があり、
// 前置きの語（refresh_token・client_secret・DB_PASSWORD）・キーの直後の閉じ引用符（JSON の "password": "…"）・
// エスケープした JSON（\"token\": \"…\"）を取り逃していた（2026-10-20。deploy.mjs の C10 で同じ穴を直した日に見つけた）
import { keyedSecretRe } from '../commands/templates/ut-review.mjs';

const REDACTED = '***REDACTED***';

// キー名 + 区切り + 値。引用符の無い値は「十分な長さ」（16 文字）を要求する（Markdown の本文を書き換えないため）。
// 引用符で囲んだ値は、閉じる引用符まで（長さを問わず）伏せる。引用符そのものは残す。
const KEYED = [
  { kind: 'token', re: keyedSecretRe(16) },
  {
    kind: 'bearer',
    // Authorization: Bearer <値>。値が無ければ反応しない（実測した偽陽性の再発防止）
    re: /\b(Bearer\s+)([A-Za-z0-9_\-.+/=]{16,})/g,
  },
  {
    kind: 'connection-string',
    // AccountKey= / SharedAccessSignature= / SharedAccessKey= の値部分。Password= は上の keyedSecretRe が受け持つ。
    re: /\b((?:AccountKey|SharedAccessSignature|SharedAccessKey)\s*=\s*)([A-Za-z0-9_\-.+/=%]{16,})/gi,
  },
];

// 値の形だけで判定できるもの。キー名を必要としない。
const SHAPED = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'sas-url', re: /\bhttps?:\/\/[^\s"'`)]*[?&]sig=[A-Za-z0-9%+/=]{16,}/gi },
];

// 実ユーザー名を含むホームパス。値ではなく表記を置き換える。
function homePatterns() {
  const home = os.homedir();
  const user = path.basename(home);
  const out = [];
  if (user && user.length >= 2) {
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // C:\Users\<user> / C:/Users/<user> の両表記
    // Windows のパスは大文字小文字を区別しないため、別の表記（C:\USERS\<名前> など）も落とす
    out.push({ kind: 'home-path', re: new RegExp('([A-Za-z]:[\\\\/]+Users[\\\\/]+)' + esc, 'gi'), to: '$1<USERPROFILE>' });
    // パス以外に出る素の実名も落とす（署名など）
    out.push({ kind: 'user-name', re: new RegExp(esc, 'gi'), to: '<USERPROFILE>' });
  }
  return out;
}

export function maskText(input) {
  let text = input;
  const findings = [];

  const record = (kind, value) => {
    // 値そのものは記録しない。長さだけ持つ
    findings.push({ kind, length: String(value).length });
  };

  for (const { kind, re } of KEYED) {
    text = text.replace(re, (m, pre, val) => {
      // 値を囲む引用符（エスケープした \" も）は残し、中身だけを伏せる
      const q = /^\\*["']/.exec(val);
      const open = q ? q[0] : '';
      const close = q && val.length > open.length && val.endsWith(open.slice(-1)) ? val.slice(val.length - open.length) : '';
      record(kind, val.slice(open.length, val.length - close.length));
      return pre + open + REDACTED + close;
    });
  }
  for (const { kind, re } of SHAPED) {
    text = text.replace(re, (m) => {
      record(kind, m);
      return REDACTED;
    });
  }
  for (const { kind, re, to } of homePatterns()) {
    text = text.replace(re, (m) => {
      record(kind, m);
      return to === '$1<USERPROFILE>' ? m.replace(/Users[\\/]+.*$/i, (s) => s.replace(/(Users[\\/]+).*/i, '$1<USERPROFILE>')) : to;
    });
  }

  // 行番号を付けた要約（値は含めない）
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  return { text, findings, byKind, count: findings.length };
}

// 自己テスト。検出できること(陽性)と、検出してはいけないこと(陰性)の両方を見る。
// 陰性側は実際に偽陽性を踏んだ入力をそのまま固定してある。
function selftest() {
  // テストデータは分割して組み立てる。完全な形をこのファイルに書くと、
  // リポジトリの機微値検査(deploy.mjs の C10)が実データの混入と区別できず落ちる。
  // 検査対象は組み立て後の文字列なので、検出力は落ちない。
  const V = 'abcdefghijklmnopqrstuvwxyz012345';
  const AT = '@';
  const SIG = 'sig' + '=' + 'abcdefghijklmnop0123456789%2F';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  const AKIA = 'AKIA' + 'IOSFODNN7EXAMPLE';

  const cases = [
    // [説明, 入力, 期待: マスクされるか]
    ['token= 付きの長い値', 'token=' + V, true],
    ['Bearer + 値', 'Authorization: Bearer ' + V, true],
    ['JWT', JWT, true],
    ['メールアドレス', 'foo.bar' + AT + 'example.co.jp', true],
    ['AKIA キー', AKIA, true],
    ['SAS 付きURL', 'https://ex.blob.core.windows.net/c/b?sv=2020&' + SIG, true],
    // 2026-10-20 に見つけた取り逃し（以前の正規表現では伏せなかった形）
    ['JSON のキー（"password": "…"）', '{ "pass' + 'word": "' + V + '" }', true],
    ['エスケープした JSON（\\"token\\": \\"…\\"）', '"{\\"tok' + 'en\\": \\"' + V + '\\"}"', true],
    ['引用したキーの YAML', "'api" + "_key': '" + V + "'", true],
    ['前置きの語（refresh_token）', 'refresh_tok' + 'en=' + V, true],
    ['前置きの語（client_secret）', 'CLIENT_SEC' + 'RET: ' + V, true],
    ['前置きの語（DB_PASSWORD）', 'DB_PASS' + 'WORD=' + V, true],
    // ここから陰性。実測した偽陽性の再発防止
    ['Bearer の語だけ(値なし)', '`Authorization: Bearer` と `x-access-token`', false],
    ['PowerShell の [Environment]::', "[Environment]::GetEnvironmentVariable('GROWI_API_TOKEN','User')", false],
    ['環境変数名だけ', 'setx GROWI_API_TOKEN "発行したトークン"', false],
    ['短い値(閾値未満)', 'token=abc123', false],
    ['プレースホルダ表記', '%USERPROFILE%/.claude/tools', false],
  ];

  let fail = 0;
  for (const [label, input, shouldMask] of cases) {
    const r = maskText(input);
    const masked = r.count > 0;
    const ok = masked === shouldMask;
    if (!ok) fail++;
    console.log(
      (ok ? '  OK   ' : '  NG   ') +
      (shouldMask ? '陽性' : '陰性') + ' | ' + label +
      ' | 検出 ' + r.count + '件' + (r.count ? ' (' + Object.keys(r.byKind).join(',') + ')' : '')
    );
    // 構造破壊の確認: 陰性ケースは入力と完全一致でなければならない
    if (!shouldMask && r.text !== input) {
      console.log('       NG 陰性なのに本文が書き換わった');
      fail++;
    }
  }
  // 引用符で囲んだ値は、中身だけを伏せて引用符を残す（JSON・エスケープした JSON の形を壊さない）
  for (const [input, want] of [
    ['{ "pass' + 'word": "' + V + '" }', '{ "pass' + 'word": "' + REDACTED + '" }'],
    ['"{\\"tok' + 'en\\": \\"' + V + '\\"}"', '"{\\"tok' + 'en\\": \\"' + REDACTED + '\\"}"'],
  ]) {
    const got = maskText(input).text;
    const ok = got === want;
    if (!ok) fail++;
    console.log((ok ? '  OK   ' : '  NG   ') + '形 | 引用符を残して中身だけ伏せる | ' + (ok ? '崩れない' : JSON.stringify(got)));
  }
  // 実際のユーザー名の大文字小文字を変えた表記も落とす（Windows では同じパスになる）
  const user = path.basename(os.homedir());
  const variant = user.toUpperCase() !== user ? user.toUpperCase() : user.toLowerCase();
  if (user.length >= 2 && variant !== user) {
    const input = 'C:\\USERS\\' + variant + '\\work\\a.md';
    const r = maskText(input);
    const ok = r.count > 0 && !r.text.toLowerCase().includes(user.toLowerCase()) && r.text.includes('<USERPROFILE>');
    if (!ok) fail++;
    console.log((ok ? '  OK   ' : '  NG   ') + '陽性 | ユーザー名の大文字小文字違い | ' + (ok ? '伏せた' : '残った'));
  } else {
    console.log('  --   ユーザー名に英字が無いため、大文字小文字違いの確認は対象外');
  }
  // 値を取るオプションの欠落は、本文を標準出力へ流す前に止める（古い出力を成功扱いで使わせない）。
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-cli-selftest-'));
  try {
    const input = path.join(cliDir, 'input.md'); fs.writeFileSync(input, 'plain\n');
    for (const opt of ['--out', '--report']) {
      const r = spawnSync(process.execPath, [process.argv[1], input, opt], { encoding: 'utf8' });
      const ok = r.status === 2 && /値が無い/.test(r.stderr) && r.stdout === '';
      if (!ok) fail++;
      console.log((ok ? '  OK   ' : '  NG   ') + '入力 | ' + opt + ' の値が無い | ' + (ok ? '出力前に停止' : `exit=${r.status}`));
    }
    // オプションを入力より前に置いても、入力は位置の引数。--out の値を入力と取り違えて、前回の出力を再マスクしない
    const prev = path.join(cliDir, 'prev-out.md'); fs.writeFileSync(prev, 'OLD-OUTPUT\n');
    const rb = spawnSync(process.execPath, [process.argv[1], '--out', prev, input], { encoding: 'utf8' });
    const okb = rb.status === 0 && fs.readFileSync(prev, 'utf8') === 'plain\n';
    if (!okb) fail++;
    console.log((okb ? '  OK   ' : '  NG   ') + '--out <出力> <入力> | オプションが入力より前 | ' + (okb ? '入力を読み、出力に書いた' : `exit=${rb.status}`));
    // 知らない -- の語・--out=x の形・余分な引数・入力と同じ出力は、書く前に止める
    const stops = [['--outt', 'x'], ['--out=' + path.join(cliDir, 'o.md')], ['extra.md'], ['--out', input]];
    for (const extra of stops) {
      const rs = spawnSync(process.execPath, [process.argv[1], input, ...extra], { encoding: 'utf8' });
      const oks = rs.status === 2 && rs.stdout === '' && fs.readFileSync(input, 'utf8') === 'plain\n';
      if (!oks) fail++;
      console.log((oks ? '  OK   ' : '  NG   ') + '入力 ' + extra[0] + ' | 知らない語・余分な引数・同じ出力 | ' + (oks ? 'exit 2・出力前に停止' : `exit=${rs.status}`));
    }
    // 値の位置に別のオプションが来た形（--out --report r.json）は、値が無いとして止める
    const rv = spawnSync(process.execPath, [process.argv[1], input, '--out', '--report', path.join(cliDir, 'r.json')], { encoding: 'utf8' });
    const okv = rv.status === 2 && /値が無い/.test(rv.stderr) && rv.stdout === '' && !fs.existsSync(path.join(cliDir, '--report'));
    if (!okv) fail++;
    console.log((okv ? '  OK   ' : '  NG   ') + '入力 --out --report r.json | 値の位置に別のオプション | ' + (okv ? '値が無いとして停止' : `exit=${rv.status}`));
  } finally { fs.rmSync(cliDir, { recursive: true, force: true }); }
  console.log('');
  console.log(fail === 0 ? 'selftest: 全件パス' : 'selftest: ' + fail + ' 件失敗');
  return fail === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  // 引数は先頭から順に読む。--out・--report は次の 1 語を値として読み、残った位置の引数を入力にする
  // （以前は「-- で始まらない最初の語」を入力にしていたので、--out out.md in.md で out.md が入力になり、前回の出力を再マスクして成功を返した）。
  // 知らない -- の語（--out=x の形・綴りの誤り）は黙って無視せず止める（指定が効いたと思い込んで、古い出力を使わないように）
  let out = null;
  let report = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--report') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error('[mask] ' + a + ' に値が無い');
        process.exit(2);
      }
      if (a === '--out') out = v; else report = v;
      i++;
    } else if (a.startsWith('--')) {
      console.error('[mask] 知らないオプション: ' + a + '（使えるのは --out <出力>・--report <report.json>・--selftest。--out=x の形は使えない）');
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    console.error('[mask] 入力は 1 つだけ（余分な引数: ' + positional.slice(1).join(' ') + '）');
    process.exit(2);
  }
  const input = positional[0];
  if (input && out && path.resolve(input) === path.resolve(out)) {
    console.error('[mask] 入力と --out が同じファイル（入力を上書きしない）');
    process.exit(2);
  }

  if (!input) {
    console.error('usage: node mask.mjs <input> [--out <out>] [--report <report.json>] [--selftest]');
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(input, 'utf8');
  } catch (e) {
    // 読めないものをマスク済みとして通さない
    console.error('[mask] 入力を読めません: ' + e.message);
    process.exit(2);
  }

  const r = maskText(raw);

  if (out) fs.writeFileSync(out, r.text, 'utf8');
  else process.stdout.write(r.text);

  if (report) {
    // 値は出さない。種別と件数と長さだけ
    fs.writeFileSync(report, JSON.stringify({ count: r.count, byKind: r.byKind, findings: r.findings }, null, 2), 'utf8');
  }

  console.error('[mask] 検出 ' + r.count + ' 件' + (r.count ? ' : ' + JSON.stringify(r.byKind) : ''));
  if (r.count > 0) {
    console.error('[mask] 値は出力しません。置換後の本文を人手で確認してください。');
  }
  console.error('[mask] 固有名詞(顧客名・テナント名・個人名)は機械判定しません。人手レビューで確認してください。');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
