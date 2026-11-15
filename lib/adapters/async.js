/**
 * 异步队列型协议：BFL / fal.ai / Replicate / 魔搭 ModelScope。
 *
 * 这些平台的共同点是「提交 → 轮询 → 拿一个会过期的 URL」，差异全部收敛到
 * async 描述符：build / submitPath / pollUrl / pollHeaders / statusOf / resolve。
 * 拿到 URL 必须立刻下载，不能交给上层。
 */
import { request } from '../net.js';
import {
  baseUrlOf, headersFor, authHeaders, readJsonResponse, dataUrlOf, nearestAspect, resolutionFor
} from '../adapter-kit.js';

function hostOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

function promptWithNegative(input) {
  const prompt = String((input && input.prompt) || '');
  const negative = String((input && input.negativePrompt) || '').trim();
  return negative ? prompt + '\n\nAvoid: ' + negative : prompt;
}

function imagesOf(input) {
  return (Array.isArray(input && input.images) ? input.images : [])
    .filter((image) => image && image.buffer && image.contentType);
}

function sizeOf(input) {
  const fitted = input && input.fitted;
  if (!fitted || fitted.omit || fitted.size === 'none' || fitted.size === 'auto') return null;
  if (!fitted.width || !fitted.height) return null;
  return { width: fitted.width, height: fitted.height, aspect: fitted.aspect || '', tier: fitted.tier || '' };
}

/* ------------------------------------------------------------------ BFL */

const BFL_SUCCESS = new Set(['READY']);
const BFL_FAILURE = new Set([
  'ERROR', 'REQUEST MODERATED', 'CONTENT MODERATED', 'NO CARD GENERATED', 'TASK NOT FOUND'
]);

function bflBuild(input) {
  const model = String(input.model || '');
  const images = imagesOf(input);
  const body = { prompt: promptWithNegative(input) };
  const size = sizeOf(input) || { width: 1024, height: 1024 };

  // FLUX 3 只认 aspect_ratio / resolution / images，未知字段直接 422。
  if (/^flux-3/i.test(model)) {
    body.aspect_ratio = size.aspect || nearestAspect(size.width, size.height);
    if (size.tier) body.resolution = String(size.tier);
    if (images.length) body.images = images.slice(0, 10).map(dataUrlOf);
    return body;
  }

  // Kontext / Ultra 用 aspect_ratio，没有 width/height。
  if (/kontext|ultra/i.test(model)) {
    body.aspect_ratio = nearestAspect(size.width, size.height);
    body.output_format = 'png';
    if (images.length) {
      body.input_image = dataUrlOf(images[0]);
      for (let index = 1; index < images.length && index < 4; index++) {
        body['input_image_' + (index + 1)] = dataUrlOf(images[index]);
      }
    }
    return body;
  }

  body.width = size.width;
  body.height = size.height;
  body.output_format = 'png';
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') body.seed = input.seed;
  if (images.length) {
    body.input_image = dataUrlOf(images[0]);
    for (let index = 1; index < images.length && index < 8; index++) {
      body['input_image_' + (index + 1)] = dataUrlOf(images[index]);
    }
  }
  return body;
}

/* ------------------------------------------------------------------ fal */

function falModelPath(model) {
  return '/' + String(model || '').trim().replace(/^\/+/, '');
}

function falBuild(input) {
  const body = { prompt: promptWithNegative(input), num_images: 1, output_format: 'jpeg' };
  const size = sizeOf(input);
  if (size) body.image_size = { width: size.width, height: size.height };
  const images = imagesOf(input);
  // fal 的单图端点用 image_url、多图端点用 image_urls，混用会 422。
  if (images.length === 1) body.image_url = dataUrlOf(images[0]);
  else if (images.length > 1) body.image_urls = images.map(dataUrlOf);
  return body;
}

/* -------------------------------------------------------------- Replicate */

const schemaCache = new Map();
const SCHEMA_TTL = 10 * 60 * 1000;

/** 测试用：清掉模型 schema 缓存。 */
export function resetAsyncSchemaCache() {
  schemaCache.clear();
}

function replicateName(model) {
  return String(model || '').trim().replace(/^\/+/, '');
}

const SCHEMA_CACHE_LIMIT = 100;

/** 读模型 Input schema；失败就返回 null，且不缓存失败（瞬时 503 不该让后面 10 分钟都退化）。 */
async function inputSchemaOf(provider, model, signal) {
  const name = replicateName(model);
  if (!name.includes('/')) return null;
  const key = baseUrlOf(provider) + '|' + name;
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.at < SCHEMA_TTL) return cached.value;
  try {
    const response = await request(baseUrlOf(provider) + '/models/' + name, {
      headers: headersFor(provider, false), signal: signal
    });
    if (!response.ok) throw new Error('schema ' + response.status);
    const payload = await readJsonResponse(response, 5 * 1024 * 1024);
    const schema = payload
      && payload.latest_version
      && payload.latest_version.openapi_schema
      && payload.latest_version.openapi_schema.components
      && payload.latest_version.openapi_schema.components.schemas
      && payload.latest_version.openapi_schema.components.schemas.Input;
    const properties = schema && schema.properties ? schema.properties : null;
    if (!properties) return null;
    if (schemaCache.size >= SCHEMA_CACHE_LIMIT) {
      const oldest = schemaCache.keys().next().value;
      if (oldest) schemaCache.delete(oldest);
    }
    schemaCache.set(key, { at: Date.now(), value: properties });
    return properties;
  } catch (_error) {
    return null;
  }
}

const SCALAR_IMAGE_FIELDS = ['input_image', 'image', 'image_url'];
const ARRAY_IMAGE_FIELDS = ['images', 'image_urls'];

function isImageString(spec) {
  return !!spec && (spec.type === 'string' || spec.format === 'uri');
}

/**
 * 只认 schema 里声明过的图片字段，并且要求类型对得上。
 * Replicate 对未知字段是静默忽略的，猜错会让参考图被丢掉还照常出图。
 */
function imageFieldOf(properties) {
  if (!properties) return null;
  for (const name of SCALAR_IMAGE_FIELDS) {
    if (isImageString(properties[name])) return { name: name, array: false };
  }
  for (const name of ARRAY_IMAGE_FIELDS) {
    const spec = properties[name];
    if (!spec) continue;
    if (spec.type === 'array') return { name: name, array: true };
    if (isImageString(spec)) return { name: name, array: false };
  }
  return null;
}

function sizeFieldsOf(properties, size) {
  if (!properties || !size) return null;
  const widthSpec = properties.width;
  const heightSpec = properties.height;
  const numeric = (spec) => !!spec && (spec.type === 'integer' || spec.type === 'number');
  if (numeric(widthSpec) && numeric(heightSpec)) {
    return { width: size.width, height: size.height };
  }
  if (properties.aspect_ratio) {
    const allowed = Array.isArray(properties.aspect_ratio.enum) ? properties.aspect_ratio.enum : undefined;
    return { aspect_ratio: nearestAspect(size.width, size.height, allowed) };
  }
  return null;
}

async function replicateBuild(input, provider, signal) {
  const images = imagesOf(input);
  const properties = await inputSchemaOf(provider, input.model, signal);
  const payload = { prompt: promptWithNegative(input) };
  const notes = [];

  if (images.length) {
    const field = imageFieldOf(properties);
    if (!field) {
      notes.push('未识别模型输入字段，已省略参考图');
    } else if (field.array) {
      payload[field.name] = images.map(dataUrlOf);
    } else {
      payload[field.name] = dataUrlOf(images[0]);
      if (images.length > 1) notes.push('该模型只接受一张参考图，已只用第一张');
    }
  }

  const size = sizeOf(input);
  if (size) {
    const sizeFields = sizeFieldsOf(properties, size);
    if (sizeFields) Object.assign(payload, sizeFields);
    else notes.push('未识别模型的尺寸字段，已省略尺寸；要锁定尺寸请开启严格模式');
  }

  return notes.length ? { body: { input: payload }, note: notes.join('；') } : { body: { input: payload } };
}

/* ------------------------------------------------------------ ModelScope */

const MODELSCOPE_SUCCESS = new Set(['SUCCEED', 'SUCCEEDED', 'SUCCESS']);
const MODELSCOPE_FAILURE = new Set(['FAILED', 'CANCELED', 'CANCELLED', 'ERROR']);

/** 魔搭的 OpenAI 兼容地址可能带 /v1，也可能只给站点根；统一到站点根再拼 /v1/...。 */
function modelscopeRoot(provider) {
  return baseUrlOf(provider).replace(/\/v1$/i, '');
}

/**
 * 魔搭的失败载荷可能是 message 字符串、errors:{message} 对象或 errors[] 数组，
 * 逐层挖出第一句可读文本，别把 [object Object] 抛给用户。
 */
function firstMessage(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstMessage(item, depth + 1);
      if (text) return text;
    }
    return '';
  }
  for (const key of ['message', 'msg', 'detail', 'error', 'errors', 'reason', 'logs']) {
    if (value[key] === undefined) continue;
    const text = firstMessage(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function modelscopeBuild(input) {
  const body = {
    model: String((input && input.model) || ''),
    prompt: String((input && input.prompt) || '')
  };
  // 魔搭原生支持 negative_prompt：照字段发，不要像不支持的平台那样拼进 prompt。
  const negative = String((input && input.negativePrompt) || '').trim();
  if (negative) body.negative_prompt = negative;
  const size = sizeOf(input);
  if (size) body.size = size.width + 'x' + size.height;
  const images = imagesOf(input);
  if (images.length) {
    // 图片字段是 image_url：一张发字符串、多张发数组；网关吃 data URI。
    const urls = images.slice(0, 10).map(dataUrlOf);
    body.image_url = urls.length === 1 ? urls[0] : urls;
  }
  return body;
}

function modelscopePollUrl(submission, provider) {
  const taskId = String((submission && submission.task_id) || '');
  if (!taskId) {
    throw new Error('ModelScope 提交后没有返回 task_id：'
      + JSON.stringify(submission || {}).slice(0, 200));
  }
  return modelscopeRoot(provider) + '/v1/tasks/' + encodeURIComponent(taskId);
}

/* ----------------------------------------------------------------- 描述符 */

export const ASYNC_ADAPTERS = [
  {
    id: 'bfl',
    label: 'Black Forest Labs (FLUX)',
    match: (provider) => /(^|\.)bfl\.ai$/i.test(hostOf(provider)),
    authHeader: 'x-key',
    local: false,
    endpoints: { generate: '/v1', edit: '/v1' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    // FLUX.2 只吃 width/height；FLUX 3 换成「比例 + 小写档位」，两代 schema 不能共用。
    size: { control: 'wh', style: 'width-height', minSide: 64, maxPixels: 4194304 },
    sizeByModel: [
      {
        match: /flux-?3/i,
        size: {
          control: 'aspect', style: 'aspect', field: 'aspect_ratio',
          aspects: ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21', 'auto'],
          tiers: [
            { value: '768sq', pixels: 589824 }, { value: '1k', pixels: 1048576 },
            { value: '1.5k', pixels: 2359296 }, { value: '2k', pixels: 4194304 }, { value: '4k', pixels: 16777216 }
          ],
          minSide: 256, maxSide: 6256, maxPixels: 16822272
        }
      }
    ],
    async listModels() {
      return [
        'flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-9b', 'flux-2-klein-4b',
        'flux-3-image', 'flux-3-image-klein', 'flux-kontext-pro', 'flux-kontext-max',
        'flux-pro-1.1', 'flux-pro-1.1-ultra'
      ];
    },
    async: {
      edit: true,
      build: bflBuild,
      submitPath: (input) => '/' + String(input.model || '').trim().replace(/^\/+/, ''),
      pollUrl: (submission) => String(submission.polling_url || ''),
      pollHeaders: (provider) => ({ 'x-key': String((provider && provider.key) || '') }),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toUpperCase();
        if (BFL_SUCCESS.has(status)) return { state: 'success', status: status };
        if (BFL_FAILURE.has(status)) {
          return { state: 'failure', status: status, message: String((payload && payload.detail) || status) };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload) => {
        const sample = payload && payload.result && payload.result.sample;
        if (!sample) throw new Error('BFL 任务完成了但没有返回图片');
        return { url: sample };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  },
  {
    id: 'fal',
    label: 'fal.ai',
    match: (provider) => /(^|\.)(queue\.)?fal(run)?\.(run|com)$/i.test(hostOf(provider)),
    authHeader: 'fal-key',
    local: false,
    endpoints: { generate: '/', edit: '/' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request('https://api.fal.ai/v1/models?category=text-to-image', {
        headers: headersFor(provider, false), signal: signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload && Array.isArray(payload.models) ? payload.models : [])
        .map((item) => String((item && item.endpoint_id) || '').trim())
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: falBuild,
      submitPath: (input) => falModelPath(input.model),
      pollUrl: (submission) => String(submission.status_url || ''),
      pollHeaders: (provider) => authHeaders(provider, { authHeader: 'fal-key' }),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toUpperCase();
        if (status === 'COMPLETED') {
          if (payload && payload.error) {
            return { state: 'failure', status: status, message: String(payload.error) };
          }
          return { state: 'success', status: status };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload, provider, signal, submission) => {
        const url = (submission && submission.response_url) || (payload && payload.response_url);
        if (!url) throw new Error('fal 任务完成了但没有 response_url');
        const response = await request(url, { headers: authHeaders(provider, { authHeader: 'fal-key' }), signal: signal });
        const result = await readJsonResponse(response, 64 * 1024 * 1024);
        const first = result && Array.isArray(result.images) ? result.images[0] : null;
        if (!first || !first.url) throw new Error('fal 没有返回图片');
        return { url: String(first.url) };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  },
  {
    id: 'replicate',
    label: 'Replicate',
    match: (provider) => hostOf(provider) === 'api.replicate.com',
    authHeader: 'bearer',
    local: false,
    endpoints: { generate: '/', edit: '/' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal: signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload && Array.isArray(payload.results) ? payload.results : [])
        .map((item) => (item && item.owner && item.name ? item.owner + '/' + item.name : ''))
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: replicateBuild,
      submitPath: (input) => '/models/' + replicateName(input.model) + '/predictions',
      pollUrl: (submission) => String((submission && submission.urls && submission.urls.get) || ''),
      pollHeaders: (provider) => headersFor(provider, false),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toLowerCase();
        if (status === 'succeeded') return { state: 'success', status: status };
        if (['failed', 'canceled', 'aborted'].includes(status)) {
          return { state: 'failure', status: status, message: String((payload && payload.error) || status) };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload) => {
        const output = payload && payload.output;
        const url = Array.isArray(output) ? output[0] : output;
        if (!url) throw new Error('Replicate 任务完成了但没有返回图片');
        return { url: String(url) };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    match: (provider) => /(^|\.)api-inference\.modelscope\.(cn|ai)$/i.test(hostOf(provider)),
    authHeader: 'bearer',
    local: false,
    endpoints: { generate: '/v1/images/generations', edit: '/v1/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    // 图片生成是任务制：不带这个头拿不到 task_id。
    headers: { 'X-ModelScope-Async-Mode': 'true' },
    editFields: [],
    maxN: 1,
    // 网关按每边 [64, 2048] 校验；再对齐到 16 的倍数，减少模型侧的取整与拒绝。
    // 但不同模型族上限差很多（Qwen-Image 只到 1664），按模型覆盖。
    size: {
      style: 'string', field: 'size', multiple: 16, minSide: 64, maxSide: 2048,
      default: '1024x1024', onUnsupported: 'nearest'
    },
    sizeByModel: [
      { match: /flux/i, size: { style: 'string', field: 'size', multiple: 16, minSide: 64, maxSide: 1024, default: '1024x1024' } },
      { match: /qwen-image/i, size: { style: 'string', field: 'size', multiple: 16, minSide: 64, maxSide: 1664, default: '1024x1024' } },
      { match: /z-image/i, size: { style: 'string', field: 'size', multiple: 16, minSide: 512, maxSide: 2048, default: '1024x1024' } }
    ],
    async: {
      edit: true,
      build: modelscopeBuild,
      submitPath: (input, provider) => modelscopeRoot(provider) + '/v1/images/generations',
      pollUrl: modelscopePollUrl,
      // 轮询要声明任务类型，图片生成是 image_generation（视频是另一套）。
      pollHeaders: (provider) => Object.assign(
        { 'X-ModelScope-Task-Type': 'image_generation' },
        authHeaders(provider, { authHeader: 'bearer' })
      ),
      statusOf: (payload) => {
        const status = String((payload && payload.task_status) || '').toUpperCase();
        if (MODELSCOPE_SUCCESS.has(status)) return { state: 'success', status: status };
        if (MODELSCOPE_FAILURE.has(status)) {
          return { state: 'failure', status: status, message: firstMessage(payload) || status };
        }
        return { state: 'pending', status: status };
      },
      // 提交响应可能提前回 SUCCEED 但还没有图，所以结果只认轮询到的 output_images。
      resolve: async (payload) => {
        const images = Array.isArray(payload && payload.output_images) ? payload.output_images : [];
        for (const item of images) {
          const url = typeof item === 'string' ? item : (item && (item.url || item.image_url));
          if (url) return { url: String(url) };
        }
        const first = payload && Array.isArray(payload.data) ? payload.data[0] : null;
        if (first && first.url) return { url: String(first.url) };
        throw new Error('ModelScope 任务完成了但没有返回图片');
      },
      intervalMs: 2000,
      timeoutMs: 300000
    }
  }
];
