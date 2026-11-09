import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions, tagToVersion, classifySource, judgeMarker,
  readMarker, clearMarker, fetchLatestVersion, fetchChangelogNotes,
  parseChangelogSection, parseChangelogFor, isHiddenPrerelease
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
  assert.deepEqual(judgeMarker(marker, '0.5.0', 2000), { state: 'stale' });
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

test('fetchLatestVersion reads npm and falls back to the mirror', async (t) => {
  let primaryDown = true;
  const server = createServer((req, res) => {
    if (req.url === '/dsh-mo-image/latest') {
      if (primaryDown) { res.writeHead(503); res.end('down'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'dsh-mo-image', version: '0.4.2' }));
      return;
    }
    if (req.url === '/mirror/dsh-mo-image/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'dsh-mo-image', version: '0.4.2' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const viaMirror = await fetchLatestVersion({ registryBase: base, mirrorBase: `${base}/mirror`, request: fetch });
  assert.equal(viaMirror.version, '0.4.2');
  assert.match(viaMirror.url, /npmjs\.com\/package\/dsh-mo-image\/v\/0\.4\.2/);

  primaryDown = false;
  const viaPrimary = await fetchLatestVersion({ registryBase: base, mirrorBase: `${base}/mirror`, request: fetch });
  assert.equal(viaPrimary.version, '0.4.2');

  const reasons = [];
  const none = await fetchLatestVersion({
    registryBase: `${base}/x`, mirrorBase: `${base}/y`, request: fetch,
    onError: (reason) => reasons.push(reason)
  });
  assert.equal(none, null);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /503|HTTP 404/);
});

test('alpha and beta versions are never offered as an update', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'dsh-mo-image', version: '0.9.0-b2' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const beta = await fetchLatestVersion({ registryBase: base, mirrorBase: `${base}/mirror`, request: fetch });
  assert.equal(beta, null);

  assert.equal(isHiddenPrerelease('0.9.0-a1'), true);
  assert.equal(isHiddenPrerelease('0.9.0-b2'), true);
  assert.equal(isHiddenPrerelease('0.9.0-rc1'), false);
  assert.equal(isHiddenPrerelease('0.9.0'), false);
});

test('parseChangelogSection returns exactly the requested release', () => {
  const changelog = [
    '# 更新日志',
    '',
    '## v0.4.2',
    '',
    '### 新功能',
    '',
    '- 自动更新检查改读 npm',
    '',
    '## v0.4.1',
    '',
    '- 旧版本'
  ].join('\n');
  const section = parseChangelogSection(changelog, '0.4.2');
  assert.match(section, /自动更新检查改读 npm/);
  assert.doesNotMatch(section, /旧版本/);
  assert.equal(parseChangelogSection(changelog, 'v0.4.2'), section);
  assert.equal(parseChangelogSection(changelog, '9.9.9'), '');
});

test('parseChangelogFor accepts a section written as vX-latest', () => {
  const changelog = ['# 更新日志', '', '## v0.4.1-latest', '', '- 写成 latest', ''].join('\n');
  assert.equal(parseChangelogFor(changelog, '0.4.1'), '- 写成 latest');
  assert.equal(parseChangelogFor(changelog, '0.5.0'), '');
});

test('fetchChangelogNotes tries each cdn and gives up quietly', async (t) => {  const server = createServer((req, res) => {
    if (req.url === '/ok/CHANGELOG.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end('## v0.4.2\n\n- 来自 CDN\n');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const notes = await fetchChangelogNotes('0.4.2', {
    request: fetch,
    cdnSources: [(version) => `${base}/missing/${version}/CHANGELOG.md`, (version) => `${base}/ok/CHANGELOG.md`]
  });
  assert.equal(notes, '- 来自 CDN');

  const empty = await fetchChangelogNotes('9.9.9', { request: fetch, cdnSources: [(v) => `${base}/ok/${v}/CHANGELOG.md`] });
  assert.equal(empty, '');
});
