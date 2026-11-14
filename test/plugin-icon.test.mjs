import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the manifest declares the plugin-list icon and ships it', () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json needs an icon field for the plugin manager card');
  assert.equal(pkg.icon, './icon.png');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('icon.png'), 'the icon must be published with the package');
});

test('the plugin-list icon is a decodable 256×256 png', () => {
  const bytes = readFileSync(new URL('../icon.png', import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 256);
  assert.equal(bytes.readUInt32BE(20), 256);
});
