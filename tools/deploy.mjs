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
          C7 表の重複掲載 / C9 外部参照の陳腐化(警告) / C10 機微値の混入 /
          C13 skills の自動の呼び出しの停止（C10 と C13 は --no-check でも必ず実行する） /
          C14 codex-skills/ に配置の対象外のファイルが無い`);
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
      const m = spec.commandListRe.exec(text);
      if (m) {
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

  // C13: skills の自動の呼び出しを止めているか（C10 と同じく --no-check でも必ず実行する）
  checkSkills(tree, add);

  return findings;
}

// ---- C13: skills の自動の呼び出しの停止 -----------------------------------
// ut-* は「人が明示したときだけ動く」。Codex の skills は既定で、内容から判断して自動で呼ばれる
// （実機で確認: 何もしないと内容に合う依頼で 3/3 回起動した）。skill のフォルダの agents/openai.yaml で
// policy.allow_implicit_invocation を false にすると止まる（同 0/3 回）。止め忘れを人の注意に任せない
// codex-skills/ の下にある「管理すべきファイル」の一覧。git の追跡・未追跡（.gitignore の対象を除く）で数える。
// 退避（*.bak-*）・書きかけ（*.tmp）・OS が作るファイルで検査が止まらないようにするため（--capture の退避で実際に止まった）
function skillRepoFiles() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.quotepath=false', 'ls-files', '-c', '-o', '--exclude-standard', '--', 'codex-skills'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean)
      .filter((f) => fs.existsSync(path.join(REPO_ROOT, ...f.split('/'))))
      .map((f) => f.slice('codex-skills/'.length));
  } catch {
    // git が使えない写し（試験など）では、フォルダをたどり、退避・書きかけ・OS のファイルを除く
    const out = [];
    const root = path.join(REPO_ROOT, 'codex-skills');
    const walk = (d, rel) => {
      for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${x.name}` : x.name;
        if (x.isDirectory()) walk(path.join(d, x.name), r);
        else if (!/\.bak-|\.tmp$|^desktop\.ini$|^Thumbs\.db$|^\.DS_Store$/i.test(x.name)) out.push(r);
      }
    };
    if (fs.existsSync(root)) walk(root, '');
    return out;
  }
}
// frontmatter を1行ずつ読み、壊れた書き方（重複したキー・引用の無い値の中の「: 」・キーの形でない行）を拒否する。
// 壊れていると Codex がその skill を読み込まないか、別の名前で登録しうる
function parseSkillFrontmatter(text) {
  const lines = normLF(text).split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return { error: 'frontmatter が無い' };
  const keys = {};
  for (const l of lines.slice(1, end)) {
    if (!l.trim()) continue;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/);
    if (!m) return { error: `frontmatter に解釈できない行がある: ${l.slice(0, 40)}` };
    if (m[1] in keys) return { error: `frontmatter のキーが重複している: ${m[1]}` };
    const v = (m[2] || '').trim();
    if (!/^["']/.test(v) && /: /.test(v)) return { error: `frontmatter の ${m[1]} の値に引用の無い「: 」がある（YAML として壊れる）` };
    keys[m[1]] = v;
  }
  return { keys };
}
function checkSkills(tree, add) {
  const dir = path.join(REPO_ROOT, 'codex-skills');
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKILL_NAME_RE.test(e.name)) add('C13', 'error', `skill の名前が規則（英小文字・数字・-）に合わない: ${e.name}`);
  }
  // C14（通常の検査）: 決まったファイル以外があれば、配置されないまま残る（SKILL.md が参照していても届かない）
  for (const f of skillRepoFiles()) {
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
  // 分類は Claude のコマンドの性質なので、配置の対象（--target）に関係なく commands/ を見る
  // （--target が claude 以外のときに、その配置先のフォルダを見て「ut-*.md が無い」と誤って止めていた）
  const names = TARGETS.claude.listFiles(TARGETS.claude.repoDir).filter(
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
    return printChecks(runChecks(null), '正本(repo)') ? 3 : 0;
  }

  if (mode === 'apply' || mode === 'capture') {
    if (skipCheck) {
      // --no-check でも機微値スキャン(C10)だけは必ず実行する。C1-C9 は「壊れたまま急ぎ
      // 配る」判断が成立しうるが、機微値の流出はどんな緊急性でも取り返しがつかない。
      console.log('警告: 整合性検査をスキップしています(--no-check)。機微値スキャン(C10)と skills の停止(C13)は必ず実行します。');
      const captureTarget = mode === 'capture' ? targetName : null;
      // C13 も迂回させない。自動の呼び出しが止まっていない skill を配ると、利用者の意図しない起動が起きる
      const only = runChecks(captureTarget).filter((f) => f.id === 'C10' || f.id === 'C13');
      if (printChecks(only, '機微値スキャン(C10)・skills の停止(C13)のみ')) {
        console.log('');
        console.log('ブロック: 機微値の疑い、または自動の呼び出しを止めていない skill があります。--no-check では回避できません。');
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
