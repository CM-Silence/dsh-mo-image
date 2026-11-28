import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CACHE = 'dsh-release-tests.json';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

function git(root, args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
}

function testFingerprint(root) {
  const result = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (result.status !== 0) return '';
  const hash = createHash('sha256');
  hash.update(JSON.stringify([process.version, process.execPath, process.platform, process.arch,
    process.env.NODE_OPTIONS, process.env.NODE_PATH]));
  const files = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  for (const file of files) {
    const target = path.resolve(root, file);
    try {
      const stat = lstatSync(target);
      if (!stat.isFile()) return '';
      const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
      hash.update(JSON.stringify([file, stat.mode & 0o111, digest]));
    } catch (error) {
      if (error.code !== 'ENOENT') return '';
    }
  }
  return hash.digest('hex');
}

function cacheFile(root) {
  const result = git(root, ['rev-parse', '--git-path', CACHE]);
  return result.status === 0 ? path.resolve(root, result.stdout.trim()) : '';
}

function cachedFingerprint(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).fingerprint; }
  catch { return ''; }
}

function saveFingerprint(file, fingerprint) {
  if (!file || !fingerprint) return;
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify({ fingerprint }), 'utf8');
    renameSync(temporary, file);
  } catch {
    // A cache failure should not prevent release after passing tests.
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export function verifyProjectTests(root, { dryRun = false } = {}) {
  const file = cacheFile(root);
  const before = testFingerprint(root);
  if (before && before === cachedFingerprint(file)) {
    console.log('项目文件和测试环境一致，复用上次通过的测试。');
    return true;
  }
  if (dryRun) {
    console.log('  node --test    (tests)');
    return true;
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const tested = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit', env });
  if (tested.error || tested.status !== 0) return false;
  const after = testFingerprint(root);
  if (before && before !== after) {
    console.error('测试期间项目文件发生变化，请重新执行。');
    return false;
  }
  saveFingerprint(file, after);
  return true;
}

export function runNpm(root, args, { capture = false, timeout } = {}) {
  const cli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((candidate) => candidate && /\.(?:c?js|mjs)$/i.test(candidate) && existsSync(candidate));
  const options = { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout };
  if (cli) return spawnSync(process.execPath, [cli, ...args], options);
  // Windows npm is commonly npm.cmd. Current callers pass only fixed npm arguments.
  return spawnSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

export function npmPublicationReady(root, execute = runNpm) {
  const result = execute(root, ['whoami', '--registry', NPM_REGISTRY, '--fetch-retries=0', '--fetch-timeout=10000'],
    { capture: true, timeout: 15000 });
  if (!result.error && result.status === 0 && result.stdout?.trim()) return true;
  const diagnosis = String(result.stderr || '') + '\n' + String(result.stdout || '');
  if (/\b(?:ENEEDAUTH|E401|E403)\b/i.test(diagnosis)) {
    console.error('npm 登录缺失、已过期或凭据无效。请执行 npm login --registry ' + NPM_REGISTRY + ' 后重试。');
  } else if (result.error?.code === 'ENOENT') {
    console.error('找不到 npm。请检查 Node.js 和 npm 安装。');
  } else {
    console.error('无法确认 npm 登录状态。请检查官方 npm registry 的连接，再执行 npm whoami --registry ' + NPM_REGISTRY + '。');
  }
  return false;
}

export function remoteReleaseTag(root, ref) {
  const remotes = git(root, ['remote', 'get-url', '--push', '--all', 'origin']);
  if (remotes.status !== 0) return 'unknown';
  const urls = [...new Set(remotes.stdout.split(/\r?\n/).filter(Boolean))];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  let allAbsent = urls.length > 0;
  for (const url of urls) {
    const result = git(root, ['ls-remote', '--exit-code', '--refs', '--', url, ref], { timeout: 10000, env });
    if (result.status === 0 && result.stdout.split(/\r?\n/).some((line) => line.split('\t')[1] === ref)) return 'present';
    if (result.error || result.status !== 2) allAbsent = false;
  }
  return allAbsent ? 'absent' : 'unknown';
}

export function rollbackUnpushedTag(root, ref, expectedObject) {
  const state = remoteReleaseTag(root, ref);
  if (state !== 'absent') return state;
  // Compare the tag object, so an independently changed local tag is left intact.
  return expectedObject && git(root, ['update-ref', '-d', ref, expectedObject]).status === 0 ? 'removed' : 'changed';
}
