import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readReferences, referenceLimitFor } from '../lib/index.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('readReferences keeps input order and returns image metadata', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mo-image-refs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = ['a.png', 'b.png', 'c.png'].map((name) => {
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.from(PNG_1PX, 'base64'));
    return file;
  });
  const images = await readReferences(files, new AbortController().signal, 1024 * 1024);
  assert.equal(images.length, 3);
  assert.deepEqual(images.map((image) => image.filename), ['a.png', 'b.png', 'c.png']);
  assert.ok(images.every((image) => image.contentType === 'image/png'));
  assert.ok(images.every((image) => image.buffer.length > 0));
});

test('readReferences rejects when the total reference size exceeds the limit', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mo-image-refs-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.png');
  writeFileSync(file, Buffer.from(PNG_1PX, 'base64'));
  await assert.rejects(() => readReferences([file], new AbortController().signal, 1), /大小超过/);
});

test('referenceLimitFor separates multipart and JSON edit budgets', () => {
  assert.equal(referenceLimitFor({ transport: { edit: 'multipart' } }), 48 * 1024 * 1024);
  assert.equal(referenceLimitFor({ transport: { edit: 'json' } }), 10 * 1024 * 1024);
  assert.equal(referenceLimitFor({}), 10 * 1024 * 1024);
});
