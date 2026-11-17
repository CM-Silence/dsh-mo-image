/**
 * 尺寸与质量「模型规则」表。
 *
 * 协议只描述请求地址与传输方式；「这个模型认哪些值、参数叫什么」搬到这里，
 * 按模型名（必要时加主机）模糊匹配。条目形状与模型选项里的用户覆盖共用一套：
 *
 *   { match: /正则/i, host?: '正则',
 *     size: { mode, field, separator, second, control? },
 *     domain: { multiple, allowed, aspects, tiers, minPixels, maxPixels, minSide, maxSide, default, ... } }
 *
 *   { match: /正则/i, host?: '正则',
 *     quality: { field, options, map, default } }
 *
 *   { match: /正则/i, host?: '正则',
 *     fields: { prompt: 模板|null, negative: 模板|null, model: 模板|null, n: 模板|null,
 *               image: 模板|null, quality: 模板|null } }
 *
 *   { match: /正则/i, host?: '正则',
 *     constants: { response_format?, watermark? } }
 *
 * 第四段 `constants` 是**请求常量**：不描述「字段叫什么」，只描述这家网关要的固定值
 * （响应形态 response_format、输出格式 output_format、水印开关 watermark）。它原来是协议上的
 * 静态属性（`adapter.responseFormat` / `adapter.outputFormat` / `adapter.watermark`），协议按 id
 * 合并成 `openai-images` 之后没有 id 可挂了，改成按「模型 + 主机」判断——这几条本来就是
 * 主机/模型的性质，不是协议地址的性质。同样没有兜底条目：认不出就不发这几个键。
 *
 * 第三段 `fields` 是字段模板的模型级微调（模板形状见 lib/field-templates.js）：只写
 * 「这个模型族怎么发」与预设不同的地方。它与尺寸/质量一样按「模型 + 主机」先、
 * 只按模型后匹配，但**故意没有兜底条目**——字段名正是预设要区分的东西，一条通配规则
 * 会把所有预设盖掉，认不出就返回 null 让调用方回落到预设。
 * 合并顺序是 用户覆盖 > 规则 > 预设，逐字段取第一个有定义的层，所以一条规则**可以只写
 * 它要改的那几个字段**（省略 = 跟随预设）；整条写 null = 显式不发，后面的层盖不掉它。
 *
 * mode（怎么发）：
 *   'wh-string'  —— 一个字段写 "1024x1024"（separator 决定分隔符）
 *   'wh-fields'  —— width / height 两个字段
 *   'aspect'     —— 只发比例（aspect_ratio）
 *   'tier'       —— 发档位名（"2K"），tierLabels 语义
 *   'prompt'     —— 尺寸只能写进提示词
 *   'none'       —— 该模型不发尺寸字段
 *
 * `control`（可选）只覆盖"面板给哪种控件"，不影响线上写法：默认由 mode + domain.allowed
 * 推导（有白名单 → 预设芯片，没有 → 宽高输入框），个别模型需要另一种组合时才点名。
 *
 * `second`（第二个尺寸字段，形如 { from: 'tier', field: 'imageSize' }）：
 * xAI 的 `resolution` 用它（`{ from: 'tier', field: 'resolution' }`，档位 1k/2k 直接发）；
 * Gemini 的 imageSize、BFL 的 resolution 仍硬编码在各自 execute / build 里
 * （它们跟比例一起发、或大小写要转，模板层看不出这个差别）。
 *
 * 匹配顺序：先「模型 + 主机」，再「只按模型」，命中第一条即返回；都不命中返回 null。
 * 主机指纹压过模型指纹——同一个模型名在不同网关字段不同（qwen-image 在硅基流动是
 * image_size、在百炼是 size 且用 `*`），只看模型名一定会串。
 *
 * 最后一条是**兜底规则**（`host` 为空、`match` 匹配任意非空模型名）：认不出的模型
 * 按 OpenAI 兼容发 `size`，因为通用网关（openai-images / localai）的尺寸本来就跟
 * 模型名无关。所以 `detectSizeRule()` 对非空模型 id 实际上总会命中一条；"不发尺寸"
 * 由 `mode: 'none'` 表达（模型规则或用户覆盖），不是靠"没命中"。
 *
 * 条目逐条抄自 lib/adapters.js、lib/adapters/{cn,async,openai}.js 的
 * `size` / `quality` / `sizeByModel` 声明，以及原来按模型名兜底的 SIZE_FAMILIES；
 * 数值一律照抄，不在这里新增或调整取值域。迁移对应关系：
 *   style 'string'        → mode 'wh-string'
 *   style 'width-height'  → mode 'wh-fields'
 *   style 'aspect'        → mode 'aspect'
 *   tierLabels: true      → mode 'tier'
 *   control 'prompt'      → mode 'prompt'
 *   wire: []（noSizeField）→ mode 'none'
 * domain 沿用现有策略里的键名（multiple/allowed/aspects/tiers/minPixels/maxPixels/
 * minSide/maxSide/default/allowCustom/custom/hint），这样规则与用户覆盖能用同一个
 * 合并器叠加。
 *
 * 不收录：a1111 / comfyui / swarmui —— 宽高写在 sdapi 参数或工作流占位符里，
 * 由 workflowParamsOf() 管，不走规则。fal / replicate / openai-responses 现在没有
 * 自己的尺寸或质量声明（fal、replicate 由模型 schema 决定），它们落到兜底规则上，
 * 与原来 encodeSizePrimary 拿默认参数名兜出的 `{ size }` 一致。
 */

/** 主机指纹：baseUrl 里取 host 段，端口/路径都丢掉。 */
function hostOf(baseUrl) {
  return String(baseUrl || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

const hostCache = new Map();

function hostMatches(pattern, host) {
  if (!host) return false;
  let compiled = hostCache.get(pattern);
  if (!compiled) {
    try {
      compiled = new RegExp(pattern, 'i');
    } catch (_error) {
      return false;
    }
    hostCache.set(pattern, compiled);
  }
  compiled.lastIndex = 0;
  return compiled.test(host);
}

function modelMatches(pattern, model) {
  if (!(pattern instanceof RegExp)) return false;
  pattern.lastIndex = 0;
  return pattern.test(model);
}

function detect(rules, model, baseUrl) {
  const id = String(model || '').trim();
  if (!id) return null;
  const host = hostOf(baseUrl);
  // 第一轮：模型与主机同时命中。网关差异优先于模型家族。
  for (const rule of rules) {
    if (rule.host === undefined || rule.host === null) continue;
    if (!hostMatches(rule.host, host)) continue;
    if (!modelMatches(rule.match, id)) continue;
    return rule;
  }
  // 第二轮：只看模型名。
  for (const rule of rules) {
    if (rule.host !== undefined && rule.host !== null) continue;
    if (!modelMatches(rule.match, id)) continue;
    return rule;
  }
  return null;
}

/* ------------------------------------------------------- 档位表（复用） */

const TIERS_1K_2K_4K = [
  { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
];
const TIERS_1K_15K_2K = [
  { value: '1K', pixels: 1048576 }, { value: '1.5K', pixels: 2359296 }, { value: '2K', pixels: 4194304 }
];
const TIERS_2K_4K = [{ value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }];
const TIERS_2K_3K_4K = [
  { value: '2K', pixels: 4194304 }, { value: '3K', pixels: 9437184 }, { value: '4K', pixels: 16777216 }
];
const TIERS_512_1K_2K_4K = [
  { value: '512', pixels: 262144 }, { value: '1K', pixels: 1048576 },
  { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
];

/** Gemini / nano-banana 的比例表（adapters.js 的 google-gemini.size.aspects）。 */
const GEMINI_ASPECTS = [
  '1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
];

/* ------------------------------------------------------------ 尺寸规则 */

export const SIZE_RULES = [
  /* ---- BFL：FLUX 2 是 width/height，FLUX 3 换成比例 + 小写档位 ---- */
  {
    match: /flux-?3/i,
    host: 'bfl\\.ai',
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: {
      aspects: ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21', 'auto'],
      tiers: [
        { value: '768sq', pixels: 589824 }, { value: '1k', pixels: 1048576 }, { value: '1.5k', pixels: 2359296 },
        { value: '2k', pixels: 4194304 }, { value: '4k', pixels: 16777216 }
      ],
      minSide: 256, maxSide: 6256, maxPixels: 16822272
    }
  },
  {
    // BFL 的提交体只认 width / height（FLUX 3 除外，见上一条）。
    match: /.*/,
    host: 'bfl\\.ai',
    size: { mode: 'wh-fields' },
    domain: { minSide: 64, maxPixels: 4194304 }
  },

  /* ---- OpenRouter：默认比例；gemini 系另有 resolution 档位 ---- */
  {
    match: /gemini/i,
    host: 'openrouter\\.ai',
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: { tiers: TIERS_512_1K_2K_4K, default: '1024x1024' }
  },
  {
    match: /.*/,
    host: 'openrouter\\.ai',
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: { default: '1024x1024' }
  },

  /* ---- Together AI：所有模型都是宽高两个字段 ---- */
  {
    match: /.*/,
    host: 'api\\.together\\.xyz',
    size: { mode: 'wh-fields' },
    domain: { default: '1024x1024' }
  },

  /* ---- Stability AI：只有比例；三个端点像素都固定 ---- */
  {
    match: /.*/,
    host: 'stability\\.ai',
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: {
      aspects: ['21:9', '16:9', '3:2', '5:4', '1:1', '4:5', '2:3', '9:16', '9:21'],
      default: '1024x1024',
      hint: 'fixedPixels'
    }
  },

  /* ---- xAI Grok Imagine：比例 + 小写两档，档位另写一个 resolution 字段 ---- */
  {
    match: /.*/,
    host: 'api\\.x\\.ai',
    size: { mode: 'aspect', field: 'aspect_ratio', second: { from: 'tier', field: 'resolution' } },
    domain: {
      aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'],
      tiers: [{ value: '1k', pixels: 1048576 }, { value: '2k', pixels: 4194304 }],
      default: '1024x1024'
    }
  },

  /* ---- Azure OpenAI：路径与鉴权不同，尺寸域跟自家 gpt-image 一致 ---- */
  {
    match: /.*/,
    host: 'openai\\.azure\\.com|services\\.ai\\.azure\\.com',
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minPixels: 655360, maxPixels: 8294400, default: '1024x1024' }
  },

  /* ---- 硅基流动：image_size；Qwen-Image-Edit 系列明确不收 ---- */
  {
    match: /qwen-image-edit/i,
    host: 'api\\.siliconflow\\.cn',
    size: { mode: 'none' },
    domain: { hint: 'noSizeField' }
  },
  {
    match: /qwen-image/i,
    host: 'api\\.siliconflow\\.cn',
    size: { mode: 'wh-string', field: 'image_size' },
    domain: {
      allowed: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'],
      allowCustom: true,
      custom: true
    }
  },
  {
    match: /.*/,
    host: 'api\\.siliconflow\\.cn',
    size: { mode: 'wh-string', field: 'image_size' },
    domain: {
      allowed: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'],
      allowCustom: true,
      custom: true
    }
  },

  /* ---- 阿里云百炼 · Qwen-Image：size 用星号分隔 ---- */
  {
    match: /qwen-image/i,
    host: 'dashscope\\.aliyuncs\\.com',
    size: { mode: 'wh-string', field: 'size', separator: '*' },
    domain: { allowCustom: true, minPixels: 262144, maxPixels: 4194304, hint: 'modelDecides' }
  },

  /* ---- 魔搭：网关按每边 [64, 2048] 校验，模型族上限另算 ---- */
  {
    match: /flux/i,
    host: 'api-inference\\.modelscope\\.(cn|ai)',
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minSide: 64, maxSide: 1024, default: '1024x1024' }
  },
  {
    match: /qwen-image/i,
    host: 'api-inference\\.modelscope\\.(cn|ai)',
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minSide: 64, maxSide: 1664, default: '1024x1024' }
  },
  {
    match: /z-image/i,
    host: 'api-inference\\.modelscope\\.(cn|ai)',
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minSide: 512, maxSide: 2048, default: '1024x1024' }
  },
  {
    match: /.*/,
    host: 'api-inference\\.modelscope\\.(cn|ai)',
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minSide: 64, maxSide: 2048, default: '1024x1024' }
  },

  /* ---- 火山方舟：线上发档位名，档位集合按 seedream 版本分叉 ---- */
  {
    match: /seedream-?5\.0-lite/i,
    host: 'volces\\.com',
    size: { mode: 'tier', field: 'size' },
    domain: { tiers: TIERS_2K_3K_4K, minPixels: 3686400, maxPixels: 16777216, default: '1024x1024', custom: true }
  },
  {
    match: /seedream-?5\.[05]/i,
    host: 'volces\\.com',
    size: { mode: 'tier', field: 'size' },
    domain: { tiers: TIERS_1K_15K_2K, minPixels: 921600, maxPixels: 4624220, default: '1024x1024', custom: true }
  },
  {
    match: /seedream-?4\.5/i,
    host: 'volces\\.com',
    size: { mode: 'tier', field: 'size' },
    domain: { tiers: TIERS_2K_4K, minPixels: 3686400, maxPixels: 16777216, default: '1024x1024', custom: true }
  },
  {
    match: /seedream-?4\.0/i,
    host: 'volces\\.com',
    size: { mode: 'tier', field: 'size' },
    domain: { tiers: TIERS_1K_2K_4K, minPixels: 921600, maxPixels: 16777216, default: '1024x1024', custom: true }
  },
  {
    match: /.*/,
    host: 'volces\\.com',
    size: { mode: 'tier', field: 'size' },
    domain: { tiers: TIERS_2K_3K_4K, default: '1024x1024', custom: true }
  },

  /* ---- GPT-Image：任意 W×H，16 的倍数、1:3–3:1 ---- */
  {
    match: /gpt-?image/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 16, minPixels: 655360, maxPixels: 8294400, default: '1024x1024' }
  },

  /* ---- DALL·E 3：三个固定尺寸 ---- */
  {
    match: /dall-?e-?3/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { allowed: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024' }
  },

  /* ---- Gemini / Nano Banana：比例 + 档位（imageSize 大小写敏感，512 只有 3.1-flash 认） ---- */
  {
    match: /3\.1-flash-image/i,
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: { aspects: GEMINI_ASPECTS, tiers: TIERS_512_1K_2K_4K, default: '1024x1024' }
  },
  {
    match: /nano-banana|3-pro-image/i,
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: { aspects: GEMINI_ASPECTS, tiers: TIERS_1K_2K_4K, default: '1024x1024' }
  },
  {
    match: /2\.5-flash-image/i,
    size: { mode: 'none' },
    domain: { hint: 'noSizeField' }
  },
  {
    // 通用网关上的 gemini image / nano-banana / imagen：面板给比例 + 档位，线上仍是 WxH。
    match: /banana|gemini-[^ ]*image|imagen/i,
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: { aspects: GEMINI_ASPECTS, tiers: TIERS_1K_2K_4K, default: '1024x1024' }
  },

  /* ---- seedream：通过中转站时按档位算像素预算，线上仍发 WxH ---- */
  {
    match: /seedream-?5[.-]?0-lite/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { tiers: TIERS_2K_3K_4K, minPixels: 3686400, maxPixels: 16777216, custom: true }
  },
  {
    match: /seedream-?5[.-]?[05]/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { tiers: TIERS_1K_15K_2K, minPixels: 921600, maxPixels: 4624220, custom: true }
  },
  {
    match: /seedream-?4[.-]?5/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { tiers: TIERS_2K_4K, minPixels: 3686400, maxPixels: 16777216, custom: true }
  },
  {
    match: /seedream-?4[.-]?0/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { tiers: TIERS_1K_2K_4K, minPixels: 921600, maxPixels: 16777216, custom: true }
  },

  /* ---- Ideogram：三个模型三种协议 ---- */
  {
    // 透明背景：比例 + 小写档位（按 v2 端点的小写来发）。
    match: /ideogram-4-transparent/i,
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: {
      aspects: ['auto', '1x4', '1x3', '1x2', '9x16', '10x16', '2x3', '3x4', '4x5', '1x1', '5x4', '4x3', '3x2', '16x10', '16x9', '2x1', '3x1', '4x1'],
      tiers: [
        { value: '1k', pixels: 1048576 }, { value: '2k', pixels: 4194304 },
        { value: '4k', pixels: 16777216 }, { value: '8k', pixels: 67108864 }
      ],
      default: '1024x1024'
    }
  },
  {
    match: /ideogram-4-5/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: {
      allowCustom: true, multiple: 32, minSide: 256, maxPixels: 4194304,
      // 比例表与默认值是从 ideogram 基础声明继承下来的（模型覆盖里没重写）。
      aspects: ['auto', '1x3', '3x1', '1x2', '2x1', '9x16', '16x9', '10x16', '16x10', '2x3', '3x2', '3x4', '4x3', '4x5', '5x4', '1x1'],
      default: '1024x1024'
    }
  },
  {
    // ideogram-4 只收 resolution 像素枚举，没有 aspect_ratio。
    match: /ideogram-4/i,
    size: { mode: 'wh-string', field: 'resolution' },
    domain: {
      aspects: ['auto', '1x3', '3x1', '1x2', '2x1', '9x16', '16x9', '10x16', '16x10', '2x3', '3x2', '3x4', '4x3', '4x5', '5x4', '1x1'],
      default: '1024x1024',
      allowed: [
        '2048x2048', '1440x2880', '2880x1440', '1664x2496', '2496x1664', '1792x2240', '2240x1792',
        '1440x2560', '2560x1440', '1600x2560', '2560x1600', '1728x2304', '2304x1728', '1296x3168',
        '3168x1296', '1152x2944', '2944x1152', '1248x3328', '3328x1248', '1280x3072', '3072x1280',
        '1024x3072', '3072x1024', '1024x1024', '896x1120', '1120x896', '864x1152', '1152x864',
        '832x1248', '1248x832', '800x1280', '1280x800', '720x1280', '1280x720', '720x1440', '1440x720',
        '512x1536', '1536x512'
      ],
      allowCustom: false
    }
  },
  {
    // ideogram-3：比例是字母 x（16x9），不是冒号。
    match: /ideogram/i,
    size: { mode: 'aspect', field: 'aspect_ratio' },
    domain: {
      aspects: ['auto', '1x3', '3x1', '1x2', '2x1', '9x16', '16x9', '10x16', '16x10', '2x3', '3x2', '3x4', '4x3', '4x5', '5x4', '1x1'],
      default: '1024x1024'
    }
  },

  /* ---- Recraft：三族像素表完全不同，表外值直接 400 ---- */
  {
    // 原声明是 `/_pro$/i`，但它只活在 recraft 适配器的 sizeByModel 里（模型 id 必然是
    // recraft 的）；搬进全局表后必须带上厂商前缀，否则 fal 的 `fal-ai/flux-2-pro`、
    // replicate 的 `black-forest-labs/flux-2-pro` 也会命中 recraft 的 2K 像素表，
    // 1024x1024 会被吸附成 2048x2048。前缀写法不限制主机：recraft 模型走中转照旧命中。
    match: /recraft.*_pro$/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: {
      allowed: [
        '2048x2048', '3072x1536', '1536x3072', '2560x1664', '1664x2560', '2432x1792', '1792x2432',
        '2304x1792', '1792x2304', '1664x2688', '2560x1792', '1792x2560', '2688x1536', '1536x2688'
      ],
      allowCustom: false
    }
  },
  {
    match: /recraftv[23]|v[23]_/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: {
      allowed: [
        '1024x1024', '2048x1024', '1024x2048', '1536x1024', '1024x1536', '1365x1024', '1024x1365',
        '1280x1024', '1024x1280', '1024x1707', '1434x1024', '1024x1434', '1820x1024', '1024x1820'
      ],
      allowCustom: false
    }
  },
  {
    // 向量模型：面板给比例（control:'aspect'），但线上发的仍是 `size:"1024x1024"` 像素串。
    // 单看 mode 表达不了这个组合，所以规则里额外点名 control（wire 形状仍按 wh-string）。
    match: /_vector/i,
    size: { mode: 'wh-string', field: 'size', control: 'aspect' },
    domain: {
      aspects: ['1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16'],
      // 像素白名单是从 recraft 基础声明继承下来的（向量模型没重写），落位仍按它取整。
      allowed: [
        '1024x1024', '1536x768', '768x1536', '1280x832', '832x1280', '1216x896', '896x1216',
        '1152x896', '896x1152', '832x1344', '1280x896', '896x1280', '1344x768', '768x1344'
      ],
      allowCustom: false
    }
  },
  {
    match: /recraft/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: {
      allowed: [
        '1024x1024', '1536x768', '768x1536', '1280x832', '832x1280', '1216x896', '896x1216',
        '1152x896', '896x1152', '832x1344', '1280x896', '896x1280', '1344x768', '768x1344'
      ],
      allowCustom: false
    }
  },

  /* ---- 智谱 BigModel：glm-image 与 cogview 的限制不一样 ---- */
  {
    match: /cogview/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { allowCustom: true, multiple: 16, minSide: 512, maxSide: 2048, maxPixels: 2097152 }
  },
  {
    match: /glm-?image/i,
    size: { mode: 'wh-string', field: 'size' },
    domain: { allowCustom: true, multiple: 32, minSide: 1024, maxSide: 2048, maxPixels: 4194304 }
  },

  /* ---- 通义万相：只有 wan2.7 认档位缩写，pro 的上限另一套；像素白名单/默认值沿用基础声明 ---- */
  {
    match: /wan2\.7.*pro/i,
    size: { mode: 'tier', field: 'parameters.size', separator: '*' },
    domain: {
      tiers: TIERS_1K_2K_4K, minPixels: 589824, maxPixels: 16777216,
      allowed: ['1280x1280', '1696x960', '960x1696', '1472x1104', '1104x1472'],
      allowCustom: true, custom: true, default: '1280x1280', hint: 'modelDecides'
    }
  },
  {
    match: /wan2\.7/i,
    size: { mode: 'tier', field: 'parameters.size', separator: '*' },
    domain: {
      tiers: TIERS_1K_2K_4K, minPixels: 589824, maxPixels: 4194304,
      allowed: ['1280x1280', '1696x960', '960x1696', '1472x1104', '1104x1472'],
      allowCustom: true, custom: true, default: '1280x1280', hint: 'modelDecides'
    }
  },
  {
    // 万相的模型 id 有两种写法：wanx2.1-* 与 wan2.6/2.7-image（后者才算得上"模型名"）。
    match: /wanx|wan[0-9]/i,
    size: { mode: 'tier', field: 'parameters.size', separator: '*' },
    domain: {
      allowed: ['1280x1280', '1696x960', '960x1696', '1472x1104', '1104x1472'],
      allowCustom: true,
      custom: true,
      default: '1280x1280',
      hint: 'modelDecides'
    }
  },

  /* ---- MiniMax H3-Image：比例 + area 档位，**不能**同时发 size ----
   *
   * H3 的尺寸是"二选一"的两套写法（官方 Text-to-Image / Image Edit 两个 OpenAPI 都这么写）：
   *
   *   - `size: "WIDTHxHEIGHT"`，此时传 `aspect_ratio` / `area` 会 400（传 `auto` 也算传）；
   *   - `size` 省略或 `auto`，宽高由 `aspect_ratio`（X:Y，1:3–3:1）和 `area`（1K/2K/4K）算出来。
   *
   * 这里选第二套：`mode: 'aspect'` 只发 `aspect_ratio`（不发 `size`），档位另写 `area`。
   * 这样任何用户选出来的尺寸都落在合法区间里（W×H 那套一旦超出 655,360–20,000,000 像素
   * 或 1:3–3:1 就 400，而且服务端不会自动缩放），档位语义也正好对上 H3 的 1K/2K/4K
   * 目标面积 1024²/2048²/4096²。
   *
   * 比例表来自官方文档：示例值 16:9 / 3:4 / 21:9 / 3:1，尺寸表里还有 1:1 / 4:3 / 9:16，
   * 合法区间是 1:3–3:1（含边界）。不带 host：官方两个域名（api.minimax.io / api.minimax.cn）
   * 是同一套接口，中转站上的 H3 也一样。
   */
  {
    match: /h3[-_ ]?image/i,
    size: { mode: 'aspect', field: 'aspect_ratio', second: { from: 'tier', field: 'area' } },
    domain: {
      aspects: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '3:1', '1:3'],
      tiers: TIERS_1K_2K_4K,
      default: '1024x1024'
    }
  },

  /* ---- 兜底（必须是最后一条）-----------------------------------------------------
   *
   * 认不出的模型按 OpenAI 兼容发 `size`，而不是"不发尺寸"。
   *
   * 理由（见设计文档「兜底规则」）：`openai-images` / `localai` 这类通用协议的尺寸
   * 声明本来就与模型名无关，规则表表达不了；没有这条，所有中转站会突然从"发尺寸"
   * 变成"不发尺寸"，而那是最大的一群人。真要"不发"，用 `mode: 'none'`（模型规则
   * 或用户覆盖）——这个语义修正写在设计文档里。
   *
   * 位置很重要：detect() 第二轮按数组顺序只看模型名，这条 `.*` 必须在所有具体规则
   * 之后，否则会抢先命中一切。
   */
  {
    match: /.*/,
    size: { mode: 'wh-string', field: 'size' },
    domain: { multiple: 1 }
  }
];

/* ------------------------------------------------------------ 质量规则 */

export const QUALITY_RULES = [
  /* ---- Azure OpenAI：主机决定用哪套质量枚举（没有 xhigh / max） ---- */
  {
    match: /.*/,
    host: 'openai\\.azure\\.com|services\\.ai\\.azure\\.com',
    quality: { field: 'quality', options: ['low', 'medium', 'high', 'auto'], default: 'high' }
  },

  /* ---- GPT-Image 2.5 的 sunburst / flare 多两档（原 options(model) 的分叉） ---- */
  {
    match: /2\.5-(sunburst|flare)/i,
    quality: { field: 'quality', options: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'], default: 'high' }
  },

  /* ---- GPT-Image ---- */
  {
    match: /gpt-?image/i,
    quality: { field: 'quality', options: ['low', 'medium', 'high', 'auto'], default: 'high' }
  },

  /* ---- DALL·E 3 ---- */
  {
    match: /dall-?e-?3/i,
    quality: { field: 'quality', options: ['standard', 'hd'], default: 'standard' }
  },

  /* ---- Ideogram：字段叫 rendering_speed，值要转大写 ---- */
  {
    match: /ideogram/i,
    quality: {
      field: 'rendering_speed',
      options: ['turbo', 'default', 'quality'],
      map: { turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' },
      default: 'default'
    }
  }
];

/* ------------------------------------------------------------ 字段规则 */

/**
 * 字段模板的模型级微调。字段名逐条抄自协议代码，不在这里新造：
 *
 *   - 主机型条目抄「这家网关的接口形状」：BFL 的多图是 input_image / input_image_2..N
 *     （FLUX 3 例外，收 images 数组）、百炼 Qwen-Image 是 input.messages[0].content[]、
 *     硅基流动是扁平的 prompt / negative_prompt / image、火山方舟是 prompt/size/image。
 *   - 模型型条目抄「这个模型家族自己的 API」：gpt-image / dall-e-3 没有 negative prompt；
 *     ideogram 的模型名在路径里、张数叫 num_images、4 的 JSON 体没有 negative_prompt。
 *
 * 表达不了的一律写 null，把那段留在协议的 execute()/async.build() 里（红线：不给模板
 * 加第七种能力）：
 *   - gemini 的参考图是 { inlineData: { mimeType, data } } 这种带额外键的对象；
 *   - fal 的单图用 image_url、多图用 image_urls，选哪个由端点决定；
 *   - replicate 的字段名由模型 Input schema 决定；
 *   - openrouter 的参考图是 input_references[] 里的 { type, image_url } 对象。
 *
 * 没有兜底条目（区别于 SIZE_RULES 的最后一条）：认不出的模型返回 null，回落到预设。
 */
export const FIELD_RULES = [
  /* ---- BFL：FLUX 3 与 FLUX.2 / kontext 的参考图字段不同，模型名进的是提交路径 ---- */
  {
    match: /flux-?3/i,
    host: 'bfl\\.ai',
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: { path: 'images[]', as: 'dataUrl' }
    }
  },
  {
    match: /.*/,
    host: 'bfl\\.ai',
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: { numbered: 'input_image', as: 'dataUrl' }
    }
  },

  /* ---- OpenRouter：比例 + input_references 对象，六种能力表达不了参考图 ---- */
  {
    match: /.*/,
    host: 'openrouter\\.ai',
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: null
    }
  },

  /* ---- Gemini 原生：内容追加进 contents[0].parts[]，模型名在 URL 的 :generateContent 前 ---- */
  {
    match: /.*/,
    host: 'generativelanguage\\.googleapis\\.com',
    fields: {
      prompt: { path: 'contents[0].parts[]', wrap: 'text' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: null
    }
  },

  /* ---- xAI Grok Imagine：负面词拼进提示词，没有参考图字段、没有质量参数 ---- */
  {
    match: /.*/,
    host: 'api\\.x\\.ai',
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: null
    }
  },

  /* ---- 智谱 BigModel：形状像 OpenAI，但不收 n / response_format，负面词拼进提示词 ---- */
  {
    match: /.*/,
    host: 'bigmodel\\.cn',
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: null,
      image: null
    }
  },

  /* ---- 硅基流动：扁平的 prompt / negative_prompt / image ---- */
  {
    match: /.*/,
    host: 'api\\.siliconflow\\.cn',
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: null,
      image: { path: 'image', as: 'dataUrl' }
    }
  },

  /* ---- 阿里云百炼：同一个 qwen-image，原生多模态接口与万相异步接口的字段完全不同 ---- */
  {
    match: /qwen-image/i,
    host: 'dashscope\\.aliyuncs\\.com',
    fields: {
      prompt: { path: 'input.messages[0].content[]', wrap: 'text' },
      negative: { path: 'parameters.negative_prompt' },
      model: { path: 'model' },
      n: { path: 'parameters.n' },
      image: { path: 'input.messages[0].content[]', wrap: 'image', as: 'dataUrl' }
    }
  },
  {
    match: /wanx|wan[0-9]/i,
    host: 'dashscope\\.aliyuncs\\.com',
    fields: {
      prompt: { path: 'input.prompt' },
      negative: { path: 'input.negative_prompt' },
      model: { path: 'model' },
      n: { path: 'parameters.n' },
      image: null
    }
  },

  /* ---- 火山方舟：seedream 一族不收负面词，参考图是 data URL 的 image ---- */
  {
    match: /.*/,
    host: 'volces\\.com',
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { path: 'image', as: 'dataUrl' }
    }
  },

  /* ---- Ideogram：模型名在路径里；张数叫 num_images；只有非 4 的表单体带负面词 ---- */
  {
    match: /ideogram-4$/i,
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: null,
      n: { path: 'num_images' },
      image: null
    }
  },
  {
    match: /ideogram/i,
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: null,
      n: { path: 'num_images' },
      image: null
    }
  },

  /* ---- OpenAI 自家的两个模型家族：官方端点没有 negative prompt 这个参数 ----
   *
   * 只有官方主机（api.openai.com / *.openai.azure.com）写 negative: null；不带 host 的
   * 那条保留预设的 negative_prompt —— 中转站上的 gpt-image 一直都收负面词，别因为上游
   * 对未知参数 400 就把所有网关都当成官方端点。
   * 两条都不写 quality：收不收质量由预设（openai / azure）的 fields.quality 决定，
   * 而 openai-chat / openai-responses 这类自己拼 body、没有预设的协议不该凭空多出档位。
   */
  {
    match: /gpt-?image/i,
    host: 'api\\.openai\\.com|openai\\.azure\\.com',
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' }
    }
  },
  {
    match: /gpt-?image/i,
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' }
    }
  },
  {
    match: /dall-?e-?3/i,
    host: 'api\\.openai\\.com|openai\\.azure\\.com',
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' }
    }
  },
  {
    match: /dall-?e-?3/i,
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' }
    }
  }
];

/* ---------------------------------------------------------- 请求常量规则 */

/**
 * 请求常量：与「字段叫什么」无关，只描述这家网关要的固定值。
 *
 * 这几条原来长在协议对象上（`responseFormat` / `outputFormat` / `watermark`），
 * 协议合并成 `openai-images` 之后按 id 区分不了，但值本身是真的（火山方舟的 `watermark`
 * 默认是 true，不发这个键出来的图会带水印），所以按「模型 + 主机」留下来：
 *
 *   - 火山方舟：关水印 + 要 URL（几十 MB 的 base64 走 JSON 太贵）；
 *   - Together：只要 URL；
 *   - DALL·E 3：响应认 b64_json（官方两种都收，插件一直发这个，别改线上形态）；
 *   - Azure：生成体一直带 output_format=png（原来挂在 azure-openai 协议的 outputFormat 上，
 *     协议并进 openai-images 后没有 id 可挂；host 就是它，别让线上 body 少一个键）。
 *
 * 与 FIELD_RULES 一样**没有兜底条目**：认不出的模型不额外发常量。
 */
export const CONSTANT_RULES = [
  {
    match: /.*/,
    host: 'volces\\.com',
    constants: { response_format: 'url', watermark: false }
  },
  {
    match: /.*/,
    host: 'api\\.together\\.xyz',
    constants: { response_format: 'url' }
  },
  {
    // xAI Grok Imagine 要 URL（原来挂在 xai-imagine 协议的 execute 里）。
    match: /.*/,
    host: 'api\\.x\\.ai',
    constants: { response_format: 'url' }
  },
  {
    match: /.*/,
    host: 'openai\\.azure\\.com|services\\.ai\\.azure\\.com',
    constants: { output_format: 'png' }
  },
  {
    match: /dall-?e-?3/i,
    constants: { response_format: 'b64_json' }
  }
];

/* ---------------------------------------------------------------- 探测 */

/** 按模型名 + 可选主机找尺寸规则；都没有返回 null（调用方据此不发尺寸字段）。 */
export function detectSizeRule(model, baseUrl) {
  return detect(SIZE_RULES, model, baseUrl);
}

/** 按模型名 + 可选主机找质量规则；都没有返回 null（调用方按 off 语义不发质量字段）。 */
export function detectQualityRule(model, baseUrl) {
  return detect(QUALITY_RULES, model, baseUrl);
}

/**
 * 按模型名 + 可选主机找字段模板规则；都没有返回 null（调用方回落到预设）。
 * 与尺寸/质量不同，这里没有兜底条目：认不出的模型就该由预设决定怎么发。
 */
export function detectFieldRule(model, baseUrl) {
  return detect(FIELD_RULES, model, baseUrl);
}

/**
 * 按模型名 + 可选主机找请求常量规则；都没有返回 null（调用方不额外发常量）。
 * 与尺寸/质量不同，这里没有兜底条目：常量是网关个性，认不出就别乱发。
 */
export function detectConstantRule(model, baseUrl) {
  return detect(CONSTANT_RULES, model, baseUrl);
}
