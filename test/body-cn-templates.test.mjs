/**
 * 任务 8'/B 组：五条自己拼 body 的协议改读字段模板（docs/…/2026-11-16-model-size-quality-rules.md）。
 *
 * 这一轮同样「只搬不改」：字段名从 `fieldsFor()` 拿、用 applyFields / promptParts 写进 body，
 * 但上游真正收到的字节必须和改造前完全一致。基线测试（test/adapter-body-regression.test.mjs）
 * 覆盖不到这几条——它们的真实请求体在 protocol 自己的 execute() 里拼，所以这里用 fetch 打桩
 * 抓住真实请求，逐条把**改造前**的 body 录成 deepEqual：
 *
 *   - dashscope-qwen-image：`input.messages[0].content[]` 的 image / text 项（图在前、提示词在后）、
 *     `parameters.size` 的 `W*H` 星号、`parameters.n` / `negative_prompt`；
 *   - zhipu：负面词拼进提示词、没有 n / response_format、尺寸 `WxH`（已并入 openai-images，
 *     所以走通用 composeBody，body 与当年 execute() 的产物逐字段一致）；
 *   - openai-responses：`input` 的 string / content[] 两种形状、`tools[0]` 里的 model / size /
 *     quality / output_format，以及 `tool_choice`；
 *   - openai-chat：`messages[0].content` 的 string / parts 两种形状与 `modalities`；
 *   - openrouter-images：顶层 prompt / n / output_format / aspect_ratio。
 *
 * 后面那几条「模板真的被读了」的用例是这一轮新增的能力：模型选项里改了逻辑字段的落点，
 * body 就跟着搬家——没有它们，一个「照抄硬编码再套一层模板」的实现也能骗过上面所有断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';
import { callImageApi } from '../lib/image-execution.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const DATA_URL = 'data:image/png;base64,' + PNG_1PX;

const IMAGE = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };
const fitted = { width: 1024, height: 1024, size: '1024x1024' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/**
 * 打桩 fetch：命中 accept 的请求被记下来（返回 payload），CDN 地址返回 1×1 PNG。
 * execute() 只发一次提交请求，多一条就是行为变了。
 */
function capture(t, accept, payload) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (accept(target)) {
      calls.push({ url: target, init: init || {} });
      return jsonResponse(payload);
    }
    if (/^https:\/\/cdn\.test\//.test(target)) return pngResponse();
    throw new Error('unexpected url ' + target);
  };
  return calls;
}

/** 跑一次 execute 并返回上游真正收到的 JSON body。 */
async function bodyOf(t, adapter, kind, provider, input, accept, payload) {
  const calls = capture(t, accept, payload);
  await adapter.execute(kind, provider, input, new AbortController().signal);
  assert.equal(calls.length, 1, '提交请求应该只发一次');
  assert.equal(calls[0].init.method, 'POST');
  return JSON.parse(calls[0].init.body);
}

const QWEN_PAYLOAD = { output: { choices: [{ message: { content: [{ image: 'https://cdn.test/qwen.png' }] } }] } };
const ZHIPU_PAYLOAD = { data: [{ url: 'https://cdn.test/zhipu.png' }] };

/* ------------------------------------------------ dashscope qwen-image */

test('百炼 qwen-image 生成体：content[] 里是 text 项，size 用星号，负面词单开一个 parameters 字段', async (t) => {
  const provider = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');
  assert.equal(adapter.id, 'dashscope-qwen-image');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'qwen-image-3.0-pro', prompt: '一只猫', negativePrompt: '模糊',
    fitted: { width: 2048, height: 2048, size: '2048x2048' }
  }, (url) => url.includes('/multimodal-generation/generation'), QWEN_PAYLOAD);

  assert.deepEqual(body, {
    model: 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content: [{ text: '一只猫\n\nAvoid: 模糊' }] }] },
    parameters: { n: 1, size: '2048*2048', negative_prompt: '模糊' }
  });
});

test('百炼 qwen-image 生成体：没有负面词时不发 parameters.negative_prompt，尺寸退回 1024*1024', async (t) => {
  const provider = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'qwen-image-3.0-pro', prompt: '一只猫', fitted: { omit: true, size: 'none' }
  }, (url) => url.includes('/multimodal-generation/generation'), QWEN_PAYLOAD);

  assert.deepEqual(body, {
    model: 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content: [{ text: '一只猫' }] }] },
    parameters: { n: 1, size: '1024*1024' }
  });
});

test('百炼 qwen-image 图生图：参考图项排在提示词项前面，且不发尺寸 / 负面词字段', async (t) => {
  const provider = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'qwen-image-3.0-pro', prompt: '换成夜景', negativePrompt: '模糊',
    fitted: { width: 2048, height: 2048, size: '2048x2048' }, images: [IMAGE]
  }, (url) => url.includes('/multimodal-generation/generation'), QWEN_PAYLOAD);

  assert.deepEqual(body, {
    model: 'qwen-image-3.0-pro',
    input: {
      messages: [{
        role: 'user',
        content: [{ image: DATA_URL }, { text: '换成夜景\n\nAvoid: 模糊' }]
      }]
    },
    parameters: { n: 1 }
  });
});

test('百炼 qwen-image 图生图：参考图最多 3 张（第 4 张不发）', async (t) => {
  const provider = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'qwen-image-3.0-pro', prompt: '合成', fitted: fitted,
    images: [IMAGE, IMAGE, IMAGE, IMAGE]
  }, (url) => url.includes('/multimodal-generation/generation'), QWEN_PAYLOAD);

  const content = body.input.messages[0].content;
  assert.equal(content.filter((item) => item.image).length, 3, '老实现是 slice(0, 3)');
  assert.deepEqual(content[content.length - 1], { text: '合成' });
});

/* ------------------------------------------------------------- 智谱（已并入 openai-images） */

/**
 * 智谱现在走通用路径（openai-images + `edit:'none'`）：旧 id 解析出来就是它。
 * 用 callImageApi 发一次，body 由 composeBody 产出——和当年 execute() 手拼的逐字段一致。
 */
async function zhipuGenerate(t, provider, input) {
  const adapter = resolveAdapter(provider, input.model);
  assert.equal(adapter.id, 'openai-images');
  const calls = capture(t, (url) => url.includes('/images/generations'), ZHIPU_PAYLOAD);
  await callImageApi('generate', adapter, provider, input, new AbortController().signal);
  assert.equal(calls.length, 1, '提交请求应该只发一次');
  assert.equal(calls[0].init.method, 'POST');
  return JSON.parse(calls[0].init.body);
}

test('智谱：负面词拼进提示词，没有 n / response_format，尺寸用 x 分隔', async (t) => {
  const provider = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', key: 'k' };
  const adapter = resolveAdapter(provider, 'cogview-4');
  assert.equal(adapter.id, 'openai-images', '智谱已并进 openai-images');
  assert.equal(adapter.endpoints.edit, '', "edit:'none'：没有编辑端点");

  const body = await zhipuGenerate(t, provider, {
    model: 'cogview-4', prompt: '一座山', negativePrompt: '模糊', fitted: fitted
  });

  assert.deepEqual(body, { prompt: '一座山\n\nAvoid: 模糊', model: 'cogview-4', size: '1024x1024' });
});

test('智谱：没有负面词（undefined）时提示词后面不留 "Avoid:"', async (t) => {
  const provider = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', key: 'k' };

  const body = await zhipuGenerate(t, provider, {
    model: 'cogview-4', prompt: '一座山', fitted: fitted
  });

  assert.deepEqual(body, { prompt: '一座山', model: 'cogview-4', size: '1024x1024' });
});

test('智谱：纯空白的负面词仍然会拼出 "Avoid:"（与老 execute() 的唯一差别，工具层不可达）', async (t) => {
  // 老 zhipu 的 execute() 在拼接前 trim 过负面词，纯空白等于没有；通用路径的
  // promptParts 把非空字符串一律当「有值」。工具层（lib/index.js）已经
  // `String(args.negative_prompt).trim() || undefined`，走工具永远到不了这个分支；
  // 这里把现状钉住，免得将来「顺手优化」时没人知道它跟老实现不同。
  const provider = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', key: 'k' };

  const body = await zhipuGenerate(t, provider, {
    model: 'cogview-4', prompt: '一座山', negativePrompt: '   ', fitted: fitted
  });

  assert.deepEqual(body, { prompt: '一座山\n\nAvoid:    ', model: 'cogview-4', size: '1024x1024' });
});

/* --------------------------------------------------- OpenAI Responses */

const RESPONSES_PAYLOAD = { output: [{ type: 'image_generation_call', status: 'completed', result: PNG_1PX }] };

test('Responses 生成体：prompt 走 input 字符串，model / size / quality / output_format 都在 tools[0] 里', async (t) => {
  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  assert.equal(adapter.id, 'openai-responses');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', negativePrompt: 'blurry',
    quality: 'HIGH', fitted: { width: 1536, height: 1024, size: '1536x1024' }
  }, (url) => url.endsWith('/responses'), RESPONSES_PAYLOAD);

  assert.deepEqual(body, {
    model: 'gpt-5.2',
    input: 'a cat\n\nAvoid: blurry',
    tools: [{
      type: 'image_generation', model: 'gpt-image-2.5-flare',
      size: '1536x1024', quality: 'high', output_format: 'png'
    }],
    tool_choice: { type: 'image_generation' }
  });
});

test('Responses 生成体：quality 是 off / auto 时不写进 tool，尺寸省略时也不写 size', async (t) => {
  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', quality: 'off', fitted: { omit: true, size: 'none' }
  }, (url) => url.endsWith('/responses'), RESPONSES_PAYLOAD);

  assert.deepEqual(body.tools, [{ type: 'image_generation', model: 'gpt-image-2.5-flare', output_format: 'png' }]);
  assert.equal(body.input, 'a cat');
});

test('Responses 图生图：input 变成 content[]，参考图是 input_image 项（带 detail），提示词是 input_text 项', async (t) => {
  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'replace the background', fitted: fitted, images: [IMAGE, IMAGE]
  }, (url) => url.endsWith('/responses'), RESPONSES_PAYLOAD);

  assert.deepEqual(body.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'replace the background' },
      { type: 'input_image', image_url: DATA_URL, detail: 'auto' },
      { type: 'input_image', image_url: DATA_URL, detail: 'auto' }
    ]
  }]);
  assert.equal(body.tools[0].type, 'image_generation');
  assert.equal(body.tools[0].size, '1024x1024');
});

/* -------------------------------------------------------- OpenAI chat */

const CHAT_PAYLOAD = { choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] };

test('chat：单模态时 content 是提示词字符串，负面词拼进去，model 走模板', async (t) => {
  const provider = { baseUrl: 'https://relay.example.com/v1', adapter: 'openai-chat', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  assert.equal(adapter.id, 'openai-chat');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', negativePrompt: '  blurry  ', fitted: fitted
  }, (url) => url.endsWith('/chat/completions'), CHAT_PAYLOAD);

  assert.deepEqual(body, {
    model: 'gpt-image-2.5-flare',
    messages: [{ role: 'user', content: 'a cat\n\nAvoid: blurry' }],
    modalities: ['image', 'text']
  });
});

test('chat 图生图：content 变成 parts，文本项在前、image_url 项在后', async (t) => {
  const provider = { baseUrl: 'https://relay.example.com/v1', adapter: 'openai-chat', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'paint it blue', fitted: fitted, images: [IMAGE]
  }, (url) => url.endsWith('/chat/completions'), CHAT_PAYLOAD);

  assert.deepEqual(body.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'paint it blue' },
      { type: 'image_url', image_url: { url: DATA_URL } }
    ]
  }]);
  assert.deepEqual(body.modalities, ['image', 'text']);
});

/* -------------------------------------------------- OpenRouter Images */

const OPENROUTER_PAYLOAD = { data: [{ b64_json: PNG_1PX, media_type: 'image/png' }] };

test('openrouter-images：prompt / 负面词 / model / n 是顶层字段，比例走 aspect_ratio', async (t) => {
  const provider = { baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images', key: 'k' };
  const adapter = resolveAdapter(provider, 'google/gemini-3.1-flash-image');
  assert.equal(adapter.id, 'openrouter-images');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'google/gemini-3.1-flash-image', prompt: 'a red panda', negativePrompt: 'blurry',
    fitted: { width: 1344, height: 768, size: '1344x768' }
  }, (url) => url.endsWith('/images'), OPENROUTER_PAYLOAD);

  assert.deepEqual(body, {
    model: 'google/gemini-3.1-flash-image',
    prompt: 'a red panda\n\nAvoid: blurry',
    n: 1,
    output_format: 'png',
    aspect_ratio: '16:9'
  });
});

test('openrouter-images 图生图：参考图是 input_references 里的 {type, image_url} 对象', async (t) => {
  const provider = { baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images', key: 'k' };
  const adapter = resolveAdapter(provider, 'openai/gpt-image-2');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'openai/gpt-image-2', prompt: 'watercolor', fitted: fitted, images: [IMAGE]
  }, (url) => url.endsWith('/images'), OPENROUTER_PAYLOAD);

  assert.deepEqual(body.input_references, [{ type: 'image_url', image_url: { url: DATA_URL } }]);
  assert.equal(body.n, 1);
  assert.equal(body.prompt, 'watercolor');
});

/* ------------------------------------- 模板真的被读了（本轮新增的能力） */

test('模型选项把智谱的提示词改到 input.prompt，body 就写到那儿', async (t) => {
  const provider = {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', key: 'k',
    modelOptions: { 'cogview-4': { fields: { prompt: { path: 'input.prompt' }, negative: null } } }
  };

  const body = await zhipuGenerate(t, provider, {
    model: 'cogview-4', prompt: '一座山', negativePrompt: '模糊', fitted: fitted
  });

  assert.deepEqual(body.input, { prompt: '一座山' });
  assert.equal(body.prompt, undefined, '模板已经指向 input.prompt，老位置不该还留着');
  assert.equal(body.negative_prompt, undefined, '模板把负面词关掉（null）以后就不该再发');
});

test('模型选项把 Responses 的模型名改到 metadata：tools[0] 里就不再写 model', async (t) => {
  const provider = {
    baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k',
    modelOptions: {
      'gpt-image-2.5-flare': {
        fields: { model: { path: 'metadata.image_model' }, quality: null }
      }
    }
  };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');

  const body = await bodyOf(t, adapter, 'generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', quality: 'high', fitted: fitted
  }, (url) => url.endsWith('/responses'), RESPONSES_PAYLOAD);

  assert.deepEqual(body.metadata, { image_model: 'gpt-image-2.5-flare' });
  assert.equal(body.tools[0].model, undefined, '模板已经指向 metadata，tools[0] 里不该还留着');
  assert.equal(body.tools[0].quality, undefined, '模板把质量关掉（null）以后就不该再发');
  assert.equal(body.model, 'gpt-5.2', '主模型的 model 是 Responses 的信封，不是逻辑字段');
});

test('模型选项把千问参考图的落点改成数组追加，图生图的 image 项就跟着搬家', async (t) => {
  const provider = {
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k',
    modelOptions: {
      'qwen-image-3.0-pro': { fields: { image: { path: 'input.contents[]', as: 'dataUrl' } } }
    }
  };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');

  const body = await bodyOf(t, adapter, 'edit', provider, {
    model: 'qwen-image-3.0-pro', prompt: '换成夜景', fitted: fitted, images: [IMAGE]
  }, (url) => url.includes('/multimodal-generation/generation'), QWEN_PAYLOAD);

  assert.deepEqual(body.input.contents, [DATA_URL], '覆盖层说的是 input.contents[]，就该写在那儿');
  assert.deepEqual(body.input.messages[0].content, [{ text: '换成夜景' }], 'content[] 里只剩提示词项');
});
