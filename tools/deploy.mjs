#!/usr/bin/env node
// deploy.mjs — ut-* 個人コマンド類を、正本(このリポジトリ)と
// 実行場所(~/.claude/commands/, ~/.agents/skills/)の間で配置/回収する。
//
// 設計上の約束:
//   1. 既定は dry-run。書き込むには --apply / --capture を明示する。
//   2. 削除は一切しない。片側にしか無いファイルは「追加」としてしか扱わない。
//   3. 両側の内容が食い違っている場合は既定でブロックする。どちら向きに上書きするかは
//      人間が決めるべきで、暗黙に選ぶと反対側の編集が消える。--force で上書き(退避を残す)。
//   4. Claude 対象は ut-*.md と許可済み templates のみ。~/.claude/commands/ に同居する
//      他者所有ファイルには触らない。Codex skills 対象は codex-skills/<名前>/ の SKILL.md と
//      agents/openai.yaml のみ。~/.agents/skills/ の他の skill は列挙もしない。同名でも管理の記録
//      (~/.agents/skills/.ut-commands-managed.json)に無い skill は --force でも引き取らない。
//   5. 比較は LF 正規化後の内容ハッシュ。core.autocrlf=true の環境で改行差を
//      「変更」と誤検知しないため。
//   6. --apply / --capture の前に整合性検査(--check)を通す。検査対象は「向き」で変える。
//      --apply は repo 側が源なので repo を、--capture は取り込み後の状態を検査する。
//      repo だけを見ると、壊れた実行場所の内容を無検査で取り込んでしまう。
//
// 使い方:
//   node tools/deploy.mjs                          # Claude の状態表示のみ(既定)
//   node tools/deploy.mjs --check                  # 整合性検査のみ(書き込まない)
//   node tools/deploy.mjs --dry-run                # 状態表示のみ(書き込まないことの明示。--apply / --capture / --check と併用すると exit 2)
//   node tools/deploy.mjs --target claude --apply # 正本 → ~/.claude/commands/
//   node tools/deploy.mjs --target claude --capture
//   node tools/deploy.mjs --target codex-skills --apply   # 正本 → ~/.agents/skills/
//   node tools/deploy.mjs --target codex-skills --capture
//
// 終了コード: 0=成功/作業不要, 1=食い違いによりブロック, 2=エラー, 3=整合性検査NG

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyedSecretRe } from '../commands/templates/ut-review.mjs';

const PREFIX = 'ut-';
const SUFFIX = '.md';
const CLAUDE_TEMPLATE_FILES = [
  path.join('templates', 'alert-report.mjs'),
  path.join('templates', 'collect-alerts.mjs'),
  path.join('templates', 'ut-report-html-template.html'),
  path.join('templates', 'ut-reportdeck.mjs'),
  path.join('templates', 'ut-reportdeck-template.html'),
  path.join('templates', 'ut-reportdeck-guide.txt'),
  path.join('templates', 'ut-review.mjs'),
  path.join('templates', 'ut-review-codex.mjs'),
  path.join('templates', 'ut-review-checks.json'),
  path.join('templates', 'ut-handoff.mjs'),
  path.join('templates', 'ut-review-guide.txt'),
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
    // 配備するテンプレートの一覧から組み立てる（手書きにすると、一覧に足したときに表示だけ古いまま残る）
    filePatternLabel: 'ut-*.md + templates/{' + CLAUDE_TEMPLATE_FILES.map((f) => path.basename(f)).join(',') + '}',
    restartHint: 'Claude Code のセッションを開き直すと反映されます。',
    listFiles(dir) {
      const topLevel = listTopLevelFiles(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
      const templates = CLAUDE_TEMPLATE_FILES.filter((n) => fs.existsSync(path.join(dir, n)));
      return [...topLevel, ...templates].sort();
    },
  },
  // Codex skills（custom prompts の後継）。配置先はユーザー単位の ~/.agents/skills。
  // 扱うのは codex-skills/ にある skill の名前と、その中の決まったファイル（SKILL_FILES）だけ。
  // 配置先の他の skill は列挙もしない（他者の skill を取り込んだり上書きしたりしないため）
  'codex-skills': {
    repoDir: path.join(REPO_ROOT, 'codex-skills'),
    repoDirName: 'codex-skills',
    liveDir: path.join(HOME, '.agents', 'skills'),
    description: 'Codex skills（自動の呼び出しは止める）',
    filePatternLabel: '<name>/agents/openai.yaml + <name>/SKILL.md',
    restartHint: 'Codex のセッションを開き直すと反映されます。',
    listFiles(dir) {
      const out = [];
      for (const name of managedSkillNames()) {
        for (const f of SKILL_FILES) {
          const rel = path.join(name, ...f.split('/'));
          if (fs.existsSync(path.join(dir, rel))) out.push(rel);
        }
      }
      return out;
    },
  },
};

// skill の中で配置するファイル。自動の呼び出しを止める設定（openai.yaml）を先に書き、入口（SKILL.md）を最後に書く。
// 途中で止まっても、設定の無い入口が Codex から見える状態を作らないため
const SKILL_FILES = ['agents/openai.yaml', 'SKILL.md'];
// openai.yaml の正規の形。文字列を探すのではなく、この形との完全一致で判定する
// （コメントの中の false、階層の誤り、"false" のような文字列、重複キー、構文の誤りは、すべて不一致になる）
const SKILL_POLICY = 'policy:\n  allow_implicit_invocation: false\n';
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
function managedSkillNames() {
  let entries;
  try { entries = fs.readdirSync(path.join(REPO_ROOT, 'codex-skills'), { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // リンク（ジャンクション）も数える。数えないと、その skill は黙って配置の対象から外れる。数えた上で、書き込みの前のリンクの確認が止める
  return entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && SKILL_NAME_RE.test(e.name)).map((e) => e.name).sort();
}
// 1つの skill の中では openai.yaml を SKILL.md より先に処理する
const fileOrder = (name) => {
  const p = name.split(path.sep).join('/');
  const i = SKILL_FILES.findIndex((f) => p.endsWith('/' + f));
  return i < 0 ? 0 : i;
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
if (targetIndex >= 0 && !argv[targetIndex + 1]) fail('--target の値がありません。claude / codex-skills のいずれかを指定してください。');
if (targetName === 'codex') fail('--target codex（旧入口の custom prompts）は撤去しました。Codex 側は --target codex-skills を使ってください（配置済みの ~/.codex/prompts/ の旧ファイルは削除しないので、要らなければ手で消す）。');
if (!Object.hasOwn(TARGETS, targetName)) fail(`不明な target: ${targetName} (claude / codex-skills のみ対応)。`);
if (has('--apply') && has('--capture')) {
  fail('--apply と --capture は同時に指定できません(どちら向きに上書きするかが決まらない)。');
}
if (has('--check') && (has('--apply') || has('--capture'))) {
  fail('--check は単独で使ってください(--apply / --capture は前段で自動的に検査します)。');
}
if (has('--no-check') && !(has('--apply') || has('--capture'))) {
  fail('--no-check は --apply / --capture と一緒にのみ指定できます。');
}
// --dry-run は「書き込まない」の明示。--apply / --capture と併用されたときに黙って書く側を選ぶと、
// 利用者が書かないつもりで打ったコマンドが書き込む（下のモードの判定は --dry-run を見ない）。--check と一緒も、どちらの意味かが決まらないので止める
if (has('--dry-run') && (has('--apply') || has('--capture') || has('--check'))) {
  fail('--dry-run は --apply / --capture / --check と同時に指定できません(書き込むのか書き込まないのかが決まらない)。何も書き込んでいません。');
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

// 一時ファイルは一意な名前で、既にあるものは開かない（wx）。固定名だと、そこがリンクにすり替えられていたときにリンクの先を上書きする
function writeAtomic(dest, buf) {
  const tmp = `${dest}.${process.pid}.${createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, buf, { flag: 'wx' });
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
  node tools/deploy.mjs --dry-run                      状態表示のみ(書き込まないことの明示。--apply / --capture / --check と同時に指定すると、何も書かずに exit 2 で止まる)
  node tools/deploy.mjs --target claude --apply       正本 → ${TARGETS.claude.liveDir}
  node tools/deploy.mjs --target claude --capture     ${TARGETS.claude.liveDir} → 正本
  node tools/deploy.mjs --target codex-skills --apply ${TARGETS['codex-skills'].liveDir} へ skills を配置（codex-skills/ にある skill だけ）
  node tools/deploy.mjs --target codex-skills --capture ${TARGETS['codex-skills'].liveDir} → 正本（同上）
  node tools/deploy.mjs ... --force                   食い違いも上書き(上書き前に .bak-<時刻>-<ミリ秒> を残す)
  node tools/deploy.mjs ... --no-check                前段の整合性検査をスキップ(緊急時のみ)

Claude 対象は ut-*.md と許可済み templates のみ、
Codex skills 対象は codex-skills/<名前>/ の SKILL.md と agents/openai.yaml のみ。削除は行わない。
--apply / --capture は前段で整合性検査を通す。--capture は取り込み後の状態を検査する。
検査項目: C1 中身表とファイルの一致 / C2 ut-* の6節骨格 / C3 templates 参照の実在 /
          C4 Codexラッパー一覧の一致 / C5 README 行数(警告) / C6 未配備テンプレート(警告) /
          C7 表の重複掲載 / C9 外部参照の陳腐化(警告) /
          C10 機微値の混入（git の追跡・未追跡の全件。git が使えないときは省いた範囲を警告で出す） /
          C11 metadata.scope と README の分類表・publish.allowlist の一致 /
          C12 frontmatter のキーが設計方針（docs/command-design.md）にある /
          C13 skills の自動の呼び出しの停止（C10 と C13 は --no-check でも必ず実行する） /
          C14 codex-skills/ に配置の対象外のファイルが無い /
          C15 コマンドの名前の形 / C16 やめた名前を理由なしに使わない /
          C17 ディスク系の入口と出口の説明（description・argument-hint） /
          C18 commands/templates/ と Claude 配置先 templates/ の入れ子に .md を置かない（Claude Code がコマンドや skill として読み込む） /
          C19 /ut-handoff と /ut-takeover に「セッションの示し方」の決まりと禁止がある /
          C20 Claude Code にしか無い機能に頼る ut-*.md に「前提と、無いときの動作」表の行がある（警告。配備は止めない）`);
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
// 「表の漏れを検知する仕組み」が同じ漏れを起こす。null は git が使えない場合（理由は gitListNote に残す）。
// 引数と絞り込みはここ1か所に置き、runChecks ごとに1回だけ呼んで C1・C10・C14 に渡す（別々に書くと、除外の条件を片方だけ変えたときに
// 検査ごとの対象がずれる）。一覧は -z（NUL 区切り）で読む。改行区切りでは、git が引用して出す名前（タブ・改行・" を含むもの）が
// 実在しないパスとして黙って落ちる。
// 正本がリポジトリの最上位でなければ使わない。上位のリポジトリの .gitignore の対象のフォルダに正本があると、ls-files は成功して
// 空の一覧を返し、C10 が何も見ないまま通る（0件を「対象なし」と読まない）
let gitListNote = '';
const samePath = (a, b) => {
  const n = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* 解決できなければそのまま比べる */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
};
// git の失敗の理由。どの失敗も同じ文言にすると、一覧が大きすぎた（ENOBUFS）ときに、利用者が git の導入や場所を疑う
const GIT_LIST_MAX = 16 * 1024 * 1024;
function gitFailureNote(e, what) {
  if (e && e.code === 'ENOENT') return 'git を実行できない（git が見つからない）';
  if (e && e.code === 'ENOBUFS') return `git の${what}の出力が大きすぎて読めない（${GIT_LIST_MAX / 1024 / 1024} MB を超えた。.gitignore されていない大量の未追跡ファイルなど）`;
  const err = e && e.stderr ? String(e.stderr).trim().split(String.fromCharCode(10))[0].trim() : '';
  if (e && typeof e.status === 'number') return `git の${what}が失敗した（終了コード ${e.status}${err ? `: ${err.slice(0, 120)}` : ''}。正本が git のリポジトリでない、など）`;
  return `git の${what}を実行できない（${(e && (e.code || e.message)) || '理由不明'}）`;
}
function gitListedFiles() {
  let out;
  // 標準エラーは読み取って理由に使う（端末にそのまま出さない）
  const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  let top;
  try {
    top = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--show-toplevel'], opt).trim();
  } catch (e) {
    gitListNote = gitFailureNote(e, 'リポジトリの確認（rev-parse）');
    return null;
  }
  if (!samePath(top, REPO_ROOT)) {
    gitListNote = `git のリポジトリの最上位（${top}）が正本と違う`;
    return null;
  }
  try {
    out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { ...opt, maxBuffer: GIT_LIST_MAX });
  } catch (e) {
    gitListNote = gitFailureNote(e, '一覧（ls-files）');
    return null;
  }
  return out.split('\0').filter(Boolean)
    // index に残っているだけの削除済みファイルを除く（ls-files -c は staged deletion も返す）
    .filter((f) => fs.existsSync(path.join(REPO_ROOT, f.split('/').join(path.sep))));
}
function trackedExtraRows(files) {
  if (!files) return null;
  const deployedDirs = Object.values(TARGETS).map((t) => t.repoDirName + '/');
  return files
    .filter((f) => f !== README_REL)
    .filter((f) => !f.startsWith('.')) // ドット始まりの設定ファイルは表に載せない
    .filter((f) => !deployedDirs.some((d) => f.startsWith(d)))
    .sort();
}
// C10 の対象。C1 の対象（配置の対象と「中身」表の行）とは切り離し、git の追跡・未追跡（.gitignore の対象を除く）の全件にする。
// 配置の対象から導くと、許可リスト外のテンプレート・commands/ の ut- で始まらないファイル・codex-skills/ の対象外のファイル・
// README.md・ドットで始まるファイルは、push されても検査を通る（README は「C10 が機械的に止める」と書いている）。
// git が使えないときは README.md と commands/・codex-skills/ をたどったもので代え、partial を立てる（省いた範囲は呼び出し側が警告で出す）。
// リポジトリ全体はたどらない。.gitignore を解釈できないため、node_modules や退避などの push されないファイルで止まる
// git から取るのはファイル名だけで、中身は作業ツリーのものを読む（tree.read）。index の中身と push するコミットの差分は読まない
// （git add の後に作業ツリーだけ直した場合・コミットしてから消した場合は通る。README の「push 前に」の節に、人が見る手順として書いてある）
// 代わりの走査で除いた退避・書きかけ・OS のファイルは skipped に返し、呼び出し側が警告に名前を出す（C14 と同じ除外を、C10 で黙って当てない）
function secretScanFiles(files) {
  if (files) return { files, partial: false, skipped: [] };
  const out = [README_REL];
  const skipped = [];
  for (const d of ['commands', 'codex-skills']) {
    const sk = [];
    out.push(...walkRepoFiles(d, sk).map((f) => `${d}/${f}`));
    skipped.push(...sk.map((f) => `${d}/${f}`));
  }
  return { files: out, partial: true, skipped };
}
// git が使えないときの代わり。REPO_ROOT/<dirRel> の下をたどり、退避・書きかけ・OS のファイルを除く（戻り値は dirRel からの相対・/ 区切り）。
// 除いたものは skipped（配列を渡したとき）に入れる。除外は C14 の都合（退避で検査が止まらない）で、.gitignore の *.bak-*・*.tmp などと同じ範囲。
// C10 はこの除外で範囲が縮むので、除いた名前を警告に出す（checkSecretsAll）
// リンク（シンボリックリンク・ジャンクション）はたどらず、ファイルと同じく1件として返す（Dirent の isDirectory() が false のため）。
// C14 はリンクかどうかを見分けて示す（checkSkills）。C10 はフォルダへのリンクを読めずに飛ばす（git が push するのもリンクそのもの）
const FALLBACK_SKIP_RE = /\.bak-|\.tmp$|^desktop\.ini$|^Thumbs\.db$|^\.DS_Store$/i;
function walkRepoFiles(dirRel, skipped) {
  const out = [];
  const root = path.join(REPO_ROOT, dirRel);
  const walk = (d, rel) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${x.name}` : x.name;
      if (FALLBACK_SKIP_RE.test(x.name)) { if (skipped) skipped.push(r); }
      else if (x.isDirectory()) walk(path.join(d, x.name), r);
      else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}
// Claude の実行場所に手作業で置かれた依存パッケージも見る。配備対象の一覧には入らないため、
// 正本だけを見ていると node_modules 内の SKILL.md が意図せず読み込まれても気づけない。
// リンクはたどらない。読めない場所は配備対象外なので書き換えず、ここでは走査を打ち切る。
function nestedMarkdownFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}
const SKELETON = ['目的', '入力', '必須手順', '出力契約', '禁止事項', '補足'];
const README_MAX_LINES = 350;

const toPosix = (p) => p.split(path.sep).join('/');

// 検査対象の仮想ツリー。capture の時だけ、取り込む対象（実行場所の側の listFiles に入るもの）は実行場所の内容を repo より優先する。
// 実行場所を優先するのは取り込む対象だけにする。commands/notes.txt のような対象外のファイルは取り込まないので、取り込み後も正本の中身が
// 残る（push される）。実行場所の同名のファイル（同居する他者のもの）を読むと、正本の機微値を見逃し、他者のファイルで止まる
// 読んだ中身のハッシュは read に記録する（readHashes）。検査の後・計画の前に書き込み元が変わっていないかを、計画と照らすため
function buildTree(captureTarget) {
  const captureNames = captureTarget
    ? new Set(TARGETS[captureTarget].listFiles(TARGETS[captureTarget].liveDir).map((n) => toPosix(n)))
    : new Set();
  const readHashes = new Map();
  const record = (relPosix, buf) => {
    const h = buf ? hashOf(buf) : null;
    // 検査の途中で中身が変わった（同じファイルを2回読んで違った）ときは、どの中身を検査したかが決まらないので、照合が必ず外れる印にする
    if (readHashes.has(relPosix) && readHashes.get(relPosix) !== h) readHashes.set(relPosix, CHANGED_DURING_CHECK);
    else readHashes.set(relPosix, h);
    return buf;
  };
  return {
    readHashes,
    listFiles(tn) {
      const t = TARGETS[tn];
      const repoNames = t.listFiles(t.repoDir);
      if (tn !== captureTarget) return repoNames.sort();
      return [...new Set([...repoNames, ...t.listFiles(t.liveDir)])].sort();
    },
    read(relPosix) {
      if (captureTarget) {
        const prefix = `${TARGETS[captureTarget].repoDirName}/`;
        if (relPosix.startsWith(prefix) && captureNames.has(relPosix.slice(prefix.length))) {
          const name = relPosix.slice(prefix.length).split('/').join(path.sep);
          const liveBuf = readIfExists(path.join(TARGETS[captureTarget].liveDir, name));
          if (liveBuf) return record(relPosix, liveBuf);
        }
      }
      return record(relPosix, readIfExists(path.join(REPO_ROOT, relPosix.split('/').join(path.sep))));
    },
  };
}
const CHANGED_DURING_CHECK = '!changed-during-check';

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
// （publish-ref-ok: tools/external-refs.json 上流の作業リポジトリにだけある設定。公開物では無いため C9 を実行せず、その旨を表示する）
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
      wrappers: Array.isArray(r.wrappers) ? r.wrappers : [r.wrapper].filter(Boolean),
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
    if (!spec.wrappers.length) { add('C9', 'error', '外部参照の設定に wrapper がありません。'); continue; }
    for (const wrapper of spec.wrappers) {
      const buf = tree.read(wrapper);
      // 設定が指すラッパーが無いと、検査が何もしないまま通る（移行でパスが変わったのに設定が古い、など）
      if (!buf) { add('C9', 'error', `外部参照の設定が指すラッパーが無い: ${wrapper}（tools/external-refs.json を直す）`); continue; }
      const text = normLF(buf.toString('utf8'));

      // 廃止済みパスへの逆戻りを先に見る。存在検査では捕まらない（別構造なので prefix に
      // 一致せず、抽出対象にすら入らない）ため、明示的な禁止パターンとして持つ。
      for (const bad of spec.obsoletePatterns || []) {
        if (text.includes(bad)) {
          add('C9', 'warning', `${wrapper} に廃止済みの外部パスが残っている: ${bad}`);
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
        add('C9', 'warning', `${wrapper} から外部パス参照(${spec.pathPrefix}) が1件も抽出できない。参照構造が変わった可能性がある。`);
      }

      const wanted = new Set(fromPaths);
      // commandListPattern を省いた設定では commandListRe が null になる。exec すると TypeError で検査全体が異常終了し、
      // 警告の扱いのはずの C9 が --check も配備も止める。書式を確かめられないことを警告として出す
      const m = spec.commandListRe ? spec.commandListRe.exec(text) : null;
      if (!spec.commandListRe) {
        add('C9', 'warning', `${wrapper} のコマンド許可リストを確かめられない（tools/external-refs.json に commandListPattern が無い）。`);
      } else if (m) {
        for (const q of m[1].match(/`([^`]+)`/g) || []) {
          wanted.add(spec.commandDir + q.replace(/`/g, '') + '.md');
        }
      } else {
        add('C9', 'warning', `${wrapper} からコマンド許可リストを読み取れない。書式が変わった可能性がある。`);
      }
      if (!wanted.size) continue;

      const src = resolveExternalSource(spec);
      if (!src) continue;
      for (const rel of [...wanted].sort().filter((r) => !src.exists(r))) {
        add('C9', 'warning', `${wrapper} が参照する外部パスが ${src.label} に見つからない: ${rel}`);
      }
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
  // /ut-review のマスク・tools/mask.mjs とキー名・エスケープした JSON の扱いを共有する。
  // push 前の検査は、引用符の有無にかかわらず 16 文字以上だけを止める。
  ['資格情報の代入', keyedSecretRe(16, 16, true)],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/],
  ['Basic 認証', /\bBasic\s+[A-Za-z0-9+/=]{16,}/],
  ['SAS 署名', /(SharedAccessSignature=|[?&]sig=)[A-Za-z0-9%+/=]{16,}/i],
  ['接続文字列', /DefaultEndpointsProtocol\s*=\s*https?/i],
  ['実ユーザーパス', /[A-Za-z]:[\\/]Users[\\/](?![<%])[^\\/\s"'()|]+/],
  // URL の userinfo（https://org@host/...）は資格情報ではないので直前の / を除外する
  ['メールアドレス', /(?<![/\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

// 文字として照合できない中身。NUL を含むもの（バイナリ・UTF-16 の文字）と、先頭の印で分かる圧縮形式
// （zip とその仲間の docx・xlsx・pptx、gzip、7z、rar、PDF）。圧縮された中の接続文字列や資格情報は、正規表現に一致しないまま通る
const PACKED_MAGIC = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x1f, 0x8b], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x52, 0x61, 0x72, 0x21], [0x25, 0x50, 0x44, 0x46, 0x2d]];
const uninspectable = (buf) => buf.includes(0) || PACKED_MAGIC.some((sig) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b));
// 照合に使う文字の読み方。照合できない形式は、latin1（1 バイトを 1 文字にするので ASCII の並びが残る）と、
// NUL を含むときは UTF-16（Windows PowerShell 5 の既定の書き出し。BOM が FE FF なら BE、それ以外は LE）でも読む。
// 圧縮された中身は読めないので、警告（中身を検査していない）は残す
function textViews(buf) {
  if (!uninspectable(buf)) return [['', buf.toString('utf8')]];
  const views = [['latin1', buf.toString('latin1')]];
  if (buf.includes(0)) {
    const even = buf.subarray(0, buf.length - (buf.length % 2));
    views.push(buf[0] === 0xfe && buf[1] === 0xff ? ['UTF-16BE', Buffer.from(even).swap16().toString('utf16le')] : ['UTF-16LE', even.toString('utf16le')]);
  }
  return views;
}
function checkSecrets(files, tree, add) {
  const unread = [];
  for (const rel of files) {
    let buf;
    // フォルダへのリンク（ジャンクション）は読めない。git が push するのはリンクそのもので、先の中身ではない
    // （配置と取り込みは、リンクの確認が別に止める）
    try { buf = tree.read(rel); } catch (e) { if (e.code === 'EISDIR') continue; throw e; }
    if (!buf) continue;
    // 照合できない形式を黙って通さない（検査済みに見えるのに中身を見ていない）。範囲を縮めたことを警告で出す。
    // ただし文字として読める部分は照合する（NUL を 1 バイト含むだけで、生の ASCII の資格情報を警告だけで通さない）
    if (uninspectable(buf)) unread.push(rel);
    for (const [view, text] of textViews(buf)) {
      const lines = normLF(text).split('\n');
      for (const [label, re] of SECRET_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          const m = re.exec(lines[i]);
          if (!m) continue;
          // 値は一切出力しない。場所・種別・長さだけ示す。
          add('C10', 'error', `${rel}:${i + 1}${view ? `（${view} として読んだ行）` : ''} に機微値の疑い [${label}] 長さ ${m[0].length}文字`);
        }
      }
    }
  }
  if (unread.length) add('C10', 'warning', `中身を検査していないファイルがある（バイナリ・圧縮形式は文字として照合できない。読める文字の部分だけを照合した。機微値が無いことを人の目で確かめる）: ${unread.join(', ')}`);
}

// C10: 機微値の混入。検査対象は git の追跡・未追跡の全件に、配置の対象（capture のときは実行場所にだけあるものも）を足したもの。
// 方向別の候補ツリー経由で読む（capture のときは、取り込む対象だけ取り込み後の中身＝実行場所の側を見る）
function checkSecretsAll(tree, add, listed) {
  const scan = secretScanFiles(listed);
  if (scan.partial) {
    // 黙って範囲を縮めない。--no-check の表示（C10・C13 だけ）にも残るよう、C10 の警告として出す
    add('C10', 'warning', `git の追跡一覧を取得できないため（${gitListNote}）、tools/・docs/・ドットで始まるファイルなど、README.md・commands/・codex-skills/ 以外の機微値の検査を省いた（commands/ と codex-skills/ はフォルダをたどって検査した${scan.skipped.length ? `。ただし退避・書きかけ・OS のファイル（.gitignore の対象と同じ範囲）は検査していない: ${scan.skipped.join(', ')}` : ''}）`);
  }
  checkSecrets([...new Set([...inventory(tree), ...scan.files])], tree, add);
}

// 必須の検査（C10・C13）だけを走らせる。--no-check 用。ほかの検査を走らせてから絞ると、それらの例外（設定の誤りなど）で
// --no-check まで止まり、緊急時の逃げ道にならない。checkSkills が出す C14 は必須でないので落とす
function runRequiredChecks(captureTarget) {
  const tree = buildTree(captureTarget);
  const findings = [];
  const add = (id, severity, message) => findings.push({ id, severity, message });
  const listed = gitListedFiles();
  checkSecretsAll(tree, add, listed);
  checkSkills(tree, add, listed);
  return { findings: findings.filter((f) => f.id === 'C10' || f.id === 'C13'), tree };
}

function runChecks(captureTarget) {
  const tree = buildTree(captureTarget);
  const findings = [];
  const add = (id, severity, message) => findings.push({ id, severity, message });
  // git の一覧は1回だけ取り、C1・C10・C14 で共用する
  const listed = gitListedFiles();

  const readmeBuf = readIfExists(path.join(REPO_ROOT, README_REL));
  const readmeLines = readmeBuf ? normLF(readmeBuf.toString('utf8')).split('\n') : null;
  if (!readmeLines) add('C1', 'error', `${README_REL} が読めません。`);

  // C1: 「中身」表のファイル列が、許可リストから導出した実ファイル集合と一致するか
  const contentRows = readmeLines && tableFirstColumn(readmeLines, /^##\s+中身\s*$/);
  if (readmeLines && !contentRows) add('C1', 'error', `${README_REL} に「## 中身」の表が見つかりません。`);
  const extraRows = trackedExtraRows(listed);
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

  // C4: 「Codex ラッパー一覧」表が、入口の単位（名前）で codex-skills/<名前>/ と一致するか（ファイルの単位の照合は C1 が行う）
  const wrapperRows = readmeLines && tableFirstColumn(readmeLines, /^##\s+Codex\s+ラッパー一覧\s*$/);
  if (readmeLines && !wrapperRows) add('C4', 'error', `${README_REL} に「## Codex ラッパー一覧」の表が見つかりません。`);
  if (wrapperRows) {
    const expected = managedSkillNames().sort();
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

  // C15: コマンド名の形（docs/command-design.md「6. コマンドの名前」）。
  // 配置の対象（PREFIX で始まるもの）だけを見ると、`UT-x.md` のような名前は対象から外れて黙って配置されなくなる。
  // そのため、大文字小文字を問わず ut- で始まる .md を数える（capture のときは取り込む側の実行場所も見る）
  const nameDirs = [TARGETS.claude.repoDir, ...(captureTarget === 'claude' ? [TARGETS.claude.liveDir] : [])];
  for (const name of new Set(nameDirs.flatMap((d) => listTopLevelFiles(d)))) {
    if (!/^ut-/i.test(name) || !/\.md$/i.test(name)) continue;
    if (!COMMAND_NAME_RE.test(name)) add('C15', 'error', `commands/${name} の名前が規則（英小文字・数字、語の区切りはハイフン）に合わない（${DESIGN_DOC}「6. コマンドの名前」）`);
  }

  // C16: やめた名前を、使い直しの理由を書かずに使っていないか
  checkRetiredNames(tree, add);

  // C17: ディスク系の入口と出口の説明（方針 §2.1・§2.4）
  checkDiskEntry(tree, add);

  // C19: /ut-handoff と /ut-takeover の「セッションの示し方」
  checkSessionLabel(tree, add);

  // C20: Claude Code にしか無い機能と「前提と、無いときの動作」表（警告。方針 §2.3）
  checkClaudeOnlyFeatures(tree, add);

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

  // C18: commands/templates/ に .md を置かない。Claude Code は ~/.claude/commands/ の下の .md を、サブフォルダの中も含めて
  // コマンドとして読み込む（templates:<名前> として一覧に出て、frontmatter が無ければモデルが自分で呼ぶこともできる）。
  // 実行時に読む手引きなどは .md 以外の拡張子にする
  for (const name of new Set([...listTopLevelFiles(path.join(REPO_ROOT, 'commands', 'templates')), ...CLAUDE_TEMPLATE_FILES.map((n) => path.basename(n))])) {
    if (/\.md$/i.test(name)) add('C18', 'error', `commands/templates/${name} は .md のため、配備すると Claude Code がコマンド（templates:${name.replace(/\.md$/i, '')}）として読み込む。.md 以外の拡張子にする`);
  }
  if (targetName === 'claude') {
    for (const name of nestedMarkdownFiles(path.join(LIVE_CMD_DIR, 'templates')).filter((n) => n.includes('/'))) {
      add('C18', 'error', `${toPosix(path.join(LIVE_CMD_DIR, 'templates', name))} は配備対象外の入れ子の .md。Claude Code にコマンドまたは skill として読まれるため、commands の外の作業ディレクトリへ移す`);
    }
  }

  // C10: 機微値の混入（--no-check でも必ず実行する。runRequiredChecks と同じ関数）
  checkSecretsAll(tree, add, listed);

  // C9: 他ブランチのパス参照が相手側の移行で陳腐化していないか
  checkExternalRefs(tree, add);
  checkClassification(tree, add);

  // C13: skills の自動の呼び出しを止めているか（C10 と同じく --no-check でも必ず実行する）
  checkSkills(tree, add, listed);

  return { findings, tree };
}

// ---- C13: skills の自動の呼び出しの停止 -----------------------------------
// ut-* は「人が明示したときだけ動く」。Codex の skills は既定で、内容から判断して自動で呼ばれる
// （実機で確認: 何もしないと内容に合う依頼で 3/3 回起動した）。skill のフォルダの agents/openai.yaml で
// policy.allow_implicit_invocation を false にすると止まる（同 0/3 回）。止め忘れを人の注意に任せない
// codex-skills/ の下にある「管理すべきファイル」の一覧。git の追跡・未追跡（.gitignore の対象を除く）で数える（runChecks で取った一覧から作る）。
// 退避（*.bak-*）・書きかけ（*.tmp）・OS が作るファイルで検査が止まらないようにするため（--capture の退避で実際に止まった）。
// git の一覧があるときの除外は、リポジトリの .gitignore（*.bak-*・*.tmp・Thumbs.db など）に任せる（.gitignore から消すと、退避で C14 が止まる。
// 消した退避は push されうるので、C14 で止まるほうが正しい）
// 戻り値は codex-skills/ からの相対・/ 区切り
function skillRepoFiles(listed) {
  if (listed) return listed.filter((f) => f.startsWith('codex-skills/')).map((f) => f.slice('codex-skills/'.length));
  // git が使えない写し（試験など）では、フォルダをたどり、退避・書きかけ・OS のファイルを除く（C10 の代わりの走査と共用）
  return walkRepoFiles('codex-skills');
}
// ---- frontmatter の読み取り（C11・C12・C13・C17 で共用） ----------------------
// 行の解釈（キーの形・コロンの後ろ・重複・字下げ・値の続きの行）と、値の形（引用符・引用の無い「:」）をここ1か所に置く。
// 検査ごとに別の判定を持つと、片方だけ直して答えが割れる（description:"…" を C11/C12 だけがキーとして通していた。
// C17 だけが重複したキーの最初の値を使っていた。引用の無い「: 」と字下げした続きの行を C13 だけが止めていた）。
// 検査が値を読むときは、どれも frontmatterScalar を通す（1 行の文字列として読めるか・引用符の中身）
// 上の階層のキーの行の形。YAML ではコロンの後ろに空白か行末が無いとキーにならない
const FM_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
// 戻り値: frontmatter が無ければ null。あれば { entries: [{ key, raw（値の前後の空白を除いたもの）, children（字下げした続きの行） }] }。
// 壊れた書き方があれば error も付ける（entries はそこまで読んだもの）。どの検査も、error があれば frontmatter のどこが壊れていても
// 値を信用しない（読み込む側が frontmatter 全体を読めないと、description も disable-model-invocation も効かない）
function readFrontmatter(text) {
  const lines = normLF(text).split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return readMappingLines(lines.slice(1, end), 0, 'frontmatter ');
}
// 同じ字下げ（indent 個の空白）の行を「キー: 値」として読み、それより深く字下げした行は直前のキーの children に入れる。
// 上の階層（indent 0）と metadata: の下（最初の子の行の字下げ）で同じものを使う。where はエラーの文の頭（「frontmatter 」など）。
// 字下げの深さを見ずに子の行を読むと、metadata: の下の owner: のさらに下の scope: を metadata.scope と取り違える
function readMappingLines(lines, indent, where) {
  const entries = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const lead = ln.match(/^\s*/)[0];
    // YAML の字下げは半角の空白だけ（タブや全角の空白で字下げすると壊れる）
    if (/[^ ]/.test(lead)) return { error: `${where}の字下げに半角の空白以外（タブなど）がある（YAML として壊れる）: ${ln.trim().slice(0, 40)}`, entries };
    // 独立したコメントは YAML の構造に影響しない。字下げの検査は先に行い、タブで字下げしたコメントまで黙って通さない。
    if (ln.slice(lead.length).startsWith('#')) continue;
    if (lead.length > indent && entries.length) { entries[entries.length - 1].children.push(ln); continue; }
    // YAML は、値の無いキーの block sequence だけは親キーと同じ字下げでも書ける（indentless sequence）。
    if (lead.length === indent && /^-\s+/.test(ln.slice(indent)) && entries.length && !entries[entries.length - 1].raw) { entries[entries.length - 1].children.push(ln); continue; }
    if (lead.length !== indent) return { error: `${where}の字下げがそろっていない（YAML として壊れるか、別の階層になる）: ${ln.trim().slice(0, 40)}`, entries };
    const m = ln.slice(indent).match(FM_KEY_RE);
    if (!m) return { error: `${where}に解釈できない行がある（キーの「:」の後ろに空白か行末が無い、など）: ${ln.slice(0, 40)}`, entries };
    if (entries.some((e) => e.key === m[1])) return { error: `${where}のキーが重複している: ${m[1]}`, entries };
    entries.push({ key: m[1], raw: (m[2] || '').trim(), children: [] });
  }
  for (const e of entries) {
    // 値のある行の後ろの字下げした行は、YAML では値の続き（折りたたんで1つの値になる）か、壊れた書き方になる。
    // 1行目だけを照合すると、照合した値と実際に効く値が食い違う（description の次の行に「ただし削除もする」、
    // disable-model-invocation: true の次の行に字下げした行を足すと文字列「true …」になる）。入れ子は値の無いキー（metadata: など）だけに許す
    if (e.raw && e.children.length) return { error: `${where}の ${e.key} の値に字下げした続きの行がある（YAML では値に連結されるか壊れる。1 行に書く）: ${e.children[0].trim().slice(0, 40)}`, entries };
    const shape = valueShapeError(e.raw);
    if (shape) return { error: `${where}の ${e.key} の値の${shape}`, entries };
    if (!e.raw && e.children.length) {
      const nested = e.children.filter((ln) => ln.trim() && !ln.trimStart().startsWith('#'));
      if (!nested.length) continue;
      const childIndent = nested[0].match(/^ */)[0].length;
      if (/^-\s+/.test(nested[0].slice(childIndent))) {
        for (const ln of nested) {
          const lead = ln.match(/^\s*/)[0];
          if (/[^ ]/.test(lead) || lead.length !== childIndent || !/^-\s+/.test(ln.slice(childIndent))) return { error: `${where}の ${e.key} の列の字下げ・項目の形がそろっていない: ${ln.trim().slice(0, 40)}`, entries };
          const item = ln.slice(childIndent).replace(/^-\s+/, '').trim();
          const itemShape = valueShapeError(item);
          if (itemShape) return { error: `${where}の ${e.key} の列の値の${itemShape}`, entries };
        }
      } else {
        const sub = readMappingLines(e.children, childIndent, `${where}の ${e.key} の下`);
        if (sub.error) return { error: sub.error, entries };
      }
    }
  }
  return { entries };
}
// 検査が値を読むときの入口（C11 の scope・C13 の全キー・C17 の description と argument-hint）。1 行の文字列として読めなければ { error }。
// 値の無いキーの下に字下げした行（description: の次の行に値を書くなど）は、入れ子か複数行の値で、1 行の文字列としては読めない
function frontmatterScalar(e) {
  if (e.children.length) return { error: `次の行からの字下げした行（入れ子か複数行の値）は 1 行の文字列として読めない（キーと同じ行に書く）: ${e.children[0].trim().slice(0, 40)}` };
  return unquoteFrontmatterValue(e.raw);
}
// SKILL.md の frontmatter を読む。壊れていると Codex がその skill を読み込まないか、別の名前で登録しうる
function parseSkillFrontmatter(text) {
  const fm = readFrontmatter(text);
  if (!fm) return { error: 'frontmatter が無い' };
  if (fm.error) return { error: fm.error };
  const keys = {};
  for (const e of fm.entries) {
    // SKILL.md は1階層だけ。字下げした続きの行（値の続きや入れ子）は読まないので、壊れた書き方と区別せずに止める（frontmatterScalar）
    const v = frontmatterScalar(e);
    if (v.error) return { error: `frontmatter の ${e.key} の値の${v.error}` };
    keys[e.key] = v.value;
  }
  return { keys };
}
// frontmatter の1行の値（前後の空白は除いたもの）から、引用符の中身を取り出す。C11・C13・C17 で共用する（frontmatterScalar から呼ぶ）。
// 先に readFrontmatter と同じ valueShapeError（引用符の閉じ・引用の無い「:」）を当て、YAML として壊れた値を通さない。
// 引用符ごと比べると、name: "ut" を「フォルダ名と違う」と誤って止め、閉じていない description: "… を値ありとして通す。
// 先頭が " か ' なら、対応する閉じ引用符（" は \ で逃がしたものを除く、' は '' を除く最初のもの）が値の末尾でなければエラー。
// 閉じ引用符の後ろのコメント（"ut" # …）も YAML としては正しいが、ここでは受け付けない（壊れた書き方と区別しないため、厳しい側に倒す）。
// 引用符の無い値も、YAML が文字列として読まないもの（コメント・null・配列や対応表のフロー記法・真偽値・数値・日時・
// 先頭が特別な意味を持つ文字のもの）はエラーにする。
// 空でない文字列として通すと、「値が無い」を見る検査（C13 の description、C17 の argument-hint）や「文字列である」前提をすり抜ける
// （description: true は YAML では真偽値、description: 123 は数値、description: 2026-10-17 は日付になる）
// 二重引用符の中で YAML が許すエスケープ（\\ \" \n \t \xHH \uHHHH \UHHHHHHHH など）。それ以外（C:\Users の \U など）は YAML として壊れる
const YAML_DQ_ESCAPE_RE = /^\\(?:[0abtnvfre "/\\N_LP\t]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/;
// 真偽値（YAML 1.1 の yes/no/on/off も含める。読む側の版で答えが変わるため、厳しい側に倒す）
const YAML_BOOL_RE = /^(?:true|false|yes|no|on|off)$/i;
// 数値（10 進・指数・16 進・8 進・2 進・桁区切りの _・無限大・非数）
const YAML_NUMBER_RE = /^(?:[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
// 日時（YAML 1.1 の timestamp。読む側によっては日付の型になり、文字列向けの処理を通らない）
const YAML_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:$|[Tt\s])/;
// YAML の二重引用符の中のエスケープが表す文字（\xHH・\uHHHH・\UHHHHHHHH は 16 進から作る）
const YAML_DQ_ESCAPE_CHARS = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
// 引用符で囲んだ値の中身。受け付けるエスケープ（YAML_DQ_ESCAPE_RE）は、すべて YAML が読むのと同じ文字に戻す。
// 受け付けたのに戻さないと、YAML としては同じ値（「。」を \u3002 と書いたもの）を、照合で別の値として止める
function unquoteQuoted(v) {
  const q = v[0];
  let close = -1;
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === '\\') {
      if (!YAML_DQ_ESCAPE_RE.test(v.slice(i))) return { error: `二重引用符の中に YAML で使えないエスケープ（${v.slice(i, i + 2)}）がある（YAML として壊れる。\\ を書くなら \\\\ にするか一重引用符で囲む）` };
      if (v[i + 1] === 'U' && parseInt(v.slice(i + 2, i + 10), 16) > 0x10ffff) return { error: `二重引用符の中のエスケープ（${v.slice(i, i + 10)}）が文字の範囲を超えている（YAML として壊れる）` };
      i++;
      continue;
    }
    if (v[i] !== q) continue;
    if (q === "'" && v[i + 1] === "'") { i++; continue; }
    close = i;
    break;
  }
  if (close < 0) return { error: '引用符が閉じていない（YAML として壊れる）' };
  if (close !== v.length - 1) return { error: '閉じ引用符の後ろに文字がある（YAML として壊れるか、意図しない値になる）' };
  const inner = v.slice(1, -1);
  if (q === "'") return { value: inner.replace(/''/g, "'") };
  return { value: inner.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[^xuU])/g, (_, s) => (s.length > 1 ? String.fromCodePoint(parseInt(s.slice(1), 16)) : YAML_DQ_ESCAPE_CHARS[s])) };
}
// 値が YAML として壊れているか（読み込む側が frontmatter 全体を読めなくなるか）。壊れていれば理由、壊れていなければ null。
// readFrontmatter がすべてのキーに当てる（検査が値を読まないキーでも、壊れていれば description や disable-model-invocation が効かない）。
// 型（真偽値・数値など）は見ない。argument-hint: [引数] のようなフロー記法や disable-model-invocation: true は YAML として正しい
function valueShapeError(v) {
  if (v[0] === '"' || v[0] === "'") return unquoteQuoted(v).error || null;
  // フロー記法（[…]・{…}）の中の「: 」は対応表の区切りとして正しい。中身の形はここでは見ない（値を読む検査は unquoteFrontmatterValue が止める）
  if (/^[[{]/.test(v)) return null;
  // 引用の無い値の中の「:」は、後ろが空白（タブを含む）か値の末尾なら、YAML では対応表の区切りになり壊れる（mapping values are not allowed）
  if (/:(?:\s|$)/.test(v)) return '中の引用の無い「:」（後ろが空白か値の末尾のもの）が YAML では対応表の区切りになる（YAML として壊れる。「:」を含めるなら引用符で囲む）';
  return null;
}
function unquoteFrontmatterValue(v) {
  const shape = valueShapeError(v);
  if (shape) return { error: shape };
  const q = v[0];
  if (q !== '"' && q !== "'") {
    if (/^#|\s#/.test(v)) return { error: '中の「#」が YAML ではコメントになる（値が無いか、後ろが消える。「#」を含めるなら引用符で囲む）' };
    if (/^(~|null)$/i.test(v)) return { error: `${v} が YAML では null になる（値が無い）` };
    if (/^[[{]/.test(v)) return { error: '先頭の「[」「{」が YAML ではフロー記法（配列・対応表）になる（文字列として読めないか、閉じていなければ壊れる。文字列なら引用符で囲む）' };
    if (YAML_BOOL_RE.test(v)) return { error: `${v} が YAML では真偽値になる（文字列として読めない。文字列なら引用符で囲む）` };
    if (YAML_NUMBER_RE.test(v)) return { error: `${v} が YAML では数値になる（文字列として読めない。文字列なら引用符で囲む）` };
    if (YAML_DATE_RE.test(v)) return { error: '日付の形の値が YAML では日時になりうる（文字列として読めない。文字列なら引用符で囲む）' };
    if (/^[*&!|>%@`]|^[-?:](?:\s|$)/.test(v)) return { error: `先頭の「${v[0]}」が YAML では特別な意味（別名・アンカー・タグ・ブロック記法・予約文字など）を持つ（文字列として読めない。文字列なら引用符で囲む）` };
    return { value: v };
  }
  return unquoteQuoted(v);
}
function checkSkills(tree, add, listed) {
  const dir = path.join(REPO_ROOT, 'codex-skills');
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKILL_NAME_RE.test(e.name)) add('C13', 'error', `skill の名前が規則（英小文字・数字・-）に合わない: ${e.name}`);
  }
  // C14（通常の検査）: 決まったファイル以外があれば、配置されないまま残る（SKILL.md が参照していても届かない）
  // リンク（シンボリックリンク・ジャンクション）は「余分なファイル」ではなく、リンクとして示す（git の一覧にもリンクそのものが載りうる）。
  // 理由を取り違えると、利用者はリンクではなく余分なファイルを探して直そうとする
  const files = skillRepoFiles(listed);
  // f の途中（f 自身を含む）にあるリンクの相対パス。無ければ null
  const linkOf = (f) => {
    const seg = f.split('/');
    for (let i = 1; i <= seg.length; i++) {
      try { if (fs.lstatSync(path.join(dir, ...seg.slice(0, i))).isSymbolicLink()) return seg.slice(0, i).join('/'); } catch { return null; }
    }
    return null;
  };
  for (const l of new Set(files.map(linkOf).filter(Boolean))) {
    add('C14', 'error', `codex-skills/${l} はリンク（シンボリックリンク・ジャンクション）。正本の skill はリンクにしない（配置と取り込みは、リンクの確認が書き込みの前に止める）`);
  }
  for (const f of files.filter((x) => !linkOf(x))) {
    const [name, ...rest] = f.split('/');
    if (!rest.length) { add('C14', 'error', `codex-skills/ 直下に skill 以外のファイルがある: ${f}`); continue; }
    if (!SKILL_FILES.includes(rest.join('/'))) add('C14', 'error', `codex-skills/${f} は配置の対象外（SKILL.md と agents/openai.yaml だけにする）`);
  }
  for (const name of managedSkillNames()) {
    const base = `codex-skills/${name}`;
    const yaml = tree.read(`${base}/agents/openai.yaml`);
    if (!yaml) add('C13', 'error', `${base}/agents/openai.yaml が無い（自動の呼び出しが止まらない）`);
    else if (normLF(yaml.toString('utf8')) !== SKILL_POLICY) {
      add('C13', 'error', `${base}/agents/openai.yaml が正規の形と違う（期待: policy: の下に allow_implicit_invocation: false だけ）`);
    }
    const skill = tree.read(`${base}/SKILL.md`);
    if (!skill) { add('C13', 'error', `${base}/SKILL.md が無い`); continue; }
    const fm = parseSkillFrontmatter(skill.toString('utf8'));
    if (fm.error) { add('C13', 'error', `${base}/SKILL.md の ${fm.error}`); continue; }
    if (fm.keys.name !== name) add('C13', 'error', `${base}/SKILL.md の name がフォルダ名（${name}）と一致しない`);
    if (!fm.keys.description) add('C13', 'error', `${base}/SKILL.md に description が無い`);
  }
}

// ---- C11/C12: 分類ラベルと設計方針の整合 --------------------------------
// C1-C9 は「ファイルが在るか」「構成が揃っているか」までしか見ない。
// 「このコマンドが社内固有に依存するか」は人が決めるものなので、決めた結果が
// 3箇所(frontmatter / README の分類表 / publish.allowlist)で食い違っていないことを
// （publish-ref-ok: publish.allowlist 公開用の許可リストは上流の作業リポジトリにだけある。公開物では無いため、照合を省いて警告にする）
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

// 行の解釈は C13・C17 と同じ readFrontmatter で行う（キーの形・コロンの後ろに空白か行末・重複したキー・字下げ・値の形）。
// 壊れていれば { error } を返す（解釈できない行を読み飛ばして、残りのキーだけで C11・C12 を通さない）。
// 値を読まないキー（ディスク系でないコマンドの description など）も、YAML として壊れていれば止める（読み込む側が frontmatter 全体を読めないと、
// disable-model-invocation も効かない）
function parseFrontmatter(text) {
  const fm = readFrontmatter(text);
  if (!fm) return null;
  if (fm.error) return { error: fm.error };
  let scope = null;
  let scopeError = null;
  const meta = fm.entries.find((e) => e.key === 'metadata');
  if (meta && meta.children.length) {
    // metadata: の下も同じ readMappingLines で、最初の子の行の字下げにそろった行だけを直下のキーとして読む
    // （それより深い行は、直前のキーの入れ子か値の続き。owner: の下の scope: を metadata.scope と取り違えない）
    const first = meta.children.find((l) => l.trim());
    const sub = readMappingLines(meta.children, first.match(/^ */)[0].length, 'frontmatter の metadata の下');
    if (sub.error) return { error: sub.error };
    const e = sub.entries.find((x) => x.key === 'scope');
    // 引用符の扱いは C13・C17 と同じ関数で行う。scope: "generic" を引用符ごと比べて止めず、
    // 閉じていない引用符・null・コメント・入れ子は値として通さない
    if (e) { const v = frontmatterScalar(e); if (v.error) scopeError = v.error; else scope = v.value; }
  }
  return { topKeys: fm.entries.map((e) => e.key), scope, scopeError };
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

// ---- C15/C16: コマンドの名前 -------------------------------------------------
// 形（C15）: ut- ＋ 英小文字・数字の語、語の区切りはハイフン（ut-vscode-debug も通る）
const COMMAND_NAME_RE = /^ut-[a-z0-9]+(-[a-z0-9]+)*\.md$/;

// docs/command-design.md の「### 6.1 やめた名前」の表を読む。
// 戻り値: { names: Map<名前, 使い直しの理由>, problems: [表の形の問題] }。節が無ければ null。
// 見出しだけ残って表が消えた状態を「空の表」として通さないため、ヘッダ行・区切り行・データ行（または「（なし）」の行）を必須にする
const RETIRED_HEADER_RE = /^\|\s*名前\s*\|\s*やめた日\s*\|\s*やめた理由\s*\|\s*使い直しの理由\s*\|\s*$/;
function readRetiredNames(text) {
  let seen = false;
  let inSection = false;
  let header = false;
  let separator = false;
  let none = false;
  const names = new Map();
  const problems = [];
  for (const ln of normLF(text).split('\n')) {
    if (/^#{1,6}\s/.test(ln)) {
      inSection = /^###\s+6\.1\s+やめた名前\s*$/.test(ln);
      if (inSection) seen = true;
      continue;
    }
    if (!inSection || !ln.startsWith('|')) continue;
    if (RETIRED_HEADER_RE.test(ln)) { header = true; continue; }
    if (/^\|[\s|:-]+\|\s*$/.test(ln)) { separator = true; continue; }
    if (/^\|\s*（なし）\s*\|/.test(ln)) { none = true; continue; }
    const m = ln.match(/^\|\s*`(ut-[^`]+)`\s*\|[^|]*\|[^|]*\|([^|]*)\|\s*$/);
    if (!m) { problems.push(`読めない行がある: ${ln}`); continue; }
    if (names.has(m[1])) { problems.push(`同じ名前の行が重複している: ${m[1]}`); continue; }
    names.set(m[1], m[2].trim());
  }
  if (!seen) return null;
  if (!header || !separator) problems.push('表のヘッダ行（| 名前 | やめた日 | やめた理由 | 使い直しの理由 |）と区切り行が無い');
  else if (!names.size && !none) problems.push('表にデータ行が無い（やめた名前が無いなら「| （なし） | | | |」の行を置く）');
  return { names, problems };
}

function checkRetiredNames(tree, add) {
  const buf = tree.read(DESIGN_DOC);
  if (!buf) return; // 本書が無いことは C12 がエラーにする
  const retired = readRetiredNames(buf.toString('utf8'));
  if (!retired) {
    add('C16', 'error', `${DESIGN_DOC} に「### 6.1 やめた名前」の表が見つからない（やめた名前の使い直しを検査できない）`);
    return;
  }
  // 読めない行・表の欠落を黙って飛ばすと、その名前は検査から漏れる
  for (const p of retired.problems) add('C16', 'error', `${DESIGN_DOC} の「やめた名前」の表: ${p}`);
  for (const name of tree.listFiles('claude')) {
    if (name.includes('/') || !name.endsWith(SUFFIX)) continue;
    const base = name.slice(0, -SUFFIX.length);
    if (!retired.names.has(base)) continue;
    const why = retired.names.get(base);
    if (!why || /^[-—–ー\s]+$/.test(why)) {
      add('C16', 'error', `commands/${name} は「やめた名前」の表にある名前。使い直すなら ${DESIGN_DOC}「6.1 やめた名前」の「使い直しの理由」を書く`);
    }
  }
}

// ---- C17: ディスク系の入口と出口 ---------------------------------------------
// 入口 ut-diskreport は「対象データは変更しない」契約を、description の先頭と argument-hint（--apply を出さない）で示す。
// モデルが description を読んで呼ぶ型の入口なので、文言が崩れると削除の入口に見えてしまう。出口（ut-diskclean・ut-diskarchive）は
// 「先に /ut-diskreport」を案内する。ファイルが無いときは検査しない（名前を変えたときは C15・C16 と README の表が見る）
// 行の解釈（キーの形・コロンの後ろ・重複したキー・字下げした行・値の形）は C13 と同じ readFrontmatter で、値は frontmatterScalar で読む。
// 戻り値: キーが無ければ null、frontmatter が壊れていれば { error, line: true }、あれば frontmatterScalar の結果
// （値の続きの行・入れ子は 1 行の文字列として読めないのでエラー。1 行目だけを照合すると、照合した値と実際に効く値が食い違う）
function frontmatterValue(text, key) {
  const fm = readFrontmatter(text);
  if (!fm) return null;
  // 対象のキーより後ろの行の壊れ・重複でも止める（C13 と同じく、frontmatter のどこかが壊れていれば値を信用しない。
  // 重複したキーの最初の値だけを照合すると、読み込む側が後の値を使ったときに、照合した説明と実際に効く説明が食い違う）
  if (fm.error) return { error: fm.error, line: true };
  const e = fm.entries.find((x) => x.key === key);
  // 引用符の扱いは C13 と同じ関数で行う（' の値を引用符ごと比べたり、閉じていない " を値として通したりしない）
  return e ? frontmatterScalar(e) : null;
}
// 説明文は方針 §2.1 の文言と全文で照合する（先頭や部分一致では「対象データは変更しないが削除する」「先に /ut-diskreport は使わない」も通る）。
// 文言を変えるときは、方針と本表を同時に変える
const DISK_DESCRIPTIONS = {
  'ut-diskreport.md': '対象データは変更しない（目安のレポートだけ保存）。容量の内訳と、削除（/ut-diskclean）・圧縮（/ut-diskarchive）・OneDrive の解放のどれが効くかを、次に打つコマンドつきで示す',
  'ut-diskclean.md': '再生成できるものだけを、承認記録に載せたうえで削除する。--apply・確認への応答・承認記録の保存の3条件が欠けたら何も削除しない。先に /ut-diskreport',
  'ut-diskarchive.md': '元を残したまま 1 ファイルずつ 7z を作る。元は移動・削除しない。この時点ではクラウドの容量は減らない（元を消すのは利用者）。この PC の空きは --release-local を明示したときだけ増える。先に /ut-diskreport',
};
const DISK_ENTRY = 'ut-diskreport.md';
function checkDiskEntry(tree, add) {
  const read = (name) => { const b = tree.read(`commands/${name}`); return b ? b.toString('utf8') : null; };
  // 戻り値: 値（文字列）、キーが無ければ null、引用符が壊れていれば undefined（エラーは出し済み。続けて比べない）
  // 解釈できない行は、キーごとに同じ行を何度も出さないよう1回だけ出す
  const reported = new Set();
  const valueOf = (name, text, key) => {
    const r = frontmatterValue(text, key);
    if (r && r.error) {
      const msg = r.line ? `commands/${name} の ${r.error}` : `commands/${name} の ${key} の値の${r.error}`;
      if (!reported.has(msg)) { reported.add(msg); add('C17', 'error', msg); }
      return undefined;
    }
    return r ? r.value : null;
  };
  for (const [name, want] of Object.entries(DISK_DESCRIPTIONS)) {
    const text = read(name);
    if (text === null) continue;
    const desc = valueOf(name, text, 'description');
    if (desc === undefined) continue;
    if (desc !== want) add('C17', 'error', `commands/${name} の description が方針 §2.1 の文言と一致しない（期待: ${want}）`);
  }
  // 入口の argument-hint: 空でなく、--apply を出さない（削除は /ut-diskclean に移った）
  const entry = read(DISK_ENTRY);
  if (entry !== null) {
    const hint = valueOf(DISK_ENTRY, entry, 'argument-hint');
    if (hint === undefined) { /* 引用符が壊れている（エラーは出し済み） */ }
    else if (!hint) add('C17', 'error', `commands/${DISK_ENTRY} に argument-hint が無い・空（--apply を出さないことを確かめられない）`);
    else if (/--apply\b/.test(hint)) add('C17', 'error', `commands/${DISK_ENTRY} の argument-hint に --apply がある（削除は /ut-diskclean に移った。入口に出さない）`);
  }
}

// ---- C19: /ut-handoff と /ut-takeover の「セッションの示し方」 -----------------
// ListAgents の名前（自動で付く <フォルダ名>-NN など）はタブにも会話の記録にも出ず、利用者がタブと結び付けられない。
// 両コマンドの §4 に同じ決まり、§5 に同じ禁止を置き、全文で照合する（片方だけ書き換えると食い違うため）。
// 見るのは「本文に決まりがあること」まで。書き手が守るかは実機の試験で見る（docs/ut-handoff.md「限界」）。
// 文言を変えるときは、両コマンドと本表を同時に変える。ファイルが無いときは検査しない（名前を変えたときは C15・C16 と README の表が見る）
const SESSION_LABEL_FILES = ['ut-handoff.md', 'ut-takeover.md'];
const SESSION_LABEL_RULE = '- **セッションの示し方（/ut-handoff と /ut-takeover で共通）。** 利用者向けにセッションを示すときは、連絡用の名前・ref（ListAgents の `<名前> [<ref>]`）だけを手がかりにしない（自動で付く名前はタブにも会話の記録にも出ず、利用者がタブと結び付けられない）。引き継ぎ ID と役割を先に示す（例:「`<ID>` を作った `/ut-handoff` のセッション（作成元）」「`/ut-takeover <ID>` を打ったセッション（引き継ぎ先）」）。打った 1 行として引くのは `/ut-takeover <ID>` だけにし、`/ut-handoff` の引数など利用者が自由に書いた行は引かない。連絡用の名前は、マスキング基準を通り識別の助けになるときだけ「（連絡用の名前: <名前>）」と括弧で補ってよい。ref は利用者向けには示さない。照合と宛先に名前・ref を使うこと（内部の利用）はこの制限の対象外。';
const SESSION_LABEL_BAN = '- 利用者向けに、連絡用の名前・ref だけでセッションを指さない（§4「セッションの示し方」）。';
// `## <番号>. <名前>` の節の行（次の `## ` まで）。無ければ null
function sectionLines(text, title) {
  const lines = normLF(text).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\d+\\.\\s*${title}\\s*$`).test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}
function checkSessionLabel(tree, add) {
  for (const name of SESSION_LABEL_FILES) {
    const b = tree.read(`commands/${name}`);
    if (!b) continue;
    const text = b.toString('utf8');
    for (const [title, want, what, konst] of [['出力契約', SESSION_LABEL_RULE, '決まり', 'SESSION_LABEL_RULE'], ['禁止事項', SESSION_LABEL_BAN, '禁止', 'SESSION_LABEL_BAN']]) {
      const sec = sectionLines(text, title);
      if (!sec || !sec.includes(want)) add('C19', 'error', `commands/${name} の「${title}」に「セッションの示し方」の${what}が無い・文言が違う（全文は tools/deploy.mjs の ${konst}）`);
    }
  }
}

// ---- C20: Claude Code にしか無い機能と「前提と、無いときの動作」表（警告） ----------------
// Codex では $ut（codex-skills/ut/SKILL.md）が本文をその場で読み替える。本文に無い環境での動作が書いていないと、
// 読み替えは実行するモデル任せになり、手順が抜けても気付けない（docs/command-design.md §2.3）。
// 見るのは 2 つだけ: 本文（frontmatter を除く。コードブロックは除かない）に群の語があるのに、§2「入力」の表にその群の語を含む行が無いこと。
// frontmatter に disallowed-tools があるのに、表に Codex を含む行が無いこと（Codex ではこの制限が仕組みで効かない）。
// 語の有無しか見られず、否定・比較・説明の文にも当たるので警告にとどめ、配備は止めない。書いた代わりの手順が妥当かは人が見る。
// 説明・比較だけの記述は、本文の <!-- c20-ignore: <群の名前> <理由> --> で外す（理由が空なら外さずに警告する）。
// 注記が外すのは、注記を書いた行と、その直前・直後の行（C20_IGNORE_REACH 行）の、その群の語だけ。ファイル全体からは外さない
// （以前はファイル全体から群を外していたので、後から本当に頼る手順を足しても黙って通った）。範囲の中にその群の語が無い注記は警告する。
// 群を足す・名前を変えるときは、方針 §2.3 の表も同時に直す。群の名前は、その群の正規表現に当たる書き方にする（表の行に群の名前を書けば通る）。
// 方針 §2.3 の表の「編集の禁止」はここの群ではない（disallowed-tools を持つかを frontmatter で見て、表に Codex を含む行があるかで判定する。c20-ignore の対象外）
const C20_GROUPS = [
  { name: 'サブエージェント', re: /サブ・?エージェント|sub[- ]?agents?\b|claude-code-guide|組み込みのエージェント/i },
  { name: 'セッション間の連絡', re: /ListAgents|SendMessage|セッション間の連絡/i },
  { name: '遅延読み込みのツール', re: /ToolSearch|遅延読み込み/i },
  { name: 'Web の取得・検索', re: /Web ?Fetch|Web ?Search|Web ?の(?:取得|検索)|Web ?検索/i },
  { name: '確認の画面', re: /AskUserQuestion|確認の画面/i },
  // /model などは、パスや URL の途中（docs/model・/ut-plan・<ROOT>/plan・%USERPROFILE%/model・~/fast・${HOME}/effort）に当てないよう、
  // 直前が語の文字・/・.・-・プレースホルダーの閉じ（> % } ~）でなく、直後が / でない（/plan/notes.md のようなパスの区切りでない）ものだけを数える
  { name: 'セッションの切り替え', re: /plan ?モード|plan mode|(?<![\w/.<>~}%-])\/(?:model|effort|fast|plan)\b(?!\/)|セッションの切り替え/i },
];
const C20_TABLE_TITLE = '前提と、無いときの動作';
// 1 行で書く（行ごとに語を数えるときに、注記の中の語を同じ範囲で外すため）
const C20_IGNORE_RE = /<!--\s*c20-ignore:(.*?)-->/g;
// 注記が効く範囲（注記の行から前後に何行か）。方針 §2.3 に同じ値を書いている
const C20_IGNORE_REACH = 1;
const c20Within = (a, b) => Math.abs(a - b) <= C20_IGNORE_REACH;
// commands/ の直下の ut-*.md（C11・C12・C20 が見る対象）。listCommands は templates/ 配下も返すので、直下の ut-*.md だけに絞る。
// 1 か所に置く（別々に書くと、条件を片方だけ変えたときに C11・C12 と C20 で見る対象がずれる）
function commandFileNames(tree) {
  return tree.listFiles('claude').filter((n) => !n.includes('/') && !n.includes(String.fromCharCode(92)) && /^ut-[A-Za-z0-9-]+[.]md$/.test(n));
}
// §2「入力」の中の「### 前提と、無いときの動作」の表のデータ行（見出し行・区切り行を除く）。節・見出し・表が無ければ null
function c20TableRows(text) {
  const sec = sectionLines(text, '入力');
  if (!sec) return null;
  const at = sec.findIndex((l) => new RegExp(`^#{3,4}\\s+${C20_TABLE_TITLE}\\s*$`).test(l));
  if (at < 0) return null;
  const rows = [];
  for (const l of sec.slice(at + 1)) {
    if (/^\s*\|/.test(l)) { rows.push(l); continue; }
    if (!rows.length && !/^#{1,6}\s+/.test(l)) continue;
    break;
  }
  if (!rows.length) return null;
  return rows.slice(1).filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l));
}
function checkClaudeOnlyFeatures(tree, add) {
  const names = commandFileNames(tree);
  for (const name of names) {
    const b = tree.read(`commands/${name}`);
    if (!b) continue;
    const text = normLF(b.toString('utf8'));
    const lines = text.split('\n');
    // 抑止の注記の中の語は数えない（理由の文に別の群の語が出ても、その群に頼っていることにはならない）
    const bodyLines = lines.map((l) => l.replace(C20_IGNORE_RE, ''));
    let start = 0;
    if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) start = end + 1; }
    const where = `commands/${name}`;
    // 抑止の注記を読む。群の名前で始まり、その後ろに理由があるものだけを、注記の行の前後 C20_IGNORE_REACH 行に効かせる
    const ignores = [];
    for (let i = start; i < lines.length; i++) {
      for (const m of lines[i].matchAll(C20_IGNORE_RE)) {
        const body = m[1].trim();
        const g = C20_GROUPS.filter((x) => body.startsWith(x.name)).sort((a, c) => c.name.length - a.name.length)[0];
        if (!g) { add('C20', 'warning', `${where} の c20-ignore の群が分からない（群の名前で始める: ${C20_GROUPS.map((x) => x.name).join('／')}）: ${body.slice(0, 40)}`); continue; }
        if (!body.slice(g.name.length).trim()) { add('C20', 'warning', `${where} の c20-ignore（${g.name}）に理由が無い。理由を書くまで、この群は外さない`); continue; }
        ignores.push({ g, line: i });
      }
    }
    // 範囲の中にその群の語が無い注記は、何も外していない（置き場所の誤り・語を消した後の残り）。黙って残さない
    for (const x of ignores) {
      let used = false;
      for (let i = Math.max(start, x.line - C20_IGNORE_REACH); i <= Math.min(lines.length - 1, x.line + C20_IGNORE_REACH); i++) if (x.g.re.test(bodyLines[i])) used = true;
      if (!used) add('C20', 'warning', `${where} の ${x.line + 1} 行目の c20-ignore（${x.g.name}）は、前後 ${C20_IGNORE_REACH} 行にその群の語が無く、何も外していない。注記は語のある行と同じ行か、その直前・直後の行に書く（${DESIGN_DOC} §2.3）`);
    }
    const rows = c20TableRows(text);
    const noTable = rows === null ? '（表そのものが無い）' : '';
    for (const g of C20_GROUPS) {
      const hits = [];
      for (let i = start; i < lines.length; i++) {
        const m = bodyLines[i].match(g.re);
        if (!m) continue;
        // 注記が外すのは近くの行だけ（ファイルの別の所で本当に頼る手順は数える）
        if (ignores.some((x) => x.g === g && c20Within(x.line, i))) continue;
        hits.push(`${i + 1} 行目「${m[0]}」`);
      }
      if (!hits.length) continue;
      if (rows && rows.some((r) => g.re.test(r))) continue;
      const shown = hits.slice(0, 3).join('・') + (hits.length > 3 ? `ほか ${hits.length - 3} か所` : '');
      add('C20', 'warning', `${where} の本文が Claude Code にしか無い機能「${g.name}」に頼っている（${shown}）が、§2「入力」の「${C20_TABLE_TITLE}」表にその群の行が無い${noTable}。Codex（$ut）など無い環境での動作を 1 行書く（${DESIGN_DOC} §2.3）。説明・比較だけなら <!-- c20-ignore: ${g.name} <理由> -->`);
    }
    // disallowed-tools は Codex では仕組みで効かない。本文の決まりで守ることを表に書かせる（frontmatter が壊れていれば C11 が止める）
    const fm = readFrontmatter(text);
    if (fm && !fm.error && fm.entries.some((e) => e.key === 'disallowed-tools') && !(rows || []).some((r) => /Codex/.test(r))) {
      add('C20', 'warning', `${where} は frontmatter に disallowed-tools があるが、§2「入力」の「${C20_TABLE_TITLE}」表に Codex の行が無い${noTable}。Codex（$ut）ではこの制限が仕組みで効かないので、本文の禁止事項で守ること（弱い保証であること）を表に書く（${DESIGN_DOC} §2.3）`);
    }
  }
}

function checkClassification(tree, add) {
  // listCommands は templates/ 配下も返す。分類の対象は直下の ut-*.md だけ。
  // 分類は Claude のコマンドの性質なので、配置の対象（--target）に関係なく commands/ を見る
  // （--target が claude 以外のときに、その配置先のフォルダを見て「ut-*.md が無い」と誤って止めていた）。
  // 数えるのは検査する側のツリー（C2・C15 と同じ）。正本だけを数えると、--capture で実行場所にだけある新しいコマンドが
  // 分類の対象から外れ、README の表に載せていれば「実在しないコマンド」と誤って止め、壊れた frontmatter は無検査で取り込む
  const names = commandFileNames(tree);
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
    if (fm.error) { add('C11', 'error', rel + ' の ' + fm.error); continue; }
    for (const k of fm.topKeys) {
      if (!ALLOWED_FRONTMATTER_KEYS.includes(k)) {
        add('C12', 'error', rel + ' が設計方針に無い frontmatter キーを使用: ' + k +
          '（' + DESIGN_DOC + ' を更新するか、使用をやめる）');
      }
    }
    if (fm.scopeError) {
      add('C11', 'error', rel + ' の metadata.scope の値の' + fm.scopeError);
      continue;
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

const PLAN_LABEL = {
  unchanged: '一致',
  differs: '食い違い',
  'repo-updated': '正本だけ更新（配置先は前回一致した時のまま）',
  'live-edited': '実行場所だけ変更（正本は前回一致した時のまま）',
  'repo-only': '正本のみ(未配置)',
  'live-only': '実行場所のみ(未取込)',
};
function printPlan(plan) {
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
  for (const p of plan) console.log(`  ${p.name.padEnd(width)}  ${PLAN_LABEL[p.state]}`);
  console.log('');
  const n = (state) => plan.filter((p) => p.state === state).length;
  console.log(`一致 ${n('unchanged')} / 食い違い ${n('differs')} / 正本のみ ${n('repo-only')} / 実行場所のみ ${n('live-only')}` +
    (targetName === 'codex-skills' ? ` / 正本だけ更新 ${n('repo-updated')} / 実行場所だけ変更 ${n('live-edited')}` : ''));
}

// ---- 試験用の差し込み ------------------------------------------------------
// ホームとリポジトリの両方に、同じ試験ID（32桁の16進）の印があるときだけ効く。
// 環境変数が残っていても、本物のホーム・リポジトリには印が無いので効かない（試験は一時的な写しにだけ印を置く）
const TEST_MARK = '.ut-deploy-test-fixture';
function testFixtureActive() {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
  const h = read(path.join(HOME, TEST_MARK));
  const r = read(path.join(REPO_ROOT, TEST_MARK));
  return !!h && /^[0-9a-f]{32}$/.test(h) && h === r;
}
const TEST_HOOKS = testFixtureActive();
// UT_DEPLOY_MUTATE_AFTER_CHECK=<書き込み元の相対パス>。整合性検査の後・計画の前に、書き込み元のそのファイルの中身を変える
// （検査した中身と計画の中身の照合が止めるかを試す）。今回の書き込み元に無いパスは、黙って無視せずに止める
function applyAfterCheckHook(srcDir) {
  const rel = TEST_HOOKS ? process.env.UT_DEPLOY_MUTATE_AFTER_CHECK : '';
  if (!rel) return;
  if (!listCommands(srcDir).some((n) => toPosix(n) === rel)) fail(`試験用の差し込みのパスが、今回の書き込み元にありません: ${rel}`);
  console.log(`  試験用の差し込みが効いています（検査の後）: ${rel}`);
  fs.writeFileSync(path.join(srcDir, rel.split('/').join(path.sep)), 'mutated-after-check' + String.fromCharCode(10));
}
const MUTATE_KINDS = ['content', 'create', 'source', 'link'];
// UT_DEPLOY_MUTATE_BEFORE_WRITE=<書き込み先の相対パス>:<種類>。書く直前に、そのファイルの状態を変える（再確認が止めるかを試す）
function readMutateHook(writes) {
  const raw = TEST_HOOKS ? process.env.UT_DEPLOY_MUTATE_BEFORE_WRITE : '';
  if (!raw) return null;
  const i = raw.lastIndexOf(':');
  const rel = i > 0 ? raw.slice(0, i) : '';
  const kind = i > 0 ? raw.slice(i + 1) : '';
  if (!MUTATE_KINDS.includes(kind)) fail(`試験用の差し込みの種類が不正: ${kind}`);
  // 計画の書き込み先との完全一致だけを見る。差し込みは一致したファイルを書く直前にしか動かないため、計画の外（.. や絶対パス）へは
  // 構造的に届かない。一致の検査は、指定の誤りを黙って無視せずに止めるためにある（差し込まれないまま試験が通るのを防ぐ）
  if (!writes.some((p) => toPosix(p.name) === rel)) fail(`試験用の差し込みのパスが、今回の書き込み先にありません: ${rel}`);
  let linkTarget = null;
  if (kind === 'link') {
    linkTarget = path.resolve(process.env.UT_DEPLOY_MUTATE_LINK_TARGET || '');
    const r = path.relative(path.resolve(HOME), linkTarget);
    if (!process.env.UT_DEPLOY_MUTATE_LINK_TARGET || !r || r.startsWith('..') || path.isAbsolute(r)) {
      fail(`試験用の差し込みのリンクの先が、ホームの中にありません: ${linkTarget}`);
    }
  }
  console.log(`  試験用の差し込みが効いています: ${rel}:${kind}`);
  return { rel, kind, linkTarget };
}
function applyMutateHook(hook, p, destDir, srcDir) {
  const MUTATED = Buffer.from('mutated-by-test' + String.fromCharCode(10));
  if (hook.kind === 'content' || hook.kind === 'create') {
    const dest = path.join(destDir, p.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, MUTATED);
  } else if (hook.kind === 'source') {
    fs.writeFileSync(path.join(srcDir, p.name), MUTATED);
  } else if (hook.kind === 'link') {
    // 書き込み先の skill フォルダを退かし、ジャンクションに差し替える
    const dir = path.join(destDir, p.name.split(path.sep)[0]);
    fs.renameSync(dir, dir + '.moved-by-test');
    fs.symlinkSync(hook.linkTarget, dir, 'junction');
  }
}

// ---- codex-skills の配置の安全策 ------------------------------------------
// 配置先（~/.agents/skills）は他の道具の skill と同居する。ここで扱ってよいのは、このツールが配置したと
// 管理の記録で分かる skill だけ。名前が同じだけの他者の skill は、--force でも引き取らない。
// 記録のハッシュは「正本と配置先が最後に一致した時点の中身」。placing（書き込みの途中）と retired（撤去待ち）の
// 項目は、この意味が崩れている可能性があるため、どちら側が変わったかの判定に使わない
const SKILL_MANIFEST = path.join(TARGETS['codex-skills'].liveDir, '.ut-commands-managed.json');
const SKILL_ENTRY_KEYS = ['files', 'at', 'placing', 'retired'];
function readSkillManifest() {
  let raw;
  try { raw = fs.readFileSync(SKILL_MANIFEST, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, skills: {} };
    throw e;
  }
  let m;
  try { m = JSON.parse(raw); } catch { fail(`管理の記録を JSON として読めません: ${SKILL_MANIFEST}（中身を確かめて直すか、退避してからやり直す）`); }
  if (!m || !m.skills || typeof m.skills !== 'object' || Array.isArray(m.skills)) fail(`管理の記録の形式が不正です: ${SKILL_MANIFEST}`);
  if (m.version !== 1) fail(`管理の記録の版が不明です（version=${JSON.stringify(m.version)}）: ${SKILL_MANIFEST}（この版の deploy.mjs は version 1 だけを読む）`);
  // 中身の形も確かめる。形の崩れた記録を「自分の skill」の証拠として使わない（"ut": "x" でも引き取っていた）
  for (const [n, v] of Object.entries(m.skills)) {
    const plain = v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
    const okFiles = plain && v.files && typeof v.files === 'object' && !Array.isArray(v.files)
      && Object.entries(v.files).every(([k, h]) => SKILL_FILES.includes(k) && typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
    const okFlags = plain && typeof v.at === 'string' && Object.keys(v).every((k) => SKILL_ENTRY_KEYS.includes(k))
      && (!Object.hasOwn(v, 'placing') || v.placing === true) && (!Object.hasOwn(v, 'retired') || v.retired === true);
    if (!SKILL_NAME_RE.test(n) || !okFiles || !okFlags) fail(`管理の記録の ${n} の形式が不正です: ${SKILL_MANIFEST}（中身を確かめて直すか、退避してからやり直す）`);
  }
  return m;
}
// 配置先の途中にリンク（シンボリックリンク・ジャンクション）があれば、リンクの先へ書かない
// capture のときはリポジトリ側（codex-skills/）が書き込み先になるため、両方の側を見る
function findSkillLink(names) {
  const live = TARGETS['codex-skills'].liveDir;
  const repo = TARGETS['codex-skills'].repoDir;
  const paths = [path.dirname(live), live, repo];
  for (const n of names) paths.push(path.join(live, n), path.join(live, n, 'agents'), path.join(repo, n), path.join(repo, n, 'agents'));
  for (const p of paths) {
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) return p;
  }
  return null;
}
function assertNoSkillLinks(names) {
  const p = findSkillLink(names);
  if (p) fail(`配置先の途中にリンクがあります: ${p}（リンクの先へは書かない）`);
}
// 配置の前の確認。問題があれば、書き込みを1つも始める前に止める
function checkSkillLive(plan) {
  const names = managedSkillNames();
  const manifest = readSkillManifest();
  const before = JSON.stringify(manifest);
  const owned = new Set(Object.keys(manifest.skills));
  assertNoSkillLinks(names);
  const live = TARGETS['codex-skills'].liveDir;
  const problems = [];
  for (const n of names) {
    const dir = path.join(live, n);
    if (fs.existsSync(dir) && !Object.hasOwn(manifest.skills, n)) {
      problems.push(`${n}: 管理の記録に無い同名の skill が配置先にある（他の道具の skill の可能性。--force でも引き取らない。手で確かめて移すか、名前を変える）`);
    }
    const yaml = readIfExists(path.join(dir, 'agents', 'openai.yaml'));
    if (yaml && normLF(yaml.toString('utf8')) !== SKILL_POLICY) {
      problems.push(`${n}: 配置先の agents/openai.yaml が正規の形でない（自動の呼び出しが止まっていない可能性。上書きの更新として続けない）`);
    }
    if (fs.existsSync(path.join(dir, 'SKILL.md')) && !yaml) {
      problems.push(`${n}: 配置先に SKILL.md があるのに agents/openai.yaml が無い（自動の呼び出しが止まっていない）`);
    }
  }
  const retired = Object.keys(manifest.skills).filter((n) => !names.includes(n));
  // 注意（止めはしない）: 途中で止まった配置の名残、記録した内容と配置先の中身の食い違い（手元で変えた可能性）
  const notes = [];
  for (const [n, v] of Object.entries(manifest.skills)) {
    if (v.placing) notes.push(`${n}: 前回の配置が途中で止まっている（どちら側が変わったかの判定に記録を使わない。書き込みが済めば確定する）`);
    for (const [f, h] of Object.entries(v.files)) {
      const b = readIfExists(path.join(live, n, ...f.split('/')));
      if (b && hashOf(b) !== h) notes.push(`${n}/${f}: 配置先の中身が、前回一致したときの記録と違う（手元で変えた可能性。apply すると、この編集は失われる）`);
    }
  }
  // どちら側が変わったかを、記録（R）と正本（S）・配置先（L）のハッシュで分ける
  for (const p of plan) {
    if (p.state !== 'differs') continue;
    const [n, ...rest] = toPosix(p.name).split('/');
    const f = rest.join('/');
    const v = Object.hasOwn(manifest.skills, n) ? manifest.skills[n] : null;
    if (!v || Object.hasOwn(v, 'placing') || Object.hasOwn(v, 'retired') || !Object.hasOwn(v.files, f)) continue;
    const R = v.files[f];
    const S = hashOf(p.repoBuf);
    const L = hashOf(p.liveBuf);
    if (L === R && S !== R) p.state = 'repo-updated';
    else if (S === R && L !== R) p.state = 'live-edited';
  }
  // names は計画の時点の skill の名前。書く直前のリンクの確認でもこれを使う（その場で数え直すと、ジャンクションに
  // 差し替えられた skill はフォルダとして数えられず、確認の対象から外れてしまう）
  return { manifest, before, owned, names, problems, retired, notes, planNames: plan.map((p) => p.name) };
}
// 管理の記録を確定する。対象は、実行を始めた時点で記録にあった名前と、今回 placing で所有を始めた名前だけ
// （記録に無い skill をここで新しく載せない。書き込み0件の capture が、配置していない skill を所有済みにしないため）。
// 両側が一致するファイルだけを記録し、一致しないものがあれば placing を残す。正本から消えた名前は、
// 配置先のフォルダが残っていれば retired を付け、フォルダも無ければ項目を外す（所有を手放す）。
// 中身が変わらなければ書き直さない（at を動かさない）。戻り値は書き直したかどうか
function finalizeSkillManifest(info) {
  const m = info.manifest;
  const live = TARGETS['codex-skills'].liveDir;
  const repo = TARGETS['codex-skills'].repoDir;
  const names = managedSkillNames();
  const now = new Date().toISOString();
  for (const n of [...info.owned]) {
    const prev = Object.hasOwn(m.skills, n) ? m.skills[n] : null;
    if (!names.includes(n)) {
      if (!fs.existsSync(path.join(live, n))) delete m.skills[n];
      else if (prev && !prev.retired) m.skills[n] = { ...prev, retired: true, at: now };
      continue;
    }
    const files = {};
    let complete = true;
    for (const f of SKILL_FILES) {
      const b = readIfExists(path.join(live, n, ...f.split('/')));
      const r = readIfExists(path.join(repo, n, ...f.split('/')));
      if (b && r && hashOf(b) === hashOf(r)) files[f] = hashOf(b); else complete = false;
    }
    const next = { files };
    if (!complete) {
      next.placing = true;
      if (prev && prev.retired) next.retired = true;
    }
    const same = prev && JSON.stringify(prev.files) === JSON.stringify(files)
      && !!prev.placing === !!next.placing && !!prev.retired === !!next.retired;
    m.skills[n] = { files, at: same ? prev.at : now, ...(next.placing ? { placing: true } : {}), ...(next.retired ? { retired: true } : {}) };
  }
  m.version = 1;
  if (JSON.stringify(m) === info.before) return false;
  fs.mkdirSync(path.dirname(SKILL_MANIFEST), { recursive: true });
  writeAtomic(SKILL_MANIFEST, Buffer.from(JSON.stringify(m, null, 2) + '\n'));
  info.before = JSON.stringify(m);
  return true;
}
function reportSkillLive(info) {
  for (const p of info.problems) console.log(`  問題: ${p}`);
  for (const n of info.notes) console.log(`  注意: ${n}`);
  for (const n of info.retired) console.log(`  撤去待ち: ${n}（管理の記録にあるが、正本の codex-skills/ に無い。撤去は専用の手順で、確認してから行う）`);
}

function run() {
  if (!fs.existsSync(REPO_CMD_DIR)) fail(`正本ディレクトリがありません: ${REPO_CMD_DIR}`);

  if (mode === 'check') {
    return printChecks(runChecks(null).findings, '正本(repo)') ? 3 : 0;
  }

  let checkedTree = null;
  if (mode === 'apply' || mode === 'capture') {
    if (skipCheck) {
      // --no-check でも機微値スキャン(C10)と skills の自動の呼び出しの停止(C13)は必ず実行する（runRequiredChecks）。
      // C1-C9 などは「壊れたまま急ぎ配る」判断が成立しうるが、機微値の流出と意図しない skill の起動は、どんな緊急性でも取り返しがつかない。
      console.log('警告: 整合性検査をスキップしています(--no-check)。機微値スキャン(C10)と skills の停止(C13)は必ず実行します。');
      const captureTarget = mode === 'capture' ? targetName : null;
      // C13 も迂回させない。自動の呼び出しが止まっていない skill を配ると、利用者の意図しない起動が起きる。
      // 走らせるのは C10・C13 だけ（ほかの検査の例外で --no-check まで止めない）
      const req = runRequiredChecks(captureTarget);
      checkedTree = req.tree;
      if (printChecks(req.findings, '機微値スキャン(C10)・skills の停止(C13)のみ')) {
        console.log('');
        console.log('ブロック: 機微値の疑い、または自動の呼び出しを止めていない skill があります。--no-check では回避できません。');
        return 3;
      }
      console.log('');
    } else {
      const captureTarget = mode === 'capture' ? targetName : null;
      const scope = captureTarget ? `取り込み後の状態(${LIVE_CMD_DIR} を反映)` : '正本(repo)';
      const res = runChecks(captureTarget);
      checkedTree = res.tree;
      if (printChecks(res.findings, scope)) {
        console.log('');
        console.log(`ブロック: 整合性検査でエラーがあります。直してから ${mode} してください。`);
        console.log('検査ロジック側の問題で急ぎ配りたい場合のみ --no-check を付けてください。');
        return 3;
      }
      console.log('');
    }
    applyAfterCheckHook(mode === 'capture' ? LIVE_CMD_DIR : REPO_CMD_DIR);
  }

  const plan = computePlan();
  // 検査した中身と計画の中身を照らす。計画は書き込み元を読み直すので、検査の後・計画の前に変わった未検査の中身が配られうる
  // （書く直前の再確認は計画との比較なので、ここで外れたものは通ってしまう）。書き込み元の側（apply は正本、capture は実行場所）の
  // 中身のハッシュが、検査で読んだときと一致しなければ、1件も書かずに止める
  if (checkedTree) {
    const changed = plan.filter((p) => {
      const buf = mode === 'capture' ? p.liveBuf : p.repoBuf;
      if (!buf) return false;
      const rel = `${target.repoDirName}/${toPosix(p.name)}`;
      return checkedTree.readHashes.get(rel) !== hashOf(buf);
    });
    if (changed.length) {
      console.log('');
      console.log(`ブロック: 整合性検査の後に書き込み元が変わった（検査していない中身を配らない）: ${changed.map((p) => p.name).join(', ')}。何も書いていません（もう一度実行してください）。`);
      return 1;
    }
  }
  // codex-skills は、表示の前に記録で「どちら側が変わったか」を分ける
  const skillInfo = targetName === 'codex-skills' ? checkSkillLive(plan) : null;
  printPlan(plan);
  if (skillInfo) {
    console.log('');
    reportSkillLive(skillInfo);
    if (!skillInfo.problems.length && !skillInfo.retired.length && !skillInfo.notes.length) console.log('  配置先の skills: 問題なし（管理の記録・自動の呼び出しの停止・リンク）');
    if (skillInfo.problems.length && mode !== 'dry-run') {
      console.log('');
      console.log('ブロック: 配置先の skills に問題があります。直してから実行してください（--force でも回避できません）。');
      return 3;
    }
  }

  if (mode === 'dry-run') {
    console.log('');
    console.log('(dry-run: 何も書き込んでいません。整合性検査は --check)');
    const count = (s) => plan.filter((p) => p.state === s).length;
    if (count('repo-updated')) console.log(`正本だけ更新された ${count('repo-updated')} 件は --force なしで配れます: node tools/deploy.mjs --target ${targetName} --apply`);
    if (count('live-edited')) console.log(`実行場所だけ変更された ${count('live-edited')} 件は --force なしで取り込めます: node tools/deploy.mjs --target ${targetName} --capture`);
    if (count('differs')) {
      console.log('食い違いがあります。どちらを正とするか決めてから実行してください:');
      console.log(`  正本を正とする  : node tools/deploy.mjs --target ${targetName} --apply --force`);
      console.log(`  手元編集を正とする: node tools/deploy.mjs --target ${targetName} --capture --force`);
    }
    return 0;
  }

  const toRepo = mode === 'capture';
  const destDir = toRepo ? REPO_CMD_DIR : LIVE_CMD_DIR;
  const srcDir = toRepo ? LIVE_CMD_DIR : REPO_CMD_DIR;
  const addState = toRepo ? 'live-only' : 'repo-only';
  // 反対側だけが変わったもの（apply なら repo-updated、capture なら live-edited）は、反対側の編集を失わないので --force が要らない
  const [safeStates, forcedStates] = toRepo ? [['live-edited'], ['differs', 'repo-updated']] : [['repo-updated'], ['differs', 'live-edited']];
  const srcOf = (p) => (toRepo ? p.liveBuf : p.repoBuf);
  const destOf = (p) => (toRepo ? p.repoBuf : p.liveBuf);
  const adds = plan.filter((p) => p.state === addState);
  const safe = plan.filter((p) => safeStates.includes(p.state));
  const overwrites = plan.filter((p) => forcedStates.includes(p.state));

  if (overwrites.length && !force) {
    const lost = toRepo ? '正本' : '配置先';
    console.log('');
    console.log(`ブロック: このまま ${mode} すると編集が失われるファイルが ${overwrites.length} 件あります。`);
    for (const p of overwrites) {
      const why = p.state === 'differs' ? '両側とも変わっている、または記録が使えない' : `${lost}の新しい編集が失われる`;
      console.log(`  - ${p.name}（${why}）`);
    }
    console.log(`意図した向きなら --force を付けてください`);
    console.log('(上書き前に .bak-<時刻>-<ミリ秒> を残します。同名があれば .1 .2 ... で衝突回避します)。');
    return 1;
  }

  const report = (changed) => { if (changed) console.log(`  管理の記録を更新: ${path.basename(SKILL_MANIFEST)}（${Object.keys(skillInfo.manifest.skills).length} 件）`); };
  if (!adds.length && !safe.length && !overwrites.length) {
    console.log('');
    console.log('作業不要(すべて一致)。');
    // 書き込みが0件でも記録は確定する（途中で止まった記録の完成、撤去待ちの印、所有を手放した名前の片付け）
    if (skillInfo) report(finalizeSkillManifest(skillInfo));
    return 0;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const ts = stamp();
  let added = 0;
  let updated = 0;
  // skills は、1つの skill の中で openai.yaml を先に、SKILL.md を最後に書く（名前の順に並べると SKILL.md が先になる）
  // 並べ替えは skill の名前（先頭の要素）ごとにまとめ、その中は fileOrder で決める。同順位は文字コードの順にする
  // （localeCompare の照合順に頼らない。文字コードの順では SKILL.md が agents/ より先になるため、fileOrder が効いていないと気づける）
  const seg = (n) => n.split(path.sep)[0];
  const cp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const writes = [...adds, ...safe, ...overwrites].sort((a, b) => (seg(a.name) === seg(b.name)
    ? (fileOrder(a.name) - fileOrder(b.name)) || cp(a.name, b.name)
    : cp(seg(a.name), seg(b.name))));
  const failAfter = TEST_HOOKS ? Number(process.env.UT_DEPLOY_FAIL_AFTER || 0) : 0; // 試験用: n 件を書いた直後に止める
  const hook = readMutateHook(writes);
  // 書き込み対象を持つすべての skill を、書き込みより先に placing にして保存する（新規も既存も、apply も capture も）。
  // 途中で止まったとき、書けた側と書けていない側が混ざった状態の記録を「最後に一致した中身」として使わないため
  if (skillInfo) {
    const m = skillInfo.manifest;
    for (const n of new Set(writes.map((p) => seg(p.name)))) {
      const prev = Object.hasOwn(m.skills, n) ? m.skills[n] : { files: {} };
      m.skills[n] = { ...prev, at: new Date().toISOString(), placing: true };
      skillInfo.owned.add(n);
    }
    fs.mkdirSync(path.dirname(SKILL_MANIFEST), { recursive: true });
    writeAtomic(SKILL_MANIFEST, Buffer.from(JSON.stringify(m, null, 2) + '\n'));
    skillInfo.before = JSON.stringify(m);
  }

  for (const p of writes) {
    const dest = path.join(destDir, p.name);
    const buf = srcOf(p);
    if (!buf) fail(`内部エラー: ${p.name} の読み込み元がありません。`);
    if (hook && toPosix(p.name) === hook.rel) applyMutateHook(hook, p, destDir, srcDir);
    // 書く直前の再確認。計画を立てた後の通常の変更を検出する（読み直してから置き換えるまでの短い間の変更は防がない。
    // 複数の deploy の同時実行も想定しない）。外れたら、このファイルから先は書かない。記録は placing のまま残る
    const stopAt = (why) => {
      console.log('');
      console.log(`ブロック: ${p.name} — ${why}。このファイルから先は書いていません（計画を立て直すため、もう一度実行してください）。`);
      return 1;
    };
    const srcNow = readIfExists(path.join(srcDir, p.name));
    if (!srcNow || hashOf(srcNow) !== hashOf(buf)) return stopAt('計画を立てた後に書き込み元が変わった');
    const destNow = readIfExists(dest);
    const destPlan = destOf(p);
    if (!!destNow !== !!destPlan || (destNow && hashOf(destNow) !== hashOf(destPlan))) return stopAt('計画を立てた後に書き込み先が変わった');
    if (skillInfo) {
      const link = findSkillLink(skillInfo.names);
      if (link) return stopAt(`書き込み先の途中にリンクがある: ${link}（リンクの先へは書かない）`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const isOverwrite = !!destNow;
    const backup = isOverwrite ? uniqueBackupPath(dest, ts) : null;
    if (backup) fs.copyFileSync(dest, backup);
    writeAtomic(dest, buf);
    // 自動の呼び出しを止める設定は、読み直して正規の形であることを確かめてから次（SKILL.md）へ進む
    if (skillInfo && !toRepo && toPosix(p.name).endsWith('/agents/openai.yaml')) {
      const back = readIfExists(dest);
      if (!back || normLF(back.toString('utf8')) !== SKILL_POLICY) fail(`書き込み後の確認に失敗: ${dest}（SKILL.md は書いていない）`);
    }
    if (isOverwrite) {
      updated++;
      console.log(`  更新 ${p.name}  (退避: ${path.basename(backup)})`);
    } else {
      added++;
      console.log(`  追加 ${p.name}`);
    }
    if (failAfter && added + updated >= failAfter) fail(`UT_DEPLOY_FAIL_AFTER による中断（${added + updated} 件を書いた直後）`);
  }

  // 両側が一致したファイルを「最後に一致した中身」として記録する（apply も capture も。次回、どちら側が変わったかの判定と、同名の他者の skill との区別に使う）
  if (skillInfo) report(finalizeSkillManifest(skillInfo));

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
