import test from 'node:test';
import assert from 'node:assert/strict';

import { configWriteReason } from '../lib/config-guard.js';

const CONFIG = 'C:\\Users\\x\\.dsh\\mo-image\\config.json';
const ROUTE = 'http://127.0.0.1:54003/api/mo-image/config';

test('reading the config through the read tool is allowed', () => {
  assert.equal(configWriteReason({ file_path: CONFIG }, 'read'), undefined);
  assert.equal(configWriteReason({ path: CONFIG }, 'read'), undefined);
});

test('searching the config is allowed', () => {
  assert.equal(configWriteReason({ path: CONFIG, pattern: 'models' }, 'grep'), undefined);
  assert.equal(configWriteReason({ file_path: CONFIG, pattern: 'models' }, 'grep'), undefined);
  assert.equal(configWriteReason({ pattern: '*.json', path: 'C:\\Users\\x\\.dsh\\mo-image' }, 'glob'), undefined);
  assert.equal(configWriteReason({ path: CONFIG }, 'read_image'), undefined);
});

test('writing the config through write or edit is still refused', () => {
  assert.match(configWriteReason({ file_path: CONFIG, content: '{}' }, 'write'), /配置/);
  assert.match(configWriteReason({ file_path: CONFIG, old_string: 'a', new_string: 'b' }, 'edit'), /配置/);
  assert.match(configWriteReason({ path: CONFIG }, 'str_replace_editor'), /配置/);
});

test('shell commands touching the config are still refused', () => {
  assert.match(configWriteReason({ command: 'Get-Content ' + CONFIG }, 'pwsh'), /配置/);
  assert.match(configWriteReason({ command: 'echo {} > ' + CONFIG }, 'pwsh'), /配置/);
  assert.match(configWriteReason({ command: 'cat ' + CONFIG }, 'bash'), /配置/);
});

test('a tool call without a tool name stays denied, so unknown callers cannot slip through', () => {
  assert.match(configWriteReason({ path: CONFIG }), /配置/);
  assert.match(configWriteReason({ url: ROUTE, body: '{}' }), /配置/);
});

test('an unknown tool that targets the config is denied', () => {
  assert.match(configWriteReason({ file_path: CONFIG }, 'some_custom_tool'), /配置/);
  assert.match(configWriteReason({ url: ROUTE }, 'fetch'), /配置/);
});

test('read-only tools are not blocked by unrelated arguments', () => {
  assert.equal(configWriteReason({ prompt: '画一只猫' }, 'read'), undefined);
  assert.equal(configWriteReason({ prompt: '画一只猫' }, 'mo_image_generate'), undefined);
});
