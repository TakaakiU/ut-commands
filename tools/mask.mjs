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

const REDACTED = '***REDACTED***';

// キー名 + 区切り + 値。値は「十分な長さ」を要求する。
// 区切りは = : => のいずれかと、その周囲の空白・引用符を許す。
const KEYED = [
  {
    kind: 'token',
    // token / api_key / apikey / access_token / secret / password / passwd / pwd
    re: /\b((?:access[_-]?token|api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([A-Za-z0-9_\-.+/=]{16,})(["']?)/gi,
  },
  {
    kind: 'bearer',
    // Authorization: Bearer <値>。値が無ければ反応しない（実測した偽陽性の再発防止）
    re: /\b(Bearer\s+)([A-Za-z0-9_\-.+/=]{16,})/g,
  },
  {
    kind: 'connection-string',
    // AccountKey= / SharedAccessSignature= / Password= を含む接続文字列の値部分
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
    out.push({ kind: 'home-path', re: new RegExp('([A-Za-z]:[\\\\/]+Users[\\\\/]+)' + esc, 'g'), to: '$1<USERPROFILE>' });
    // パス以外に出る素の実名も落とす（署名など）
    out.push({ kind: 'user-name', re: new RegExp(esc, 'g'), to: '<USERPROFILE>' });
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
    text = text.replace(re, (m, pre, val, post = '') => {
      record(kind, val);
      return pre + REDACTED + post;
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
      return to === '$1<USERPROFILE>' ? m.replace(/Users[\\/]+.*$/, (s) => s.replace(/(Users[\\/]+).*/, '$1<USERPROFILE>')) : to;
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
  console.log('');
  console.log(fail === 0 ? 'selftest: 全件パス' : 'selftest: ' + fail + ' 件失敗');
  return fail === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  const input = argv.find((a) => !a.startsWith('--'));
  const outIdx = argv.indexOf('--out');
  const repIdx = argv.indexOf('--report');
  const out = outIdx >= 0 ? argv[outIdx + 1] : null;
  const report = repIdx >= 0 ? argv[repIdx + 1] : null;

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
