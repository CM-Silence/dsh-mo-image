import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobJournal } from '../lib/image-jobs.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mo-image-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a created job can be read back and updated in place', async (t) => {
  const journal = createJobJournal({ dir: tempDir(t) });
  const created = await journal.create({ status: 'submitted', providerId: 'p1', model: 'm', taskId: 't1' });

  assert.match(created.id, /^[a-zA-Z0-9_-]{8,}$/);
  assert.equal(created.status, 'submitted');
  assert.equal(created.providerId, 'p1');

  const loaded = await journal.get(created.id);
  assert.equal(loaded.taskId, 't1');

  const updated = await journal.update(created.id, { status: 'saved', file: 'out.png' });
  assert.equal(updated.status, 'saved');
  assert.equal(updated.file, 'out.png');
  assert.equal(updated.providerId, 'p1', 'update merges instead of replacing the record');
  assert.ok(updated.updatedAt >= created.updatedAt);
});

test('a missing or malformed id is not a crash', async (t) => {
  const journal = createJobJournal({ dir: tempDir(t) });
  assert.equal(await journal.get('missing-job'), null);
  assert.equal(await journal.get('../escape'), null);
  assert.equal(await journal.update('missing-job', { status: 'x' }), null);
});

test('concurrent updates are serialized so neither write is lost', async (t) => {
  const journal = createJobJournal({ dir: tempDir(t) });
  const created = await journal.create({ status: 'submitted', count: 0 });

  await Promise.all([
    journal.update(created.id, { count: 1 }),
    journal.update(created.id, { note: 'second' })
  ]);
  const loaded = await journal.get(created.id);
  assert.equal(loaded.count, 1);
  assert.equal(loaded.note, 'second');
});

test('prune removes only records older than the retention window', async (t) => {
  const dir = tempDir(t);
  let now = 1_700_000_000_000;
  const journal = createJobJournal({ dir: dir, now: () => now });
  const old = await journal.create({ status: 'saved' });
  now += 1000;
  const fresh = await journal.create({ status: 'saved' });

  now += 7 * 24 * 60 * 60 * 1000;
  const removed = await journal.prune(30 * 24 * 60 * 60 * 1000);
  assert.equal(removed, 0, 'both records are inside the retention window');
  assert.ok(await journal.get(old.id));

  now += 30 * 24 * 60 * 60 * 1000;
  assert.equal(await journal.prune(30 * 24 * 60 * 60 * 1000), 2);
  assert.equal(await journal.get(old.id), null);
  assert.equal(await journal.get(fresh.id), null);
});

test('the journal directory contains only JSON records (no temp leftovers)', async (t) => {
  const dir = tempDir(t);
  const journal = createJobJournal({ dir: dir });
  await journal.create({ status: 'submitted' });
  await journal.create({ status: 'saved' });
  const names = readdirSync(dir);
  assert.equal(names.length, 2);
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]+\.json$/);
});
