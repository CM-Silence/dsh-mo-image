import { resolveHttpUrl } from './adapter-kit.js';
import { applyFields } from './field-templates.js';
import { DEFAULT_EMPTY_MESSAGE, outputProfile, outputProfiles } from './output-profiles.js';

const MIB = 1024 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH'];
const TRANSPORTS = ['json', 'multipart', 'form', 'query'];
const IMAGE_FIELDS = new Set(['prompt', 'negative', 'model', 'n', 'image', 'quality', 'size', 'width', 'height', 'aspect', 'tier']);
const NON_DATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ROUTE_TASK_FIELDS = {
  statusPath: ['status', 'state'],
  success: ['succeeded', 'success', 'completed', 'done', 'ready'],
  failure: ['failed', 'error', 'canceled', 'cancelled'],
  resultPath: ['output', 'result', 'images', 'url']
};

const OUTPUT_PRESETS = {
  openai: {
    kind: 'json',
    pick: [{ path: 'data.0.b64_json', as: 'base64' }, { path: 'data.0.url', as: 'url' }]
  },
  binary: { kind: 'binary' },
  'image-url': { kind: 'json', pick: [{ path: 'image_url', as: 'url' }, { path: 'url', as: 'url' }] },
  'image-base64': { kind: 'json', pick: [{ path: 'image', as: 'base64' }, { path: 'base64', as: 'base64' }] },
  'task-location': {
    kind: 'task', pollUrlFrom: 'location', ...ROUTE_TASK_FIELDS
  },
  'task-json': {
    kind: 'task', idPath: ['task_id', 'job_id', 'id'], path: '/tasks/{taskId}',
    ...ROUTE_TASK_FIELDS
  }
};

export function outputPresetManifest() {
  return ['auto', ...Object.keys(OUTPUT_PRESETS)];
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

function knownKeys(raw, keys, label) {
  if (!plainObject(raw)) throw new Error(label + ' 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new Error(label + ' 不支持字段 ' + key);
  }
}

function cleanData(value, depth = 0) {
  if (depth > 16) throw new Error('操作配置最多嵌套 16 层');
  if (Array.isArray(value)) return value.map((item) => cleanData(item, depth + 1));
  if (!plainObject(value)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('操作配置只接受 JSON 数据');
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (NON_DATA_KEYS.has(key)) throw new Error('操作配置包含无效属性 ' + key);
    return [key, cleanData(item, depth + 1)];
  }));
}

function bound(value, from, to, name) {
  if (!Number.isInteger(value) || value < from || value > to) {
    throw new Error(name + ' 必须是 ' + from + ' 到 ' + to + ' 之间的整数');
  }
}

function configuredOutput(raw) {
  const source = typeof raw === 'string' && Object.hasOwn(OUTPUT_PRESETS, raw) ? OUTPUT_PRESETS[raw] : raw;
  if (!plainObject(source)) throw new Error('请选择有效的返回格式预设或填写输出描述符');
  const profile = { maxBytes: 32 * MIB, emptyMessage: DEFAULT_EMPTY_MESSAGE, ...source };
  if (profile.kind === 'task') {
    if (profile.backoff === undefined && profile.intervalMs === undefined) profile.intervalMs = 2000;
    if (profile.failure === undefined) profile.failure = [];
    if (profile.pollOutput === 'binary' && profile.success === undefined) profile.success = [];
    for (const [name, value] of [
      ['intervalMs', profile.intervalMs], ['backoff.startMs', profile.backoff?.startMs], ['backoff.maxMs', profile.backoff?.maxMs],
      ['timeoutMs', profile.timeoutMs]
    ]) {
      if (value !== undefined) bound(value, 250, 340000, name);
    }
  }
  bound(profile.maxBytes, 1, 64 * MIB, 'maxBytes');
  if (profile.via) bound(profile.via.maxBytes, 1, 64 * MIB, 'via.maxBytes');
  for (const pick of [...(Array.isArray(profile.pick) ? profile.pick : []), ...(Array.isArray(profile.from) ? profile.from : [])]) {
    if (pick?.text !== undefined) throw new Error('自定义输出请使用字段路径。文本正则由内置预设提供');
  }
  return outputProfile(profile, '自定义返回格式');
}

export function resolveConfiguredOutput(raw, fallback) {
  if (raw === undefined || raw === 'auto') return fallback;
  if (!Array.isArray(raw)) return configuredOutput(raw);
  if (raw.length > 8) throw new Error('最多配置 8 个返回格式候选');
  return outputProfiles(raw.map(configuredOutput), '自定义返回格式');
}

export function operationOutputOf(raw, fallback) {
  return parsedOutput(raw) || fallback;
}

function staticHeaders(raw) {
  if (!plainObject(raw)) throw new Error('headers 必须是对象');
  const entries = Object.entries(raw);
  if (entries.length > 16) throw new Error('每项操作最多配置 16 个请求头');
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)
        || /^(?:authorization|proxy-|cookie|host|connection|content-length|transfer-encoding|content-type)|(?:token|secret|api-?key)/i.test(name)
        || typeof value !== 'string' || value.length > 1024 || /[\x00-\x1F\x7F]/.test(value)) {
      throw new Error('无效的操作请求头 ' + name + '。凭据请在鉴权方式中设置');
    }
  }
  return raw;
}

function originsOf(raw, label) {
  if (!Array.isArray(raw) || raw.length > 8) throw new Error(label + ' 最多接受 8 个 HTTP(S) 源');
  return [...new Set(raw.map((entry) => {
    const url = resolveHttpUrl(entry);
    if (!url || url !== new URL(url).origin + '/') throw new Error(label + ' 必须使用完整的 HTTP(S) 源');
    return new URL(url).origin;
  }))];
}

function modelListOutput(raw) {
  knownKeys(raw, ['path', 'idPath', 'namePath'], '模型列表返回格式');
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length > 256 || (key === 'namePath' && !value.trim())) {
      throw new Error('模型列表字段路径无效');
    }
  }
  return raw;
}

function validateFields(fields) {
  if (!plainObject(fields)) throw new Error('fields 必须是对象');
  for (const [name, spec] of Object.entries(fields)) {
    if (!IMAGE_FIELDS.has(name)) throw new Error('未知的输入字段 ' + name);
    if (spec !== null && spec !== false && !plainObject(spec)) throw new Error(name + ' 需要字段映射或 null');
  }
  applyFields({}, fields, {});
}

/** Validate interactions after provider and model settings have been merged. */
export function validateOperationTransport(kind, operation, transport) {
  if (operation.method === 'GET' && transport !== 'query') throw new Error('GET 操作必须使用 query 传输');
  for (const [name, spec] of Object.entries(operation.fields || {})) {
    if (!spec) continue;
    if (spec.multipart && (transport !== 'multipart' || (name === 'image' && kind !== 'edit'))) {
      throw new Error(name + ' 的 multipart 映射与操作的传输方式不符');
    }
    if (name === 'image' && (kind !== 'edit' || (transport === 'multipart' && !spec.multipart)
        || (!spec.multipart && !spec.as))) {
      throw new Error('参考图字段映射与编辑操作的传输方式不符');
    }
  }
}

/** Versioned data shared by saved providers, model overrides, and unsaved connection tests. */
export function normalizeOperations(raw, modelOnly = false) {
  if (raw === undefined || raw === null) return undefined;
  const label = '操作配置';
  if (JSON.stringify(raw).length > 64 * 1024) throw new Error(label + ' 超过大小限制');
  const config = cleanData(raw);
  knownKeys(config, modelOnly ? ['version', 'generate', 'edit'] : ['version', 'generate', 'edit', 'models'], label);
  if (config.version !== undefined && config.version !== 1) throw new Error('暂不支持此操作配置版本');
  for (const kind of ['generate', 'edit', 'models']) {
    const operation = config[kind];
    if (operation === undefined) continue;
    const models = kind === 'models';
    knownKeys(operation, models
      ? ['path', 'method', 'body', 'headers', 'output']
      : ['path', 'method', 'transport', 'input', 'body', 'fields', 'headers', 'output', 'pollOrigins', 'resultOrigins',
        'pollHeaders', 'pollNotFoundPending'], kind);
    if (operation.path !== undefined) {
      if (typeof operation.path !== 'string' || operation.path.length > 2048) throw new Error(kind + ' 的 path 无效');
      operation.path = operation.path.trim();
      if (/^\/\//.test(operation.path) || /^(?!https?:)[a-z][a-z\d+.-]*:/i.test(operation.path)
        || /^https?:/i.test(operation.path) && !resolveHttpUrl(operation.path)) {
        throw new Error(kind + ' 的 path 需要 HTTP(S) 地址或相对路径');
      }
    }
    if (operation.method !== undefined && !METHODS.includes(operation.method)) throw new Error(kind + ' 的 HTTP 方法无效');
    if (operation.transport !== undefined && !TRANSPORTS.includes(operation.transport)) throw new Error(kind + ' 的传输方式无效');
    if (operation.input !== undefined && !['inherit', 'explicit'].includes(operation.input)) throw new Error(kind + ' 的 input 无效');
    if (operation.fields !== undefined) validateFields(operation.fields);
    if (operation.headers !== undefined) operation.headers = staticHeaders(operation.headers);
    if (operation.pollHeaders !== undefined) operation.pollHeaders = staticHeaders(operation.pollHeaders);
    if (operation.pollNotFoundPending !== undefined && typeof operation.pollNotFoundPending !== 'boolean') {
      throw new Error('pollNotFoundPending 必须是布尔值');
    }
    if (operation.body !== undefined && !plainObject(operation.body)) throw new Error(kind + ' 的 body 必须是 JSON 对象');
    if (models && operation.body !== undefined && (!operation.method || operation.method === 'GET')) throw new Error('GET 模型列表使用端点查询参数');
    if (operation.output !== undefined) {
      if (models) modelListOutput(operation.output);
      else resolveConfiguredOutput(operation.output);
    }
    for (const key of ['pollOrigins', 'resultOrigins']) {
      if (operation[key] !== undefined) operation[key] = originsOf(operation[key], key);
    }
  }
  return { ...config, version: 1 };
}

/** Built-ins keep their request dialect and can opt into a different response format. */
export function normalizeResponseOverrides(raw, modelOnly = false) {
  const operations = normalizeOperations(raw, modelOnly);
  if (!operations) return operations;
  if (operations.models) throw new Error('此协议使用内置模型列表格式');
  for (const entry of [operations.generate, operations.edit]) {
    if (entry) knownKeys(entry, ['output'], '内置协议的返回格式');
  }
  return operations;
}

const outputCache = new WeakMap();
const presetCache = new Map();

function parsedOutput(raw) {
  if (raw === 'auto' || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (!presetCache.has(raw)) presetCache.set(raw, resolveConfiguredOutput(raw));
    return presetCache.get(raw);
  }
  if (!raw || typeof raw !== 'object') return resolveConfiguredOutput(raw);
  let result = outputCache.get(raw);
  if (!result) {
    result = resolveConfiguredOutput(raw);
    outputCache.set(raw, result);
  }
  return result;
}

export function responseOverridesOf(provider, model) {
  const defaults = provider?.operations;
  const override = provider?.modelOptions?.[model]?.operations;
  if (!defaults && !override) return null;
  const base = compiledOperations(defaults, 'responses');
  const settings = compiledOperations(override, 'model-responses');
  return {
    generate: parsedOutput(settings.generate?.output ?? base.generate?.output),
    edit: parsedOutput(settings.edit?.output ?? base.edit?.output)
  };
}

export function providerOperationsOf(provider, model) {
  const base = compiledOperations(provider?.operations, 'operations');
  const override = compiledOperations(provider?.modelOptions?.[model]?.operations, 'model-operations');
  return Object.fromEntries(['generate', 'edit', 'models'].flatMap((kind) => {
    if (!base[kind] && !override[kind]) return [];
    const entry = { ...base[kind], ...override[kind] };
    if (base[kind]?.fields || override[kind]?.fields) entry.fields = { ...base[kind]?.fields, ...override[kind]?.fields };
    return [[kind, entry]];
  }));
}

const compiled = new WeakMap();

function compiledOperations(raw, scope) {
  const modelOnly = scope.startsWith('model-');
  const normalize = scope.endsWith('responses') ? normalizeResponseOverrides : normalizeOperations;
  if (!plainObject(raw)) return normalize(raw, modelOnly) || {};
  let cache = compiled.get(raw);
  if (!cache) compiled.set(raw, cache = {});
  return cache[scope] ||= normalize(raw, modelOnly);
}
