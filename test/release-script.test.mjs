import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rollbackUnpushedTag } from '../scripts/release-checks.mjs';
import {
  parseArgs, nextVersion, renderNotes, releasePlan, commandAvailable, distTag,
  upsertChangelog, notesForRelease, isPreparedRelease, publishReleaseArtifacts
} from '../scripts/release.mjs';

test('release notes prefer the changelog section over generated commits', () => {
  const changelog = ['# 更新日志', '', '## v0.4.2', '', '- 写在 CHANGELOG 里', '', '## v0.4.1', '', '- 旧', ''].join('\n');
  const commits = [{ type: 'feat', text: 'auto' }];
  assert.equal(notesForRelease({ version: '0.4.2', changelog, commits }), '- 写在 CHANGELOG 里');
  assert.equal(notesForRelease({ version: '0.4.3', changelog, commits }), '### 新功能\n\n- auto');
  assert.equal(notesForRelease({ version: '0.4.2', changelog, notes: '- 显式', commits }), '- 显式');
  assert.equal(notesForRelease({ version: '0.4.2', changelog, notes: '- 显式', notesFileText: '- 文件', commits }), '- 文件');
});

test('a section written as vX-latest feeds the plain release and gets folded in', () => {
  const changelog = ['# 更新日志', '', '## v0.4.1-latest', '', '- 写成 latest 的说明', ''].join('\n');
  assert.equal(notesForRelease({ version: '0.4.1', changelog, commits: [] }), '- 写成 latest 的说明');
  const written = upsertChangelog(changelog, '0.4.1', '- 写成 latest 的说明');
  assert.match(written, /## v0\.4\.1\n/);
  assert.doesNotMatch(written, /v0\.4\.1-latest/);
});

test('upsertChangelog puts the new version on top and replaces an old draft', () => {
  const initial = ['# 更新日志', '', '## v0.4.1', '', '- 旧版本', ''].join('\n');
  const added = upsertChangelog(initial, '0.4.2', '- 新功能');
  assert.match(added, /^# 更新日志\n\n## v0\.4\.2\n\n- 新功能/);
  assert.match(added, /## v0\.4\.1\n\n- 旧版本/);

  const replaced = upsertChangelog(added, '0.4.2', '- 改过的说明');
  assert.match(replaced, /- 改过的说明/);
  assert.doesNotMatch(replaced, /- 新功能/);
  assert.equal((replaced.match(/## v0\.4\.2/g) || []).length, 1);
});

test('parseArgs reads the bump kind and flags', () => {
  assert.deepEqual(parseArgs(['minor']), { kind: 'minor', dryRun: false, notes: '', notesFile: '', help: false, releaseOnly: false, publish: false });
  const withNotes = parseArgs(['0.4.0', '--notes', '- 修复']);
  assert.equal(withNotes.kind, '0.4.0');
  assert.equal(withNotes.notes, '- 修复');
  assert.equal(parseArgs(['--dry-run', 'patch']).dryRun, true);
  assert.equal(parseArgs(['--notes-file', 'notes.md', 'patch']).notesFile, 'notes.md');
  assert.equal(parseArgs(['--release-only']).releaseOnly, true);
  assert.equal(parseArgs(['0.4.1', '--publish']).publish, true);
  assert.equal(parseArgs([]).kind, '');
});

test('prereleases publish under the next dist-tag', () => {
  assert.equal(distTag('0.4.1'), 'latest');
  assert.equal(distTag('0.4.1-rc1'), 'next');
  assert.equal(distTag('0.4.1-b1'), 'next');
  assert.equal(distTag('0.4.1-a2'), 'next');
});

test('a missing command is reported as unavailable instead of throwing', () => {
  assert.equal(commandAvailable('dsh-mo-image-definitely-not-installed'), false);
});

test('nextVersion bumps the right segment', () => {
  assert.equal(nextVersion('0.3.1', 'patch'), '0.3.2');
  assert.equal(nextVersion('0.3.1', 'minor'), '0.4.0');
  assert.equal(nextVersion('0.3.1', 'major'), '1.0.0');
  assert.equal(nextVersion('0.3.1', '0.4.0'), '0.4.0');
  assert.throws(() => nextVersion('0.3.1', '0.2.0'), /newer/i);
  assert.throws(() => nextVersion('0.3.1', 'banana'), /unknown/i);
});

test('nextVersion accepts explicit tag-style versions with a suffix', () => {
  assert.equal(nextVersion('0.3.1', '0.9.0-rc1'), '0.9.0-rc1');
  assert.equal(nextVersion('0.9.0-rc1', 'v0.9.0-rc2'), '0.9.0-rc2');
  assert.equal(nextVersion('0.9.0-rc2', '0.9.0'), '0.9.0');
  assert.equal(nextVersion('0.9.0-b1', '0.9.0-b2'), '0.9.0-b2');
  assert.throws(() => nextVersion('0.9.0-rc2', '0.9.0-rc1'), /newer/i);
  assert.throws(() => nextVersion('0.9.0-b2', '0.9.0-a3'), /newer/i);
  assert.throws(() => nextVersion('0.3.1', '0.4'), /unknown/i);
});

test('a -latest tag is just an alias for the plain release', () => {
  assert.equal(nextVersion('0.4.1-rc1', '0.4.1-latest'), '0.4.1');
  assert.equal(nextVersion('0.4.1-rc1', 'v0.4.2-latest'), '0.4.2');
});

test('renderNotes groups commits by type', () => {
  const notes = renderNotes([
    { type: 'feat', text: 'add searchable model picker' },
    { type: 'fix', text: 'keep the picker open' },
    { type: 'docs', text: 'describe providers' },
    { type: 'chore', text: 'release v0.4.0' },
    { type: 'chore', text: 'bump dev dependencies' }
  ]);
  assert.match(notes, /### 新功能/);
  assert.match(notes, /### 修复/);
  assert.match(notes, /add searchable model picker/);
  assert.match(notes, /keep the picker open/);
  assert.match(notes, /describe providers/);
  assert.match(notes, /bump dev dependencies/);
  assert.doesNotMatch(notes, /release v0\.4\.0/);
});

test('releasePlan commits only the release files and atomically pushes the tagged commit and the single tag', () => {
  const plan = releasePlan('0.4.0');
  assert.deepEqual(plan.map((step) => step.command), ['git', 'git', 'git']);
  const commit = plan.find((step) => step.args[0] === 'commit');
  assert.deepEqual(commit.args, ['commit', '--only', '-m', 'chore(release): v0.4.0', '--', 'package.json', 'CHANGELOG.md']);
  const tag = plan.find((step) => step.args[0] === 'tag');
  assert.deepEqual(tag.args, ['tag', '-a', 'v0.4.0', '-m', 'v0.4.0']);
  assert.deepEqual(plan.at(-1).args, [
    'push', '--atomic', 'origin', 'refs/tags/v0.4.0^{commit}:refs/heads/master', 'refs/tags/v0.4.0:refs/tags/v0.4.0'
  ]);
});

test('an explicit current version resumes from the matching tag or an untagged release commit', () => {
  const version = nextVersion('0.4.1-rc2', 'v0.4.1-rc2');
  assert.equal(version, '0.4.1-rc2');
  assert.ok(isPreparedRelease('0.4.1-rc2', version, 'abc', 'abc'));
  assert.equal(isPreparedRelease('0.4.1-rc2', version, 'abc', 'def', 'prepared'), false);
  assert.ok(isPreparedRelease('0.4.1-rc2', version, 'abc', '', 'prepared'));
  assert.equal(isPreparedRelease('0.4.1-rc2', version, 'abc', ''), false);
  assert.equal(isPreparedRelease('0.4.1-rc2', version, '', ''), false);
  assert.equal(isPreparedRelease('0.4.1-rc1', version, 'abc', 'abc'), false);
});

test('failed requested npm publication prevents a GitHub announcement', () => {
  const calls = [];
  const npm = (version) => { calls.push(['npm', version]); return false; };
  const github = (version, notes) => { calls.push(['github', version, notes]); return true; };
  assert.equal(publishReleaseArtifacts('0.4.0', 'notes', { npm, github, publish: true }), 'npm-failed');
  assert.deepEqual(calls, [['npm', '0.4.0']]);
  assert.equal(publishReleaseArtifacts('0.4.0', 'notes', { npm, github }), 'released');
  assert.deepEqual(calls.at(-1), ['github', '0.4.0', 'notes']);
});

function releaseFixture(t) {
  const temp = realpathSync(os.tmpdir());
  const folder = mkdtempSync(path.join(temp, 'dsh-release-regression-'));
  t.after(() => {
    const real = realpathSync(folder);
    if (path.dirname(real) === temp && path.basename(real).startsWith('dsh-release-regression-')) {
      rmSync(real, { recursive: true, force: true });
    }
  });
  const root = path.join(folder, 'project');
  const remote = path.join(folder, 'origin');
  mkdirSync(root);
  const git = (args, cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'master']);
  git(['config', 'user.name', 'Release Test']);
  git(['config', 'user.email', 'release-test@example.invalid']);
  for (const name of ['lib', 'scripts', 'test']) mkdirSync(path.join(root, name));
  for (const name of ['lib/update.js', 'scripts/release.mjs', 'scripts/release-checks.mjs']) {
    copyFileSync(new URL('../' + name, import.meta.url), path.join(root, name));
  }
  const packageFile = path.join(root, 'package.json');
  const changelog = path.join(root, 'CHANGELOG.md');
  writeFileSync(packageFile, JSON.stringify({ type: 'module', name: 'fixture', version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(changelog, '# Changes\n');
  writeFileSync(path.join(root, 'test', 'smoke.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
    "test('record the actual tested version', () => {",
    "  appendFileSync('.git/tested', JSON.parse(readFileSync('package.json', 'utf8')).version + '\\n');",
    "  assert.equal(existsSync('.git/fail-tests'), false);",
    "});"
  ].join('\n'));
  git(['add', '-A']);
  git(['commit', '-m', 'chore: initial release fixture']);
  git(['clone', root, remote]);
  git(['config', 'receive.denyCurrentBranch', 'refuse'], remote);
  git(['remote', 'add', 'origin', remote]);
  const env = { ...process.env, GH_CONFIG_DIR: path.join(folder, 'gh'), GH_TOKEN: '', GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const release = (args, extra = {}) => {
    const result = spawnSync(process.execPath, ['scripts/release.mjs', ...args],
      { cwd: root, encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { root, remote, git, release, packageFile, changelog, version: () => JSON.parse(readFileSync(packageFile, 'utf8')).version };
}

test('a refused atomic push rolls back the local tag and retries the same tested release', (t) => {
  const { root, remote, git, release, version, changelog } = releaseFixture(t);
  const firstHead = git(['rev-parse', 'HEAD']);
  const failTests = path.join(root, '.git', 'fail-tests');
  writeFileSync(failTests, '');
  const testFailure = release(['1.0.1']);
  assert.equal(testFailure.status, 1, testFailure.output);
  assert.match(testFailure.output, /tests failed; release aborted/);
  assert.equal(version(), '1.0.0');
  assert.equal(readFileSync(changelog, 'utf8'), '# Changes\n');
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['rev-parse', 'HEAD']), firstHead);
  rmSync(failTests);

  const rejected = release(['1.0.1']);
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.output, /已撤回本地标签/);
  assert.equal(version(), '1.0.1');
  assert.equal(git(['log', '-1', '--format=%s']), 'chore(release): v1.0.1');
  assert.equal(git(['tag', '--list', 'v1.0.1']), '');
  assert.equal(git(['tag', '--list', 'v1.0.1'], remote), '');
  const releaseHead = git(['rev-parse', 'HEAD']);
  git(['tag', '-a', 'v1.0.1', '-m', 'retained after an unconfirmed push']);
  const retry = release(['1.0.1']);
  assert.equal(retry.status, 1, retry.output);
  assert.match(retry.output, /复用上次通过的测试/);
  assert.match(retry.output, /已撤回本地标签/);
  assert.equal(git(['rev-parse', 'HEAD']), releaseHead);
  assert.equal(readFileSync(path.join(root, '.git', 'tested'), 'utf8'), '1.0.1\n1.0.1\n');
  assert.equal(git(['status', '--porcelain']), '');

  writeFileSync(path.join(root, 'test-input.txt'), 'file changed');
  git(['add', 'test-input.txt']);
  git(['commit', '-m', 'chore: update release inputs']);
  const changed = release(['1.0.1']);
  assert.equal(changed.status, 1, changed.output);
  assert.match(changed.output, /已撤回本地标签/);
  assert.doesNotMatch(changed.output, /复用上次通过的测试/);
  assert.equal(readFileSync(path.join(root, '.git', 'tested'), 'utf8'), '1.0.1\n1.0.1\n1.0.1\n');

  git(['tag', '-a', 'v1.0.1', '-m', 'retained locally']);
  const retained = git(['rev-parse', 'refs/tags/v1.0.1']);
  git(['tag', 'v1.0.1'], remote);
  const duplicate = release(['1.0.1', '--publish']);
  assert.equal(duplicate.status, 1, duplicate.output);
  assert.match(duplicate.output, /远端已存在 v1\.0\.1/);
  assert.equal(git(['rev-parse', 'refs/tags/v1.0.1']), retained);
  git(['remote', 'set-url', 'origin', path.join(remote, 'does-not-exist')]);
  const unconfirmed = release(['1.0.1']);
  assert.equal(unconfirmed.status, 1, unconfirmed.output);
  assert.match(unconfirmed.output, /无法确认远端标签状态，本地标签会保留/);
  assert.equal(git(['rev-parse', 'refs/tags/v1.0.1']), retained);
  assert.equal(readFileSync(path.join(root, '.git', 'tested'), 'utf8'), '1.0.1\n1.0.1\n1.0.1\n');
});

test('missing npm authentication stops before tests, a commit or a tag', (t) => {
  const { root, git, release, version } = releaseFixture(t);
  const stub = path.join(root, '.git', 'npm-stub.cjs');
  writeFileSync(stub, [
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'whoami' || args[args.indexOf('--registry') + 1] !== 'https://registry.npmjs.org/') process.exit(4);",
    "console.error('npm error code ENEEDAUTH');",
    "process.exit(1);"
  ].join('\n'));
  const original = git(['rev-parse', 'HEAD']);
  const result = release(['1.0.1', '--publish'], { npm_execpath: stub });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm login --registry https:\/\/registry\.npmjs\.org\//);
  assert.equal(version(), '1.0.0');
  assert.equal(git(['rev-parse', 'HEAD']), original);
  assert.equal(git(['tag', '--list']), '');
  assert.throws(() => readFileSync(path.join(root, '.git', 'tested')), { code: 'ENOENT' });
});

test('rollback preserves a remote, unverified or independently changed tag', (t) => {
  const { root, remote, git } = releaseFixture(t);
  const ref = 'refs/tags/v1.0.1';
  git(['tag', '-a', 'v1.0.1', '-m', 'local']);
  const object = git(['rev-parse', ref]);
  git(['tag', 'v1.0.1'], remote);
  assert.equal(rollbackUnpushedTag(root, ref, object), 'present');
  git(['tag', '-d', 'v1.0.1'], remote);
  assert.equal(rollbackUnpushedTag(root, ref, git(['rev-parse', 'HEAD'])), 'changed');
  git(['remote', 'set-url', 'origin', path.join(remote, 'does-not-exist')]);
  assert.equal(rollbackUnpushedTag(root, ref, object), 'unknown');
  assert.equal(git(['rev-parse', ref]), object);
});
