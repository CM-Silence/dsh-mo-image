import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { promptSectionText, CONFIG_STATE_MARKER } from '../lib/prompt-profiles.js';

/**
 * 常驻文本预算。F2 压缩前的实测基线（String.length，字符）：
 * - 固定模型 On（带配置 marker）：1155 → 现在 864
 * - 提示词优化 Off（同一状态，无 marker）：878 → 现在 712
 * - Auto On（同一状态，带 marker）：734 → 现在 590
 * 上限比实测略高，只用来挡住回涨，不锁死措辞。
 */
const ON_STATE = {
  model: 'gpt-image-2.5-flare',
  adapter: { id: 'openai-images' },
  canEdit: true,
  sizeMode: 'auto',
  sizeOptions: ['1024x1024', '1024x1536'],
  promptOptimization: true,
  workflowParams: [{ name: 'steps', type: 'INT' }, { name: 'seed', type: 'INT' }]
};

const AUTO_ON_STATE = {
  ...ON_STATE,
  model: 'auto',
  models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
  editModels: ['gpt-image-2.5-sunburst']
};

const ON = promptSectionText(ON_STATE, CONFIG_STATE_MARKER);
const AUTO_ON = promptSectionText(AUTO_ON_STATE, CONFIG_STATE_MARKER);
const OFF = promptSectionText({ ...ON_STATE, promptOptimization: false });
const OFF_WITH_MARKER = promptSectionText({ ...ON_STATE, promptOptimization: false }, CONFIG_STATE_MARKER);

test('the fixed-model prompt section stays inside its character budget', () => {
  assert.ok(ON.length <= 950, '固定模型 On 应 ≤ 950 字符，实际 ' + ON.length);
});

test('the auto prompt section stays inside its character budget', () => {
  assert.ok(AUTO_ON.length <= 700, 'Auto On 应 ≤ 700 字符，实际 ' + AUTO_ON.length);
});

test('the optimization-off prompt section stays inside its character budget', () => {
  assert.ok(OFF.length <= 800, '优化 Off 应 ≤ 800 字符，实际 ' + OFF.length);
});

test('the prompt modes keep the shared delivery and ownership rules', () => {
  for (const text of [ON, AUTO_ON, OFF]) {
    assert.match(text, /不评价画质/);
    assert.match(text, /除非用户明确要求看图/);
    assert.match(text, /不要自行切换/);
    assert.match(text, /可以问用户/);
    assert.match(text, /提供商和模型同样由选择器控制|提供商不能换/);
    assert.doesNotMatch(text, /必须传 model/);
  }
});

test('the optimization-off section keeps the raw-wording rules and no formula', () => {
  assert.match(OFF, /提示词优化：Off/);
  assert.match(OFF, /用户原话/);
  assert.match(OFF, /不要扩写/);
  assert.match(OFF, /不要自动补 negative_prompt/);
  assert.match(OFF, /尺寸由你决定/);
  assert.match(OFF, /缺少所需指引时才加载相应 skill/);
  assert.match(OFF, /不要套用.*公式/);
  assert.doesNotMatch(OFF, /生成公式/);
  assert.doesNotMatch(OFF, /主体 \+ 动作 \+ 环境/);
});

test('the model profile keeps its label, formula, edit rule and negative-prompt stance', () => {
  assert.match(ON, /<\/mo-image-prompt>/);
  assert.match(ON, /OpenAI GPT-Image/);
  assert.match(ON, /主体 \+ 动作 \+ 环境/);
  assert.match(ON, /无 negative prompt/);
  assert.match(promptSectionText({ model: 'qwen-image' }), /支持 negative prompt/);
  assert.match(AUTO_ON, /缺少所需指引时才加载相应 skill/);
});

test('the config-state marker stays a single line the host interpolates', () => {
  for (const text of [ON, AUTO_ON, OFF_WITH_MARKER]) {
    const lines = text.split('\n').filter((line) => line.includes(CONFIG_STATE_MARKER));
    assert.equal(lines.length, 1, 'marker 行只能出现一次');
    assert.match(lines[0], /配置状态/);
  }
});

/**
 * skill 文本预算。压缩前基线：
 * - skills/mo-image-generation/SKILL.md：9683 字符（现在 5296）
 * - skills/mo-image-editing/SKILL.md：4640 字符（现在 3239）
 * 上限取基线 × 0.8，即至少压缩 20%。
 */
const GENERATION_SKILL_BUDGET = 7746;
const EDITING_SKILL_BUDGET = 3712;

const GENERATION_SKILL = readFileSync('skills/mo-image-generation/SKILL.md', 'utf8');
const EDITING_SKILL = readFileSync('skills/mo-image-editing/SKILL.md', 'utf8');

test('the generation skill stays inside its character budget', () => {
  assert.ok(GENERATION_SKILL.length <= GENERATION_SKILL_BUDGET,
    '生成 skill 应 ≤ ' + GENERATION_SKILL_BUDGET + ' 字符，实际 ' + GENERATION_SKILL.length);
});

test('the editing skill stays inside its character budget', () => {
  assert.ok(EDITING_SKILL.length <= EDITING_SKILL_BUDGET,
    '编辑 skill 应 ≤ ' + EDITING_SKILL_BUDGET + ' 字符，实际 ' + EDITING_SKILL.length);
});

test('the compressed skills keep the rules that matter', () => {
  for (const phrase of ['主体 + 动作 + 环境', '参数调优', 'karras', 'denoising_strength', '图1/图2']) {
    assert.ok(GENERATION_SKILL.includes(phrase), '生成 skill 缺少：' + phrase);
  }
  for (const phrase of ['五类高权重约束词', '重绘幅度', '0.2–0.35', '图1/图2', 'negative_prompt']) {
    assert.ok(EDITING_SKILL.includes(phrase), '编辑 skill 缺少：' + phrase);
  }
  for (const word of ['保持', '修改', '添加', '删除', '替换']) {
    assert.ok(EDITING_SKILL.includes(word), '编辑 skill 缺少约束词：' + word);
  }
});
