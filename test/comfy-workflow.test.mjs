import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWorkflow, uiToApi, analyzeWorkflow, injectByMapping } from '../lib/comfy-workflow.js';

const objectInfo = () => JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));
const mossText = () => readFileSync('test/fixtures/moss-t2i.api.json', 'utf8');
const moss = () => JSON.parse(mossText());
const sdUi = () => JSON.parse(readFileSync('test/fixtures/sd-t2i.ui.json', 'utf8'));

const fullMapping = () => ({
  prompt: { node: '18:17', input: 'value' },
  negative_prompt: { node: '18:5', input: 'text' },
  width: { node: '18:6', input: 'width' },
  height: { node: '18:6', input: 'height' },
  seed: { node: '18:7', input: 'seed' },
  model: null,
  image: null
});

/* ---------------------------------------------------------------- 解析 */

test('an API-format workflow is detected as api and keeps every node', () => {
  const result = parseWorkflow(mossText());
  assert.equal(result.format, 'api');
  assert.equal(Object.keys(result.graph).length, 17);
  assert.deepEqual(result.warnings, []);
});

test('a UI-format workflow is detected as ui and keeps its nodes and links', () => {
  const result = parseWorkflow(JSON.stringify(sdUi()));
  assert.equal(result.format, 'ui');
  assert.ok(Array.isArray(result.ui.nodes));
  assert.ok(Array.isArray(result.ui.links));
});

test('a BOM, line comments and trailing commas do not break parsing', () => {
  const text = '\uFEFF{ // exported by some tool\n "1": {"class_type":"SaveImage","inputs":{}},\n}\n';
  const result = parseWorkflow(text);
  assert.equal(result.format, 'api');
  assert.ok(result.graph['1']);
});

test('non-JSON text is rejected with a readable message', () => {
  assert.throws(() => parseWorkflow('not json at all'), /不是合法 JSON/);
});

test('a JSON array or scalar is rejected as an unsupported shape', () => {
  assert.throws(() => parseWorkflow('[1,2,3]'), /API 格式|UI 格式/);
  assert.throws(() => parseWorkflow('"hello"'), /API 格式|UI 格式/);
});

/* ------------------------------------------------------------ UI → API */

test('uiToApi maps widgets_values onto input names in schema order', () => {
  const { graph } = uiToApi(sdUi(), objectInfo());
  assert.equal(graph['4'].class_type, 'CheckpointLoaderSimple');
  assert.equal(graph['4'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors');
  assert.equal(graph['5'].inputs.width, 512);
  assert.equal(graph['5'].inputs.height, 512);
});

test('uiToApi links override widget values', () => {
  const { graph } = uiToApi(sdUi(), objectInfo());
  assert.deepEqual(graph['3'].inputs.model, ['4', 0]);
  assert.deepEqual(graph['3'].inputs.positive, ['6', 0]);
  assert.deepEqual(graph['3'].inputs.latent_image, ['5', 0]);
});

test('uiToApi skips the control_after_generate phantom widget after a seed', () => {
  const { graph } = uiToApi(sdUi(), objectInfo());
  assert.equal(graph['3'].inputs.seed, 42);
  assert.equal(graph['3'].inputs.steps, 20, 'steps must not shift by one');
  assert.equal(graph['3'].inputs.cfg, 7);
  assert.equal(graph['3'].inputs.sampler_name, 'euler');
});

test('uiToApi accepts object-shaped links as well as tuple links', () => {
  const ui = sdUi();
  ui.links = ui.links.map(([id, from, fromSlot, to, toSlot, type]) =>
    ({ id, origin_id: from, origin_slot: fromSlot, target_id: to, target_slot: toSlot, type }));
  const { graph } = uiToApi(ui, objectInfo());
  assert.deepEqual(graph['3'].inputs.model, ['4', 0]);
  assert.deepEqual(graph['3'].inputs.positive, ['6', 0]);
});

test('uiToApi reports node classes missing from object_info instead of guessing', () => {
  const ui = { nodes: [{ id: 1, type: 'MysteryNode', widgets_values: [1] }], links: [] };
  const { graph, warnings } = uiToApi(ui, objectInfo());
  assert.equal(graph['1'], undefined, 'an unknown class cannot be converted');
  assert.match(warnings.join('\n'), /MysteryNode/);
});

/* ---------------------------------------------------------------- 分析 */

test('analyzeWorkflow finds the MOSS prompt upstream of the LLM node, not at the CLIP node', () => {
  const { mapping } = analyzeWorkflow(moss(), objectInfo());
  assert.deepEqual(mapping.prompt, { node: '18:17', input: 'value' });
  assert.deepEqual(mapping.negative_prompt, { node: '18:5', input: 'text' });
});

test('analyzeWorkflow maps width and height to the latent node inputs', () => {
  const { mapping } = analyzeWorkflow(moss(), objectInfo());
  assert.deepEqual(mapping.width, { node: '18:6', input: 'width' });
  assert.deepEqual(mapping.height, { node: '18:6', input: 'height' });
});

test('analyzeWorkflow maps seed and model', () => {
  const { mapping } = analyzeWorkflow(moss(), objectInfo());
  assert.deepEqual(mapping.seed, { node: '18:7', input: 'seed' });
  assert.deepEqual(mapping.model, { node: '18:1', input: 'unet_name' });
});

test('analyzeWorkflow picks the sampler closest to the output and keeps the other as a candidate', () => {
  const graph = moss();
  graph['18:99'] = { class_type: 'KSampler', inputs: { ...graph['18:7'].inputs, seed: 1 } };
  graph['18:8'].inputs.samples = ['18:99', 0];
  const result = analyzeWorkflow(graph, objectInfo());
  assert.equal(result.samplerId, '18:99');
  assert.ok(result.candidates.seed.some((item) => item.node === '18:7'));
});

test('analyzeWorkflow reports no image input for a text-to-image graph', () => {
  const { mapping } = analyzeWorkflow(moss(), objectInfo());
  assert.equal(mapping.image, null);
});

test('analyzeWorkflow finds a LoadImage when the graph has one', () => {
  const graph = moss();
  graph['90'] = { class_type: 'LoadImage', inputs: { image: 'ref.png' } };
  const { mapping } = analyzeWorkflow(graph, objectInfo());
  assert.deepEqual(mapping.image, { node: '90', input: 'image' });
});

test('analyzeWorkflow rejects a graph without any output node', () => {
  const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } } };
  assert.throws(() => analyzeWorkflow(graph, objectInfo()), /没有输出节点/);
});

test('analyzeWorkflow offers every literal string input as a prompt candidate', () => {
  const { candidates } = analyzeWorkflow(moss(), objectInfo());
  const nodes = candidates.prompt.map((item) => item.node);
  assert.ok(nodes.includes('18:17'));
  assert.ok(nodes.includes('18:14'), 'the system prompt is offered as a candidate, just not the default');
});

/* ---------------------------------------------------------------- 注入 */

test('injectByMapping writes values and keeps numeric types', () => {
  const { graph } = injectByMapping(moss(), fullMapping(), {
    prompt: '一只猫', negativePrompt: 'blurry', width: 768, height: 512, seed: 7
  });
  assert.equal(graph['18:17'].inputs.value, '一只猫');
  assert.equal(graph['18:5'].inputs.text, 'blurry');
  assert.equal(graph['18:6'].inputs.width, 768);
  assert.equal(graph['18:6'].inputs.height, 512);
  assert.equal(graph['18:7'].inputs.seed, 7);
});

test('injectByMapping replaces a link when the target input is linked', () => {
  const graph = moss();
  graph['18:6'].inputs.width = ['19', 0];
  graph['18:6'].inputs.height = ['19', 1];
  const { graph: out } = injectByMapping(graph, fullMapping(), { width: 640, height: 384 });
  assert.equal(out['18:6'].inputs.width, 640);
  assert.equal(out['18:6'].inputs.height, 384);
});

test('injectByMapping never mutates the source graph', () => {
  const graph = moss();
  const before = JSON.stringify(graph);
  injectByMapping(graph, fullMapping(), { prompt: 'x' });
  assert.equal(JSON.stringify(graph), before);
});

test('injectByMapping reports a mapping that no longer matches the graph', () => {
  const graph = moss();
  delete graph['18:17'];
  assert.throws(() => injectByMapping(graph, fullMapping(), { prompt: 'x' }), /重新解析|失效/);
});

test('injectByMapping skips null entries without failing', () => {
  const { applied } = injectByMapping(moss(), fullMapping(), { prompt: 'x' });
  assert.ok(!applied.includes('image'));
  assert.ok(applied.includes('prompt'));
});

test('injectByMapping leaves untouched values alone when a field is not supplied', () => {
  const { graph } = injectByMapping(moss(), fullMapping(), { prompt: 'x' });
  assert.equal(graph['18:7'].inputs.seed, moss()['18:7'].inputs.seed);
});

/* ------------------------------------------------- FLUX.2 / SamplerCustomAdvanced */

const flux = () => JSON.parse(readFileSync('test/fixtures/flux-t2i.api.json', 'utf8'));

test('analyzeWorkflow reads prompt, seed and model through a custom sampler chain', () => {
  const { mapping, samplerId } = analyzeWorkflow(flux(), objectInfo());
  assert.equal(samplerId, '14', 'SamplerCustomAdvanced is the sampler');
  assert.deepEqual(mapping.prompt, { node: '8', input: 'text' });
  assert.deepEqual(mapping.seed, { node: '7', input: 'noise_seed' });
  assert.deepEqual(mapping.model, { node: '5', input: 'unet_name' });
  assert.deepEqual(mapping.width, { node: '15', input: 'width' });
  assert.deepEqual(mapping.height, { node: '15', input: 'height' });
});

test('analyzeWorkflow leaves negative empty instead of copying the positive prompt', () => {
  const { mapping } = analyzeWorkflow(flux(), objectInfo());
  assert.equal(mapping.negative_prompt, null);
});

test('uiToApi lists the classes it could not convert', () => {
  const ui = { nodes: [{ id: 1, type: 'MysteryNode', widgets_values: [1] }], links: [] };
  const { missing } = uiToApi(ui, objectInfo());
  assert.deepEqual(missing, ['MysteryNode']);
});
