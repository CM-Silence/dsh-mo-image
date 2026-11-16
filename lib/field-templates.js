/**
 * 字段模板：把逻辑字段（prompt / negative / model / n / image）写进请求体的哪里。
 *
 * 协议只认识地址与传输形态；「这家网关把提示词叫什么、参考图怎么放」归预设与模型规则，
 * 都写成这里的模板。能力封顶六种「写哪儿」，外加一个与位置无关的 as 编码形态；
 * 多一种都不加——表达不了的网关单独做预设/协议，不往这一层加特性（红线见设计文档）：
 *
 *   { path: 'prompt' }                                   扁平；a.b.c 是嵌套
 *   { path: 'x[0].y[]' }                                 路径以 [] 结尾 = 追加到该数组末尾
 *   { path: 'x[]', wrap: 'text' }                        追加的是 { text: 值 } 这种包装对象
 *   { inPrompt: true } / { appendToPrompt: '\n\nAvoid: ' }  不写 body，拼进提示词文本
 *   { numbered: 'input_image' }                          数组逐个展开 input_image / input_image_2 …
 *   { multipart: 'image[]' }                             走 FormData 的字段名（配 multipartFields）
 *   { path: 'image', as: 'dataUrl' | 'base64' | 'url' }  as 修的是编码形态，不是第七种位置
 *
 * 三层合并顺序：用户覆盖 > 模型规则 > 预设；三层都没有 = 不发这个字段。
 * 整条模板写 `null` 或 `false` = **显式不发**：它会原样留在合并结果里（`'image' in fields`
 * 仍为真），后面的层不许把它盖掉，写 body 时跳过。
 *
 * 两个出口分开：applyFields 只写 JSON body，promptParts 只算提示词文本。模板形状认不出来
 * 一律抛错，而且校验在写入之前整批做完——宁可在配置时就炸，也不要静默写错位置或留下半个 body。
 */

/** inPrompt 的默认粘合符：追加到提示词末尾时用换行隔开。 */
const PROMPT_GLUE = '\n';

const ENCODINGS = new Set(['dataUrl', 'base64', 'url']);

/** 每种形状允许出现的键；多出来的键一律当成「无法识别的形状」。 */
const SHAPES = {
  path: ['path', 'as'],
  append: ['path', 'wrap', 'as'],
  prompt: ['inPrompt'],
  appendPrompt: ['appendToPrompt'],
  numbered: ['numbered', 'as'],
  multipart: ['multipart']
};

/** 合并顺序，前面的压过后面的。 */
const LAYERS = ['override', 'rule', 'preset'];

/** 逻辑字段里唯一可能是「一组图」的那个：multipartFields 的 images 参数只喂给它。 */
const IMAGE_FIELD = 'image';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(message) {
  throw new Error('字段模板：' + message);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 图片对象是 { buffer, contentType }；裸 Buffer 自带 .buffer（ArrayBuffer 池），不能算图片。 */
function isImage(value) {
  return isPlainObject(value) && value.buffer != null && !Buffer.isBuffer(value);
}

/** undefined / null / false 都是「不发这个字段」。 */
function isAbsent(value) {
  return value === undefined || value === null || value === false;
}

function bufferOf(image) {
  return Buffer.isBuffer(image.buffer) ? image.buffer : Buffer.from(image.buffer);
}

/* ------------------------------------------------------------ 路径解析 */

/**
 * 把 'input.messages[0].content[]' 拆成步骤：{ key } / { index }。
 * `[]` 只允许出现在末尾，表示「追加到这个数组」。
 */
function parsePath(field, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(field + ' 的 path 必须是非空字符串');
  }
  const steps = [];
  let append = false;
  const parts = raw.split('.');
  parts.forEach((part, partIndex) => {
    const match = /^([^.[\]]+)((?:\[\d+\]|\[\])*)$/.exec(part);
    if (!match) fail(field + ' 的 path 无法识别：' + raw);
    steps.push({ key: match[1] });
    const tails = Array.from(match[2].matchAll(/\[(\d*)\]/g), (item) => item[1]);
    tails.forEach((tail, tailIndex) => {
      if (tail !== '') {
        steps.push({ index: Number(tail) });
        return;
      }
      const atEnd = partIndex === parts.length - 1 && tailIndex === tails.length - 1;
      if (!atEnd) fail(field + ' 的 path 只有末尾才能用 []：' + raw);
      append = true;
    });
  });
  return { steps, append };
}

/* ---------------------------------------------------------- 模板编译 */

function checkShape(field, spec, kind) {
  const allowed = SHAPES[kind];
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      fail(field + ' 的模板有无法识别的键 ' + JSON.stringify(key) + '：' + JSON.stringify(spec));
    }
  }
}

function encodingOf(field, spec) {
  if (!('as' in spec)) return null;
  if (!ENCODINGS.has(spec.as)) {
    fail(field + ' 的 as 只能是 dataUrl / base64 / url，收到 ' + JSON.stringify(spec.as));
  }
  return spec.as;
}

function nameOf(field, key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(field + ' 的 ' + key + ' 必须是非空字符串');
  }
  return value;
}

function otherKind(field, spec) {
  if ('inPrompt' in spec) {
    if (spec.inPrompt !== true) fail(field + ' 的 inPrompt 只能是 true');
    return 'prompt';
  }
  if ('appendToPrompt' in spec) {
    if (typeof spec.appendToPrompt !== 'string') {
      fail(field + ' 的 appendToPrompt 必须是字符串');
    }
    return 'appendPrompt';
  }
  if ('numbered' in spec) return 'numbered';
  if ('multipart' in spec) return 'multipart';
  return fail(field + ' 的模板没有可识别的形状：' + JSON.stringify(spec));
}

function compileSpec(field, spec) {
  if (!isPlainObject(spec)) {
    fail(field + ' 的模板必须是对象（要「不发」请写 null 或 false），收到 ' + typeof spec);
  }
  const parsed = 'path' in spec ? parsePath(field, spec.path) : null;
  const kind = parsed ? (parsed.append ? 'append' : 'path') : otherKind(field, spec);
  checkShape(field, spec, kind);
  const as = encodingOf(field, spec);

  if (parsed) {
    const descriptor = { field, kind, raw: spec.path, steps: parsed.steps, as };
    if (kind === 'append') {
      descriptor.wrap = hasOwn(spec, 'wrap') ? nameOf(field, 'wrap', spec.wrap) : null;
    }
    return descriptor;
  }
  if (kind === 'numbered') return { field, kind, name: nameOf(field, 'numbered', spec.numbered), as };
  if (kind === 'multipart') return { field, kind, name: nameOf(field, 'multipart', spec.multipart) };
  if (kind === 'appendPrompt') return { field, kind, prefix: spec.appendToPrompt };
  return { field, kind };
}

/** 整批编译：先全部校验完，再让调用方动手写（所以坏模板不会留下半个 body）。 */
function compileFields(fields) {
  if (fields === undefined || fields === null) return [];
  if (!isPlainObject(fields)) fail('fields 必须是对象，收到 ' + typeof fields);
  const descriptors = [];
  for (const [field, spec] of Object.entries(fields)) {
    if (spec === null || spec === false) continue; // 显式不发，连形状都不用认
    descriptors.push(compileSpec(field, spec));
  }
  return descriptors;
}

/* ------------------------------------------------------------ 值编码 */

function encode(value, as) {
  if (as === null) return value;
  if (as === 'url') return value; // 原样透传（参考图本来就是 URL）
  if (as === 'base64') {
    if (isImage(value)) return bufferOf(value).toString('base64');
    if (Buffer.isBuffer(value)) return value.toString('base64');
    return String(value);
  }
  if (isImage(value)) {
    return 'data:' + (value.contentType || 'image/png') + ';base64,' + bufferOf(value).toString('base64');
  }
  return String(value);
}

function listOf(value) {
  if (Array.isArray(value)) return value.filter((item) => !isAbsent(item));
  return [value];
}

/* --------------------------------------------------------- body 写入 */

function assertContainer(node, label) {
  if (!isPlainObject(node) && !Array.isArray(node)) {
    fail('路径 ' + label + ' 与已有的 body 结构冲突（中间是 ' + typeof node + '）');
  }
}

function readChild(node, step, label) {
  assertContainer(node, label);
  if (step.index !== undefined) {
    if (!Array.isArray(node)) fail('路径 ' + label + ' 的 [' + step.index + '] 遇到非数组容器');
    return node[step.index];
  }
  if (Array.isArray(node)) fail('路径 ' + label + ' 的 ' + step.key + ' 遇到数组容器');
  return node[step.key];
}

function writeChild(node, step, value, label) {
  assertContainer(node, label);
  if (step.index !== undefined) {
    if (!Array.isArray(node)) fail('路径 ' + label + ' 的 [' + step.index + '] 遇到非数组容器');
    node[step.index] = value;
    return;
  }
  if (Array.isArray(node)) fail('路径 ' + label + ' 的 ' + step.key + ' 遇到数组容器');
  node[step.key] = value;
}

/** 走到最后一步的持有者，沿途按下一步是下标还是键把中间容器建出来。 */
function walk(root, steps, label) {
  let node = root;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (index === steps.length - 1) return { node, step };
    let child = readChild(node, step, label);
    if (child === undefined || child === null) {
      child = steps[index + 1].index !== undefined ? [] : {};
      writeChild(node, step, child, label);
    }
    node = child;
  }
  return fail('path 不能为空');
}

function writeAt(body, descriptor, value) {
  const { node, step } = walk(body, descriptor.steps, descriptor.raw);
  writeChild(node, step, value, descriptor.raw);
}

function appendAt(body, descriptor, value) {
  const { node, step } = walk(body, descriptor.steps, descriptor.raw);
  let list = readChild(node, step, descriptor.raw);
  if (list === undefined || list === null) {
    list = [];
    writeChild(node, step, list, descriptor.raw);
  } else if (!Array.isArray(list)) {
    fail(descriptor.field + ' 的路径 ' + descriptor.raw + ' 不是数组，无法追加');
  }
  list.push(value);
}

/* --------------------------------------------------------------- API */

/**
 * 把一组逻辑字段按模板写进 body（就地修改）。
 * @param {object} body 目标请求体
 * @param {object} fields 字段 → 模板（resolveFields 的结果，可含 null/false）
 * @param {object} values 逻辑字段值 { prompt, negative, model, n, image }，image 单张或数组
 * @returns {object} 同一个 body
 */
export function applyFields(body, fields, values) {
  if (!isPlainObject(body)) fail('body 必须是对象');
  const descriptors = compileFields(fields);
  const source = isPlainObject(values) ? values : {};
  for (const descriptor of descriptors) {
    const value = source[descriptor.field];
    if (isAbsent(value)) continue;
    if (descriptor.kind === 'path') {
      const items = listOf(value).map((item) => encode(item, descriptor.as));
      if (items.length === 1) writeAt(body, descriptor, items[0]);
      else if (items.length > 1) writeAt(body, descriptor, items);
      continue;
    }
    if (descriptor.kind === 'append') {
      for (const item of listOf(value)) {
        const encoded = encode(item, descriptor.as);
        appendAt(body, descriptor, descriptor.wrap ? { [descriptor.wrap]: encoded } : encoded);
      }
      continue;
    }
    if (descriptor.kind === 'numbered') {
      listOf(value).forEach((item, index) => {
        const key = index === 0 ? descriptor.name : descriptor.name + '_' + (index + 1);
        body[key] = encode(item, descriptor.as);
      });
    }
    // inPrompt / appendToPrompt / multipart 不写 body：分别交给 promptParts 与 multipartFields。
  }
  return body;
}

/**
 * 合并三层字段模板：用户覆盖 > 模型规则 > 预设。
 * 逐字段取第一个「有这个键」的层；整条为 null / false 的「显式不发」原样保留，
 * 后面两层不许盖掉它。
 * @param {{ override?: object, rule?: object, preset?: object }} layers
 * @returns {object} 合并后的 fields
 */
export function resolveFields(layers) {
  const input = isPlainObject(layers) ? layers : {};
  const merged = {};
  for (const name of LAYERS) {
    const layer = input[name];
    if (layer === undefined || layer === null) continue;
    if (!isPlainObject(layer)) fail(name + ' 层必须是对象，收到 ' + typeof layer);
    for (const [field, spec] of Object.entries(layer)) {
      if (hasOwn(merged, field)) continue; // 更高层已经定过（包括「不发」）
      if (spec !== null && spec !== false && !isPlainObject(spec)) {
        fail(name + '.' + field + ' 必须是模板对象或 null/false，收到 ' + typeof spec);
      }
      merged[field] = spec;
    }
  }
  return merged;
}

/**
 * 给 multipart 端点用：把 multipart 字段算成 [{ name, value }]，不写进 JSON body。
 * 图片条目多带一个 contentType（调用方据此造 Blob），其余是字符串化的标量。
 * @param {object} fields 字段 → 模板
 * @param {object} values 逻辑字段值
 * @param {object|object[]} [images] 图片列表；给了就以它为准（只喂给 image 字段）
 * @returns {Array<{ name: string, value: string|Buffer, contentType?: string }>}
 */
export function multipartFields(fields, values, images) {
  const descriptors = compileFields(fields);
  const source = isPlainObject(values) ? values : {};
  const entries = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'multipart') continue;
    const fromImages = descriptor.field === IMAGE_FIELD && images !== undefined;
    const raw = fromImages ? images : source[descriptor.field];
    if (isAbsent(raw)) continue;
    for (const item of listOf(raw)) {
      if (isImage(item)) {
        entries.push({
          name: descriptor.name,
          value: bufferOf(item),
          contentType: item.contentType || 'image/png'
        });
      } else {
        entries.push({ name: descriptor.name, value: String(item) });
      }
    }
  }
  return entries;
}

/**
 * 把 inPrompt / appendToPrompt 的字段算成提示词文本。
 * inPrompt 用 '\n' 粘合，appendToPrompt 用给定的前缀；返回的 prompt 已把它们接在
 * values.prompt 后面（prompt 缺省算空串）。
 * @param {object} fields 字段 → 模板
 * @param {object} values 逻辑字段值（可以有 prompt 之外的键，如 size）
 * @returns {{ prompt: string, parts: Array<{ field: string, text: string }> }}
 */
export function promptParts(fields, values) {
  const descriptors = compileFields(fields);
  const source = isPlainObject(values) ? values : {};
  const parts = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'prompt' && descriptor.kind !== 'appendPrompt') continue;
    const value = source[descriptor.field];
    if (isAbsent(value)) continue;
    const glue = descriptor.kind === 'appendPrompt' ? descriptor.prefix : PROMPT_GLUE;
    parts.push({ field: descriptor.field, text: glue + String(value) });
  }
  const base = isAbsent(source.prompt) ? '' : String(source.prompt);
  return { prompt: base + parts.map((part) => part.text).join(''), parts };
}
