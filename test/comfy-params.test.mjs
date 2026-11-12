import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectParams, applyWorkflowParams, analyzeWorkflow } from '../lib/comfy-workflow.js';

const objectInfo = () => JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));
const moss = () => JSON.parse(readFileSync('test/fixtures/moss-t2i.api.json', 'utf8'));

const mappingOf = () => ({
  prompt: { node: '18:17', input: 'value' },
  negative_prompt: { node: '18:5', input: 'text' },
  width: { node: '18:6', input: 'width' },
  height: { node: '18:6', input: 'height' },
  seed: { node: '18:7', input: 'seed' },
  model: { node: '18:1', input: 'unet_name' },
  image: null
});

test('collectParams returns only the tunable inputs present in the graph', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  const names = params.map((item) => item.name);
  assert.deepEqual(names, ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'batch_size']);
});

test('collectParams carries the default value and type', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  const steps = params.find((item) => item.name === 'steps');
  assert.equal(steps.node, '18:7');
  assert.equal(steps.default, 25);
  assert.equal(steps.type, 'INT');
  const sampler = params.find((item) => item.name === 'sampler_name');
  assert.equal(sampler.default, 'er_sde');
  assert.equal(sampler.type, 'enum');
  assert.ok(sampler.options.includes('euler'));
});

test('collectParams never offers an input that the mapping already owns', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  assert.ok(!params.some((item) => item.name === 'seed'), 'seed belongs to the mapping');
  assert.ok(!params.some((item) => item.name === 'width'));
});

test('applyWorkflowParams writes known parameters and reports unknown ones', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  const graph = moss();
  const result = applyWorkflowParams(graph, params, { steps: '30', cfg: 3.5, mystery: 1 });
  assert.equal(result.graph['18:7'].inputs.steps, 30, 'numbers stay numbers');
  assert.equal(result.graph['18:7'].inputs.cfg, 3.5);
  assert.deepEqual(result.applied.sort(), ['cfg', 'steps']);
  assert.deepEqual(result.ignored, ['mystery']);
});

test('applyWorkflowParams leaves unsupported values alone', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  const graph = moss();
  const result = applyWorkflowParams(graph, params, { steps: 'not-a-number' });
  assert.equal(result.graph['18:7'].inputs.steps, 25, 'the default survives an unparsable value');
  assert.deepEqual(result.ignored, ['steps']);
});

test('applyWorkflowParams accepts an enum value', () => {
  const params = collectParams(moss(), mappingOf(), objectInfo());
  const graph = moss();
  const result = applyWorkflowParams(graph, params, { sampler_name: 'euler' });
  assert.equal(result.graph['18:7'].inputs.sampler_name, 'euler');
  assert.deepEqual(result.applied, ['sampler_name']);
});

test('analyzed params carry the candidate inputs the panel can rebind to', () => {
  const analysis = analyzeWorkflow(moss(), objectInfo());
  const steps = analysis.params.find((param) => param.name === 'steps');
  assert.ok(Array.isArray(steps.candidates), 'a param needs candidates for its dropdown');
  assert.ok(steps.candidates.some((item) => item.node === '18:7' && item.input === 'steps'));
});
