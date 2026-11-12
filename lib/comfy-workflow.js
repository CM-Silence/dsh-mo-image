/**
 * ComfyUI 工作流解析：把用户贴进来的任何一种工作流，变成「参数该写进哪个节点」的映射。
 *
 * 纯函数，不碰网络和文件：/object_info 由调用方取好传进来。
 * 这里做的判断都会摆到设置页让用户确认，所以宁可给出候选，也不要做"聪明"的静默回退。
 *
 * 定位策略：先找到主采样器，再把**它整条上游闭包**摊开，按角色（positive/negative）、
 * 名字（seed/ckpt_name）和类型去匹配。不逐输入查表——FLUX.2 的 SamplerCustomAdvanced
 * 自己没有 positive/seed/model，这些散落在 CFGGuider 和 RandomNoise 上。
 */

export const MAPPING_KEYS = ['prompt', 'negative_prompt', 'width', 'height', 'seed', 'model', 'image'];

/** 输入名优先级：先认这些名字，再退而求其次找其它字符串输入。 */
const TEXTISH = /^(text|prompt|string|value|positive)$/i;
const SEEDISH = /^(seed|noise_seed)$/i;
const MODELISH = /^(ckpt_name|unet_name|model_name)$/i;
/** UI 格式里，种子后面那个「fixed/randomize」下拉不是节点输入，但占了一个 widgets_values 位。 */
const PHANTOM_WIDGETS = new Set(['fixed', 'increment', 'decrement', 'randomize']);

const SUMMARY_MAX = 80;

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
      const spec = (schema.input.required && schema.input.required[name]) || (schema.input.optional && schema.input.optional[name]) || [];
      if (spec[1] && typeof spec[1] === 'object' && spec[1].forceInput) continue;
      if (linked.has(name)) { inputs[name] = linked.get(name); continue; }
      if (cursor >= widgets.length) continue;
      inputs[name] = widgets[cursor];
      cursor += 1;
      if (SEEDISH.test(name) && typeof widgets[cursor] === 'string' && PHANTOM_WIDGETS.has(widgets[cursor])) cursor += 1;
    }
    graph[id] = { class_type: type, inputs };
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
    const schema = objectInfo[graph[id].class_type];
    return !!(schema && schema.output_node);
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

/** 主采样器的整条上游闭包：id → 距采样器的层数。 */
function upstreamClosure(graph, samplerId) {
  const depth = new Map([[samplerId, 0]]);
  let frontier = [samplerId];
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
function findRoleLink(graph, closure, samplerId, role) {
  const sampler = graph[samplerId];
  if (sampler && isLink(sampler.inputs && sampler.inputs[role])) return sampler.inputs[role];
  const ids = [...closure.keys()].filter((id) => id !== samplerId)
    .sort((a, b) => closure.get(a) - closure.get(b) || a.localeCompare(b));
  for (const id of ids) {
    const hit = inputEntries(graph[id]).find(([name, value]) => name === role && isLink(value));
    if (hit) return hit[1];
  }
  return null;
}

/** 从某个输入出发，按优先级向上找字面量字符串输入；沿途收集候选。 */
function walkText(graph, startLink, pool) {
  const visited = new Set();
  let primary = null;

  const rank = (name) => (TEXTISH.test(name) ? 0 : name === 'system_prompt' ? 2 : 1);
  const visit = (link) => {
    if (!isLink(link)) return;
    const id = String(link[0]);
    if (visited.has(id)) return;
    visited.add(id);
    const node = graph[id];
    if (!node) return;
    const ordered = [...inputEntries(node)].sort(([a], [b]) => rank(a) - rank(b));
    for (const [name, value] of ordered) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      pool.push(makeCandidate(id, node, name, value));
      if (!primary && TEXTISH.test(name)) primary = { node: id, input: name };
    }
    for (const [name, value] of ordered) {
      if (!isLink(value)) continue;
      if (name === 'clip' || name === 'model' || name === 'vae') continue;
      visit(value);
    }
  };
  visit(startLink);
  if (!primary && pool.length) primary = { node: pool[0].node, input: pool[0].input };
  return primary;
}

/** 在上游闭包里按名字找某个输入，最近的优先。 */
function findInClosure(graph, closure, samplerId, matcher, { literalOnly = false } = {}) {
  const ids = [...closure.keys()].sort((a, b) => closure.get(a) - closure.get(b) || a.localeCompare(b));
  for (const id of ids) {
    for (const [name, value] of inputEntries(graph[id]).sort(([a], [b]) => a.localeCompare(b))) {
      if (!matcher.test(name)) continue;
      if (literalOnly && isLink(value)) continue;
      return { node: id, input: name };
    }
  }
  return null;
}

/**
 * 分析整张图。返回的 mapping 里每一项要么是 {node, input}，要么是 null。
 * @throws 图里没有输出节点时抛错——ComfyUI 会直接拒绝执行这种图。
 */
export function analyzeWorkflow(graph, objectInfo) {
  const warnings = [];
  const outputIds = findOutputNodes(graph, objectInfo);
  if (!outputIds.length) throw new Error('这个工作流没有输出节点，ComfyUI 不会执行它。');

  const samplers = findSamplers(graph, objectInfo, outputIds);
  const samplerId = samplers.length ? samplers[0] : null;
  if (!samplerId) warnings.push('没有找到采样器，提示词和尺寸需要手动指定');

  const mapping = { prompt: null, negative_prompt: null, width: null, height: null, seed: null, model: null, image: null };
  const promptPool = [];
  const negativePool = [];

  if (samplerId) {
    const closure = upstreamClosure(graph, samplerId);
    mapping.prompt = walkText(graph, findRoleLink(graph, closure, samplerId, 'positive'), promptPool);
    mapping.negative_prompt = walkText(graph, findRoleLink(graph, closure, samplerId, 'negative'), negativePool);
    if (mapping.prompt && mapping.negative_prompt
      && mapping.prompt.node === mapping.negative_prompt.node
      && mapping.prompt.input === mapping.negative_prompt.input) {
      mapping.negative_prompt = null;
    }
    mapping.seed = findInClosure(graph, closure, samplerId, SEEDISH);
    mapping.model = findInClosure(graph, closure, samplerId, MODELISH, { literalOnly: true });
    mapping.width = findInClosure(graph, closure, samplerId, /^width$/);
    mapping.height = findInClosure(graph, closure, samplerId, /^height$/);
  }

  const imageNode = Object.keys(graph).filter((id) => graph[id].class_type === 'LoadImage').sort()[0];
  if (imageNode) mapping.image = { node: imageNode, input: 'image' };

  const candidates = {
    prompt: promptPool,
    negative_prompt: negativePool,
    width: collectInputs(graph, /^width$/),
    height: collectInputs(graph, /^height$/),
    seed: collectInputs(graph, SEEDISH),
    model: collectInputs(graph, MODELISH),
    image: Object.keys(graph).filter((id) => graph[id].class_type === 'LoadImage').sort()
      .map((id) => makeCandidate(id, graph[id], 'image', graph[id].inputs.image)),
    sampler: samplers.map((id) => makeCandidate(id, graph[id], 'latent_image', id))
  };

  return {
    mapping, candidates, warnings, samplerId, outputIds,
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

/** 默认对对话模型可见的参数：提示词、负面词和尺寸。种子和模型保持隐藏。 */
export const DEFAULT_EXPOSED = new Set(['prompt', 'negative_prompt', 'width', 'height']);

/**
 * 映射角色也当成参数：提示词、负面词、宽高、种子、模型。
 * 它们在工作流里已经有确定位置，和可调参数放进同一张表，但默认只有前四个暴露。
 * 类型来自 object_info；值是连线时按输入名推断，避免把 ["19",0] 当成字符串。
 */
export function collectRoleParams(graph, mapping, objectInfo) {
  const out = [];
  for (const key of ['prompt', 'negative_prompt', 'width', 'height', 'seed', 'model']) {
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
      type = key === 'width' || key === 'height' || key === 'seed' ? 'INT' : 'STRING';
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
 * 把对话模型传来的参数写进图。不认识的键、解析不了的值都退回默认值并报告，
 * 让工具能告诉模型「这个参数被忽略了」。
 */
export function applyWorkflowParams(graph, params, overrides) {
  const byName = new Map((Array.isArray(params) ? params : []).map((param) => [param.name, param]));
  const applied = [];
  const ignored = [];
  for (const [name, raw] of Object.entries(overrides || {})) {
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
