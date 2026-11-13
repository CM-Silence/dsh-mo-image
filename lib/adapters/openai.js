/**
 * OpenAI 家族的四个协议。
 *
 * - openai-responses：Responses API 的 image_generation 工具（图片在 output[].result，裸 base64）
 * - openrouter-images：OpenRouter 专用 /api/v1/images（data[].b64_json + media_type）
 * - azure-openai：Azure 的 OpenAI v1 路径，鉴权是 api-key 而不是 Bearer
 * - openai-chat：中转生态的 chat/completions + modalities，响应形态不唯一，要多形态探测
 */
import { request } from '../net.js';
import {
  baseUrlOf, headersFor, readJsonResponse, dataUrlOf, base64ToImage, nearestAspect, decodeImagePayload
} from '../adapter-kit.js';

function hostOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

function sizeTextOf(input) {
  const fitted = input && input.fitted;
  if (!fitted || fitted.omit || fitted.size === 'none' || fitted.size === 'auto') return '';
  if (fitted.width && fitted.height) return fitted.width + 'x' + fitted.height;
  return String(fitted.size || '');
}

function promptWithNegative(input) {
  const prompt = String((input && input.prompt) || '');
  const negative = String((input && input.negativePrompt) || '').trim();
  return negative ? prompt + '\n\nAvoid: ' + negative : prompt;
}

function imageParts(images) {
  return (Array.isArray(images) ? images : [])
    .filter((image) => image && image.buffer && image.contentType)
    .map((image) => ({ type: 'image_url', image_url: { url: dataUrlOf(image) } }));
}

function decodeDataOrUrl(text) {
  if (!text) return null;
  const decoded = base64ToImage(text);
  if (decoded) return decoded;
  if (/^https?:\/\//i.test(String(text))) return { url: String(text) };
  return null;
}

/** chat 出图没有统一响应格式：images[] → content 里的 data URL → markdown 链接 → 兜底扫描。 */
function chatImage(payload) {
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const direct = message && Array.isArray(message.images) ? message.images : [];
  for (const item of direct) {
    const url = (item && item.image_url && item.image_url.url) || (item && item.url) || (typeof item === 'string' ? item : '');
    const decoded = decodeDataOrUrl(url);
    if (decoded) return decoded;
  }
  const content = message && message.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
      : [];
  for (const text of texts) {
    const hit = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\r\n]+/i.exec(text);
    if (hit) {
      const decoded = base64ToImage(hit[0]);
      if (decoded) return decoded;
    }
  }
  for (const text of texts) {
    const hit = /https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s)"'<>]*)?/i.exec(text);
    if (hit) return { url: hit[0] };
  }
  try {
    return decodeImagePayload(payload, null);
  } catch (_error) {
    return null;
  }
}

const GPT_QUALITY = {
  label: '质量', default: 'high', fallback: 'high',
  allowed: ['low', 'medium', 'high', 'auto'],
  options: [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'auto', label: 'Auto' }
  ]
};

export const OPENAI_ADAPTERS = [
  {
    id: 'openai-responses',
    label: 'OpenAI Responses (image_generation)',
    match: () => false,
    local: false,
    endpoints: { generate: '/responses', edit: '/responses' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1,
    editFields: [],
    async execute(kind, provider, input, signal) {
      const model = String(input.model || '').trim();
      const hostModel = String((provider && provider.hostModel) || 'gpt-5.2').trim();
      const size = sizeTextOf(input);
      const tool = { type: 'image_generation', model: model, ...(size ? { size: size } : {}) };
      const quality = String(input.quality || '').trim().toLowerCase();
      if (quality && quality !== 'off' && quality !== 'auto') tool.quality = quality;
      tool.output_format = 'png';

      const prompt = promptWithNegative(input);
      const images = (input.images || []).filter((image) => image && image.buffer && image.contentType);
      const payloadInput = (kind === 'edit' || images.length)
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
        body: JSON.stringify({
          model: hostModel,
          input: payloadInput,
          tools: [tool],
          tool_choice: { type: 'image_generation' }
        }),
        signal: signal
      });
      const payload = await readJsonResponse(response, 64 * 1024 * 1024);
      const items = payload && Array.isArray(payload.output) ? payload.output : [];
      const call = items.find((item) => item && item.type === 'image_generation_call' && item.result);
      const decoded = call ? base64ToImage(call.result) : null;
      if (decoded) return decoded;
      throw new Error('Responses API 没有返回图片（检查 tool_choice 与主模型是否支持 image_generation）');
    }
  },
  {
    id: 'openrouter-images',
    label: 'OpenRouter Images',
    match: (provider) => hostOf(provider) === 'openrouter.ai',
    local: false,
    endpoints: { generate: '/images', edit: '/images' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 10,
    editFields: [],
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
      const body = {
        model: input.model,
        prompt: promptWithNegative(input),
        n: 1,
        output_format: 'png'
      };
      if (input.fitted && !input.fitted.omit && input.fitted.width && input.fitted.height) {
        body.aspect_ratio = nearestAspect(input.fitted.width, input.fitted.height);
      }
      const quality = String(input.quality || '').trim().toLowerCase();
      if (quality && quality !== 'off' && quality !== 'auto') body.quality = quality;
      const references = imageParts(input.images);
      if (references.length) body.input_references = references;

      const response = await request(baseUrlOf(provider) + '/images', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, 64 * 1024 * 1024);
      const first = payload && Array.isArray(payload.data) ? payload.data[0] : null;
      const decoded = first ? base64ToImage(first.b64_json) : null;
      if (!decoded) throw new Error('OpenRouter 没有返回图片');
      return { bytes: decoded.bytes, contentType: first.media_type || decoded.contentType };
    }
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI Images',
    match: (provider) => /(^|\.)openai\.azure\.com$/i.test(hostOf(provider)) || /(^|\.)services\.ai\.azure\.com$/i.test(hostOf(provider)),
    authHeader: 'api-key',
    local: false,
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'n', 'output_format'],
    size: { style: 'string', field: 'size', multiple: 16, minPixels: 655360, maxPixels: 8294400, default: '1024x1024', onUnsupported: 'nearest' },
    quality: GPT_QUALITY,
    outputFormat: 'png',
    maxN: 10,
    editFields: ['image[]', 'image']
  },
  {
    id: 'openai-chat',
    label: 'OpenAI 兼容 chat 出图（中转）',
    match: () => false,
    local: false,
    endpoints: { generate: '/chat/completions', edit: '/chat/completions' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1,
    editFields: [],
    async execute(kind, provider, input, signal) {
      const parts = [{ type: 'text', text: promptWithNegative(input) }].concat(imageParts(input.images));
      const body = {
        model: input.model,
        messages: [{ role: 'user', content: parts.length === 1 ? parts[0].text : parts }],
        modalities: ['image', 'text']
      };
      const response = await request(baseUrlOf(provider) + '/chat/completions', {
        method: 'POST',
        headers: headersFor(provider, false, null, this),
        body: JSON.stringify(body),
        signal: signal
      });
      const payload = await readJsonResponse(response, 64 * 1024 * 1024);
      const decoded = chatImage(payload);
      if (!decoded) {
        throw new Error('该中转没有返回图片（检查 modalities 或换用 OpenRouter 专用接口）');
      }
      if (decoded.bytes) return decoded;
      throw new Error('该中转返回的是图片链接，暂不支持：' + decoded.url);
    }
  }
];
