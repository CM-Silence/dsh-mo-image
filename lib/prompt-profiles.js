/**
 * 生图提示词「方言」描述层。
 *
 * 同一个提示词写给不同模型，效果差别很大：
 *   GPT-Image / DALL·E 3 / FLUX / Nano Banana 更吃自然语言；
 *   Seedream / Qwen-Image / 通义万相 / Kolors 更吃中文叙事；
 *   Stable Diffusion 仍常用短语标签 + negative prompt。
 *
 * 这里只放「怎么写」的知识，不发请求。插件在系统提示词里按当前模型
 * 注入对应规则，完整模板放在 skills/ 里按需加载。
 */

export const GENERATION_FORMULA = '主体 + 动作 + 环境 + 艺术风格 + 光影 + 构图 + 限制条件';
export const EDITING_FORMULA = '动作动词 + 目标元素 + 期望变化 + 风格细节';

function languageLabel(language) {
  if (language === 'en') return '英文优先';
  if (language === 'zh') return '中文优先';
  return '中英皆可，默认跟随用户';
}

/**
 * 模型族 → 提示词写法。match 只看模型 ID，adapter 是模型 ID 认不出时的兜底。
 * 顺序有意义：越具体的族越靠前。
 */
const PROFILES = [
  {
    id: 'gpt-image',
    label: 'OpenAI GPT-Image',
    match: /gpt-?image|chatgpt-?image/i,
    adapter: 'gpt-image',
    language: 'en',
    supportsNegative: false,
    supportsEdit: true,
    textRendering: 'strong',
    rules: [
      '结构：场景/背景 → 主体 → 关键细节 → 明确约束；复杂需求用短标签或换行分段，不要只堆关键词。',
      '先写用途与画幅（电商主图/海报/UI/信息图/摄影），用位置词安排布局和留白（居中/左上/右侧留白）。',
      '图中文字用引号原样写出，并指定字体、颜色、大小、位置；小字或密集排版用高质量挡位。',
      '编辑：只改 X，其余保持不变；每轮重复身份、构图、文字、光线的保留清单，避免漂移。',
      '具体到材质、镜头、光线；避免空泛质量词（masterpiece/8k/best quality）。'
    ],
    editRule: '只改指定元素，保持身份、构图、文字、光线和背景不变。'
  },
  {
    id: 'dall-e-3',
    label: 'OpenAI DALL·E 3',
    match: /dall-?e-?3/i,
    adapter: 'dall-e-3',
    language: 'en',
    supportsNegative: false,
    supportsEdit: false,
    textRendering: 'weak',
    rules: [
      '用完整自然语言段落（2–5 句）描述画面，不要用关键词列表或标签堆叠。',
      '写清主体、动作、场景、媒介/风格、光线和氛围；模型会自动改写扩展，细节要明确。',
      '文字渲染弱：避免长文字和 logo；文字需求改用 GPT-Image 等模型。',
      '不支持透明背景：需要纯色背景时直接写“纯白背景”等，不要写 transparent。',
      '不要用 no/without 否定句；把不要的东西改写成正面描述。'
    ],
    editRule: '不适合参考图编辑；需要编辑时换用 GPT-Image、Seedream、Nano Banana 等。'
  },
  {
    id: 'nano-banana',
    label: 'Google Nano Banana / Gemini Image',
    match: /nano-?banana|gemini.*(?:image|flash)|imagen/i,
    language: 'any',
    supportsNegative: false,
    supportsEdit: true,
    textRendering: 'strong',
    rules: [
      '自然语言叙事，先写主体/动作/场景，再写构图、风格、镜头；不要只列关键词。',
      '正向描述：说“空荡的街道”而不是“没有车”；不要用否定句。',
      '参考图公式：参考图 + 关系指令 + 新场景；按图1/图2说明用途。',
      '文字放引号中并指定字体/位置；支持多语言文字和 1K/2K/4K。',
      '编辑：用强动词开头（添加/移除/替换/改成），明确保留项；可用文字描述蒙版区域。'
    ],
    editRule: '强动词开头，只改指定区域，明确保持主体、构图和风格。'
  },
  {
    id: 'seedream',
    label: '字节 Seedream',
    match: /seedream|doubao.*(?:image|t2i)/i,
    adapter: 'volcengine-ark',
    language: 'zh',
    supportsNegative: false,
    supportsEdit: true,
    textRendering: 'strong',
    rules: [
      '简洁连贯的中文自然语言：主体 + 行为 + 环境，再补风格、色彩、光影、构图。',
      '不要关键词堆砌；说明用途/类型（海报/电商/角色设定/分镜）和画幅。',
      '文字放双引号中；需要多张时写“一组/四张/分镜”等，可生成统一风格的组图。',
      '编辑：用“增加/删除/替换/修改”明确对象和变化，避免代词；强调其余保持不变。',
      '支持图1/图2参考和多图输入；按顺序说明每张图的作用。'
    ],
    editRule: '只说清改哪个对象、怎么改、其余保持不变；不要用“它/那个”指代。'
  },
  {
    id: 'qwen-image',
    label: '阿里 Qwen-Image',
    match: /qwen.*image|qwen-?image/i,
    language: 'zh',
    supportsNegative: true,
    supportsEdit: true,
    textRendering: 'strong',
    rules: [
      '中文或英文自然语言，主体、场景、风格、构图写具体；支持长提示词和复杂版面。',
      '文字渲染强：把文字放引号中，指定字体、颜色、位置和层级。',
      '支持 negative prompt：把畸变、水印、多余文字、低质量等放进 negative_prompt。',
      '编辑：按图1/图2说明参考关系，只改指定元素，保持其余不变。',
      '需要精确控制时，把“必须出现/必须保留”的内容写成清单。'
    ],
    editRule: '只改指定区域，保持文字、版式和主体不变。'
  },
  {
    id: 'flux',
    label: 'Black Forest Labs FLUX',
    match: /flux|kontext/i,
    language: 'en',
    supportsNegative: false,
    supportsEdit: true,
    textRendering: 'weak',
    rules: [
      '自然语言散文，前置主体和动作；30–80 词最佳，最多约 512 tokens。',
      '按 主体 + 动作 + 风格/媒介 + 环境 + 光线 + 镜头/技术细节 的顺序写。',
      '只写你想要的：FLUX 不支持 negative prompt，用正面描述替代排除项。',
      '文字渲染弱：不要依赖长文字；需要文字用 GPT-Image/Qwen/Seedream。',
      'Kontext 编辑：明确“改什么 + 保持什么”，参考图按图1/图2指代。'
    ],
    editRule: 'Kontext 编辑只改目标元素，保持主体、构图、背景和风格一致。'
  },
  {
    id: 'stable-diffusion',
    label: 'Stable Diffusion / Stability',
    match: /stable-?diffusion|sdxl|sd-?3|sd3|stable-image/i,
    adapter: 'stability',
    language: 'en',
    supportsNegative: true,
    supportsEdit: true,
    textRendering: 'weak',
    rules: [
      'SD3.5 用自然语言段落；SDXL/1.5 用逗号分隔的短语标签（媒介、主体、构图、光线、细节）。',
      '支持 negative prompt：把低质量、畸变、多余肢体、水印等放进 negative_prompt。',
      '写清风格/媒介、主体、构图、光线、色彩；避免互相冲突的风格词。',
      '文字渲染弱：不要依赖长文字；需要文字用 GPT-Image/Qwen/Seedream。',
      '编辑：说明保留区域和修改区域；参考图按图1/图2指代。'
    ],
    editRule: '说明保留区域和修改区域；需要局部重绘时优先用支持蒙版的模型。'
  },
  {
    id: 'wanx',
    label: '阿里通义万相',
    match: /wanx|wan-?xiang|tongyi.*wan/i,
    adapter: 'dashscope-wanx',
    language: 'zh',
    supportsNegative: true,
    supportsEdit: false,
    textRendering: 'fair',
    rules: [
      '中文自然语言：主体 + 场景 + 风格 + 光影 + 构图，简洁具体。',
      '支持 negative prompt：把低质量、畸变、水印、多余文字放入 negative_prompt。',
      '写清画幅和用途；避免长文字渲染。',
      '编辑能力有限：需要局部修改时优先换支持编辑的模型。',
      '不要堆砌抽象形容词；用可画的细节替代。'
    ],
    editRule: '编辑能力有限；需要局部修改时换支持编辑的模型。'
  },
  {
    id: 'kolors',
    label: '快手 Kolors',
    match: /kolors/i,
    language: 'zh',
    supportsNegative: true,
    supportsEdit: true,
    textRendering: 'fair',
    rules: [
      '中文自然语言，主体、场景、风格、光线、构图写具体；写实/插画均可。',
      '支持 negative prompt：低质量、畸变、多余肢体、水印等。',
      '文字渲染一般：避免长文字；需要文字用 GPT-Image/Qwen/Seedream。',
      '编辑：明确对象和变化，保持其余不变。',
      '写清人物年龄、发型、服装、材质等可画细节。'
    ],
    editRule: '只改指定对象，保持人物身份、构图和光线不变。'
  }
];

const GENERIC_PROFILE = {
  id: 'generic',
  label: '通用 OpenAI Images 兼容模型',
  match: null,
  adapter: '',
  language: 'any',
  supportsNegative: false,
  supportsEdit: true,
  textRendering: 'fair',
  rules: [
    '自然语言写清主体、动作、环境、风格、光影、构图和限制条件。',
    '具体到材质、颜色、镜头和光线；避免关键词堆砌和空泛质量词。',
    '图中文字用引号；不确定模型是否支持 negative prompt 时省略。',
    '编辑：只改 X，其余保持不变；按图1/图2指代参考图。',
    '先用最少的模型专属指令，再逐步加细节；一次只改一个变量。'
  ],
  editRule: '只改 X，其余保持不变。'
};

export function listPromptProfiles() {
  return PROFILES.map((profile) => ({ id: profile.id, label: profile.label }))
    .concat([{ id: GENERIC_PROFILE.id, label: GENERIC_PROFILE.label }]);
}

/**
 * 按模型 ID 选提示词写法；模型 ID 认不出时退回适配器族。
 * @param {string} modelId
 * @param {{id?: string}|string|null} adapter
 */
export function resolvePromptProfile(modelId, adapter) {
  const model = String(modelId || '');
  for (const profile of PROFILES) {
    if (profile.match && profile.match.test(model)) return profile;
  }
  const adapterId = typeof adapter === 'string' ? adapter : String((adapter && adapter.id) || '');
  if (adapterId) {
    const hit = PROFILES.find((profile) => profile.adapter === adapterId);
    if (hit) return hit;
  }
  return GENERIC_PROFILE;
}

export function describePromptProfile(profile) {
  return profile ? profile.id + ' (' + profile.label + ')' : '';
}

/**
 * 生图前必读的当前配置：给模型看的最小 JSON。
 * 只靠系统提示词时，多轮之后模型会按上一条提示词的习惯继续写，换了模型、关了优化都不看；
 * 把当前状态放进工具结果，能让它每次写之前重读一遍。
 * 非 Auto 模式不带模型清单——清单只在 Auto 模式需要挑模型时才出现。
 * @param {{provider?: object, model?: string, adapter?: {id?: string}|null, models?: string[], promptOptimization?: boolean}} state
 */
/**
 * 工作流可调参数的提示：只列出名字、类型和默认值，让对话模型知道能填什么。
 * 留空等于用工作流默认值，所以这里不要求它必须填。
 */
function paramsHint(params) {
  if (!Array.isArray(params) || !params.length) return '';
  const lines = params.map((param) => {
    const type = param.type === 'enum' && Array.isArray(param.options)
      ? '可选 ' + param.options.slice(0, 12).join(' / ')
      : String(param.type || '').toLowerCase();
    return '- ' + param.name + '（' + type + '，默认 ' + JSON.stringify(param.default) + '）';
  });
  return '；可通过 params 覆盖的工作流参数（不传则用默认值）：' + lines.join('；');
}

export function settingsPayload(state) {
  const provider = (state && state.provider) || null;
  const model = String((state && state.model) || '').trim();
  const optimized = !(state && state.promptOptimization === false);
  const payload = {
    provider: provider ? String(provider.id || '') : '',
    model: model,
    promptOptimization: optimized,
    hint: ''
  };
  if (!model) {
    payload.hint = '还没有选择生图模型，请让用户先到设置里选一个';
    return payload;
  }
  if (model === 'auto') {
    payload.hint = optimized
      ? '按你选中的那个模型的方言写' + NEED_FULL_RULES
      : '直接用用户原话，不要扩写';
    payload.models = (Array.isArray(state && state.models) ? state.models : []).filter(Boolean).map(String);
    return payload;
  }
  const profile = resolvePromptProfile(model, (state && state.adapter) || null);
  payload.hint = optimized
    ? (PROFILE_HINTS[profile.id] || profile.label) + NEED_FULL_RULES
    : '直接用用户原话，不要扩写，不要补 negative prompt';
  const workflowParams = state && state.workflowParams;
  if (Array.isArray(workflowParams) && workflowParams.length) {
    payload.params = workflowParams;
    payload.hint += paramsHint(workflowParams);
  }
  return payload;
}

/** 优化开启时补一句：完整写法只在没读过时才要加载，读完不用重复加载。 */
const NEED_FULL_RULES = '；完整写法没读过时先加载对应 skill，读过就不用再加载';

/** 每个模型族一句最短提示：就是 mo_image_settings 里 hint 的内容，别的都不要。 */
const PROFILE_HINTS = {
  'gpt-image': '自然语言：场景→主体→细节→约束；英文优先；无 negative prompt',
  'dall-e-3': '完整自然语言段落；英文优先；无 negative prompt',
  'nano-banana': '自然语言叙事，正向描述；中英皆可',
  seedream: '简洁中文叙事，主体+行为+环境；中文优先',
  'qwen-image': '中文自然语言，可用 negative prompt；中文优先',
  flux: '自然语言散文，主体+动作前置，30–80 词；英文优先；无 negative prompt',
  'stable-diffusion': '自然语言段落或短语标签；英文优先；可用 negative prompt',
  wanx: '中文自然语言，简洁具体；可用 negative prompt',
  kolors: '中文自然语言；可用 negative prompt',
  generic: '自然语言写清主体、动作、环境、风格、光影、构图；中英皆可'
};

/**
 * 生成注入系统提示词的那一节。没有当前模型时返回空串，整节省略。
 * @param {{model?: string, adapter?: {id?: string}|null, editModel?: string, editAdapter?: {id?: string}|null, promptOptimization?: boolean}} state
 */
/** 交付与选择权的硬约束：对话模型只负责把提示词交出去，不评判、不换模型。 */
const DELIVERY_RULES = [
  '- 交付即止：工具返回图片链接后，最终回复只输出那一行；不评价画质、不描述画面。除非用户明确要求看图，否则不要打开或读取生成的图片。',
  '- 提供商由用户在设置里固定：不要自行切换提供商，也不要用其他工具（本地生图、建模/Blender、脚本绘图）替代生图模型。',
  '- 调用失败时：把错误原样告诉用户；可以问用户是否要更换模型或服务商，但不要自己更换，也不要换别的模型重试。',
  '- 每次生图/改图前先调用 mo_image_settings 读当前配置，按它返回的模型写法和提示词优化状态写提示词；没读就调用生图工具会被拒绝。配置文件可以只读查看，但对它的任何写入都会被守卫拒绝。'
];

/** Auto 行：用户把选择器设为 Auto 时，模型选择权才下放给对话模型。 */
function autoSectionText(state) {
  const models = Array.isArray(state && state.models) ? state.models.filter(Boolean) : [];
  return [
    '<mo-image-prompt>',
    '仅在用户需要生成/编辑图片时使用；其他任务忽略本节。',
    '当前生图模型：Auto —— 由你按任务从下面的列表里选，并在调用工具时通过 model 传入。',
    '可选模型：' + (models.length ? models.join(' / ') : '（列表为空，请让用户先在设置里添加模型）'),
    '- 不传 model 会被拒绝；也只能从上面列表里选，不能换提供商。',
    '- 提示词优化：' + (state && state.promptOptimization === false
      ? 'Off，直接用用户原话，不要扩写；生图/改图时仍加载 skill mo-image-generation / mo-image-editing，使用其中的调用与输出规则，但不要套用提示词公式。'
      : 'On，按所选模型的方言写（可加载 skill mo-image-generation / mo-image-editing）。'),
    ...DELIVERY_RULES,
    '</mo-image-prompt>'
  ].join('\n');
}

export function promptSectionText(state) {
  const model = String((state && state.model) || '').trim();
  if (!model) return '';
  if (model === 'auto') return autoSectionText(state);
  if (state && state.promptOptimization === false) {
    return [
      '<mo-image-prompt>',
      '仅在用户需要生成/编辑图片时使用；其他任务忽略本节。',
      '当前生图模型：' + model + '。提示词优化：Off。',
      '- 不用传 model：模型由用户在选择器里决定（当前 ' + model + '）；传了不一致的值会被拒绝。',
      '- 直接使用用户原话作为 prompt；不要扩写、改写、补充风格/光线/构图，不要替用户做提示词工程。',
      '- 只做最低限度的文本整理：保留用户原话中的主体、动作、文字、语言和限制；如果用户分多段描述，可以原样拼接，不添加用户没说的内容。',
      '- 不要自动补 negative_prompt；用户原话里没有的排除项不要加。',
      '- 生图/改图时仍加载 skill mo-image-generation / mo-image-editing，使用其中的工具调用、参考图顺序和输出规则；但不要套用提示词公式、模板和自检清单。',
      '- 尺寸、质量、提供商、模型由用户选择器控制；工具不接受这些参数，不要传。',
      '- 只有用户明确要求“优化/改写提示词”时，才按当前模型方言优化，并说明这是应要求改写。',
      '- 编辑时，prompt 也只写用户原话或最小必要修改说明；images 按用户指定的参考图传。',
      ...DELIVERY_RULES,
      '</mo-image-prompt>'
    ].join('\n');
  }
  const profile = resolvePromptProfile(model, (state && state.adapter) || null);
  const editModel = String((state && state.editModel) || '').trim();
  const editProfile = editModel && editModel !== model
    ? resolvePromptProfile(editModel, (state && state.editAdapter) || (state && state.adapter) || null)
    : null;

  const lines = [];
  lines.push('<mo-image-prompt>');
  lines.push('仅在用户需要生成/编辑图片时使用；其他任务忽略本节。');
  lines.push('当前生图模型：' + model + '（' + profile.label + '）。按该模型的提示词方言写。');
  lines.push('- 不用传 model：模型由用户在选择器里决定（当前 ' + model + '）；传了不一致的值会被拒绝。');
  for (const rule of DELIVERY_RULES) lines.push(rule);
  lines.push('生成公式：' + GENERATION_FORMULA + '。');
  for (const rule of profile.rules) lines.push('- ' + rule);
  lines.push('- ' + (profile.supportsNegative
    ? '支持 negative prompt：把畸变、水印、多余文字等放进 negative_prompt。'
    : '无 negative prompt：用正面描述和硬约束表达排除项。'));
  lines.push('- 提示词语言：' + languageLabel(profile.language) + '；用户明确指定时从用户。');
  lines.push('- 尺寸、质量、提供商、模型由用户选择器控制；工具不接受这些参数，不要传。');
  lines.push('编辑公式：' + EDITING_FORMULA + '。');
  if (editProfile) {
    lines.push('编辑模型：' + editModel + '（' + editProfile.label + '）——' + editProfile.editRule);
  } else {
    lines.push('编辑：' + profile.editRule);
  }
  lines.push('完整写法：没读过时按需加载 skill mo-image-generation / mo-image-editing；读过就不用重复加载。');
  lines.push('</mo-image-prompt>');
  return lines.join('\n');
}
