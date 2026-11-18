/**
 * OpenAI 家族的三条自拼 body 协议。
 *
 * - openai-responses：Responses API 的 image_generation 工具（图片在 output[].result，裸 base64）
 * - openrouter-images：OpenRouter 专用 /api/v1/images（data[].b64_json + media_type）
 * - openai-chat：中转生态的 chat/completions + modalities，响应形态不唯一，要多形态探测
 *
 * Azure OpenAI 不在这里：它与 `openai-images` 的地址三元组、传输方式、字段模板完全一样，
 * 只差鉴权方式，所以是 `openai-images` + 提供商字段 `auth.mode: 'api-key'`
 * （见 lib/adapter-kit.js 的 AUTH_MODES 与 adapters.js 的 LEGACY_PROTOCOL_ALIASES）。
 *
 * 其中这三条自己拼 body 的协议不再持有字段名：prompt / negative /
 * model / n 写在哪，由字段模板（`fieldsFor()` 或协议自带默认模板）说了算，再用
 * applyFields / promptParts 写进去。
 * 留在协议里的有两类东西：
 *   - 请求形状：Responses 的 input 是「字符串」还是「content[]」，chat 的 content 是「字符串」
 *     还是 parts、`modalities`，OpenRouter 的 aspect_ratio / resolution；
 *   - 六种模板能力表达不了的项对象：{ type: 'input_image', detail } 与
 *     { type: 'image_url', image_url: { url } }（带额外键），按设计红线留在协议里。
 */
import { request } from '../net.js';
import {
  baseUrlOf, headersFor, readJsonResponse, dataUrlOf, nearestAspect
} from '../adapter-kit.js';
// 结果图下载走同一套凭据判断（同源带、跨源默认不带），别在这里另写一个裸 GET。
import { fetchResultImage } from '../request-auth.js';
import { applyFields, promptParts, resolveFields } from '../field-templates.js';
import { outputProfile, readOutput } from '../output-profiles.js';
// 循环依赖：adapters.js 先 import 本模块、再求值完。fieldsFor 是函数声明（已提升），
// 只在 execute() 里调用，所以安全。
import { fieldsFor } from '../adapters.js';

function hostOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

function sizeTextOf(input) {
  const fitted = input && input.fitted;
  if (!fitted || fitted.omit || fitted.size === 'none' || fitted.size === 'auto') return '';
  if (fitted.width && fitted.height) return fitted.width + 'x' + fitted.height;
  return String(fitted.size || '');
}

/** 提示词文本：负面词拼不拼进来由模板说（这几条协议的默认模板都是 appendToPrompt）。 */
function foldedPrompt(fields, input) {
  const negative = String((input && input.negativePrompt) || '').trim();
  return promptParts(fields, { prompt: input.prompt, negative: negative || undefined }).prompt;
}

/** 质量值：`off` / `auto` 的语义是「完全不发这个参数」。 */
function qualityOf(input) {
  const quality = String((input && input.quality) || '').trim().toLowerCase();
  return quality && quality !== 'off' && quality !== 'auto' ? quality : undefined;
}

/** 参考图：老实现只认带 contentType 的图，别把不完整的数据塞进请求体。 */
function referenceImages(input) {
  return (input.images || []).filter((image) => image && image.buffer && image.contentType);
}

function imageParts(images) {
  return (Array.isArray(images) ? images : [])
    .filter((image) => image && image.buffer && image.contentType)
    .map((image) => ({ type: 'image_url', image_url: { url: dataUrlOf(image) } }));
}

/**
 * 「用户覆盖 + 协议默认模板」：给没有预设、而且信封形状和模型字段规则对不上的两条协议用。
 *
 * 不用 fieldsFor() 的那两层：模型字段规则是照「扁平 body」写的（gpt-image 的提示词叫
 * body.prompt、模型叫 body.model），套进 Responses 的 `tools[0]` 或 chat 的 `messages[]`
 * 会静默写错位置——不抛错，只发出去一个坏 body。信封形状本来就不归规则管。
 */
function fieldsWithDefaults(defaults, provider, model) {
  const options = provider && typeof provider === 'object' ? provider.modelOptions : null;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const declared = entry && entry.fields && typeof entry.fields === 'object' && !Array.isArray(entry.fields)
    ? entry.fields
    : null;
  return resolveFields({ override: declared, preset: defaults });
}

/**
 * Responses 的默认模板：模型名与质量在 `tools[0]` 里。
 * 提示词（input 的字符串 / content[] 二选一）与参考图项（type + detail）表达不了，写 null 留在协议里。
 */
const RESPONSES_FIELDS = {
  prompt: null,
  negative: { appendToPrompt: '\n\nAvoid: ' },
  model: { path: 'tools[0].model' },
  n: null,
  image: null,
  quality: { path: 'tools[0].quality' }
};

/**
 * chat 的默认模板：模型是顶层字段，负面词拼进提示词。
 * messages[].content[] 里的 { type: 'text' } / { type: 'image_url' } 项带额外键，留在协议里。
 */
const CHAT_FIELDS = {
  prompt: null,
  negative: { appendToPrompt: '\n\nAvoid: ' },
  model: { path: 'model' },
  n: null,
  image: null,
  quality: null
};

/**
 * OpenRouter 的默认模板（预设有同款）：OpenRouter 主机会命中模型字段规则，
 * 但有人把这条协议挂到别的主机上时规则不命中，兜底不能是空模板。
 */
const OPENROUTER_FIELDS = {
  prompt: { path: 'prompt' },
  negative: { appendToPrompt: '\n\nAvoid: ' },
  model: { path: 'model' },
  n: { path: 'n' },
  image: null,
  quality: null
};

export const OPENAI_ADAPTERS = [
  {
    id: 'openai-responses',
    label: 'protocol.openai-responses',
    match: () => false,
    local: false,
    endpoints: { generate: '/responses', edit: '/responses' },
    routes: { generate: '/responses', edit: '/responses', models: '/models' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1,
    editFields: [],
    // 输出格式描述符：图片在 output[] 里 type 为 image_generation_call 的那项的 result
    // （裸 base64）。没有 URL 分支，也没有兜底扫描。
    output: outputProfile({
      kind: 'json',
      pick: [{
        path: 'output[]',
        as: 'base64',
        any: ['result'],
        where: [{ path: 'type', equals: 'image_generation_call' }]
      }],
      maxBytes: 64 * 1024 * 1024,
      emptyMessage: 'Responses API 没有返回图片（检查 tool_choice 与主模型是否支持 image_generation）'
    }, 'openai-responses'),
    async execute(kind, provider, input, signal) {
      const hostModel = String((provider && provider.hostModel) || 'gpt-5.2').trim();
      const fields = fieldsWithDefaults(RESPONSES_FIELDS, provider, input.model);
      // 工具声明是请求形状（type / output_format 是响应形态常量）。
      const tool = { type: 'image_generation', output_format: 'png' };
      const body = {
        model: hostModel,
        tools: [tool],
        tool_choice: { type: 'image_generation' }
      };
      // 模型名与质量的落点来自模板（默认是 tools[0].model / tools[0].quality）。
      applyFields(body, { model: fields.model, quality: fields.quality }, {
        model: String(input.model || '').trim(),
        quality: qualityOf(input)
      });
      // 尺寸不属于六个逻辑字段：Responses 的尺寸在工具声明里。
      const size = sizeTextOf(input);
      if (size) tool.size = size;

      // input 是字符串还是 content[]，取决于有没有参考图 / 是不是编辑方向：条件分支留在协议里。
      const prompt = foldedPrompt(fields, input);
      const images = referenceImages(input);
      body.input = (kind === 'edit' || images.length)
        ? [{
            role: 'user',
            content: [{ type: 'input_text', text: prompt }].concat(images.map((image) => ({
              type: 'input_image', image_url: dataUrlOf(image), detail: 'auto'
            })))
          }]
        : prompt;

      const response = await request(baseUrlOf(provider) + '/responses', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, this.output.maxBytes);
      // 响应侧只做「读描述符」：filter（type）+ 取 result + base64 直解都在描述符里。
      // 迁移前是 `items.find(...)` 只解第一项，这里会「解不出就试下一个匹配项」——见下方
      // 「已知差异」的用例；单一坏结果仍报同一句 emptyMessage。
      return readOutput(payload, this.output);
    }
  },
  {
    id: 'openrouter-images',
    label: 'protocol.openrouter-images',
    match: (provider) => hostOf(provider) === 'openrouter.ai',
    local: false,
    endpoints: { generate: '/images', edit: '/images' },
    routes: { generate: '/images', edit: '/images', models: '/models' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 10,
    editFields: [],
    // 输出格式描述符：OpenRouter 专用接口回 data[0].b64_json（裸 base64），
    // contentType 取同级 media_type（没有就按字节签名）。只看 data[0]，没有 URL 分支。
    output: outputProfile({
      kind: 'json',
      pick: [{ path: 'data.0.b64_json', as: 'base64', contentTypePath: 'media_type' }],
      maxBytes: 64 * 1024 * 1024,
      emptyMessage: 'OpenRouter 没有返回图片'
    }, 'openrouter-images'),
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/images/models', {
        headers: headersFor(provider, false), signal: signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload && Array.isArray(payload.data) ? payload.data : [])
        .map((item) => String((item && item.id) || '').trim())
        .filter(Boolean)
        .slice(0, 200);
    },
    async execute(kind, provider, input, signal) {
      // 模板：用户覆盖 > 模型字段规则 > 协议默认（OpenRouter 主机上的规则与默认值一致）。
      const fields = resolveFields({
        override: fieldsFor(this, provider, input.model),
        preset: OPENROUTER_FIELDS
      });
      const values = {
        prompt: input.prompt,
        model: input.model,
        n: 1,
        negative: String((input && input.negativePrompt) || '').trim() || undefined
      };
      const folded = promptParts(fields, values);
      const body = applyFields({}, fields, Object.assign({}, values, { prompt: folded.prompt }));
      // 响应形态常量，不是「提示词叫什么」。
      body.output_format = 'png';
      // 尺寸不属于六个逻辑字段：OpenRouter 收比例 + 档位。
      if (input.fitted && !input.fitted.omit && input.fitted.width && input.fitted.height) {
        body.aspect_ratio = input.fitted.aspect || nearestAspect(input.fitted.width, input.fitted.height);
        // 只有认 resolution 的底层模型才发档位（fitSize 已经填好 tier）；发错了 provider 会 400。
        if (input.fitted.tier) body.resolution = String(input.fitted.tier);
      }
      // 参考图是 { type, image_url: { url } } 对象（带额外键），六种能力表达不了，留在协议里。
      const references = imageParts(input.images);
      if (references.length) body.input_references = references;

      const response = await request(baseUrlOf(provider) + '/images', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, this.output.maxBytes);
      // 响应侧只做「读描述符」：data.0 的 b64 + media_type 覆盖都在描述符里。
      return readOutput(payload, this.output);
    }
  },
  {
    id: 'openai-chat',
    label: 'protocol.openai-chat',
    match: () => false,
    local: false,
    endpoints: { generate: '/chat/completions', edit: '/chat/completions' },
    routes: { generate: '/chat/completions', edit: '/chat/completions', models: '/models' },
    transport: { generate: 'json', edit: 'json' },
    // 这个协议没有尺寸字段：尺寸只能写进提示词（stitch），面板仍给宽高输入框。
    size: { control: 'prompt', stitch: true, wire: [], style: 'string', field: 'size', default: '1024x1024' },
    // 四级级联，顺序照抄迁移前的 chatImage()：
    //   1. message.images[]（元素可以是 image_url.url / url / 字符串）
    //   2. content 里的 data URL（content 可以是字符串或 parts[].text）
    //   3. content 里的 http 图片链接
    //   4. 任意位置扫描（scan）
    // 2/3 两级用 text 表达：一条正则先扫全部文本，再扫下一条——不是逐段文本依次试。
    output: outputProfile({
      kind: 'json',
      from: [
        { path: 'choices.0.message.images[]', as: 'auto', any: ['image_url.url', 'url', ''] },
        {
          path: 'choices.0.message.content',
          text: [
            { regex: "data:image/[a-z+]+;base64,[A-Za-z0-9+/=\\r\\n]+", as: 'base64' },
            { regex: "https?://[^\\s)\"'<>]+\\.(?:png|jpe?g|webp)(?:\\?[^\\s)\"'<>]*)?", as: 'url' }
          ]
        }
      ],
      scan: true,
      maxBytes: 64 * 1024 * 1024,
      emptyMessage: '该中转没有返回图片（检查 modalities 或换用 OpenRouter 专用接口）'
    }, 'openai-chat'),
    maxN: 1,
    editFields: [],
    async execute(kind, provider, input, signal) {
      const fields = fieldsWithDefaults(CHAT_FIELDS, provider, input.model);
      // 模型落点来自模板；messages / modalities 是请求形状。
      const body = { modalities: ['image', 'text'] };
      applyFields(body, { model: fields.model }, { model: input.model });
      // content 是「字符串」还是 parts、以及项里的 type，都是条件形状，留在协议里。
      const parts = [{ type: 'text', text: foldedPrompt(fields, input) }].concat(imageParts(input.images));
      body.messages = [{ role: 'user', content: parts.length === 1 ? parts[0].text : parts }];
      const response = await request(baseUrlOf(provider) + '/chat/completions', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, this.output.maxBytes);
      // 响应侧只做「读描述符」：字节直接返回，URL 交给 fetchResultImage
      // （同源带凭据、跨源默认不带，判定只有那一份）。
      const picked = readOutput(payload, this.output);
      if (picked.bytes) return picked;
      // 中转经常把图存到自己的 CDN 再回链接；当轮下载，不把 URL 交给上层。
      return fetchResultImage(picked.url, signal, this, provider);
    }
  }
];
