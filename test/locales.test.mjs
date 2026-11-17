import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_LOCALES,
  parseMessages,
  validateMessages,
  renderLocaleBlock,
  checkLocaleBlock,
  collectTranslationKeys,
  BEGIN_MARKER,
  END_MARKER
} from '../scripts/build-locales.mjs';
import { LOCAL_PRESETS, adapterManifest } from '../lib/adapters.js';
import { SERVER_ERROR_CODES, NETWORK_HINT_CODES } from '../lib/localized-error.js';

const csv = readFileSync(new URL('../locale/messages.csv', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const parsed = parseMessages(csv);

const QUALITY_VALUES = ['off', 'low', 'medium', 'high', 'max', 'auto', 'standard', 'hd', 'default', 'quality', 'turbo'];

test('CSV declares the key column and all eight DSH locales', () => {
  assert.deepEqual(parsed.locales, BUILTIN_LOCALES);
  validateMessages(parsed);
});

test('every locale carries every key with a non-empty value', () => {
  for (const locale of parsed.locales) {
    const dict = parsed.messages[locale];
    assert.deepEqual(Object.keys(dict), parsed.keys, `${locale} key order/count drift`);
    for (const key of parsed.keys) assert.ok(dict[key].trim().length > 0, `${locale}:${key} is empty`);
  }
});

test('placeholders match across locales', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of parsed.keys) {
    const expected = placeholders(parsed.messages.zh[key]);
    for (const locale of parsed.locales) {
      assert.equal(placeholders(parsed.messages[locale][key]), expected, `${locale}:${key} placeholder drift`);
    }
  }
});

test('the CSV contains no zero-width characters or byte-order marks', () => {
  assert.doesNotMatch(csv, /[\u200B\uFEFF]/u);
});

test('the generated block in lib/client.js matches the CSV', () => {
  const result = checkLocaleBlock(clientSource, parsed);
  assert.equal(result.ok, true, result.message);
  assert.match(clientSource, new RegExp(BEGIN_MARKER));
  assert.match(clientSource, new RegExp(END_MARKER));
});

test('every literal t() key in the client exists in the CSV', () => {
  const missing = collectTranslationKeys(clientSource).filter((key) => !parsed.keys.includes(key));
  assert.deepEqual(missing, []);
});

test('dynamic quality and local-preset keys exist in the CSV', () => {
  const keys = new Set(parsed.keys);
  for (const value of QUALITY_VALUES) assert.ok(keys.has(`quality.${value}`), `missing quality.${value}`);
  for (const preset of LOCAL_PRESETS) {
    assert.ok(keys.has(`localPreset.${preset.id}.hint`), `missing localPreset.${preset.id}.hint`);
    assert.ok(keys.has(`localPreset.${preset.id}.urlHint`), `missing localPreset.${preset.id}.urlHint`);
  }
});

// 协议级选项的文案键是客户端拼出来的（form.protocolOption <name> / <value> / Hint），
// 字面量扫描看不见它们，所以这里按宿主清单（adapterManifest().options）逐项核对。
test('dynamic protocol option keys exist in the CSV', () => {
  const keys = new Set(parsed.keys);
  const withOptions = adapterManifest().filter((adapter) => Array.isArray(adapter.options) && adapter.options.length);
  assert.ok(withOptions.length > 0, '一条带选项的协议都没有：清单是不是退回旧样子了');
  for (const adapter of withOptions) {
    for (const option of adapter.options) {
      assert.ok(keys.has(`form.protocolOption.${option.name}`), `missing form.protocolOption.${option.name}`);
      assert.ok(keys.has(`form.protocolOption.${option.name}Hint`), `missing form.protocolOption.${option.name}Hint`);
      for (const value of option.values) {
        assert.ok(
          keys.has(`form.protocolOption.${option.name}.${value}`),
          `missing form.protocolOption.${option.name}.${value}`
        );
      }
    }
  }
});

// 协议名与分组标题同样是客户端拼出来的键（protocol.<id> / protocolGroup.<id>），
// 字面量扫描看不见；按宿主清单逐条核对，漏一条下拉里就会露出键名。
test('dynamic protocol label and group keys exist in the CSV', () => {
  const keys = new Set(parsed.keys);
  const manifest = adapterManifest();
  assert.ok(manifest.length > 0, '一条协议都没有：清单是不是退回旧样子了');
  for (const adapter of manifest) {
    assert.ok(keys.has('protocol.' + adapter.id), `missing protocol.${adapter.id}`);
    assert.ok(keys.has('protocolGroup.' + adapter.group), `missing protocolGroup.${adapter.group}`);
  }
});

test('every host server-error code has a translation', () => {
  const keys = new Set(parsed.keys);
  for (const code of SERVER_ERROR_CODES) {
    if (code === 'network.failed') continue; // composed from serverError.network.* below
    assert.ok(keys.has(`serverError.${code}`), `missing serverError.${code}`);
  }
  for (const hint of NETWORK_HINT_CODES) assert.ok(keys.has(`serverError.network.hint.${hint}`), `missing network hint ${hint}`);
  for (const key of ['serverError.network.format', 'serverError.network.viaDirect', 'serverError.network.viaIndirect']) {
    assert.ok(keys.has(key), `missing ${key}`);
  }
});

test('renderLocaleBlock produces the same text the client carries', () => {
  const block = renderLocaleBlock(parsed);
  assert.match(block, new RegExp(BEGIN_MARKER));
  assert.match(block, /const MESSAGES = \{/);
  assert.match(block, /"zh": \{/);
  assert.match(block, /"nav": "生图模型"/);
});
