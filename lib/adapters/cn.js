/**
 * 国内厂商里协议形状和 OpenAI Images 不一致的那一家。
 *
 * - 百炼 Qwen-Image：原生多模态同步接口，size 用 `*` 分隔，图片在 output.choices[].message.content[].image
 *
 * 智谱 BigModel 不在这里：它的地址三元组（/images/generations + 无编辑 + /models）与
 * 请求体都和通用 composeBody 一致（不收 n / response_format、负面词拼进提示词），
 * 所以并进了 `openai-images` + 协议级选项 `{ edit: 'none' }`。
 *
 * 字段名不在协议里：prompt / negative / model / n / image 写在哪，由 `fieldsFor()` 按
 * 「用户覆盖 > 模型规则 > 预设」取模板，再用 applyFields / promptParts 写进 body。
 *
 * 仍然留在协议里的三类东西（都不是「这家网关把提示词叫什么」）：
 *   - 请求形状：消息信封 `input.messages[0].role = 'user'`；content[] 里 image 项在前、
 *     text 项在后（老 body 的顺序）；编辑端不收尺寸；
 *   - 尺寸：它不属于六个逻辑字段，百炼的 `W*H` 星号仍由协议自己拼；
 *   - 六种模板能力表达不了的：百炼的负面词**既要单开 parameters.negative_prompt、又拼进
 *     提示词**（一个逻辑字段只能有一条模板），所以折叠那一句还是协议代码。
 */
import { baseUrlOf } from '../adapter-kit.js';
import { outputProfile } from '../output-profiles.js';
import { applyFields, promptParts } from '../field-templates.js';
// 循环依赖：adapters.js 先 import 本模块、再求值完。fieldsFor 是函数声明（已提升），
// 只要不在模块顶层调用就没问题——这里只在 execute() 里用。
import { executeBuiltImage, fieldsFor } from '../adapters.js';

/** 百炼的提示词：负面词既发一个独立参数、又拼进文本，模板表达不了双写，折叠留在协议里。 */
function promptOf(input) {
  const prompt = String((input && input.prompt) || '');
  const negative = String((input && input.negativePrompt) || '').trim();
  return negative ? prompt + '\n\nAvoid: ' + negative : prompt;
}

/** 负面词的字段值：老实现只在这个值为真时才发那个参数（空串不发）。 */
function negativeOf(input) {
  return String((input && input.negativePrompt) || '') || undefined;
}

export const CN_ADAPTERS = [
  {
    id: 'dashscope-qwen-image',
    label: 'protocol.dashscope-qwen-image',
    acceptsHttpParams: true,
    match: (provider, model) => /dashscope\.aliyuncs\.com/i.test(baseUrlOf(provider)) && /qwen-image/i.test(String(model || '')),
    local: false,
    endpoints: { generate: '/services/aigc/multimodal-generation/generation', edit: '/services/aigc/multimodal-generation/generation' },
    routes: { generate: '/services/aigc/multimodal-generation/generation', edit: '/services/aigc/multimodal-generation/generation', models: '' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 6,
    editFields: [],
    // 输出格式描述符：图片在 output.choices[0].message.content[].image，取第一个带 image 的项。
    // `as:'url'` 只认 http(s)——迁移前对 item.image 不做校验，相对路径/垃圾串会变成一次
    // 注定失败的请求；这里改成跳过（后面若有合法 URL 就能拿到）。
    output: outputProfile({
      kind: 'json',
      pick: [{ path: 'output.choices.0.message.content[].image', as: 'url' }],
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: '百炼 Qwen-Image 没有返回图片'
    }, 'dashscope-qwen-image'),
    async execute(kind, provider, input, signal, hooks) {
      // 生成与编辑是同一个原生多模态端点：编辑时把参考图放进 content 的 image 项。
      // 提示词与参考图的落点（input.messages[0].content[]，分别包成 { text } / { image }）
      // 都来自模板；content[] 之外的 role 是消息信封，模板不描述它。
      const fields = fieldsFor(this, provider, input.model);
      const body = { input: { messages: [{ role: 'user' }] } };
      const images = kind === 'edit'
        ? (input.images || []).filter((image) => image && image.buffer && image.contentType).slice(0, 3)
        : [];
      if (kind === 'edit') {
        if (!images.length) throw new Error('百炼 Qwen-Image 图生图需要一张参考图');
        // 老 body 的顺序是 image 项在前、text 项在后；applyFields 按模板键序追加，所以分两次写。
        applyFields(body, { image: fields.image }, { image: images });
      }
      applyFields(body, { prompt: fields.prompt }, { prompt: promptOf(input) });
      // 编辑接口不收尺寸、也不发负面词字段：老实现的这两个分支留在协议里（用哪条模板由协议决定）。
      applyFields(
        body,
        kind === 'edit'
          ? { model: fields.model, n: fields.n }
          : { model: fields.model, n: fields.n, negative: fields.negative },
        { model: input.model, n: 1, negative: negativeOf(input) }
      );
      // 尺寸不属于六个逻辑字段：百炼用 `W*H`，编辑端不发。老实现在缺省时退回 1024x1024。
      if (kind !== 'edit') {
        const size = input.fitted && !input.fitted.omit ? input.fitted : { width: 1024, height: 1024 };
        body.parameters = Object.assign({}, body.parameters, { size: size.width + '*' + size.height });
      }
      return executeBuiltImage(kind, this, provider, input, this.endpoints[kind], body, signal, undefined, hooks);
    }
  }
];
