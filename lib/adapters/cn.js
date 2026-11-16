/**
 * 国内厂商里协议形状和 OpenAI Images 不一致的两家。
 *
 * - 百炼 Qwen-Image：原生多模态同步接口，size 用 `*` 分隔，图片在 output.choices[].message.content[].image
 * - 智谱 BigModel：形状像 OpenAI，但不接受 n / response_format，一次只回一张 url
 */
import { request } from '../net.js';
import { baseUrlOf, headersFor, readJsonResponse, fetchImageUrl, base64ToImage, dataUrlOf } from '../adapter-kit.js';

function promptOf(input) {
  const prompt = String((input && input.prompt) || '');
  const negative = String((input && input.negativePrompt) || '').trim();
  return negative ? prompt + '\n\nAvoid: ' + negative : prompt;
}

function sizeOf(input) {
  const fitted = input && input.fitted;
  if (!fitted || fitted.omit || fitted.size === 'none' || fitted.size === 'auto') return '';
  if (fitted.width && fitted.height) return fitted.width + 'x' + fitted.height;
  return String(fitted.size || '');
}

async function urlToImage(url, signal) {
  return fetchImageUrl(String(url), signal);
}

export const CN_ADAPTERS = [
  {
    id: 'dashscope-qwen-image',
    label: '阿里云百炼 · Qwen-Image',
    match: (provider, model) => /dashscope\.aliyuncs\.com/i.test(baseUrlOf(provider)) && /qwen-image/i.test(String(model || '')),
    local: false,
    endpoints: { generate: '/services/aigc/multimodal-generation/generation', edit: '/services/aigc/multimodal-generation/generation' },
    routes: { generate: '/services/aigc/multimodal-generation/generation', edit: '/services/aigc/multimodal-generation/generation', models: '' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 6,
    editFields: [],
    // 百炼原生：size 用星号分隔，512²–2048²，比例 1:8–8:1。
    size: {
      control: 'wh', style: 'string', field: 'size', separator: '*', allowCustom: true,
      minPixels: 262144, maxPixels: 4194304, hint: 'modelDecides'
    },
    async execute(kind, provider, input, signal) {
      // 生成与编辑是同一个原生多模态端点：编辑时把参考图放进 content 的 image 项。
      const messageContent = [];
      if (kind === 'edit') {
        const images = (input.images || []).filter((image) => image && image.buffer && image.contentType);
        if (!images.length) throw new Error('百炼 Qwen-Image 图生图需要一张参考图');
        for (const image of images.slice(0, 3)) messageContent.push({ image: dataUrlOf(image) });
      }
      messageContent.push({ text: promptOf(input) });
      const parameters = { n: 1 };
      // 编辑接口不收尺寸：Qwen-Image-Edit 系列官方明确不发这个字段。
      if (kind !== 'edit') {
        const fitted = input.fitted && !input.fitted.omit ? input.fitted : { width: 1024, height: 1024 };
        parameters.size = fitted.width + '*' + fitted.height;
        if (input.negativePrompt) parameters.negative_prompt = String(input.negativePrompt);
      }
      const body = {
        model: input.model,
        input: { messages: [{ role: 'user', content: messageContent }] },
        parameters: parameters
      };
      const response = await request(baseUrlOf(provider) + '/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const content = payload && payload.output && payload.output.choices
        && payload.output.choices[0] && payload.output.choices[0].message
        && payload.output.choices[0].message.content;
      for (const item of Array.isArray(content) ? content : []) {
        if (item && item.image) return urlToImage(item.image, signal);
      }
      throw new Error('百炼 Qwen-Image 没有返回图片');
    }
  },
  {
    id: 'zhipu',
    label: '智谱 BigModel',
    match: (provider) => /(^|\.)bigmodel\.cn$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//i, '').split('/')[0]),
    local: false,
    endpoints: { generate: '/images/generations', edit: '' },
    routes: { generate: '/images/generations', edit: '', models: '/models' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1,
    editFields: [],
    // glm-image 与 cogview 的限制不一样：前者 1024–2048 且 32 的倍数，后者 512–2048 且 16 的倍数。
    size: { control: 'wh', style: 'string', field: 'size', allowCustom: true, multiple: 32, minSide: 1024, maxSide: 2048, maxPixels: 4194304 },
    sizeByModel: [
      {
        match: /cogview/i,
        size: { control: 'wh', style: 'string', field: 'size', allowCustom: true, multiple: 16, minSide: 512, maxSide: 2048, maxPixels: 2097152 }
      }
    ],
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('智谱 BigModel 暂未支持参考图编辑；请换用支持编辑的模型。');
      const body = { model: input.model, prompt: promptOf(input) };
      const size = sizeOf(input);
      if (size) body.size = size;
      const quality = String(input.quality || '').trim().toLowerCase();
      if (quality && quality !== 'off' && quality !== 'auto') body.quality = quality;
      const response = await request(baseUrlOf(provider) + '/images/generations', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const first = payload && Array.isArray(payload.data) ? payload.data[0] : null;
      if (first && first.url) return urlToImage(first.url, signal);
      if (first && first.b64_json) {
        const decoded = base64ToImage(first.b64_json);
        if (decoded) return decoded;
      }
      throw new Error('智谱 BigModel 没有返回图片');
    }
  }
];
