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
      '结构：场景/背景 → 主体 → 关键细节 → 明确约束；不要只堆关键词。',
      '先写用途与画幅（电商主图/海报/UI/信息图/摄影），用位置词安排布局和留白。',
      '图中文字用引号原样写出，并指定字体、颜色、大小、位置。'
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
      '用完整自然语言段落（2–5 句），不要关键词列表或标签堆叠。',
      '写清主体、动作、场景、媒介/风格、光线和氛围；细节要明确。',
      '文字渲染弱：避免长文字和 logo；不要用 no/without 否定句。'
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
      '自然语言叙事：先主体/动作/场景，再构图、风格、镜头；不要只列关键词。',
      '正向描述：说“空荡的街道”而不是“没有车”。',
      '参考图公式：参考图 + 关系指令 + 新场景；按图1/图2说明用途。'
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
      '支持图1/图2参考和多图输入，按顺序说明每张图的作用。'
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
      '文字渲染强：文字放引号中，指定字体、颜色、位置和层级。',
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
      '自然语言散文，主体和动作前置；30–80 词最佳，最多约 512 tokens。',
      '顺序：主体 + 动作 + 风格/媒介 + 环境 + 光线 + 镜头/技术细节。',
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
      'SD3.5 用自然语言段落；SDXL/1.5 用逗号分隔的短语标签。',
      '写清风格/媒介、主体、构图、光线、色彩；避免互相冲突的风格词。',
      '文字渲染弱；编辑时说明保留区域和修改区域。'
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
      '写清画幅和用途；避免长文字渲染；用可画的细节替代抽象形容词。'
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
      '写清人物年龄、发型、服装、材质等可画细节；避免长文字。'
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
    '图中文字用引号；编辑时只改 X，其余保持不变，按图1/图2指代参考图。'
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
/** 尺寸这类参数旧配置里可能存成了 STRING，读的时候按名字纠正一次。 */
const NUMERIC_ROLES = new Set(['width', 'height', 'seed', 'steps', 'batch_size']);

function paramType(param) {
  const type = String(param.type || 'STRING');
  if (NUMERIC_ROLES.has(param.name) && (type === 'STRING' || type === 'string')) return 'INT';
  return type;
}

export function settingsPayload(state) {
  const provider = (state && state.provider) || null;
  const model = String((state && state.model) || '').trim();
  const optimized = !(state && state.promptOptimization === false);
  const payload = {
    provider: provider ? String(provider.id || '') : '',
    model: model,
    promptOptimization: optimized,
    canEdit: Boolean(state && state.canEdit),
    // 自动尺寸下模型可以自己填 size；固定尺寸下选择器说了算。
    sizeMode: state && state.sizeMode === 'fixed' ? 'fixed' : 'auto',
    strict: !!(state && state.strict === true),
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
    // 改图只在能图生图的模型里选；没传 model 时插件会自动取第一个。
    payload.editModels = (Array.isArray(state && state.editModels) ? state.editModels : []).filter(Boolean).map(String);
    return payload;
  }
  const profile = resolvePromptProfile(model, (state && state.adapter) || null);
  payload.hint = optimized
    ? (PROFILE_HINTS[profile.id] || profile.label) + NEED_FULL_RULES
    : '直接用用户原话，不要扩写，不要补 negative prompt';
  const sizeMode = payload.sizeMode;
  if (state && state.control) payload.control = String(state.control);
  if (sizeMode === 'fixed') {
    const fixed = String((state && state.size) || '选择器里的值');
    payload.hint += '；尺寸已固定为 ' + fixed + '，不要填 size，用户要别的形状就让他去选择器改';
  } else {
    if (state && Array.isArray(state.sizeOptions) && state.sizeOptions.length) {
      payload.sizeOptions = state.sizeOptions.map(String);
    }
    payload.hint += '；尺寸交给模型：用户要特定形状时才填 size（如 1024x1536），没要求就留空';
  }
  if (payload.strict) {
    payload.hint += '；严格模式已开：出图会被强制缩放成请求的尺寸';
  }
  const workflowParams = Array.isArray(state && state.workflowParams)
    ? state.workflowParams.filter((param) => param && param.expose !== false)
    : [];
  if (workflowParams.length) {
    // 参数只走结构化的 params，hint 里不再重复列一遍名字。
    payload.params = workflowParams.map((param) => {
      const out = { name: param.name, type: paramType(param) };
      if (Array.isArray(param.options)) out.options = param.options;
      return out;
    });
    payload.hint += '；可用 params 覆盖工作流参数，不传则用工作流默认值';
  }
  return payload;
}

/** 优化开启时补一句：完整写法只在没读过时才要加载，读完不用重复加载。 */
const NEED_FULL_RULES = '；完整写法没读过时加载对应 skill，读过就不用再加载';

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
  '- 交付即止：最终回复只输出图片行，不评价画质、不描述画面；除非用户明确要求看图，不要读图。',
  '- 只用选择器里的提供商和模型：不要自行切换，也不要用本地生图、建模、脚本绘图替代。',
  '- 失败时原样报错；可以问用户是否换模型或服务商，但不要自己换、也不要换模型重试。',
  '- 没读配置或配置刚改过时工具只交回配置、不出图：按它重写提示词再调一次；配置文件可读，写入会被拒绝。'
];

/**
 * 配置状态标记：提示词节里放占位符，由宿主按当前会话插值，所以模型每一步看到的
 * 都是这一刻的状态，而不是注册提示词时的旧值。
 */
export const CONFIG_STATE_VARIABLE = 'mo_image_config';
export const CONFIG_STATE_MARKER = '{{' + CONFIG_STATE_VARIABLE + '}}';

const CONFIG_STATE_TEXT = {
  unread: '本会话还没读过 —— 先调用 mo_image_settings',
  stale: '用户刚改过 —— 先重读 mo_image_settings',
  fresh: '和上次读到的一致 —— 不用再读，可直接生图/改图'
};

/**
 * 把配置状态翻成模型能直接照做的一句话。
 * @param {'unread'|'stale'|'fresh'} state
 */
export function configStateText(state) {
  return CONFIG_STATE_TEXT[state] || CONFIG_STATE_TEXT.unread;
}

/** Auto 行：用户把选择器设为 Auto 时，模型选择权才下放给对话模型。 */
function autoSectionText(state, marker) {
  const models = Array.isArray(state && state.models) ? state.models.filter(Boolean) : [];
  const editModels = Array.isArray(state && state.editModels) ? state.editModels.filter(Boolean) : [];
  return [
    '<mo-image-prompt>',
    '仅生成/编辑图片时使用，其他任务忽略。',
    ...(marker ? ['- 配置状态：' + marker] : []),
    '- 当前模型：Auto —— 由你从下面列表里选，调用时用 model 传入。',
    '可选模型：' + (models.length ? models.join(' / ') : '（列表为空，先让用户在设置里添加模型）'),
    '可改图模型：' + (editModels.length ? editModels.join(' / ') : '（没有支持图生图的模型，微调/重做会失败，先让用户换模型）'),
    '- 生图要传 model（只能从「可选模型」里选）；改图不传则用「可改图模型」的第一个，也可以显式指定。',
    '- 提示词优化：' + (state && state.promptOptimization === false
      ? 'Off，直接用用户原话，不要扩写；仍加载 skill mo-image-generation / mo-image-editing 的调用与输出规则，但不要套用提示词公式。'
      : 'On，按所选模型的方言写（可加载 skill mo-image-generation / mo-image-editing）。'),
    sizeRuleText(state, { modelByPicker: false }),
    ...DELIVERY_RULES,
    '</mo-image-prompt>'
  ].join('\n');
}

/**
 * 尺寸那句话。必须和 settingsPayload 的 sizeMode 一致：
 * 固定尺寸下模型不许传 size，自动尺寸下只有它能决定尺寸。
 * 严格模式与"只吃比例/根本不收尺寸"的模型各追加一句，省得模型自己发明规则。
 */
export function sizeRuleText(state, options) {
  const mode = state && state.sizeMode === 'fixed' ? 'fixed' : 'auto';
  const label = String((state && state.size) || '').trim();
  const control = String((state && state.control) || '');
  const modelByPicker = !(options && options.modelByPicker === false);
  const tail = modelByPicker
    ? '质量、提供商、模型同样由选择器控制。'
    : '模型必须从上面列表里传，提供商不能换。';
  const parts = [];
  if (mode === 'fixed') {
    parts.push('- 尺寸已固定为 ' + (label || '选择器里的值') + '，不要传 size；要别的尺寸让用户去选择器改。' + tail);
  } else {
    const sizeValues = Array.isArray(state && state.sizeOptions) ? state.sizeOptions.filter(Boolean) : [];
    parts.push('- 尺寸由你决定：用户要特定形状时才传 size（如 1024x1536），没要求就省略；' + tail
      + (sizeValues.length ? '可选尺寸：' + sizeValues.join(' / ') : ''));
  }
  if (state && state.strict === true) {
    parts.push('- 严格模式已开：成品尺寸强制等于这个值。');
  }
  if (control === 'aspect') {
    parts.push('- 该模型只吃宽高比：size 给 3:4 这类比例即可。');
  } else if (control === 'prompt') {
    parts.push('- 该模型不收尺寸：尺寸会自动写进提示词，不要重复写。');
  }
  return parts.join('\n');
}

/**
 * 生图提示词节。没有当前模型时返回空串，整节省略。
 * @param {object} state 当前生图配置
 * @param {string} [marker] 配置状态占位符；宿主不能插值时省略，这一行就不出现
 */
export function promptSectionText(state, marker) {
  const model = String((state && state.model) || '').trim();
  if (!model) return '';
  if (model === 'auto') return autoSectionText(state, marker);
  if (state && state.promptOptimization === false) {
    return [
      '<mo-image-prompt>',
      '仅生成/编辑图片时使用，其他任务忽略。',
      ...(marker ? ['- 配置状态：' + marker] : []),
      '- 当前模型：' + model + '；提示词优化：Off。',
      ...(state && state.canEdit === false ? ['- 该模型不支持图生图：微调/重做先换支持编辑的模型。'] : []),
      '- 不用传 model：用选择器里的当前模型；传了不一致的值会被拒绝。',
      '- 直接把用户原话当 prompt：不要扩写、改写，不补风格/光线/构图，不替用户做提示词工程。',
      '- 只做最低限度整理：保留主体、动作、文字、语言和限制；分段可原样拼接，不加用户没说的内容。',
      '- 不要自动补 negative_prompt：用户没说的排除项不加。',
      sizeRuleText(state),
      '- 仍加载 skill mo-image-generation / mo-image-editing 的调用、参考图顺序和输出规则；但不要套用其中的公式、模板和自检清单。',
      '- 只有用户明确要求“优化/改写提示词”时，才按当前模型方言改写，并说明是应要求改写。',
      '- 编辑时 prompt 同样只写原话或最小必要修改；images 按用户指定的参考图传。',
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
  lines.push('仅生成/编辑图片时使用，其他任务忽略。');
  if (marker) lines.push('- 配置状态：' + marker);
  lines.push('- 当前模型：' + model + '（' + profile.label + '），按其方言写。');
  if (state && state.canEdit === false) lines.push('- 该模型不支持图生图：微调/重做先换支持编辑的模型。');
  lines.push('- 不用传 model：用选择器里的当前模型；传了不一致的值会被拒绝。');
  for (const rule of DELIVERY_RULES) lines.push(rule);
  lines.push('生成公式：' + GENERATION_FORMULA + '。');
  for (const rule of profile.rules) lines.push('- ' + rule);
  lines.push('- ' + (profile.supportsNegative
    ? '支持 negative prompt：把畸变、水印、多余文字等放进 negative_prompt。'
    : '无 negative prompt：用正面描述和硬约束表达排除项。'));
  lines.push('- 提示词语言：' + languageLabel(profile.language) + '；用户明确指定时从用户。');
  lines.push(sizeRuleText(state));
  const exposedParams = Array.isArray(state && state.workflowParams) ? state.workflowParams : [];
  if (exposedParams.length) {
    // 只放一句指针：具体用途和调法在 skill 里，读过一次就不用再加载，省 token。
    lines.push('- 可调参数：' + exposedParams.map((param) => param.name).join('、')
      + '。按需主动调整，用法见 skill mo-image-generation「参数调优」；'
      + '没读过才加载，拿不准就留空。');
  }
  lines.push('编辑公式：' + EDITING_FORMULA + '。');
  if (editProfile) {
    lines.push('编辑模型：' + editModel + '（' + editProfile.label + '）——' + editProfile.editRule);
  } else {
    lines.push('编辑：' + profile.editRule);
  }
  lines.push('完整写法：按需加载 skill mo-image-generation / mo-image-editing，读过就不用重复加载。');
  lines.push('</mo-image-prompt>');
  return lines.join('\n');
}
