import { mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  resolveAdapter, describeAdapter, fitSize, escalateSize,
  prepareGenerate, prepareEdit, prepareAsync, pollUrlFor, pollHeaders,
  readTaskId, readTaskState, decodeImagePayload, classifyFailure,
  fetchImageUrl, resizeTo, adapterBase
} from './adapters.js';

const PLUGIN = 'dsh-mo-image';
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE = path.join(HOME, 'mo-image');
const CONFIG_FILE = path.join(STATE, 'config.json');
const OUT_DIR = path.join(STATE, 'out');
const HOST_LOG = path.join(STATE, 'host.log');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REF_COUNT = 16;

function ensureDirs() { mkdirSync(OUT_DIR, { recursive: true }); }
function logHost(message) {
  try { appendFileSync(HOST_LOG, new Date().toISOString() + ' ' + message + '\n'); } catch (_error) { /* diagnostics */ }
}
function emptyConfig() {
  return {
    version: 1, providers: [], active: { providerId: '', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  };
}
/** off / medium / xhigh 这些旧值都收敛到现在的四挡：off / low / high / max。 */
function normalizeQuality(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'medium') return 'high';
  if (raw === 'xhigh') return 'max';
  return ['off', 'low', 'high', 'max'].includes(raw) ? raw : 'high';
}
function normalizeDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const side = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(4096, Math.max(64, Math.round(number)));
  };
  let width = side(source.width, 0);
  let height = side(source.height, 0);
  if (!width || !height) {
    // 兼容上一版的 { size: "1024x1024" }
    const legacy = /^(\d{2,5})x(\d{2,5})$/.exec(String(source.size || '').trim().toLowerCase().replace(/[×*]/g, 'x'));
    if (legacy) { width = side(legacy[1], 1024); height = side(legacy[2], 1024); }
  }
  return {
    quality: normalizeQuality(source.quality),
    auto: source.auto === undefined ? true : !!source.auto,
    width: width || 1024,
    height: height || 1024
  };
}
/** Off 表示不把 quality 发给模型。 */
function resolveQuality(args, defaults) {
  const explicit = args && args.quality !== undefined && args.quality !== null && String(args.quality).trim() !== '';
  const value = normalizeQuality(explicit ? args.quality : (defaults && defaults.quality));
  return value === 'off' ? undefined : value;
}
/** 工具参数优先；没传就看选择器里的「自动 / 手填长宽」。 */
function resolveSizeArg(args, defaults) {
  const explicit = args && args.size !== undefined && args.size !== null && String(args.size).trim() !== '';
  if (explicit) return String(args.size).trim();
  if (defaults && defaults.auto === false) return (defaults.width || 1024) + 'x' + (defaults.height || 1024);
  return 'none';
}
function normalizeConfig(raw) {
  const out = emptyConfig();
  if (!raw || typeof raw !== 'object') return out;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  for (const item of providers) {
    if (!item || typeof item !== 'object') continue;
    const models = Array.from(new Set((Array.isArray(item.models) ? item.models : [])
      .map((m) => String(m || '').trim()).filter(Boolean)));
    const names = {};
    if (item.names && typeof item.names === 'object') for (const model of models) if (typeof item.names[model] === 'string') names[model] = item.names[model];
    out.providers.push({
      id: String(item.id || randomUUID()), name: String(item.name || ''),
      baseUrl: String(item.baseUrl || '').replace(/\/+$/, ''), key: String(item.key || ''),
      protocol: String(item.protocol || 'openai-images'), adapter: String(item.adapter || ''), models, names
    });
  }
  const wanted = raw.active && typeof raw.active === 'object' ? raw.active : {};
  const provider = out.providers.find((p) => p.id === wanted.providerId);
  out.active = { providerId: provider ? provider.id : '', model: provider && provider.models.includes(wanted.model) ? wanted.model : '' };
  out.defaults = normalizeDefaults(raw.defaults);
  return out;
}
async function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return emptyConfig();
    return normalizeConfig(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  } catch (_error) { return emptyConfig(); }
}
async function writeConfig(config) {
  ensureDirs();
  const next = normalizeConfig(config);
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
function pickProvider(config, args, purpose) {
  const providers = config.providers || [];
  if (!providers.length) throw new Error('还没有配置生图模型。请先到 DSH 设置 → 生图模型 添加提供商、模型和 API Key。');
  let provider = null;
  let model = String(args.model || '').trim();
  if (args.provider) {
    provider = providers.find((p) => p.id === args.provider || p.name === args.provider) || null;
    if (!provider) throw new Error('找不到指定的生图提供商：' + args.provider);
  } else {
    if (!config.active.providerId) throw new Error('还没有选择当前生图模型。请先到 DSH 设置 → 生图模型 选择当前模型。');
    provider = providers.find((p) => p.id === config.active.providerId) || null;
    if (!provider) throw new Error('当前选中的生图提供商不存在，请到设置 → 生图模型重新选择。');
  }
  if (!model) {
    if (purpose === 'edit') model = (provider.models || []).find((m) => /sunburst|edit/i.test(m)) || '';
    if (!model) model = config.active.providerId === provider.id ? config.active.model : ((provider.models || [])[0] || '');
  }
  if (!model || !(provider.models || []).includes(model)) {
    if (provider.models && provider.models.length) throw new Error('当前模型不在提供商的模型目录里，请到设置 → 生图模型补全。' + (purpose === 'edit' ? '图片编辑建议使用 gpt-image-2.5-sunburst 等编辑模型。' : ''));
    throw new Error('当前提供商还没有模型 ID，请到设置 → 生图模型添加并选择模型。');
  }
  // 协议/适配器解析交给 resolveAdapter()：不同模型族的请求形状由适配器描述符定义。
  if (!provider.baseUrl) throw new Error('生图提供商缺少 API 地址，请到设置 → 生图模型补全。');
  if (!provider.key) throw new Error('生图提供商缺少 API Key，请到设置 → 生图模型补全。');
  return { provider, model };
}
function safeExt(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'png';
}
function makeSignal(exec, timeoutMs) {
  const signals = [];
  if (exec && exec.signal) signals.push(exec.signal);
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  return signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0];
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch (_error) { return null; }
}
function sizeLabel(fitted) {
  if (!fitted) return '';
  if (fitted.omit || fitted.size === 'none') return 'auto';
  if (fitted.size === 'auto') return fitted.width && fitted.height ? fitted.width + 'x' + fitted.height : 'auto';
  return fitted.size;
}
function imageErrorText(failure) {
  const text = '生图接口失败：' + failure.message;
  if (failure.kind === 'size') return text + '（该模型对尺寸有最小/最大像素限制，换一个尺寸或换支持该尺寸的模型）';
  if (failure.kind === 'auth') return text + '（检查 API Key 与地址是否正确）';
  if (failure.kind === 'param') return text + '（请求参数与模型不兼容）';
  return text;
}
/**
 * 真正发请求的地方：按适配器组装 → 发 → 解码。
 * 上游报错时只在三类情况下自愈：字段不认识（摘掉重试）、尺寸被拒（往上抬一档）、限流/5xx（退避重试）。
 */
/**
 * 异步入队型：提交任务 → 轮询到 SUCCEEDED → 下载图片。
 * 提交阶段的参数错误照旧自愈（摘字段 / 抬尺寸），轮询阶段只对 429、5xx 继续等。
 */
async function callAsyncImage(kind, adapter, provider, input, signal) {
  if (kind === 'edit') throw new Error('该模型（' + adapter.label + '）暂不支持参考图编辑，请到设置里换一个编辑模型。');
  const drops = new Set();
  let fitted = input.fitted;
  let submission = null;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const built = prepareAsync(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops);
    const response = await fetch(adapterBase(provider) + built.path, {
      method: 'POST', headers: built.headers, body: built.body, signal: signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.ok) {
      submission = safeJson(buffer);
      break;
    }
    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' async submit ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));
    if (failure.kind === 'param' && failure.drop && !drops.has(failure.drop)) {
      drops.add(failure.drop);
      logHost(kind + ' async drop param "' + failure.drop + '"');
      continue;
    }
    if (failure.kind === 'size') {
      const next = escalateSize(adapter, fitted);
      if (next.size !== fitted.size) {
        fitted = next;
        logHost(kind + ' async size escalate → ' + next.size);
        continue;
      }
    }
    throw new Error(imageErrorText(failure));
  }
  if (!submission) throw new Error(imageErrorText(lastFailure || { kind: 'unknown', message: '任务提交失败' }));

  const taskId = readTaskId(adapter, submission);
  if (!taskId) throw new Error('任务提交后没有拿到 task_id：' + JSON.stringify(submission).slice(0, 200));
  logHost(kind + ' async task=' + taskId + ' submitted');

  const poll = adapter.poll || {};
  const deadline = Date.now() + (Number(poll.timeoutMs) || 300000);
  let interval = Number(poll.intervalMs) || 2000;
  let state = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    const response = await fetch(pollUrlFor(adapter, provider, taskId), {
      method: 'GET', headers: pollHeaders(provider), signal: signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const payload = safeJson(buffer);
    if (!response.ok || !payload) {
      const failure = classifyFailure(response.status, buffer.toString('utf8'));
      if (failure.retryable) continue;
      throw new Error(imageErrorText(failure));
    }
    state = readTaskState(adapter, payload);
    if (state.state === 'success') {
      const decoded = decodeImagePayload(state.node, null);
      const image = decoded.bytes ? decoded : await fetchImageUrl(decoded.url, signal);
      logHost(kind + ' async task=' + taskId + ' done');
      return { fitted: fitted, bytes: image.bytes, contentType: image.contentType };
    }
    if (state.state === 'failure') {
      throw new Error('生图任务失败（' + state.status + '）：' + state.message);
    }
    interval = Math.min(Math.round(interval * 1.15), 5000);
  }
  throw new Error('生图任务超时（' + taskId + (state ? '，最后状态 ' + state.status : '') + '）');
}
async function callImageApi(kind, adapter, provider, input, signal) {
  if (adapter.async) return callAsyncImage(kind, adapter, provider, input, signal);
  const fieldNames = (adapter.editFields && adapter.editFields.length) ? adapter.editFields : ['image'];
  const drops = new Set();
  let fitted = input.fitted;
  let fieldIndex = 0;
  let sizeRetries = 0;
  let retries = 0;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const built = kind === 'edit'
      ? prepareEdit(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops, fieldNames[fieldIndex])
      : prepareGenerate(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops);
    const response = await fetch(adapterBase(provider) + built.path, {
      method: 'POST', headers: built.headers, body: built.body, signal: signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());

    if (response.ok) {
      const parsed = safeJson(buffer);
      const decoded = parsed ? decodeImagePayload(parsed, null) : decodeImagePayload(null, buffer);
      const image = decoded.bytes ? decoded : await fetchImageUrl(decoded.url, signal);
      return { fitted: fitted, bytes: image.bytes, contentType: image.contentType };
    }

    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' upstream ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));

    if (failure.kind === 'param' && failure.drop && !drops.has(failure.drop)) {
      drops.add(failure.drop);
      logHost(kind + ' drop param "' + failure.drop + '" for adapter ' + adapter.id);
      continue;
    }
    if (kind === 'edit' && response.status === 400 && /image/i.test(failure.message) && fieldIndex + 1 < fieldNames.length) {
      fieldIndex++;
      logHost(kind + ' retry with form field "' + fieldNames[fieldIndex] + '"');
      continue;
    }
    if (failure.kind === 'size' && sizeRetries < 2) {
      const next = escalateSize(adapter, fitted);
      if (next.size !== fitted.size) {
        fitted = next;
        sizeRetries++;
        logHost(kind + ' size escalate → ' + next.size + '（' + next.reason + '）');
        continue;
      }
    }
    if (failure.retryable && retries < 2) {
      retries++;
      await sleep(600 * retries);
      continue;
    }
    throw new Error(imageErrorText(failure));
  }
  throw new Error(imageErrorText(lastFailure || { kind: 'unknown', message: '重试次数用尽' }));
}
/** 尺寸被抬大过，就尽量缩回用户要的尺寸。 */
function finalizeImage(result) {
  let bytes = result.bytes;
  let contentType = result.contentType;
  let fitted = result.fitted;
  const wanted = fitted && fitted.requested;
  if (fitted && fitted.adjusted && wanted && wanted.width && wanted.height && wanted.text !== fitted.size) {
    const resized = resizeTo(bytes, wanted.width, wanted.height);
    if (resized) {
      bytes = resized.bytes;
      contentType = resized.contentType;
      logHost('resize ' + fitted.size + ' → ' + wanted.text);
      fitted = Object.assign({}, fitted, { size: wanted.text, width: wanted.width, height: wanted.height, adjusted: false });
    } else {
      logHost('resize unavailable, keep ' + fitted.size + '（用户要 ' + wanted.text + '）');
    }
  }
  return { bytes: bytes, contentType: contentType, fitted: fitted };
}
async function saveImage(bytes, contentType, provider, model, size) {
  ensureDirs();
  const ext = safeExt(contentType);
  const filename = 'mo-' + Date.now() + '-' + randomUUID().slice(0, 8) + '.' + ext;
  const file = path.join(OUT_DIR, filename);
  await writeFile(file, bytes);
  return { file, filename, provider: provider.name || provider.id, model, size, bytes: bytes.length, contentType };
}
async function generate(args, exec) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：生图提示词由对话模型根据用户需求撰写');
  const config = await readConfig();
  const { provider, model } = pickProvider(config, args, 'generate');
  const adapter = resolveAdapter(provider, model);
  const defaults = (config && config.defaults) || {};
  const fitted = fitSize(adapter, resolveSizeArg(args, defaults));
  if (fitted.rejected) throw new Error(fitted.reason);
  logHost('generate adapter=' + describeAdapter(adapter) + ' model=' + model + ' size=' + sizeLabel(fitted) + (fitted.adjusted ? '（' + fitted.reason + '）' : ''));
  const signal = makeSignal(exec, 180000);
  const result = await callImageApi('generate', adapter, provider, {
    model: model, prompt: prompt, fitted: fitted, quality: resolveQuality(args, defaults), seed: args.seed
  }, signal);
  const final = finalizeImage(result);
  return saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted));
}
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
async function readReference(src, signal, index) {
  const raw = String(src || '').trim();
  if (!raw) throw new Error('第 ' + (index + 1) + ' 张参考图为空');
  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw, { signal });
    if (!response.ok) throw new Error('下载参考图失败（第 ' + (index + 1) + ' 张）：HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REF_BYTES) throw new Error('参考图超过 15MB：' + raw);
    return { buffer, contentType: response.headers.get('content-type') || 'image/png', filename: 'ref-' + (index + 1) + (/\.(png|jpe?g|webp|gif)$/i.exec(raw) || ['.png'])[0] };
  }
  const file = path.resolve(raw);
  if (!existsSync(file)) throw new Error('找不到参考图：' + raw);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('参考图不是文件：' + raw);
  if (info.size > MAX_REF_BYTES) throw new Error('参考图超过 15MB：' + raw);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('参考图只支持 png / jpg / jpeg / webp / gif：' + raw);
  return { buffer: await readFile(file), contentType: IMAGE_MIME[ext], filename: path.basename(file) };
}
async function edit(args, exec) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：图片编辑需要写清保留什么、只改什么。');
  const sources = Array.isArray(args.images) ? args.images.filter((item) => String(item || '').trim()) : [];
  if (!sources.length) throw new Error('图片编辑至少需要 1 张参考图。');
  if (sources.length > MAX_REF_COUNT) throw new Error('参考图最多 ' + MAX_REF_COUNT + ' 张，当前 ' + sources.length + ' 张。');
  const config = await readConfig();
  const defaults = (config && config.defaults) || {};
  const quality = resolveQuality(args, defaults);
  const { provider, model } = pickProvider(config, args, 'edit');
  const adapter = resolveAdapter(provider, model);
  const fitted = fitSize(adapter, resolveSizeArg(args, defaults));
  if (fitted.rejected) throw new Error(fitted.reason);
  const signal = makeSignal(exec, 360000);
  const images = [];
  for (let i = 0; i < sources.length; i++) images.push(await readReference(sources[i], signal, i));
  logHost('edit adapter=' + describeAdapter(adapter) + ' model=' + model + ' size=' + sizeLabel(fitted) + ' refs=' + images.length);
  const result = await callImageApi('edit', adapter, provider, {
    model: model, prompt: prompt, fitted: fitted, quality: quality, images: images
  }, signal);
  const final = finalizeImage(result);
  return saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted));
}


export const name = PLUGIN;
export const inject = ['webServer', 'tools'];

export function apply(ctx) {
  ensureDirs();
  logHost('apply');
  const publicOrigin = () => {
    try { if (ctx.webServer && typeof ctx.webServer.getOrigin === 'function') return String(ctx.webServer.getOrigin()).replace(/\/+$/, ''); } catch (_error) { /* ignore */ }
    try { const port = ctx.webServer && ctx.webServer.port; if (port) return 'http://127.0.0.1:' + port; } catch (_error) { /* ignore */ }
    return '';
  };

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/config',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: await readConfig() });
            if (req.method === 'POST') {
              const body = await readBody(req);
              return sendJson(res, 200, { ok: true, config: await writeConfig(body.config || body) });
            }
            return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        }
      });
    } catch (error) { logHost('config route error: ' + String(error)); return () => {}; }
  }, 'mo-image: config route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix', path: '/api/mo-image/preview',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
            const name = path.basename(decodeURIComponent(url.pathname.slice('/api/mo-image/preview/'.length)));
            if (!/^[a-zA-Z0-9._-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad filename' });
            const file = path.join(OUT_DIR, name);
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
            const info = await stat(file);
            if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
            const ext = path.extname(name).toLowerCase();
            const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'private, max-age=3600' });
            res.end(await readFile(file));
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        }
      });
    } catch (error) { logHost('preview route error: ' + String(error)); return () => {}; }
  }, 'mo-image: preview route');

  const renderImage = (_args, value) => [{
    type: 'text',
    text: '![生成图片](' + publicOrigin() + '/api/mo-image/preview/' + encodeURIComponent(path.basename(value.path)) + ')'
  }];
  const presentImage = (exec, result) => {
    try {
      const projections = ctx.get && ctx.get('sessionProjections');
      const boundary = projections && exec.agent ? projections.stateOf(exec.agent.session, 'turnBoundary') : undefined;
      if (boundary && boundary.lastTurn !== undefined) {
        exec.agent.session.append('deliverables/presented', {
          turn: boundary.lastTurn, callId: exec.callId,
          files: [{ path: result.file, description: 'AI 生成图片' }]
        });
      }
    } catch (error) { logHost('present error: ' + String(error && error.message ? error.message : error)); }
  };
  const output = {
    schema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string' },
        image: {
          type: 'object', additionalProperties: false,
          required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
            bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' },
            name: { type: 'string' }
          }
        }
      }
    },
    render: renderImage
  };

  try {
    ctx.tools.register({
      name: 'mo_image_generate',
      description: 'Generate a new image with the user-configured image model. Use when the user asks to create, draw or redo an image from scratch. Write the final prompt yourself. The tool returns a Markdown image line and a file card; copy the Markdown line into the final reply.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'Final detailed image prompt.' },
          size: { type: 'string', description: 'Optional. Omit to use the picker setting (auto by default, letting the model choose). Explicit values win.' },
          provider: { type: 'string' }, model: { type: 'string' }
        }
      },
      output, timeoutMs: 180000,
      async execute(args, exec) {
        const result = await generate(args, exec);
        presentImage(exec, result);
        return { path: result.file };
      }
    });
  } catch (error) { logHost('generate tool register error: ' + String(error)); }

  try {
    ctx.tools.register({
      name: 'mo_image_edit',
      description: 'Edit or refine an existing image with one or more reference images. Use for detail adjustments that must preserve the current image, reference-based generation, multi-image fusion, or adding the previous version as a reference. Images are sent in order and correspond to 图1/图2 in the prompt. For a full redo that must not copy the current image, use mo_image_generate instead.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['prompt', 'images'],
        properties: {
          prompt: { type: 'string', description: 'Final edit prompt; state what to change and that everything else must stay unchanged.' },
          images: { type: 'array', items: { type: 'string' }, description: '1–16 absolute local paths or http(s) URLs; order matters.' },
          size: { type: 'string' },
          quality: { type: 'string', enum: ['off', 'low', 'high', 'max'], description: 'off omits the parameter and lets the model decide.' },
          provider: { type: 'string' }, model: { type: 'string' }
        }
      },
      output, timeoutMs: 360000,
      async execute(args, exec) {
        const result = await edit(args, exec);
        presentImage(exec, result);
        return { path: result.file };
      }
    });
  } catch (error) { logHost('edit tool register error: ' + String(error)); }
}
