/**
 * 异步队列型协议：BFL / fal.ai / Replicate / 魔搭 ModelScope。
 *
 * 这些平台的共同点是「提交 → 轮询 → 拿一个会过期的 URL」。职责已经按四件事拆开：
 *   - 请求侧（`build` / `submitPath` / `edit`）还在 `async` 描述符里；
 *   - 响应侧（轮询地址 / 状态词 / 结果图 / 轮询间隔）在 `output:{kind:'task'}` 里
 *     （lib/output-profiles.js）——描述符不碰请求、不产出 headers；
 *   - 轮询要带的头挂在适配器上（`taskPollHeaders`），凭据与跨源判定仍只有
 *     lib/request-auth.js 一份；
 *   - 拿到 URL 必须立刻下载，不能交给上层。
 */
import { requestProvider } from '../request-auth.js';
import {
  baseUrlOf, headersFor, credentialRef, authHeaders, joinEndpoint, readJsonResponse, dataUrlOf, nearestAspect
} from '../adapter-kit.js';
// 结果地址的凭据判定只有一份（request-auth.js）：轮询、via 的二次 GET、结果下载都走它。
import { applyFields, promptParts } from '../field-templates.js';
import { outputProfile } from '../output-profiles.js';

function hostOf(provider) {
  try { return new URL(baseUrlOf(provider)).hostname.toLowerCase(); } catch (_error) { return ''; }
}

/* --------------------------------------------------------------- 字段模板 */

/**
 * 字段名不在协议里：这四条 build 自己拼提交体，prepare* 那套模板不会流经它们
 * （adapters.js 的 ownsOwnBody() 让 composeBody 跳过模板），所以这里按**同一个实现**
 * 取模板（用户覆盖 > 模型规则 > 预设），再用 applyFields / promptParts 写进去。
 * 协议只决定「用哪条模板」和「什么时候写」——张数上限、FLUX 3 换成 images 数组这类
 * 条件分支仍在各自的 build 里（红线见设计文档「字段模板」）。
 *
 * 为什么用动态 import 而不是像 openai.js / cn.js 那样静态反向 import：adapters.js 在模块
 * 顶层就展开 `...ASYNC_ADAPTERS`，反向静态 import 会成环。那两条协议只在 execute() 里调用，
 * 现在能跑，但代价是它们**被当成入口模块 import 时立刻 TDZ 崩**
 * （`Cannot access 'OPENAI_ADAPTERS' before initialization`）。本文件被三个测试直接 import，
 * 不能把测试吊在 import 顺序上；动态取一次（缓存住）就没有这张图上的环。
 */
let adaptersModule = null;
function adapters() {
  if (!adaptersModule) adaptersModule = import('../adapters.js');
  return adaptersModule;
}

/**
 * 本条协议自己的描述符：fieldsFor() 要它来反查预设，而本模块清单里的那一份就是
 * resolveAdapter() 交给调用方的同一个对象。
 */
function asyncAdapterOf(adapterId) {
  return ASYNC_ADAPTERS.find((adapter) => adapter.id === adapterId) || null;
}

/** 三层字段模板，与通用路径同源（adapters.js 的 fieldsFor）。 */
async function fieldsOf(adapterId, provider, model) {
  const module = await adapters();
  return module.fieldsFor(asyncAdapterOf(adapterId), provider, model);
}

function promptTextOf(input) {
  return String((input && input.prompt) || '');
}

/** 空负面词算「不发」：拼进提示词的模板靠它保持老行为（trim 后为空就不加 Avoid）。 */
function negativeOf(input) {
  return String((input && input.negativePrompt) || '').trim() || undefined;
}

/**
 * 四个逻辑字段的值（参考图不在这里：每个协议的张数上限不同，由各自的 build 单独喂）。
 * 这四条协议的 maxN 都是 1，所以张数永远是 1；收不收由模板决定（预设里 bfl / replicate
 * 是 null，fal 才叫 num_images）。quality 也一样：四条预设都是 null，这里不给值。
 */
function fieldValuesOf(input) {
  return {
    prompt: promptTextOf(input),
    negative: negativeOf(input),
    model: String((input && input.model) || ''),
    n: 1
  };
}

/**
 * 提示词与负面词按模板落位：负面词可能是独立字段（魔搭的 negative_prompt），
 * 也可能是拼进提示词（BFL / fal / replicate 的 appendToPrompt）。
 * 落点由模板决定，这里只负责把「拼好的提示词」交回去。
 */
function writePrompt(body, fields, values) {
  const folded = promptParts(fields, values);
  applyFields(body, fields, Object.assign({}, values, { prompt: folded.prompt }));
  return body;
}

/* ------------------------------------------------------- 结果地址的凭据范围 */

/*
 * 结果地址不一定是「自己家」的接口：队列服务常常直接给一个对象存储/CDN 的
 * 预签名地址。预签名本来就带授权，不需要我们的 Key；反过来，把 Key 发给
 * 一个没见过的主机就是凭据泄漏。
 *
 * 判定**不在这里**：同源带、跨源默认不带、resultAuthOrigins 声明过的才带，
 * 这套规则只有一份，在 lib/request-auth.js 的 downloadRequestHeaders()。
 * 结果图字节同样只有 fetchResultImage() 一个入口。
 */

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

/**
 * 参考图字段由模板给（预设 / 规则里是 `{ numbered: 'input_image' }`，FLUX 3 是
 * `images[]`）；这里只决定「用哪条模板」和「最多几张」——张数上限是端点的规矩，
 * 不是字段名。
 */
async function bflBuild(input, provider) {
  const model = String(input.model || '');
  const images = imagesOf(input);
  const fields = await fieldsOf('bfl', provider, model);
  const body = writePrompt({}, fields, fieldValuesOf(input));
  const size = sizeOf(input) || { width: 1024, height: 1024 };

  // FLUX 3 只认 aspect_ratio / resolution / images，未知字段直接 422。
  if (/^flux-3/i.test(model)) {
    body.aspect_ratio = size.aspect || nearestAspect(size.width, size.height);
    if (size.tier) body.resolution = String(size.tier);
    if (images.length) applyFields(body, fields, { image: images.slice(0, 10) });
    return body;
  }

  // Kontext / Ultra 用 aspect_ratio，没有 width/height。
  if (/kontext|ultra/i.test(model)) {
    body.aspect_ratio = nearestAspect(size.width, size.height);
    body.output_format = 'png';
    if (images.length) applyFields(body, fields, { image: images.slice(0, 4) });
    return body;
  }

  body.width = size.width;
  body.height = size.height;
  body.output_format = 'png';
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') body.seed = input.seed;
  if (images.length) applyFields(body, fields, { image: images.slice(0, 8) });
  return body;
}

/* ------------------------------------------------------------------ fal */

function falModelPath(model) {
  return '/' + String(model || '').trim().replace(/^\/+/, '');
}

/**
 * fal 的参考图有两个端点：单图收 image_url、多图收 image_urls，混用会 422。
 * 「用哪一条」由张数决定，是条件不是字段名，所以预设把 image 留空、这里按张数选模板。
 */
const FAL_IMAGE_SINGLE = { path: 'image_url', as: 'dataUrl' };
const FAL_IMAGE_MULTI = { path: 'image_urls', as: 'dataUrl' };

async function falBuild(input, provider) {
  const fields = await fieldsOf('fal', provider, String(input.model || ''));
  const body = writePrompt({}, fields, fieldValuesOf(input));
  body.output_format = 'jpeg';
  const size = sizeOf(input);
  if (size) body.image_size = { width: size.width, height: size.height };
  const images = imagesOf(input);
  if (images.length) {
    const declared = fields.image;
    // 用户覆盖里写明了参考图模板就照它发；否则按张数在那两条候选模板里选一条。
    const template = declared && typeof declared === 'object'
      ? declared
      : (images.length === 1 ? FAL_IMAGE_SINGLE : FAL_IMAGE_MULTI);
    applyFields(body, { image: template }, { image: images });
  }
  return body;
}

/* -------------------------------------------------------------- Replicate */

const schemaCache = new Map();
/** 进行中的 schema 请求：同一模型的并发 build 只发一次，别让参考图和尺寸各查一遍。 */
const schemaInflight = new Map();
const SCHEMA_TTL = 10 * 60 * 1000;

/** 测试用：清掉模型 schema 缓存与进行中的请求占位。 */
export function resetAsyncSchemaCache() {
  schemaCache.clear();
  schemaInflight.clear();
}

function replicateName(model) {
  return String(model || '').trim().replace(/^\/+/, '');
}

const SCHEMA_CACHE_LIMIT = 100;


/** 读模型 Input schema；失败就返回 null，且不缓存失败（瞬时 503 不该让后面 10 分钟都退化）。 */
async function inputSchemaOf(provider, model, signal) {
  const name = replicateName(model);
  if (!name.includes('/')) return null;
  const key = baseUrlOf(provider) + '|' + name + '|' + credentialRef(provider);
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.at < SCHEMA_TTL) return cached.value;
  const pending = schemaInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    try {
      const response = await requestProvider(joinEndpoint(baseUrlOf(provider), '/models/' + name), {
        headers: headersFor(provider, false), signal: signal
      }, provider);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider);
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
  })();
  // 失败同样经过 finally：占位必须清掉，下一次 build 才能重新请求（失败不缓存）。
  let tracked;
  tracked = task.finally(() => {
    if (schemaInflight.get(key) === tracked) schemaInflight.delete(key);
  });
  schemaInflight.set(key, tracked);
  return tracked;
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
  const fields = await fieldsOf('replicate', provider, String(input.model || ''));
  const notes = [];
  // prompt 的落点由模板给（预设是 input.prompt）；提交体永远是 { input: {...} }。
  const body = writePrompt({}, fields, fieldValuesOf(input));
  const payload = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
    ? body.input
    : (body.input = {});

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

  const built = { body: body };
  if (notes.length) built.note = notes.join('；');
  return built;
}

/* ------------------------------------------------------------ ModelScope */

/** 魔搭的 OpenAI 兼容地址可能带 /v1，也可能只给站点根；统一到站点根再拼 /v1/...。 */
function modelscopeRoot(provider) {
  return baseUrlOf(provider).replace(/\/v1$/i, '');
}

async function modelscopeBuild(input, provider) {
  const fields = await fieldsOf('modelscope', provider, String(input.model || ''));
  // 魔搭原生支持 negative_prompt：模板把它写成独立字段（{ path: 'negative_prompt' }），
  // 不像不支持的平台那样拼进 prompt。
  const body = writePrompt({}, fields, fieldValuesOf(input));
  const size = sizeOf(input);
  if (size) body.size = size.width + 'x' + size.height;
  const images = imagesOf(input);
  // 图片字段是 image_url：模板的 path 语义正好是「一张发字符串、多张发数组」，网关吃 data URI。
  if (images.length) applyFields(body, fields, { image: images.slice(0, 10) });
  return body;
}

/* ----------------------------------------------------------------- 描述符 */

/**
 * fal 的 response_url 正常就是 queue.fal.run 上的接口地址（同源时不需要这里声明），
 * 结果图则落在 v3.fal.media 这类 CDN 上——那是预签名地址，不需要 Key。
 * 这里只列 fal 自家确实要凭据的跨源域名：把 baseUrl 配成 fal.run 时，
 * response_url 仍会落在 queue.fal.run，丢掉 Key 反而会让结果读不出来。
 */
const FAL_RESULT_AUTH_ORIGINS = ['https://queue.fal.run'];

export const ASYNC_ADAPTERS = [
  {
    id: 'bfl',
    acceptsHttpParams: true,
    label: 'protocol.bfl',
    match: (provider) => /(^|\.)bfl\.ai$/i.test(hostOf(provider)),
    authHeader: 'x-key',
    local: false,
    endpoints: { generate: '/v1', edit: '/v1' },
    routes: { generate: '/v1', edit: '/v1', models: '' },
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
      submitPath: (input) => '/' + String(input.model || '').trim().replace(/^\/+/, '')
    },
    // 轮询头在适配器侧（描述符里不许出现 headers）：BFL 默认用 x-key，不是 Bearer；
    // provider.auth 设了就按它来（鉴权是提供商字段，提交与轮询必须是同一套）。
    taskPollHeaders: (provider) => authHeaders(provider, { authHeader: 'x-key' }),
    // 输出格式描述符：轮询地址由提交响应直接给；状态词大写；结果在 result.sample。
    // 迁移前这三个函数在 async 描述符里（pollUrl / statusOf / resolve），字段值一字未改。
    output: outputProfile({
      kind: 'task',
      pollUrlPath: 'polling_url',
      statusPath: 'status',
      success: ['READY'],
      failure: ['ERROR', 'REQUEST MODERATED', 'CONTENT MODERATED', 'NO CARD GENERATED', 'TASK NOT FOUND'],
      // 失败文案来自 payload.detail（迁移前 resolve/statusOf 里就是这么取的）。
      failureMessagePath: ['detail'],
      resultPath: 'result.sample',
      intervalMs: 1000,
      // 没有读取方（超时统一由 TOTAL_BUDGET_MS 决定），保留原值，见计划 §7.3-11。
      timeoutMs: 300000,
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: 'BFL 任务完成了但没有返回图片'
    }, 'bfl')
  },
  {
    id: 'fal',
    acceptsHttpParams: true,
    label: 'protocol.fal',
    match: (provider) => /(^|\.)(queue\.)?fal(run)?\.(run|com)$/i.test(hostOf(provider)),
    authHeader: 'fal-key',
    local: false,
    // 跨源结果地址的白名单；via 的二次 GET 与结果下载都按同一个声明判断能不能带 Key。
    resultAuthOrigins: FAL_RESULT_AUTH_ORIGINS,
    endpoints: { generate: '/', edit: '/' },
    routes: { generate: '/', edit: '/', models: '' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const endpoint = /(^|\.)fal\.(run|ai)$/i.test(hostOf(provider))
        ? 'https://api.fal.ai/v1/models?category=text-to-image'
        : joinEndpoint(baseUrlOf(provider), '/models');
      const response = await requestProvider(endpoint, {
        headers: headersFor(provider, false, null, this), signal: signal
      }, provider, this);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider);
      return (payload && Array.isArray(payload.models) ? payload.models : [])
        .map((item) => String((item && item.endpoint_id) || '').trim())
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: falBuild,
      submitPath: (input) => falModelPath(input.model)
    },
    // 轮询头在适配器侧：fal 用 `Authorization: Key …`（描述符里不许出现 headers）。
    taskPollHeaders: (provider) => authHeaders(provider, { authHeader: 'fal-key' }),
    // 输出格式描述符：轮询地址在 status_url；结果不在轮询载荷里，要再 GET 一次
    // response_url（提交响应或轮询载荷给）。COMPLETED 却带 error 字段算失败。
    // 迁移前这段逻辑在 async.resolve()/statusOf() 里，URL 来源与判定顺序一字未改。
    output: outputProfile({
      kind: 'task',
      pollUrlPath: 'status_url',
      statusPath: 'status',
      success: ['COMPLETED'],
      // 空数组：迁移前的 statusOf 对 COMPLETED 以外的状态词一律当「还在跑」，
      // 失败信号只看 error 字段（errorPath）。加 'ERROR' 会是行为变更。
      failure: [],
      errorPath: 'error',
      resultPath: 'images.0.url',
      via: {
        kind: 'json-get',
        urlPath: ['submission.response_url', 'payload.response_url'],
        // 迁移前是 readJsonResponse(response, 64MB)；不写就会静默变成默认 10MB。
        maxBytes: 64 * 1024 * 1024
      },
      intervalMs: 1000,
      timeoutMs: 300000,
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: 'fal 没有返回图片'
    }, 'fal')
  },
  {
    id: 'replicate',
    acceptsHttpParams: true,
    label: 'protocol.replicate',
    match: (provider) => hostOf(provider) === 'api.replicate.com',
    authHeader: 'bearer',
    local: false,
    endpoints: { generate: '/', edit: '/' },
    routes: { generate: '/', edit: '/', models: '' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const response = await requestProvider(joinEndpoint(baseUrlOf(provider), '/models'), {
        headers: headersFor(provider, false), signal: signal
      }, provider, this);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider);
      return (payload && Array.isArray(payload.results) ? payload.results : [])
        .map((item) => (item && item.owner && item.name ? item.owner + '/' + item.name : ''))
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: replicateBuild,
      submitPath: (input) => '/models/' + replicateName(input.model) + '/predictions'
    },
    // 轮询头在适配器侧：Replicate 用 Bearer，GET 也带 Content-Type（迁移前就是这个形状）。
    taskPollHeaders: (provider) => headersFor(provider, false),
    // 输出格式描述符：轮询地址在提交响应的 urls.get 里；状态是小写词；结果是 output
    // （可能是字符串，也可能是数组，取第一个）。字段值照搬迁移前的 statusOf / resolve。
    output: outputProfile({
      kind: 'task',
      pollUrlPath: 'urls.get',
      statusPath: 'status',
      success: ['succeeded'],
      failure: ['failed', 'canceled', 'aborted'],
      failureMessagePath: ['error'],
      resultPath: 'output',
      intervalMs: 1000,
      timeoutMs: 300000,
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: 'Replicate 任务完成了但没有返回图片'
    }, 'replicate')
  },
  {
    id: 'modelscope',
    acceptsHttpParams: true,
    label: 'protocol.modelscope',
    match: (provider) => /(^|\.)api-inference\.modelscope\.(cn|ai)$/i.test(hostOf(provider)),
    authHeader: 'bearer',
    local: false,
    endpoints: { generate: '/v1/images/generations', edit: '/v1/images/generations' },
    routes: { generate: '/v1/images/generations', edit: '/v1/images/generations', models: '' },
    transport: { generate: 'json', edit: 'json' },
    // 图片生成是任务制：不带这个头拿不到 task_id。
    headers: { 'X-ModelScope-Async-Mode': 'true' },
    editFields: [],
    maxN: 1,
    async: {
      edit: true,
      build: modelscopeBuild,
      submitPath: (input, provider) => modelscopeRoot(provider) + '/v1/images/generations'
    },
    // 轮询头在适配器侧：任务类型是网关要求的**非凭据头**，描述符不开口子放 headers。
    taskPollHeaders: (provider) => Object.assign(
      { 'X-ModelScope-Task-Type': 'image_generation' },
      authHeaders(provider, { authHeader: 'bearer' })
    ),
    // 输出格式描述符：轮询地址按任务 id 自己拼（{root} = 去掉末尾 /v1 的站点根，
    // 否则 baseUrl 不带 /v1 时会拼出 /v1/v1/tasks/…）；状态是 task_status；
    // 结果先看 output_images（字符串或 {url|image_url}），老网关退 data.0.url。
    output: outputProfile({
      kind: 'task',
      idPath: 'task_id',
      path: '{root}/v1/tasks/{taskId}',
      statusPath: 'task_status',
      success: ['SUCCEED', 'SUCCEEDED', 'SUCCESS'],
      failure: ['FAILED', 'CANCELED', 'CANCELLED', 'ERROR'],
      // 迁移前是 firstMessage() 的递归挖法，键顺序一致；errors:{message} 这类嵌套由深挖覆盖。
      failureMessagePath: ['message', 'msg', 'detail', 'error', 'errors', 'reason', 'logs'],
      resultPath: ['output_images', 'data.0.url'],
      intervalMs: 2000,
      timeoutMs: 300000,
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: 'ModelScope 任务完成了但没有返回图片'
    }, 'modelscope')
  }
];
