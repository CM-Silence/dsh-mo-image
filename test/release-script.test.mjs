import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, nextVersion, renderNotes, releasePlan, commandAvailable } from '../scripts/release.mjs';

test('parseArgs reads the bump kind and flags', () => {
  assert.deepEqual(parseArgs(['minor']), { kind: 'minor', dryRun: false, notes: '', notesFile: '', help: false, releaseOnly: false });
  const withNotes = parseArgs(['0.4.0', '--notes', '- 修复']);
  assert.equal(withNotes.kind, '0.4.0');
  assert.equal(withNotes.notes, '- 修复');
  assert.equal(parseArgs(['--dry-run', 'patch']).dryRun, true);
  assert.equal(parseArgs(['--notes-file', 'notes.md', 'patch']).notesFile, 'notes.md');
  assert.equal(parseArgs(['--release-only']).releaseOnly, true);
  assert.equal(parseArgs([]).kind, '');
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
