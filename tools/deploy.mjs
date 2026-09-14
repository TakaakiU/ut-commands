#!/usr/bin/env node
// deploy.mjs — ut-* 個人コマンド類を、正本(このリポジトリ)と
// 実行場所(~/.claude/commands/, ~/.codex/prompts/)の間で配置/回収する。
//
// 設計上の約束:
//   1. 既定は dry-run。書き込むには --apply / --capture を明示する。
//   2. 削除は一切しない。片側にしか無いファイルは「追加」としてしか扱わない。
//   3. 両側の内容が食い違っている場合は既定でブロックする。どちら向きに上書きするかは
//      人間が決めるべきで、暗黙に選ぶと反対側の編集が消える。--force で上書き(退避を残す)。
//   4. Claude 対象は ut-*.md と許可済み templates のみ。~/.claude/commands/ に同居する
//      他者所有ファイルには触らない。Codex 対象は codex-prompts/*.md のみで、他の
//      ~/.codex/prompts/* には触らない。
//   5. 比較は LF 正規化後の内容ハッシュ。core.autocrlf=true の環境で改行差を
//      「変更」と誤検知しないため。
//   6. --apply / --capture の前に整合性検査(--check)を通す。検査対象は「向き」で変える。
//      --apply は repo 側が源なので repo を、--capture は取り込み後の状態を検査する。
//      repo だけを見ると、壊れた実行場所の内容を無検査で取り込んでしまう。
//
// 使い方:
//   node tools/deploy.mjs                          # Claude の状態表示のみ(既定)
//   node tools/deploy.mjs --check                  # 整合性検査のみ(書き込まない)
//   node tools/deploy.mjs --target claude --apply # 正本 → ~/.claude/commands/
//   node tools/deploy.mjs --target claude --capture
//   node tools/deploy.mjs --target codex --apply  # 正本 → ~/.codex/prompts/
//   node tools/deploy.mjs --target codex --capture
//
// 終了コード: 0=成功/作業不要, 1=食い違いによりブロック, 2=エラー, 3=整合性検査NG

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'ut-';
const SUFFIX = '.md';
const CLAUDE_TEMPLATE_FILES = [
  path.join('templates', 'alert-report.mjs'),
  path.join('templates', 'collect-alerts.mjs'),
  path.join('templates', 'ut-report-html-template.html'),
];

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

const HOME = process.env.USERPROFILE || process.env.HOME;
if (!HOME) fail('ホームディレクトリを解決できません(USERPROFILE / HOME が未設定)。');

const TARGETS = {
  claude: {
    repoDir: path.join(REPO_ROOT, 'commands'),
    repoDirName: 'commands',
    liveDir: path.join(HOME, '.claude', 'commands'),
    description: 'Claude Code 個人コマンド',
    filePatternLabel: 'ut-*.md + templates/{alert-report.mjs,collect-alerts.mjs,ut-report-html-template.html}',
    restartHint: 'Claude Code のセッションを開き直すと反映されます。',
    listFiles(dir) {
      const topLevel = listTopLevelFiles(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
      const templates = CLAUDE_TEMPLATE_FILES.filter((n) => fs.existsSync(path.join(dir, n)));
      return [...topLevel, ...templates].sort();
    },
  },
  codex: {
    repoDir: path.join(REPO_ROOT, 'codex-prompts'),
    repoDirName: 'codex-prompts',
    liveDir: path.join(HOME, '.codex', 'prompts'),
    description: 'Codex custom prompts',
    filePatternLabel: '*.md',
    restartHint: 'Codex のセッションを開き直すと反映されます。',
    listFiles(dir) {
      return listTopLevelFiles(dir).filter((n) => n.endsWith(SUFFIX)).sort();
    },
  },
};

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const targetIndex = argv.indexOf('--target');
const targetName = targetIndex >= 0 ? argv[targetIndex + 1] : 'claude';
const knownFlags = new Set(['--apply', '--capture', '--force', '--dry-run', '--check', '--no-check', '--help', '-h', '--target']);
const unknown = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--target') {
    i++;
    continue;
  }
  if (!knownFlags.has(arg)) unknown.push(arg);
}
if (unknown.length) fail(`不明な引数: ${unknown.join(' ')}`);
if (has('--help') || has('-h')) { usage(); process.exit(0); }
if (targetIndex >= 0 && !argv[targetIndex + 1]) fail('--target の値がありません。claude または codex を指定してください。');
if (!(targetName in TARGETS)) fail(`不明な target: ${targetName} (claude / codex のみ対応)。`);
if (has('--apply') && has('--capture')) {
  fail('--apply と --capture は同時に指定できません(どちら向きに上書きするかが決まらない)。');
}
if (has('--check') && (has('--apply') || has('--capture'))) {
  fail('--check は単独で使ってください(--apply / --capture は前段で自動的に検査します)。');
}
if (has('--no-check') && !(has('--apply') || has('--capture'))) {
  fail('--no-check は --apply / --capture と一緒にのみ指定できます。');
}

const mode = has('--check') ? 'check' : has('--apply') ? 'apply' : has('--capture') ? 'capture' : 'dry-run';
const skipCheck = has('--no-check');
const force = has('--force');
const target = TARGETS[targetName];
const REPO_CMD_DIR = target.repoDir;
const LIVE_CMD_DIR = target.liveDir;

const normLF = (s) => s.replace(/\r\n/g, '\n');
const hashOf = (buf) => createHash('sha256').update(normLF(buf.toString('utf8')), 'utf8').digest('hex');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function listTopLevelFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function listCommands(dir) {
  return target.listFiles(dir);
}

function writeAtomic(dest, buf) {
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function uniqueBackupPath(dest, ts) {
  const base = `${dest}.bak-${ts}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  fail(`退避ファイル名を確保できません: ${base}.*`);
}

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(2);
}

function usage() {
  console.log(`使い方:
  node tools/deploy.mjs                                状態表示のみ(既定・claude)
  node tools/deploy.mjs --check                        整合性検査のみ(書き込まない)
  node tools/deploy.mjs --target claude --apply       正本 → ${TARGETS.claude.liveDir}
  node tools/deploy.mjs --target claude --capture     ${TARGETS.claude.liveDir} → 正本
  node tools/deploy.mjs --target codex --apply        正本 → ${TARGETS.codex.liveDir}
  node tools/deploy.mjs --target codex --capture      ${TARGETS.codex.liveDir} → 正本
  node tools/deploy.mjs ... --force                   食い違いも上書き(上書き前に .bak-<時刻>-<ミリ秒> を残す)
  node tools/deploy.mjs ... --no-check                前段の整合性検査をスキップ(緊急時のみ)

Claude 対象は ut-*.md と許可済み templates のみ、Codex 対象は codex-prompts/*.md のみ。削除は行わない。
--apply / --capture は前段で整合性検査を通す。--capture は取り込み後の状態を検査する。
検査項目: C1 中身表とファイルの一致 / C2 ut-* の6節骨格 / C3 templates 参照の実在 /
          C4 Codexラッパー一覧の一致 / C5 README 行数(警告) / C6 未配備テンプレート(警告) /
          C7 表の重複掲載 / C9 外部参照の陳腐化(警告) / C10 機微値の混入`);
}

// ---- 整合性検査(--check) ------------------------------------------------
// 「配備対象集合の正本」は上の TARGETS が持っている。検査もそこから導出する。
// 別に lint スクリプトを作ると許可リストが2箇所になり、lint 自身がドリフト源になる。
//
// 検査は「候補ツリー」に対して行う。--apply は repo 側が源なので repo を見るが、
// --capture は実行場所の内容を repo へ取り込む向きなので、取り込み後の状態を見る。
// repo だけを見ると、壊れた実行場所の内容を無検査で取り込んでしまう。

const README_REL = 'README.md';
// 「中身」表に載せるべき非配備ファイル（tools/, docs/ 等）は git から導出する。
// 追跡済み(-c)に加えて未追跡(-o --exclude-standard)も見る。git add 前でも
// 新規ファイルを検知したいため。.gitignore 対象（*.bak-* 等）は除かれる。
// 手書きリストにすると、ファイルを増やしたときにリスト自体が更新漏れの対象になり、
// 「表の漏れを検知する仕組み」が同じ漏れを起こす。null は git が使えない場合。
function trackedExtraRows() {
  let files;
  try {
    files = execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.quotepath=false', 'ls-files', '-c', '-o', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const deployedDirs = Object.values(TARGETS).map((t) => t.repoDirName + '/');
  return files
    .filter((f) => f !== README_REL)
    .filter((f) => !f.startsWith('.')) // ドット始まりの設定ファイルは表に載せない
    .filter((f) => !deployedDirs.some((d) => f.startsWith(d)))
    // index に残っているだけの削除済みファイルを除く（ls-files -c は staged deletion も返す）
    .filter((f) => fs.existsSync(path.join(REPO_ROOT, f.split('/').join(path.sep))))
    .sort();
}
const SKELETON = ['目的', '入力', '必須手順', '出力契約', '禁止事項', '補足'];
const README_MAX_LINES = 350;

const toPosix = (p) => p.split(path.sep).join('/');

// 検査対象の仮想ツリー。capture の時だけ、対象の実行場所の内容を repo より優先する。
function buildTree(captureTarget) {
  return {
    listFiles(tn) {
      const t = TARGETS[tn];
      const repoNames = t.listFiles(t.repoDir);
      if (tn !== captureTarget) return repoNames.sort();
      return [...new Set([...repoNames, ...t.listFiles(t.liveDir)])].sort();
    },
    read(relPosix) {
      if (captureTarget) {
        const prefix = `${TARGETS[captureTarget].repoDirName}/`;
        if (relPosix.startsWith(prefix)) {
          const name = relPosix.slice(prefix.length).split('/').join(path.sep);
          const liveBuf = readIfExists(path.join(TARGETS[captureTarget].liveDir, name));
          if (liveBuf) return liveBuf;
        }
      }
      return readIfExists(path.join(REPO_ROOT, relPosix.split('/').join(path.sep)));
    },
  };
}

// 「中身」表に載るべきファイル集合を、許可リストから導出する。
function inventory(tree) {
  const out = [];
  for (const tn of Object.keys(TARGETS)) {
    for (const name of tree.listFiles(tn)) out.push(`${TARGETS[tn].repoDirName}/${toPosix(name)}`);
  }
  return out;
}

// 見出し直後の markdown 表から1列目を取り出す。ヘッダ行と区切り行は落とす。
function tableFirstColumn(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return null;
  const rows = [];
  let seenTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6} /.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cell = line.split('|')[1];
    if (cell === undefined) continue;
    rows.push(cell.trim().replace(/^`|`$/g, ''));
  }
  if (!seenTable) return null;
  return rows.slice(1); // 先頭はヘッダ行
}

function diffSets(expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    missing: expected.filter((x) => !a.has(x)),
    extra: actual.filter((x) => !e.has(x)),
  };
}

function duplicates(list) {
  const seen = new Set();
  const dup = new Set();
  for (const x of list) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

// ---- C9: 外部参照（他ブランチのパス）の陳腐化検知 ----------------------
// C1-C7 は repo 内部の参照しか見ない。ラッパー prompt が指す「他ブランチのパス」は
// 相手側の移行で黙って壊れる（運用改善パイプラインのプラグイン化で実際に壊れた）。
//
// severity は warning に限定する。他ブランチの状態に依存するため error にすると、
// 相手側の移行途中や ref 未取得だけで ut-commands の配備が止まる。C5 と同じ判断。
// local も remote も解決できない場合は警告すら出さず skip する
// (--single-branch clone では相手ブランチの ref が存在しない)。

// 社内固有の参照先(他ブランチ・社内プラグイン)は tools/external-refs.json へ外出しした。
// deploy.mjs 自体を汎用に保ち、公開用ビルドで本文を書き換えずに済ませるため。
// 設定が無い環境では C9 を skip するが、**「設定なし」を明示して黙って通さない**。
const EXTERNAL_REFS_FILE = path.join(REPO_ROOT, "tools", "external-refs.json");
let externalRefsStatus = "未読込";
function loadExternalRefs() {
  if (!fs.existsSync(EXTERNAL_REFS_FILE)) {
    externalRefsStatus = "設定ファイルなし(C9 は実行しない)";
    return [];
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(EXTERNAL_REFS_FILE, "utf8"));
  } catch (e) {
    // 壊れた設定を「設定なし」と同じ扱いにしない。黙って検査を飛ばすと退行に気づけない。
    externalRefsStatus = "設定ファイルが読めません: " + String((e && e.message) || e);
    return null;
  }
  if (!Array.isArray(raw)) {
    externalRefsStatus = "設定ファイルの形式が不正(配列ではない)";
    return null;
  }
  externalRefsStatus = "設定あり(" + raw.length + "件)";
  // commandListPattern が不正な正規表現だと new RegExp が投げる。
  // ここで捕まえないと C9 の warning を素通りしてトップレベルのエラーになり、
  // 「設定が壊れている場合も必ず出す」という意図から漏れる。
  try {
    return raw.map((r) => ({
      ...r,
      localCandidates: [
        r.localCandidateEnv ? process.env[r.localCandidateEnv] : undefined,
        ...(r.localCandidates || []),
      ],
      commandListRe: r.commandListPattern
        ? new RegExp(r.commandListPattern, r.commandListFlags || "")
        : null,
    }));
  } catch (e) {
    externalRefsStatus = "設定ファイルの内容が不正です: " + String((e && e.message) || e);
    return null;
  }
}

// 本文から「他ブランチの実在パス」を抽出する。プレースホルダ(<CMD> 等)や glob を
// 含む断片はディレクトリまで切り詰める。切り詰め結果が prefix だけなら捨てる。
function extractExternalPaths(text, token, mapTo, out) {
  // 閉じ引用符も境界にする（node "…/mask.mjs" のような書き方で余分な文字を拾わないため）
  const stop = [' ', '\t', '\n', '`', ')', '|', '、', '。', String.fromCharCode(34), String.fromCharCode(39)];
  for (let i = 0; ; ) {
    const at = text.indexOf(token, i);
    if (at < 0) break;
    i = at + token.length;
    let end = i;
    while (end < text.length && !stop.includes(text[end])) end++;
    let rest = text.slice(i, end).replace(/[.,;:）)]+$/, '');
    // プレースホルダ(<CMD> 等)や glob より前で切り、ディレクトリまで丸める
    const cut = rest.search(/[<*{]/);
    if (cut >= 0) rest = rest.slice(0, cut).replace(/[^/]*$/, '');
    const p = mapTo + rest;
    if (rest && p !== mapTo) out.add(p);
  }
}

function gitTreeFiles(ref) {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', ref], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean);
}

// 参照元を1つ決める。ラッパー本体と同じ優先順（ローカル作業ツリー → プラグイン
// キャッシュ → remote ref）にする。片方だけが見る参照元があると、C9 が
// 「ラッパーは壊れているのに検査は通る」状態を作ってしまう。
function resolveExternalSource(spec) {
  const localRoot = (spec.localCandidates || []).filter(Boolean).find((d) => fs.existsSync(d));
  if (localRoot) {
    return {
      label: `ローカル ${localRoot}`,
      exists: (rel) => fs.existsSync(path.join(localRoot, rel.split('/').join(path.sep))),
    };
  }
  // キャッシュではプラグインルートがバージョンディレクトリそのもの。
  // rel から pathPrefix を落として突き合わせる。
  const cacheBase = spec.cacheDir && path.join(HOME, ...spec.cacheDir);
  if (cacheBase && fs.existsSync(cacheBase)) {
    const versions = fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const latest = versions[versions.length - 1];
    if (latest) {
      const root = path.join(cacheBase, latest);
      return {
        label: `プラグインキャッシュ ${root}`,
        exists: (rel) => {
          if (!rel.startsWith(spec.pathPrefix)) return false;
          const sub = rel.slice(spec.pathPrefix.length);
          return fs.existsSync(path.join(root, sub.split('/').join(path.sep)));
        },
      };
    }
  }
  const files = gitTreeFiles(spec.ref);
  if (!files) return null; // local も cache も ref も無ければ検査しない
  const set = new Set(files);
  return {
    label: `remote ref ${spec.ref}`,
    exists: (rel) => (rel.endsWith('/') ? files.some((f) => f.startsWith(rel)) : set.has(rel)),
  };
}

function checkExternalRefs(tree, add) {
  const specs = loadExternalRefs();
  if (specs === null) {
    // 設定が壊れている場合は検査できないことを警告として出す(沈黙させない)。
    add("C9", "warning", "外部参照検査を実行できません: " + externalRefsStatus);
    return;
  }
  if (specs.length === 0) {
    // 0件でも「問題なし」と読ませない。理由を出す。
    add("C9", "info", "外部参照検査: " + externalRefsStatus);
    return;
  }
  for (const spec of specs) {
    const buf = tree.read(spec.wrapper);
    if (!buf) continue;
    const text = normLF(buf.toString('utf8'));

    // 廃止済みパスへの逆戻りを先に見る。存在検査では捕まらない（別構造なので prefix に
    // 一致せず、抽出対象にすら入らない）ため、明示的な禁止パターンとして持つ。
    for (const bad of spec.obsoletePatterns || []) {
      if (text.includes(bad)) {
        add('C9', 'warning', `${spec.wrapper} に廃止済みの外部パスが残っている: ${bad}`);
      }
    }

    // パス抽出とコマンド名抽出は分けて数える。コマンド名が取れているだけで
    // 「参照構造は健在」と誤判定しないため。
    const fromPaths = new Set();
    extractExternalPaths(text, spec.pathPrefix, spec.pathPrefix, fromPaths);
    for (const alias of spec.rootAliases || []) {
      extractExternalPaths(text, alias, spec.pathPrefix, fromPaths);
    }
    if (!fromPaths.size) {
      add('C9', 'warning', `${spec.wrapper} から外部パス参照(${spec.pathPrefix}) が1件も抽出できない。参照構造が変わった可能性がある。`);
    }

    const wanted = new Set(fromPaths);
    const m = spec.commandListRe.exec(text);
    if (m) {
      for (const q of m[1].match(/`([^`]+)`/g) || []) {
        wanted.add(spec.commandDir + q.replace(/`/g, '') + '.md');
      }
    } else {
      add('C9', 'warning', `${spec.wrapper} からコマンド許可リストを読み取れない。書式が変わった可能性がある。`);
    }
    if (!wanted.size) continue;

    const src = resolveExternalSource(spec);
    if (!src) continue;
    for (const rel of [...wanted].sort().filter((r) => !src.exists(r))) {
      add('C9', 'warning', `${spec.wrapper} が参照する外部パスが ${src.label} に見つからない: ${rel}`);
    }
  }
}

// ---- C10: 機微値スキャン ------------------------------------------------
// README の「push 前に資格情報・接続文字列・実ユーザーパスが差分に無いこと」は
// 人間の目だけが担保する手動指示で、P26（エラーを出さずに失敗する）そのもの。
// これは正しさの性質なので severity は error（C5/C6/C9 の警告とは扱いを分ける）。
//
// パターンは「キー名だけ」ではなく「キー=十分な長さの値」で判定する。キー名だけで
// 判定すると、このファイル自身のパターン定義に自己マッチしてしまう。
const SECRET_PATTERNS = [
  // キー名の先頭に \b を置かない。AZURE_STORAGE_CONNECTION_STRING のように
  // アンダースコア前置だと \b が成立せず取り逃す。
  ['資格情報の代入', /(AccountKey|SharedAccessKey|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|connection[_-]?string|database[_-]?url|password|passwd)\b\s*[=:]\s*["']?([A-Za-z0-9+/_\-.=:@;~%]{16,})/i],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/],
  ['Basic 認証', /\bBasic\s+[A-Za-z0-9+/=]{16,}/],
  ['SAS 署名', /(SharedAccessSignature=|[?&]sig=)[A-Za-z0-9%+/=]{16,}/i],
  ['接続文字列', /DefaultEndpointsProtocol\s*=\s*https?/i],
  ['実ユーザーパス', /[A-Za-z]:[\\/]Users[\\/](?![<%])[^\\/\s"'()|]+/],
  // URL の userinfo（https://org@host/...）は資格情報ではないので直前の / を除外する
  ['メールアドレス', /(?<![/\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

function checkSecrets(files, tree, add) {
  for (const rel of files) {
    const buf = tree.read(rel);
    if (!buf) continue;
    const lines = normLF(buf.toString('utf8')).split('\n');
    for (const [label, re] of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (!m) continue;
        // 値は一切出力しない。場所・種別・長さだけ示す。
        add('C10', 'error', `${rel}:${i + 1} に機微値の疑い [${label}] 長さ ${m[0].length}文字`);
      }
    }
  }
}

function runChecks(captureTarget) {
  const tree = buildTree(captureTarget);
  const findings = [];
  const add = (id, severity, message) => findings.push({ id, severity, message });

  const readmeBuf = readIfExists(path.join(REPO_ROOT, README_REL));
  const readmeLines = readmeBuf ? normLF(readmeBuf.toString('utf8')).split('\n') : null;
  if (!readmeLines) add('C1', 'error', `${README_REL} が読めません。`);

  // C1: 「中身」表のファイル列が、許可リストから導出した実ファイル集合と一致するか
  const contentRows = readmeLines && tableFirstColumn(readmeLines, /^##\s+中身\s*$/);
  if (readmeLines && !contentRows) add('C1', 'error', `${README_REL} に「## 中身」の表が見つかりません。`);
  const extraRows = trackedExtraRows();
  if (contentRows && !extraRows) {
    add("C1", "warning", "git 追跡一覧を取得できないため「中身」表の照合を省略した。");
  }
  if (contentRows && extraRows) {
    const expected = [...inventory(tree), ...extraRows].sort();
    const { missing, extra } = diffSets(expected, contentRows);
    for (const m of missing) add('C1', 'error', `「中身」表に未掲載: ${m}`);
    for (const x of extra) add('C1', 'error', `「中身」表に実在しない行: ${x}`);
    // C7: 過不足一致だけでは同一ファイルの2重掲載を通してしまう
    for (const d of duplicates(contentRows)) add('C7', 'error', `「中身」表が重複掲載: ${d}`);
  }

  // C4: 「Codex ラッパー一覧」表が codex-prompts/*.md と一致するか
  const wrapperRows = readmeLines && tableFirstColumn(readmeLines, /^##\s+Codex\s+ラッパー一覧\s*$/);
  if (readmeLines && !wrapperRows) add('C4', 'error', `${README_REL} に「## Codex ラッパー一覧」の表が見つかりません。`);
  if (wrapperRows) {
    const expected = tree.listFiles('codex').map((n) => n.replace(/\.md$/, '')).sort();
    const { missing, extra } = diffSets(expected, wrapperRows);
    for (const m of missing) add('C4', 'error', `Codexラッパー一覧に未掲載: ${m}`);
    for (const x of extra) add('C4', 'error', `Codexラッパー一覧に実在しない行: ${x}`);
    for (const d of duplicates(wrapperRows)) add('C7', 'error', `Codexラッパー一覧が重複掲載: ${d}`);
  }

  // C2: ut-*.md が6節骨格を順序どおり持つか
  for (const name of tree.listFiles('claude')) {
    if (!(name.startsWith(PREFIX) && name.endsWith(SUFFIX))) continue;
    const rel = `commands/${toPosix(name)}`;
    const buf = tree.read(rel);
    if (!buf) { add('C2', 'error', `${rel} が読めません。`); continue; }
    const heads = normLF(buf.toString('utf8')).split('\n')
      .map((l) => l.match(/^##\s+(\d+)\.\s*(\S+)/))
      .filter(Boolean)
      .map((m) => `${m[1]}. ${m[2]}`);
    const want = SKELETON.map((s, i) => `${i + 1}. ${s}`);
    const got = heads.filter((h) => want.includes(h));
    if (got.join(' / ') !== want.join(' / ')) {
      add('C2', 'error', `${rel} の6節骨格が不一致。期待: ${want.join(' / ')} / 実際: ${got.join(' / ') || '(なし)'}`);
    }
  }

  // C3: commands/ 本文中の templates 参照が実在するか
  const templateRe = /commands\/templates\/[A-Za-z0-9._-]+/g;
  for (const name of tree.listFiles('claude')) {
    if (!name.endsWith(SUFFIX)) continue;
    const rel = `commands/${toPosix(name)}`;
    const buf = tree.read(rel);
    if (!buf) continue;
    for (const ref of new Set(normLF(buf.toString('utf8')).match(templateRe) || [])) {
      if (!tree.read(ref)) add('C3', 'error', `${rel} が実在しないテンプレートを参照: ${ref}`);
    }
  }

  // C5: README の行数(_md-diet 準拠)。正しさの性質ではなく起草上の規律なので warning に留める。
  if (readmeLines) {
    const count = readmeLines[readmeLines.length - 1] === '' ? readmeLines.length - 1 : readmeLines.length;
    if (count > README_MAX_LINES) {
      add('C5', 'warning', `${README_REL} が ${count} 行(上限 ${README_MAX_LINES} 行)。表の自動生成や補足の外出しを検討する。`);
    }
  }

  // C6: 配備されない補助ファイルが commands/templates/ に増えていないか
  const allowed = new Set(CLAUDE_TEMPLATE_FILES.map((n) => toPosix(n)));
  for (const name of listTopLevelFiles(path.join(REPO_ROOT, 'commands', 'templates'))) {
    const rel = `templates/${name}`;
    if (!allowed.has(rel)) {
      add('C6', 'warning', `commands/${rel} は許可リスト外のため配備されない。CLAUDE_TEMPLATE_FILES への追加要否を確認する。`);
    }
  }

  // C10: 機微値の混入。検査対象は C1 と同じ集合（方向別の候補ツリー経由で読む）
  checkSecrets([...inventory(tree), ...(extraRows || [])], tree, add);

  // C9: 他ブランチのパス参照が相手側の移行で陳腐化していないか
  checkExternalRefs(tree, add);
  checkClassification(tree, add);

  return findings;
}

// ---- C11/C12: 分類ラベルと設計方針の整合 --------------------------------
// C1-C9 は「ファイルが在るか」「構成が揃っているか」までしか見ない。
// 「このコマンドが社内固有に依存するか」は人が決めるものなので、決めた結果が
// 3箇所(frontmatter / README の分類表 / publish.allowlist)で食い違っていないことを
// 機械で見る。人の記憶を担保にしない。
const SCOPE_VALUES = ['generic', 'org-specific'];
// docs/command-design.md「2. 採用しているフィールド」と対応する。
// ここを増やすときは設計方針側も直す(C12 が突き合わせる)。
const ALLOWED_FRONTMATTER_KEYS = [
  'description',
  'argument-hint',
  'disable-model-invocation',
  'metadata',
  'disallowed-tools',
];
const DESIGN_DOC = 'docs/command-design.md';

function parseFrontmatter(text) {
  const lines = normLF(text).split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const topKeys = [];
  let scope = null;
  let inMetadata = false;
  for (const ln of lines.slice(1, end)) {
    const top = ln.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
    if (top) {
      topKeys.push(top[1]);
      inMetadata = top[1] === 'metadata';
      continue;
    }
    if (inMetadata) {
      const m = ln.match(/^\s+scope:\s*(\S+)\s*$/);
      if (m) scope = m[1];
    }
  }
  return { topKeys, scope };
}

// README の「## コマンドの分類」表から scope を読む
function readReadmeScopes(readmeText) {
  const out = new Map();
  if (!readmeText) return out;
  const lines = normLF(readmeText).split('\n');
  let inSection = false;
  for (const ln of lines) {
    if (ln.startsWith('## ')) inSection = ln.includes('コマンドの分類');
    if (!inSection) continue;
    const m = ln.match(/^\|\s*`(ut-[^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(\S+)\s*\|/);
    if (m) out.set(m[1], { scope: m[2], published: m[3] });
  }
  return out;
}

function readAllowlistCommands() {
  const p = path.join(REPO_ROOT, 'publish.allowlist');
  if (!fs.existsSync(p)) return null;
  const out = new Set();
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const from = (l.includes('->') ? l.slice(0, l.indexOf('->')) : l).trim();
    const m = from.match(/^commands\/(ut-[A-Za-z0-9-]+)\.md$/);
    if (m) out.add(m[1]);
  }
  return out;
}

function checkClassification(tree, add) {
  // listCommands は templates/ 配下も返す。分類の対象は直下の ut-*.md だけ。
  const names = listCommands(REPO_CMD_DIR).filter(
    (n) => !n.includes('/') && !n.includes(String.fromCharCode(92)) && /^ut-[A-Za-z0-9-]+[.]md$/.test(n)
  );
  if (!names.length) {
    add('C11', 'error', 'ut-*.md が1本も見つかりません。分類を検査できません。');
    return;
  }
  const scopes = new Map();
  for (const name of names) {
    const rel = 'commands/' + name;
    const buf = tree.read(rel);
    if (!buf) { add('C11', 'error', rel + ' が読めません。'); continue; }
    const fm = parseFrontmatter(buf.toString('utf8'));
    if (!fm) { add('C11', 'error', rel + ' の frontmatter を解析できません。'); continue; }
    for (const k of fm.topKeys) {
      if (!ALLOWED_FRONTMATTER_KEYS.includes(k)) {
        add('C12', 'error', rel + ' が設計方針に無い frontmatter キーを使用: ' + k +
          '（' + DESIGN_DOC + ' を更新するか、使用をやめる）');
      }
    }
    if (!fm.scope) {
      add('C11', 'error', rel + ' に metadata.scope がありません（未記載を既定値で通さない）。');
      continue;
    }
    if (!SCOPE_VALUES.includes(fm.scope)) {
      add('C11', 'error', rel + ' の metadata.scope が不正: ' + fm.scope +
        '（許可: ' + SCOPE_VALUES.join(' / ') + '）');
      continue;
    }
    scopes.set(name.replace(/\.md$/, ''), fm.scope);
  }

  // 設計方針そのものが消えていたら、C12 は根拠を失う。黙って通さない。
  if (!tree.read(DESIGN_DOC)) {
    add('C12', 'error', DESIGN_DOC + ' がありません。採用キーの根拠が失われています。');
  }

  // README の分類表と突合
  const readmeBuf = tree.read('README.md');
  const rm = readReadmeScopes(readmeBuf ? readmeBuf.toString('utf8') : '');
  if (rm.size === 0) {
    add('C11', 'error', 'README に「## コマンドの分類」表が見つかりません。');
  } else {
    for (const [name, scope] of scopes) {
      const row = rm.get(name);
      if (!row) { add('C11', 'error', 'README の分類表に未掲載: ' + name); continue; }
      if (row.scope !== scope) {
        add('C11', 'error', name + ' の scope が食い違い: frontmatter=' + scope + ' / README=' + row.scope);
      }
    }
    for (const name of rm.keys()) {
      if (!scopes.has(name)) add('C11', 'error', 'README の分類表に実在しないコマンド: ' + name);
    }
  }

  // publish.allowlist との含意: 載っているなら generic でなければならない
  const allow = readAllowlistCommands();
  if (allow === null) {
    add('C11', 'warning', 'publish.allowlist が無いため、公開対象との突合を省略しました。');
  } else {
    for (const name of allow) {
      if (!scopes.has(name)) {
        add('C11', 'error', 'publish.allowlist に実在しないコマンド: ' + name);
      } else if (scopes.get(name) !== 'generic') {
        add('C11', 'error', name + ' は scope=' + scopes.get(name) + ' なのに publish.allowlist に載っています。');
      }
    }
    // README の「公開用ビルドに含める」列とも突合する
    for (const [name, row] of rm) {
      const listed = allow.has(name);
      const said = row.published === 'あり';
      if (listed !== said) {
        add('C11', 'error', name + ' の公開有無が食い違い: allowlist=' + (listed ? 'あり' : 'なし') +
          ' / README=' + row.published);
      }
    }
  }
}

function printChecks(findings, scopeLabel) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');
  // 表示と件数が食い違うと、出ている行が集計に入らず読み手が取り違える。
  // 未知の severity は「不明」として必ず件数に出す(黙って警告に丸めない)。
  const known = new Set(['error', 'warning', 'info']);
  const unknownSev = findings.filter((f) => !known.has(f.severity));
  const label = (sv) => (sv === 'error' ? 'NG' : sv === 'warning' ? '警告' : sv === 'info' ? '情報' : '不明(' + sv + ')');
  console.log(`整合性検査  : ${scopeLabel}`);
  for (const f of findings) {
    console.log(`  ${label(f.severity)} [${f.id}] ${f.message}`);
  }
  console.log(
    `  結果: エラー ${errors.length} / 警告 ${warnings.length} / 情報 ${infos.length}` +
      (unknownSev.length ? ` / 不明 ${unknownSev.length}` : '')
  );
  return errors.length;
}

function computePlan() {
  const names = [...new Set([...listCommands(REPO_CMD_DIR), ...listCommands(LIVE_CMD_DIR)])].sort();
  return names.map((name) => {
    const repoBuf = readIfExists(path.join(REPO_CMD_DIR, name));
    const liveBuf = readIfExists(path.join(LIVE_CMD_DIR, name));
    const repoHash = repoBuf && hashOf(repoBuf);
    const liveHash = liveBuf && hashOf(liveBuf);
    let state;
    if (repoBuf && liveBuf) state = repoHash === liveHash ? 'unchanged' : 'differs';
    else if (repoBuf) state = 'repo-only';
    else state = 'live-only';
    return { name, state, repoBuf, liveBuf };
  });
}

function printPlan(plan) {
  const label = {
    unchanged: '一致',
    differs: '食い違い',
    'repo-only': '正本のみ(未配置)',
    'live-only': '実行場所のみ(未取込)',
  };
  console.log(`正本      : ${REPO_CMD_DIR}`);
  console.log(`実行場所  : ${LIVE_CMD_DIR}`);
  console.log(`対象      : ${targetName} (${target.description})`);
  console.log(`モード    : ${mode}${force ? ' --force' : ''}`);
  console.log('');
  if (!plan.length) {
    console.log(`対象 ${target.filePatternLabel} がありません。`);
    return;
  }
  const width = Math.max(...plan.map((p) => p.name.length));
  for (const p of plan) console.log(`  ${p.name.padEnd(width)}  ${label[p.state]}`);
  console.log('');
  const n = (state) => plan.filter((p) => p.state === state).length;
  console.log(`一致 ${n('unchanged')} / 食い違い ${n('differs')} / 正本のみ ${n('repo-only')} / 実行場所のみ ${n('live-only')}`);
}

function run() {
  if (!fs.existsSync(REPO_CMD_DIR)) fail(`正本ディレクトリがありません: ${REPO_CMD_DIR}`);

  if (mode === 'check') {
    return printChecks(runChecks(null), '正本(repo)') ? 3 : 0;
  }

  if (mode === 'apply' || mode === 'capture') {
    if (skipCheck) {
      // --no-check でも機微値スキャン(C10)だけは必ず実行する。C1-C9 は「壊れたまま急ぎ
      // 配る」判断が成立しうるが、機微値の流出はどんな緊急性でも取り返しがつかない。
      console.log('警告: 整合性検査をスキップしています(--no-check)。機微値スキャン(C10)は必ず実行します。');
      const captureTarget = mode === 'capture' ? targetName : null;
      const only = runChecks(captureTarget).filter((f) => f.id === 'C10');
      if (printChecks(only, '機微値スキャン(C10)のみ')) {
        console.log('');
        console.log('ブロック: 機微値の疑いがあります。--no-check では回避できません。');
        return 3;
      }
      console.log('');
    } else {
      const captureTarget = mode === 'capture' ? targetName : null;
      const scope = captureTarget ? `取り込み後の状態(${LIVE_CMD_DIR} を反映)` : '正本(repo)';
      if (printChecks(runChecks(captureTarget), scope)) {
        console.log('');
        console.log(`ブロック: 整合性検査でエラーがあります。直してから ${mode} してください。`);
        console.log('検査ロジック側の問題で急ぎ配りたい場合のみ --no-check を付けてください。');
        return 3;
      }
      console.log('');
    }
  }

  const plan = computePlan();
  printPlan(plan);

  if (mode === 'dry-run') {
    console.log('');
    console.log('(dry-run: 何も書き込んでいません。整合性検査は --check)');
    const differs = plan.filter((p) => p.state === 'differs');
    if (differs.length) {
      console.log('食い違いがあります。どちらを正とするか決めてから実行してください:');
      console.log(`  正本を正とする  : node tools/deploy.mjs --target ${targetName} --apply --force`);
      console.log(`  手元編集を正とする: node tools/deploy.mjs --target ${targetName} --capture --force`);
    }
    return 0;
  }

  const toRepo = mode === 'capture';
  const destDir = toRepo ? REPO_CMD_DIR : LIVE_CMD_DIR;
  const addState = toRepo ? 'live-only' : 'repo-only';
  const srcOf = (p) => (toRepo ? p.liveBuf : p.repoBuf);
  const adds = plan.filter((p) => p.state === addState);
  const overwrites = plan.filter((p) => p.state === 'differs');

  if (overwrites.length && !force) {
    console.log('');
    console.log(`ブロック: 内容が食い違うファイルが ${overwrites.length} 件あります。`);
    for (const p of overwrites) console.log(`  - ${p.name}`);
    console.log(`このまま ${mode} すると反対側の編集が失われます。意図した向きなら --force を付けてください`);
    console.log('(上書き前に .bak-<時刻>-<ミリ秒> を残します。同名があれば .1 .2 ... で衝突回避します)。');
    return 1;
  }

  if (!adds.length && !overwrites.length) {
    console.log('');
    console.log('作業不要(すべて一致)。');
    return 0;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const ts = stamp();
  let added = 0;
  let updated = 0;

  for (const p of [...adds, ...overwrites]) {
    const dest = path.join(destDir, p.name);
    const buf = srcOf(p);
    if (!buf) fail(`内部エラー: ${p.name} の読み込み元がありません。`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const isOverwrite = fs.existsSync(dest);
    const backup = isOverwrite ? uniqueBackupPath(dest, ts) : null;
    if (backup) fs.copyFileSync(dest, backup);
    writeAtomic(dest, buf);
    if (isOverwrite) {
      updated++;
      console.log(`  更新 ${p.name}  (退避: ${path.basename(backup)})`);
    } else {
      added++;
      console.log(`  追加 ${p.name}`);
    }
  }

  console.log('');
  console.log(`完了: 追加 ${added} / 更新 ${updated} / 削除 0 (削除は行わない設計)`);
  if (!toRepo) console.log(target.restartHint);
  else console.log('正本を更新しました。git status で差分を確認して commit してください。');
  return 0;
}

try {
  process.exit(run());
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
}
