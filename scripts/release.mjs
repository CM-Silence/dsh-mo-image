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
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions } from '../lib/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const REPO = 'CM-Silence/dsh-mo-image';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const BRANCH = 'master';

/**
 * 解析命令行。
 * @param {string[]} argv
 * @returns {{kind: string, dryRun: boolean, notes: string, notesFile: string, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { kind: '', dryRun: false, notes: '', notesFile: '', help: false, releaseOnly: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--release-only') out.releaseOnly = true;
    else if (arg === '--notes') { out.notes = String(argv[i + 1] || ''); i += 1; }
    else if (arg === '--notes-file') { out.notesFile = String(argv[i + 1] || ''); i += 1; }
    else if (arg === '--help' || arg === '-h') out.help = true;
    else rest.push(arg);
  }
  out.kind = rest[0] || '';
  return out;
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
  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (SEMVER.test(String(kind || ''))) {
    if (compareVersions(kind, current) !== 1) throw new Error(`${kind} is not newer than ${current}`);
    return String(kind);
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
    { command: 'git', args: ['add', 'package.json'] },
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

function hasGh() {
  return commandAvailable('gh');
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
function createReleaseWithToken(tag, notes) {
  const dir = os.tmpdir();
  const payload = path.join(dir, `dsh-release-${Date.now()}.json`);
  const script = path.join(dir, `dsh-release-${Date.now()}.mjs`);
  writeFileSync(payload, JSON.stringify({ tag_name: tag, name: tag, body: notes }), 'utf8');
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
  if (options.dryRun) return true;
  const file = path.join(os.tmpdir(), `dsh-mo-image-${tag}.md`);
  writeFileSync(file, notes + '\n', 'utf8');
  try {
    if (hasGh()) {
      return run('gh', ['release', 'create', tag, '--title', tag, '--notes-file', file]).status === 0;
    }
    if (String(process.env.GITHUB_TOKEN || '').trim()) return createReleaseWithToken(tag, notes);
    console.log(`\ntag ${tag} 已经推送，但没有 gh 也没有 GITHUB_TOKEN。`);
    console.log(`打开这个地址，正文粘贴下面的内容，点 Create release：`);
    console.log(`  https://github.com/${REPO}/releases/new?tag=${tag}&title=${tag}\n`);
    console.log('----- 正文开始 -----');
    console.log(notes);
    console.log('----- 正文结束 -----\n');
    console.log('装好 gh（winget install GitHub.cli）或设置 GITHUB_TOKEN 后，也可以跑：');
    console.log(`  node scripts/release.mjs --release-only\n`);
    return false;
  } finally {
    try { rmSync(file, { force: true }); } catch (_error) { /* 同上 */ }
  }
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
  const notes = args.notesFile
    ? readFileSync(path.resolve(ROOT, args.notesFile), 'utf8').trim()
    : args.notes.trim() || renderNotes(collectCommits(previous));
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
 * 主流程。
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.releaseOnly) return releaseOnly(args);
  if (args.help || !args.kind) {
    console.log('usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--notes "..."] [--notes-file file]');
    console.log('       node scripts/release.mjs --release-only   # 补建 Release');
    return args.help ? 0 : 2;
  }
  const current = readVersion();
  const next = nextVersion(current, args.kind);
  if (next === current) throw new Error('the new version equals the current one');
  const tag = `v${next}`;

  // 说明必须在打 tag 之前收：打完 tag 再 describe 拿到的就是新 tag，区间为空。
  const notes = args.notesFile
    ? readFileSync(path.resolve(ROOT, args.notesFile), 'utf8').trim()
    : args.notes.trim() || renderNotes(collectCommits(lastTag()));
  const plan = releasePlan(next);

  if (args.dryRun) {
    console.log(`release ${current} → ${next}`);
    console.log(`  node --test    (tests)`);
    for (const step of plan) console.log(`  ${step.command} ${step.args.join(' ')}`);
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
  if (capture('git', ['tag', '--list', tag])) {
    console.error(`tag ${tag} already exists`);
    return 1;
  }
  if (hasGh() && run('gh', ['release', 'view', tag], { capture: true }).status === 0) {
    console.error(`release ${tag} already exists`);
    return 1;
  }

  if (run(process.execPath, ['--test']).status !== 0) {
    console.error('tests failed; release aborted');
    return 1;
  }

  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = next;
  writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  for (const step of plan) {
    if (run(step.command, step.args).status !== 0) {
      console.error(`failed: ${step.command} ${step.args.join(' ')}`);
      return 1;
    }
  }

  if (!createRelease(next, notes, { dryRun: false })) {
    console.error(`tag ${tag} pushed but the GitHub release was not created`);
    return 1;
  }
  console.log(`\nreleased ${tag}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
