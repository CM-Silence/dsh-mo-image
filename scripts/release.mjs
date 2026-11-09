#!/usr/bin/env node
/**
 * 发版脚本：bump 版本 → 跑测试 → commit → tag → push → 建 GitHub Release。
 *
 * 版本号的唯一事实来源是 tag；更新检查读的就是 Release，所以 tag 与
 * package.json 必须一致，脚本负责保证这一点。
 *
 * Usage:
 *   npm run release -- patch            # 0.3.1 → 0.3.2
 *   npm run release -- minor            # 0.3.1 → 0.4.0
 *   npm run release -- 0.5.0            # 指定版本
 *   npm run release -- minor --dry-run  # 只打印要做的事
 *   npm run release -- minor --notes-file notes.md
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions, isHiddenPrerelease } from '../lib/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const REPO = 'CM-Silence/dsh-mo-image';
// 允许明确指定 vX.Y.Z / vX.Y.Z-a1 / vX.Y.Z-b2 / vX.Y.Z-rc1（示例里的版本样式）。
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-((?:a|b|rc)\d+))?$/;
const BRANCH = 'master';

/**
 * 解析命令行。
 * @param {string[]} argv
 * @returns {{kind: string, dryRun: boolean, notes: string, notesFile: string, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { kind: '', dryRun: false, notes: '', notesFile: '', help: false, releaseOnly: false, publish: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--release-only') out.releaseOnly = true;
    else if (arg === '--publish') out.publish = true;
    else if (arg === '--notes') { out.notes = String(argv[i + 1] || ''); i += 1; }
    else if (arg === '--notes-file') { out.notesFile = String(argv[i + 1] || ''); i += 1; }
    else if (arg === '--help' || arg === '-h') out.help = true;
    else rest.push(arg);
  }
  out.kind = rest[0] || '';
  return out;
}

/**
 * npm 的 dist-tag：预发布发到 next，正式版才顶掉 latest，
 * 免得 `npm i dsh-mo-image` 的人装到 rc。
 * @param {string} version
 * @returns {'next'|'latest'}
 */
export function distTag(version) {
  return /-(?:a|b|rc)\d+$/i.test(String(version || '')) ? 'next' : 'latest';
}

/**
 * 算下一个版本号。
 * @param {string} current 当前版本
 * @param {string} kind patch|minor|major 或一个明确的新版本
 * @returns {string}
 */
export function nextVersion(current, kind) {
  const match = SEMVER.exec(String(current || ''));
  if (!match) throw new Error(`current version is not semver: ${current}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  const explicit = SEMVER.exec(String(kind || ''));
  if (explicit) {
    const normalized = `${explicit[1]}.${explicit[2]}.${explicit[3]}${explicit[4] ? '-' + explicit[4] : ''}`;
    if (compareVersions(normalized, current) !== 1) throw new Error(`${normalized} is not newer than ${current}`);
    return normalized;
  }
  throw new Error(`unknown release kind: ${kind}`);
}

const GROUPS = [
  ['feat', '新功能'],
  ['fix', '修复'],
  ['docs', '文档'],
  ['chore', '其他']
];
const OTHER = '其他';

/**
 * 把提交标题按类型分组，生成 Release 正文。
 * @param {{type: string, text: string}[]} commits
 * @returns {string}
 */
export function renderNotes(commits) {
  const buckets = new Map(GROUPS.map(([, title]) => [title, []]));
  for (const commit of commits) {
    // 发版提交本身是噪音，不写进说明；其他 chore 归到「其他」。
    if (commit.type === 'chore' && /^release\b/i.test(String(commit.text || '').trim())) continue;
    const title = (GROUPS.find(([type]) => type === commit.type) || [null, OTHER])[1];
    if (!buckets.has(title)) buckets.set(title, []);
    buckets.get(title).push(commit.text);
  }
  const lines = [];
  for (const [, title] of GROUPS) {
    const items = buckets.get(title) || [];
    if (items.length === 0) continue;
    lines.push(`### ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** 把 `git log --pretty=%s` 的一行拆成 {type, text}。 */
export function parseCommit(subject) {
  const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(String(subject || '').trim());
  if (!match) return { type: '', text: String(subject || '').trim() };
  return { type: match[1], text: match[2] };
}

/**
 * 发版要执行的 git 步骤（测试与 package.json 写入在 main 里单独做）。
 * 每条命令的 argv 都是分开的数组，不经过 shell，带空格的 -m 不会被拆开。
 * @param {string} version
 * @returns {{command: string, args: string[]}[]}
 */
export function releasePlan(version) {
  const tag = `v${version}`;
  return [
    { command: 'git', args: ['add', 'package.json', 'CHANGELOG.md'] },
    { command: 'git', args: ['commit', '-m', `chore(release): ${tag}`] },
    { command: 'git', args: ['tag', '-a', tag, '-m', tag] },
    { command: 'git', args: ['push'] },
    { command: 'git', args: ['push', '--tags'] }
  ];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: options.env || process.env
  });
  // 命令不存在（ENOENT）时 spawnSync 会把 error 填上而 status 为 null；这里不抛，
  // 交给调用方判断——没有 gh 是常态，不该让发版直接崩掉。
  return result;
}

function capture(command, args) {
  const result = run(command, args, { capture: true });
  return !result.error && result.status === 0 ? String(result.stdout || '').trim() : '';
}

/** 某个命令在不在 PATH 上；不存在时返回 false，不抛异常。 */
export function commandAvailable(name) {
  const result = run(name, ['--version'], { capture: true });
  return !result.error && result.status === 0;
}

// gh 装在 PATH 之外是常态（尤其是刚装完、宿主进程还拿着旧 PATH 的时候）。
const GH_FALLBACKS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'GitHub CLI', 'gh.exe')
];

/**
 * 找到可用的 gh 可执行文件（PATH 上没有就试常见安装位置）。
 * @returns {string} 可用时返回命令或绝对路径，找不到返回空串
 */
export function resolveGh() {
  if (commandAvailable('gh')) return 'gh';
  for (const candidate of GH_FALLBACKS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 装了且已登录才返回可用的 gh；只装了没登录时返回空串，让调用方退回 token / 手动。
 * @returns {string}
 */
function ghReady() {
  const gh = resolveGh();
  if (!gh) return '';
  const status = run(gh, ['auth', 'status'], { capture: true });
  return !status.error && status.status === 0 ? gh : '';
}

function hasGhInstalled() {
  return resolveGh() !== '';
}

function readVersion() {
  return JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;
}

function lastTag() {
  return capture('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
}

function collectCommits(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : '-30';
  const log = capture('git', ['log', range, '--pretty=%s']);
  return log.split('\n').map((line) => line.trim()).filter(Boolean).map(parseCommit);
}

/** 用 token 走 REST API 建 Release：脚本写到临时文件再执行，避免命令行引号问题。 */
function createReleaseWithToken(tag, notes, prerelease) {
  const dir = os.tmpdir();
  const payload = path.join(dir, `dsh-release-${Date.now()}.json`);
  const script = path.join(dir, `dsh-release-${Date.now()}.mjs`);
  writeFileSync(payload, JSON.stringify({ tag_name: tag, name: tag, body: notes, prerelease: !!prerelease }), 'utf8');
  writeFileSync(script, [
    "import { readFileSync } from 'node:fs';",
    'const [file] = process.argv.slice(2);',
    `const token = String(process.env.GITHUB_TOKEN || '').trim();`,
    `const body = readFileSync(file, 'utf8');`,
    `const response = await fetch('https://api.github.com/repos/${REPO}/releases', {`,
    "  method: 'POST',",
    "  headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json' },",
    '  body',
    '});',
    'if (!response.ok) { console.error(await response.text()); process.exit(1); }',
    'console.log(response.status);'
  ].join('\n'), 'utf8');
  try {
    return run(process.execPath, [script, payload]).status === 0;
  } finally {
    for (const file of [payload, script]) {
      try { rmSync(file, { force: true }); } catch (_error) { /* 临时文件删不掉不影响发布 */ }
    }
  }
}

/**
 * 建 Release。返回是否成功；没有凭据时打印手动步骤并返回 false。
 * @param {string} version
 * @param {string} notes
 * @returns {boolean}
 */
export function createRelease(version, notes, options = {}) {
  const tag = `v${version}`;
  // alpha / beta 标成 prerelease：GitHub 的 /releases/latest 会跳过它，
  // 已装用户也就不会收到更新提示。rc 照常发布。
  const prerelease = isHiddenPrerelease(version);
  if (options.dryRun) return true;
  const file = path.join(os.tmpdir(), `dsh-mo-image-${tag}.md`);
  writeFileSync(file, notes + '\n', 'utf8');
  try {
    const gh = ghReady();
    if (gh) {
      const args = ['release', 'create', tag, '--title', tag, '--notes-file', file];
      if (prerelease) args.push('--prerelease');
      return run(gh, args).status === 0;
    }
    if (String(process.env.GITHUB_TOKEN || '').trim()) return createReleaseWithToken(tag, notes, prerelease);
    const hint = prerelease ? '\n（这是 alpha/beta，记得在页面上勾选 "Set as a pre-release"）' : '';
    console.log(`\ntag ${tag} 已经推送，但没找到可用的 GitHub 凭据。${hint}`);
    if (hasGhInstalled()) console.log('检测到 gh 已安装但没登录：先在终端跑 gh auth login，再执行下面的补建命令。');
    console.log(`打开这个地址，正文粘贴下面的内容，点 Create release：`);
    console.log(`  https://github.com/${REPO}/releases/new?tag=${tag}&title=${tag}\n`);
    console.log('----- 正文开始 -----');
    console.log(notes);
    console.log('----- 正文结束 -----\n');
    if (hasGhInstalled()) {
      console.log('补建命令（先在终端 gh auth login）：');
    } else {
      console.log('装好 gh（winget install GitHub.cli）或设置 GITHUB_TOKEN 后，也可以跑：');
    }
    console.log(`  node scripts/release.mjs --release-only --notes-file <上面那份 md>\n`);
    return false;
  } finally {
    try { rmSync(file, { force: true }); } catch (_error) { /* 同上 */ }
  }
}

/**
 * 默认更新日志：docs/superpowers/updatelogs/v<version>.md（与 push.js 的约定一致）。
 * @param {string} version
 * @returns {string}
 */
function defaultNotesFile(version) {
  const candidate = path.join(ROOT, 'docs', 'superpowers', 'updatelogs', `v${version}.md`);
  return existsSync(candidate) ? candidate : '';
}

/**
 * 只补建 Release：tag 已经推上去、但 GitHub 上没有对应 Release 时用。
 * 缺凭据时和完整发版一样，打印手动步骤并返回失败。
 * @returns {number} 退出码
 */
function releaseOnly(args) {
  const version = readVersion();
  const tag = `v${version}`;
  if (!capture('git', ['tag', '--list', tag])) {
    console.error(`tag ${tag} 不存在；先跑一次完整发版，或手动打 tag`);
    return 1;
  }
  const previous = capture('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`]);
  const autoFile = defaultNotesFile(version);
  const notes = args.notesFile
    ? readFileSync(path.resolve(ROOT, args.notesFile), 'utf8').trim()
    : args.notes.trim() || (autoFile ? readFileSync(autoFile, 'utf8').trim() : renderNotes(collectCommits(previous)));
  if (autoFile && !args.notesFile && !args.notes.trim()) {
    console.log(`使用 ${path.relative(ROOT, autoFile)} 作为更新日志`);
  }
  if (args.dryRun) {
    console.log(`release-only ${tag}（上一个 tag: ${previous || '无'}）`);
    console.log(notes || '(no notes)');
    return 0;
  }
  if (!createRelease(version, notes, { dryRun: false })) {
    console.error(`tag ${tag} 已存在，但 GitHub Release 没有建成`);
    return 1;
  }
  console.log(`released ${tag}`);
  return 0;
}

/**
 * 把这一版的说明写进 CHANGELOG.md：新的在最前，同版本旧条目被替换。
 * CHANGELOG 会随包发布，更新对话框就是从这里读说明的。
 * @param {string} text 现有 CHANGELOG 内容（可为空）
 * @param {string} version
 * @param {string} notes
 * @returns {string}
 */
export function upsertChangelog(text, version, notes) {
  const title = '# 更新日志';
  const body = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#\s+更新日志\s*/, '')
    .trim();
  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = { title: line.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  const wanted = new RegExp(`^##\\s+v?${String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const kept = sections
    .filter((section) => !wanted.test(section.title))
    .map((section) => ({ title: section.title, lines: section.lines }));
  const fresh = { title: `## v${version}`, lines: ['', ...String(notes || '').trim().split('\n')] };
  const lines = [title, ''];
  for (const section of [fresh, ...kept]) {
    lines.push(section.title, ...section.lines, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * 发到 npm。返回是否成功（失败不阻止建 Release，但退出码会是 1）。
 * @param {string} version
 * @returns {boolean}
 */
function publishToNpm(version) {
  const tag = distTag(version);
  const args = ['publish', '--tag', tag, '--access', 'public'];
  console.log(`\n发布到 npm（dist-tag: ${tag}）…`);
  // Windows 上 npm 是 .cmd，不能直接 spawn；优先用 npm-cli.js 走 node。
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const result = existsSync(cli) ? run(process.execPath, [cli, ...args]) : run('npm', args);
  if (!result.error && result.status === 0) {
    console.log(`npm 已发布 ${version}`);
    return true;
  }
  console.error(`npm publish 失败；tag 已经推送。修好后手动执行：npm publish --tag ${tag}`);
  return false;
}

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.releaseOnly) return releaseOnly(args);
  if (args.help || !args.kind) {
    console.log('usage: node scripts/release.mjs <patch|minor|major|x.y.z|x.y.z-rc1> [--dry-run] [--publish] [--notes "..."] [--notes-file file]');
    console.log('       node scripts/release.mjs --release-only   # 补建 Release');
    return args.help ? 0 : 2;
  }
  const current = readVersion();
  const next = nextVersion(current, args.kind);
  if (next === current) throw new Error('the new version equals the current one');
  const tag = `v${next}`;
  if (isHiddenPrerelease(next)) {
    console.log(`${next} 是 alpha/beta：会标成 prerelease，已装用户不会收到更新提示。`);
  }

  // 说明必须在打 tag 之前收：打完 tag 再 describe 拿到的就是新 tag，区间为空。
  const notes = args.notesFile
    ? readFileSync(path.resolve(ROOT, args.notesFile), 'utf8').trim()
    : args.notes.trim() || renderNotes(collectCommits(lastTag()));
  const plan = releasePlan(next);

  if (args.dryRun) {
    console.log(`release ${current} → ${next}`);
    console.log(`  node --test    (tests)`);
    for (const step of plan) console.log(`  ${step.command} ${step.args.join(' ')}`);
    if (args.publish) console.log(`  npm publish --tag ${distTag(next)}`);
    console.log(`  (github release ${tag})\n`);
    console.log(notes || '(no notes)');
    return 0;
  }

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) {
    console.error(`release from ${BRANCH}, not ${branch || 'detached HEAD'}`);
    return 1;
  }
  if (capture('git', ['status', '--porcelain'])) {
    console.error('working tree is not clean; commit or stash first');
    return 1;
  }

  // 上一次发版可能已经 bump + 打了 tag、只是推送/建 Release 时失败：
  // 这种情况下不重做前面的步骤，直接从推送继续。
  const resume = capture('git', ['tag', '--list', tag]) !== '' && current === next;
  if (resume) {
    console.log(`检测到 ${tag} 已存在且版本号已是 ${next}：接着上次没做完的推送与 Release`);
  } else if (capture('git', ['tag', '--list', tag])) {
    console.error(`tag ${tag} already exists`);
    return 1;
  }
  const ghCli = ghReady();
  if (ghCli && run(ghCli, ['release', 'view', tag], { capture: true }).status === 0) {
    console.error(`release ${tag} already exists`);
    return 1;
  }

  if (run(process.execPath, ['--test']).status !== 0) {
    console.error('tests failed; release aborted');
    if (resume) console.error(`版本号已经是 ${next}；修好测试后重跑本命令会从推送继续`);
    return 1;
  }

  const baseSha = capture('git', ['rev-parse', 'HEAD']);
  /** 推送之前失败：把本地改动恢复原样，用户可以直接重试。 */
  const rollback = (reason) => {
    console.error(`\n发版失败：${reason}`);
    run('git', ['tag', '-d', tag], { capture: true });
    const reset = run('git', ['reset', '--hard', baseSha], { capture: true });
    if (!reset.error && reset.status === 0) console.error(`已回退本地改动（回到 ${baseSha.slice(0, 7)}），可以直接重试`);
    else console.error(`自动回退没有成功，请手动执行：git reset --hard ${baseSha} && git tag -d ${tag}`);
    return 1;
  };

  if (!resume) {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    pkg.version = next;
    writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    // 说明同时写进 CHANGELOG.md：它会随包发布，更新对话框从那里读。
    const changelogPath = path.join(ROOT, 'CHANGELOG.md');
    const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
    writeFileSync(changelogPath, upsertChangelog(existing, next, notes), 'utf8');

    // 只做本地那三步（add / commit / tag），推送单独处理，好在失败时回退。
    for (const step of plan.slice(0, 3)) {
      if (run(step.command, step.args).status !== 0) {
        return rollback(`${step.command} ${step.args[0]} 失败`);
      }
    }
  }

  // 先推分支：这一步失败说明远端还没变，可以安全回退。
  if (run('git', ['push', 'origin', BRANCH]).status !== 0) {
    console.error('\n推送分支失败（网络 / 凭据）');
    if (resume) {
      console.error(`本地停在 ${tag}，远端未更新；修好网络后重跑本命令会从推送继续`);
      return 1;
    }
    return rollback('git push 失败');
  }

  // 再单独推 tag：失败时分支已经上去了，不能再回退本地，改为提示补推。
  if (run('git', ['push', 'origin', `refs/tags/${tag}`]).status !== 0) {
    console.error(`\n分支已推送，但 tag ${tag} 推送失败（网络 / 凭据）`);
    console.error(`恢复网络后执行：git push origin refs/tags/${tag}，然后 node scripts/release.mjs --release-only`);
    return 1;
  }

  let published = true;
  if (args.publish) published = publishToNpm(next);

  if (!createRelease(next, notes, { dryRun: false })) {
    console.error(`\ntag ${tag} 已推送，但 GitHub Release 没有建成`);
    console.error('凭据齐了之后执行：node scripts/release.mjs --release-only');
    return 1;
  }
  console.log(`\nreleased ${tag}`);
  return published ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
