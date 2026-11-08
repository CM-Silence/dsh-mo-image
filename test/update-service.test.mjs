import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateService, UPDATE_SPEC } from '../lib/update-service.js';
import { readMarker, writeMarker } from '../lib/update.js';

function releaseResponse(tag, body) {
  return {
    ok: true,
    async json() {
      return { tag_name: tag, body, html_url: `https://github.com/CM-Silence/dsh-mo-image/releases/tag/${tag}` };
    }
  };
}

function makeService(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mo-update-service-'));
  const markerFile = path.join(dir, 'update.json');
  const installs = [];
  const removed = [];
  const logs = [];
  const bundles = [{ name: 'dsh-mo-image', source: 'github:CM-Silence/dsh-mo-image' }];
  const pluginManager = {
    async listBundles() { return overrides.bundles || bundles; },
    async installBundle(spec, options) {
      installs.push({ spec, options });
      if (overrides.failNext) {
        const error = overrides.failNext;
        overrides.failNext = null;
        throw error;
      }
      return { result: { changed: true, application: 'restart-required' } };
    },
    async removeBundle(name) { removed.push(name); return {}; }
  };
  const service = createUpdateService({
    currentVersion: '0.3.1',
    markerFile,
    request: async () => releaseResponse('v0.4.0', '- 新'),
    pluginManager,
    log: (line) => logs.push(line),
    sleep: async () => {},
    installDelayMs: 0,
    ...overrides
  });
  return { service, markerFile, installs, removed, logs, pluginManager };
}

test('refresh turns a newer release into available', async () => {
  const { service } = makeService();
  await service.refresh();
  const status = service.status();
  assert.equal(status.state, 'available');
  assert.equal(status.current, '0.3.1');
  assert.equal(status.latest, '0.4.0');
  assert.equal(status.notes, '- 新');
  assert.equal(status.url, 'https://github.com/CM-Silence/dsh-mo-image/releases/tag/v0.4.0');
  assert.equal(status.installable, true);
});

test('refresh failure stays idle and logs', async () => {
  const logs = [];
  const { service } = makeService({
    request: async () => { throw new Error('fetch failed'); },
    log: (line) => logs.push(line)
  });
  await service.refresh();
  assert.equal(service.status().state, 'idle');
  assert.ok(logs.some((line) => line.includes('update check failed')));
});

test('apply installs the tagged git spec and writes a marker', async () => {
  const { service, markerFile, installs } = makeService();
  await service.refresh();
  const out = await service.apply('0.4.0');
  assert.deepEqual(out, { ok: true });
  assert.equal(service.status().state, 'updating');
  assert.equal(readMarker(markerFile).to, '0.4.0');
  assert.equal(readMarker(markerFile).from, '0.3.1');
  await service.settled();
  assert.equal(installs.length, 1);
  assert.equal(installs[0].spec, UPDATE_SPEC('0.4.0'));
  assert.equal(installs[0].spec, 'github:CM-Silence/dsh-mo-image#v0.4.0');
  assert.equal(typeof installs[0].options.requestId, 'string');
  assert.equal(installs[0].options.enabled, true);
});

test('apply refuses local link installs', async () => {
  const { service, installs } = makeService({ bundles: [{ name: 'dsh-mo-image', source: 'link:F:/repo/dsh-mo-image' }] });
  await service.refresh();
  assert.equal(service.status().installable, false);
  const out = await service.apply('0.4.0');
  assert.deepEqual(out, { ok: false, code: 'update.localDev' });
  assert.equal(installs.length, 0);
});

test('apply falls back to removeBundle on already-installed', async () => {
  const { service, installs, removed } = makeService({
    failNext: Object.assign(new Error('x'), { code: 'already-installed' })
  });
  await service.refresh();
  await service.apply('0.4.0');
  await service.settled();
  assert.deepEqual(removed, ['dsh-mo-image']);
  assert.equal(installs.length, 2);
  assert.equal(installs[0].spec, installs[1].spec);
});

test('hydrate reports done once and clears the marker', async () => {
  const { service, markerFile } = makeService({ currentVersion: '0.4.0' });
  writeMarker(markerFile, { from: '0.3.1', to: '0.4.0', startedAt: 1 });
  await service.hydrate();
  assert.equal(service.status().state, 'done');
  assert.equal(service.status().updatedBeforeRestart, true);
  assert.equal(readMarker(markerFile), null);
  await service.hydrate();
  assert.equal(service.status().state, 'idle');
});

test('apply is idempotent while an install is in flight', async () => {
  const { service, installs } = makeService();
  await service.refresh();
  const [first, second] = await Promise.all([service.apply('0.4.0'), service.apply('0.4.0')]);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  await service.settled();
  assert.equal(installs.length, 1);
});
