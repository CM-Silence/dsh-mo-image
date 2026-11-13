/**
 * 异步队列型协议：BFL / fal.ai / Replicate。
 *
 * 三个平台的共同点是「提交 → 轮询 → 拿一个会过期的 URL」，差异全部收敛到
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
  return { width: fitted.width, height: fitted.height };
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

  if (/^flux-3/i.test(model)) {
    const size = sizeOf(input);
    if (size) {
      body.aspect_ratio = nearestAspect(size.width, size.height);
      body.resolution = resolutionFor(size.width, size.height);
    }
    if (images.length) body.images = images.map(dataUrlOf);
    return body;
  }

  const size = sizeOf(input) || { width: 1024, height: 1024 };
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
  if (images.length) body.image_urls = images.map(dataUrlOf);
  return body;
}

/* -------------------------------------------------------------- Replicate */

const schemaCache = new Map();
const schemaRequests = new Map();
const SCHEMA_TTL = 10 * 60 * 1000;

/** 测试用：清掉模型 schema 缓存。 */
export function resetAsyncSchemaCache() {
  schemaCache.clear();
  schemaRequests.clear();
}

function replicateName(model) {
  return String(model || '').trim().replace(/^\/+/, '');
}

/** 读模型 Input schema；失败就返回 null（绝不猜字段）。 */
async function inputSchemaOf(provider, model, signal) {
  const name = replicateName(model);
  if (!name.includes('/')) return null;
  const key = baseUrlOf(provider) + '|' + name;
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.at < SCHEMA_TTL) return cached.value;
  if (schemaRequests.has(key)) return schemaRequests.get(key);

  const pending = (async () => {
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
      schemaCache.set(key, { at: Date.now(), value: properties });
      return properties;
    } catch (_error) {
      schemaCache.set(key, { at: Date.now(), value: null });
      return null;
    } finally {
      schemaRequests.delete(key);
    }
  })();
  schemaRequests.set(key, pending);
  return pending;
}

function pickImageField(properties) {
  if (!properties) return '';
  const names = Object.keys(properties);
  for (const candidate of ['input_image', 'image', 'images', 'image_url', 'image_urls']) {
    if (names.includes(candidate)) return candidate;
  }
  return names.find((name) => /image/i.test(name) && !/mask/i.test(name)) || '';
}

async function replicateBuild(input, provider, signal) {
  const images = imagesOf(input);
  const properties = await inputSchemaOf(provider, input.model, signal);
  const payload = { prompt: promptWithNegative(input) };

  if (images.length) {
    const field = pickImageField(properties);
    if (!field) {
      return { body: { input: payload }, note: '未识别模型输入字段，已省略参考图' };
    }
    payload[field] = images.length === 1 ? dataUrlOf(images[0]) : images.map(dataUrlOf);
  }

  const size = sizeOf(input);
  if (size && properties && properties.aspect_ratio) {
    const allowed = properties.aspect_ratio.enum && Array.isArray(properties.aspect_ratio.enum)
      ? properties.aspect_ratio.enum
      : undefined;
    payload.aspect_ratio = nearestAspect(size.width, size.height, allowed);
  }
  return { body: { input: payload } };
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
  }
];
