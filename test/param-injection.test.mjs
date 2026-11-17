/**
 * 参数表的离散行 → 请求体。
 *
 * 「常规」方框现在是一张离散参数表（commit dcb2bc2）：
 *   { role?, name, type, default, description, expose, options? }
 *
 * 内置四行带 role（prompt / negative / model / n），行名与 fields[role].path 双向同步；
 * 用户新增的行没有 role，只写在 modelOptions[m].params 里。上一轮它们只是声明，
 * 通用路径（composeBody / prepareGenerate / prepareEdit）根本不认识，body 里发不出去。
 *
 * 这一轮锁住的行如下：
 *   1. 无 role 的行按 default 注入（number 是数字，不是字符串）；
 *   2. 参数名支持 a.b.c 嵌套；
 *   3. default 为空 / 未设的行不写（避免发空值）；
 *   4. boolean 写 true / false，不写 "true"；
 *   5. 内置四行不改变现有 body——它们是同一件事的另一种声明，不是新字段；
 *   6. expose:true 的行允许这次调用的 input.params 覆盖默认值，未暴露的不认。
 *
 * 协议自己拼 body 的出口（execute() / async.build()）不在这里管：它们的 params 语义是
 * ComfyUI / A1111 的工作流参数，和这张表同键不同形状（有 node / input）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, fitSize, prepareGenerate, prepareEdit } from '../lib/adapters.js';

/** 一条通用的 OpenAI 兼容网关：四个内置 role 都有 path 模板，走 prepare*（通用路径）。 */
const MODEL = 'flux-1-schnell';
const BASE_URL = 'https://gateway.example.com/v1';

/** 参数表的一行；形状与 config-store 的 sanitizeParamTable 产物一致（default 是字符串）。 */
function row(name, type, value, extra) {
  return Object.assign({ name, type, default: value, description: '', expose: false }, extra || {});
}

function providerOf(params) {
  const provider = { adapter: 'openai-images', baseUrl: BASE_URL, key: 'test-key' };
  if (params) provider.modelOptions = { [MODEL]: { params } };
  return provider;
}

const FITTED = fitSize({ adapter: 'openai-images', baseUrl: BASE_URL }, { kind: 'wh-string', text: '1024x1024' }, MODEL);

function inputOf(extra) {
  return Object.assign({
    model: MODEL,
    prompt: 'a cat sitting on a windowsill',
    negativePrompt: 'blurry, watermark',
    n: 2,
    fitted: FITTED
  }, extra || {});
}

function generateBody(params, extra) {
  const provider = providerOf(params);
  const adapter = resolveAdapter(provider, MODEL);
  const prepared = prepareGenerate(adapter, provider, inputOf(extra), new Set());
  return JSON.parse(prepared.body);
}

test('新增一行 seed（number，default 42）注入 body，且是数字', () => {
  const body = generateBody([row('seed', 'number', '42')]);
  assert.equal(body.seed, 42);
  assert.equal(typeof body.seed, 'number', 'number 行必须是数字，不能发 "42"');

  // 编辑出口共用 composeBody：multipart 里也要有它（表单值统一字符串化）。
  const provider = providerOf([row('seed', 'number', '42')]);
  const edited = prepareEdit(resolveAdapter(provider, MODEL), provider, inputOf({ images: [] }), new Set(), 'image');
  assert.ok(edited.body && typeof edited.body.get === 'function', 'openai-images 的编辑出口是 multipart');
  assert.equal(edited.body.get('seed'), '42', 'prepareEdit 也要注入');
});

test('参数名支持 a.b.c：按嵌套对象写，不写成扁平键', () => {
  const body = generateBody([
    row('a.b.c', 'text', 'deep'),
    row('a.b.n', 'number', '5')
  ]);
  assert.deepEqual(body.a, { b: { c: 'deep', n: 5 } });
  assert.equal('a.b.c' in body, false, '嵌套名不能当成扁平键发出去');
});

test('default 为空串或未设的行不写，其它行照写', () => {
  const body = generateBody([
    row('empty_text', 'text', ''),
    row('empty_number', 'number', ''),
    { name: 'unset', type: 'text', expose: false },
    row('seed', 'number', '42')
  ]);
  assert.equal('empty_text' in body, false);
  assert.equal('empty_number' in body, false);
  assert.equal('unset' in body, false);
  assert.equal(body.seed, 42, '空默认只跳过自己，不该连累别的行');
});

test('boolean 行写 true / false，不是字符串', () => {
  const body = generateBody([
    row('flag', 'boolean', 'true'),
    row('off', 'boolean', 'false')
  ]);
  assert.equal(body.flag, true);
  assert.equal(body.off, false);
  assert.equal(typeof body.flag, 'boolean');
  assert.equal(typeof body.off, 'boolean');
});

test('内置四行（prompt / negative / model / n）不改变现有 body', () => {
  const builtin = [
    { role: 'prompt', name: 'prompt', type: 'text', default: '', description: '', expose: true },
    { role: 'negative', name: 'negative_prompt', type: 'text', default: '', description: '', expose: false },
    { role: 'model', name: 'model', type: 'text', default: '', description: '', expose: false },
    { role: 'n', name: 'n', type: 'number', default: '1', description: '', expose: false }
  ];
  const plain = generateBody(null);
  const withRows = generateBody(builtin);
  // 值来自角色，不是行里的 default：prompt / model 的 default 是空串，n 的 default 是 1，
  // 而这次调用的 n 是 2。按 default 写的话这一条会立刻变红。
  assert.equal(withRows.n, 2, 'n 必须取角色值（2），不能取行默认值 1');
  assert.deepEqual(withRows, plain, '内置四行只是同一件事的另一种声明，body 必须一模一样');
});

test('expose:true 的行被调用方传值覆盖；没暴露的行只认默认值', () => {
  const body = generateBody([
    row('seed', 'number', '42', { expose: true }),
    row('steps', 'number', '20')
  ], { params: { seed: 7, steps: 50 } });
  assert.equal(body.seed, 7, '暴露行应该用 input.params 里的值');
  assert.equal(body.steps, 20, '没暴露的行不许被 input.params 改掉');
});
