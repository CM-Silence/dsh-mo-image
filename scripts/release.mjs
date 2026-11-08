#!/usr/bin/env node
/**
 * 发版脚本：bump 版本 → 跑测试 → commit → tag → push → 建 GitHub Release。
 *
 * 版本号的唯一事实来源是 tag；更新检查读的就是 Release，所以 tag 与
 * package.json 必须一致，脚本负责保证这一点。
 *
 * Usage:
 *   node scripts/release.mjs patch            # 0.3.1 → 0.3.2
 *   node scripts/release.mjs minor            # 0.3.1 → 0.4.0
 *   node scripts/release.mjs 0.5.0            # 指定版本
 *   node scripts/release.mjs minor --dry-run  # 只打印要做的事
 *   node scripts/release.mjs minor --notes-file notes.md
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

/**
 * 解析命令行。
 * @param {string[]} argv
 * @returns {{kind: string, dryRun: boolean, notes: string, notesFile: string, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { kind: '', dryRun: false, notes: '', notesFile: '', help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
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
    // 发版提交本身是噪音，不写进说明。
    if (commit.type === 'chore') continue;
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  if (result.error) throw result.error;
  return result;
}

function capture(command, args) {
  const result = run(command, args, { capture: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function hasGh() {
  return run('gh', ['--version'], { capture: true }).status === 0;
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

function createRelease(version, notes, dryRun) {
  const tag = `v${version}`;
  if (dryRun) {
    console.log(`would create GitHub release ${tag} with ${notes.split('\n').length} lines of notes`);
    return true;
  }
  const file = path.join(os.tmpdir(), `dsh-mo-image-${tag}.md`);
  writeFileSync(file, notes + '\n', 'utf8');
  try {
    if (hasGh()) {
      const result = run('gh', ['release', 'create', tag, '--title', tag, '--notes-file', file]);
      return result.status === 0;
    }
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    if (!token) {
      console.log(`\ntag ${tag} 已经推送，但没有 gh 也没有 GITHUB_TOKEN。`);
      console.log(`去 https://github.com/${REPO}/releases/new 新建 Release，tag 选 ${tag}，正文：\n`);
      console.log(notes);
      return false;
    }
    const body = JSON.stringify({ tag_name: tag, name: tag, body: notes });
    const result = run('node', ['-e', `
      const body = ${JSON.stringify(body)};
      fetch('https://api.github.com/repos/${REPO}/releases', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
        body
      }).then((r) => { console.log(r.status); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(e.message); process.exit(1); });
    `]);
    return result.status === 0;
  } finally {
    try { rmSync(file, { force: true }); } catch (_error) { /* 临时文件删不掉不影响发布 */ }
  }
}

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.kind) {
    console.log('usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--notes "..."] [--notes-file file]');
    return args.help ? 0 : 2;
  }
  const current = readVersion();
  const next = nextVersion(current, args.kind);
  if (next === current) throw new Error('the new version equals the current one');
  const tag = `v${next}`;

  const steps = [
    ['git', ['status', '--porcelain']],
    ['npm', ['test']],
    ['git', ['add', 'package.json']],
    ['git', ['commit', '-m', `chore(release): ${tag}`]],
    ['git', ['tag', '-a', tag, '-m', tag]],
    ['git', ['push']],
    ['git', ['push', '--tags']]
  ];

  if (args.dryRun) {
    console.log(`release ${current} → ${next}`);
    for (const [command, commandArgs] of steps) console.log(`  ${command} ${commandArgs.join(' ')}`);
    console.log(`  (github release ${tag})`);
    return 0;
  }

  if (capture('git', ['status', '--porcelain'])) {
    console.error('working tree is not clean; commit or stash first');
    return 1;
  }
  if (capture('git', ['tag', '--list', tag])) {
    console.error(`tag ${tag} already exists`);
    return 1;
  }

  for (const [command, commandArgs] of steps.slice(1, 2)) {
    const result = run(command, commandArgs);
    if (result.status !== 0) {
      console.error('tests failed; release aborted');
      return 1;
    }
  }

  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = next;
  writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  for (const [command, commandArgs] of steps.slice(2)) {
    const result = run(command, commandArgs);
    if (result.status !== 0) {
      console.error(`failed: ${command} ${commandArgs.join(' ')}`);
      return 1;
    }
  }

  const notes = args.notesFile
    ? readFileSync(path.resolve(ROOT, args.notesFile), 'utf8').trim()
    : args.notes.trim() || renderNotes(collectCommits(lastTag()));
  createRelease(next, notes, false);
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
