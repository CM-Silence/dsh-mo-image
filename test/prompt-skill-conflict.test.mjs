import test from 'node:test';
import assert from 'node:assert/strict';

import { promptSectionText } from '../lib/prompt-profiles.js';

test('prompt optimization off only loads missing invocation guidance', () => {
  const text = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  assert.match(text, /复用上下文已有写法；缺少所需指引时才加载相应 skill/);
  assert.match(text, /不要套用.*公式/);
});

test('Auto with optimization off only loads missing invocation guidance', () => {
  const text = promptSectionText({
    model: 'auto',
    promptOptimization: false,
    models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']
  });
  assert.match(text, /提示词优化：Off/);
  assert.match(text, /缺少所需指引时才加载相应 skill/);
  assert.match(text, /不要套用.*公式/);
});

test('optimization reuses visible instructions and ready prompts for fixed and Auto models', () => {
  for (const model of ['auto', 'gpt-image-2.5-flare']) {
    const text = promptSectionText({ model, promptOptimization: true });
    assert.match(text, /优化粗略需求，保留主体、限制、指定语言和逐字文本/);
    assert.match(text, /已有适用成稿或用户要求原样时直接用/);
    assert.match(text, /复用上下文已有写法；缺少所需指引时才加载相应 skill/);
  }
});
