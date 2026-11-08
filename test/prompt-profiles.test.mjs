import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePromptProfile, promptSectionText, listPromptProfiles
} from '../lib/prompt-profiles.js';
import { resolveAdapter, prepareGenerate } from '../lib/adapters.js';

const provider = { baseUrl: 'https://example.test/v1', key: 'test-key' };

test('resolves the prompt profile by model family', () => {
  assert.equal(resolvePromptProfile('gpt-image-2.5-flare').id, 'gpt-image');
  assert.equal(resolvePromptProfile('gpt-image-2.5-sunburst').id, 'gpt-image');
  assert.equal(resolvePromptProfile('dall-e-3').id, 'dall-e-3');
  assert.equal(resolvePromptProfile('flux-kontext-pro').id, 'flux');
  assert.equal(resolvePromptProfile('seedream-4.0').id, 'seedream');
  assert.equal(resolvePromptProfile('qwen-image').id, 'qwen-image');
  assert.equal(resolvePromptProfile('nano-banana-pro').id, 'nano-banana');
  assert.equal(resolvePromptProfile('stable-diffusion-3.5-large').id, 'stable-diffusion');
  assert.equal(resolvePromptProfile('wanx2.1-t2i-turbo').id, 'wanx');
  assert.equal(resolvePromptProfile('kolors').id, 'kolors');
});

test('falls back to the adapter when the model id is unknown', () => {
  assert.equal(resolvePromptProfile('mystery-model', { id: 'gpt-image' }).id, 'gpt-image');
  assert.equal(resolvePromptProfile('mystery-model', { id: 'dall-e-3' }).id, 'dall-e-3');
  assert.equal(resolvePromptProfile('mystery-model', { id: 'stability' }).id, 'stable-diffusion');
  assert.equal(resolvePromptProfile('mystery-model', { id: 'dashscope-wanx' }).id, 'wanx');
});

test('falls back to the generic profile', () => {
  assert.equal(resolvePromptProfile('').id, 'generic');
  assert.equal(resolvePromptProfile('some-compatible-model').id, 'generic');
  assert.ok(listPromptProfiles().length >= 10);
});

test('empty state contributes no prompt section', () => {
  assert.equal(promptSectionText({ model: '' }), '');
  assert.equal(promptSectionText(null), '');
});

test('prompt section forbids judging the image and switching models', () => {
  const on = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: true });
  const off = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  for (const text of [on, off]) {
    assert.match(text, /不评价画质/);
    assert.match(text, /不打开或读取图片/);
    assert.match(text, /不要自行切换/);
    assert.match(text, /可以问用户/);
  }
});

test('section names the active model, formula and edit model', () => {
  const text = promptSectionText({
    model: 'gpt-image-2.5-flare',
    adapter: { id: 'gpt-image' },
    editModel: 'gpt-image-2.5-sunburst',
    editAdapter: { id: 'gpt-image' }
  });
  assert.match(text, /gpt-image-2\.5-flare/);
  assert.match(text, /OpenAI GPT-Image/);
  assert.match(text, /主体 \+ 动作 \+ 环境/);
  assert.match(text, /gpt-image-2\.5-sunburst/);
  assert.match(text, /无 negative prompt/);
  assert.match(text, /<\/mo-image-prompt>/);
});

test('model-specific negative prompt guidance is accurate', () => {
  const qwen = promptSectionText({ model: 'qwen-image' });
  assert.match(qwen, /支持 negative prompt/);
  const flux = promptSectionText({ model: 'flux-kontext-pro' });
  assert.match(flux, /无 negative prompt/);
});

test('prompt optimization off instructs raw user wording', () => {
  const text = promptSectionText({
    model: 'gpt-image-2.5-flare',
    adapter: { id: 'gpt-image' },
    promptOptimization: false
  });
  assert.match(text, /提示词优化：Off/);
  assert.match(text, /用户原话/);
  assert.match(text, /不要扩写/);
  assert.match(text, /不要自动补 negative_prompt/);
  assert.match(text, /尺寸、质量、提供商、模型由用户选择器控制/);
  assert.doesNotMatch(text, /生成公式/);
  assert.doesNotMatch(text, /主体 \+ 动作 \+ 环境/);
});

test('both prompt modes keep generation parameters out of tool args', () => {
  const on = promptSectionText({ model: 'gpt-image-2.5-flare' });
  const off = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  for (const text of [on, off]) {
    assert.match(text, /尺寸、质量、提供商、模型由用户选择器控制/);
    assert.match(text, /工具不接受这些参数/);
  }
});

test('negative prompt is sent only to adapters that whitelist it', () => {
  const gpt = resolveAdapter({ baseUrl: 'https://api.example.test/v1' }, 'gpt-image-2.5-flare');
  const gptBody = JSON.parse(prepareGenerate(gpt, provider, {
    model: 'gpt-image-2.5-flare', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(gptBody.negative_prompt, undefined);

  const silicon = resolveAdapter({ baseUrl: 'https://api.siliconflow.cn/v1' }, 'kwai-kolors/kolors');
  const siliconBody = JSON.parse(prepareGenerate(silicon, provider, {
    model: 'kwai-kolors/kolors', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(siliconBody.negative_prompt, 'bad');

  const generic = resolveAdapter({ baseUrl: 'https://api.example.test/v1' }, 'some-compatible-model');
  const genericBody = JSON.parse(prepareGenerate(generic, provider, {
    model: 'some-compatible-model', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(genericBody.negative_prompt, 'bad');
});
