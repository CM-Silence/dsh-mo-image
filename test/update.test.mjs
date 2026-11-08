import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions, tagToVersion, classifySource, judgeMarker,
  readMarker, clearMarker, fetchLatestRelease
} from '../lib/update.js';

test('compareVersions orders releases, prereleases and junk', () => {
  assert.equal(compareVersions('0.3.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.3.9'), 1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0-rc.2'), -1);
  assert.equal(compareVersions('nope', '0.4.0'), null);
});

test('tagToVersion strips the v prefix and rejects non versions', () => {
  assert.equal(tagToVersion('v0.4.0'), '0.4.0');
  assert.equal(tagToVersion('0.4.0'), '0.4.0');
  assert.equal(tagToVersion('v0.4.0-rc.1'), '0.4.0-rc.1');
  assert.equal(tagToVersion('nightly'), '');
  assert.equal(tagToVersion(''), '');
});

test('classifySource separates local links from installable specs', () => {
  assert.equal(classifySource('link:F:/repo/dsh-mo-image'), 'link');
  assert.equal(classifySource('file:C:\\repo'), 'link');
  assert.equal(classifySource('github:CM-Silence/dsh-mo-image'), 'git');
  assert.equal(classifySource('git+https://github.com/CM-Silence/dsh-mo-image.git'), 'git');
  assert.equal(classifySource('https://github.com/CM-Silence/dsh-mo-image/archive/refs/tags/v0.4.0.tar.gz'), 'tarball');
  assert.equal(classifySource(undefined), 'unknown');
  assert.equal(classifySource(''), 'unknown');
});

test('judgeMarker decides done, updating and failed from the current version', () => {
  assert.deepEqual(judgeMarker(null, '0.3.1', 1000), { state: 'none' });
  const marker = { from: '0.3.1', to: '0.4.0', startedAt: 1000 };
  assert.deepEqual(judgeMarker(marker, '0.4.0', 2000), { state: 'done', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.3.1', 2000), { state: 'updating', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.3.1', 1000 + 90_001), { state: 'failed', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.5.0', 2000), { state: 'done', to: '0.4.0' });
});

test('readMarker treats broken json as absent and clearMarker removes the file', (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'mo-update-')), 'update.json');
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(readMarker(file), null);
  writeFileSync(file, '{', 'utf8');
  assert.equal(readMarker(file), null);
  writeFileSync(file, JSON.stringify({ from: '0.3.1', to: '0.4.0', startedAt: 1 }), 'utf8');
  assert.equal(readMarker(file).to, '0.4.0');
  clearMarker(file);
  assert.equal(readMarker(file), null);
});

test('fetchLatestRelease reads the api, falls back to the redirect, else null', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/repos/CM-Silence/dsh-mo-image/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v0.4.0', body: '- 修复：{braces}\n- 新增', html_url: 'u1' }));
      return;
    }
    if (req.url === '/CM-Silence/dsh-mo-image/releases/latest') {
      res.writeHead(302, { location: '/CM-Silence/dsh-mo-image/releases/tag/v0.4.0' });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const viaApi = await fetchLatestRelease({ apiBase: base, releasesBase: base, request: fetch });
  assert.equal(viaApi.version, '0.4.0');
  assert.equal(viaApi.notes, '- 修复：{braces}\n- 新增');
  assert.equal(viaApi.via, 'api');

  const viaRedirect = await fetchLatestRelease({ apiBase: `${base}/missing`, releasesBase: base, request: fetch });
  assert.deepEqual(viaRedirect, { version: '0.4.0', notes: '', url: `${base}/CM-Silence/dsh-mo-image/releases/tag/v0.4.0`, via: 'redirect' });

  const none = await fetchLatestRelease({ apiBase: `${base}/x`, releasesBase: `${base}/y`, request: fetch });
  assert.equal(none, null);
});
