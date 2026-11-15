import test from 'node:test';
import assert from 'node:assert/strict';

import { promptSectionText, sizeRuleText } from '../lib/prompt-profiles.js';

/* 系统提示词里的尺寸说法必须和 sizeMode 一致，否则模型会照着旧的"不许传 size"办事。 */

test('a fixed size tells the model not to send size', () => {
  const text = promptSectionText({ model: 'flux-2-pro', sizeMode: 'fixed', size: '1024x1024' });
  assert.match(text, /尺寸已固定为 1024x1024，不要传 size/);
  assert.match(text, /质量、提供商、模型同样由选择器控制/);
});

test('an auto size lets the model send size and lists the options', () => {
  const text = promptSectionText({ model: 'flux-2-pro', sizeMode: 'auto', sizeOptions: ['1024x1024', '1536x1024'] });
  assert.match(text, /尺寸由你决定/);
  assert.doesNotMatch(text, /不要传 size/);
  assert.match(text, /1536x1024/);
});

test('an auto size without options still lets the model pass a size', () => {
  const text = promptSectionText({ model: 'flux-2-pro', sizeMode: 'auto' });
  assert.match(text, /传 size/);
  assert.doesNotMatch(text, /不要传 size/);
});

test('the Auto-model section carries the size rule too', () => {
  const text = promptSectionText({ model: 'auto', models: ['m1'], sizeMode: 'auto' });
  assert.match(text, /尺寸由你决定/);
  assert.match(text, /模型必须从上面列表里传/);
});

test('the Auto-model section gets the fixed wording when the picker pins a size', () => {
  const text = promptSectionText({ model: 'auto', models: ['m1'], sizeMode: 'fixed', size: '768x1024' });
  assert.match(text, /尺寸已固定为 768x1024/);
  assert.doesNotMatch(text, /模型同样由选择器控制/);
});

test('strict is announced in both modes', () => {
  assert.match(sizeRuleText({ sizeMode: 'fixed', size: '512x512', strict: true }), /严格模式已开/);
  assert.match(sizeRuleText({ sizeMode: 'auto', strict: true }), /严格模式已开/);
  assert.doesNotMatch(sizeRuleText({ sizeMode: 'auto', strict: false }), /严格模式已开/);
});

test('an aspect adapter explains that only the ratio matters', () => {
  assert.match(sizeRuleText({ sizeMode: 'fixed', control: 'aspect', aspect: '3:4', tier: '2K' }), /只吃宽高比/);
});

test('a prompt-only adapter says the size is already written into the prompt', () => {
  assert.match(sizeRuleText({ sizeMode: 'fixed', control: 'prompt', size: '1024x1024' }), /自动写进提示词/);
});

test('the optimization-off section carries the size rule instead of denying it', () => {
  const text = promptSectionText({ model: 'flux-2-pro', sizeMode: 'auto', promptOptimization: false });
  assert.match(text, /尺寸由你决定/);
  assert.doesNotMatch(text, /工具不接受这些参数/);
});
