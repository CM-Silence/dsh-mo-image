import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsSignature, rememberSettings, settingsState } from '../lib/settings-memory.js';

test('a session that never read the settings is unread', () => {
  assert.equal(settingsState({ id: 'fresh-session' }, 'sig-1'), 'unread');
});

test('a remembered snapshot stays fresh while the payload is identical', () => {
  const session = {};
  rememberSettings(session, 'sig-1');
  assert.equal(settingsState(session, 'sig-1'), 'fresh');
  assert.equal(settingsState(session, 'sig-2'), 'stale');
});

test('changing a value and changing it back counts as no change', () => {
  const session = {};
  rememberSettings(session, settingsSignature({ model: 'flux' }));
  // 用户改成别的值，又改回原值，中间没有对话：比较的是快照而不是变更次数。
  assert.equal(settingsState(session, settingsSignature({ model: 'moss' })), 'stale');
  assert.equal(settingsState(session, settingsSignature({ model: 'flux' })), 'fresh');
});

test('the signature is the stable rendering of the payload', () => {
  const payload = { provider: 'p1', model: 'flux', promptOptimization: true };
  assert.equal(settingsSignature(payload), settingsSignature({ ...payload }));
  assert.notEqual(settingsSignature(payload), settingsSignature({ ...payload, model: 'moss' }));
});

test('sessions never share a snapshot', () => {
  const one = {};
  const two = {};
  rememberSettings(one, 'sig-1');
  assert.equal(settingsState(two, 'sig-1'), 'unread');
  assert.equal(settingsState(one, 'sig-1'), 'fresh');
});

test('a script call without a session has nothing to compare', () => {
  assert.equal(settingsState(null, 'sig-1'), 'unread');
  assert.equal(settingsState(undefined, 'sig-1'), 'unread');
  rememberSettings(null, 'sig-1');
  rememberSettings(undefined, 'sig-1');
});

test('a non-object session key is ignored instead of throwing', () => {
  assert.doesNotThrow(() => rememberSettings('session-id', 'sig-1'));
  assert.equal(settingsState('session-id', 'sig-1'), 'unread');
});
