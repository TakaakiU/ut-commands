// ut-env.mjs の --selftest に欠陥を1つずつ注入し、実際に落ちるかを掃引する負テスト。
// 「selftest が全件パス」を検証済みの根拠にしないため、防御ごとに壊して、その防御を見るテストで落ちることを確かめる。
//   node tools/ut-env-sweep.mjs            （repo ルートで実行する）
// exit: 0 全件 CAUGHT / 1 それ以外（基準実行の失敗・未検出・別理由での検出・異常終了・設計不正）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 生成経路でバックスラッシュが落ちる事故を避けるため、改行は定数で組み立て、正規表現を含む文字列は String.raw で書く
const NL = String.fromCharCode(10);
const R = String.raw;
const SRC_PATH = 'tools/ut-env.mjs';
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ute-sweep-'));
// 変異版から相対 import する mask.mjs を横に置く
// mask.mjs は ../commands/templates/ut-review.mjs を相対 import するため、写しの置き場所では解決できない。repo の実ファイルを指す絶対 URL に書き換える
{
  const reviewUrl = pathToFileURL(path.resolve('commands/templates/ut-review.mjs')).href;
  const maskSrc = fs.readFileSync('tools/mask.mjs', 'utf8');
  const rewritten = maskSrc.replace("'../commands/templates/ut-review.mjs'", JSON.stringify(reviewUrl));
  if (rewritten === maskSrc) { console.log('mask.mjs の import を書き換えられない（形が変わった）'); process.exit(1); }
  fs.writeFileSync(path.join(tmp, 'mask.mjs'), rewritten);
}

// expect: その防御を見ているテスト名の一部。これで落ちた場合だけ CAUGHT と数える
const mutations = [
  // ---- 判定（3者比較）
  { id: 'E01', desc: 'CRLF を LF に揃えずにハッシュを取る', expect: 'CRLF だけの差は一致',
    find: R`.toString('latin1').replace(/\r\n/g, '\n');`, to: `.toString('latin1');` },
  { id: 'E02', desc: '記録のキーを小文字に揃えない', expect: 'パスの大小文字だけの差は一致',
    find: 'const key = (rel) => posix(rel).toLowerCase();', to: 'const key = (rel) => posix(rel);' },
  { id: 'E03', desc: '計画で正本自身を拒否しない', expect: '正本自身は拒否',
    find: "throw new ConfigError('正本自身は対象にできない');" + NL + '  const warnings', to: '0;' + NL + '  const warnings' },
  { id: 'E04', desc: '衝突を常に取り込む（上書きする）', expect: '手元の変更は衝突で上書きしない',
    find: "return { state: 'conflict', action: take ? 'take' : null };", to: "return { state: 'conflict', action: 'take' };" },
  { id: 'E05', desc: '記録と一致するかを見ずに「正本が更新」とする', expect: '記録なしの差分は衝突',
    find: "if (rec && tgt === rec) return { state: 'updated'", to: "if (true) return { state: 'updated'" },
  { id: 'E06', desc: '追跡ファイルを判定から外す', expect: '追跡ファイルは上書きしない',
    find: "if (tracked) return { state: 'tracked', action: null };", to: '' },
  { id: 'E07', desc: '--prune なしでも消す', expect: '正本から消えたものは既定で消さない',
    find: "action: prune && canPrune ? 'prune' : null", to: "action: canPrune ? 'prune' : null" },
  { id: 'E08', desc: '退避せずに消す', expect: '--prune で退避してから消す',
    find: "else if (it.action === 'prune') { backup(it.rel); fs.unlinkSync", to: "else if (it.action === 'prune') { fs.unlinkSync" },
  { id: 'E09', desc: '退避せずに更新する', expect: '正本の更新を検出して更新する',
    find: "it.action === 'take') { backup(it.rel); copyIn(it); }", to: "it.action === 'take') { copyIn(it); }" },
  { id: 'E10', desc: '計画でリンクを判定しない（書き込み時の確認だけが残る）', expect: 'リンクは追従しない',
    find: "if (link) { it.state = 'link'; it.note = link; items.push(it); continue; }", to: '' },
  { id: 'E11', desc: 'リンクの検出そのものを外す（リンクの先へ書く）', expect: 'リンクは追従しない',
    find: 'if (st.isSymbolicLink()) return posix(path.relative(root, cur));', to: '' },
  { id: 'E12', desc: '壊れた記録を壊れていないことにする', expect: '壊れたマニフェストは上書きしない側に倒れる',
    find: 'return { files: {}, broken: true };', to: 'return { files: {}, broken: false };' },
  { id: 'E13', desc: '一致でも毎回「記録」を変更に数える', expect: '2回目は変更0件',
    find: "action: rec === src ? null : 'record'", to: "action: 'record'" },
  { id: 'E14', desc: '正本自身を「リンク worktree」と判定する', expect: '正本自身は拒否',
    find: "if (canonAbs(top) === canonAbs(srcTop)) kind = 'source';", to: "if (false) kind = 'source';" },
  { id: 'E15', desc: 'リンク worktree を別 clone と判定する', expect: 'ツリーの種類を判定する',
    find: "else if (canonAbs(common) === canonAbs(srcCommon)) kind = 'linked-worktree';", to: '' },
  { id: 'E16', desc: 'キャッシュを複製対象から外さない', expect: '不足を複製対象にする',
    find: "const IGNORE_NAMES = new Set(['__pycache__', '.DS_Store', 'Thumbs.db']);", to: 'const IGNORE_NAMES = new Set([]);',
    also: ["const IGNORE_EXT = ['.pyc'];", 'const IGNORE_EXT = [];'] },

  // ---- apply の原子性・排他
  { id: 'E20', desc: 'ロックを排他で作らない', expect: '二重起動を拒否',
    find: "const fd = fs.openSync(f, 'wx');", to: "const fd = fs.openSync(f, 'w');" },
  { id: 'E21', desc: '例外時にロックを解放しない', expect: '途中で止まっても再実行で収束',
    find: 'after };' + NL + '  } finally { release(); }', to: 'after };' + NL + '  } finally { }' },
  { id: 'E22', desc: '1件ごとに記録しない', expect: '途中で止まっても再実行で収束',
    find: '      writeManifest(top, files, profile.source);' + NL + '      done.push(it);', to: '      done.push(it);' },

  // ---- exclude
  { id: 'E30', desc: '除外済みかを判定せず常に追記する', expect: '除外済みなら追記しない',
    find: 'if (code === 1) adds.push(p);', to: 'if (code === 1 || code === 0) adds.push(p);' },
  { id: 'E31', desc: '秘密ファイルを exclude の候補から外す', expect: '未除外のセットのディレクトリを追記する',
    find: '...profile.exclude, ...profile.secret_files];', to: '...profile.exclude];' },
  { id: 'E32', desc: 'セットのディレクトリを exclude の候補から外す', expect: '未除外のセットのディレクトリを追記する',
    find: "for (const pat of profile.sets[s]) out.push(pat.endsWith('/**') ? pat.slice(0, -3) + '/' : pat);", to: '' },

  // ---- profile
  { id: 'E40', desc: 'セットに秘密ファイルを含めても拒否しない', expect: 'セットに秘密ファイルを含めたら拒否',
    find: 'if (hit) throw new ConfigError(', to: 'if (false) throw new ConfigError(' },
  { id: 'E41', desc: '.. を含むパスを拒否しない', expect: '不正な型は拒否',
    find: "x === '..' || (x.includes", to: "(x.includes" },

  // ---- doctor
  { id: 'E50', desc: '点検の例外を他へ波及させる', expect: '点検の例外が他に波及しない',
    find: '  } catch (e) {' + NL + "    results.push({ area, check: name, status: 'fail', message: `判定できない", to: '  } catch (e) { throw e;' + NL + "    results.push({ area, check: name, status: 'fail', message: `判定できない" },
  { id: 'E51', desc: 'codex doctor の要約文（テナントID入り）を表示に含める', expect: '秘密の値・メール・テナントIDを出さない',
    find: '.map((c) => `${c.id}=${c.status}`);', to: '.map((c) => `${c.id}=${c.status} ${c.summary || ""}`);' },
  { id: 'E52', desc: 'codex login status の出力（メール入り）を表示し、最後のマスクも外す', expect: '秘密の値・メール・テナントIDを出さない',
    find: "{ status: 'ok', message: 'ログイン済み', evidence: 'codex login status' }", to: "{ status: 'ok', message: r.stdout.trim(), evidence: 'codex login status' }",
    also: ["for (const r of results) for (const k of ['check', 'message', 'fix', 'evidence']) r[k] = mask(r[k]);", ''] },
  { id: 'E53', desc: 'レジストリの出力（値入り）を表示に含める', expect: '秘密の値・メール・テナントIDを出さない',
    find: "message: 'ユーザー環境変数にはあるが、このプロセスに反映されていない'", to: 'message: r.stdout' },
  { id: 'E54', desc: '環境変数の値を表示する', expect: '秘密の値・メール・テナントIDを出さない',
    find: "message: '現在のプロセスに設定あり（値は表示しない。値が有効かは未確認）'", to: 'message: process.env[name]' },
  { id: 'E55', desc: 'Backlog の例外文（キー入り URL）を返し、親の選別も外す', expect: '通信の子プロセスがキーを返さない',
    find: "{ code: r.status })); process.exit(0); })\n  .catch((e) => { console.log(JSON.stringify({ err: (e && e.cause && e.cause.code) || (e && e.name) || 'Error' }));", to: '{ code: r.status })); process.exit(0); })\n  .catch((e) => { console.log(JSON.stringify({ err: String(e && e.message) + " " + u }));',
    also: ["const safeErr = typeof o.err === 'string' && /^[A-Za-z_]+$/.test(o.err) ? o.err : 'Error';\n  return { ok: Number.isInteger(o.code) && o.code >= 200", 'const safeErr = o.err;\n  return { ok: Number.isInteger(o.code) && o.code >= 200'] },
  { id: 'E56', desc: 'fail があっても終了コード0', expect: 'fail のときだけ終了コード1',
    find: 'return d.totals.fail ? 1 : 0;', to: 'return 0;' },
  { id: 'E57', desc: 'fail を総数に数えない', expect: '総数 = ok + warn + fail',
    find: '    totals[r.status]++;', to: "    if (r.status !== 'fail') totals[r.status]++;" },
  { id: 'E58', desc: 'レジストリだけにある環境変数を未設定扱いにする', expect: '未反映の環境変数は warn',
    find: "if (r.code === 0) return { check: `環境変数 ${name}`, status: 'warn'", to: "if (false) return { check: `環境変数 ${name}`, status: 'warn'" },
  { id: 'E59', desc: '除外されていない秘密ファイルを warn にとどめる', expect: '除外されていない秘密ファイルは fail',
    find: ": { status: 'fail', message: 'あり、しかも git の除外に入っていない（誤って add される）'", to: ": { status: 'warn', message: 'あり、しかも git の除外に入っていない（誤って add される）'" },
  // ---- ローカルレビュー（Claude・SonarQube）の指摘に対する防御
  { id: "E60", desc: "記録の path を検証しない（ツリーの外を読み書きする）", expect: "記録のパスがツリーの外を指したら",
    find: "s.split('/').includes('..') || key(s) !== key(k)) throw new Error('path');", to: "false) throw new Error('path');" },
  { id: "E61", desc: "追跡ファイルの判定を「一致」より後に置く（以前の順序）", expect: "追跡ファイルは正本から消えても消さず",
    find: "  if (tracked) return { state: 'tracked', action: null };\n  if (src) {", to: "  if (src) {",
    also: ["    if (tgt === src) return { state: 'same', action: rec === src ? null : 'record' };","    if (tgt === src) return { state: 'same', action: rec === src ? null : 'record' };\n    if (tracked) return { state: 'tracked', action: null };"] },
  { id: "E62", desc: "正本にセットの中身が無くても警告しない", expect: "正本にセットの中身が無ければ成功にしない",
    find: "    if (!files.length) warnings.push(", to: "    if (false) warnings.push(" },
  { id: "E63", desc: "計画に無い --take-source を黙って無視する", expect: "計画に無い --take-source は拒否",
    find: "  if (strayTake.length) throw new ConfigError(", to: "  if (false) throw new ConfigError(" },
  { id: "E64", desc: "複製の前に exclude を追記しない", expect: "途中で止まっても exclude は先に入っている",
    find: "    if (plan.excludeAdds.length) appendExclude(plan.info, plan.excludeAdds);", to: "" },
  { id: "E65", desc: "ロックの持ち主を確かめずに消す", expect: "自分のロックだけを解放する",
    find: "if (JSON.parse(fs.readFileSync(f, 'utf8')).token === token) fs.unlinkSync(f);", to: "fs.unlinkSync(f);" },
  { id: "E66", desc: "\"Not logged in\" もログイン済みと判定する", expect: "Not logged in をログイン済みにしない",
    find: "/^\\s*logged in\\b/im.test(text) && !/not logged in/i.test(text)", to: "/logged in/i.test(text)" },
  { id: "E67", desc: "カレントディレクトリの同名コマンドの実行を止めない", expect: "外部コマンドをカレントディレクトリから探させない",
    find: ", env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } };", to: " };" },
  { id: "E68", desc: "外部コマンドの引数を検証しない", expect: "外部コマンドをカレントディレクトリから探させない",
    find: "  for (const a of [name, ...args]) if (!SAFE_ARG.test(a)) throw", to: "  for (const a of [name, ...args]) if (false) throw" },
  { id: "E69", desc: "JSON の解析エラーの文言（入力の断片入り）をそのまま出す", expect: "JSON の解析エラーで入力の断片を出さない",
    find: "try { return JSON.parse(text); } catch { throw new Error(`${label} を JSON として読めない`); }", to: "try { return JSON.parse(text); } catch (e) { throw new Error(e.message); }" },
  { id: "E70", desc: "許可ドメインを settings.json の部分一致で判定する", expect: "deny にだけある許可ドメインを許可ありにしない",
    find: "const hit = Array.isArray(allow) && allow.some((x) => typeof x === 'string' && x.includes(b.settings_pattern));", to: "const hit = fs.readFileSync(f, 'utf8').includes(b.settings_pattern);" },
  { id: "E71", desc: "点検が0件でも正常にする", expect: "点検が0件なら fail",
    find: "  if (!results.length) results.push(", to: "  if (false) results.push(" },
  { id: "E72", desc: "--json でも profile の行を標準出力に出す", expect: "--json の標準出力は JSON だけ",
    find: "if (o.json) console.error(mask(`profile: ${profilePath()}`));\n    else out(`profile: ${profilePath()}`);", to: "out(`profile: ${profilePath()}`);" },
  { id: "E73", desc: "exclude の glob 記号を逃がさない", expect: "glob 記号を逃がして",
    find: "p.replace(/[[\\]*?!#\\\\]/g, '\\\\$&')", to: "p" },
  // ---- Codex クロスチェック（計画・コード）の指摘に対する防御
  { id: "E80", desc: "非正規のパス表記（./ や //）を受け付ける", expect: "別の書き方のパスで秘密ファイルを指せない",
    find: "x === '' || x === '.' || x === '..'", to: "x === '..'" },
  { id: "E81", desc: "管理ファイルをセットに含めても拒否しない", expect: "管理ファイルを含むセット・重なるセットは拒否",
    find: "...(configJson ? [configJson.path] : []), MANIFEST, LOCK].map(key);", to: "...(configJson ? [configJson.path] : [])].map(key);" },
  { id: "E82", desc: "重なるセットを拒否しない", expect: "管理ファイルを含むセット・重なるセットは拒否",
    find: "if (a.name !== b.name && (a.base === b.base || a.base.startsWith(b.base + '/'))) {", to: "if (false) {" },
  { id: "E83", desc: "正本の祖先のリンクを見ない", expect: "正本の祖先のリンクを追従しない",
    find: "if (link) { warnings.push(`正本のリンクは複製しない: ${link}`); continue; }", to: "" },
  { id: "E84", desc: "管理ファイルの置き場所のリンクを見ない", expect: "管理ファイルの置き場所がリンクなら書かない",
    find: "if (ctlLink) throw new ConfigError(", to: "if (false) throw new ConfigError(" },
  { id: "E85", desc: "別の正本の記録をそのまま使う", expect: "別の正本の記録は使わない",
    find: "if (source && m.source !== canonAbs(source)) return", to: "if (false) return" },
  { id: "E86", desc: "書き込み予定の記録を判定に使わない", expect: "書いた直後に止まっても",
    find: "if (ent && ent.pending && it.tgtHash === ent.pending) it.rec = ent.pending;", to: "" },
  { id: "E87", desc: "計画ID が違っても適用する", expect: "計画ID が違えば適用しない",
    find: "if (opts.expect && opts.expect !== plan.id) {", to: "if (false) {" },
  { id: "E88", desc: "CLI の apply で --expect を求めない", expect: "計画ID が違えば適用しない",
    find: "if (!o.expect) throw new ConfigError('apply には", to: "if (false) throw new ConfigError('apply には" },
  { id: "E89", desc: "計画の後に変わった正本を書く", expect: "計画の後に正本が変わったら書かない",
    find: "if (bufHash !== it.srcHash) throw", to: "if (false) throw" },
  { id: "E90", desc: "計画の後に変わった対象を上書きする", expect: "計画の後に対象が変わったら上書きしない",
    find: "if (['copy', 'update', 'take', 'prune'].includes(it.action)) unchanged(it);", to: "" },
  { id: "E91", desc: "手元で消した管理済みファイルを書き戻す", expect: "手元で消した管理済みファイルは書き戻さない",
    find: "if (tgt === null && rec) return { state: 'deleted', action: take ? 'copy' : null };", to: "" },
  { id: "E92", desc: "正本の列挙が不完全でも --prune する", expect: "正本の列挙に警告があれば --prune しない",
    find: "action: prune && canPrune ? 'prune' : null", to: "action: prune ? 'prune' : null" },
  { id: "E93", desc: "取り込み済みの --take-source を再実行で拒否する", expect: "途中で止まった取り込みを同じ引数で再開できる",
    find: " || it.state === 'same').map", to: ").map" },
  { id: "E94", desc: "exclude が効かなくても複製する", expect: "exclude が効かなければ複製しない",
    find: "if (notEffective.length) throw", to: "if (false) throw" },
  { id: "E95", desc: "codex doctor の検査0件を受け付ける", expect: "codex doctor の空の結果・非0終了を ok にしない",
    find: "if (!checks.length) throw new Error('codex doctor --json の検査が0件');", to: "" },
  { id: "E96", desc: "codex doctor の非0終了を見ない", expect: "codex doctor の空の結果・非0終了を ok にしない",
    find: "if (r.code !== 0 || ['error', 'fail'].includes(o.overallStatus)) st = 'fail';", to: "if (['error', 'fail'].includes(o.overallStatus)) st = 'fail';" },
  { id: "E97", desc: "https でない SonarQube にも接続する", expect: "https でない SonarQube には接続しない",
    find: "if (!/^https:\\/\\//i.test(base)) return", to: "if (false) return" },
  { id: "E98", desc: "点検の登録を1つ外す（VS Code）", expect: "期待する点検がすべて実施される",
    find: "  if (profile.vscode) {\n    await runCheck(results, 'target', 'VS Code のデバッグ設定'", to: "  if (false) {\n    await runCheck(results, 'target', 'VS Code のデバッグ設定'" },
  // ---- Backlog の API キーの送り先（キーを Backlog の公式の https の送り先にだけ送る）
  { id: 'E104', desc: '送る前の送り先の検査を外す', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (why) return { ok: false, code: null, err: 'destination_refused', why };", to: "if (false) return { ok: false, code: null, err: 'destination_refused', why };" },
  { id: 'E105', desc: '公式ドメインを完全一致でなく末尾の一致で判定する', expect: '公式の Backlog 以外へはキーを送らない',
    find: "return !!m && BACKLOG_SUFFIXES.includes(m[2]) && !m[1].startsWith('xn--');", to: "return !!m && BACKLOG_SUFFIXES.some((x) => m[2].endsWith(x)) && !m[1].startsWith('xn--');" },
  { id: 'E106', desc: '国際化ドメインのスペースを拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: " && !m[1].startsWith('xn--');", to: ';' },
  { id: 'E107', desc: 'https でない送り先を拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (u.protocol !== 'https:') return 'https ではない';", to: '' },
  { id: 'E108', desc: 'URL の認証情報を拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (u.username || u.password) return 'URL に認証情報が含まれる';", to: '' },
  { id: 'E109', desc: '既定以外のポートを拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (u.port !== '') return '既定以外のポート';", to: '' },
  { id: 'E110', desc: 'クエリ・フラグメント付きの URL を拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (u.search || u.hash) return 'URL にクエリかフラグメントが含まれる';", to: '' },
  { id: 'E111', desc: 'API 以外のパスを拒否しない', expect: '公式の Backlog 以外へはキーを送らない',
    find: "if (!u.pathname.startsWith('/api/v2/')) return 'API のパスではない';", to: '' },
  { id: 'E112', desc: '通信の子プロセスへ環境を丸ごと渡す', expect: 'NODE_OPTIONS やプロキシの変数を渡さない',
    find: "  for (const k of CHILD_ENV_KEYS) if (process.env[k] !== undefined) e[k] = process.env[k];\n  return { ...e, ...extra };", to: "  return { ...process.env, ...extra };" },
  { id: 'E113', desc: 'リダイレクトをたどる', expect: 'リダイレクトをたどらない',
    find: "fetch(u, { signal: ac.signal, redirect: 'manual' })", to: "fetch(u, { signal: ac.signal, redirect: 'follow' })" },
  { id: 'E115', desc: 'キーを profile の変数名のまま子の環境に入れる', expect: 'キーの変数名が NODE_OPTIONS などでも',
    find: "  const keyVar = keyEnv ? { UT_ENV_API_KEY: process.env[keyEnv] || '', UT_ENV_HAS_KEY: '1' } : {};", to: "  const keyVar = keyEnv ? { [keyEnv]: process.env[keyEnv] || '', UT_ENV_API_KEY: process.env[keyEnv] || '', UT_ENV_HAS_KEY: '1' } : {};" },
  { id: 'E116', desc: 'backlog.env に起動に使う変数の名前を許す', expect: '起動に使う変数・内部の変数の名前を使わせない',
    find: "    if (CHILD_ENV_KEYS.some((k) => k.toLowerCase() === b.env.toLowerCase()) || /^UT_ENV_/i.test(b.env)) throw new ConfigError(", to: "    if (false) throw new ConfigError(" },
  { id: 'E117', desc: 'git を相対パスの場所からも探す', expect: '作業フォルダ・相対パスの場所の git を選ばない',
    find: '    if (!d || !path.isAbsolute(d)) continue;', to: '    if (!d) continue;' },
  { id: 'E118', desc: 'git の設定を通じた外部コマンドの起動を止めない', expect: '対象のツリーの設定（fsmonitor・hook）から外部コマンドを起動しない',
    find: "export const GIT_GUARD = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];", to: 'export const GIT_GUARD = [];' },
  { id: 'E119', desc: '計画の後の書き換えの差し込みを環境変数でも効かせる', expect: '試験用の差し込みは環境変数では効かない',
    find: '    const mutateTarget = testHooks.mutateTarget;', to: "    const mutateTarget = testHooks.mutateTarget || process.env.UT_ENV_MUTATE_TARGET || '';" },
  { id: 'E120', desc: '外部コマンドのスタブを環境変数でも差し替えられる', expect: '試験用の差し込みは環境変数では効かない',
    find: '  const stub = testHooks.cmdStubs[name.toLowerCase()];', to: '  const stub = testHooks.cmdStubs[name.toLowerCase()] || process.env[`UT_ENV_CMD_${name.toUpperCase()}`];' },
  { id: 'E121', desc: 'New Relic のリージョンを存在確認なしで通す（__proto__ などが通る）', expect: 'リージョンは us / eu だけ',
    find: "  if (!Object.hasOwn(NERDGRAPH_HOSTS, region)) return { ok: false, code: null, err: 'destination_refused'", to: "  if (false) return { ok: false, code: null, err: 'destination_refused'" },
  { id: 'E122', desc: 'New Relic の応答の errors を見ずに HTTP 200 を成功とする', expect: 'HTTP 200 でも errors があれば',
    find: "code2 < 300 && !gqlErrors && accounts !== null && accounts > 0", to: "code2 < 300 && accounts !== null && accounts > 0" },
  { id: 'E123', desc: 'New Relic のアカウントが 0 件でも成功とする', expect: 'HTTP 200 でも errors があれば',
    find: "code2 < 300 && !gqlErrors && accounts !== null && accounts > 0", to: "code2 < 300 && !gqlErrors" },
  { id: 'E124', desc: 'New Relic のキーを URL のクエリに付ける', expect: 'キーは固定のホストへ POST し',
    find: "env: childEnv({ UT_ENV_API_KEY: process.env[keyEnv] || '', UT_ENV_URL: url }),", to: "env: childEnv({ UT_ENV_API_KEY: process.env[keyEnv] || '', UT_ENV_URL: url + '?apiKey=' + (process.env[keyEnv] || '') }),", },
  { id: 'E125', desc: 'newrelic.env に起動に使う変数の名前を許す', expect: '起動に使う変数・内部の変数の名前を使わせない',
    find: "    if (CHILD_ENV_KEYS.some((k) => k.toLowerCase() === n.env.toLowerCase()) || /^UT_ENV_/i.test(n.env)) throw new ConfigError(", to: "    if (false) throw new ConfigError(" },
  { id: 'E126', desc: 'New Relic の点検名を期待する点検から外す', expect: '点検名の登録漏れが無い',
    find: "    e.push('New Relic API（NerdGraph）');", to: "" },
  { id: 'E141', desc: '前回との差で、状態が変わった点検を数えない', expect: '前回の結果との差を出す',
    find: "else if (last.checks.get(k) !== v) changes.push(", to: "else if (false) changes.push(" },
  { id: 'E142', desc: '前回にあって今回は消えた点検を無視する', expect: '前回の結果との差を出す',
    find: "for (const [k, v] of last.checks) if (!now.has(k)) changes.push(", to: "for (const [k, v] of []) if (!now.has(k)) changes.push(" },
  { id: 'E143', desc: '壊れた前回の記録を「記録なし」として黙って扱う', expect: '前回の結果との差を出す',
    find: "  } catch { return { state: 'broken' }; }", to: "  } catch { return { state: 'none' }; }" },
  { id: 'E145', desc: '前回の記録に点検の結果（メッセージ）まで残す', expect: '前回の結果との差を出す',
    find: "JSON.stringify({ at: new Date().toISOString(), online, checks }, null, 2)", to: "JSON.stringify({ at: new Date().toISOString(), online, checks, results: d.results }, null, 2)" },
  { id: 'E146', desc: '前回の記録を保存できなかったことを黙って成功にする', expect: '前回の結果との差を出す',
    find: "  } catch (e) { return String(e && e.code || 'error'); }", to: "  } catch (e) { return null; }" },
  { id: 'E147', desc: '前回の記録を対象ツリーごとに分けない', expect: '前回の結果との差を出す',
    find: "const scope = target ? 'tree-'", to: "const scope = false ? 'tree-'" },
  { id: 'E148', desc: '--online の有無が違うことを添えない', expect: '前回の結果との差を出す',
    find: "if (df.lastOnline !== df.online) L.push(", to: "if (false) L.push(" },
  { id: 'E149', desc: '確かめていない（unknown）点検にも依頼を出す', expect: '頼む一覧は fail・warn の点検',
    find: "(r.status === 'fail' || r.status === 'warn'));", to: "r.status !== 'ok');" },
  { id: 'E150', desc: 'warn の点検には依頼を出さない', expect: '頼む一覧は fail・warn の点検',
    find: "(r.status === 'fail' || r.status === 'warn'));", to: "r.status === 'fail');" },
  { id: 'E151', desc: 'requests が指す点検名の実在を確かめない', expect: '頼む一覧は fail・warn の点検',
    find: "requests.forEach((r, i) => { for (const c of r.checks) if (!known.has(c)) throw", to: "requests.forEach((r, i) => { for (const c of r.checks) if (false) throw" },
  { id: 'E152', desc: 'priorities が指す点検名の実在を確かめない', expect: '頼む一覧は fail・warn の点検',
    find: "for (const k of Object.keys(priorities)) if (!known.has(k)) throw", to: "for (const k of Object.keys(priorities)) if (false) throw" },
  { id: 'E153', desc: 'requests の checks が空でも受け付ける', expect: '頼む一覧は fail・warn の点検',
    find: "if (!checks.length) throw new ConfigError(`profile の requests[", to: "if (false) throw new ConfigError(`profile の requests[" },
  { id: 'E154', desc: '依頼文の長さの上限を見ない', expect: '頼む一覧は fail・warn の点検',
    find: " || v.length > 500 || /[", to: " || /[" },
  { id: 'E155', desc: 'priorities を原型のある入れ物にする（__proto__ が黙って捨てられる）', expect: '優先度は点検名から決まり',
    find: "const priorities = Object.create(null);", to: "const priorities = {};" },
  { id: 'E156', desc: 'requests の項目の制御文字（改行）を許す', expect: '頼む一覧は fail・warn の点検',
    find: "|| /[\\u0000-\\u001f\\u007f]/.test(v)) throw new ConfigError(`profile の requests[", to: ") throw new ConfigError(`profile の requests[" },
  { id: 'E157', desc: '前回の記録の種別・大きさを見ずに読む', expect: '前回の結果との差を出す',
    find: "if (!st.isFile() || st.size > LAST_MAX_BYTES) throw new Error('種別・大きさ');", to: "" },
  { id: 'E158', desc: '前回の記録の online が真偽値でなくても受け付ける', expect: '前回の結果との差を出す',
    find: " || typeof o.online !== 'boolean') throw new Error('形式');", to: ") throw new Error('形式');" },
  { id: 'E159', desc: '前回の記録の at が日時の形でなくても受け付ける', expect: '前回の結果との差を出す',
    find: " || !/^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z$/.test(o.at)", to: "" },
  { id: 'E160', desc: '前回の記録の点検数に上限を設けない', expect: '前回の結果との差を出す',
    find: " || Object.keys(o.checks).length > LAST_MAX_CHECKS", to: "" },
  { id: 'E161', desc: '前回の記録の点検名の長さ・制御文字を見ない', expect: '前回の結果との差を出す',
    find: " || k.length > LAST_MAX_NAME || /[\\u0000-\\u001f\\u007f]/.test(k)", to: "" },
  { id: 'E162', desc: '同名の点検の状態を実行順のまま比べる（並べ替えない）', expect: '前回の結果との差を出す',
    find: "[k, v.sort().join(',')]", to: "[k, v.join(',')]" },
  { id: 'E163', desc: 'unknown があれば終了コードを 1 にする', expect: '終了コードは fail だけが 1',
    find: "return d.totals.fail ? 1 : 0;", to: "return d.totals.fail || d.totals.unknown ? 1 : 0;" },
  { id: 'E164', desc: '前回の記録の状態値を、文字列なら何でも受け付ける', expect: '前回の結果との差を出す',
    find: "const validStatus = (v) => typeof v === 'string' && v.split(',').every((x) => STATUSES.includes(x));", to: "const validStatus = (v) => typeof v === 'string';" },
  { id: 'E133', desc: '--online なしで通信しない点検を結果から消す（unknown で残さない）', expect: '通信する点検を --online なしで省いたときは unknown',
    find: "if (!online) results.push(notRun('New Relic API（NerdGraph）'));", to: "if (!online) { /* 何も残さない */ }" },
  { id: 'E134', desc: '未実施の点検を ok として残す', expect: '通信する点検を --online なしで省いたときは unknown',
    find: "status: 'unknown', message: '--online を付けていない", to: "status: 'ok', message: '--online を付けていない" },
  { id: 'E135', desc: 'unknown を合計から数えない', expect: '総数 = ok + warn + fail',
    find: "    totals[r.status]++;\n    byPriority", to: "    if (r.status !== 'unknown') totals[r.status]++;\n    byPriority" },
  { id: 'E136', desc: 'A に unknown があっても完了とする', expect: '優先度は点検名から決まり',
    find: "a.warn + a.fail + a.unknown === 0;", to: "a.warn + a.fail === 0;" },
  { id: 'E137', desc: 'A が 0 件でも完了とする', expect: '優先度は点検名から決まり',
    find: "const setupComplete = a.ok > 0 && ", to: "const setupComplete = " },
  { id: 'E138', desc: 'profile の priorities の値を検査しない', expect: '優先度は点検名から決まり',
    find: "if (!k || !['A', 'B', 'C'].includes(v)) throw", to: "if (false) throw" },
  { id: 'E139', desc: 'profile の priorities による上書きを効かせない', expect: '優先度は点検名から決まり',
    find: "if (overrides && Object.hasOwn(overrides, check)) return overrides[check];", to: "" },
  { id: 'E140', desc: '環境変数の優先度を B にする', expect: '優先度は点検名から決まり',
    find: "['A', /^(環境変数 |", to: "['B', /^(環境変数 |" },
  { id: 'E127', desc: '子が返した件数の型を確かめずに使う', expect: '子の出力はキーや想定外の値を信用しない',
    find: "const accounts = Number.isSafeInteger(o.accounts) && o.accounts >= 0 && o.accounts <= 0xffffffff ? o.accounts : null;", to: "const accounts = o.accounts === undefined ? null : o.accounts;" },
  { id: 'E128', desc: 'errors を配列のときだけ失敗とする（オブジェクト・文字列は成功扱い）', expect: '応答本文の判定は errors が「ある」だけで失敗にする',
    find: "Object.hasOwn(j, 'errors') && j.errors !== null && !(Array.isArray(j.errors) && j.errors.length === 0);", to: "Array.isArray(j.errors) && j.errors.length > 0;" },
  { id: 'E129', desc: '子の出力の gqlErrors の欠落・型違いを「errors なし」と読む', expect: 'HTTP 200 でも errors があれば',
    find: "const shapeOk = code2 === null || (typeof o.gqlErrors === 'boolean' && typeof o.json === 'boolean');", to: "const shapeOk = true;" },
  { id: 'E130', desc: '子の err を文字種だけで信用する', expect: '子の出力はキーや想定外の値を信用しない',
    find: "typeof o.err === 'string' && NERDGRAPH_KNOWN_ERRORS.has(o.err) ? o.err : 'Error';", to: "typeof o.err === 'string' && /^[A-Za-z_]+$/.test(o.err) ? o.err : 'Error';" },
  { id: 'E131', desc: '件数・ステータスの範囲を見ない（巨大な数を通す）', expect: 'HTTP 200 でも errors があれば',
    find: "const accounts = Number.isSafeInteger(o.accounts) && o.accounts >= 0 && o.accounts <= 0xffffffff ? o.accounts : null;", to: "const accounts = Number.isInteger(o.accounts) && o.accounts >= 0 ? o.accounts : null;" },
  { id: 'E132', desc: 'JSON でない本文を成功の判定に含めない', expect: 'HTTP 200 でも errors があれば',
    find: "return { ok: shapeOk && jsonOk && code2 !== null", to: "return { ok: shapeOk && code2 !== null" },
  { id: 'E114', desc: 'profile の backlog.space を形だけで受け付ける', expect: 'profile の backlog.space は公式ドメインの形だけを受け付ける',
    find: "space: typeof b.space === 'string' && isBacklogHost(b.space) ? b.space.toLowerCase() : null,", to: "space: typeof b.space === 'string' && /^[A-Za-z0-9.-]+$/.test(b.space) ? b.space.toLowerCase() : null," },
  { id: "E99", desc: "点検漏れの報告を止め、点検の登録も1つ外す", expect: "期待する点検がすべて実施される",
    find: "  if (missing.length) results.push(", to: "  if (false) results.push(",
    also: ["  if (profile.vscode) {\n    await runCheck(results, 'target', 'VS Code のデバッグ設定'","  if (false) {\n    await runCheck(results, 'target', 'VS Code のデバッグ設定'"] },
  { id: "E100", desc: "追跡済みの秘密ファイルを fail にしない", expect: "追跡済みの秘密ファイルは fail",
    find: "if (gitOk(top, ['ls-files', '--error-unmatch', '--', sf]) === 0) return", to: "if (false) return" },
  { id: "E101", desc: "必須ファイルを点検しない", expect: "必須ファイルが無ければ fail",
    find: "for (const req of profile.required) {", to: "for (const req of []) {" },
  { id: "E102", desc: "正本の件数でなく記録由来の件数で0件を判定する", expect: "正本が空でも記録があれば fail",
    find: "if (!plan.sourceCounts[s]) return { status: 'fail'", to: "if (!its.length) return { status: 'fail'" },
  { id: "E103", desc: "profile の解析エラーの文言（断片入り）をそのまま出す", expect: "JSON の解析エラーで入力の断片を出さない",
    find: "try { p = JSON.parse(raw); } catch { throw new ConfigError('profile を JSON として読めない（位置は JSON の検査ツールで確かめる）'); }", to: "try { p = JSON.parse(raw); } catch (e) { throw new ConfigError(e.message); }" },
];

// 変異の ID が重なると、部分実行（UT_SWEEP_ONLY）で両方が流れ、内訳の行も区別できない。重なっていたら何もせずに止める
{ const ids = mutations.map((m) => m.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) { console.log('変異の ID が重なっている: ' + [...new Set(dup)].join(',')); process.exit(1); } }

function runSelftest(file) {
  return new Promise((resolve) => {
    // 並列で回すと1件の selftest が5分を超えることがあるため、上限は長めにとる（打ち切りは CRASHED として数える）
    // 変異の写しは一時フォルダで動くため、自己テストが読む例・文書の場所（このリポジトリ）を渡す
    execFile(process.execPath, [file, '--selftest'], { encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, UT_ENV_TEST_REPO: process.cwd() } }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const names = (out.match(/^NG {2}.*$/gm) || []).map((x) => x.replace(/^NG {2}/, '').split(' — ')[0]);
      const total = Number((/selftest: (\d+) 件中/.exec(out) || [])[1] || 0);
      resolve({ out, code, names, total });
    });
  });
}

async function runMutant(m) {
  const hits = SRC.split(m.find).length - 1;
  if (hits !== 1) return { ...m, verdict: 'INVALID', detail: 'アンカー一致 ' + hits + ' 件' };
  const f = path.join(tmp, m.id + '.mjs');
  let src = SRC.replace(m.find, () => m.to);
  if (m.also) {
    if (src.split(m.also[0]).length - 1 !== 1) return { ...m, verdict: 'INVALID', detail: '追加アンカー不一致' };
    src = src.replace(m.also[0], () => m.also[1]);
  }
  fs.writeFileSync(f, src);
  const r = await runSelftest(f);
  if (r.names.length === 0 && r.code !== 0) {
    return { ...m, verdict: 'CRASHED', detail: '異常終了(exit=' + r.code + ') ' + r.out.split(NL).filter(Boolean).slice(-2).join(' / ') };
  }
  const hit = r.names.some((n) => n.includes(m.expect));
  const verdict = hit ? 'CAUGHT' : r.names.length ? 'OTHER' : 'MISSED';
  return { ...m, verdict, detail: 'NG ' + r.names.length + ' 件', ngNames: r.names };
}

if (process.env.UT_SWEEP_CHECK_ANCHORS) {
  const bad = mutations.filter((m) => SRC.split(m.find).length - 1 !== 1 || (m.also && SRC.split(m.also[0]).length - 1 !== 1));
  for (const m of bad) console.log('  INVALID ' + m.id + ' ' + m.desc + ' (一致 ' + (SRC.split(m.find).length - 1) + ' 件)');
  console.log('差し込み位置の確認: ' + (mutations.length - bad.length) + ' / ' + mutations.length + ' 件が有効');
  process.exit(bad.length ? 1 : 0);
}
const base = await runSelftest(SRC_PATH);
if (base.code !== 0 || base.names.length) {
  console.log('基準実行（変異なし）の selftest が失敗しているため掃引しない: ' + (base.names.join(' / ') || 'exit=' + base.code));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  process.exit(1);
}
console.log('基準実行: selftest ' + base.total + ' 件全件パス');

const only = process.env.UT_SWEEP_ONLY ? new Set(process.env.UT_SWEEP_ONLY.split(',').map((x) => x.trim())) : null;
if (only) {
  console.log('部分実行: ' + [...only].join(',') + '（全件の判定ではない）');
  const unknown = [...only].filter((id) => !mutations.some((m) => m.id === id));
  if (unknown.length) { console.log('存在しない変異 ID: ' + unknown.join(',')); process.exit(1); }
}
const rows = [];
const queue = mutations.filter((m) => !only || only.has(m.id));
// 変異1件ごとに selftest を丸ごと回すため時間がかかる。UT_SWEEP_JOBS で並列数を変えられる（既定 8、CPU 数が上限）
const jobs = Math.max(1, Math.min(Number(process.env.UT_SWEEP_JOBS) || 8, os.cpus().length));
const workers = Array.from({ length: jobs }, async () => {
  while (queue.length) { const m = queue.shift(); rows.push(await runMutant(m)); }
});
await Promise.all(workers);
rows.sort((a, b) => a.id.localeCompare(b.id));

console.log('== ut-env ミューテーション掃引 内訳 ==');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(5) + r.verdict.padEnd(8) + r.desc + '  -> ' + r.detail);
  for (const n of (r.ngNames || [])) console.log('          落ちた: ' + n + (n.includes(r.expect) ? '  ← 期待' : ''));
}
const by = (v) => rows.filter((r) => r.verdict === v);
console.log(NL + '検出 ' + by('CAUGHT').length + ' / ' + rows.length + '   未検出 ' + by('MISSED').length + '   別理由で検出 ' + by('OTHER').length +
  '   異常終了 ' + by('CRASHED').length + '   設計不正 ' + by('INVALID').length);
for (const v of ['MISSED', 'OTHER', 'CRASHED', 'INVALID']) {
  if (by(v).length) console.log(v + ': ' + by(v).map((r) => r.id + ' ' + r.desc + (v === 'OTHER' ? '（期待: ' + r.expect + '）' : ' ' + r.detail)).join(' / '));
}
console.log('対象外（2重の防御の片方だけを外す変異。もう片方が先に効くため差が出ない）:');
console.log('  - apply 冒頭の「正本自身は拒否」だけを外す（apply 内の planTree が同じ判定で拒否する）');
console.log('  - 複製時のリンク確認だけを外す（計画でリンクと判定され、操作が割り当てられない）。両方を外す変異は E11');
console.log('  - 書き込み後・退避後のハッシュ照合（ディスクの異常でしか差が出ず、selftest で決定的に起こせない）');
console.log('  - doctor の最後のマスクだけを外す（点検が必要な欄だけを取り出しているため、マスクに頼る値が無い）。両方を外す変異は E52');
console.log('  - exclude を書く直前の読み直しと、exclude 自体のロック（2つの worktree へ同時に apply したときの競合でしか差が出ず、再現が非決定的）');
console.log('  - 時間切れのとき cmd.exe の先の子プロセスが残る点（既知の限界。防御を置いていない）');
console.log('  - git check-ignore が 0/1 以外で終わったときの停止（git の異常終了を selftest で決定的に起こせない）');
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(by('CAUGHT').length === rows.length ? 0 : 1);
