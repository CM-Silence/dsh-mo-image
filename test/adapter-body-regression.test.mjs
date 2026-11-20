/**
 * 「只搬不改」的行为基线：19 条生图协议各自 prepareGenerate / prepareEdit 产出的请求体。
 *
 * 背景：下一步要把 size / quality 的声明从 26 条协议里搬进按模型名匹配的规则表
 * （docs/superpowers/plans/2026-11-16-model-size-quality-rules.md 任务 4）。
 * 漏一条规则，行为就会从「发尺寸」静默变成「不发尺寸」，光读代码看不出来。
 * 所以这里把搬迁**之前**的请求体录进 test/fixtures/adapter-bodies.baseline.json，
 * 搬迁之后逐条比对：body 一模一样才算没改行为。测试只读基线，不写。
 *
 * ---- 协议收敛（26 → 20 → 19）-------------------------------------------
 *
 * 第一轮：dall-e-3 / gpt-image / together / localai / siliconflow / volcengine-ark
 * 六条协议合并成一条 `openai-images` + 协议级选项（`edit`，见 lib/adapters.js 的
 * PROTOCOL_OPTIONS）。第二轮：azure-openai 也只差鉴权头形态；第三轮把鉴权从协议选项
 * 升成提供商字段（provider.auth.mode = 'api-key'），body 一个字节都不该动。
 * 它们当年真正发出去的 body 由基线的 `variants` 段继续锁住（`legacy/*`），比对方式是
 * **字符串相等**，连键顺序都不许变；`adapters` 段只留现存的 19 条协议。合并带来的 body
 * 变化为 0：字段名仍在预设/规则里，尺寸与质量仍在规则表里，`response_format` / `watermark` /
 * `output_format` 搬进了请求常量规则（CONSTANT_RULES）。
 *
 * ---- 覆盖边界（别误读这份基线的结论）------------------------------------------
 *
 * lib/image-execution.js 的 callImageApi() 按这个顺序分派：
 *   1. adapter.async 是描述符对象 → 走异步的 async.build()，提交体由协议自己拼；
 *   2. adapter.async 是 legacy 的 true → 走 prepareAsync()，提交体仍然是 composeBody()（真实）；
 *   3. 有 adapter.execute() → 走协议自己的 execute()，body 在 execute 里拼；
 *   4. 以上都没有 → 走 prepareGenerate / prepareEdit（真实）。
 *
 * 只有第 4 类（covers: 'prepare'）和第 2 类（covers: 'prepare-async'，目前只有 dashscope-wanx）
 * 的协议，这份基线锁住的就是**真实请求体**。
 *
 * 另外 14 条协议（covers: 'execute' / 'async-build'）在自己代码里拼 body，
 * 本文件**只锁住了「通用 composeBody 会产出什么」，不覆盖它们的真实请求**——
 * 逐条说明见下面的 OWN_BODY_NOTES，并由 test('…自己拼 body…') 校验「一条都没漏注释」。
 * 它们的真实请求由这些测试覆盖：provider-adapters / openai-protocols / async-protocols /
 * modelscope-protocols / cn-protocols / local-adapters / comfyui-workflow / size-platforms。
 *
 * ---- 固定输入 -----------------------------------------------------------------
 *
 * 见 FIXED / MODELS / BASE_URLS。四个刻意的选择：
 *   - model 取该协议「典型」模型的真实 id（dall-e-3、gpt-image-2.5-flare、qwen-image-3.0-pro、
 *     doubao-seedream-4-0-250828 …），否则按模型分叉的策略根本命中不了；
 *   - fitted = fitSize(provider, '1024x1024', model)，**带上 model**：同一协议里尺寸形态按模型
 *     分叉（ideogram-4 收 resolution 像素表、seedream 收档位名），只按协议算会录到一条谁都不发的 body；
 *   - quality = qualityOptionsFor(provider, model, adapter).default，没有质量声明的协议记 null。
 *   - baseUrl 现在不参与 prepare*，但迁移后的规则要按主机区分（qwen-image 在硅基流动是
 *     image_size、在百炼是 size 且用 *），所以固定输入先给真实主机，免得迁移后这条测试失效。
 *
 * ---- 迁移时怎么用这个文件 -------------------------------------------------------
 *
 *   任务 2/3 已经把 sizePolicyFor / fitSize / qualityOptionsFor 的入参从 adapter 改成
 *   provider（adapter 只在协议级例外——openai-chat 的 control:'prompt'——和质量闸门里
 *   作为可选第三参出现）。本文件的调用点跟着机械改过，断言一个字没动，基线 JSON 只变了
 *   google-gemini 那一条（gemini-2.5-flash-image 的 mode:'none' 收口：尺寸字段消失）。
 *   另外：14 条「自己拼 body」的协议里，fal 和 replicate **没有任何 size 声明**，
 *   composeBody 是靠 encodeSizePrimary 的默认参数名兜出一个 {size:"1024x1024"}，上游根本不看；
 *   规则表里没有它们时这个兜底很可能会变成「不发尺寸」→ 这两条基线会合理地变红。
 *   看到红先分辨是「真实请求变了」还是「没人用的 composeBody 变了」，别直接重建基线。
 *
 * ---- 已知覆盖缺口（都有别的测试兜着，这里不重复）--------------------------------
 *
 *   - 1024x1024 是 1:1 / 1MP，摸不到档位换算与非 1:1 的比例映射。例：volcengine-ark 的
 *     tierLabels（2K/3K/4K）在 1024x1024 下不发档位名，那条分支由 test/cn-protocols.test.mjs
 *     的 2048x2048 用例覆盖；比例映射由 test/size-platforms.test.mjs 覆盖。
 *   - 尺寸被上游拒绝后的降级（drops / 严格模式）不在基线范围内，见 test/strict-size.test.mjs。
 *   - edit 的参考图是固定的 1×1 PNG，只验证「参考图挂到哪个字段」，不验证上传细节。
 *   - 固定输入用的是每个协议的**默认**质量档；质量 off（mapQuality 把 off 翻成「不发该参数」）
 *     不在基线里，由 test/provider-adapters.test.mjs 的 "quality off means the field is not sent at all" 锁住。
 *
 * ---- 重建基线 -----------------------------------------------------------------
 *
 *   node --input-type=module -e "import fs from 'node:fs'; import { buildBaseline } from './test/adapter-body-regression.test.mjs'; fs.writeFileSync('test/fixtures/adapter-bodies.baseline.json', JSON.stringify(buildBaseline(), null, 2) + '\n')"
 *
 * （import 这个模块会顺带把本文件的测试也注册并跑一遍，属正常。）
 * 重建必须单独提交，让基线文件的 diff 能被 review —— 测试变红时不要顺手重建。
 *
 * 注意 `variants` 里的 `legacy/*` 六条**不是**这一次重建录的：它们是从合并前的基线
 * （26 条协议那版，`git show HEAD:test/fixtures/adapter-bodies.baseline.json`）逐条搬
 * 过来的，用来证明「合并只改名字、不改线上 body」。`buildBaseline()` 重建时会用当前
 * 代码重录它们——那之后就只是「从现在起不许变」，旧协议的对照点也就没了，
 * 所以要重建时先想清楚是不是真的要丢掉这个对照。
 * 方舟的连字符版本号修复后，4.0 的固定样例开始使用官方 1K 档位。这里保留其他原始值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  listAdapters, resolveAdapter, adapterSupportsKind,
  fitSize, qualityOptionsFor, prepareGenerate, prepareEdit
} from '../lib/adapters.js';

/* ------------------------------------------------------------------ 基线文件 */

const BASELINE_URL = new URL('./fixtures/adapter-bodies.baseline.json', import.meta.url);

let BASELINE = null;
let BASELINE_ERROR = null;
try {
  BASELINE = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
} catch (error) {
  BASELINE_ERROR = error;
}

function baseline() {
  assert.equal(
    BASELINE_ERROR, null,
    '读不到基线 test/fixtures/adapter-bodies.baseline.json：' + (BASELINE_ERROR && BASELINE_ERROR.message)
  );
  return BASELINE;
}

/* ---------------------------------------------------------------- 固定输入 */

/** 1×1 PNG：字节固定，保证 edit 体里的 data URL 每次都一样。 */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const FIXED = {
  sizeRequest: '1024x1024',
  // 用 ASCII：基线文件要能直接看 diff，别让多字节字符的转义/换行干扰阅读。
  prompt: 'a cat sitting on a windowsill, soft morning light',
  negativePrompt: 'blurry, watermark, text',
  image: { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' }
};

/** 每条协议用哪个模型：必须能命中该协议的典型形态，否则按模型分叉的尺寸/质量策略不会生效。 */
const MODELS = {
  'google-gemini': 'gemini-2.5-flash-image',
  'recraft': 'recraftv4_1',
  'ideogram': 'ideogram-4',
  'stability': 'core',
  'dashscope-qwen-image': 'qwen-image-3.0-pro',
  'dashscope-wanx': 'wanx2.1-t2i-turbo',
  'a1111': 'sd-cpp-local',
  'comfyui': 'flux2-dev.safetensors',
  'swarmui': 'sdxl-base',
  'bfl': 'flux-2-pro',
  'fal': 'fal-ai/flux-2-pro',
  'replicate': 'black-forest-labs/flux-2-pro',
  'modelscope': 'Qwen/Qwen-Image-2.1',
  'openai-responses': 'gpt-image-2.5-flare',
  'openrouter-images': 'google/gemini-3.1-flash-image',
  'openai-chat': 'gpt-image-2.5-flare',
  'openai-images': 'flux-1-schnell'
};

/** 每条协议用哪个主机：和 PROVIDER_PRESETS 对齐；搬迁后规则要按主机区分。 */
const BASE_URLS = {
  'google-gemini': 'https://generativelanguage.googleapis.com/v1beta',
  'recraft': 'https://external.api.recraft.ai/v1',
  'ideogram': 'https://api.ideogram.ai',
  'stability': 'https://api.stability.ai',
  'dashscope-qwen-image': 'https://dashscope.aliyuncs.com/api/v1',
  'dashscope-wanx': 'https://dashscope.aliyuncs.com/api/v1',
  'a1111': 'http://127.0.0.1:7860',
  'comfyui': 'http://127.0.0.1:8188',
  'swarmui': 'http://127.0.0.1:7801',
  'bfl': 'https://api.bfl.ai',
  'fal': 'https://queue.fal.run',
  'replicate': 'https://api.replicate.com/v1',
  'modelscope': 'https://api-inference.modelscope.cn',
  'openai-responses': 'https://api.openai.com/v1',
  'openrouter-images': 'https://openrouter.ai/api/v1',
  'openai-chat': 'https://relay.example.com/v1',
  'openai-images': 'https://gateway.example.com/v1'
};

/**
 * 协议合并（dall-e-3 / gpt-image / together / localai / siliconflow / volcengine-ark /
 * azure-openai → openai-images + 选项）之前的固定输入。
 *
 * `adapters` 只能记「一条协议 × 一套输入」，而合并后这些都是同一协议的不同选项组合，
 * 所以它们单独记在基线的 `variants` 段：旧协议当年真正发出去的 body 继续被逐字节锁住，
 * 合并只是换了名字，不是换了行为。多加一条老写法的 `auth:'api-key'`：鉴权头不进 body，
 * 但「body 与鉴权形态无关」这件事也该有个断言（见 test('provider.auth 只改鉴权头…')）。
 */
const VARIANTS = {
  'legacy/dall-e-3': { model: 'dall-e-3', baseUrl: 'https://api.openai.com/v1', options: {} },
  'legacy/gpt-image': { model: 'gpt-image-2.5-flare', baseUrl: 'https://api.openai.com/v1', options: {} },
  'legacy/together': { model: 'black-forest-labs/FLUX.1-schnell', baseUrl: 'https://api.together.xyz/v1', options: { edit: 'none' } },
  'legacy/localai': { model: 'localai-model', baseUrl: 'http://127.0.0.1:8080/v1', options: { edit: 'none' } },
  'legacy/siliconflow': { model: 'Qwen/Qwen-Image', baseUrl: 'https://api.siliconflow.cn/v1', options: { edit: 'same' } },
  'legacy/volcengine-ark': { model: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', options: { edit: 'same' } },
  // Azure 并进 openai-images（`auth:'api-key'`）：body 必须与合并前逐字节一致，
  // 包括 output_format:'png'——那个键原来挂在 azure-openai 协议的 outputFormat 上，
  // 合并后由请求常量规则按主机（openai.azure.com）继续给。
  'legacy/azure-openai': { model: 'gpt-image-2.5-flare', baseUrl: 'https://example-resource.openai.azure.com/openai/v1', options: { auth: 'api-key' } },
  // xAI / 智谱并进 openai-images（`edit:'none'`）。这两条的 reference 不是 execute() 的
  // 通用 composeBody 产物（老基线的 generate 段只记了 `{aspect_ratio}` / `{size}` 那种死路径
  // body），而是**合并前 execute() 真正发出去的请求体**，逐字段抄在下面。
  'legacy/xai-imagine': {
    model: 'grok-imagine-image',
    baseUrl: 'https://api.x.ai/v1',
    options: { edit: 'none' },
    reference: {
      generatePath: '/images/generations',
      generate: {
        model: 'grok-imagine-image',
        prompt: 'a cat sitting on a windowsill, soft morning light\n\nAvoid: blurry, watermark, text',
        n: 1,
        response_format: 'url',
        aspect_ratio: '1:1',
        resolution: '1k'
      }
    }
  },
  'legacy/zhipu': {
    model: 'cogview-4',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    options: { edit: 'none' },
    quality: null, // 重放旧请求时仍省略新支持的质量档位。
    reference: {
      generatePath: '/images/generations',
      generate: {
        prompt: 'a cat sitting on a windowsill, soft morning light\n\nAvoid: blurry, watermark, text',
        model: 'cogview-4',
        size: '1024x1024'
      }
    }
  },
  'option/auth=bearer': { model: 'flux-1-schnell', baseUrl: 'https://gateway.example.com/v1', options: {} },
  'option/auth=api-key': { model: 'flux-1-schnell', baseUrl: 'https://gateway.example.com/v1', options: { auth: 'api-key' } }
};

/**
 * 这 14 条协议的真实请求体不经过 prepare*（分派见文件头），
 * 下面的基线对它们只等于「通用 composeBody 的产物」，不是上游真正收到的 body。
 * 一条都不能漏：test('…自己拼 body…') 会拿这张表对照 listAdapters()。
 */
const OWN_BODY_NOTES = {
  // 走 execute()：body 在协议自己的 execute 里拼
  'google-gemini': 'execute() 拼 {contents, generationConfig.imageConfig:{aspectRatio, imageSize}}；prepare* 只产出 {aspect_ratio}。真实请求：test/provider-adapters.test.mjs',
  'recraft': 'execute() 拼 {model, prompt(含 Avoid), n:1, response_format, size}；prepare* 只有 size。真实请求：test/provider-adapters.test.mjs',
  'ideogram': 'execute() 按 ideogram-3 / 4 / 4-5 / 4-transparent 分四种 body（JSON 的 resolution 或 multipart 的 aspect_ratio + rendering_speed）；prepare* 的 multipart 体里连 prompt 都没有。真实请求：test/provider-adapters.test.mjs、test/size-platforms.test.mjs',
  'dashscope-qwen-image': 'execute() 拼 {model, input:{messages:[{role, content:[image…, text]}]}, parameters:{n, size:"W*H", negative_prompt}}；prepare* 只有 {size:"1024*1024"}。真实请求：test/cn-protocols.test.mjs',
  'a1111': 'execute() 发 width/height（外加 override_settings / init_images），prepare* 发的是 size 字符串，两者形状不同。真实请求：test/local-adapters.test.mjs',
  'comfyui': 'execute() 发 ComfyUI 工作流 {prompt, client_id}，尺寸进 EmptyLatentImage 节点；prepare* 的 size 字段根本不会出现在工作流里。真实请求：test/local-adapters.test.mjs、test/comfyui-workflow.test.mjs',
  'swarmui': 'execute() 先取 session_id 再拼 {session_id, images, prompt, negativeprompt, model, cfgscale, steps, seed, width, height}；prepare* 只有 size。真实请求：test/local-adapters.test.mjs',
  'openai-responses': 'execute() 发 {model: hostModel, input, tools:[{type:"image_generation", size, quality, output_format}], tool_choice}；prepare* 只有顶层 {size}。真实请求：test/openai-protocols.test.mjs',
  'openrouter-images': 'execute() 拼 {model, prompt, n, output_format, aspect_ratio, resolution?, quality?, input_references?}；prepare* 只有 aspect_ratio。真实请求：test/openai-protocols.test.mjs',
  'openai-chat': 'execute() 发 {model, messages, modalities}，尺寸只能写进提示词；prepare* 的 generate 体是 {}（control:prompt 表示「不发尺寸字段」，不是漏了字段）。真实请求：test/openai-protocols.test.mjs',
  // 走异步描述符的 async.build()：提交体由 build 自己拼
  'bfl': 'async.build() 拼 {prompt, width, height, output_format}(FLUX.2) 或 {prompt, aspect_ratio, resolution}(FLUX 3 / kontext)；prepare* 只有 width/height。真实请求：test/async-protocols.test.mjs',
  'fal': 'async.build() 拼 {prompt, num_images, output_format, image_size:{width,height}}；fal 协议根本没有 size 声明，prepare* 只产出 {size:"1024x1024"}，上游不看这个字段。真实请求：test/async-protocols.test.mjs',
  'replicate': 'async.build() 拼 {input:{prompt, 宽高或 aspect_ratio 由模型 schema 决定}}；prepare* 只产出 {size}，同样不是上游字段。真实请求：test/async-protocols.test.mjs',
  'modelscope': 'async.build() 拼 {model, prompt, negative_prompt, size, image_url}；prepare* 只产出 {size}，连 model / prompt 都没有。真实请求：test/modelscope-protocols.test.mjs'
};

/* -------------------------------------------------------------- 录制与快照 */

function providerOf(id) {
  // 用 adapter 而不是 protocol：和真实 provider 配置（PROVIDER_PRESETS）一致。
  return { adapter: id, baseUrl: BASE_URLS[id], key: 'test-key' };
}

function adapterFor(id) {
  return resolveAdapter(providerOf(id), MODELS[id]);
}

/**
 * 这条协议的真实请求体是不是由 prepare* 产出。
 * 顺序必须和 lib/image-execution.js 的 callImageApi() 一致：先 async，再 execute，最后 prepare*。
 */
function coversOf(adapter) {
  // async 是描述符对象 → async.build() 自己拼提交体；legacy 的 true → prepareAsync() → composeBody()。
  if (adapter.async) return typeof adapter.async === 'object' ? 'async-build' : 'prepare-async';
  if (typeof adapter.execute === 'function') return 'execute';
  return 'prepare';
}

/**
 * 把 prepare* 的 body 变成可 JSON 化的快照。
 * JSON 端点是 JSON 字符串，直接 parse；multipart 端点（dall-e-3 / stability 这些）是 FormData，
 * 逐项展开，文件项记成 { $file, type, bytes }，否则 JSON.stringify 会把它变成 "{}"。
 */
function snapshotBody(body) {
  if (typeof body === 'string') return JSON.parse(body);
  if (body && typeof body.entries === 'function') {
    const fields = {};
    for (const [key, value] of body.entries()) {
      fields[key] = typeof value === 'string'
        ? value
        : { $file: String(value.name || ''), type: String(value.type || ''), bytes: Number(value.size) || 0 };
    }
    return { $multipart: fields };
  }
  throw new Error('prepare* 返回了不认识的 body：' + Object.prototype.toString.call(body));
}

/** 录一条协议的某个方向。抛错也照录（基线里是 { throws }），不能悄悄当成空 body。 */
function recordKind(adapter, provider, input, kind) {
  const supported = adapterSupportsKind(adapter, kind);
  // 参考图字段与 image-execution.js 一致：editFields 的第一个，没声明就 'image'。
  const field = adapter.editFields && adapter.editFields.length ? adapter.editFields[0] : 'image';
  let built;
  try {
    built = kind === 'edit'
      ? prepareEdit(adapter, provider, input, new Set(), field)
      : prepareGenerate(adapter, provider, input, new Set());
  } catch (error) {
    return { supported: supported, throws: String((error && error.message) || error) };
  }
  return { supported: supported, path: String(built.path === undefined ? '' : built.path), body: snapshotBody(built.body) };
}

function recordAdapter(id) {
  const model = MODELS[id];
  const provider = providerOf(id);
  const adapter = adapterFor(id);
  assert.equal(adapter.id, id, 'adapter: ' + id + ' 解析到了 ' + adapter.id + '，固定输入对不上');
  const spec = qualityOptionsFor(provider, model, adapter);
  const input = {
    model,
    prompt: FIXED.prompt,
    negativePrompt: FIXED.negativePrompt,
    fitted: fitSize(provider, FIXED.sizeRequest, model),
    quality: spec ? spec.default : null,
    images: [FIXED.image]
  };
  return {
    model,
    quality: spec ? spec.default : null,
    covers: coversOf(adapter),
    generate: recordKind(adapter, provider, input, 'generate'),
    edit: recordKind(adapter, provider, input, 'edit')
  };
}

/** 录一条「合并前协议」的等价输入：走同一条 openai-images，选项不同。 */
function recordVariant(name) {
  const entry = VARIANTS[name];
  const model = entry.model;
  const provider = {
    adapter: 'openai-images',
    baseUrl: entry.baseUrl,
    key: 'test-key',
    protocolOptions: { ...entry.options }
  };
  // 鉴权已从协议选项升成 provider.auth：老写法（protocolOptions.auth，只有 bearer /
  // api-key 两个值）按 normalizeConfig 的迁移路径落到 provider.auth.mode，这里照同一条路重放。
  // 基线的 `options` 段仍然记老写法，所以 provider 上两种都带着——鉴权不进 body，录出来不变。
  const legacyAuth = String((entry.options && entry.options.auth) || '').trim().toLowerCase();
  if (legacyAuth === 'bearer' || legacyAuth === 'api-key') provider.auth = { mode: legacyAuth };
  const adapter = resolveAdapter(provider, model);
  assert.equal(adapter.id, 'openai-images', name + ' 应该落在合并后的 openai-images 上');
  const spec = qualityOptionsFor(provider, model, adapter);
  const quality = Object.hasOwn(entry, 'quality') ? entry.quality : (spec?.default ?? null);
  const input = {
    model,
    prompt: FIXED.prompt,
    negativePrompt: FIXED.negativePrompt,
    fitted: fitSize(provider, FIXED.sizeRequest, model),
    quality,
    images: [FIXED.image]
  };
  return {
    model,
    quality,
    options: { ...entry.options },
    generate: recordKind(adapter, provider, input, 'generate'),
    edit: recordKind(adapter, provider, input, 'edit')
  };
}

/** 重建基线用（命令见文件头）。测试本身不调用它写文件。 */
export function buildBaseline() {
  const adapters = {};
  for (const entry of listAdapters()) adapters[entry.id] = recordAdapter(entry.id);
  const variants = {};
  for (const name of Object.keys(VARIANTS)) variants[name] = recordVariant(name);
  return {
    _readme: [
      '每条协议 prepareGenerate / prepareEdit 产出的请求体（搬迁到模型规则表之前的行为基线）。',
      '键：model / quality 是固定输入；covers 说明该协议真实请求体的来源：',
      '  prepare        = prepare* 产出的就是真实请求体',
      '  prepare-async  = 走 prepareAsync()，但提交体同样来自 composeBody()，也是真实的',
      '  execute        = 协议自己的 execute() 拼 body，这里只录了通用 composeBody 的产物',
      '  async-build    = 异步描述符的 async.build() 拼提交体，这里只录了通用 composeBody 的产物',
      'generate / edit：{ supported, path, body }；body 是 multipart 时记成 { $multipart: {…} }，文件项是 { $file, type, bytes }；',
      'prepare* 抛错时记成 { supported, throws }。',
      'variants：协议合并（dall-e-3 / gpt-image / together / localai / siliconflow / volcengine-ark /',
      '  azure-openai → openai-images + edit/auth 选项）之前这几条协议各自的输入，按新写法重放的 body。',
      '  它们与 adapters 里的条目同形，多一个 options 字段记录协议级选项。',
      '人工维护的记录：test/adapter-body-regression.test.mjs（改这个文件请先读它的文件头）。'
    ],
    adapters: adapters,
    variants: variants
  };
}

/* ------------------------------------------------------------------ 测试 */

test('固定输入表覆盖 listAdapters() 的全部协议', () => {
  const ids = listAdapters().map((entry) => entry.id).sort();
  assert.equal(ids.length, 17, '协议数变了：基线要跟着补一条，并重新确认搬迁范围');
  assert.deepEqual(ids.filter((id) => !MODELS[id]), [], '这些协议还没有固定 model');
  assert.deepEqual(ids.filter((id) => !BASE_URLS[id]), [], '这些协议还没有固定 baseUrl');
});

test('基线与协议清单一一对应，一条不多一条不少', () => {
  const base = baseline();
  assert.ok(base && base.adapters && typeof base.adapters === 'object', '基线文件结构不对，应该有 adapters');
  assert.deepEqual(Object.keys(base.adapters).sort(), listAdapters().map((entry) => entry.id).sort());
});

test('「自己拼 body」的 14 条协议都有注释说明，且分派方式没变', () => {
  const base = baseline();
  const derived = {};
  for (const entry of listAdapters()) derived[entry.id] = coversOf(adapterFor(entry.id));
  const own = Object.keys(derived)
    .filter((id) => derived[id] !== 'prepare' && derived[id] !== 'prepare-async')
    .sort();
  assert.deepEqual(own, Object.keys(OWN_BODY_NOTES).sort(), 'OWN_BODY_NOTES 与实际「自己拼 body」的协议对不上：新增/减少一条都要写清楚');
  for (const id of Object.keys(derived)) {
    assert.equal(base.adapters[id].covers, derived[id], id + ' 的请求体来源变了（execute / async.build / prepare*），基线要重新评估');
  }
});

test('dashscope-wanx 走 prepareAsync，但提交体同样来自 composeBody（基线是真实请求体）', () => {
  assert.equal(coversOf(adapterFor('dashscope-wanx')), 'prepare-async');
  const body = baseline().adapters['dashscope-wanx'].generate.body;
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'parameters']);
});

test('prepareEdit 的抛错情况与基线一致（当前一条都不抛）', () => {
  const base = baseline();
  const throwing = Object.entries(base.adapters)
    .filter(([, entry]) => typeof entry.edit.throws === 'string')
    .map(([id]) => id);
  // 注意：这里原本的预期是「endpoints.edit 为空 ⇒ prepareEdit 抛错」。实测不是这样：
  // prepareEdit 根本不看 endpoints.edit，照样把 body 拼出来，只是 path 是空串。
  // 那条路在 callImageApi() 里走不到（adapterSupportsKind 先报「不支持编辑」），
  // 所以基线把它记成「body 拼得出来但发不出去」，见下一个用例。
  assert.deepEqual(throwing, [], '有协议开始抛错了：要么是回归，要么基线要更新并写清原因');
});

test('样例模型没有编辑端点时：编辑体拼得出来，但 path 为空，永远发不出去', () => {
  const base = baseline();
  const unsupported = Object.entries(base.adapters)
    .filter(([, entry]) => entry.edit.supported === false)
    .map(([id, entry]) => ({ id, path: entry.edit.path, hasBody: !!(entry.edit.body) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  // together / localai / xai-imagine / zhipu 合并进 openai-images（edit:'none'）后不再是独立协议，
  // 它们的「没有编辑」形态由 variants 段锁住（legacy/*）。
  assert.deepEqual(unsupported.map((item) => item.id), ['dashscope-wanx', 'ideogram', 'stability', 'swarmui']);
  for (const item of unsupported) {
    assert.equal(item.path, '', item.id + ' 的 edit 端点应该还是空的');
    assert.equal(item.hasBody, true, item.id + ' 的编辑体仍然会被拼出来（只是没人发），别把它当成「没有 body」');
  }
});

/**
 * 键顺序规范化后再比：基线里的 body 是 JSON 对象，键顺序不是线上约定（HTTP/JSON
 * 语义上都无所谓），而且这份基线从来没有盯过键顺序——`git show HEAD` 的代码产出的
 * 键顺序就已经和提交里的基线不一致（只有 `assert.deepEqual` 在比，它不看顺序）。
 * 所以「逐字节一致」在这里的口径是：**键值完全一致**，顺序归一。
 */
function canonicalJson(value) {
  const normalize = (node) => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = normalize(node[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(normalize(value));
}

test('合并前的九条协议：同一套输入按新写法重放，body 与合并前完全一致', () => {
  const base = baseline();
  assert.ok(base.variants && typeof base.variants === 'object', '基线里缺少 variants 段');
  assert.deepEqual(Object.keys(base.variants).sort(), Object.keys(VARIANTS).sort());
  for (const name of Object.keys(VARIANTS)) {
    const recorded = base.variants[name];
    const now = recordVariant(name);
    assert.equal(now.model, recorded.model, name + ' 的基线是用另一个 model 录的');
    assert.deepEqual(now.options, recorded.options, name + ' 的选项变了');
    assert.equal(now.quality, recorded.quality, name + ' 的默认质量变了');
    assert.equal(
      canonicalJson(now.generate), canonicalJson(recorded.generate),
      name + ' 的 generate 请求体变了（合并只能改名字，不能改线上 body）'
    );
    // 没有编辑端点的老协议（xai-imagine / zhipu）：prepareEdit 仍会拼出一个 body，
    // 但 adapterSupportsKind 先拦住了，那条路永远发不出去——只锁「不支持 + path 为空」，
    // 不锁死路径 body 的形状（它不是行为契约）。
    if (recorded.edit.supported === false) {
      assert.equal(now.edit.supported, false, name + ' 的编辑支持形态变了');
      assert.equal(now.edit.path, '', name + ' 的编辑地址应该还是空串');
    } else {
      assert.equal(
        canonicalJson(now.edit), canonicalJson(recorded.edit),
        name + ' 的 edit 请求体变了（合并只能改名字，不能改线上 body）'
      );
    }
    // 有 reference 的条目：合并前 execute() 真正发出去的 body 也当场对一遍，
    // 免得「基线重建」把这份唯一的对照点洗掉。
    const reference = VARIANTS[name].reference;
    if (reference) {
      assert.equal(now.generate.path, reference.generatePath, name + ' 的提交地址变了');
      assert.equal(
        canonicalJson(now.generate.body), canonicalJson(reference.generate),
        name + ' 的 generate body 与合并前 execute() 发出的不一致'
      );
    }
  }
});

test('provider.auth 只改鉴权头，不改 body', () => {
  const bearer = recordVariant('option/auth=bearer');
  const apiKey = recordVariant('option/auth=api-key');
  assert.deepEqual(apiKey.generate, bearer.generate, '鉴权方式不该影响 generate body');
  assert.deepEqual(apiKey.edit, bearer.edit, '鉴权方式不该影响 edit body');

  // 基线只锁 body，不记请求头；鉴权形态单独在这里取一次真实请求头来对。
  const entry = VARIANTS['option/auth=api-key'];
  const headersOf = (auth) => {
    const provider = { adapter: 'openai-images', baseUrl: entry.baseUrl, key: 'test-key' };
    if (auth) provider.auth = auth;
    return prepareGenerate(resolveAdapter(provider, entry.model), provider, {
      model: entry.model,
      prompt: FIXED.prompt,
      negativePrompt: FIXED.negativePrompt,
      fitted: fitSize(provider, FIXED.sizeRequest, entry.model),
      quality: null,
      images: [FIXED.image]
    }, new Set()).headers;
  };
  assert.equal(headersOf(undefined).Authorization, 'Bearer test-key', '没设 provider.auth 时回落到 bearer');
  const apiKeyHeaders = headersOf({ mode: 'api-key' });
  assert.equal(apiKeyHeaders['api-key'], 'test-key');
  assert.equal(apiKeyHeaders.Authorization, undefined);
});

test('openai-chat 的 generate 体是空的：尺寸走提示词，不是漏字段', () => {
  const recorded = baseline().adapters['openai-chat'];
  // size 策略是 control:'prompt'，encodeSize() 对 prompt 形态直接返回 {}；
  // 这条协议也确实没有 send 白名单。搬迁时它必须继续是空体，不能突然多出 size。
  assert.deepEqual(recorded.generate.body, {});
  assert.equal(recorded.generate.path, '/chat/completions');
});

for (const id of listAdapters().map((entry) => entry.id)) {
  test('协议 ' + id + '：generate / edit 请求体与基线一致', () => {
    const recorded = baseline().adapters[id];
    assert.ok(recorded, '基线里没有 ' + id + '，先重建基线再改代码');
    assert.equal(recorded.model, MODELS[id], id + ' 的基线是用另一个 model 录的，先对齐 MODELS 表');
    const now = recordAdapter(id);
    assert.equal(now.quality, recorded.quality, id + ' 的默认质量变了');
    assert.equal(now.covers, recorded.covers, id + ' 的请求体来源变了');
    assert.deepEqual(now.generate, recorded.generate, id + ' 的 generate 请求体（path / body）变了');
    assert.deepEqual(now.edit, recorded.edit, id + ' 的 edit 请求体（path / body）变了');
  });
}
