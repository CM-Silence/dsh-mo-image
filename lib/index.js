import { mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

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
function emptyConfig() { return { version: 1, providers: [], active: { providerId: '', model: '' } }; }
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
      protocol: String(item.protocol || 'openai-images'), models, names
    });
  }
  const wanted = raw.active && typeof raw.active === 'object' ? raw.active : {};
  const provider = out.providers.find((p) => p.id === wanted.providerId);
  out.active = { providerId: provider ? provider.id : '', model: provider && provider.models.includes(wanted.model) ? wanted.model : '' };
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
  if (String(provider.protocol || 'openai-images') !== 'openai-images') throw new Error('暂不支持该生图协议：' + provider.protocol);
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
async function bytesFromPayload(payload, signal) {
  const first = payload && payload.data && payload.data[0];
  if (!first) throw new Error('生图接口没有返回图片');
  if (first.b64_json) return { bytes: Buffer.from(first.b64_json, 'base64'), contentType: 'image/png' };
  if (first.url) {
    const response = await fetch(first.url, { signal });
    if (!response.ok) throw new Error('下载生成图失败：HTTP ' + response.status);
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'image/png' };
  }
  throw new Error('生图接口返回格式不认识');
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
  const size = String(args.size || '1024x1024').replace(/[×*]/g, 'x').replace(/\s+/g, '');
  const signal = makeSignal(exec, 180000);
  const response = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
    body: JSON.stringify({ model, prompt, n: 1, size }),
    signal
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_error) { payload = null; }
  if (!response.ok) throw new Error('生图接口 ' + response.status + ': ' + text.slice(0, 400));
  const { bytes, contentType } = await bytesFromPayload(payload, signal);
  return saveImage(bytes, contentType, provider, model, size);
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
function buildEditForm(provider, model, prompt, size, quality, images, fieldName) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('n', '1');
  for (const image of images) form.append(fieldName, new Blob([image.buffer], { type: image.contentType }), image.filename);
  return form;
}
async function requestEdit(provider, model, prompt, size, quality, images, fieldName, signal) {
  const response = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/images/edits', {
    method: 'POST', headers: { Authorization: 'Bearer ' + provider.key },
    body: buildEditForm(provider, model, prompt, size, quality, images, fieldName), signal
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_error) { payload = null; }
  return { response, text, payload };
}
async function edit(args, exec) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：图片编辑需要写清保留什么、只改什么。');
  const sources = Array.isArray(args.images) ? args.images.filter((item) => String(item || '').trim()) : [];
  if (!sources.length) throw new Error('图片编辑至少需要 1 张参考图。');
  if (sources.length > MAX_REF_COUNT) throw new Error('参考图最多 ' + MAX_REF_COUNT + ' 张，当前 ' + sources.length + ' 张。');
  const quality = String(args.quality || 'medium').toLowerCase();
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) throw new Error('quality 只支持 low / medium / high / xhigh / max，不要传 auto。');
  const config = await readConfig();
  const { provider, model } = pickProvider(config, args, 'edit');
  const size = String(args.size || '1024x1024').replace(/[×*]/g, 'x').replace(/\s+/g, '');
  const signal = makeSignal(exec, 360000);
  const images = [];
  for (let i = 0; i < sources.length; i++) images.push(await readReference(sources[i], signal, i));
  let result = await requestEdit(provider, model, prompt, size, quality, images, 'image[]', signal);
  if (!result.response.ok && result.response.status === 400 && /image/i.test(result.text)) {
    result = await requestEdit(provider, model, prompt, size, quality, images, 'image', signal);
  }
  if (!result.response.ok) throw new Error('图片编辑接口 ' + result.response.status + ': ' + result.text.slice(0, 500));
  const { bytes, contentType } = await bytesFromPayload(result.payload, signal);
  return saveImage(bytes, contentType, provider, model, size);
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
          size: { type: 'string', description: 'Image size such as 1024x1024.' },
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
          quality: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
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
