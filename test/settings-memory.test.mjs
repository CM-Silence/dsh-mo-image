import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsMemory, settingsSnapshot, SETTINGS_REFRESH_TURNS } from '../lib/settings-memory.js';

const first = settingsSnapshot({ provider: 'p1', model: 'flux', size: '512x512', hint: 'FLUX' });
const second = settingsSnapshot({ provider: 'p1', model: 'flux', size: '1024x1024', hint: 'FLUX' });
const context = {
  get(name) {
    if (name === 'agents') return { turnBoundaryOf: (session) => ({ lastTurn: session.turn }) };
  }
};

test('snapshots are isolated and only changed fields update the current revision', () => {
  const memory = createSettingsMemory(context);
  const one = { turn: 1 };
  const two = { turn: 1 };
  assert.equal(memory.state(one, first.signature), 'unread');
  assert.equal(memory.read(one, first).reply.revision, 1);
  assert.equal(memory.state(one, first.signature), 'fresh');
  assert.equal(memory.state(one, second.signature), 'stale');
  assert.equal(memory.state(two, second.signature), 'unread');
  assert.deepEqual(memory.read(one, second).reply, {
    baseRevision: 1, revision: 2, changes: { size: '1024x1024' }, hint: '应用变更，保留其余字段。'
  });
  assert.equal(memory.read(one, second).reply.unchanged, true);
  assert.equal(memory.read(two, second).reply.size, '1024x1024');
  assert.equal(memory.read(null, second).reply.size, '1024x1024');
});

test('turn expiry measures from the last full snapshot and resets after a refresh', () => {
  const memory = createSettingsMemory(context);
  const session = { turn: 1 };
  memory.read(session, first);
  session.turn += SETTINGS_REFRESH_TURNS - 1;
  assert.equal(memory.read(session, second).reply.baseRevision, 1);
  assert.equal(memory.read(session, second).reply.unchanged, true);

  session.turn++;
  assert.equal(memory.state(session, second.signature), 'refresh');
  const full = memory.read(session, second).reply;
  assert.equal(full.size, '1024x1024');
  assert.equal(full.revision, 2);
  assert.equal(memory.read(session, second).reply.unchanged, true);

  session.turn++;
  memory.read(session, second, { refresh: true });
  session.turn += SETTINGS_REFRESH_TURNS - 1;
  assert.equal(memory.read(session, second).reply.unchanged, true);
});

test('legacy host expiry counts unique steps and ignores repeated reads in the same step', () => {
  const memory = createSettingsMemory({});
  const session = {};
  const step = {};
  memory.read(session, first, { step });
  for (let i = 0; i < SETTINGS_REFRESH_TURNS; i++) {
    assert.equal(memory.read(session, first, { step }).reply.unchanged, true);
  }
  for (let i = 1; i < SETTINGS_REFRESH_TURNS; i++) {
    assert.equal(memory.read(session, first, { step: {} }).reply.unchanged, true);
  }
  assert.equal(memory.read(session, first, { step: {} }).reply.model, 'flux');
});

test('candidate baselines are independent across providers and refresh after a context change', () => {
  const memory = createSettingsMemory(context);
  const session = { turn: 1, surface: { contentGeneration: 0 } };
  const candidate = { candidate: true };
  const other = settingsSnapshot({ ...first.payload, provider: 'p2' });
  memory.read(session, first, candidate);
  assert.equal(memory.read(session, other, candidate).reply.provider, 'p2');
  assert.equal(memory.read(session, first, candidate).reply.unchanged, true);
  assert.equal(memory.state(session, first.signature), 'unread');
  session.surface.contentGeneration++;
  assert.equal(memory.read(session, second, candidate).reply.size, '1024x1024');
});

test('catalog reordering updates model-facing editable indexes', () => {
  const memory = createSettingsMemory(context);
  const session = { turn: 1 };
  const catalog = { provider: 'p1', model: 'auto', models: ['a', 'b'], editModels: ['a'], hint: 'Auto' };
  memory.read(session, settingsSnapshot(catalog));
  const reordered = settingsSnapshot({ ...catalog, models: ['b', 'a'] });
  assert.deepEqual(memory.read(session, reordered).reply.changes, { models: ['b', 'a'], editModelIndexes: [1] });
});
