/**
 * ComfyUI 工作流解析：把用户贴进来的任何一种工作流，变成「参数该写进哪个节点」的映射。
 *
 * 纯函数，不碰网络和文件：/object_info 由调用方取好传进来。
 * 这里做的判断都会摆到设置页让用户确认，所以宁可给出候选，也不要做"聪明"的静默回退。
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

function linkTarget(link) {
  if (Array.isArray(link)) return { from: String(link[1]), fromSlot: Number(link[2]) };
  if (link && typeof link === 'object') {
    return { from: String(link.origin_id), fromSlot: Number(link.origin_slot) };
  }
  return null;
}

function linkResolution(link) {
  if (Array.isArray(link)) return { target: String(link[3]), type: String(link[5] || '') };
  return { target: String(link.target_id), type: String(link.type || '') };
}

/** UI 格式 → API 格式。widgets_values 按 object_info 的输入顺序对齐。 */
export function uiToApi(ui, objectInfo) {
  const warnings = [];
  const links = new Map();
  for (const link of ui.links || []) {
    const linkId = Array.isArray(link) ? link[0] : link && link.id;
    const source = linkTarget(link);
    const resolved = linkResolution(link);
    if (linkId === undefined || !source || !resolved) continue;
    links.set(linkId, { from: source.from, fromSlot: source.fromSlot, target: resolved.target });
  }

  const graph = {};
  for (const node of ui.nodes || []) {
    const type = node && node.type;
    const schema = type ? objectInfo[type] : undefined;
    if (!schema) {
      if (type) warnings.push('工作流里的节点 ' + type + ' 没有安装，涉及它的连线会被忽略');
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
    const names = [...required, ...optional];
    const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
    let cursor = 0;
    for (const name of names) {
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
  return { graph, warnings };
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

/** 找出所有输出节点（object_info 里 output_node === true）。 */
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

/** 从输出节点反向 BFS，按距离找出所有采样器。 */
function findSamplers(graph, objectInfo, outputIds) {
  const found = [];
  const seen = new Set(outputIds);
  let frontier = outputIds.map((id) => ({ id, depth: 0 }));
  while (frontier.length) {
    const next = [];
    for (const item of frontier) {
      const node = graph[item.id];
      if (!node) continue;
      const entries = inputEntries(node);
      const hasLatent = entries.some(([name]) => name === 'latent_image');
      const types = outputTypes(node, objectInfo);
      const looksSampler = hasLatent && (types.includes('LATENT') || !types.length);
      if (looksSampler && item.depth > 0) found.push({ id: item.id, depth: item.depth });
      for (const [, value] of entries) {
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

/** 从某个输入出发，按优先级向上找字面量字符串输入；沿途收集候选。 */
function walkText(graph, startLink, objectInfo, pool) {
  const visited = new Set();
  let primary = null;

  const visit = (link) => {
    if (!isLink(link)) return;
    const id = String(link[0]);
    if (visited.has(id)) return;
    visited.add(id);
    const node = graph[id];
    if (!node) return;
    const entries = inputEntries(node);
    const ordered = [...entries].sort(([a], [b]) => rank(a) - rank(b));
    for (const [name, value] of ordered) {
      if (typeof value === 'string' && value.trim() !== '') {
        pool.push(makeCandidate(id, node, name, value));
        if (!primary && TEXTISH.test(name)) primary = { node: id, input: name };
      }
    }
    for (const [name, value] of ordered) {
      if (!isLink(value)) continue;
      if (name === 'clip' || name === 'model' || name === 'vae') continue;
      visit(value);
    }
  };

  const rank = (name) => (TEXTISH.test(name) ? 0 : name === 'system_prompt' ? 2 : 1);
  visit(startLink);
  if (!primary && pool.length) primary = { node: pool[0].node, input: pool[0].input };
  return primary;
}

/** 沿某个输入向上找第一个满足条件的节点。 */
function findUpstream(graph, link, predicate) {
  const visited = new Set();
  let cursor = link;
  while (isLink(cursor)) {
    const id = String(cursor[0]);
    if (visited.has(id)) return null;
    visited.add(id);
    const node = graph[id];
    if (!node) return null;
    const hit = predicate(id, node);
    if (hit) return hit;
    const next = inputEntries(node).find(([, value]) => isLink(value));
    cursor = next ? next[1] : null;
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
  const sampler = samplerId ? graph[samplerId] : null;

  const promptPool = [];
  const negativePool = [];
  const mapping = { prompt: null, negative_prompt: null, width: null, height: null, seed: null, model: null, image: null };

  if (sampler) {
    mapping.prompt = walkText(graph, sampler.inputs.positive, objectInfo, promptPool);
    mapping.negative_prompt = walkText(graph, sampler.inputs.negative, objectInfo, negativePool);

    const latent = isLink(sampler.inputs.latent_image) ? String(sampler.inputs.latent_image[0]) : null;
    const latentNode = latent ? graph[latent] : null;
    if (latentNode) {
      for (const [name] of inputEntries(latentNode)) {
        if (name === 'width') mapping.width = { node: latent, input: 'width' };
        if (name === 'height') mapping.height = { node: latent, input: 'height' };
      }
    }
    for (const [name] of inputEntries(sampler)) {
      if (SEEDISH.test(name)) mapping.seed = { node: samplerId, input: name };
    }
    mapping.model = findUpstream(graph, sampler.inputs.model, (id, node) => {
      const hit = inputEntries(node).find(([name, value]) => MODELISH.test(name) && !isLink(value));
      return hit ? { node: id, input: hit[0] } : null;
    });
  }

  const imageNode = Object.keys(graph).filter((id) => graph[id].class_type === 'LoadImage').sort()[0];
  if (imageNode) mapping.image = { node: imageNode, input: 'image' };

  const candidates = {
    prompt: promptPool,
    negative_prompt: negativePool,
    width: collectInputs(graph, 'width', objectInfo),
    height: collectInputs(graph, 'height', objectInfo),
    seed: collectInputs(graph, SEEDISH, objectInfo),
    model: collectInputs(graph, MODELISH, objectInfo),
    image: Object.keys(graph).filter((id) => graph[id].class_type === 'LoadImage').sort()
      .map((id) => makeCandidate(id, graph[id], 'image', graph[id].inputs.image)),
    sampler: samplers.map((id) => makeCandidate(id, graph[id], 'latent_image', id))
  };

  return { mapping, candidates, warnings, samplerId, outputIds };
}

function collectInputs(graph, matcher, objectInfo) {
  const out = [];
  const test = typeof matcher === 'string' ? (name) => name === matcher : (name) => matcher.test(name);
  for (const id of Object.keys(graph).sort()) {
    const node = graph[id];
    for (const [name, value] of inputEntries(node)) {
      if (!test(name)) continue;
      if (isLink(value) && matcher !== 'width' && matcher !== 'height') continue;
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
    const source = VALUE_KEYS[key];
    const value = values ? values[source] : undefined;
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
