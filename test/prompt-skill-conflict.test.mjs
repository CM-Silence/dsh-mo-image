import test from 'node:test';
import assert from 'node:assert/strict';

import { promptSectionText } from '../lib/prompt-profiles.js';

test('prompt optimization off still allows loading the generation skill', () => {
  const text = promptSectionText({ model: 'gpt-image-2.5-flare', promptOptimization: false });
  assert.match(text, /加载 skill/);
  assert.match(text, /不要套用.*公式/);
});

test('auto mode off still allows loading the generation skill', () => {
  const text = promptSectionText({
    model: 'auto',
    promptOptimization: false,
    models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']
  });
  assert.match(text, /提示词优化：Off/);
  assert.match(text, /加载 skill/);
  assert.match(text, /不要套用.*公式/);
});

test('auto mode on advertises the generation skill', () => {
  const text = promptSectionText({
    model: 'auto',
    promptOptimization: true,
    models: ['gpt-image-2.5-flare']
  });
  assert.match(text, /可加载 skill/);
});
