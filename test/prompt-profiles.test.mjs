import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePromptProfile, promptSectionText, listPromptProfiles,
  configStateText, CONFIG_STATE_MARKER
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
  // 兜底只认**还存在的**协议 id：gpt-image / dall-e-3 / volcengine-ark 已经合并进
  // openai-images（同一条协议下两个模型族要的写法还相反），那两族的兜底交给模型名匹配。
  assert.equal(resolvePromptProfile('mystery-model', { id: 'openai-images' }).id, 'generic');
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
    assert.match(text, /除非用户明确要求看图/);
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
  assert.match(text, /尺寸由你决定/);
  assert.doesNotMatch(text, /生成公式/);
  assert.doesNotMatch(text, /主体 \+ 动作 \+ 环境/);
});

test('neither prompt mode makes the model echo the selected model id', () => {
  const on = promptSectionText({ model: 'gpt-image-2.5-flare' });
  const off = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  for (const text of [on, off]) {
    assert.doesNotMatch(text, /必须传 model/);
  }
});

test('both prompt modes describe who owns the size', () => {
  const on = promptSectionText({ model: 'gpt-image-2.5-flare' });
  const off = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  for (const text of [on, off]) {
    // 默认是「自动尺寸」：模型可以传 size，质量/提供商/模型仍由选择器控制。
    assert.match(text, /尺寸由你决定/);
    assert.match(text, /质量、提供商、模型/);
  }
});

test('the config-state marker is one line the host can interpolate', () => {
  const on = promptSectionText({ model: 'gpt-image-2.5-flare' }, CONFIG_STATE_MARKER);
  const off = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false }, CONFIG_STATE_MARKER);
  const auto = promptSectionText({ model: 'auto', models: ['gpt-image-2.5-flare'] }, CONFIG_STATE_MARKER);
  for (const text of [on, off, auto]) {
    assert.match(text, /\{\{mo_image_config\}\}/, 'the section carries the placeholder, not a stale value');
    const lines = text.split('\n').filter((line) => line.includes('{{mo_image_config}}'));
    assert.equal(lines.length, 1, 'the marker appears exactly once');
    assert.match(lines[0], /配置状态/);
  }
});

test('no marker line is added when the host cannot interpolate it', () => {
  for (const state of [
    { model: 'gpt-image-2.5-flare' },
    { model: 'gpt-image-2.5-flare', promptOptimization: false },
    { model: 'auto', models: ['gpt-image-2.5-flare'] }
  ]) {
    assert.doesNotMatch(promptSectionText(state), /配置状态/);
  }
});

test('each config state explains whether the settings tool has to be read', () => {
  assert.match(configStateText('unread'), /还没读过/);
  assert.match(configStateText('unread'), /mo_image_settings/);
  assert.match(configStateText('stale'), /改过/);
  assert.match(configStateText('stale'), /mo_image_settings/);
  assert.match(configStateText('fresh'), /一致/);
  assert.match(configStateText('fresh'), /不用再读/);
  assert.equal(configStateText('nonsense'), configStateText('unread'), 'an unknown state must fail safe');
});

test('negative prompt follows the field template, not a protocol whitelist', () => {
  // 官方 OpenAI 端点收未知参数会 400：negative 归零。
  const official = { baseUrl: 'https://api.openai.com/v1' };
  const officialAdapter = resolveAdapter(official, 'gpt-image-2.5-flare');
  const officialBody = JSON.parse(prepareGenerate(officialAdapter, official, {
    model: 'gpt-image-2.5-flare', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(officialBody.negative_prompt, undefined);

  // 中转站上的同名模型一直收 negative_prompt，别把所有人都当成官方端点。
  const relay = resolveAdapter({ baseUrl: 'https://api.example.test/v1' }, 'gpt-image-2.5-flare');
  const relayBody = JSON.parse(prepareGenerate(relay, provider, {
    model: 'gpt-image-2.5-flare', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(relayBody.negative_prompt, 'bad');

  const silicon = resolveAdapter({ baseUrl: 'https://api.siliconflow.cn/v1' }, 'kwai-kolors/kolors');
  const siliconBody = JSON.parse(prepareGenerate(silicon, provider, {
    model: 'kwai-kolors/kolors', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(siliconBody.negative_prompt, 'bad');

  // 认不出的网关按 OpenAI 兼容兜底，同样发 negative_prompt。
  const generic = resolveAdapter({ baseUrl: 'https://api.example.test/v1' }, 'some-compatible-model');
  const genericBody = JSON.parse(prepareGenerate(generic, provider, {
    model: 'some-compatible-model', prompt: 'p', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.equal(genericBody.negative_prompt, 'bad');
});
