/**
 * ComfyUI 工作流解析：把用户贴进来的任何一种工作流，变成「参数该写进哪个节点」的映射。
 *
 * 纯函数，不碰网络和文件：/object_info 由调用方取好传进来。
 * 提示词、尺寸与质量由解析器绑定。其它参数保留工作流自己的配置入口。
 *
 * 定位策略：先找到主采样器，再把**它整条上游闭包**摊开，按角色（positive/negative）、
 * 名字（seed/ckpt_name）和类型去匹配。不逐输入查表——FLUX.2 的 SamplerCustomAdvanced
 * 自己没有 positive/seed/model，这些散落在 CFGGuider 和 RandomNoise 上。
 */

export const MAPPING_KEYS = ['prompt', 'negative_prompt', 'width', 'height', 'quality', 'seed', 'model', 'image'];
export const WORKFLOW_REFERENCE_LIMIT = 16;

/** 输入名优先级：先认这些名字，再退而求其次找其它字符串输入。 */
const TEXTISH = /^(text|string|value)$/i;
const POSITIVE_PROMPT = /^(prompt|positive_prompt|positivePrompt)$/i;
const NEGATIVE_PROMPT = /^(negative_prompt|negativePrompt)$/i;
const QUALITYISH = /^(quality|image_quality|quality_preset|rendering_quality)$/i;
const SEEDISH = /^(seed|noise_seed)$/i;
const MODELISH = /^(ckpt_name|unet_name|model_name)$/i;
/** UI 格式里，种子后面那个「fixed/randomize」下拉不是节点输入，但占了一个 widgets_values 位。 */
const PHANTOM_WIDGETS = new Set(['fixed', 'increment', 'decrement', 'randomize']);

const SUMMARY_MAX = 80;

export function workflowPlaceholders(text) {
  return new Set(Array.from(text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g), (match) =>
    match[1] === 'negativePrompt' ? 'negative_prompt' : match[1]));
}

function placeholdersIn(value) {
  const found = new Set();
  const visit = (part) => {
    if (typeof part === 'string' && part.includes('{{')) {
      for (const name of workflowPlaceholders(part)) found.add(name);
    } else if (part && typeof part === 'object') {
      for (const item of Object.values(part)) visit(item);
    }
  };
  visit(value);
  return found;
}

export function workflowInputPlaceholders(graph) {
  const found = new Set();
  for (const node of Object.values(graph)) {
    for (const name of placeholdersIn(node.inputs)) found.add(name);
  }
  return found;
}

/** 只在字符串外剥离 // 行注释，避免把提示词里的网址吃掉。 */
function stripLineComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonLenient(source) {
  try {
    return JSON.parse(source);
  } catch (first) {
    const stripped = stripLineComments(source).replace(/,\s*([}[\]])/g, '$1');
    try {
      return JSON.parse(stripped);
    } catch (_second) {
      throw new Error('工作流不是合法 JSON：' + String(first && first.message ? first.message : first));
    }
  }
}

/** 判定格式：UI 格式带 nodes/links，API 格式是 节点id → {class_type, inputs}。 */
export function parseWorkflow(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const parsed = parseJsonLenient(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工作流必须是 ComfyUI 的 API 格式对象或 UI 格式工作流。');
  }
  if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) {
    return { format: 'ui', ui: parsed, warnings: [] };
  }
  const entries = Object.entries(parsed);
  const looksApi = entries.length > 0 && entries.every(([, value]) =>
    value && typeof value === 'object' && !Array.isArray(value) && typeof value.class_type === 'string');
  if (looksApi) return { format: 'api', graph: parsed, warnings: [] };
  throw new Error('工作流必须是 ComfyUI 的 API 格式对象或 UI 格式工作流。');
}

function linkSource(link) {
  if (Array.isArray(link)) return { from: String(link[1]), fromSlot: Number(link[2]) };
  if (link && typeof link === 'object') {
    return { from: String(link.origin_id), fromSlot: Number(link.origin_slot) };
  }
  return null;
}

function linkTargetOf(link) {
  if (Array.isArray(link)) return { target: String(link[3]), type: String(link[5] || '') };
  return { target: String(link.target_id), type: String(link.type || '') };
}

/**
 * UI 格式 → API 格式。widgets_values 按 object_info 的输入顺序对齐。
 * `missing` 列出缺签名的节点类：UI 格式丢了节点就会留下悬空连线，调用方必须当硬错误处理。
 */
export function uiToApi(ui, objectInfo) {
  const warnings = [];
  const missing = [];
  const links = new Map();
  for (const link of ui.links || []) {
    const linkId = Array.isArray(link) ? link[0] : link && link.id;
    const source = linkSource(link);
    const resolved = linkTargetOf(link);
    if (linkId === undefined || !source || !resolved) continue;
    links.set(linkId, { from: source.from, fromSlot: source.fromSlot });
  }

  const graph = {};
  for (const node of ui.nodes || []) {
    const type = node && node.type;
    const schema = type ? objectInfo[type] : undefined;
    if (!schema) {
      if (type && !missing.includes(type)) missing.push(type);
      continue;
    }
    const id = String(node.id);
    const inputs = {};
    const linked = new Map();
    for (const entry of node.inputs || []) {
      if (!entry || entry.link === null || entry.link === undefined) continue;
      const resolved = links.get(entry.link);
      if (resolved) linked.set(entry.name, [resolved.from, resolved.fromSlot]);
    }
    const required = schema.input && schema.input.required ? Object.keys(schema.input.required) : [];
    const optional = schema.input && schema.input.optional ? Object.keys(schema.input.optional) : [];
    const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
    let cursor = 0;
    for (const name of [...required, ...optional]) {
      if (linked.has(name)) { inputs[name] = linked.get(name); continue; }
      const spec = (schema.input.required && schema.input.required[name]) || (schema.input.optional && schema.input.optional[name]) || [];
      if (spec[1]?.forceInput) continue;
      if (cursor >= widgets.length) continue;
      inputs[name] = widgets[cursor];
      cursor += 1;
      if (SEEDISH.test(name) && typeof widgets[cursor] === 'string' && PHANTOM_WIDGETS.has(widgets[cursor])) cursor += 1;
    }
    graph[id] = { class_type: type, inputs };
    if (typeof node.title === 'string' && node.title.trim()) graph[id]._meta = { title: node.title };
  }
  for (const type of missing) warnings.push('工作流里的节点 ' + type + ' 没有安装，涉及它的连线会被忽略');
  return { graph, warnings, missing };
}

/* ------------------------------------------------------------------ 图遍历 */

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

function inputEntries(node) {
  if (!node || !node.inputs || typeof node.inputs !== 'object') return [];
  return Object.entries(node.inputs);
}

function summarize(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? flat.slice(0, SUMMARY_MAX) + '…' : flat;
}

function makeCandidate(id, node, input, value) {
  return { node: id, input, classType: node.class_type, value: summarize(value) };
}

function findOutputNodes(graph, objectInfo) {
  return Object.keys(graph).filter((id) => {
    const type = graph[id].class_type;
    const schema = objectInfo[type];
    return schema ? Boolean(schema.output_node) : type === 'SaveImage' || type === 'PreviewImage';
  }).sort();
}

function outputTypes(node, objectInfo) {
  const schema = objectInfo[node.class_type];
  return schema && Array.isArray(schema.output) ? schema.output : [];
}

/** 从输出节点反向 BFS，按距离找出所有采样器（最近的是主采样器）。 */
function findSamplers(graph, objectInfo, outputIds) {
  const found = [];
  const seen = new Set(outputIds);
  let frontier = outputIds.map((id) => ({ id, depth: 0 }));
  while (frontier.length) {
    const next = [];
    for (const item of frontier) {
      const node = graph[item.id];
      if (!node) continue;
      const hasLatent = inputEntries(node).some(([name]) => name === 'latent_image');
      const types = outputTypes(node, objectInfo);
      if (hasLatent && item.depth > 0 && (types.includes('LATENT') || !types.length)) {
        found.push({ id: item.id, depth: item.depth });
      }
      for (const [, value] of inputEntries(node)) {
        if (!isLink(value)) continue;
        const source = String(value[0]);
        if (seen.has(source) || !graph[source]) continue;
        seen.add(source);
        next.push({ id: source, depth: item.depth + 1 });
      }
    }
    frontier = next;
  }
  found.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return found.map((item) => item.id);
}

/** 从各起点向上游查找，记录到最近起点的距离。 */
function upstreamClosure(graph, roots) {
  const depth = new Map(roots.map((id) => [id, 0]));
  let frontier = roots;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const node = graph[id];
      if (!node) continue;
      for (const [, value] of inputEntries(node)) {
        if (!isLink(value)) continue;
        const source = String(value[0]);
        if (depth.has(source) || !graph[source]) continue;
        depth.set(source, depth.get(id) + 1);
        next.push(source);
      }
    }
    frontier = next;
  }
  return depth;
}

/** 在上游闭包里按角色找输入（positive/negative），最近的优先。 */
function findRoleLink(graph, ids, role, matcher) {
  for (const id of ids) {
    const hit = inputEntries(graph[id]).find(([name, value]) => (name === role || matcher.test(name)) && isLink(value));
    if (hit) return hit[1];
  }
  return null;
}

/** 从某个输入出发，按优先级向上找字面量字符串输入；沿途收集候选。 */
function walkText(graph, startLink, pool, role, matcher) {
  const visited = new Set();
  let primary = null;

  const matches = (name) => matcher.test(name) || name === role || TEXTISH.test(name);
  const excluded = (name) => name === 'system_prompt'
    || (role === 'positive' ? name === 'negative' || NEGATIVE_PROMPT.test(name)
      : name === 'positive' || POSITIVE_PROMPT.test(name));
  const rank = (name) => (matches(name) ? 0 : excluded(name) ? 2 : 1);
  const visit = (link) => {
    if (!isLink(link)) return;
    const id = String(link[0]);
    if (visited.has(id)) return;
    visited.add(id);
    const node = graph[id];
    if (!node) return;
    const ordered = [...inputEntries(node)].sort(([a], [b]) => rank(a) - rank(b));
    for (const [name, value] of ordered) {
      // 空字符串也是字面量：导出和模板里的文本框默认就是空的，跳过它等于让整条角色参数消失。
      if (typeof value !== 'string') continue;
      pool.push(makeCandidate(id, node, name, value));
      if (!primary && matches(name)) primary = { node: id, input: name };
    }
    for (const [name, value] of ordered) {
      if (!isLink(value)) continue;
      if (name === 'clip' || name === 'model' || name === 'vae') continue;
      visit(value);
    }
  };
  visit(startLink);
  const fallback = pool.find((item) => !excluded(item.input));
  if (!primary && fallback) primary = { node: fallback.node, input: fallback.input };
  return primary;
}

function upstreamIds(graph, roots) {
  const closure = upstreamClosure(graph, roots);
  return [...closure.keys()].sort((a, b) => closure.get(a) - closure.get(b) || a.localeCompare(b));
}

/** 在上游闭包里按名字找某个输入，最近的优先。 */
function findInClosure(graph, ids, matcher, accepts = () => true) {
  for (const id of ids) {
    for (const [name, value] of inputEntries(graph[id]).sort(([a], [b]) => a.localeCompare(b))) {
      if (matcher.test(name) && accepts(value)) return { node: id, input: name };
    }
  }
  return null;
}

function findQuality(graph, ids, objectInfo) {
  for (const id of ids) {
    const node = graph[id];
    const schema = objectInfo[node.class_type];
    if (!schema || schema.output_node) continue;
    for (const [name, value] of inputEntries(node)) {
      if (!QUALITYISH.test(name) || typeof value !== 'string') continue;
      const [type, metadata] = schema.input?.required?.[name] || schema.input?.optional?.[name] || [];
      const values = Array.isArray(type) ? type : type === 'COMBO' && metadata?.options;
      if (!Array.isArray(values)) continue;
      const options = new Map();
      for (const label of values) {
        if (typeof label !== 'string') continue;
        const key = label.trim().toLowerCase().replace(/\s+/g, '-');
        if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(key) || key === 'off' || key === 'auto') continue;
        if (!options.has(key) || label === value) options.set(key, label);
      }
      if (!options.size) continue;
      return {
        target: { node: id, input: name },
        spec: {
          supported: true,
          options: [...options].map(([key, label]) => ({ value: key, label, default: label === value })),
          map: Object.fromEntries(options)
        }
      };
    }
  }
  return null;
}

/** 定位生成链路上的输入，跳过与输出无关的节点。 */
function workflowBindings(graph, objectInfo, outputIds) {
  const samplers = findSamplers(graph, objectInfo, outputIds);
  const samplerId = samplers[0];
  const roots = samplerId ? [samplerId] : outputIds;
  const ids = upstreamIds(graph, roots);
  const promptPool = [];
  const negativePool = [];
  const findPrompt = (role, matcher, pool) => (
    walkText(graph, findRoleLink(graph, ids, role, matcher), pool, role, matcher)
      || findInClosure(graph, ids, matcher, (value) => typeof value === 'string')
  );
  const prompt = findPrompt('positive', POSITIVE_PROMPT, promptPool);
  const negative = findPrompt('negative', NEGATIVE_PROMPT, negativePool);
  const samePrompt = prompt && negative && prompt.node === negative.node && prompt.input === negative.input;
  const latent = graph[samplerId]?.inputs?.latent_image;
  const sizeIds = isLink(latent) ? [...new Set([...upstreamIds(graph, [latent[0]]), ...ids])] : ids;
  const quality = findQuality(graph, ids, objectInfo);
  const mapping = {
    prompt, negative_prompt: samePrompt ? null : negative,
    width: findInClosure(graph, sizeIds, /^width$/, isDimensionInput),
    height: findInClosure(graph, sizeIds, /^height$/, isDimensionInput),
    seed: findInClosure(graph, ids, SEEDISH),
    model: findInClosure(graph, ids, MODELISH, (value) => !isLink(value)),
    image: null
  };
  if (quality) mapping.quality = quality.target;
  return { mapping, quality: quality?.spec, samplers, promptPool, negativePool };
}

function isDimensionInput(value) {
  return Number.isFinite(value) || isLink(value)
    || (typeof value === 'string' && /^\{\{\s*(width|height)\s*\}\}$/.test(value));
}

export function findWorkflowPrompt(graph, objectInfo = {}) {
  return workflowBindings(graph, objectInfo, findOutputNodes(graph, objectInfo)).mapping.prompt;
}

/** 只绑定输出链路上的图像上传控件。文件名来自 ComfyUI 的 input 目录。 */
function referenceInputs(graph, objectInfo, outputIds) {
  const sources = new Set();
  for (const id of upstreamIds(graph, outputIds)) {
    for (const [, value] of inputEntries(graph[id])) {
      if (!isLink(value)) continue;
      const source = graph[value[0]];
      const types = outputTypes(source || {}, objectInfo);
      const imageOutput = types.length ? types[value[1]] === 'IMAGE'
        : source?.class_type === 'LoadImage' && value[1] === 0;
      if (imageOutput) sources.add(value[0]);
    }
  }
  const candidates = [];
  for (const id of sources) {
    const node = graph[id];
    const signature = objectInfo[node.class_type]?.input;
    for (const [name, value] of inputEntries(node)) {
      if (typeof value !== 'string' || /mask/i.test(name)) continue;
      const metadata = (signature?.required?.[name] || signature?.optional?.[name])?.[1];
      const loader = node.class_type === 'LoadImage' && name === 'image';
      if (!loader && !(metadata?.image_upload === true && (!metadata.image_folder || metadata.image_folder === 'input'))) continue;
      candidates.push(makeCandidate(id, node, name, value));
    }
  }
  return candidates;
}

export function workflowReferenceTarget(graph, saved, objectInfo = {}) {
  const outputIds = findOutputNodes(graph, objectInfo);
  const images = referenceInputs(graph, objectInfo, outputIds);
  const node = saved && graph[saved.node];
  if (typeof node?.inputs?.[saved.input] === 'string') {
    if (!outputIds.length) return saved; // API 导出可能使用客户端无法识别的自定义输出节点。
    if (images.some((target) => target.node === saved.node && target.input === saved.input)) return saved;
    if (node.class_type !== 'LoadImage' && upstreamClosure(graph, outputIds).has(saved.node)) return saved;
  }
  return uniqueReference(images);
}

export function isWorkflowImagePlaceholder(name) {
  return name === 'image' || name.startsWith('image_');
}

/** Numbered placeholders opt inputs into editing. Other image loaders keep their own assets. */
export function workflowImageSlots(graph) {
  const slots = new Map();
  for (const [id, node] of Object.entries(graph)) {
    const title = typeof node._meta?.title === 'string' ? node._meta.title.replace(/\s+/g, ' ').trim() : '';
    for (const [input, value] of inputEntries(node)) {
      for (const name of placeholdersIn(value)) {
        if (!isWorkflowImagePlaceholder(name)) continue;
        const index = name === 'image' ? 1 : Number(name.slice(6));
        if (!Number.isInteger(index) || index < 1 || index > WORKFLOW_REFERENCE_LIMIT
          || (name !== 'image' && name !== 'image_' + index)) {
          throw new Error('参考图占位符必须从 {{image_1}} 到 {{image_' + WORKFLOW_REFERENCE_LIMIT + '}}：' + name);
        }
        const slot = slots.get(index) || { index, keys: new Set(), targets: [], purpose: '' };
        slot.keys.add(name);
        slot.targets.push({ node: id, input });
        if (!slot.purpose && title && title !== node.class_type) slot.purpose = title.slice(0, 96);
        slots.set(index, slot);
      }
    }
  }
  const list = Array.from(slots.values()).sort((a, b) => a.index - b.index);
  if (list.some((slot, index) => slot.index !== index + 1)) {
    throw new Error('参考图占位符须从 {{image_1}} 开始连续编号；{{image}} 等同于 {{image_1}}。');
  }
  if (!list.length || list.every((slot) => slot.purpose)) return list;
  const uses = new Map();
  for (const node of Object.values(graph)) {
    for (const [input, value] of inputEntries(node)) {
      if (!isLink(value) || /^(image|images|pixels|input|value|source)$/i.test(input)) continue;
      const source = value[0];
      if (!uses.has(source)) uses.set(source, input);
      else if (uses.get(source) !== input) uses.set(source, null);
    }
  }
  for (const slot of list) {
    const target = slot.targets[0];
    const purpose = uses.get(target.node) || target.input;
    if (!slot.purpose && !/^(widgets|image|images|pixels|input|value|source)$/i.test(purpose)) {
      slot.purpose = purpose.slice(0, 96);
    }
  }
  return list;
}

export function assertComfyReferenceCount(actual, expected) {
  if (actual !== expected) throw new Error('当前 ComfyUI 工作流需要 ' + expected
    + ' 张参考图，实际收到 ' + actual + ' 张。请按配置中的参考图入口顺序传入 images。');
}

function uniqueReference(images) {
  return images.length === 1 ? { node: images[0].node, input: images[0].input } : null;
}

/**
 * 分析整张图。返回的 mapping 里每一项要么是 {node, input}，要么是 null。
 * @throws 图里没有输出节点时抛错——ComfyUI 会直接拒绝执行这种图。
 */
export function analyzeWorkflow(graph, objectInfo) {
  const warnings = [];
  const outputIds = findOutputNodes(graph, objectInfo);
  if (!outputIds.length) throw new Error('这个工作流没有输出节点，ComfyUI 不会执行它。');

  const { mapping, quality, samplers, promptPool, negativePool } = workflowBindings(graph, objectInfo, outputIds);
  const placeholders = workflowInputPlaceholders(graph);
  if (!mapping.prompt && !placeholders.has('prompt')) {
    warnings.push('未识别到提示词输入。请将工作流的提示词输入设为 {{prompt}} 后重新解析。');
  }

  const images = referenceInputs(graph, objectInfo, outputIds);
  const slots = [...placeholders].some(isWorkflowImagePlaceholder) ? workflowImageSlots(graph) : [];
  mapping.image = uniqueReference(images);
  const ambiguousImage = images.length > 1 && !slots.length;

  const candidates = {
    prompt: promptPool,
    negative_prompt: negativePool,
    seed: collectInputs(graph, SEEDISH),
    model: collectInputs(graph, MODELISH),
    image: images,
    sampler: samplers.map((id) => makeCandidate(id, graph[id], 'latent_image', id))
  };

  return {
    mapping, quality, candidates, warnings, ambiguousImage, samplerId: samplers[0] || null, outputIds,
    params: [
      ...collectRoleParams(graph, mapping, objectInfo).map((param) => (
        Object.assign({}, param, { candidates: paramCandidates(graph, param.name) })
      )),
      ...collectParams(graph, mapping, objectInfo).map((param) => (
        Object.assign({}, param, { candidates: paramCandidates(graph, param.name) })
      ))
    ]
  };
}

function collectInputs(graph, matcher) {
  const out = [];
  for (const id of Object.keys(graph).sort()) {
    const node = graph[id];
    for (const [name, value] of inputEntries(node)) {
      if (!matcher.test(name)) continue;
      out.push(makeCandidate(id, node, name, value));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 注入 */

const VALUE_KEYS = {
  prompt: 'prompt',
  negative_prompt: 'negativePrompt',
  width: 'width',
  height: 'height',
  quality: 'quality',
  seed: 'seed',
  model: 'model',
  image: 'image'
};

/**
 * 按映射把运行时参数写进工作流副本。
 * @throws 映射指向的节点不存在时抛错——静默跳过会生成一张参数没进去的图。
 */
export function injectByMapping(graph, mapping, values) {
  const out = structuredClone(graph);
  const applied = [];
  for (const key of MAPPING_KEYS) {
    const target = mapping && mapping[key];
    if (!target) continue;
    const value = values ? values[VALUE_KEYS[key]] : undefined;
    if (value === undefined || value === null || value === '') continue;
    const node = out[target.node];
    if (!node) {
      throw new Error('工作流里找不到节点 ' + target.node + '，映射已失效，请重新解析工作流。');
    }
    node.inputs = node.inputs || {};
    node.inputs[target.input] = value;
    applied.push(key);
  }
  return { graph: out, applied };
}

/* -------------------------------------------------------------- 可调参数 */

/**
 * 方案 A：只暴露这几个常用参数。它们在不在，取决于工作流里有没有，
 * 且永远不碰映射已经占用的输入（种子、宽高、提示词等）。
 */
const TUNABLE_PARAMS = ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'guidance', 'batch_size'];

/**
 * 从图里收集可调参数。默认值取工作流当前写死的那个值，
 * 枚举的候选来自 object_info，方便对话模型知道能填什么。
 */
export function collectParams(graph, mapping, objectInfo) {
  const owned = new Set();
  for (const key of MAPPING_KEYS) {
    const target = mapping && mapping[key];
    if (target) owned.add(target.node + '::' + target.input);
  }
  const found = new Map();
  for (const id of Object.keys(graph).sort()) {
    const node = graph[id];
    const schema = objectInfo ? objectInfo[node.class_type] : null;
    if (!schema) continue;
    const required = (schema.input && schema.input.required) || {};
    const optional = (schema.input && schema.input.optional) || {};
    for (const [name, value] of inputEntries(node)) {
      if (!TUNABLE_PARAMS.includes(name)) continue;
      if (owned.has(id + '::' + name)) continue;
      if (isLink(value)) continue;
      if (found.has(name)) continue;
      const spec = required[name] || optional[name] || [];
      const options = Array.isArray(spec[0]) ? spec[0].map(String) : null;
      found.set(name, {
        name,
        node: id,
        input: name,
        type: options ? 'enum' : String(spec[0] || typeof value),
        ...(options ? { options } : {})
      });
    }
  }
  return TUNABLE_PARAMS.filter((name) => found.has(name)).map((name) => found.get(name));
}

/**
 * 提示词与负面词不是「可调参数」：它们由工具调用自己的 prompt/negative_prompt
 * 经映射直接写进工作流，始终生效，也不该出现在给模型看的 params 里。
 */
export const PROMPT_ROLE_NAMES = new Set(['prompt', 'negative_prompt']);

const MANAGED_WORKFLOW_ROLES = ['prompt', 'negative_prompt', 'width', 'height', 'quality', 'image'];
const SELECTOR_INPUTS = /^(prompt|positive_prompt|positivePrompt|negative_prompt|negativePrompt|width|height)$/i;

/** 核心参数既可按名称识别，也可能在旧配置里以其他名称绑定同一输入。 */
export function isManagedWorkflowInput(row, mapping) {
  return SELECTOR_INPUTS.test(row?.name) || SELECTOR_INPUTS.test(row?.input)
    || MANAGED_WORKFLOW_ROLES.some((role) => {
      const target = mapping?.[role];
      return target && String(target.node) === String(row?.node) && target.input === row?.input;
    });
}

/**
 * 只有种子和模型作为额外的参数行。
 * 它们在工作流里已经有确定位置，和可调参数放进同一张表，但默认只有能调的那几项需要显式打开。
 * 类型来自 object_info；值是连线时按输入名推断，避免把 ["19",0] 当成字符串。
 */
export function collectRoleParams(graph, mapping, objectInfo) {
  const out = [];
  for (const key of ['seed', 'model']) {
    const target = mapping && mapping[key];
    if (!target) continue;
    const node = graph[target.node];
    if (!node) continue;
    const value = node.inputs ? node.inputs[target.input] : undefined;
    const schema = objectInfo ? objectInfo[node.class_type] : null;
    const spec = schema && schema.input
      ? ((schema.input.required && schema.input.required[target.input])
        || (schema.input.optional && schema.input.optional[target.input]))
      : null;
    let type = 'STRING';
    if (Array.isArray(spec) && spec.length) {
      type = Array.isArray(spec[0]) ? 'enum' : String(spec[0]);
    } else if (isLink(value)) {
      type = key === 'seed' ? 'INT' : 'STRING';
    } else if (typeof value === 'number') {
      type = 'INT';
    }
    out.push({
      name: key,
      role: true,
      node: target.node,
      input: target.input,
      type
    });
  }
  return out;
}

/* ---------------------------------------------------------- 参数候选 */

/**
 * 一行参数的类型推断：只看当前的原始值。
 *
 * API 格式的工作流里没有 widget 元数据（枚举清单、INT/FLOAT 之分都丢了），所以
 * 只能按值来判。判不准时一律按文本处理——文本在注入时会原样写回，不会把数字变成字符串。
 */
export function inferInputType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'text';
  return 'text';
}

/** 节点 id 的自然序：`9` 排在 `10` 前面，`18:2` 排在 `18:10` 前面。 */
function compareNodeIds(a, b) {
  const left = String(a).split(/(\d+)/);
  const right = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] === right[i]) continue;
    const l = /^\d+$/.test(left[i]) ? Number(left[i]) : left[i];
    const r = /^\d+$/.test(right[i]) ? Number(right[i]) : right[i];
    if (typeof l === 'number' && typeof r === 'number') return l - r;
    return String(l) < String(r) ? -1 : 1;
  }
  return left.length - right.length;
}

/** 候选里的「当前值」：对象（少见）序列化成一行 JSON，其余原样。 */
function scalarOf(value) {
  if (value === null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_error) { return ''; }
  }
  return value;
}

/**
 * 把整张图里「输入是原始值」的项摊成可勾选候选。
 *
 * 连线（`["18:7", 0]`）不算：那是别的节点的输出，写进去会被 ComfyUI 当成坏连线。
 * 每一项的形状就是离散参数表要的那一行（node / input / type / default / name），
 * 勾中后直接进 `modelOptions[m].params`。
 */
export function listWorkflowInputs(graph, objectInfo = {}) {
  const outputIds = findOutputNodes(graph, objectInfo);
  const { mapping } = workflowBindings(graph, objectInfo, outputIds);
  mapping.image = uniqueReference(referenceInputs(graph, objectInfo, outputIds));
  const outputSet = new Set(outputIds);
  const out = [];
  for (const id of Object.keys(graph || {}).sort(compareNodeIds)) {
    const node = graph[id];
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    const classType = String(node.class_type || '');
    for (const [input, value] of inputEntries(node).slice().sort(([a], [b]) => a.localeCompare(b))) {
      if (isLink(value)) continue;
      if (value === undefined) continue;
      if (isManagedWorkflowInput({ node: id, input }, mapping)) continue;
      if (typeof value === 'string' && value.includes('{{') && [...workflowPlaceholders(value)].some((name) =>
        MANAGED_WORKFLOW_ROLES.includes(name) || isWorkflowImagePlaceholder(name))) continue;
      // API 导出没有枚举元数据。把可能由选择器接管的档位留给完整的工作流解析。
      if (!objectInfo[classType] && !outputSet.has(id) && typeof value === 'string' && QUALITYISH.test(input)) continue;
      const raw = scalarOf(value);
      out.push({
        node: id,
        input: input,
        name: input,
        classType: classType,
        type: inferInputType(value),
        value: raw,
        display: summarize(raw)
      });
    }
  }
  return out;
}

/** 同名输入的其它位置，给面板下拉用：多个采样器时可以换一个绑。 */
function paramCandidates(graph, name) {
  const out = [];
  for (const id of Object.keys(graph).sort()) {
    for (const [input, value] of inputEntries(graph[id])) {
      if (input !== name) continue;
      if (isLink(value)) continue;
      out.push({ node: id, input });
    }
  }
  return out;
}

function coerceParam(value, param, previous) {
  if (param.type === 'enum') {
    const text = String(value);
    return Array.isArray(param.options) && param.options.length && !param.options.includes(text) ? null : text;
  }
  if (typeof previous === 'number') {
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(number) ? number : null;
  }
  if (typeof previous === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (text === 'true' || text === 'false') return text === 'true';
    return null;
  }
  return String(value);
}

/**
 * 把参数行写进图。两层：先写行里的默认值（设置页里可改，清空 = 不碰工作流里的原值），
 * 再写这次调用显式传的值。
 *
 * 不认识的键、解析不了的值都退回原值并报告，让工具能告诉模型「这个参数被忽略了」。
 * 默认值写进去的那些不算 applied——它们不是这次调用点名要的。
 */
export function applyWorkflowParams(graph, params, overrides) {
  const list = Array.isArray(params) ? params : [];
  const byName = new Map(list.map((param) => [param.name, param]));
  const applied = [];
  const ignored = [];
  const asked = overrides && typeof overrides === 'object' ? overrides : null;
  for (const param of list) {
    if (!param || !param.node || !param.input) continue;
    const fallback = param.default;
    if (fallback === undefined || fallback === null || String(fallback).trim() === '') continue;
    if (asked && Object.prototype.hasOwnProperty.call(asked, param.name)) continue;
    const node = graph[param.node];
    if (!node) continue;
    node.inputs = node.inputs || {};
    const next = coerceParam(fallback, param, node.inputs[param.input]);
    if (next === null) continue;
    node.inputs[param.input] = next;
  }
  for (const [name, raw] of Object.entries(asked || {})) {
    const param = byName.get(name);
    if (!param) { ignored.push(name); continue; }
    const node = graph[param.node];
    if (!node) { ignored.push(name); continue; }
    node.inputs = node.inputs || {};
    const next = coerceParam(raw, param, node.inputs[param.input]);
    if (next === null) { ignored.push(name); continue; }
    node.inputs[param.input] = next;
    applied.push(name);
  }
  return { graph, applied, ignored };
}
