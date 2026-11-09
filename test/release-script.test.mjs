import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, nextVersion, renderNotes, releasePlan, commandAvailable, distTag,
  upsertChangelog, notesForRelease
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

test('releasePlan keeps a spaced commit message inside one argument', () => {
  const plan = releasePlan('0.4.0');
  assert.deepEqual(plan.map((step) => step.command), ['git', 'git', 'git', 'git', 'git']);
  const commit = plan.find((step) => step.args[0] === 'commit');
  assert.deepEqual(commit.args, ['commit', '-m', 'chore(release): v0.4.0']);
  const tag = plan.find((step) => step.args[0] === 'tag');
  assert.deepEqual(tag.args, ['tag', '-a', 'v0.4.0', '-m', 'v0.4.0']);
});
