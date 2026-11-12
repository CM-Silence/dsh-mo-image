import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  resolveAdapter, describeAdapter, fitSize, escalateSize,
  qualityForAdapter, qualityOptionsFor, filterImageModels,
  prepareGenerate, prepareEdit, prepareAsync, pollUrlFor, pollHeaders,
  readTaskId, readTaskState, decodeImagePayload, classifyFailure,
  fetchImageUrl, resizeTo, adapterBase, readResponseBytes, looksLikeImage, sniffType,
  listProviderModelEntries, adapterManifest, localPresetManifest, providerPresetManifest, MAX_IMAGE_BYTES,
  adapterSupportsKind, analyzeComfyWorkflow
} from './adapters.js';
import { promptSectionText, resolvePromptProfile, settingsPayload } from './prompt-profiles.js';
import { request, setNetworkLogger } from './net.js';
import { configWriteReason } from './config-guard.js';
import { localizedError, errorBody } from './localized-error.js';
import { createUpdateService } from './update-service.js';
import { MAPPING_KEYS } from './comfy-workflow.js';

const PLUGIN = 'dsh-mo-image';
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function stateDir() {
  return path.join(dshHome(), 'mo-image');
}
function configFile() {
  return path.join(stateDir(), 'config.json');
}
function outputDir() {
  return path.join(stateDir(), 'out');
}
function hostLogFile() {
  return path.join(stateDir(), 'host.log');
}
/** 插件自己的版本号，用来和 GitHub 上的 Release 比。 */
function pluginVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0');
  } catch (_error) {
    return '0.0.0';
  }
}
const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REF_TOTAL = 48 * 1024 * 1024;
const MAX_JSON_EDIT_TOTAL = 10 * 1024 * 1024;
const MAX_REF_COUNT = 16;
const MAX_REF_CONCURRENCY = 3;
const ALLOW_PRIVATE_REFS = String(process.env.MO_IMAGE_ALLOW_PRIVATE_REFS || '').trim() === '1';

function ensureDirs() { mkdirSync(outputDir(), { recursive: true }); }
function logHost(message) {
  try { appendFileSync(hostLogFile(), new Date().toISOString() + ' ' + message + '\n'); } catch (_error) { /* diagnostics */ }
}
function sessionCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : '';
  } catch (_error) { return ''; }
}
/** 新图优先写进当前项目目录；没有 session cwd 时退回 DSH 状态目录。 */
function generatedImageDir(exec) {
  const cwd = sessionCwd(exec);
  return cwd ? path.join(cwd, 'generated-images') : outputDir();
}
let previewKeyCache = null;
/** 预览 URL 用 HMAC 签名，图片本体留在项目目录，宿主只保存一把很小的 key。 */
function previewKey() {
  const file = path.join(stateDir(), 'preview.key');
  if (previewKeyCache && previewKeyCache.file === file) return previewKeyCache.key;
  ensureDirs();
  let key = null;
  try { key = readFileSync(file); } catch (_error) { key = null; }
  if (!key || key.length !== 32) {
    key = randomBytes(32);
    try {
      writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      key = readFileSync(file);
    }
    if (!key || key.length !== 32) throw new Error('preview key is invalid');
  }
  previewKeyCache = { file: file, key: key };
  return key;
}
function signPreview(file) {
  const payload = Buffer.from(JSON.stringify({ p: file }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', previewKey()).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function resolvePreviewToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return '';
  const payload = parts[0];
  try {
    const expected = createHmac('sha256', previewKey()).update(payload).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return '';
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value && typeof value.p === 'string' && path.isAbsolute(value.p) ? value.p : '';
  } catch (_error) { return ''; }
}
function emptyConfig() {
  return {
    version: 1, providers: [], active: { providerId: '', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  };
}
/** 质量值由适配器的 options 决定；这里只保留旧配置里的合法字符串，具体对齐交给 adapter。 */
const QUALITY_VALUES = new Set(['off', 'low', 'medium', 'high', 'max', 'auto', 'standard', 'hd', 'default', 'quality', 'turbo']);
function normalizeQuality(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'xhigh') return 'max';
  return QUALITY_VALUES.has(raw) ? raw : 'high';
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
    height: height || 1024,
    promptOptimization: source.promptOptimization === undefined ? true : !!source.promptOptimization
  };
}
/** 质量、尺寸都只取选择器默认值；工具不再接受模型传入的参数。 */
function resolveQuality(defaults) {
  return normalizeQuality(defaults && defaults.quality);
}
function resolveSizeArg(defaults) {
  if (defaults && defaults.auto === false) return (defaults.width || 1024) + 'x' + (defaults.height || 1024);
  return 'none';
}
/** 每个模型的可选配置（目前只有自定义工作流），只保留仍存在的模型，限制体积。 */
const MODEL_WORKFLOW_MAX = 2000000;
/**
 * 映射要么完整，要么没有：任何一项形状不对就整体丢弃，
 * 免得生成时一半注入一半不注入，产出用户看不懂的图。
 */
function sanitizeMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const key of MAPPING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === null) { out[key] = null; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const node = typeof value.node === 'string' ? value.node.trim() : '';
    const input = typeof value.input === 'string' ? value.input.trim() : '';
    if (!node || !input) return undefined;
    out[key] = { node, input };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 可调参数清单来自解析结果，形状固定：name/node/input/type/default[/options]。
 * 任何一项不合法就整体丢弃——宁可不让模型看到，也不要报一个假的默认值。
 */
function sanitizeParams(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const node = typeof item.node === 'string' ? item.node.trim() : '';
    const input = typeof item.input === 'string' ? item.input.trim() : '';
    if (!name || !node || !input) return undefined;
    const param = { name, node, input, type: String(item.type || 'string') };
    if (item.default !== undefined) param.default = item.default;
    if (Array.isArray(item.options)) param.options = item.options.map(String).slice(0, 64);
    if (item.expose === false) param.expose = false;
    out.push(param);
  }
  return out.length ? out : undefined;
}

export function normalizeModelOptions(raw, models) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set(Array.isArray(models) ? models : []);
  for (const model of Object.keys(raw)) {
    if (!allowed.has(model)) continue;
    const entry = raw[model];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const workflow = typeof entry.workflow === 'string' ? entry.workflow.trim() : '';
    if (!workflow || workflow.length > MODEL_WORKFLOW_MAX) continue;
    const mapping = sanitizeMapping(entry.mapping);
    const params = sanitizeParams(entry.params);
    const next = { workflow };
    if (mapping) next.mapping = mapping;
    if (params) next.params = params;
    out[model] = next;
  }
  return out;
}

export function normalizeConfig(raw) {
  const out = emptyConfig();
  if (!raw || typeof raw !== 'object') return out;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  for (const item of providers) {
    if (!item || typeof item !== 'object') continue;
    const models = Array.from(new Set((Array.isArray(item.models) ? item.models : [])
      .map((m) => String(m || '').trim()).filter(Boolean)));
    const names = {};
    if (item.names && typeof item.names === 'object') for (const model of models) if (typeof item.names[model] === 'string') names[model] = item.names[model];
    const modelOptions = normalizeModelOptions(item.modelOptions, models);
    const key = String(item.key || '');
    const provider = {
      id: String(item.id || randomUUID()), name: String(item.name || ''),
      baseUrl: String(item.baseUrl || '').replace(/\/+$/, ''),
      apiKeyEnv: validKeyRef(item.apiKeyEnv),
      optionalKey: !!item.optionalKey,
      protocol: String(item.protocol || 'openai-images'), adapter: String(item.adapter || ''), models, names
    };
    // 自定义工作流只有 ComfyUI 适配器会读；别的提供商留着也没用，直接丢弃。
    if (provider.adapter === 'comfyui' && Object.keys(modelOptions).length > 0) provider.modelOptions = modelOptions;
    if (key) provider.key = key;
    out.providers.push(provider);
  }
  const wanted = raw.active && typeof raw.active === 'object' ? raw.active : {};
  const provider = out.providers.find((p) => p.id === wanted.providerId);
  // "auto" 是选择器里的特殊行：允许对话模型在提供商列表内自选模型。
  const wantedModel = String(wanted.model || '').trim();
  const keepModel = wantedModel === 'auto' || (provider && provider.models.includes(wantedModel));
  out.active = { providerId: provider ? provider.id : '', model: keepModel ? wantedModel : '' };
  out.defaults = normalizeDefaults(raw.defaults);
  return out;
}
/** DSH 凭据库（ctx.credentials）里的引用名；只允许我们自己的 MO_IMAGE_ 命名空间。 */
const KEY_REF_PREFIX = 'MO_IMAGE_';
const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function createConfigStore(options) {
  return {
    configFile: options.configFile,
    ensureDirs: options.ensureDirs,
    logHost: options.logHost,
    credentialsAccessor: options.credentialsAccessor,
    cache: null,
    stamp: '',
    webOriginHost: '',
    keyMigration: null,
    writeQueue: Promise.resolve()
  };
}
function credentialsService(store) {
  if (!store || typeof store.credentialsAccessor !== 'function') return undefined;
  try { return store.credentialsAccessor(); } catch (_error) { return undefined; }
}
function validKeyRef(value) {
  const ref = String(value || '').trim();
  return KEY_REF_PATTERN.test(ref) && ref.startsWith(KEY_REF_PREFIX) ? ref : '';
}
/** 按 provider id 生成稳定的环境变量名，例如 MO_IMAGE_P_ABC_API_KEY。 */
function deriveKeyRef(id, used) {
  const stem = String(id || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROVIDER';
  const base = KEY_REF_PREFIX + stem + '_API_KEY';
  let ref = base;
  for (let n = 2; used && used.has(ref); n++) ref = base.replace(/_API_KEY$/, '_' + n + '_API_KEY');
  return ref;
}
function hasLegacyKeys(config) {
  return (config.providers || []).some((provider) => provider.key || !validKeyRef(provider.apiKeyEnv));
}
/** describe() 的 configured 也可能来自环境变量；只有不是 env fallback 才算已存进凭据库。 */
function credentialIsStored(info) {
  if (!info || !info.configured) return false;
  const source = String(info.source || '');
  return source !== 'env' && source !== 'project-env' && source !== 'user-env';
}

function requestHostName(req) {
  const raw = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  if (!raw) return '';
  const withoutPort = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return withoutPort;
}
/**
 * 配置写接口是本插件自己的本地 HTTP 路由，不走 DSH 的 remote 权限层，所以
 * 至少挡掉跨站浏览器请求和 DNS rebinding：Host 必须是回环、IP 字面量或
 * DSH_WEB_URL 公布的域名；Origin 必须同源；POST 必须是 application/json。
 * 同一 OS 用户的进程本来就能读凭据文件，这里不是对抗同 UID 进程的边界。
 */
function assertLocalRequest(store, req, write) {
  const hostName = requestHostName(req);
  if (!hostName) {
    const error = new Error('missing Host header'); error.status = 403; throw error;
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  for (const value of [process.env.DSH_WEB_URL, store && store.webOriginHost]) {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.hostname) allowed.add(parsed.hostname.toLowerCase());
    } catch (_error) { /* ignore */ }
  }
  if (!allowed.has(hostName) && isIP(hostName) === 0) {
    const error = new Error('unexpected Host header'); error.status = 403; throw error;
  }
  const origin = req.headers && req.headers.origin;
  if (origin !== undefined) {
    let originUrl;
    try { originUrl = new URL(String(origin)); } catch (_error) {
      const error = new Error('invalid Origin'); error.status = 403; throw error;
    }
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (originUrl.host.toLowerCase() !== hostHeader) {
      const error = new Error('cross-origin request rejected'); error.status = 403; throw error;
    }
  }
  const site = req.headers && req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    const error = new Error('cross-site request rejected'); error.status = 403; throw error;
  }
  if (write) {
    const type = String((req.headers && req.headers['content-type']) || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      const error = new Error('content-type must be application/json'); error.status = 415; throw error;
    }
  }
}
/** 系统提示词节是同步渲染的，这里用 mtime 缓存一份配置副本。 */
function rememberConfig(store, config) {
  store.cache = config;
  store.stamp = '';
}
function readConfigSync(store) {
  try {
    const info = statSync(store.configFile);
    const stamp = info.mtimeMs + ':' + info.size;
    if (!store.cache || stamp !== store.stamp) {
      store.cache = normalizeConfig(JSON.parse(readFileSync(store.configFile, 'utf8')));
      store.stamp = stamp;
    }
  } catch (_error) {
    if (!store.cache) store.cache = emptyConfig();
  }
  return store.cache;
}
/** 当前选中的生图模型；编辑也用同一个（严格模式，不做任何回退）。 */
function activeImageState(store) {
  const config = readConfigSync(store);
  const provider = (config.providers || []).find((item) => item.id === config.active.providerId);
  const model = String((config.active && config.active.model) || '').trim();
  if (!provider || !model) return null;
  let adapter = null;
  try { adapter = resolveAdapter(provider, model); } catch (_error) { adapter = null; }
  return {
    provider, model, adapter, models: provider.models || [],
    editModel: model, editAdapter: adapter,
    // 只有 ComfyUI 部署才有工作流参数；用户关掉暴露时不返回。
    workflowParams: workflowParamsOf(provider, model, adapter),
    promptOptimization: config.defaults.promptOptimization !== false, defaults: config.defaults
  };
}

/** 当前模型的工作流可调参数；非 ComfyUI 或用户逐项关闭时不返回。 */
function workflowParamsOf(provider, model, adapter) {
  try {
    if (!adapter || adapter.id !== 'comfyui') return undefined;
    const entry = provider && provider.modelOptions ? provider.modelOptions[model] : null;
    if (!entry || !Array.isArray(entry.params)) return undefined;
    const exposed = entry.params.filter((param) => param && param.expose !== false);
    return exposed.length ? exposed : undefined;
  } catch (_error) { return undefined; }
}
function canUseCredentials(store) {
  const credentials = credentialsService(store);
  return !!(credentials && typeof credentials.describe === 'function' && typeof credentials.resolve === 'function' && typeof credentials.set === 'function');
}
/** 浏览器只拿 hasKey/keySource，永远拿不到明文密钥。 */
async function publicConfig(store, config) {
  const credentials = credentialsService(store);
  const providers = await Promise.all((config.providers || []).map(async (provider) => {
    const copy = Object.assign({}, provider);
    delete copy.key;
    const ref = validKeyRef(provider.apiKeyEnv);
    let hasKey = false;
    let keySource = '';
    if (ref && credentials && typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(ref);
        hasKey = !!info.configured;
        keySource = info.source || '';
      } catch (error) { store.logHost('credential describe failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
    if (!hasKey && ref && process.env[ref]) { hasKey = true; keySource = 'env'; }
    if (!hasKey && provider.key) { hasKey = true; keySource = 'config'; }
    return Object.assign(copy, { hasKey: hasKey, keySource: keySource });
  }));
  return Object.assign({}, config, { providers: providers });
}
/** 选择器用的模型能力表：目前先下发每个模型可用的质量档位。 */
function capabilityManifest(config) {
  return (config.providers || []).map((provider) => ({
    providerId: provider.id,
    models: (provider.models || []).map((model) => {
      let quality = null;
      try { quality = qualityOptionsFor(resolveAdapter(provider, model), model); } catch (_error) { quality = null; }
      return { model: model, quality: quality };
    })
  }));
}
/**
 * 把旧版 config.json 里的明文 key 迁到 DSH 凭据库，并在配置里只留下 apiKeyEnv 引用。
 * 凭据服务不存在（自定义 composition）时保持旧字段，避免把用户锁死。
 */
async function migrateConfigKeys(store, input) {
  if (!canUseCredentials(store)) return input;
  const credentials = credentialsService(store);
  const config = normalizeConfig(input);
  const used = new Set();
  let migrated = 0;
  let changed = false;
  for (const provider of config.providers) {
    let ref = validKeyRef(provider.apiKeyEnv);
    if (!ref) {
      ref = deriveKeyRef(provider.id, used);
      provider.apiKeyEnv = ref;
      changed = true;
    } else if (used.has(ref)) {
      ref = deriveKeyRef(provider.id, used);
      provider.apiKeyEnv = ref;
      changed = true;
    }
    used.add(ref);
    if (!provider.key) continue;
    try {
      const info = await credentials.describe(ref);
      if (!credentialIsStored(info)) {
        await credentials.set(ref, provider.key);
        migrated++;
      }
      delete provider.key;
      changed = true;
    } catch (error) {
      store.logHost('credential migration failed for provider ' + provider.id + ': ' + String(error && error.message ? error.message : error));
    }
  }
  if (!changed) return config;
  const saved = await writeConfig(store, config);
  if (migrated > 0) store.logHost('migrated ' + migrated + ' API key(s) to credentials store');
  return saved;
}
function migrateKeysOnce(store, config) {
  if (!store.keyMigration) store.keyMigration = migrateConfigKeys(store, config).finally(() => { store.keyMigration = null; });
  return store.keyMigration;
}
async function readConfig(store) {
  try {
    if (!existsSync(store.configFile)) {
      const empty = emptyConfig();
      rememberConfig(store, empty);
      return empty;
    }
    let config = normalizeConfig(JSON.parse(await readFile(store.configFile, 'utf8')));
    if (hasLegacyKeys(config) && canUseCredentials(store)) {
      try { config = await migrateKeysOnce(store, config); } catch (error) { store.logHost('config key migration failed: ' + String(error && error.message ? error.message : error)); }
    }
    rememberConfig(store, config);
    return config;
  } catch (_error) { return emptyConfig(); }
}
async function writeConfig(store, config) {
  const next = normalizeConfig(config);
  const task = store.writeQueue.then(async () => {
    store.ensureDirs();
    const tempFile = store.configFile + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8);
    try {
      await writeFile(tempFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tempFile, store.configFile);
    } finally {
      try { await unlink(tempFile); } catch (_error) { /* rename 成功后临时文件已不存在 */ }
    }
    rememberConfig(store, next);
    return next;
  });
  store.writeQueue = task.catch(() => {});
  return task;
}
/** 每次请求才解析一次密钥；不在内存里长期缓存，轮换后下一请求生效。 */
async function resolveProviderCredential(store, provider) {
  const ref = validKeyRef(provider.apiKeyEnv);
  const credentials = credentialsService(store);
  if (ref) {
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref);
        if (hit && typeof hit.value === 'string' && hit.value.trim().length > 0) {
          return Object.assign({}, provider, { key: hit.value.trim() });
        }
      } catch (error) { store.logHost('credential resolve failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
    const env = process.env[ref];
    if (env && env.trim()) return Object.assign({}, provider, { key: env.trim() });
  }
  if (provider.key) return provider;
  if (provider.optionalKey) return provider;
  throw localizedError(
    new Error('生图提供商「' + (provider.name || provider.id) + '」缺少 API Key，请到 DSH 设置 → 生图模型填写'
      + (ref ? '（凭据 ' + ref + '）' : '') + '。'),
    ref ? 'provider.missingKeyWithRef' : 'provider.missingKey',
    { provider: provider.name || provider.id, ref: ref }
  );
}
/** 保存配置前先把每个 provider 的新 key 写进凭据库，配置文件只保留 apiKeyEnv。 */
async function saveConfigWithCredentials(store, raw) {
  const incoming = normalizeConfig(raw);
  const current = await readConfig(store);
  const credentials = credentialsService(store);
  const canStore = !!(credentials && typeof credentials.set === 'function');
  const canDescribe = !!(credentials && typeof credentials.describe === 'function');
  const currentById = new Map(current.providers.map((provider) => [provider.id, provider]));
  const used = new Set();
  const providers = [];
  for (const provider of incoming.providers) {
    const old = currentById.get(provider.id);
    let ref = validKeyRef(provider.apiKeyEnv) || validKeyRef(old && old.apiKeyEnv) || deriveKeyRef(provider.id, used);
    if (used.has(ref)) ref = deriveKeyRef(provider.id, used);
    used.add(ref);
    provider.apiKeyEnv = ref;
    const newKey = String(provider.key || '').trim();
    delete provider.key;
    if (newKey) {
      if (!canStore) throw localizedError(new Error('DSH 凭据服务未挂载，无法安全保存 API Key；请确认 base composition 包含 dsh-credentials-local。'), 'config.credentialsUnavailable');
      try {
        await credentials.set(ref, newKey);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        throw localizedError(new Error('保存 API Key 失败：' + message), 'config.credentialSaveFailed', { message: message });
      }
    } else if (old && old.key) {
      if (canStore && canDescribe) {
        try {
          const info = await credentials.describe(ref);
          if (!credentialIsStored(info)) await credentials.set(ref, old.key);
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          throw localizedError(new Error('旧 API Key 迁移失败：' + message), 'config.legacyKeyMigrationFailed', { message: message });
        }
      } else {
        provider.key = old.key;
      }
    }
    providers.push(provider);
  }
  if (credentials && typeof credentials.unset === 'function') {
    const kept = new Set(providers.map((provider) => provider.id));
    for (const old of current.providers) {
      if (kept.has(old.id)) continue;
      const ref = validKeyRef(old.apiKeyEnv);
      if (!ref || used.has(ref)) continue;
      try { await credentials.unset(ref); } catch (error) { store.logHost('credential removal failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
  }
  incoming.providers = providers;
  try {
    return await writeConfig(store, incoming);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    throw localizedError(new Error('保存生图配置失败：' + message), 'config.writeFailed', { message: message });
  }
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
    if (total > MAX_BODY) throw localizedError(new Error('request body is too large'), 'request.bodyTooLarge');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw localizedError(error, 'request.invalidJson');
  }
}
function pickProvider(config, purpose, args) {
  const providers = config.providers || [];
  if (!providers.length) throw new Error('还没有配置生图模型。请先到 DSH 设置 → 生图模型 添加提供商、模型和 API Key。');
  // 提供商和模型只认用户在选择器里选中的那一组：工具参数里传什么都不认，
  // 避免对话模型在失败后绕过用户去别的提供商/模型上重试。
  const active = config.active || {};
  if (!active.providerId) throw new Error('还没有选择当前生图模型。请先到 DSH 设置 → 生图模型 选择当前模型。');
  const provider = providers.find((p) => p.id === active.providerId) || null;
  if (!provider) throw new Error('当前选中的生图提供商不存在，请到设置 → 生图模型重新选择。');
  // 严格只用用户选中的模型：不做「编辑时自动换 sunburst」这类回退，
  // 模型不支持对应能力时由 callImageApi 明确报「不支持」，而不是偷偷换一个。
  // 唯一例外是用户把选择器设为 Auto：此时由工具传进来的 model 决定，且必须在本提供商列表内。
  const activeModel = String(active.model || '').trim();
  if (!activeModel) throw new Error('还没有选择当前生图模型。请先到 DSH 设置 → 生图模型 选择当前模型。');
  const requestedProvider = String((args && args.provider) || '').trim();
  const requestedModel = String((args && args.model) || '').trim();
  // 模型由用户在设置里选定，工具参数只是可选的一致性核对。不让模型复述环境状态：
  // 它会把对话历史里的旧 id 再抄一遍，用户中途切换模型后必定白失败一轮。
  // 传了不一致的值仍然拒绝，防止对话模型自己换提供商/模型。
  if (requestedProvider && requestedProvider !== provider.id && requestedProvider !== provider.name) {
    throw new Error('提供商由用户在设置里固定（当前：' + (provider.name || provider.id) + '），请求的是 ' + requestedProvider + '。要换提供商请让用户在设置里切换。');
  }
  let model;
  if (activeModel === 'auto') {
    if (!requestedModel) {
      throw new Error('Auto 模式下要由你选一个模型：' + ((provider.models || []).join(' / ') || '（列表为空，请让用户先在设置里添加模型）') + '，通过 model 传入。');
    }
    if (!(provider.models || []).includes(requestedModel)) {
      throw new Error('Auto 模式只能选当前提供商列表里的模型：' + requestedModel + '。可选：' + ((provider.models || []).join(' / ') || '（列表为空）'));
    }
    model = requestedModel;
  } else {
    if (requestedModel && requestedModel !== activeModel) {
      throw new Error('当前选中的模型是 ' + activeModel + '（提供商 ' + (provider.name || provider.id) + '），请求的是 ' + requestedModel + '。模型只能由用户在设置里切换。');
    }
    model = activeModel;
  }
  if (!(provider.models || []).includes(model)) {
    if (provider.models && provider.models.length) throw new Error('当前模型不在提供商的模型目录里，请到设置 → 生图模型补全。' + (purpose === 'edit' ? '图片编辑建议使用 gpt-image-2.5-sunburst 等编辑模型。' : ''));
    throw new Error('当前提供商还没有模型 ID，请到设置 → 生图模型添加并选择模型。');
  }
  // 协议/适配器解析交给 resolveAdapter()：不同模型族的请求形状由适配器描述符定义。
  // API Key 由 resolveProviderCredential() 在请求前从 DSH 凭据库解析，不在这里检查。
  if (!provider.baseUrl) throw new Error('生图提供商缺少 API 地址，请到设置 → 生图模型补全。');
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
  const suffix = '（模型与提供商只能由用户在选择器里切换）';
  if (failure.kind === 'size') return text + '（该模型对尺寸有最小/最大像素限制，换一个尺寸或换支持该尺寸的模型）' + suffix;
  if (failure.kind === 'auth') return text + '（检查 API Key 与地址是否正确）' + suffix;
  if (failure.kind === 'param') return text + '（请求参数与模型不兼容）' + suffix;
  return text + suffix;
}
/**
 * 上游说「这个模型不支持这类操作」时，翻译成统一说法，
 * 免得对话模型把「模型不支持」当成临时故障去换模型重试。
 */
function unsupportedModelMessage(kind, failure) {
  const text = String((failure && failure.message) || '');
  if (!/(model|模型)/i.test(text)) return '';
  if (!/(not support|does not support|unsupported|不支持|cannot|无法)/i.test(text)) return '';
  return '该模型不支持' + (kind === 'edit' ? '图生图' : '文生图') + '：' + text;
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
  let retries = 0;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const built = prepareAsync(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops);
    const response = await request(adapterBase(provider) + built.path, {
      method: 'POST', headers: built.headers, body: built.body, signal: signal
    });
    const buffer = await readResponseBytes(response, 2 * 1024 * 1024);
    if (response.ok) {
      submission = safeJson(buffer);
      break;
    }
    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' async submit ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));
    const capability = unsupportedModelMessage(kind, failure);
    if (capability) throw new Error(capability);

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
    if (failure.retryable && retries < 2) {
      retries++;
      logHost(kind + ' async submit retry #' + retries + ' in ' + (600 * retries) + 'ms');
      await sleep(600 * retries);
      continue;
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
    const response = await request(pollUrlFor(adapter, provider, taskId), {
      method: 'GET', headers: pollHeaders(provider), signal: signal
    });
    const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
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
  if (!adapterSupportsKind(adapter, kind)) {
    throw new Error('该模型不支持' + (kind === 'edit' ? '图生图' : '文生图')
      + '（' + String(input.model || adapter.label) + '）。请到设置 → 生图模型换一个支持它的模型。');
  }
  if (adapter.async) return callAsyncImage(kind, adapter, provider, input, signal);
  if (typeof adapter.execute === 'function') {
    const out = await adapter.execute(kind, provider, input, signal);
    return { fitted: input.fitted, bytes: out.bytes, contentType: out.contentType, note: out.note };
  }
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
    const response = await request(adapterBase(provider) + built.path, {
      method: 'POST', headers: built.headers, body: built.body, signal: signal
    });
    const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);

    if (response.ok) {
      const parsed = safeJson(buffer);
      const decoded = parsed ? decodeImagePayload(parsed, null) : decodeImagePayload(null, buffer);
      const image = decoded.bytes ? decoded : await fetchImageUrl(decoded.url, signal);
      return { fitted: fitted, bytes: image.bytes, contentType: image.contentType };
    }

    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' upstream ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));

    const capability = unsupportedModelMessage(kind, failure);
    if (capability) throw new Error(capability);

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
export function finalizeImage(result) {
  let bytes = result.bytes;
  let contentType = result.contentType;
  let fitted = result.fitted;
  let note = result && result.note ? String(result.note) : '';
  const wanted = fitted && fitted.requested;
  const wantedPixels = wanted ? wanted.width * wanted.height : 0;
  const fittedPixels = fitted ? (fitted.width || 0) * (fitted.height || 0) : 0;
  // 只有用户要的尺寸比模型实际生成的小才缩回去。用户要的更大时，
  // 上游已经按上限生成，不能再放大冒充用户尺寸（会损失画质）。
  if (fitted && fitted.adjusted && wanted && wanted.width && wanted.height
    && wanted.text !== fitted.size && fittedPixels > wantedPixels) {
    const resized = resizeTo(bytes, wanted.width, wanted.height);
    if (resized) {
      bytes = resized.bytes;
      contentType = resized.contentType;
      logHost('resize ' + fitted.size + ' → ' + wanted.text);
      fitted = Object.assign({}, fitted, { size: wanted.text, width: wanted.width, height: wanted.height, adjusted: false });
    } else {
      logHost('resize unavailable, keep ' + fitted.size + '（用户要 ' + wanted.text + '）');
    }
  } else if (fitted && fitted.adjusted && wanted && fittedPixels < wantedPixels) {
    const sizeNote = '该模型上限为 ' + fitted.size + '，已按上限生成（请求 ' + wanted.text + '，未放大）。';
    note = note ? note + '；' + sizeNote : sizeNote;
    logHost('keep model max ' + fitted.size + '（用户要 ' + wanted.text + '，不放大）');
  }
  return { bytes: bytes, contentType: contentType, fitted: fitted, note: note };
}
async function saveImage(bytes, contentType, provider, model, size, exec) {
  ensureDirs();
  const dir = generatedImageDir(exec);
  mkdirSync(dir, { recursive: true });
  const ext = safeExt(contentType);
  const filename = 'mo-' + Date.now() + '-' + randomUUID().slice(0, 8) + '.' + ext;
  const file = path.join(dir, filename);
  await writeFile(file, bytes);
  return { file, filename, provider: provider.name || provider.id, model, size, bytes: bytes.length, contentType };
}
/** 只保留有值的 params；别的形状一律当没传。 */
function readParamsArg(args) {
  const raw = args && args.params;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function generate(args, exec, store) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：先按当前模型的提示词公式写好完整提示词。');
  const negativePrompt = String(args.negative_prompt || '').trim();
  const config = await readConfig(store);
  const picked = pickProvider(config, 'generate', args);
  const model = picked.model;
  const provider = await resolveProviderCredential(store, picked.provider);
  const adapter = resolveAdapter(provider, model);
  const profile = resolvePromptProfile(model, adapter);
  const defaults = (config && config.defaults) || {};
  const quality = qualityForAdapter(adapter, resolveQuality(defaults));
  const fitted = fitSize(adapter, resolveSizeArg(defaults));
  if (fitted.rejected) throw new Error(fitted.reason);
  logHost('generate adapter=' + describeAdapter(adapter) + ' model=' + model + ' promptProfile=' + profile.id + ' quality=' + (quality || 'none') + ' size=' + sizeLabel(fitted) + (fitted.adjusted ? '（' + fitted.reason + '）' : ''));
  const signal = makeSignal(exec, 360000);
  const extraParams = readParamsArg(args);
  const unsupported = extraParams && adapter.id !== 'comfyui' ? Object.keys(extraParams) : [];
  const result = await callImageApi('generate', adapter, provider, {
    model: model, prompt: prompt, negativePrompt: negativePrompt || undefined,
    fitted: fitted, quality: quality, params: extraParams
  }, signal);
  const final = finalizeImage(result);
  const saved = await saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted), exec);
  const notes = [];
  if (final.note) notes.push(final.note);
  if (unsupported.length) notes.push('当前模型不支持工作流参数，已忽略：' + unsupported.join('、'));
  if (notes.length) saved.note = notes.join('；');
  return saved;
}
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}
function isPrivateAddress(address) {
  const ip = String(address || '').trim().toLowerCase();
  if (!ip) return true;
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  if (isIP(ip) !== 6) return true;
  if (ip === '::' || ip === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;          // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;          // fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(ip)) return true;             // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (ip.startsWith('::ffff:')) return true;               // 十六进制写法的 IPv4-mapped，保守拒绝
  return false;
}
async function assertReferenceUrl(raw) {
  if (ALLOW_PRIVATE_REFS) return;
  let parsed;
  try { parsed = new URL(raw); } catch (_error) { throw new Error('参考图 URL 无效：' + raw); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('参考图只支持 http/https URL：' + raw);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('参考图 URL 不能指向本机地址：' + raw + '（如确需使用，请设置 MO_IMAGE_ALLOW_PRIVATE_REFS=1）');
  }
  let addresses;
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);
    } catch (_error) {
      throw new Error('无法解析参考图域名：' + host);
    }
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error('参考图 URL 不能指向内网地址：' + host + '（如确需使用，请设置 MO_IMAGE_ALLOW_PRIVATE_REFS=1）');
  }
}
/** 手动跟重定向，每一跳都重新做内网检查。 */
async function fetchReferenceResponse(raw, signal) {
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    await assertReferenceUrl(current);
    const response = await request(current, { signal: signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
      if (!location) throw new Error('参考图重定向缺少 Location');
      current = new URL(location, current).href;
      continue;
    }
    return response;
  }
  throw new Error('参考图重定向次数过多');
}
async function readReference(src, signal, index) {
  const raw = String(src || '').trim();
  if (!raw) throw new Error('第 ' + (index + 1) + ' 张参考图为空');
  if (/^https?:\/\//i.test(raw)) {
    const response = await fetchReferenceResponse(raw, signal);
    if (!response.ok) throw new Error('下载参考图失败（第 ' + (index + 1) + ' 张）：HTTP ' + response.status);
    let buffer;
    try {
      buffer = await readResponseBytes(response, MAX_REF_BYTES);
    } catch (error) {
      throw new Error('下载参考图失败（第 ' + (index + 1) + ' 张）：' + String(error && error.message ? error.message : error));
    }
    if (!looksLikeImage(buffer)) throw new Error('参考图不是有效图片（第 ' + (index + 1) + ' 张）：' + raw);
    return { buffer, contentType: sniffType(buffer), filename: 'ref-' + (index + 1) + (/\.(png|jpe?g|webp|gif)$/i.exec(raw) || ['.png'])[0] };
  }
  const file = path.resolve(raw);
  if (!existsSync(file)) throw new Error('找不到参考图：' + raw);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('参考图不是文件：' + raw);
  if (info.size > MAX_REF_BYTES) throw new Error('参考图超过 15MB：' + raw);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('参考图只支持 png / jpg / jpeg / webp / gif：' + raw);
  const buffer = await readFile(file);
  if (!looksLikeImage(buffer)) throw new Error('参考图不是有效图片：' + raw);
  return { buffer, contentType: sniffType(buffer), filename: path.basename(file) };
}
export function referenceLimitFor(adapter) {
  return adapter && adapter.transport && adapter.transport.edit === 'multipart' ? MAX_REF_TOTAL : MAX_JSON_EDIT_TOTAL;
}

/** 有界并发读取参考图；结果按输入顺序返回。 */
export async function readReferences(sources, signal, totalLimit = MAX_REF_TOTAL, concurrency = MAX_REF_CONCURRENCY) {
  const list = Array.isArray(sources) ? sources : [];
  const images = new Array(list.length);
  let totalBytes = 0;
  let failure = null;
  let nextIndex = 0;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex++;
      if (index >= list.length) return;
      try {
        const image = await readReference(list[index], signal, index);
        if (failure) return;
        totalBytes += image.buffer.length;
        if (totalBytes > totalLimit) throw new Error('参考图总大小超过 ' + Math.round(totalLimit / 1024 / 1024) + 'MB，请减少图片数量或压缩后再试。');
        images[index] = image;
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency || 1, list.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure;
  return images;
}

async function edit(args, exec, store) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：图片编辑需要写清保留什么、只改什么。');
  const negativePrompt = String(args.negative_prompt || '').trim();
  const sources = Array.isArray(args.images) ? args.images.filter((item) => String(item || '').trim()) : [];
  if (!sources.length) throw new Error('图片编辑至少需要 1 张参考图。');
  if (sources.length > MAX_REF_COUNT) throw new Error('参考图最多 ' + MAX_REF_COUNT + ' 张，当前 ' + sources.length + ' 张。');
  const config = await readConfig(store);
  const defaults = (config && config.defaults) || {};
  const picked = pickProvider(config, 'edit', args);
  const model = picked.model;
  const provider = await resolveProviderCredential(store, picked.provider);
  const adapter = resolveAdapter(provider, model);
  const profile = resolvePromptProfile(model, adapter);
  const quality = qualityForAdapter(adapter, resolveQuality(defaults));
  const fitted = fitSize(adapter, resolveSizeArg(defaults));
  if (fitted.rejected) throw new Error(fitted.reason);
  const signal = makeSignal(exec, 360000);
  const totalLimit = referenceLimitFor(adapter);
  const images = await readReferences(sources, signal, totalLimit);
  logHost('edit adapter=' + describeAdapter(adapter) + ' model=' + model + ' promptProfile=' + profile.id + ' quality=' + (quality || 'none') + ' size=' + sizeLabel(fitted) + ' refs=' + images.length);
  const extraParams = readParamsArg(args);
  const unsupported = extraParams && adapter.id !== 'comfyui' ? Object.keys(extraParams) : [];
  const result = await callImageApi('edit', adapter, provider, {
    model: model, prompt: prompt, negativePrompt: negativePrompt || undefined,
    fitted: fitted, quality: quality, images: images, params: extraParams
  }, signal);
  const final = finalizeImage(result);
  const saved = await saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted), exec);
  const notes = [];
  if (final.note) notes.push(final.note);
  if (unsupported.length) notes.push('当前模型不支持工作流参数，已忽略：' + unsupported.join('、'));
  if (notes.length) saved.note = notes.join('；');
  return saved;
}


const SKILL_FILES = [
  {
    name: 'mo-image-generation',
    file: fileURLToPath(new URL('../skills/mo-image-generation/SKILL.md', import.meta.url)),
    description: '生成或重做图片时加载，包含按模型区分的提示词公式、模板和自检清单。'
  },
  {
    name: 'mo-image-editing',
    file: fileURLToPath(new URL('../skills/mo-image-editing/SKILL.md', import.meta.url)),
    description: '局部修改、参考图融合和版本迭代时加载，包含编辑公式、约束词和按模型写法。'
  }
];

/** 只解析 SKILL.md 顶部那几个简单字段，不引入 YAML 依赖。 */
function parseSkillMarkdown(raw) {
  const text = String(raw || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const hit = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!hit) continue;
    let value = hit[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[hit[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** 把当前模型对应的提示词方言注入系统提示词；模型切换后下一次组装自动更新。 */
function installPromptRecipe(ctx, store) {
  const register = (target) => {
    if (!target.systemPrompt || typeof target.systemPrompt.section !== 'function') return;
    target.effect(() => target.systemPrompt.section({
      name: 'mo-image:prompt-recipe',
      order: 2950,
      text: () => {
        try {
          const state = activeImageState(store);
          return state ? promptSectionText(state) : '';
        } catch (error) {
          logHost('prompt recipe error: ' + String(error && error.message ? error.message : error));
          return '';
        }
      }
    }), 'mo-image: prompt recipe');
    logHost('prompt recipe registered (mo-image:prompt-recipe)');
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], register);
    else register(ctx);
  } catch (error) { logHost('prompt recipe install error: ' + String(error && error.message ? error.message : error)); }
}

/** 把插件自带的两个 SKILL.md 注册成运行时技能，模型可按需加载。 */
function installBundledSkills(ctx) {
  const register = (target) => {
    if (!target.skills || typeof target.skills.register !== 'function') return;
    for (const item of SKILL_FILES) {
      try {
        const parsed = parseSkillMarkdown(readFileSync(item.file, 'utf8'));
        target.effect(() => target.skills.register({
          name: parsed.meta.name || item.name,
          description: parsed.meta.description || item.description,
          whenToUse: parsed.meta.whenToUse,
          source: 'runtime',
          content: parsed.body,
          resourceBase: { kind: 'directory', path: path.dirname(item.file) }
        }), 'mo-image: skill ' + item.name);
        logHost('skill registered: ' + item.name);
      } catch (error) { logHost('skill register error ' + item.name + ': ' + String(error && error.message ? error.message : error)); }
    }
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['skills'], register);
    else register(ctx);
  } catch (error) { logHost('skill install error: ' + String(error && error.message ? error.message : error)); }
}

export const name = PLUGIN;
export const inject = ['webServer', 'tools'];

async function modelsForRequest(store, body) {
  const providerId = String(body.providerId || '').trim();
  let provider;
  if (providerId) {
    const config = await readConfig(store);
    provider = (config.providers || []).find((item) => item.id === providerId);
    if (!provider) throw localizedError(new Error('找不到指定的生图提供商'), 'provider.notFound');
    provider = Object.assign({}, provider);
    if (body.baseUrl) provider.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
    if (body.adapter) provider.adapter = String(body.adapter).trim();
    if (body.protocol) provider.protocol = String(body.protocol).trim();
    if (body.optionalKey !== undefined) provider.optionalKey = !!body.optionalKey;
    const supplied = String(body.key || '').trim();
    if (supplied) {
      provider.key = supplied;
      delete provider.apiKeyEnv;
    }
  } else {
    const supplied = String(body.key || '').trim();
    provider = normalizeConfig({
      providers: [{
        id: 'model-list',
        baseUrl: String(body.baseUrl || '').trim(),
        adapter: String(body.adapter || '').trim(),
        protocol: String(body.protocol || 'openai-images').trim(),
        optionalKey: !!body.optionalKey,
        key: supplied
      }]
    }).providers[0];
  }
  if (!provider || !provider.baseUrl) throw localizedError(new Error('请先填写 API 地址'), 'provider.missingBaseUrl');
  try {
    provider = await resolveProviderCredential(store, provider);
  } catch (_error) {
    // 模型列表接口本身可能不需要鉴权；没 key 也让它试一次，真 401 会由上游报出来。
  }
  let adapter = resolveAdapter(provider, '');
  if ((!adapter || typeof adapter.listModels !== 'function') && !String(provider.adapter || '').trim()) {
    // 没有显式适配器的第三方/兼容网关，退回 OpenAI 兼容的 /models 探测。
    try { adapter = resolveAdapter(Object.assign({}, provider, { adapter: 'openai-images' }), ''); } catch (_error) { /* keep original */ }
  }
  if (!adapter || typeof adapter.listModels !== 'function') throw localizedError(new Error('该部署方式不支持获取模型列表'), 'models.unsupported');
  const entries = await listProviderModelEntries(adapter, provider, AbortSignal.timeout(20000));
  const seen = new Set();
  const allModels = [];
  const names = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String((entry && entry.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    allModels.push(id);
    const name = String((entry && entry.name) || '').trim();
    if (name && name !== id) names[id] = name;
    if (allModels.length >= 500) break;
  }
  const models = adapter.id === 'openai-images' ? filterImageModels(allModels) : allModels;
  return { models: models, allModels: allModels, filteredCount: allModels.length - models.length, names: names };
}

export function apply(ctx, options = {}) {
  ensureDirs();
  logHost('apply');
  setNetworkLogger(logHost);
  // 配置写入是权限问题，不是提示词问题：任何工具调用只要指向插件配置就拒绝。
  try {
    if (ctx.tools && typeof ctx.tools.guard === 'function') {
      ctx.effect(() => ctx.tools.guard((execution) => configWriteReason(execution && execution.arguments, execution && execution.name)), 'mo-image: config guard');
      logHost('config write guard installed');
    }
  } catch (error) { logHost('config guard install error: ' + String(error && error.message ? error.message : error)); }
  const store = createConfigStore({
    configFile: configFile(),
    ensureDirs: ensureDirs,
    logHost: logHost,
    credentialsAccessor: () => (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined)
  });
  try { store.webOriginHost = new URL(ctx.webServer.getOrigin()).hostname; } catch (_error) { store.webOriginHost = ''; }
  readConfigSync(store);
  if (canUseCredentials(store)) {
    readConfig(store).catch((error) => logHost('config key migration failed: ' + String(error && error.message ? error.message : error)));
  }
  installPromptRecipe(ctx, store);
  installBundledSkills(ctx);

  // 更新检查：宿主启动后预热一次，路由再按 12 小时的新鲜度补查。
  // pluginManager 只有桌面版有；没有它时检查照做，只是点"更新"会退化成命令行提示。
  const updateOptions = options.update && typeof options.update === 'object' ? options.update : {};
  const updateService = createUpdateService({
    currentVersion: pluginVersion(),
    markerFile: path.join(stateDir(), 'update.json'),
    request: typeof updateOptions.request === 'function' ? updateOptions.request : request,
    pluginManager: () => (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined),
    log: logHost,
    installDelayMs: Number.isFinite(updateOptions.installDelayMs) ? updateOptions.installDelayMs : 800,
    registryBase: updateOptions.registryBase,
    mirrorBase: updateOptions.mirrorBase,
    cdnSources: updateOptions.cdnSources
  });
  // 上次更新成没成，先看标记文件——这一步不能等网络，否则重启后的
  // 完成气泡要晚好几秒才可能被问到。
  Promise.resolve(updateService.hydrate())
    .catch((error) => logHost('update hydrate failed: ' + String(error && error.message ? error.message : error)));
  if (updateOptions.skipCheck !== true) {
    ctx.effect(() => {
      const delay = Number.isFinite(updateOptions.startupDelayMs) ? updateOptions.startupDelayMs : 5000;
      const timer = setTimeout(() => {
        Promise.resolve(updateService.refresh())
          .catch((error) => logHost('update warmup failed: ' + String(error && error.message ? error.message : error)));
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return () => {
        clearTimeout(timer);
        updateService.dispose();
      };
    }, 'mo-image: update check');
  }
  const publicOrigin = () => {
    // DSH_WEB_URL 是宿主对外公布的地址（远程/反代场景也能用）；getOrigin 只是
    // 本地监听地址，不能直接给远端浏览器用。
    try {
      const advertised = String(process.env.DSH_WEB_URL || '').trim();
      if (/^https?:\/\//i.test(advertised)) return advertised.replace(/\/+$/, '');
    } catch (_error) { /* ignore */ }
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
            assertLocalRequest(store, req, req.method === 'POST');
            if (req.method === 'GET') {
              const config = await readConfig(store);
              return sendJson(res, 200, { ok: true, config: await publicConfig(store, config), adapters: adapterManifest(), providerPresets: providerPresetManifest(), localPresets: localPresetManifest(), capabilities: capabilityManifest(config) });
            }
            if (req.method === 'POST') {
              const body = await readBody(req);
              const saved = await saveConfigWithCredentials(store, body.config || body);
              return sendJson(res, 200, { ok: true, config: await publicConfig(store, saved), adapters: adapterManifest(), providerPresets: providerPresetManifest(), localPresets: localPresetManifest(), capabilities: capabilityManifest(saved) });
            }
            return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 500, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('config route error: ' + String(error)); return () => {}; }
  }, 'mo-image: config route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/models',
        handler: async (req, res) => {
          try {
            assertLocalRequest(store, req, true);
            if (req.method !== 'POST') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const body = await readBody(req);
            const result = await modelsForRequest(store, body || {});
            return sendJson(res, 200, { ok: true, models: result.models, allModels: result.allModels, filteredCount: result.filteredCount, names: result.names || {} });
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 502, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('models route error: ' + String(error)); return () => {}; }
  }, 'mo-image: models route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/comfy/analyze',
        handler: async (req, res) => {
          try {
            assertLocalRequest(store, req, true);
            if (req.method !== 'POST') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const body = await readBody(req);
            const config = await readConfig(store);
            const providerId = String(body.providerId || '');
            const provider = (config.providers || []).find((item) => item && item.id === providerId) || null;
            const baseUrl = String(body.baseUrl || (provider && provider.baseUrl) || '').trim().replace(/\/+$/, '');
            if (!baseUrl) throw new Error('找不到这个提供商，或它没有填地址。');
            const workflow = String(body.workflow || '');
            if (!workflow.trim()) throw new Error('工作流是空的。');
            const merged = provider ? Object.assign({}, provider, { baseUrl }) : { baseUrl };
            const analysis = await analyzeComfyWorkflow({ base: baseUrl, provider: merged, workflow });
            return sendJson(res, 200, { ok: true, ...analysis });
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        }
      });
    } catch (error) { logHost('analyze route error: ' + String(error)); return () => {}; }
  }, 'mo-image: analyze route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix', path: '/api/mo-image/preview',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (req.method !== 'GET') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const raw = decodeURIComponent(url.pathname.slice('/api/mo-image/preview/'.length));
            let file = resolvePreviewToken(raw);
            if (!file) {
              // 兼容旧版 /preview/<basename>：旧图仍在 DSH 状态目录 out/ 下。
              const name = path.basename(raw);
              if (!/^[a-zA-Z0-9._-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad filename' });
              file = path.join(outputDir(), name);
            }
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
            const info = await stat(file);
            if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
            const ext = path.extname(file).toLowerCase();
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

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/update',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              assertLocalRequest(store, req, false);
              const status = updateService.status();
              if (!status.checkedAt || Date.now() - Date.parse(status.checkedAt) > UPDATE_CHECK_TTL_MS) {
                Promise.resolve(updateService.refresh()).catch((error) => logHost('update refresh failed: ' + String(error && error.message ? error.message : error)));
              }
              return sendJson(res, 200, { ok: true, ...status });
            }
            if (req.method === 'POST') {
              assertLocalRequest(store, req, true);
              const body = await readBody(req);
              const action = body && typeof body.action === 'string' ? body.action : '';
              if (action === 'ack') {
                await updateService.ack();
                return sendJson(res, 200, { ok: true });
              }
              if (action === 'apply') {
                // 只装服务端自己查到的最新版；请求体里的版本号不可信。
                const outcome = await updateService.apply();
                if (outcome.ok === false) return sendJson(res, 200, { ok: false, code: outcome.code });
                return sendJson(res, 200, { ok: true });
              }
              return sendJson(res, 400, { ok: false, error: 'unknown action' });
            }
            return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 500, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('update route error: ' + String(error)); return () => {}; }
  }, 'mo-image: update route');

  const renderImage = (_args, value) => {
    let ref = '';
    try { ref = value && value.path ? signPreview(value.path) : ''; } catch (error) { logHost('preview sign error: ' + String(error && error.message ? error.message : error)); }
    if (!ref) ref = path.basename((value && value.path) || '');
    const blocks = [{
      type: 'text',
      text: '![生成图片](' + publicOrigin() + '/api/mo-image/preview/' + encodeURIComponent(ref) + ')'
    }];
    if (value && value.note) blocks.push({ type: 'text', text: value.note });
    return blocks;
  };
  const pendingPresentations = new Map();
  const presentImage = (exec, result) => {
    try {
      const projections = ctx.get && ctx.get('sessionProjections');
      const boundary = projections && exec.agent ? projections.stateOf(exec.agent.session, 'turnBoundary') : undefined;
      if (boundary && boundary.openTurnStartSeq !== null && boundary.lastTurn !== undefined) {
        pendingPresentations.set(exec, {
          session: exec.agent.session, turn: boundary.lastTurn,
          callId: exec.callId, file: result.file
        });
      }
    } catch (error) { logHost('present error: ' + String(error && error.message ? error.message : error)); }
  };
  const flushPresentation = (exec, result) => {
    const item = pendingPresentations.get(exec);
    if (!item) return;
    pendingPresentations.delete(exec);
    if (result && result.isError) return;
    try {
      item.session.append('deliverables/presented', {
        turn: item.turn, callId: item.callId,
        files: [{ path: item.file, description: 'AI 生成图片' }]
      });
    } catch (error) { logHost('present append error: ' + String(error && error.message ? error.message : error)); }
  };
  if (typeof ctx.on === 'function') ctx.on('tools/result', flushPresentation);
  const output = {
    schema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string' },
        note: { type: 'string' }
      }
    },
    render: renderImage
  };
  // DSH 的工具契约要求每个工具声明 output { schema, render? }；settings
  // 返回值就是给模型看的全部内容：一个最小 JSON（提供商/模型唯一 id + 优化开关 + 一句写法提示）。
  const modelsOutput = {
    schema: {
      type: 'object', additionalProperties: false,
      required: ['provider', 'model', 'promptOptimization', 'hint'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        promptOptimization: { type: 'boolean' },
        hint: { type: 'string' },
        models: { type: 'array', items: { type: 'string' } },
        params: { type: 'array', items: { type: 'object' } }
      }
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  };

  // 生图前必须先读配置。只靠系统提示词时，多轮之后模型会按上一条提示词的习惯继续写，
  // 换了模型、关了提示词优化都不看；把当前配置放进工具结果，能让它每次写之前重读一遍。
  // 一次读取在当前回合内有效，配置一变（换模型、切优化开关）就作废。
  const marks = new WeakMap();
  const signatureOf = (state) => {
    if (!state) return '';
    const defaults = state.defaults || {};
    return [
      (state.provider && state.provider.id) || '', state.model,
      state.promptOptimization === false ? 'off' : 'on',
      defaults.quality || '', defaults.width || '', defaults.height || ''
    ].join('|');
  };
  const sessionOf = (exec) => (exec && exec.agent && exec.agent.session) || null;
  const currentTurn = (session) => {
    try {
      const projections = ctx.get && ctx.get('sessionProjections');
      if (!projections || typeof projections.stateOf !== 'function') return null;
      const boundary = projections.stateOf(session, 'turnBoundary');
      const seq = boundary && boundary.openTurnStartSeq;
      return typeof seq === 'number' ? seq : null;
    } catch (error) { logHost('turn lookup error: ' + String(error && error.message ? error.message : error)); return null; }
  };
  const rememberSettings = (exec) => {
    const session = sessionOf(exec);
    if (!session) return;
    marks.set(session, { signature: signatureOf(activeImageState(store)), turn: currentTurn(session) });
  };
  const requireSettings = (exec) => {
    const session = sessionOf(exec);
    if (!session) return; // 没有会话上下文（脚本调用）时无从比对，不拦。
    const mark = marks.get(session);
    const turn = currentTurn(session);
    const fresh = !!mark
      && mark.signature === signatureOf(activeImageState(store))
      && (turn === null || mark.turn === turn);
    if (!fresh) {
      throw new Error('生成前先读当前配置：调用 mo_image_settings，按它返回的模型写法和提示词优化状态写提示词，再调用本工具。');
    }
  };
  // 拿不到回合号时退回一次一读：生成成功后作废这次读取，失败不消耗。
  const consumeSettings = (exec) => {
    const session = sessionOf(exec);
    if (session && currentTurn(session) === null) marks.delete(session);
  };

  // 每个工具单独兜底：一个工具的契约不满足时，不会连带其它工具一起注册失败。
  try {
    ctx.tools.register({
      name: 'mo_image_settings',
      description: 'Read the current image settings before every generation or edit: the picked provider and model, whether prompt optimization is on, and a one-line hint for how to write the prompt for that model. Calling mo_image_generate or mo_image_edit without reading this first in the current turn is rejected, so read it again after the user switches models or toggles a setting.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: modelsOutput,
      timeoutMs: 15000,
      async execute(_args, exec) {
        rememberSettings(exec);
        return settingsPayload(activeImageState(store));
      }
    });
  } catch (error) { logHost('settings tool register error: ' + String(error)); }

  try {
    ctx.tools.register({
      name: 'mo_image_generate',
      description: 'Generate a new image with the active image model. Call mo_image_settings first in this turn: it returns the current model, the prompt-optimization state and the writing rules for that model, and this tool rejects a call that did not read it. Then follow what it returned: when optimization is On, write the final prompt in the active model\'s dialect; when Off, pass the user\'s original wording unchanged. Model, size, and quality come from the picker, so leave the model argument out; only in Auto mode must you pass one id from the active provider list. Load the mo-image-generation skill only when you have not already read this model\'s writing rules in this conversation; when optimization is Off, use only its invocation and output guidance, not its prompt formulas. The tool returns a Markdown image line and a file card; reply with that Markdown line and nothing else. Output is final: never judge or describe the image, never switch provider, model or tool (local image models, Blender, scripting) on your own, and do not open or read the image unless the user explicitly asks to look at it. On failure report the error verbatim and at most ask the user whether to switch.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'Final prompt adapted to the active model when optimization is On; otherwise the user\'s original wording. Cover subject, action, environment, style, lighting, composition, and constraints; quote in-image text exactly.' },
          negative_prompt: { type: 'string', description: 'Optional prompt content. Only for models that support negative prompts; list artifacts and undesired elements. Omit otherwise.' },
          model: { type: 'string', description: 'Optional outside Auto mode: omit it and the picker\'s model is used. In Auto mode it is required — one id from the active provider list. A value other than the picked model is rejected; never use it to switch models.' },
          provider: { type: 'string', description: 'Optional. The provider the user selected; it is validated against the picker and never switches providers. Omit when unsure.' },
          params: {
            type: 'object', additionalProperties: true,
            description: 'Optional workflow parameters for the active model, as listed by mo_image_settings. Omit any you do not need: the workflow default applies. Keys the current model does not support are ignored and reported back in note.'
          }
        }
      },
      output, timeoutMs: 360000,
      async execute(args, exec) {
        requireSettings(exec);
        const result = await generate(args, exec, store);
        consumeSettings(exec);
        presentImage(exec, result);
        return result.note ? { path: result.file, note: result.note } : { path: result.file };
      }
    });
  } catch (error) { logHost('generate tool register error: ' + String(error)); }

  try {
    ctx.tools.register({
      name: 'mo_image_edit',
      description: 'Edit or refine an existing image with one or more reference images. Call mo_image_settings first in this turn: it returns the current model, the prompt-optimization state and the writing rules for that model, and this tool rejects a call that did not read it. Follow what it returned: when optimization is Off, use the user\'s original edit wording and do not expand it. Model, size, and quality come from the picker, so leave the model argument out; only in Auto mode must you pass one id from the active provider list. Name each reference as 图1/图2 in the prompt. For a full redo that must not copy the current image, use mo_image_generate instead. Load the mo-image-editing skill only when you have not already read this model\'s editing rules in this conversation; when optimization is Off, use only its invocation and output guidance, not its edit formula. Output is final: never judge or describe the image, never switch provider, model or tool (local image models, Blender, scripting) on your own, and do not open or read the image unless the user explicitly asks to look at it. On failure report the error verbatim and at most ask the user whether to switch.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['prompt', 'images'],
        properties: {
          prompt: { type: 'string', description: 'Final edit prompt. Name each reference image (图1/图2), state exactly what to change, and state that everything else must stay unchanged.' },
          images: { type: 'array', items: { type: 'string' }, description: '1–16 absolute local paths or http(s) URLs; order matters and corresponds to 图1/图2.' },
          negative_prompt: { type: 'string', description: 'Optional prompt content. Only for models that support negative prompts; list artifacts and undesired elements. Omit otherwise.' },
          model: { type: 'string', description: 'Optional outside Auto mode: omit it and the picker\'s model is used. In Auto mode it is required — one id from the active provider list. A value other than the picked model is rejected; never use it to switch models.' },
          provider: { type: 'string', description: 'Optional. The provider the user selected; it is validated against the picker and never switches providers. Omit when unsure.' },
          params: {
            type: 'object', additionalProperties: true,
            description: 'Optional workflow parameters for the active model, as listed by mo_image_settings. Omit any you do not need: the workflow default applies. Keys the current model does not support are ignored and reported back in note.'
          }
        }
      },
      output, timeoutMs: 360000,
      async execute(args, exec) {
        requireSettings(exec);
        const result = await edit(args, exec, store);
        consumeSettings(exec);
        presentImage(exec, result);
        return result.note ? { path: result.file, note: result.note } : { path: result.file };
      }
    });
  } catch (error) { logHost('edit tool register error: ' + String(error)); }
}
