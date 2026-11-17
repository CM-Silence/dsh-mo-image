window.__ModuleLoader__.load({
  id: 'dsh-mo-image',
  factory: (require) => {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const createPortal = ReactDOM && typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal.bind(ReactDOM) : (node) => node;
    let DshSegmentedControl = null;
    let DshMenuSurface = null;
    let DshMenuGroup = null;
    let DshInput = null;
    let observeStickyMenuGroups = null;
    let IconChevronDown = null;
    let IconChevronRight = null;
    let IconCheck = null;
    let IconTrash = null;
    let IconPlus = null;
    let IconCloseFill = null;
    let IconDragHandle = null;
    let DshToast = null;
    let DshModal = null;
    let DshButton = null;
    let DshTooltip = null;
    let useRowDragPreviewPrimitive = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      DshSegmentedControl = primitives.SegmentedControl || null;
      DshMenuSurface = primitives.MenuSurface || null;
      DshMenuGroup = primitives.MenuGroup || null;
      DshInput = primitives.Input || null;
      observeStickyMenuGroups = primitives.observeStickyMenuGroups || null;
      IconChevronDown = primitives.IconChevronDownOutlineRegular || null;
      IconChevronRight = primitives.IconChevronRightOutlineRegular || null;
      IconCheck = primitives.IconCheckOutlineRegular || null;
      IconTrash = primitives.IconTrashOutlineRegular || null;
      IconPlus = primitives.IconPlusOutlineRegular || null;
      IconCloseFill = primitives.IconCloseFillRegular || null;
      IconDragHandle = primitives.IconDragHandleOutlineRegular || null;
      DshToast = primitives.Toast || null;
      DshModal = primitives.Modal || null;
      DshButton = primitives.Button || null;
      DshTooltip = primitives.Tooltip || null;
      useRowDragPreviewPrimitive = typeof primitives.useRowDragPreview === 'function' ? primitives.useRowDragPreview : null;
    } catch (_error) { /* optional */ }

    /** 行拖动预览是 DSH 原语；拿不到时拖动照旧，只是少了跟随指针的浮层。*/
    function useNoopRowDragPreview() {
      return React.useMemo(() => ({ start() {}, clear() { return false; } }), []);
    }
    const useModelRowDragPreview = useRowDragPreviewPrimitive || useNoopRowDragPreview;

    // 适配器、云端 provider preset 和本地部署器都由宿主下发，客户端不再维护
    // 第二份 preset/能力表；这里只保留加载后的只读快照。
    let imageCatalog = { adapters: [], providerPresets: [], localPresets: [], capabilities: [] };

    // 文案统一走 DSH 的 locale 服务；MESSAGES 由 locale/messages.csv 生成。
    const NS = 'dsh-mo-image';

    /** 没有 locale 服务时的兜底翻译（DSH Web 运行时不会走到这里）。 */
    function fallbackTranslate(key, params) {
      const table = MESSAGES.zh || {};
      const template = Object.hasOwn(table, key) ? table[key] : key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    /** 取翻译；key 不存在时返回回退值，用于宿主下发的数据（如 local preset 提示）。 */
    function translatedOr(translate, key, fallback) {
      const value = translate(key);
      return value === key ? fallback : value;
    }

    /** 把宿主返回的 code/params 展开成当前语言的完整报错；没有 code 时保留原文。 */
    function serverErrorText(translate, error) {
      const code = error && error.code ? String(error.code) : '';
      const params = error && error.params && typeof error.params === 'object' ? error.params : {};
      if (code === 'network.failed') {
        const via = params.via === 'proxy'
          ? translate('serverError.network.viaIndirect')
          : translate('serverError.network.viaDirect');
        const hint = params.hint
          ? translatedOr(translate, 'serverError.network.hint.' + params.hint, '')
          : '';
        return translate('serverError.network.format', {
          host: params.host || '', cause: params.cause || '', via: via, hint: hint
        }).trim();
      }
      if (code === 'provider.missingKey' || code === 'provider.missingKeyWithRef') {
        return params.ref
          ? translate('serverError.provider.missingKeyWithRef', { provider: params.provider || '', ref: params.ref })
          : translate('serverError.provider.missingKey', { provider: params.provider || '' });
      }
      if (code === 'upstream.http' || code === 'upstream.httpNoDetail') {
        return params.detail
          ? translate('serverError.upstream.http', { status: params.status || '', detail: params.detail })
          : translate('serverError.upstream.httpNoDetail', { status: params.status || '' });
      }
      if (code) {
        const key = 'serverError.' + code;
        const value = translate(key, params);
        if (value !== key) return value;
      }
      if (!code && error && error.name === 'AbortError') return translate('errors.localTimeout');
      if (!code && error && /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String(error.message || ''))) {
        return translate('errors.localUnreachable');
      }
      return error && error.message ? String(error.message) : String(error);
    }

    /** 把设置接口的 JSON 错误转成 Error（保留 code/params 供 serverErrorText 使用）。 */
    function responseError(data, status, fallbackKey, translate) {
      const payload = data && typeof data === 'object' ? data : {};
      const error = new Error(payload.error ? String(payload.error) : translate(fallbackKey, { status: status }));
      if (payload.code) {
        error.code = String(payload.code);
        error.params = payload.params && typeof payload.params === 'object' ? payload.params : {};
      }
      return error;
    }

    function adapterSupportsModels(id) {
      const adapter = imageCatalog.adapters.find((item) => item && item.id === id);
      return !!(adapter && adapter.supportsModels);
    }

    function providerPresetsForUi() {
      return imageCatalog.providerPresets.filter((item) => item && item.id && item.baseUrl);
    }

    function localPresetsForUi() {
      return imageCatalog.localPresets.filter((item) => item && item.id && item.adapter);
    }

    /** 端点归一化：忽略大小写和末尾斜杠；只用于比对，不参与请求。 */
    function normalizeEndpoint(value) {
      return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
    }

    /**
     * 是否内置的云端提供商：端点与宿主下发的 provider preset 一致。
     * 这类提供商有名字、有官网，不是「自定义」端点；只有用户自己填地址的才打这个标。
     */
    function isBuiltinProvider(provider) {
      const endpoint = normalizeEndpoint(provider && provider.baseUrl);
      if (!endpoint) return false;
      return providerPresetsForUi().some((preset) => normalizeEndpoint(preset.baseUrl) === endpoint);
    }

    // DSH 的组件样式是 CSS Modules：类名形如「构建前缀_语义名」。前缀会随
    // DSH 版本/构建变化，所以这里不写死完整类名，只保留语义名；运行时从当前
    // 已加载的样式表里解析出前缀，再拼成真实类名。这样 DSH 升级换了 hash，
    // 或者美化插件重写了同一批类名的样式，插件都能继续复用当前样式。
    const SETTINGS_CLASS_LOCALS = {
      section: 'section', title: 'title', intro: 'intro',
      rows: 'rows', rowCard: 'rowCard', rowHead: 'rowHead',
      rowIdentity: 'rowIdentity', rowName: 'rowName', rowTag: 'rowTag',
      credentialDot: 'credentialDot', credentialDotConfigured: 'credentialDotConfigured', credentialDotMissing: 'credentialDotMissing',
      rowActions: 'rowActions', secondaryButton: 'secondaryButton', primaryButton: 'primaryButton', dangerButton: 'dangerButton', linkButton: 'linkButton',
      addBlock: 'addBlock', addActions: 'addActions', addButton: 'addButton', addCard: 'addCard',
      addModes: 'addModes', addPanel: 'addPanel', advancedHint: 'advancedHint',
      editor: 'editor', editorHeader: 'editorHeader', editorTitle: 'editorTitle', editorRoute: 'editorRoute', editorActions: 'editorActions',
      field: 'field', fieldLabel: 'fieldLabel', input: 'input', selectInput: 'selectInput',
      customized: 'customized', customizedSummary: 'customizedSummary', customizedBody: 'customizedBody',
      // 协议 label 右侧的问号：沿用设置页的 helpButton（16×16 圆形边框、cursor:help）。
      helpButton: 'helpButton',
      modelCatalog: 'modelCatalog', modelCatalogHeading: 'modelCatalogHeading', modelCatalogTitle: 'modelCatalogTitle', modelCatalogMeta: 'modelCatalogMeta',
      modelList: 'modelList', modelListHead: 'modelListHead', modelEntry: 'modelEntry', modelRow: 'modelRow', modelEmpty: 'modelEmpty',
      addModelButton: 'addModelButton', iconButton: 'iconButton', iconButtonDanger: 'iconButtonDanger',
      // 模型行沿用 DSH 设置页的列定义：拖动把手、ID、显示名称、尾部控件。
      modelField: 'modelField', modelFieldLabel: 'modelFieldLabel', modelName: 'modelName', modelNameLabel: 'modelNameLabel',
      modelDragHandle: 'modelDragHandle', modelDragPreview: 'modelDragPreview',
      // 展开后的「模型选项」面板：沿用 DSH 设置页的 modelAdvanced 网格（grid-column: 1/-1）。
      modelAdvanced: 'modelAdvanced',
      candidate: 'candidate', candidateEmpty: 'candidateEmpty', candidateId: 'candidateId', candidateLabel: 'candidateLabel',
      candidateList: 'candidateList', candidateSearch: 'candidateSearch', candidateToolbar: 'candidateToolbar',
      fetchDialog: 'fetchDialog', error: 'error',
      // 两列数字 + 尾部控件：沿用设置页里「推理深度的最 最大」那一。
    modelReasoningRow: 'modelReasoningRow',
      modelReasoningValueInput: 'modelReasoningValueInput'
    };
    const MODEL_CLASS_LOCALS = {
      root: 'root',
      trigger: 'trigger',
      triggerIcon: 'triggerIcon',
      triggerLabel: 'triggerLabel',
      triggerEffort: 'triggerEffort',
      chevron: 'chevron',
      chevronOpen: 'chevronOpen',
      menu: 'menu',
      searchRow: 'searchRow',
      search: 'search',
      searchWithQuery: 'searchWithQuery',
      searchClear: 'searchClear',
      groups: 'groups',
      option: 'option',
      modelOption: 'modelOption',
      optionActive: 'optionActive',
      optionCopy: 'optionCopy',
      modelName: 'modelName',
      check: 'check',
      selected: 'selected',
      empty: 'empty',
      cell: 'cell',
      cellLabel: 'cellLabel',
      cellValue: 'cellValue',
      cellChevron: 'cellChevron'
    };
    // 只有运行时解析不到前缀时才用它们兜底；正常路径都以当前样式表为准。
    const CLASS_FALLBACK_PREFIX = { settings: '_3nPmjq_', model: 'wq12jW_' };
    const CLASS_STYLE_SOURCES = {
      settings: {
        packageIds: ['@deepseek-ai/dsh-client-ui-settings-models'],
        styleIds: ['ModelsSection.module.css'],
        anchors: ['modelCatalog', 'addModelButton', 'modelRow']
      },
      model: {
        packageIds: ['@deepseek-ai/dsh-client-ui-model-selection'],
        styleIds: ['ModelSelect.module.css'],
        anchors: ['triggerEffort', 'modelOption', 'triggerLabel']
      }
    };
    const resolvedClassPrefix = { ...CLASS_FALLBACK_PREFIX };
    let themeClassRevision = 0;

    function buildClassMap(locals, prefix) {
      const map = {};
      for (const key of Object.keys(locals)) map[key] = prefix + locals[key];
      return map;
    }

    /** 从 CSS 里找出「.前缀语义名」中的前缀；找不到返回空串。 */
    function classPrefixInCss(css, anchors) {
      if (!css) return '';
      for (const anchor of anchors) {
        const match = new RegExp('\\.([A-Za-z0-9_-]+?)' + anchor + '\\b').exec(css);
        if (match) return match[1];
      }
      return '';
    }

    /** 收集当前已注入的样式文本；一次刷新只遍历 DOM 一遍。 */
    function collectStyleTags() {
      const tags = [];
      if (typeof document === 'undefined') return tags;
      for (const tag of document.querySelectorAll('style')) {
        const text = tag.textContent || '';
        if (!text) continue;
        tags.push({
          text: text,
          cssId: tag.getAttribute('data-plugin-css') || '',
          owner: tag.getAttribute('data-plugin') || ''
        });
      }
      return tags;
    }

    /** 从已收集的样式里按优先级取文本；all 惰性拼接，命中 preferred 时不复制全量 CSS。 */
    function loadedStyleText(tags, packageIds, styleIds) {
      const preferred = [];
      const scoped = [];
      for (const tag of tags) {
        if (styleIds.some((id) => tag.cssId.endsWith(id))) preferred.push(tag.text);
        if (packageIds.indexOf(tag.owner) !== -1) scoped.push(tag.text);
      }
      return {
        preferred: preferred.join('\n'),
        scoped: scoped.join('\n'),
        all: () => tags.map((tag) => tag.text).join('\n')
      };
    }

    /** 优先从对话里真实渲染的 DSH 模型选择器读取类名前缀。 */
    function classPrefixFromHostModel() {
      if (typeof document === 'undefined') return '';
      const label = document.querySelector('[data-model-id]');
      const button = label && label.closest('button[aria-haspopup="menu"]');
      if (!button) return '';
      const root = button.parentElement;
      if (root) {
        for (const name of root.classList) {
          if (name.length > 5 && name.endsWith('_root')) return name.slice(0, -'root'.length);
        }
      }
      for (const name of button.classList) {
        if (name.length > 8 && name.endsWith('_trigger')) return name.slice(0, -'trigger'.length);
      }
      return '';
    }

    /** 最后兜底：直接从 CSSOM 读规则文本，兼容不用 <style> 注入的实现。 */
    function cssomText() {
      if (typeof document === 'undefined') return '';
      let text = '';
      const collect = (sheet) => {
        try {
          for (const rule of sheet.cssRules) text += rule.cssText + '\n';
        } catch (_error) { /* 跨域或已失效的样式表 */ }
      };
      for (const sheet of document.styleSheets) collect(sheet);
      for (const sheet of document.adoptedStyleSheets || []) collect(sheet);
      return text;
    }

    function resolveClassPrefix(kind, tags) {
      const source = CLASS_STYLE_SOURCES[kind];
      const styles = loadedStyleText(tags, source.packageIds, source.styleIds);
      const cssPrefix = classPrefixInCss(styles.preferred, source.anchors)
        || classPrefixInCss(styles.scoped, source.anchors)
        || classPrefixInCss(styles.all(), source.anchors)
        || classPrefixInCss(cssomText(), source.anchors);
      if (cssPrefix) return cssPrefix;
      // 样式表还没注入时，再退回对话里真实渲染的模型选择器。
  return kind === 'model' ? classPrefixFromHostModel() : '';
    }

    let MC = buildClassMap(SETTINGS_CLASS_LOCALS, resolvedClassPrefix.settings);
    let MS = buildClassMap(MODEL_CLASS_LOCALS, resolvedClassPrefix.model);

    // ── 生图席的皮肤 ──────────────────────────────────────────────────
    // official：宿主原版对话模型选择器（优先，类 材质/键盘行为全部对齐）。
    // codex   ：检测到 dsh-codex-model-effort-selector 接管了对话席时，直接复用
    //           它的 cmes-* 全局类名 DOM 形状，让两个席看起来是同一套皮肤。
    // generic ：未知的接管型美化插件。没公共协议，只能采样它触发器的实际样式。
    //           弹层回退到原版材质；保证并排不违和，不承诺像素级。
    const SEAT_SKIN = { OFFICIAL: 'official', CODEX: 'codex', GENERIC: 'generic' };
    let resolvedSeatSkin = SEAT_SKIN.OFFICIAL;

    function detectSeatSkinFromMarkers(markers) {
      const source = markers || {};
      if (source.codex) return SEAT_SKIN.CODEX;
      if (source.official) return SEAT_SKIN.OFFICIAL;
      if (source.generic) return SEAT_SKIN.GENERIC;
      return SEAT_SKIN.OFFICIAL;
    }

    /** 找到和生图席同一排的对话模型触发器；找不到就不冒 generic。*/
    function findChatTriggerNear(seatEl) {
      if (!seatEl || typeof seatEl.closest !== 'function') return null;
      let node = seatEl;
      // 只往上找三层：slot 包装  standardControls  输入行。再往上就会碰。
      // 左侧的权 计划按钮，把普通的 aria-haspopup 误认成模型选择器。
  for (let depth = 0; depth < 3 && node; depth += 1) {
        node = node.parentElement;
        if (!node || typeof node.querySelectorAll !== 'function') break;
        const buttons = node.querySelectorAll('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]');
        for (const button of buttons) {
          if (!seatEl.contains(button)) return button;
        }
        if (node.querySelectorAll('button').length > 10) break;
      }
      return null;
    }

    function codexSkinProbe() {
      if (typeof document === 'undefined') return { present: false, ready: false };
      let trigger = null;
      for (const candidate of document.querySelectorAll('.cmes-trigger')) {
        if (!candidate || (typeof candidate.closest === 'function' && candidate.closest('[data-mo-image-seat]'))) continue;
        trigger = candidate;
        break;
      }
      if (!trigger) return { present: false, ready: false };
      let textReady = false;
      for (const tag of document.querySelectorAll('style')) {
        if (String(tag.textContent || '').includes('.cmes-popover')) { textReady = true; break; }
      }
      // The codex popover is portaled to <body>, so it is NOT inside the
      // `.cmes-root` that owns the trigger. Probe the document instead, but
      // exclude our own codex-skin popover.
      let popover = null;
      for (const candidate of document.querySelectorAll('.cmes-popover')) {
        if (!candidate || candidate.id === 'mo-image-codex-popover') continue;
        if (typeof candidate.closest === 'function' && candidate.closest('[data-mo-image-seat]')) continue;
        popover = candidate;
        break;
      }
      if (!popover) return { present: true, ready: textReady };
      const page = typeof popover.querySelector === 'function' ? popover.querySelector('.cmes-page') : null;
      if (!page) return { present: true, ready: false };
      let fixed = true;
      try {
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          fixed = window.getComputedStyle(popover).position === 'fixed';
        }
      } catch (_error) { fixed = true; }
      return { present: true, ready: fixed };
    }

    // 未知接管型皮肤没有公共协议：只采样它触发器的实际尺寸/字体/颜色，套。
    // 我们的触发器上；弹层仍走原版材质。够用，但不承诺像素级一致。
    const TRIGGER_STYLE_KEYS = [
      'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'gap', 'fontSize', 'lineHeight', 'color', 'borderRadius', 'maxWidth', 'fontFamily'
    ];
    function pickTriggerStyle(computed) {
      if (!computed) return null;
      const out = {};
      let found = false;
      for (const key of TRIGGER_STYLE_KEYS) {
        const value = computed[key];
        if (typeof value === 'string' && value) { out[key] = value; found = true; }
      }
      return found ? out : null;
    }
    function genericChatTriggerStyle() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return null;
      if (typeof window.getComputedStyle !== 'function') return null;
      const seat = document.querySelector('[data-mo-image-seat]');
      const trigger = findChatTriggerNear(seat);
      if (!trigger) return null;
      try { return pickTriggerStyle(window.getComputedStyle(trigger)); } catch (_error) { return null; }
    }

    function detectSeatSkin() {
      if (typeof document === 'undefined') return SEAT_SKIN.OFFICIAL;
      const codex = codexSkinProbe();
      if (codex.ready) return SEAT_SKIN.CODEX;
      // A codex trigger exists but its CSS/DOM contract is incomplete: do not
      // paint half-codex, and do not sample it as generic either.
      if (codex.present) return SEAT_SKIN.OFFICIAL;
      if (document.querySelector('[data-model-id]')) return SEAT_SKIN.OFFICIAL;
      const seat = document.querySelector('[data-mo-image-seat]');
      const chat = findChatTriggerNear(seat);
      return detectSeatSkinFromMarkers({ generic: !!chat });
    }

    function seatSkinNow() {
      return resolvedSeatSkin;
    }

    function refreshClassPrefixes() {
      let changed = false;
      const tags = collectStyleTags();
      for (const kind of Object.keys(CLASS_STYLE_SOURCES)) {
        const prefix = resolveClassPrefix(kind, tags);
        if (prefix && prefix !== resolvedClassPrefix[kind]) {
          resolvedClassPrefix[kind] = prefix;
          changed = true;
        }
      }
      if (!changed) return false;
      MC = buildClassMap(SETTINGS_CLASS_LOCALS, resolvedClassPrefix.settings);
      MS = buildClassMap(MODEL_CLASS_LOCALS, resolvedClassPrefix.model);
      return true;
    }
    function refreshSeatSkin() {
      const skin = detectSeatSkin();
      if (skin === resolvedSeatSkin) return false;
      resolvedSeatSkin = skin;
      return true;
    }
    /** 重新解析类名前缀与皮肤；变化时通知已挂载的组件重绘。*/
    function refreshThemeClasses() {
      const prefixesChanged = refreshClassPrefixes();
      const skinChanged = refreshSeatSkin();
      if (!prefixesChanged && !skinChanged) return false;
      themeClassRevision += 1;
      try { window.dispatchEvent(new Event('mo-image-theme')); } catch (_error) { /* ignore */ }
      return true;
    }

    // ── Codex 皮肤的几何与粒子 ────────────────────────────────────────
    // 几何取自 dsh-codex-model-effort-selector（MIT）的实测值：272×104 卡片。
    // 30px 旋钮 2px 内缩轨道。这里只保留生图席需要的部分。
    const CODEX_POPOVER_WIDTH = 272;
    const CODEX_QUALITY_HEIGHT = 104;
    const CODEX_MARGIN = 12;
    // Mirrors the upstream CSS metrics (codex 1.1.2). Keep them in one place:
    // when upstream changes a row height, these are the only numbers to revisit.
    const CODEX_METRICS = {
      pad: 20,
      head: 36,
      row: 41,
      model: 39,
      listMax: 252,
      listPad: 4,
      search: 40,
      empty: 48,
      section: 30
    };

    function codexPlacement(rect, viewport, width, margin) {
      const pad = Number.isFinite(margin) ? margin : CODEX_MARGIN;
      const viewWidth = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
      const viewHeight = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
      const boxWidth = Number.isFinite(width) ? width : CODEX_POPOVER_WIDTH;
      const trigger = rect || { left: 0, top: 0, width: 0 };
      const bottom = Math.max(pad, viewHeight - Number(trigger.top || 0) + 8);
      const rawLeft = Number(trigger.left || 0) + Number(trigger.width || 0) - boxWidth;
      const maxLeft = Math.max(pad, viewWidth - boxWidth - pad);
      return {
        left: Math.min(Math.max(rawLeft, pad), maxLeft),
        bottom: bottom
      };
    }

    // 星尘相位用黄金比低差异序列、高度用独立哈希，保证重渲染不跳变。
    const CODEX_PHI = 0.6180339887498949;
    function codexHash01(n) {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    }
    function buildCodexSparkles(count) {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const b = 0.5 + 0.5 * codexHash01(i * 7 + 3);
        out.push({
          key: i,
          x: (4 + 92 * codexHash01(i * 17 + 9)).toFixed(1) + '%',
          top: (8 + 84 * codexHash01(i * 13 + 5)).toFixed(1) + '%',
          b: b.toFixed(2),
          dur: (1.6 + 2.4 * codexHash01(i * 3 + 11)).toFixed(2) + 's',
          delay: (-(i * CODEX_PHI % 1) * 4).toFixed(2) + 's'
        });
      }
      return out;
    }

    // Codex 皮肤浅色/深色两套色板（MIT，dsh-codex-model-effort-selector）。
    // 生图质量档复用它：蓝  紫，峰值档才点燃紫罗兰。
    const CODEX_FILL = {
      off: '#8a8a8f', minimal: '#4a8ef8', low: '#3a83f7', medium: '#4a72f2',
      high: '#5f5ce8', xhigh: '#7b48e8', max: '#914ef6'
    };
    const CODEX_INK = {
      off: '#707073', minimal: '#2b62bd', low: '#2f6fd0', medium: '#3a55b8',
      high: '#4a3fc0', xhigh: '#6a35c8', max: '#8b46ee'
    };
    const CODEX_FILL_DARK = {
      off: '#737378', minimal: '#3684ff', low: '#448dff', medium: '#6e90ff',
      high: '#928fff', xhigh: '#b18dff', max: '#bd91ff'
    };
    const CODEX_INK_DARK = {
      off: '#a9a9ae', minimal: '#73a9ff', low: '#76aafe', medium: '#8ba7ff',
      high: '#a4a2ff', xhigh: '#bc9cff', max: '#c39bff'
    };
    function codexFillFor(value, dark) {
      const bucket = qualityBucketOf(value);
      if (bucket) return (dark ? CODEX_FILL_DARK : CODEX_FILL)[bucket];
      return dark ? '#448dff' : '#3a83f7';
    }
    function codexInkFor(value, dark) {
      const bucket = qualityBucketOf(value);
      if (bucket) return (dark ? CODEX_INK_DARK : CODEX_INK)[bucket];
      return dark ? '#76aafe' : '#2f6fd0';
    }
    function codexMixHex(a, b, t) {
      const pa = [1, 3, 5].map((index) => parseInt(String(a).substr(index, 2), 16));
      const pb = [1, 3, 5].map((index) => parseInt(String(b).substr(index, 2), 16));
      const out = pa.map((value, index) => Math.round(value + (pb[index] - value) * t));
      return '#' + out.map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    function codexTrackFor(fill, dark) {
      return codexMixHex(dark ? '#232324' : '#e8e7e8', fill, 0.22);
    }

    // 一次性抵达峰值档的粒子绽放；确定性哈希，重渲染不会重排。
    function buildCodexBloom(count) {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const side = i % 2 === 0 ? 1 : -1;
        const t = codexHash01(i * 5 + 2);
        const deg = side > 0 ? 108 + 56 * t : 180 + (72 - 56 * t);
        const angle = deg * Math.PI / 180;
        const near = 9 + 5 * codexHash01(i * 11 + 7);
        const far = 0.72 + 0.55 * codexHash01(i * 17 + 3);
        const rx = 34 + 12 * codexHash01(i * 23 + 13);
        const ry = 20 + 9 * codexHash01(i * 29 + 19);
        out.push({
          key: i,
          x0: (Math.cos(angle) * near).toFixed(1) + 'px',
          y0: (Math.sin(angle) * near).toFixed(1) + 'px',
          x1: (Math.cos(angle) * rx * far).toFixed(1) + 'px',
          y1: (Math.sin(angle) * ry * far).toFixed(1) + 'px',
          sz: (3.4 + 2.6 * codexHash01(i * 31 + 5)).toFixed(1) + 'px',
          bmax: (0.70 + 0.30 * codexHash01(i * 37 + 23)).toFixed(2),
          bd: (0.6 + 0.3 * codexHash01(i * 41 + 11)).toFixed(2) + 's',
          bdel: (0.05 * codexHash01(i * 43 + 17)).toFixed(3) + 's'
        });
      }
      return out;
    }

    function useThemeClassRevision() {
      const [, setRevision] = React.useState(0);
      React.useEffect(() => {
        const sync = () => setRevision(themeClassRevision);
        window.addEventListener('mo-image-theme', sync);
        sync();
        return () => window.removeEventListener('mo-image-theme', sync);
      }, []);
    }

    // 质量档位由宿主按「当前模型」下发；不同适配器的挡位名称、数量都不同，
    // 不支持的模型直接隐藏这一栏。
    const IMAGE_DEFAULT_QUALITY = 'high';
    const IMAGE_MIN_SIDE = 64;
    const IMAGE_MAX_SIDE = 4096;

    function normalizeQuality(value) {
      const raw = String(value || '').trim().toLowerCase();
      // 档位可以自定义（模型选项里能加），这里只做结构兜底，和服务端保持同一套口径。
      return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(raw) ? raw : IMAGE_DEFAULT_QUALITY;
    }

    function qualitySpecFor(providerId, model) {
      const provider = imageCatalog.capabilities.find((item) => item && item.providerId === providerId);
      const entry = provider && Array.isArray(provider.models)
        ? provider.models.find((item) => item && item.model === model)
        : undefined;
      const spec = entry && entry.quality;
      return spec && Array.isArray(spec.options) && spec.options.length ? spec : null;
    }

    /**
     * 尺寸能力：由宿主按「提供商 + 模型」下发，查不到就按宽高输入框渲染。
     * control: 'wh' | 'aspect' | 'preset' | 'prompt'
     */
    function sizeSpecFor(providerId, model) {
      const provider = imageCatalog.capabilities.find((item) => item && item.providerId === providerId);
      const entry = provider && Array.isArray(provider.models)
        ? provider.models.find((item) => item && item.model === model)
        : undefined;
      const spec = entry && entry.size;
      return spec && typeof spec === 'object' ? spec : null;
    }

    function sizeControlOf(spec) {
      const control = spec && spec.control ? String(spec.control) : 'wh';
      return ['wh', 'aspect', 'preset', 'prompt'].includes(control) ? control : 'wh';
    }

    /**
     * 面板上的「有效编码方式」：用户没选（空串）时按适配器下发的形态推导。
     * 只用来决定参数名 label 与要摆几个输入，不参与线上取值（写入的仍是 `mode`）。
     * prompt 单独留一档：那种模型不发字段名，面板就不该摆一个改不了任何东西的输入。
     */
    function effectiveSizeMode(mode, spec) {
      const picked = String(mode || '');
      if (picked) return picked;
      const style = String((spec && spec.style) || 'string');
      const control = sizeControlOf(spec);
      if (style === 'width-height') return 'wh-fields';
      if (style === 'aspect' || control === 'aspect') return 'aspect';
      if (control === 'prompt') return 'prompt';
      return 'wh-string';
    }

    /* ── 参数键与键锁 ────────────────────────────────────────────────
     *
     * 模型选项里可以单独上锁的七个键。锁的语义是「该值不可被修改」：输入框禁用，
     * 一键配置与单点自动检测都跳过它。锁状态只存与默认不同的键。
     *
     * 默认锁状态只看「这个提供商是不是从预设带来的」（provider.presetId）：
     *   有 presetId → 全锁（预设已经把字段模板配好了，面板只该显示摘要）；
     *   没有 → 不锁（自配的网关与老配置都要能直接改）。
     * 早先按 adapter !== 'custom' 判，会把 adapter 为空的中转站一起锁死——那是最常见的一档，
     * 也是这次改回「看来源」的原因。老配置没有 presetId，按不锁处理（宁可放宽）。
     */
    const PARAM_KEYS = ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image'];
    const PARAM_LABELS = {
      size: 'form.paramSize', quality: 'form.paramQuality', prompt: 'form.paramPrompt',
      negative: 'form.paramNegative', model: 'form.paramModel', n: 'form.paramN', image: 'form.paramImage'
    };
    /** 六个逻辑字段里由「字段模板」管的五个（尺寸与质量各自单独一块）。 */
    const FIELD_KEYS = ['prompt', 'negative', 'model', 'n', 'image'];

    /** 从预设创建的提供商（有 presetId）默认全锁；其余一律默认不锁。 */
    function lockDefaultsFor(provider) {
      const locked = Boolean(provider && String(provider.presetId || '').trim());
      const out = {};
      for (const key of PARAM_KEYS) out[key] = locked;
      return out;
    }

    /** 某个模型当前的锁状态（缺省项按提供商的默认值补）。 */
    function lockedMapOf(entry, provider) {
      const defaults = lockDefaultsFor(provider);
      const raw = entry && entry.locked && typeof entry.locked === 'object' && !Array.isArray(entry.locked)
        ? entry.locked
        : {};
      const out = {};
      for (const key of PARAM_KEYS) out[key] = typeof raw[key] === 'boolean' ? raw[key] : defaults[key];
      return out;
    }

    /** 写一个键的锁；与默认值相同的就不写，配置里只留被改过的那几个。 */
    function writeLock(entry, key, locked, provider) {
      const defaults = lockDefaultsFor(provider);
      const raw = entry && entry.locked && typeof entry.locked === 'object' && !Array.isArray(entry.locked)
        ? entry.locked
        : {};
      const next = {};
      for (const name of PARAM_KEYS) {
        const value = name === key ? !!locked : (typeof raw[name] === 'boolean' ? raw[name] : defaults[name]);
        if (value !== defaults[name]) next[name] = value;
      }
      if (Object.keys(next).length) entry.locked = next;
      else delete entry.locked;
    }

    /** 「全部解锁」：省得解锁一个预设提供商要连点七次。 */
    function writeAllLocks(entry, locked, provider) {
      const defaults = lockDefaultsFor(provider);
      const next = {};
      for (const key of PARAM_KEYS) if (!!locked !== defaults[key]) next[key] = !!locked;
      if (Object.keys(next).length) entry.locked = next;
      else delete entry.locked;
    }

    /** 字段模板的「写在哪」：路径 / 按序号展开的名字 / multipart 字段名都算。 */
    function fieldPathOf(template) {
      if (!template || typeof template !== 'object' || Array.isArray(template)) return '';
      if (typeof template.path === 'string' && template.path.trim()) return template.path.trim();
      if (typeof template.numbered === 'string' && template.numbered.trim()) return template.numbered.trim();
      if (typeof template.multipart === 'string' && template.multipart.trim()) return template.multipart.trim();
      return '';
    }

    /** 编辑字段名时保留模板原来的形状：multipart / numbered 不会被手填改成扁平路径。 */
    function fieldKindOf(template) {
      if (!template || typeof template !== 'object' || Array.isArray(template)) return 'path';
      if ('multipart' in template) return 'multipart';
      if ('numbered' in template) return 'numbered';
      return 'path';
    }

    function fieldTemplateOf(kind, name, as) {
      const template = kind === 'multipart' ? { multipart: name } : kind === 'numbered' ? { numbered: name } : { path: name };
      if (as) template.as = as;
      return template;
    }

    /**
     * 检测路由的返回 → `{ [model]: { rule, fields, matched } }`。
     * 批量与单点共用这一份形状，面板与合并逻辑都不再关心接口长什么样。
     */
    function ruleEntriesOf(data) {
      const out = {};
      const rules = (data && data.rules) || {};
      const matchedMap = data && data.matched && typeof data.matched === 'object' ? data.matched : null;
      for (const model of Object.keys(rules)) {
        out[model] = {
          rule: rules[model] && typeof rules[model] === 'object' ? rules[model] : {},
          fields: data && data.fields && typeof data.fields === 'object' ? (data.fields[model] || null) : null,
          // 老宿主没有 matched 表：宁可当成命中，也不要让面板突然什么都不填。
          matched: matchedMap ? matchedMap[model] === true : true
        };
      }
      return out;
    }

    /** 尺寸规则 → modelOptions 里能存的覆盖对象（domain 只属于规则，不落盘）。 */
    function sizeOverrideFromRule(size) {
      if (!size || typeof size !== 'object') return null;
      const mode = typeof size.mode === 'string' ? size.mode.trim() : '';
      // mode none 表示不发这个字段，没有值可写；写进去也只会变成一条空覆盖。
      if (!mode || mode === 'none') return null;
      const next = { mode: mode };
      if (typeof size.field === 'string' && size.field.trim()) next.field = size.field.trim();
      if (typeof size.separator === 'string' && size.separator.trim()) next.separator = size.separator.trim();
      // 规则点名的面板控件（向量模型是「面板给比例、线上发像素」）：不抄过去的话，
      // 覆盖层会把 control 推回宽高，面板控件就变了。
      if (typeof size.control === 'string' && size.control.trim()) next.control = size.control.trim();
      if (size.second && typeof size.second === 'object' && size.second.field) {
        next.second = {
          from: size.second.from === 'tier' ? 'tier' : 'aspect',
          field: String(size.second.field)
        };
      }
      return next;
    }

    /** 质量规则 → modelOptions 里能存的覆盖对象。 */
    function qualityOverrideFromRule(quality) {
      if (!quality || typeof quality !== 'object') return null;
      const next = {};
      if (typeof quality.field === 'string' && quality.field.trim()) next.field = quality.field.trim();
      if (Array.isArray(quality.options) && quality.options.length) next.options = quality.options.map(String);
      if (quality.map && typeof quality.map === 'object' && !Array.isArray(quality.map)) next.map = { ...quality.map };
      if (typeof quality.default === 'string' && quality.default.trim()) next.default = quality.default.trim();
      return Object.keys(next).length ? next : null;
    }

    /**
     * 把一次规则检测并进 modelOptions：一键配置（lock=true）与单点自动检测（lock=false）
     * 共用这一份合并逻辑。
     *
     * 合并顺序（逐模型、逐键）：
     *   1. `matched === false` 的模型一个键都不写（规则没认出它，写了也只是把兜底冻住）；
     *   2. 上锁的键直接跳过——这正是锁的意义；
     *   3. 尺寸只在规则给了 mode 且不是 `none` 时写；质量只在规则命中时写
     *      （并在字段模板里没有 quality 时补一条 `{ path }`，否则质量参数永远发不出去）；
     *   4. 五个字段模板只在规则给出非 null 模板时写（null = 显式不发，不落盘）；
     *   5. `lock: true` 时，写过的键顺手锁上。
     *
     * @returns {{ modelOptions: object, configured: number, unmatched: number, skipped: number }}
     */
    function mergeRuleResult(provider, modelOptions, entries, options) {
      const source = modelOptions && typeof modelOptions === 'object' ? modelOptions : {};
      const out = { ...source };
      const lockWritten = !!(options && options.lock === true);
      const only = options && Array.isArray(options.models) ? options.models : null;
      const models = only || Object.keys(entries || {});
      const stats = { configured: 0, unmatched: 0, skipped: 0 };
      for (const model of models) {
        const hit = entries && entries[model];
        if (!hit) continue;
        if (hit.matched === false) { stats.unmatched += 1; continue; }
        const entry = { ...(out[model] || {}) };
        const locks = lockedMapOf(entry, provider);
        let wrote = 0;
        let held = 0;
        const apply = (key, put) => {
          if (locks[key]) { held += 1; return; }
          put();
          if (lockWritten) writeLock(entry, key, true, provider);
          wrote += 1;
        };
        const size = sizeOverrideFromRule(hit.rule && hit.rule.size);
        if (size) apply('size', () => { entry.size = size; });
        const quality = qualityOverrideFromRule(hit.rule && hit.rule.quality);
        if (quality) {
          apply('quality', () => {
            entry.quality = quality;
            // 质量参数的闸门是字段模板：模板里没有 quality 的话，写多少档位也发不出去。
            const fields = { ...(entry.fields || {}) };
            const hasQuality = fields.quality !== undefined && fields.quality !== null && fields.quality !== false;
            if (!hasQuality && typeof quality.field === 'string' && quality.field) {
              fields.quality = { path: quality.field };
              entry.fields = fields;
            }
          });
        }
        const resolved = hit.fields && typeof hit.fields === 'object' ? hit.fields : null;
        if (resolved) {
          for (const key of FIELD_KEYS) {
            const spec = resolved[key];
            // 没给（undefined）与显式不发（null）都不写：规则已经决定了不发，落盘只会挡住后续重试。
            if (spec === undefined || spec === null || spec === false) continue;
            apply(key, () => {
              const fields = { ...(entry.fields || {}) };
              fields[key] = spec;
              entry.fields = fields;
            });
          }
        }
        if (wrote) { stats.configured += 1; out[model] = entry; }
        else if (held) stats.skipped += 1;
        else stats.unmatched += 1;
      }
      return { modelOptions: out, configured: stats.configured, unmatched: stats.unmatched, skipped: stats.skipped };
    }

    /** 尺寸的一级显示值：和面板里实际的控件保持一致。 */
    function sizeValueLabel(spec, defaults, translate) {
      const t = translate || fallbackTranslate;
      if (!defaults || defaults.auto) return t('seat.sizeAutoValue');
      const control = sizeControlOf(spec);
      if (control === 'aspect') {
        const aspects = spec && Array.isArray(spec.aspects) ? spec.aspects : [];
        const aspect = String(defaults.aspect || '') || String(aspects[0] || '');
        const tier = String(defaults.tier || '');
        return [aspect, tier].filter(Boolean).join(' · ') || t('seat.sizeAutoValue');
      }
      if (control === 'preset') {
        const preset = String(defaults.preset || '');
        return /^\d+x\d+$/.test(preset) ? preset.split('x').join(' × ') : preset;
      }
      return defaults.width + ' × ' + defaults.height;
    }

    function qualityValueFor(value, spec) {
      const raw = normalizeQuality(value);
      if (spec) {
        if (spec.options.some((item) => item.value === raw)) return raw;
        if (spec.default && spec.options.some((item) => item.value === spec.default)) return spec.default;
        return spec.options[0].value;
      }
      return raw;
    }

    function qualityLabelFor(value, spec, translate) {
      if (!spec) return '';
      const wanted = qualityValueFor(value, spec);
      const hit = spec.options.find((item) => item.value === wanted);
      return translatedOr(translate || fallbackTranslate, 'quality.' + wanted, hit ? hit.label : wanted);
    }

    // ── 质量滑条（Codex 皮肤的「推理强度」位 ──────────────────────────
    // 生图适配器下发的 options 已经是语义顺序（off    max）。Auto 是模。
    // 不是画质档，紧挨着 Off 放，避免它被当成最高档排到滑条最右端。
    function orderedQualityLevels(options) {
      const list = Array.isArray(options) ? options.slice() : [];
      const autoAt = list.findIndex((item) => item && item.value === 'auto');
      if (autoAt < 0) return list;
      const auto = list.splice(autoAt, 1)[0];
      const offAt = list.findIndex((item) => item && item.value === 'off');
      list.splice(offAt >= 0 ? offAt + 1 : 0, 0, auto);
      return list;
    }
    function qualityRailLevels(spec) {
      if (!spec || !Array.isArray(spec.options)) return [];
      return orderedQualityLevels(spec.options)
        .map((item) => ({
          value: String(item && item.value || '').trim().toLowerCase(),
          label: String(item && item.label || '')
        }))
        .filter((item) => item.value);
    }
    // 复用 Codex 推理档的色相轴（  紫）与每档上限；auto/未知值返 null。
    //  fillFor 走兜底色，不冒充「Ultra」。
    const QUALITY_BUCKET = {
      off: 'off',
      turbo: 'minimal',
      low: 'low',
      minimal: 'low',
      standard: 'medium',
      medium: 'medium',
      default: 'medium',
      high: 'high',
      hd: 'xhigh',
      quality: 'xhigh',
      xhigh: 'xhigh',
      max: 'max',
      ultra: 'max'
    };
    function qualityBucketOf(value) {
      return QUALITY_BUCKET[String(value || '').trim().toLowerCase()] || null;
    }

    function clampSide(value, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return fallback;
      return Math.min(IMAGE_MAX_SIDE, Math.max(IMAGE_MIN_SIDE, Math.round(number)));
    }

    function normalizeDefaults(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      let width = Number(source.width) || 0;
      let height = Number(source.height) || 0;
      if (!width || !height) {
        // 兼容上一版的 { size: "1024x1024" }
        const legacy = /^(\d{2,5})x(\d{2,5})$/.exec(String(source.size || '').trim().toLowerCase());
        if (legacy) { width = Number(legacy[1]); height = Number(legacy[2]); }
      }
      const side = { width: clampSide(width, 1024), height: clampSide(height, 1024) };
      return {
        quality: normalizeQuality(source.quality),
        auto: source.auto === undefined ? true : !!source.auto,
        width: side.width,
        height: side.height,
        // 尺寸的另外三个形态（比例 / 档位 / 白名单值）与 strict 必须原样带过，
        // 少一个就会在写回时被这个归一化吃掉——勾了没反应就是这么来的。
        aspect: String(source.aspect || '').trim(),
        tier: String(source.tier || '').trim(),
        preset: String(source.preset || '').trim() || (side.width + 'x' + side.height),
        strict: !!source.strict,
        promptOptimization: source.promptOptimization === undefined ? true : !!source.promptOptimization
      };
    }

    function sizeLabelOf(defaults, translate, spec) {
      return sizeValueLabel(spec, defaults, translate);
    }

    function makeId() {
      return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function modelDisplayName(provider, model) {
      const id = String(model || '');
      const alias = provider && provider.names && typeof provider.names[id] === 'string' ? provider.names[id].trim() : '';
      return alias || id;
    }

    // Both skins render the same seat; keep the store reads and writes here so
    // official and codex can never drift apart on "no model" or quality fallback.
    function deriveSeatView(store, translate, qualitySpecOverride) {
      const safe = store || { providers: [], active: { providerId: '', model: '' }, defaults: normalizeDefaults(null) };
      const providers = Array.isArray(safe.providers) ? safe.providers : [];
      const defaults = safe.defaults || normalizeDefaults(null);
      const active = activeImageConfig(safe);
      const activeProvider = providers.find((provider) => provider.id === active.providerId) || providers[0] || null;
      const hasAnyModel = providers.some((provider) => Array.isArray(provider.models) && provider.models.length > 0);
      const activeModelName = hasAnyModel && active.model === 'auto'
        ? translate('seat.auto')
        : (hasAnyModel && active.model ? modelDisplayName(activeProvider, active.model) : '');
      const qualitySpec = qualitySpecOverride !== undefined
        ? qualitySpecOverride
        : qualitySpecFor(active.providerId, active.model);
      return {
        defaults: defaults,
        active: active,
        activeProvider: activeProvider,
        hasAnyModel: hasAnyModel,
        activeModelName: activeModelName,
        triggerLabel: activeModelName || translate('seat.fallback'),
        qualitySpec: qualitySpec,
        qualityValue: qualityValueFor(defaults.quality, qualitySpec),
        qualityLabel: qualityLabelFor(defaults.quality, qualitySpec, translate)
      };
    }
    function commitSeatDefaults(store, defaults, setStore, patch, translate) {
      const next = writeImageStore({ ...store, defaults: { ...defaults, ...patch } }, translate);
      setStore(next);
      return next;
    }
    function commitSeatModel(store, defaults, setStore, providerId, model, translate) {
      const targetSpec = qualitySpecFor(providerId, model);
      const next = writeImageStore({
        ...store,
        active: { providerId: providerId, model: model },
        defaults: { ...defaults, quality: targetSpec ? qualityValueFor(defaults.quality, targetSpec) : defaults.quality }
      }, translate);
      setStore(next);
      return next;
    }

    const normalizeCache = new WeakMap();
    const normalizedStores = new WeakSet();

    function normalizeImageStore(raw) {
      if (raw && typeof raw === 'object') {
        if (normalizedStores.has(raw)) return raw;
        const cached = normalizeCache.get(raw);
        if (cached) return cached;
      }
      const out = normalizeImageStoreUncached(raw);
      if (raw && typeof raw === 'object') normalizeCache.set(raw, out);
      normalizedStores.add(out);
      return out;
    }

    function normalizeImageStoreUncached(raw) {
      const out = { providers: [], active: { providerId: '', model: '' }, defaults: normalizeDefaults(raw && raw.defaults) };
      if (!raw || typeof raw !== 'object') return out;
      if (Array.isArray(raw.providers)) {
        const seen = new Set();
        out.providers = raw.providers.map((item, i) => {
          const p = item && typeof item === 'object' ? item : {};
          const id = String(p.id || makeId());
          const models = Array.from(new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m || '').trim()).filter(Boolean)));
          const names = {};
          if (p.names && typeof p.names === 'object') {
            for (const model of models) {
              if (typeof p.names[model] === 'string') names[model] = p.names[model];
            }
          }
          // 服务端才 provider 字段的权威；这里保留未知字段，避免客户端白名。
          //  normalizeConfig 漂移（adapter/protocol 就曾因此丢失）。
  return {
            ...p,
            id: id,
            name: String(p.name || ''),
            baseUrl: String(p.baseUrl || ''),
            key: String(p.key || ''),
            apiKeyEnv: String(p.apiKeyEnv || ''),
            keySource: String(p.keySource || ''),
            adapter: String(p.adapter || ''),
            customEndpoints: { ...(p.customEndpoints || {}) },
            protocol: String(p.protocol || 'openai-images'),
            hasKey: !!(p.hasKey || p.key),
            optionalKey: !!p.optionalKey,
            models: models,
            names: names
          };
        });
        const active = raw.active || {};
        const provider = out.providers.find((p) => p.id === active.providerId) || out.providers.find((p) => p.models.length);
        if (provider) {
          const model = (active.model === 'auto' || provider.models.includes(active.model)) ? active.model : (provider.models[0] || '');
          out.active = { providerId: provider.id, model: model };
        }
        return out;
      }
      if (raw.baseUrl || raw.model) {
        const models = raw.model ? [String(raw.model)] : [];
        const provider = {
          id: makeId(), name: '', baseUrl: String(raw.baseUrl || ''),
          key: String(raw.key || ''), apiKeyEnv: '', keySource: '', adapter: '', protocol: 'openai-images', hasKey: !!raw.key, optionalKey: false, models: models, names: {}
        };
        out.providers = [provider];
        out.active = { providerId: provider.id, model: models[0] || '' };
      }
      return out;
    }

    let imageStoreCache = { providers: [], active: { providerId: '', model: '' } };
    let imageStoreLoaded = false;
    let imageStoreLoadPromise = null;

    function applyCatalog(data) {
      if (!data) return;
      if (Array.isArray(data.adapters)) imageCatalog.adapters = data.adapters;
      if (Array.isArray(data.providerPresets)) imageCatalog.providerPresets = data.providerPresets;
      if (Array.isArray(data.localPresets)) imageCatalog.localPresets = data.localPresets;
      if (Array.isArray(data.capabilities)) imageCatalog.capabilities = data.capabilities;
    }

    function loadImageStore(translate) {
      const t = translate || fallbackTranslate;
      if (imageStoreLoadPromise) return imageStoreLoadPromise;
      imageStoreLoadPromise = (async () => {
        try {
          const response = await fetch('/api/mo-image/config', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw responseError(data, response.status, 'errors.loadConfig', t);
          applyCatalog(data);
          imageStoreCache = normalizeImageStore(data.config);
          imageStoreLoaded = true;
          window.dispatchEvent(new Event('mo-image-config'));
        } catch (error) {
          try { window.dispatchEvent(new CustomEvent('mo-image-config-error', { detail: { message: serverErrorText(t, error) } })); } catch (_error) { /* ignore */ }
        } finally {
          imageStoreLoadPromise = null;
        }
      })();
      return imageStoreLoadPromise;
    }

    function readImageStore() {
      return normalizeImageStore(imageStoreCache);
    }

    function activeImageConfig(store) {
      const s = store || readImageStore();
      const p = s.providers.find((x) => x.id === s.active.providerId) || s.providers[0];
      return {
        baseUrl: p ? p.baseUrl : '',
        key: p ? p.key : '',
        model: s.active.model || (p && p.models[0]) || '',
        providerId: p ? p.id : ''
      };
    }

    let configWriteChain = Promise.resolve();
    let configWriteSeq = 0;
    function writeImageStore(store, translate) {
      const t = translate || fallbackTranslate;
      const next = normalizeImageStore(store);
      const seq = ++configWriteSeq;
      imageStoreCache = next;
      try { window.dispatchEvent(new Event('mo-image-config')); } catch (_error) { /* ignore */ }
      configWriteChain = configWriteChain.then(async () => {
        try {
          const response = await fetch('/api/mo-image/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: next }),
            signal: AbortSignal.timeout(15000)
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw responseError(data, response.status, 'errors.saveConfig', t);
          if (seq === configWriteSeq && data.config) {
            applyCatalog(data);
            imageStoreCache = normalizeImageStore(data.config);
            window.dispatchEvent(new Event('mo-image-config'));
          }
          if (seq === configWriteSeq) window.dispatchEvent(new CustomEvent('mo-image-config-saved'));
        } catch (error) {
          if (seq !== configWriteSeq) return;
          try {
            window.dispatchEvent(new CustomEvent('mo-image-config-error', {
              detail: { message: serverErrorText(t, error) }
            }));
          } catch (_error) { /* ignore */ }
        }
      });
      return next;
    }

    function useImageStore(options) {
      const t = (options && options.t) || fallbackTranslate;
      const [store, setStore] = React.useState(readImageStore);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        const sync = () => setStore(readImageStore());
        const onError = (event) => setError((event && event.detail && event.detail.message) || t('errors.saveFailed'));
        const onSaved = () => setError('');
        window.addEventListener('mo-image-config', sync);
        window.addEventListener('storage', sync);
        window.addEventListener('mo-image-config-error', onError);
        if (options && options.saved) window.addEventListener('mo-image-config-saved', onSaved);
        if (!imageStoreLoaded) loadImageStore(t);
        sync();
        return () => {
          window.removeEventListener('mo-image-config', sync);
          window.removeEventListener('storage', sync);
          window.removeEventListener('mo-image-config-error', onError);
          if (options && options.saved) window.removeEventListener('mo-image-config-saved', onSaved);
        };
      }, []);
      return { store: store, setStore: setStore, error: error, setError: setError };
    }

    /**
     * 获取可用模型弹窗。版式照抄对话模型设置的选择模型弹窗：DSH 的 Modal
     * （标题 + 说明 + 关闭钮 + 底栏）+ 搜索行 + 勾选列表 + 两个描边按钮。
     * 只有拿不到这些原语时才退回插件自己的浮层，结构保持同一套类名。
     */
    function ModelFetchDialog(props) {
      const t = props.t || fallbackTranslate;
      const visible = props.visible || [];
      const names = props.names || {};
      const list = visible.length
        ? h('ul', { className: MC.candidateList },
          visible.map((id) => h('li', { className: MC.candidate, key: id },
            h('label', { className: MC.candidateLabel },
              h('input', {
                type: 'checkbox', checked: props.isPicked(id),
                onChange: () => props.onToggle(id)
              }),
              h('span', {
                className: MC.candidateId,
                title: typeof names[id] === 'string' && names[id] ? names[id] : id
              }, id)
            )
          ))
        )
        : h('p', { className: MC.candidateEmpty, role: 'status' }, t('picker.noMatches'));
      const toolbar = h('div', { className: MC.candidateToolbar },
        h('input', {
          ref: props.searchRef, className: MC.input + ' ' + MC.candidateSearch, type: 'search',
          value: props.query, placeholder: t('picker.search'), 'aria-label': t('picker.search'),
          onChange: (event) => props.onQuery(event.target.value)
        }),
        DshButton
          ? h(DshButton, {
            variant: 'ghost', size: 'sm', disabled: !visible.length, onClick: props.onToggleAll
          }, props.allPicked ? t('picker.deselectAll') : t('picker.selectAll'))
          : h('button', {
            type: 'button', className: MC.linkButton, disabled: !visible.length, onClick: props.onToggleAll
          }, props.allPicked ? t('picker.deselectAll') : t('picker.selectAll'))
      );
      const filtered = props.filteredCount > 0
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('input', {
              type: 'checkbox', checked: !!props.showAll,
              onChange: (event) => props.onShowAll(event.target.checked)
            }),
            t('picker.showAll')
          ),
          h('span', { className: MC.advancedHint, style: { margin: 0 } },
            t('picker.filtered', { count: props.filteredCount })
          )
        )
        : null;
      const cancelButton = DshButton
        ? h(DshButton, { variant: 'outline', onClick: props.onClose }, t('form.cancel'))
        : h('button', { type: 'button', className: MC.secondaryButton, onClick: props.onClose }, t('form.cancel'));
      const adoptButton = DshButton
        ? h(DshButton, {
          variant: 'outline', disabled: !!props.emptiesList,
          title: props.emptiesList ? t('picker.keepOne') : undefined,
          onClick: props.onAdopt
        }, t('picker.adopt'))
        : h('button', {
          type: 'button', className: MC.primaryButton, disabled: !!props.emptiesList,
          title: props.emptiesList ? t('picker.keepOne') : undefined,
          onClick: props.onAdopt
        }, t('picker.adopt'));
      if (DshModal) {
        return h(DshModal, {
          open: !!props.open, onClose: props.onClose,
          title: t('picker.title'), closeLabel: t('picker.close'),
          description: t('picker.description'), className: MC.fetchDialog,
          footer: h(React.Fragment, null, cancelButton, adoptButton)
        }, h(React.Fragment, null, toolbar, filtered, list));
      }
      if (!props.open) return null;
      return createPortal(h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 10000, padding: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.45)'
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose(); }
      }, h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': t('picker.title'), tabIndex: -1,
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
        },
        style: {
          width: 'min(520px, 100%)', maxHeight: 'min(82vh, 760px)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px',
          border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-xl)',
          background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)'
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('strong', { style: { fontSize: 15 } }, t('picker.title')),
          h('button', { type: 'button', className: MC.linkButton, style: { marginLeft: 'auto' }, onClick: props.onClose }, t('picker.close'))
        ),
        h('p', { className: MC.advancedHint, style: { margin: 0 } }, t('picker.description')),
        toolbar,
        filtered,
        list,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, cancelButton, adoptButton)
      )), document.body);
    }

    function ImageProviderForm(props) {
      useThemeClassRevision();
      const t = props.t || fallbackTranslate;
      const isNew = !!props.isNew;
      // 尺寸交给模型（自动）时，面板里才需要显示宽高落在哪。
      const sizeAuto = props.sizeAuto !== false;
      const [draft, setDraft] = React.useState(() => ({
        ...props.provider,
        id: props.provider.id,
        name: props.provider.name || '',
        baseUrl: props.provider.baseUrl || '',
        key: isNew ? (props.provider.key || '') : '',
        apiKeyEnv: props.provider.apiKeyEnv || '',
        keySource: props.provider.keySource || '',
        adapter: props.provider.adapter || '',
        customEndpoints: { ...(props.provider.customEndpoints || {}) },
        hostModel: props.provider.hostModel || '',
        protocol: props.provider.protocol || 'openai-images',
        optionalKey: !!props.provider.optionalKey,
        // 预设来源：决定锁的默认值（有它全锁）与「一键配置」显不显示。
        presetId: props.provider.presetId || '',
        models: (props.provider.models || []).slice(),
        names: { ...(props.provider.names || {}) },
        modelOptions: { ...(props.provider.modelOptions || {}) }
      }));
      const [optionsFor, setOptionsFor] = React.useState('');
      const [advanced, setAdvanced] = React.useState(false);
      const [mode, setMode] = React.useState('catalog');
      // 表单里选中的预设（与 provider 上的 presetId 是两件事：那个记的是来源）。
      const [presetId, setPresetId] = React.useState('openai');
      const [localPresetId, setLocalPresetId] = React.useState('sd-server');
      const [modelFetch, setModelFetch] = React.useState({ loading: false, error: '' });
      const [candidates, setCandidates] = React.useState(null);
      const [candidateQuery, setCandidateQuery] = React.useState('');
      // 勾选结果记成「相对默认勾选的翻转集」：已配置的模型默认勾选，取消即翻转。
      const [flipped, setFlipped] = React.useState(() => new Set());
      const [showAllCandidates, setShowAllCandidates] = React.useState(false);
      const [dragFrom, setDragFrom] = React.useState(-1);
      const [dropAt, setDropAt] = React.useState(null);
      // 工作流解析结果与用户确认过的映射，按模型 id 分开存。
      const [workflowAnalysis, setWorkflowAnalysis] = React.useState({});
      const [mappingDraft, setMappingDraft] = React.useState({});
      // 模型规则快照（检测路由的结果）：面板的只读摘要与一键配置都读它。
      const [ruleState, setRuleState] = React.useState({ loading: false, error: '', notice: '', rules: {} });
      const candidateSearchRef = React.useRef(null);
      const rowDragPreview = useModelRowDragPreview(MC.modelDragPreview);
      const providerPresets = providerPresetsForUi();
      const localPresets = localPresetsForUi();
      const selectedPreset = providerPresets.find((item) => item.id === presetId) || providerPresets[0] || null;
      React.useEffect(() => {
        if (!candidates) return undefined;
        const timer = setTimeout(() => {
          try { if (candidateSearchRef.current) candidateSearchRef.current.focus(); } catch (_error) { /* ignore */ }
        }, 0);
        return () => clearTimeout(timer);
      }, [candidates]);
      const addModel = () => {
        setDraft({ ...draft, models: draft.models.concat('') });
      };
      const localPreset = localPresets.find((item) => item.id === localPresetId) || localPresets[0] || null;
      const applyLocalPreset = (id) => {
        const next = localPresets.find((item) => item.id === id) || localPresets[0];
        if (!next) return;
        setLocalPresetId(next.id);
        setModelFetch({ loading: false, error: '' });
        setDraft((previous) => ({
          ...previous,
          name: next.name,
          baseUrl: next.baseUrl,
          adapter: next.adapter,
          protocol: 'openai-images',
          optionalKey: next.optionalKey,
          presetId: next.id,
          key: '',
          models: [],
          names: {}
        }));
      };
      // 宿主 manifest 比设置页晚到时（例如首屏刚打开），补一次本 preset 初始化。
  React.useEffect(() => {
        if (mode === 'local' && localPreset && !draft.adapter) applyLocalPreset(localPreset.id);
      }, [mode, localPreset && localPreset.id, draft.adapter]);
      const switchMode = (next) => {
        setMode(next);
        setModelFetch({ loading: false, error: '' });
        if (next === 'local') {
          applyLocalPreset(localPresetId);
        } else if (next === 'catalog') {
          const nextPreset = providerPresets.find((item) => item.id === presetId) || providerPresets[0];
          setDraft((previous) => ({
            ...previous,
            name: nextPreset ? nextPreset.name : '',
            baseUrl: nextPreset ? nextPreset.baseUrl : '',
            adapter: nextPreset ? (nextPreset.adapter || '') : '',
            protocol: nextPreset ? (nextPreset.protocol || 'openai-images') : 'openai-images',
            optionalKey: false,
            presetId: nextPreset ? nextPreset.id : '',
            models: nextPreset ? (nextPreset.models || []).slice() : [],
            names: {}
          }));
        } else {
          setDraft((previous) => ({
            ...previous,
            adapter: '',
            protocol: 'openai-images',
            optionalKey: false,
            presetId: ''
          }));
        }
      };
      // 新建表单默认带出第一个云 preset（通常 OpenAI），避免用户先看到空地址。
  React.useEffect(() => {
        if (!isNew || mode !== 'catalog' || draft.baseUrl || !providerPresets.length) return;
        const preset = providerPresets.find((item) => item.id === presetId) || providerPresets[0];
        if (!preset) return;
        setPresetId(preset.id);
        setDraft((previous) => ({
          ...previous,
          name: preset.name,
          baseUrl: preset.baseUrl,
          adapter: preset.adapter || '',
          protocol: preset.protocol || 'openai-images',
          optionalKey: false,
          presetId: preset.id,
          models: (preset.models || []).slice(),
          names: {}
        }));
      }, [isNew, mode, providerPresets.length, presetId]);
      // 自定义协议的模型列表地址是自己填的：填了才给拉取按钮，也不依赖 baseUrl。
      const customModelsUrl = String((draft.customEndpoints && draft.customEndpoints.models) || '').trim();
      const fetchTarget = draft.adapter === 'custom' ? customModelsUrl : draft.baseUrl.trim();
      const canFetchModels = draft.adapter === 'custom'
        ? Boolean(customModelsUrl)
        : (!draft.adapter || adapterSupportsModels(draft.adapter));
      const closeCandidates = () => {
        setCandidates(null);
        setCandidateQuery('');
        setFlipped(new Set());
        setShowAllCandidates(false);
      };
      const fetchModels = async () => {
        setModelFetch({ loading: true, error: '' });
        try {
          const response = await fetch('/api/mo-image/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: isNew ? undefined : draft.id,
              baseUrl: draft.baseUrl.trim(),
              adapter: draft.adapter,
              protocol: draft.protocol,
              customEndpoints: draft.customEndpoints,
              optionalKey: draft.optionalKey,
              key: draft.key.trim()
            }),
            signal: AbortSignal.timeout(30000)
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw responseError(data, response.status, 'errors.fetchModels', t);
          const ids = Array.isArray(data.models) ? data.models : [];
          const allModels = Array.isArray(data.allModels) ? data.allModels : ids;
          if (!ids.length && !allModels.length) throw new Error(t('errors.noModels'));
          setCandidates({
            models: ids,
            allModels: allModels,
            filteredCount: Number(data.filteredCount) || 0,
            // 上游给了显示名就一起带回来，采纳时顺手填进「显示名称」。
            names: data.names && typeof data.names === 'object' ? data.names : {},
            // 宿主只对「本次新增」的模型附了规则：采纳时按它填未上锁的键。
            detected: data.detected && typeof data.detected === 'object' ? data.detected : {}
          });
          setShowAllCandidates(ids.length === 0 && allModels.length > 0);
          setFlipped(new Set());
          setCandidateQuery('');
          setModelFetch({ loading: false, error: '' });
        } catch (error) {
          setModelFetch({ loading: false, error: serverErrorText(t, error) });
        }
      };
      // 与对话模型设置的选择弹窗同一套语义：已配置的默认勾选，勾选结果就是新列表。
      const candidateSource = candidates
        ? (showAllCandidates ? candidates.allModels : candidates.models)
        : [];
      const candidateNames = candidates ? candidates.names : {};
      const configuredIds = new Set(draft.models.filter((id) => typeof id === 'string' && id.length > 0));
      const pickedByDefault = (id) => configuredIds.size === 0 || configuredIds.has(id);
      const isPicked = (id) => pickedByDefault(id) !== flipped.has(id);
      const normalizedCandidateQuery = candidateQuery.trim().toLowerCase();
      const visibleCandidates = normalizedCandidateQuery
        ? candidateSource.filter((id) => {
            if (id.toLowerCase().includes(normalizedCandidateQuery)) return true;
            const name = candidateNames[id];
            return typeof name === 'string' && name.toLowerCase().includes(normalizedCandidateQuery);
          })
        : candidateSource;
      const allVisiblePicked = visibleCandidates.length > 0
        && visibleCandidates.every((id) => isPicked(id));
      const toggleCandidate = (id) => {
        setFlipped((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        });
      };
      const toggleVisibleCandidates = () => {
        if (!visibleCandidates.length) return;
        const target = !allVisiblePicked;
        setFlipped((current) => {
          const next = new Set(current);
          for (const id of visibleCandidates) {
            if (pickedByDefault(id) === target) next.delete(id); else next.add(id);
          }
          return next;
        });
      };
      const listedIds = new Set(candidateSource);
      const removedIndexes = new Set();
      draft.models.forEach((id, at) => { if (listedIds.has(id) && !isPicked(id)) removedIndexes.add(at); });
      const keptModels = draft.models.filter((_id, at) => !removedIndexes.has(at));
      const keptIds = new Set(keptModels);
      const addedModels = candidateSource.filter((id) => isPicked(id) && !keptIds.has(id));
      const emptiesModelList = draft.models.length > 0 && keptModels.length === 0 && addedModels.length === 0;
      const adoptCandidates = () => {
        if (emptiesModelList) return;
        const models = keptModels.concat(addedModels);
        const names = {};
        for (const id of models) {
          const existing = draft.names[id];
          const fetched = candidateNames[id];
          names[id] = typeof existing === 'string' && existing
            ? existing
            : (typeof fetched === 'string' ? fetched : '');
        }
        // 新增模型按宿主下发的 detected 填一遍「未上锁」的键：已经存在的模型可能被手改过，不碰。
        // ComfyUI / A1111 的尺寸走工作流参数，这套覆盖对它们没有意义。
        let modelOptions = { ...draft.modelOptions };
        const adapterId = String(draft.adapter || '');
        const detected = candidates && candidates.detected && typeof candidates.detected === 'object' ? candidates.detected : {};
        const fresh = {};
        for (const id of addedModels) if (detected[id]) fresh[id] = { rule: detected[id], fields: null, matched: true };
        if (adapterId !== 'comfyui' && adapterId !== 'a1111' && Object.keys(fresh).length) {
          modelOptions = mergeRuleResult(draft, modelOptions, fresh, { lock: false, models: Object.keys(fresh) }).modelOptions;
        }
        setDraft({ ...draft, models: models, names: names, modelOptions: modelOptions });
        closeCandidates();
      };
      const field = (label, control) => h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, label),
        control
      );
      const nameField = field(t('form.displayName'), h('input', { className: MC.input, value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }), placeholder: t('form.displayName') }));
      const matchedLocalPreset = localPresets.find((item) => item.adapter === draft.adapter) || null;
      const hintPreset = mode === 'local' ? (localPreset || matchedLocalPreset) : null;
      const urlHint = hintPreset
        ? translatedOr(t, 'localPreset.' + hintPreset.id + '.urlHint', hintPreset.urlHint || '')
        : '';
      const localHint = localPreset
        ? translatedOr(t, 'localPreset.' + localPreset.id + '.hint', localPreset.hint || '')
        : '';
      const urlPlaceholder = mode === 'local' && localPreset ? localPreset.baseUrl : 'https://gateway.example/v1';
      const urlField = h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, t('form.baseUrl')),
        h('input', {
          className: MC.input,
          value: draft.baseUrl,
          // 手改地址 = 换成另一家网关：不再按预设对待（锁默认值与只读摘要都跟 presetId 走）。
          onChange: (e) => setDraft({ ...draft, baseUrl: e.target.value, presetId: '' }),
          placeholder: urlPlaceholder
        }),
        urlHint ? h('p', { className: MC.advancedHint, style: { margin: 0 } }, urlHint) : null
      );
      /** 协议声明的是相对路径，面板里要看的是拼好 baseUrl 之后真正会被请求的地址。 */
      const joinRoute = (base, route) => {
        const path = String(route || '').trim();
        if (!path) return '';
        if (/^https?:\/\//i.test(path)) return path;
        const root = String(base || '').trim().replace(/\/+$/, '');
        if (!root) return path;
        return root + (path.startsWith('/') ? path : '/' + path);
      };
      const routesOf = (id) => {
        const hit = imageCatalog.adapters.find((item) => item && item.id === id);
        return (hit && hit.routes) || { generate: '', edit: '', models: '' };
      };
      /** 一类请求在当前地址下的真实地址；自定义协议的三条端点就是用户自己填的那三个。 */
      const routeValueOf = (kind) => {
        if (draft.adapter === 'custom') {
          const endpoints = draft.customEndpoints || {};
          return String(endpoints[kind] || '').trim() || t('form.routeUnsupported');
        }
        return joinRoute(draft.baseUrl, routesOf(draft.adapter)[kind]) || t('form.routeUnsupported');
      };
      // 协议 label 右侧的问号：三条真实地址收进悬停提示，一行一条，不再各占一行版面。
      const routeHelp = h('button', {
        type: 'button',
        className: MC.helpButton,
        'data-route-help': '',
        'aria-label': t('form.protocolRoutes'),
        title: [
          t('form.route.generate') + '：' + routeValueOf('generate'),
          t('form.route.edit') + '：' + routeValueOf('edit'),
          t('form.route.models') + '：' + routeValueOf('models')
        ].join('\n'),
        onClick: (event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault(); }
      }, '?');
      const protocolField = h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, t('form.protocol'), routeHelp),
        h('select', {
          className: MC.input + ' ' + MC.selectInput,
          value: draft.adapter || '',
          onChange: (e) => setDraft({ ...draft, adapter: e.target.value })
        }, [h('option', { key: '', value: '' }, t('form.protocolAuto'))].concat(
          imageCatalog.adapters.map((item) => h('option', { key: item.id, value: item.id }, item.label || item.id))
        ).concat([h('option', { key: 'custom', value: 'custom' }, t('form.customProtocol'))]))
      );
      // 自定义协议的三条端点没法从协议表里推出来，仍旧给三个输入框。
      const routeField = (kind, label) => h('div', { className: MC.field, key: kind },
        h('label', { className: MC.fieldLabel }, label),
        h('input', {
          className: MC.input,
          name: 'route-' + kind,
          value: String((draft.customEndpoints && draft.customEndpoints[kind]) || ''),
          placeholder: kind === 'generate' ? 'https://gateway.example/v1/images/generations' : '',
          onChange: (e) => setDraft((prev) => ({
            ...prev,
            customEndpoints: { ...(prev.customEndpoints || {}), [kind]: e.target.value }
          }))
        })
      );
      const routePanel = draft.adapter === 'custom'
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            routeField('generate', t('form.route.generate')),
            routeField('edit', t('form.route.edit')),
            routeField('models', t('form.route.models')))
        : null;
      // Responses API 的顶层模型是「调度模型」，只有这个协议需要填。
      const hostModelField = draft.adapter === 'openai-responses'
        ? h('div', { className: MC.field },
            h('label', { className: MC.fieldLabel }, t('form.hostModel')),
            h('input', {
              className: MC.input,
              value: draft.hostModel || 'gpt-5.2',
              placeholder: 'gpt-5.2',
              onChange: (e) => setDraft({ ...draft, hostModel: e.target.value })
            }),
            h('p', { className: MC.advancedHint, style: { margin: 0 } }, t('form.hostModelHint'))
          )
        : null;
      const keyPlaceholder = isNew
        ? (draft.optionalKey ? t('form.keyLocalOptional') : t('form.keyEnter'))
        : (props.provider.hasKey || props.provider.key
          ? (props.provider.keySource === 'env' ? t('form.keyEnvSaved') : t('form.keySaved'))
          : (props.provider.optionalKey ? t('form.keyLocalOptional') : t('form.keyEnter')));
      const keyField = field(t('form.apiKey'), h('input', { className: MC.input, type: 'password', value: draft.key, onChange: (e) => setDraft({ ...draft, key: e.target.value }), placeholder: keyPlaceholder }));
      const modelNameOf = (id) => (typeof draft.names[id] === 'string' ? draft.names[id] : '');
      const updateModelId = (index, id) => {
        const models = draft.models.slice();
        const previous = models[index];
        models[index] = id;
        const names = { ...draft.names };
        const modelOptions = { ...draft.modelOptions };
        if (previous !== id) {
          names[id] = names[previous] || '';
          delete names[previous];
          if (modelOptions[previous]) {
            modelOptions[id] = modelOptions[previous];
            delete modelOptions[previous];
          }
        }
        setDraft({ ...draft, models: models, names: names, modelOptions: modelOptions });
      };
      const updateModelName = (index, name) => {
        setDraft({ ...draft, names: { ...draft.names, [draft.models[index]]: name } });
      };
      const removeModel = (index) => {
        const names = { ...draft.names };
        const modelOptions = { ...draft.modelOptions };
        delete names[draft.models[index]];
        delete modelOptions[draft.models[index]];
        setDraft({ ...draft, models: draft.models.filter((_model, at) => at !== index), names: names, modelOptions: modelOptions });
      };
      const modelWorkflowOf = (id) => {
        const entry = draft.modelOptions[id];
        return entry && typeof entry.workflow === 'string' ? entry.workflow : '';
      };
      /** 统一改某个模型的选项：函数式更新，避免连续 setDraft 用同一份旧 draft 互相覆盖。 */
      const updateModelEntry = (id, mutate) => {
        setDraft((prev) => {
          const modelOptions = { ...prev.modelOptions };
          const entry = { ...(modelOptions[id] || {}) };
          mutate(entry);
          // 只留下真正有内容的条目：锁、字段模板、质量覆盖与尺寸一样是这个模型的家当。
          if (entry.workflow || entry.params || entry.expose || entry.size
            || entry.fields || entry.quality || entry.locked || entry.mapping) modelOptions[id] = entry;
          else delete modelOptions[id];
          return { ...prev, modelOptions: modelOptions };
        });
      };
      /**
       * 检测路由要一个地址：自定义协议的三条端点是自己填的，baseUrl 可能是空的。
       * 这里只读取，不回写——一键配置不动用户填的地址（设计文档明说）。
       */
      const detectBaseUrl = () => {
        const direct = String(draft.baseUrl || '').trim();
        if (direct) return direct;
        const endpoints = draft.customEndpoints || {};
        return String(endpoints.generate || endpoints.edit || endpoints.models || '').trim();
      };
      /** 规则快照的时效签名：地址或协议一变，旧摘要就不作数了。 */
      const ruleSignature = () => [detectBaseUrl(), draft.adapter || '', draft.protocol || ''].join('\u0000');
      /** 问一次规则：给几个模型就问几个，返回 `{ [model]: { rule, fields, matched } }`。 */
      const detectRules = async (ids) => {
        const models = (Array.isArray(ids) ? ids : [])
          .map((id) => String(id || '').trim()).filter(Boolean);
        if (!models.length) {
          setRuleState((prev) => ({ ...prev, loading: false, error: t('form.detectNeedsModels') }));
          return null;
        }
        const baseUrl = detectBaseUrl();
        if (!baseUrl) {
          setRuleState((prev) => ({ ...prev, loading: false, error: t('form.fetchNeedsBaseUrl') }));
          return null;
        }
        setRuleState((prev) => ({ ...prev, loading: true, error: '' }));
        try {
          const response = await fetch('/api/mo-image/detect-model-rule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl: baseUrl,
              adapter: draft.adapter,
              protocol: draft.protocol,
              customEndpoints: draft.adapter === 'custom' ? draft.customEndpoints : undefined,
              models: models
            }),
            signal: AbortSignal.timeout(20000)
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw responseError(data, response.status, 'errors.detectRule', t);
          const entries = ruleEntriesOf(data);
          const signature = ruleSignature();
          setRuleState((prev) => ({
            ...prev,
            loading: false,
            error: '',
            signature: signature,
            // 地址/协议变了旧快照就作废，免得摘要说的是另一家网关的字段名。
            rules: prev.signature === signature ? { ...prev.rules, ...entries } : entries
          }));
          return entries;
        } catch (error) {
          setRuleState((prev) => ({ ...prev, loading: false, error: serverErrorText(t, error) }));
          return null;
        }
      };
      /**
       * 定制：把检测结果写进 modelOptions —— 只写未上锁的键。
       * `lock: true` 是一键配置（写过的键顺手锁上）；单点自动检测与拉列表后的自动填都不锁。
       *
       * 计数在函数式更新外面算一遍：React 的 updater 是在下一次渲染里跑的，
       * 把 stats 写在 updater 里会拿到一份还没跑完的零。
       */
      const applyRuleEntries = (entries, lock) => {
        if (!entries || !Object.keys(entries).length) return { configured: 0, unmatched: 0, skipped: 0 };
        const preview = mergeRuleResult(draft, draft.modelOptions, entries, { lock: lock });
        setDraft((prev) => ({
          ...prev,
          modelOptions: mergeRuleResult(prev, prev.modelOptions, entries, { lock: lock }).modelOptions
        }));
        return { configured: preview.configured, unmatched: preview.unmatched, skipped: preview.skipped };
      };
      /** 一键配置：卡片上的一次点击，把所有模型按规则配一遍，然后把结果说清楚。 */
      const bulkConfigure = async () => {
        const models = draft.models.filter((id) => typeof id === 'string' && id.trim());
        const entries = await detectRules(models);
        if (!entries) return;
        const stats = applyRuleEntries(entries, true);
        const notice = stats.configured
          ? t('form.bulkConfigDone', { count: stats.configured, unmatched: stats.unmatched })
          : (stats.unmatched ? t('form.bulkConfigNone') : t('form.bulkConfigSkipped'));
        setRuleState((prev) => ({ ...prev, notice: notice }));
      };
      /** 单点自动检测：只重算这一条，同样只写未上锁的键（不锁）。 */
      const detectOne = async (id) => {
        const entries = await detectRules([id]);
        if (!entries) return;
        applyRuleEntries(entries, false);
        setRuleState((prev) => ({ ...prev, notice: '' }));
      };
      const toggleLock = (id, key) => updateModelEntry(id, (entry) => {
        const next = !lockedMapOf(entry, draft)[key];
        writeLock(entry, key, next, draft);
      });
      const unlockAll = (id) => updateModelEntry(id, (entry) => { writeAllLocks(entry, false, draft); });
      // 展开某个模型的选项时补一次它的规则快照：和「自动检测」共用同一份缓存
      // （面板改版后不再有只读摘要，这里只负责把快照备好）。
      // 只对「还没有当前地址下的快照」的模型发请求，展开/收起不会反复打路由。
      React.useEffect(() => {
        if (!optionsFor || !detectBaseUrl()) return;
        const adapterId = String(draft.adapter || '');
        // ComfyUI / A1111 的折叠区是工作流与参数映射，不归这套规则管，别白问一次。
        if (adapterId === 'comfyui' || adapterId === 'a1111') return;
        if (ruleState.signature === ruleSignature() && ruleState.rules[optionsFor]) return;
        detectRules([optionsFor]).catch(() => {});
      }, [optionsFor]);
      const setModelWorkflow = (id, workflow) => {
        const text = String(workflow || '');
        if (!text.trim()) {
          setDraft((prev) => {
            const modelOptions = { ...prev.modelOptions };
            delete modelOptions[id];
            return { ...prev, modelOptions: modelOptions };
          });
          return;
        }
        updateModelEntry(id, (entry) => { entry.workflow = text; });
      };
      const setModelMapping = (id, mapping) => updateModelEntry(id, (entry) => {
        if (mapping) entry.mapping = mapping;
        else delete entry.mapping;
      });
      /** 解析出的可调参数逐项保存；没有 expose 字段表示暴露。 */
      const setModelParamsList = (id, params) => updateModelEntry(id, (entry) => {
        if (Array.isArray(params) && params.length) entry.params = params;
        else delete entry.params;
      });
      const paramsOf = (id, analysis) => {
        const entry = draft.modelOptions[id];
        if (entry && Array.isArray(entry.params) && entry.params.length) return entry.params;
        return Array.isArray(analysis && analysis.params) ? analysis.params : [];
      };
      /** 解析结果一次写进 draft。 */
      const applyAnalysis = (id, analysis) => updateModelEntry(id, (entry) => {
        if (analysis && analysis.mapping) entry.mapping = analysis.mapping;
        if (analysis && Array.isArray(analysis.params) && analysis.params.length) {
          entry.params = analysis.params;
        }
      });
      const toggleParam = (id, name, checked) => updateModelEntry(id, (entry) => {
        entry.expose = { ...(entry.expose || {}), [name]: !!checked };
      });
      /** 逐项暴露开关：没显式设过时，角色参数默认开、可调参数默认关。 */
      const exposedOf = (id, name, fallback) => {
        const entry = draft.modelOptions[id];
        const map = entry && entry.expose;
        if (map && Object.prototype.hasOwnProperty.call(map, name)) return map[name] !== false;
        return fallback;
      };
      /** 换绑：把某个参数指到同名的另一个输入上。 */
      const rebindParam = (id, analysis, name, node, input) => {
        const list = paramsOf(id, analysis).map((param) => (
          param.name === name ? { ...param, node: node, input: input } : { ...param }
        ));
        setModelParamsList(id, list);
      };
      /** 把工作流交给宿主解析，结果原样留着给面板渲染。 */
      const analyzeModelWorkflow = async (id) => {
        const workflow = modelWorkflowOf(id);
        if (!workflow.trim()) return;
        setWorkflowAnalysis((prev) => ({ ...prev, [id]: { loading: true } }));
        try {
          const response = await fetch('/api/mo-image/comfy/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: isNew ? undefined : draft.id,
              baseUrl: draft.baseUrl.trim(),
              model: id,
              workflow: workflow
            }),
            signal: AbortSignal.timeout(60000)
          });
          const data = await response.json().catch(() => ({}));
          if (!data.ok) throw new Error(data.error || t('form.modelMappingFailed'));
          setWorkflowAnalysis((prev) => ({ ...prev, [id]: { loading: false, analysis: data } }));
          if (data.mapping) setMappingDraft((prev) => ({ ...prev, [id]: data.mapping }));
          // mapping 和 params 必须一次写进 draft：连着两次 setDraft 会互相覆盖。
          if (data.mapping || (Array.isArray(data.params) && data.params.length)) {
            applyAnalysis(id, data);
          }
        } catch (error) {
          setWorkflowAnalysis((prev) => ({
            ...prev,
            [id]: { loading: false, error: String(error && error.message ? error.message : error) }
          }));
        }
      };
      /** 下拉里只显示输入名，节点 id 对用户没有意义。 */
      const mappingOptionLabel = (item) => (item ? item.input : '');
      /** 参数名走翻译；没有译文时退回原始名字。 */
      const paramLabel = (name) => {
        const key = 'param.' + name;
        const value = t(key);
        return value === key ? name : value;
      };
      /** 参数的悬停说明；没写说明的参数不显示问号。 */
      const paramHint = (name) => {
        const key = 'param.' + name + '.desc';
        const value = t(key);
        return value === key ? '' : value;
      };
      /** 尺寸由选择器经 mapping 注入；认出来就不占列表，认不出来才留手选。 */
      const SIZE_ROLES = new Set(['width', 'height']);
      /**
       * 只列要手选落点的映射。提示词与负面词不在这里——它们由工具调用自己的
       * prompt / negative_prompt 直接写入工作流，落点仍按解析结果自动填。
       */
      const MAPPING_ROWS = [
        ['width', 'form.modelMappingWidth'],
        ['height', 'form.modelMappingHeight'],
        ['seed', 'form.modelMappingSeed'],
        ['model', 'form.modelMappingModel'],
        ['image', 'form.modelMappingImage']
      ];
      const mappingPanel = (id) => {
        const state = workflowAnalysis[id];
        if (!state || state.loading) return null;
        if (state.error) {
          return h('p', { className: MC.advancedHint, style: { gridColumn: '1 / -1', margin: 0 } },
            t('form.modelMappingFailed') + '：' + state.error);
        }
        const analysis = state.analysis || {};
        const candidates = analysis.candidates || {};
        const mapping = mappingDraft[id] || analysis.mapping || {};
        const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
        return h('div', { style: { gridColumn: '1 / -1', display: 'grid', gap: 8 } },
          h('p', { className: MC.advancedHint, style: { margin: 0 } },
            (analysis.format === 'ui' ? t('form.modelMappingFormatUi') : t('form.modelMappingFormatApi'))
            + ' · ' + t('form.modelMappingSampler') + ' ' + (analysis.samplerId || '—')),
          ...warnings.map((line, at) => h('p', { key: 'warn' + at, className: MC.advancedHint, style: { margin: 0, opacity: 0.8 } }, line)),
          (() => {
            const rows = [];
            for (const [key, labelKey] of MAPPING_ROWS) {
              const pool = Array.isArray(candidates[key]) ? candidates[key] : [];
              const current = mapping[key];
              if (!pool.length && !current) continue;
              // 尺寸固定时由选择器注入，认出来就不再占列表；自动时留给模型，需要看见落点。
              if (SIZE_ROLES.has(key) && current && !sizeAuto) continue;
              rows.push({
                key, name: key, label: t(labelKey), role: true, allowSkip: true,
                value: current ? current.node + '::' + current.input : '',
                options: pool.slice(),
                onPick: (picked) => {
                  const next = { ...(mappingDraft[id] || analysis.mapping || {}) };
                  if (!picked) next[key] = null;
                  else {
                    const [node, input] = picked.split('::');
                    next[key] = { node, input };
                  }
                  setMappingDraft((prev) => ({ ...prev, [id]: next }));
                  setModelMapping(id, next);
                }
              });
            }
            // 角色参数由上面的 MAPPING_ROWS 渲染，这里只放可调参数，避免出现重复行。
            for (const param of paramsOf(id, analysis).filter((item) => item.role !== true)) {
              const options = Array.isArray(param.candidates) && param.candidates.length
                ? param.candidates.slice()
                : [{ node: param.node, input: param.input }];
              rows.push({
                key: 'param-' + param.name, name: param.name, label: param.name,
                role: param.role === true, allowSkip: false,
                value: param.node + '::' + param.input,
                options,
                onPick: (picked) => {
                  const [node, input] = picked.split('::');
                  rebindParam(id, analysis, param.name, node, input);
                }
              });
            }
            const cell = {
              display: 'grid', gridTemplateColumns: 'minmax(88px, 1fr) 168px 76px',
              alignItems: 'center', gap: 8, minHeight: 32
            };
            const rowView = (row) => {
              const list = row.options.map((item) => ({
                value: item.node + '::' + item.input,
                label: mappingOptionLabel(item)
              }));
              if (row.allowSkip) list.unshift({ value: '', label: t('form.modelMappingSkip') });
              if (row.value && !list.some((option) => option.value === row.value)) {
                list.push({ value: row.value, label: row.value.split('::')[1] });
              }
              const label = row.role ? row.label : paramLabel(row.name);
              const hint = row.role ? '' : paramHint(row.name);
              return h('div', { key: row.key, style: cell },
                h('span', {
                  className: MC.modelFieldLabel,
                  style: { margin: 0, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }
                },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                hint ? h(MoHelp, { text: hint }) : null),
                h('select', {
                  className: MC.input + ' ' + MC.selectInput,
                  style: { width: '100%', minWidth: 0 },
                  value: row.value,
                  onChange: (event) => row.onPick(event.target.value)
                }, list.map((option) => h('option', { key: option.value || 'none', value: option.value }, option.label))),
                h('input', {
                  type: 'checkbox',
                  checked: exposedOf(id, row.name, false),
                  'aria-label': label,
                  style: {
                    accentColor: 'var(--dsw-alias-state-business-primary, #3989f6)',
                    width: 16, height: 16, flex: 'none', justifySelf: 'end'
                  },
                  onChange: (event) => toggleParam(id, row.name, event.target.checked)
                })
              );
            };
            // 提示词与负面词不占这里的行：它们由工具参数直接写入，落点按解析结果自动填。
            return h('div', { style: { display: 'grid', gap: 4 } },
              h('p', { className: MC.advancedHint, style: { margin: 0 } },
                t('form.modelAutoInjectHint')),
              rows.length ? h('div', { className: MC.advancedHint, style: Object.assign({}, cell, { minHeight: 0 }) },
                h('span', null, t('form.modelMappingColName')),
                h('span', null, t('form.modelMappingColTarget')),
                h('span', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, t('form.modelMappingColExpose'))) : null,
              rows.length ? h('div', {
                style: {
                  display: 'grid', gap: 4, maxHeight: 184,
                  overflowY: 'auto', paddingRight: 2
                }
              }, ...rows.map((row) => rowView(row))) : null
            );
          })()
        );
      };
      /** A1111 没有工作流，只给一张参数开关表；默认全不暴露。 */
      const A1111_ROWS = [
        ['steps', 'param.steps', 'INT'],
        ['cfg_scale', 'param.cfg', 'FLOAT'],
        ['sampler_name', 'param.sampler_name', 'STRING'],
        ['scheduler', 'param.scheduler', 'STRING'],
        ['seed', 'param.seed', 'INT'],
        ['denoising_strength', 'param.denoise', 'FLOAT']
      ];
      const a1111ParamsPanel = (id) => {
        const cell = {
          display: 'grid', gridTemplateColumns: 'minmax(96px, 1fr) 64px 76px',
          alignItems: 'center', gap: 8, minHeight: 32
        };
        return h('div', { style: { display: 'grid', gap: 4 } },
          h('p', { className: MC.advancedHint, style: { margin: 0 } }, t('form.a1111ParamsHint')),
          h('div', { className: MC.advancedHint, style: Object.assign({}, cell, { minHeight: 0 }) },
            h('span', null, t('form.modelMappingColName')),
            h('span', null, t('form.a1111ColType')),
            h('span', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, t('form.modelMappingColExpose'))),
          ...A1111_ROWS.map(([name, labelKey, type]) => h('div', { key: name, style: cell },
            h('span', { className: MC.modelFieldLabel, style: { margin: 0 } }, t(labelKey)),
            h('span', { className: MC.advancedHint, style: { margin: 0 } }, type),
            h('input', {
              type: 'checkbox',
              checked: exposedOf(id, name, false),
              'aria-label': t(labelKey),
              style: {
                accentColor: 'var(--dsw-alias-state-business-primary, #3989f6)',
                width: 16, height: 16, flex: 'none', justifySelf: 'end'
              },
              onChange: (event) => toggleParam(id, name, event.target.checked)
            })
          ))
        );
      };
      // 没有自己的 ComfyUI 工作流时，先插一个能跑 SD/SDXL 的骨架，改起来比重写快。
      const modelWorkflowTemplate = () => JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '{{prompt}}' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '{{negative_prompt}}' } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
        '5': {
          class_type: 'KSampler',
          inputs: {
            seed: '{{seed}}', steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0]
          }
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['6', 0] } }
      }, null, 2);
      const moveModel = (from, to) => {
        if (from === to || from < 0 || to < 0 || to >= draft.models.length) return;
        const models = draft.models.slice();
        const moved = models.splice(from, 1)[0];
        models.splice(to, 0, moved);
        setDraft({ ...draft, models: models });
      };
      const endRowDrag = () => { setDragFrom(-1); setDropAt(null); };
      const rowHalf = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      };
      // 每格都是 DSH 设置页的 modelField：ID 与显示名称同一套输入框样式和列宽。
      const modelField = (field, index, id) => h('label', {
        className: MC.modelField + (field === 'name' ? ' ' + MC.modelName : '')
      },
        field === 'name'
          ? h('span', { className: MC.modelFieldLabel + ' ' + MC.modelNameLabel }, t('form.displayName'))
          : null,
        h('input', {
          className: MC.input, type: 'text',
          value: field === 'name' ? modelNameOf(id) : id,
          placeholder: field === 'name' ? t('form.displayName') : t('form.modelId'),
          'aria-label': (field === 'name' ? t('form.displayName') : t('form.modelId')) + ' ' + (index + 1),
          // 与 DSH 设置页一致：聚焦显示名称时自动展开该行的模型选项（仅 ComfyUI）
          onFocus: field === 'name' && String(draft.adapter || '') === 'comfyui' && optionsFor !== id
            ? () => setOptionsFor(id) : undefined,
          onChange: (event) => {
            if (field === 'name') updateModelName(index, event.target.value);
            else updateModelId(index, event.target.value);
          }
        })
      );
      const modelDragHandle = (index) => {
        const button = h('button', {
          type: 'button',
          className: MC.iconButton + ' ' + MC.modelDragHandle,
          'aria-label': t('form.reorderModel') + ' ' + (index + 1),
          'aria-keyshortcuts': 'ArrowUp ArrowDown',
          'aria-description': t('form.reorderModelHelp'),
          title: DshTooltip ? undefined : t('form.reorderModelHelp'),
          draggable: true,
          onDragStart: (event) => {
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'move';
              try { event.dataTransfer.setData('application/x-mo-image-model-order', String(index)); } catch (_error) { /* ignore */ }
            }
            setDragFrom(index);
            try {
              const row = event.currentTarget.closest('[data-row-key]');
              if (row) rowDragPreview.start(event, row);
            } catch (_error) { /* 预览失败不影响拖动本身 */ }
          },
          onDragEnd: () => { rowDragPreview.clear(); endRowDrag(); },
          onKeyDown: (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            event.stopPropagation();
            moveModel(index, index + (event.key === 'ArrowUp' ? -1 : 1));
          }
        }, IconDragHandle ? h(IconDragHandle, { size: 14 }) : '\u22ee');
        return DshTooltip ? h(DshTooltip, { label: t('form.reorderModelHelp'), portal: true }, button) : button;
      };
      /** 键名右侧的锁图标：上锁 = 该值不可被修改（输入框禁用、自动填跳过）。 */
      const lockButton = (id, key, locked) => h('button', {
        type: 'button',
        className: MC.iconButton,
        'data-lock-key': key,
        'data-locked': locked ? 'true' : 'false',
        'aria-pressed': locked ? 'true' : 'false',
        'aria-label': t('form.paramLock') + ': ' + t(PARAM_LABELS[key]),
        title: locked ? t('form.lockOn') : t('form.lockOff'),
        style: { flex: 'none', fontSize: 12, lineHeight: '18px' },
        onClick: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          toggleLock(id, key);
        }
      }, locked ? '\u{1F512}' : '\u{1F513}');
      /** 参数行的 label：靠左、不伸缩 —— label 变长时挤的是输入框，右侧锁的位置不变。 */
      const paramRowLabel = (text, hint) => h('span', {
        className: MC.modelFieldLabel,
        style: { margin: 0, flex: 'none' },
        title: hint || undefined
      }, text);
      /** 参数输入：吃掉剩下的宽度；min-width 0 才允许被变长的 label 挤窄。 */
      const PARAM_INPUT_STYLE = { flex: '1 1 auto', minWidth: 0 };
      /**
       * 一行参数：label 左、输入中间自适应、尾部控件（锁）在行尾。
       * 单输入的参数就用这一行；多输入的参数放进 paramBox，每行一个输入。
       */
      const paramLine = (labelText, control, trailing, rowKey) => h('div', {
        'data-param-row': rowKey || undefined,
        // gridColumn 只在「高级」那块多列网格里起作用：一行占满，不被切成两栏。
        style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
      }, paramRowLabel(labelText), control, trailing || null);
      /**
       * 参数方框：一律横跨整行、占满面板宽度（面板本身是两列网格，不写 gridColumn 就只占半宽）。
       * 多输入的参数把锁挂在标题行；单输入参数收在一起时（「常规」）每个键自己一行带锁，
       * 标题行只留标题。
       */
      const paramBox = (id, key, locks, titleText, rows, options) => {
        const lockInHead = !(options && options.lockInHead === false);
        return h('div', {
          'data-param-box': key,
          style: {
            gridColumn: '1 / -1', justifySelf: 'stretch',
            width: '100%', boxSizing: 'border-box',
            display: 'grid', gap: 6, minWidth: 0,
            padding: '8px 10px',
            border: '.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-md, 8px)'
          }
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            paramRowLabel(titleText),
            lockInHead ? lockButton(id, key, !!locks[key]) : null),
          ...rows
        );
      };
      /**
       * 「尺寸」方框：编码方式 + 参数名，锁在标题行。
       * 参数名跟着编码方式变：宽+高 是两个键名（宽 / 高），比例+分辨率 是比例字段与分辨率
       * （或档位）字段，其余是一个参数名，prompt 形态则没有键名可填。
       */
      const sizeOptionsPanel = (id, locks) => {
        const locked = !!locks.size;
        const entry = (draft.modelOptions[id] && draft.modelOptions[id].size) || {};
        const spec = sizeSpecFor(draft.id, id);
        const setSize = (patch) => updateModelEntry(id, (next) => {
          const merged = { ...(next.size || {}), ...patch };
          for (const key of Object.keys(merged)) if (!merged[key]) delete merged[key];
          if (Object.keys(merged).length) next.size = merged;
          else delete next.size;
        });
        const mode = String(entry.mode || '');
        const effective = effectiveSizeMode(mode, spec);
        const defaultControl = spec ? sizeControlOf(spec) : 'wh';
        const defaultStyle = String((spec && spec.style) || 'string');
        // 分隔符只在「一个字段写宽x高」时有意义；其余形态没有分隔符这回事。
        const showSeparator = mode === 'wh-string'
          || (!mode && defaultControl === 'wh' && defaultStyle !== 'width-height');
        const second = (entry.second && typeof entry.second === 'object') ? entry.second : {};
        const setSecond = (patch) => updateModelEntry(id, (next) => {
          const size = { ...(next.size || {}) };
          const merged = { ...(size.second || {}), ...patch };
          for (const key of Object.keys(merged)) if (!merged[key]) delete merged[key];
          if (merged.field) size.second = merged;
          else delete size.second;
          if (Object.keys(size).length) next.size = size;
          else delete next.size;
        });
        const sepValue = String(entry.separator || '');
        const sepCustomValue = sepValue && sepValue !== 'x' && sepValue !== '*' ? sepValue : '';
        const sepChoice = sepCustomValue ? '__custom' : (sepValue || 'x');
        const modes = [
          { value: '', label: t('form.sizeModeDefault') },
          { value: 'wh-string', label: t('form.sizeModeWhString') },
          { value: 'wh-fields', label: t('form.sizeModeWhFields') },
          { value: 'aspect', label: t('form.sizeModeAspect') },
          { value: 'tier', label: t('form.sizeModeTier') },
          { value: 'prompt', label: t('form.sizeModePrompt') }
        ];
        const rows = [];
        rows.push(paramLine(t('form.sizeMode'), h('select', {
          className: MC.input + ' ' + MC.selectInput,
          style: PARAM_INPUT_STYLE,
          'data-param-key': 'size',
          title: t('form.sizeParamsHint'),
          disabled: locked,
          value: mode,
          onChange: (event) => setSize({ mode: String(event.target.value) })
        }, modes.map((option) => h('option', { key: option.value, value: option.value }, option.label))), null, 'size:mode'));
        // 宽+高 的两个键名：field 是宽、second.field 是高（留空就用 width / height）。
        const nameInput = (value, placeholder, labelText, onChange) => h('input', {
          className: MC.input, type: 'text', spellCheck: false,
          style: PARAM_INPUT_STYLE,
          'data-param-key': 'size',
          'aria-label': labelText,
          title: t('form.sizeFieldHint'),
          disabled: locked,
          value: String(value || ''),
          placeholder: placeholder,
          onChange: onChange
        });
        if (effective === 'wh-fields') {
          rows.push(paramLine(t('form.sizeFieldWidth'),
            nameInput(entry.field || 'width', 'width', t('form.sizeFieldWidth'),
              (event) => setSize({ field: event.target.value.trim() })),
            null, 'size:width'));
          rows.push(paramLine(t('form.sizeFieldHeight'),
            nameInput(second.field || 'height', 'height', t('form.sizeFieldHeight'),
              (event) => setSecond({ field: event.target.value.trim() })),
            null, 'size:height'));
        } else if (effective === 'aspect') {
          rows.push(paramLine(t('form.sizeFieldAspect'),
            nameInput(entry.field, String((spec && spec.field) || '') || 'aspect_ratio', t('form.sizeFieldAspect'),
              (event) => setSize({ field: event.target.value.trim() })),
            null, 'size:field'));
          rows.push(paramLine(t('form.sizeFieldResolution'),
            // 这个 label 在 `from: 'tier'` 时略偏：那时发的是档位名（1K / 2K），不是分辨率。
            // 两种取值共用一个字段，label 只按「比例之外的那一格」命名，不为它再拆一个文案。
            h('input', {
              className: MC.input + ' ' + MC.selectInput, type: 'text', spellCheck: false,
              style: PARAM_INPUT_STYLE,
              'data-param-key': 'size',
              'aria-label': t('form.sizeFieldResolution'),
              title: t('form.sizeSecondHint'),
              disabled: locked,
              value: String(second.field || ''),
              placeholder: 'imageSize',
              onChange: (event) => setSecond({ field: event.target.value.trim() })
            }),
            second.field ? h('select', {
              className: MC.input + ' ' + MC.selectInput,
              style: { flex: 'none' },
              'data-param-key': 'size',
              'aria-label': t('form.sizeSecond'),
              disabled: locked,
              value: second.from === 'tier' ? 'tier' : 'aspect',
              onChange: (event) => setSecond({ from: String(event.target.value) })
            }, [
              { value: 'aspect', label: t('seat.sizeAspect') },
              { value: 'tier', label: t('seat.sizeTier') }
            ].map((option) => h('option', { key: option.value, value: option.value }, option.label))) : null,
            'size:second'));
        } else if (effective !== 'prompt') {
          rows.push(paramLine(t('form.sizeField'),
            nameInput(entry.field, String((spec && spec.field) || 'size'), t('form.sizeField'),
              (event) => setSize({ field: event.target.value.trim() })),
            null, 'size:field'));
        }
        if (showSeparator) {
          rows.push(paramLine(t('form.sizeSeparator'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 auto', minWidth: 0 } },
              h('select', {
                className: MC.input + ' ' + MC.selectInput,
                style: { flex: 'none' },
                'data-param-key': 'size',
                disabled: locked,
                value: sepChoice,
                onChange: (event) => {
                  const next = String(event.target.value);
                  // 选「自定义」先落一个占位符，输入框才有值可改。
                  setSize({ separator: next === '__custom' ? (sepCustomValue || '|') : next });
                }
              }, [
                { value: 'x', label: 'x' },
                { value: '*', label: '*' },
                { value: '__custom', label: t('form.sizeSeparatorCustom') }
              ].map((option) => h('option', { key: option.value, value: option.value }, option.label))),
              sepChoice === '__custom' ? h('input', {
                className: MC.input + ' ' + MC.selectInput, type: 'text', maxLength: 4,
                style: PARAM_INPUT_STYLE,
                'data-param-key': 'size',
                'aria-label': t('form.sizeSeparator'),
                disabled: locked,
                value: String(entry.separator || ''),
                placeholder: '|',
                onChange: (event) => setSize({ separator: event.target.value })
              }) : null),
            null, 'size:separator'));
        }
        return paramBox(id, 'size', locks, t('form.paramSize'), rows);
      };
      /**
       * 质量与五个字段模板（提示词/负面词/模型/张数/参考图）：单输入的就是一行，各带锁。
       * 参考图有两个输入（字段名 + 传法），按多输入那档用方框框起来。
       * 手填的值按「模板」的形状保存；清空就删掉这条覆盖，重新跟随规则/预设。
       */
      const paramFieldsPanel = (id, locks) => {
        const entry = draft.modelOptions[id] || {};
        const fieldEntry = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
        const quality = entry.quality && typeof entry.quality === 'object' ? entry.quality : {};
        const setQualityField = (value) => updateModelEntry(id, (next) => {
          const merged = { ...(next.quality || {}) };
          if (value) merged.field = value;
          else delete merged.field;
          if (Object.keys(merged).length) next.quality = merged;
          else delete next.quality;
        });
        const setFieldTemplate = (key, template) => updateModelEntry(id, (next) => {
          const merged = { ...(next.fields || {}) };
          if (template) merged[key] = template;
          else delete merged[key];
          if (Object.keys(merged).length) next.fields = merged;
          else delete next.fields;
        });
        const commonRows = [];
        // 质量：只有字段名可手改（档位与值映射由规则给，见设计文档「不编辑值域」）。
        commonRows.push(paramLine(t(PARAM_LABELS.quality), h('input', {
          className: MC.input, type: 'text', spellCheck: false,
          style: PARAM_INPUT_STYLE,
          'data-param-key': 'quality',
          'aria-label': t(PARAM_LABELS.quality),
          disabled: !!locks.quality,
          value: String(quality.field || ''),
          placeholder: 'quality',
          onChange: (event) => setQualityField(event.target.value.trim())
        }), lockButton(id, 'quality', !!locks.quality), 'quality'));
        const imageRows = [];
        for (const key of FIELD_KEYS) {
          const template = fieldEntry[key];
          const locked = !!locks[key];
          const kind = fieldKindOf(template);
          const asValue = template && typeof template === 'object' && typeof template.as === 'string' ? template.as : '';
          const name = fieldPathOf(template);
          const onName = (event) => {
            const text = event.target.value.trim();
            setFieldTemplate(key, text ? fieldTemplateOf(kind, text, asValue) : null);
          };
          if (key === 'image') {
            // 参考图有「字段名」与「传法」两个输入，按多输入那档单独用方框框起来。
            imageRows.push(paramLine(t('form.imageField'), h('input', {
              className: MC.input, type: 'text', spellCheck: false,
              style: PARAM_INPUT_STYLE,
              'data-param-key': key,
              'aria-label': t('form.imageField'),
              disabled: locked,
              value: name,
              placeholder: 'image',
              onChange: onName
            }), null, 'image:field'));
            imageRows.push(paramLine(t('form.imageAs'), h('select', {
              className: MC.input + ' ' + MC.selectInput,
              style: PARAM_INPUT_STYLE,
              'data-param-key': key + '.as',
              'aria-label': t('form.imageAs'),
              disabled: locked,
              value: asValue,
              onChange: (event) => {
                const picked = String(event.target.value);
                // 没有字段名时选传法没有意义：等用户先填「发到哪」。
                if (!name) return;
                setFieldTemplate(key, fieldTemplateOf(kind, name, picked));
              }
            }, [
              { value: '', label: t('form.sizeModeDefault') },
              { value: 'dataUrl', label: 'dataUrl' },
              { value: 'base64', label: 'base64' },
              { value: 'url', label: 'url' }
            ].map((option) => h('option', { key: option.value, value: option.value }, option.label))), null, 'image:as'));
            continue;
          }
          commonRows.push(paramLine(t(PARAM_LABELS[key]), h('input', {
            className: MC.input, type: 'text', spellCheck: false,
            style: PARAM_INPUT_STYLE,
            'data-param-key': key,
            'aria-label': t(PARAM_LABELS[key]),
            disabled: locked,
            value: name,
            placeholder: key === 'negative' ? 'negative_prompt' : key,
            onChange: onName
          }), lockButton(id, key, locked), key));
        }
        return {
          // 五个单输入参数（质量 / 提示词 / 负面词 / 模型 / 张数）收进同一个「常规」方框：
          // 每行 label 左、输入自适应、锁在行尾，锁不挂在标题行（每个键各有各的锁）。
          common: paramBox(id, 'common', locks, t('form.paramsCommon'), commonRows, { lockInHead: false }),
          image: paramBox(id, 'image', locks, t(PARAM_LABELS.image), imageRows)
        };
      };
      /**
       * 模型选项的面板：一个占满宽度的「高级」折叠区，展开后是「常规 / 尺寸 / 参考图」三个全宽方框。
       * 自动检测与全部解锁挪到「高级」这一行的右端（同一个 <summary> 里），不再单独散在面板上。
       * 预设来源的提供商默认全锁，展开后看到的是锁，而不是一堆待填的空格。
       */
      const modelParamsPanel = (id) => {
        const locks = lockedMapOf(draft.modelOptions[id], draft);
        const fields = paramFieldsPanel(id, locks);
        // summary 里的按钮别把折叠区一起开合。
        const keepOpen = (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        };
        return h('div', { className: MC.modelAdvanced },
          h('details', {
            className: MC.customized,
            style: { gridColumn: '1 / -1', width: '100%', minWidth: 0 }
          },
            h('summary', {
              className: MC.customizedSummary,
              style: { width: '100%', justifyContent: 'space-between' }
            },
              t('form.advancedParams'),
              h('span', { className: MC.rowActions },
                h('button', {
                  type: 'button', className: MC.secondaryButton,
                  disabled: ruleState.loading,
                  onClick: (event) => { keepOpen(event); detectOne(id); }
                }, ruleState.loading ? t('form.detecting') : t('form.autoDetect')),
                h('button', {
                  type: 'button', className: MC.secondaryButton,
                  onClick: (event) => { keepOpen(event); unlockAll(id); }
                }, t('form.unlockAll'))
              )
            ),
            h('div', {
              className: MC.customizedBody,
              style: { display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)' }
            },
              h('p', { className: MC.advancedHint, style: { margin: 0 } }, t('form.paramsHint')),
              fields.common,
              sizeOptionsPanel(id, locks),
              fields.image
            )
          )
        );
      };

      // 「一键配置」只给非预设来源的提供商：自定义协议与 adapter 为空的中转站都需要它；
      // 从预设创建的那些开箱即用、默认全锁，按了也不会写任何键。
      const canBulkConfigure = !String(draft.presetId || '').trim();
      const bulkButton = canBulkConfigure ? h('button', {
        type: 'button', className: MC.linkButton,
        disabled: ruleState.loading || !draft.models.some((id) => typeof id === 'string' && id.trim()),
        onClick: bulkConfigure
      }, ruleState.loading ? t('form.bulkConfiguring') : t('form.bulkConfigure')) : null;
      const modelDirectory = h('div', { className: MC.modelCatalog },
        h('div', { className: MC.modelListHead, style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 } },
          h('div', { className: MC.modelCatalogHeading },
            h('span', { className: MC.modelCatalogTitle }, t('form.modelDirectory')),
            h('p', { className: MC.modelCatalogMeta }, draft.models.length ? t('form.modelDirectoryCustom') : t('form.modelDirectoryDefault'))
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            bulkButton,
            canFetchModels ? h('button', {
              type: 'button', className: MC.linkButton,
              disabled: modelFetch.loading || !fetchTarget,
              title: !fetchTarget ? t('form.fetchNeedsBaseUrl') : undefined,
              onClick: fetchModels
            }, modelFetch.loading ? t('form.fetching') : t('form.fetchModels')) : null
          )
        ),
        modelFetch.error ? h('p', { className: MC.error, role: 'alert' }, modelFetch.error) : null,
        // 一键配置的结果：配了几条、几条没命中（没命中的才会需要展开「高级」手填）。
        ruleState.error ? h('p', { className: MC.error, role: 'alert' }, ruleState.error) : null,
        ruleState.notice ? h('p', { className: MC.advancedHint, role: 'status', 'data-rule-notice': '' }, ruleState.notice) : null,
        draft.models.length ? h('div', { className: MC.modelList },
          draft.models.map((model, index) => {
            const dragging = dragFrom === index;
            const target = !dragging && dragFrom >= 0 && dropAt && dropAt.index === index ? dropAt.half : null;
            // 工作流只对 ComfyUI / A1111 有意义；其它适配器的折叠区放「尺寸参数」。
            const workflowSupported = String(draft.adapter || '') === 'comfyui' || String(draft.adapter || '') === 'a1111';
            const optionsOpen = optionsFor === model && model !== '';
            return h('div', {
              className: MC.modelEntry,
              key: index,
              'data-row-key': String(index),
              'data-dragging': dragging || undefined,
              'data-drop-target': target || undefined,
              onDragOver: (event) => {
                if (dragFrom < 0) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                const half = rowHalf(event);
                setDropAt((current) => (current && current.index === index && current.half === half ? current : { index: index, half: half }));
              },
              onDragLeave: (event) => {
                if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
                setDropAt((current) => (current && current.index === index ? null : current));
              },
              onDrop: (event) => {
                if (dragFrom < 0) return;
                event.preventDefault();
                const insertion = index + (rowHalf(event) === 'after' ? 1 : 0);
                moveModel(dragFrom, insertion > dragFrom ? insertion - 1 : insertion);
                endRowDrag();
              }
            },
              h('div', { className: MC.modelRow, 'data-expanded': optionsOpen || undefined },
                modelDragHandle(index),
                modelField('id', index, model),
                // 「模型选项」：和 DSH 设置页一致，是 ID 与删除之间的折叠箭头图标按钮
                h('button', {
                  type: 'button',
                  className: MC.iconButton,
                  'aria-label': t('form.modelOptions') + ' ' + (index + 1),
                  'aria-expanded': optionsOpen,
                  title: t('form.modelOptions'),
                  onClick: (event) => {
                    event.currentTarget.focus();
                    setOptionsFor(optionsOpen ? '' : model);
                  }
                }, optionsOpen
                  ? (IconChevronDown ? h(IconChevronDown, {}) : '\u25be')
                  : (IconChevronRight ? h(IconChevronRight, {}) : '\u25b8')),
                h('button', {
                  type: 'button', className: MC.iconButton + ' ' + MC.iconButtonDanger,
                  onClick: () => removeModel(index),
                  title: t('form.deleteModel'), 'aria-label': t('form.deleteModel') + ' ' + (index + 1)
                }, IconTrash ? h(IconTrash, { size: 14 }) : '×'),
                modelField('name', index, model),
                optionsOpen ? (workflowSupported ? (String(draft.adapter || '') === 'a1111'
                  ? h('div', { className: MC.modelAdvanced }, a1111ParamsPanel(model))
                  : h('div', { className: MC.modelAdvanced },
                  h('p', { className: MC.advancedHint, style: { gridColumn: '1 / -1', margin: 0 } },
                    t('form.modelOptionsHint')),
                  h('label', { className: MC.modelField, style: { gridColumn: '1 / -1' } },
                    h('span', { className: MC.modelFieldLabel }, t('form.modelWorkflow')),
                    h('textarea', {
                      className: MC.input,
                      rows: 8,
                      spellCheck: false,
                      style: {
                        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
                        fontSize: 13,
                        minHeight: 160,
                        resize: 'vertical'
                      },
                      value: modelWorkflowOf(model),
                      placeholder: t('form.modelWorkflowPlaceholder'),
                      onChange: (event) => setModelWorkflow(model, event.target.value)
                    })
                  ),
                  h('p', { className: MC.advancedHint, style: { gridColumn: '1 / -1', margin: 0 } },
                    t('form.modelWorkflowHelp')),
                  h('div', { className: MC.rowActions, style: { gridColumn: '1 / -1' } },
                    h('button', {
                      type: 'button', className: MC.secondaryButton,
                      onClick: () => setModelWorkflow(model, modelWorkflowTemplate())
                    }, t('form.modelWorkflowSample')),
                    modelWorkflowOf(model) ? h('button', {
                      type: 'button', className: MC.secondaryButton,
                      disabled: !!(workflowAnalysis[model] && workflowAnalysis[model].loading),
                      onClick: () => analyzeModelWorkflow(model)
                    }, workflowAnalysis[model] && workflowAnalysis[model].loading
                      ? t('form.modelMappingParsing')
                      : t('form.modelMappingParse')) : null
                  ),
                  mappingPanel(model)
                )) : modelParamsPanel(model)) : null
              )
            );
          })
        ) : h('div', { className: MC.modelEmpty }, t('form.modelEmpty')),
        h('button', { type: 'button', className: MC.addModelButton, onClick: addModel },
          IconPlus ? h(IconPlus, { size: 14 }) : null,
          t('form.addModel')
        )
      );
      const modelPicker = h(ModelFetchDialog, {
        open: !!candidates,
        t: t,
        query: candidateQuery,
        onQuery: setCandidateQuery,
        visible: visibleCandidates,
        names: candidateNames,
        filteredCount: candidates ? candidates.filteredCount : 0,
        showAll: showAllCandidates,
        onShowAll: setShowAllCandidates,
        allPicked: allVisiblePicked,
        isPicked: isPicked,
        onToggle: toggleCandidate,
        onToggleAll: toggleVisibleCandidates,
        emptiesList: emptiesModelList,
        onClose: closeCandidates,
        onAdopt: adoptCandidates,
        searchRef: candidateSearchRef
      });
      const actions = h('div', { className: MC.editorActions },
        h('button', { type: 'button', className: MC.secondaryButton, onClick: props.onClose }, t('form.cancel')),
        h('button', { type: 'button', className: MC.primaryButton, onClick: () => props.onSave({ ...draft, key: draft.key.trim() }) }, t('form.save'))
      );
      if (isNew) {
        const modes = DshSegmentedControl
          ? h(DshSegmentedControl, {
              id: 'mo-image-add-mode',
              label: t('form.addMode'),
              value: mode,
              options: [
                { value: 'catalog', label: t('form.modeCatalog') },
                { value: 'custom', label: t('form.modeCustom') },
                { value: 'local', label: t('form.modeLocal') }
              ],
              onChange: (next) => switchMode(next)
            })
          : h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-1)' } },
              ['catalog', 'custom', 'local'].map((value) => h('button', {
                key: value, type: 'button', onClick: () => switchMode(value),
                style: { height: 28, padding: '0 12px', border: value === mode ? '.5px solid var(--dsw-alias-border-l3)' : 0, borderRadius: 'var(--dsw-radius-md)', background: value === mode ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: value === mode ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }
              }, value === 'catalog' ? t('form.modeCatalog') : value === 'custom' ? t('form.modeCustom') : t('form.modeLocal')))
            );
        const choosePreset = (id) => {
          const next = providerPresets.find((p) => p.id === id) || providerPresets[0];
          if (!next) return;
          setPresetId(next.id);
          setDraft({
            ...draft,
            name: next.name,
            baseUrl: next.baseUrl,
            adapter: next.adapter || '',
            protocol: next.protocol || 'openai-images',
            optionalKey: false,
            presetId: next.id,
            models: (next.models || []).slice(),
            names: {}
          });
        };
        const providerField = h('div', { className: MC.field },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('label', { className: MC.fieldLabel }, t('form.provider')),
            selectedPreset && selectedPreset.website ? h('a', {
              href: selectedPreset.website, target: '_blank', rel: 'noopener noreferrer',
              style: {
                fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-business-primary)',
                textDecoration: 'underline', whiteSpace: 'nowrap'
              }
            }, t('form.providerWebsite')) : null
          ),
          h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: presetId,
            onChange: (e) => choosePreset(e.target.value)
          }, providerPresets.map((p) => h('option', { key: p.id, value: p.id }, p.name)))
        );
        const catalogBody = h(React.Fragment, null,
          providerField,
          keyField,
          h('details', {
            className: MC.customized,
            open: advanced,
            onToggle: (e) => setAdvanced(e.currentTarget.open)
          },
            h('summary', { className: MC.customizedSummary }, t('form.advanced')),
            h('div', { className: MC.customizedBody },
              urlField,
              modelDirectory
            )
          )
        );
        const customBody = h(React.Fragment, null,
          nameField,
          urlField,
          protocolField,
          routePanel,
          hostModelField,
          keyField,
          modelDirectory
        );
        const localBody = h(React.Fragment, null,
          localPresets.length ? field(t('form.localDeployer'), h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: localPreset ? localPreset.id : localPresetId,
            onChange: (e) => applyLocalPreset(e.target.value)
          }, localPresets.map((item) => h('option', { key: item.id, value: item.id }, item.name)))) : h('p', { className: MC.advancedHint }, t('form.localPresetsMissing')),
          nameField,
          urlField,
          keyField,
          localHint ? h('p', { className: MC.advancedHint }, localHint) : null,
          modelDirectory
        );
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { className: MC.addModes },
            modes,
            h('p', { className: MC.advancedHint }, mode === 'catalog'
              ? t('form.modeCatalogHint')
              : mode === 'local'
                ? t('form.modeLocalHint')
                : t('form.modeCustomHint'))
          ),
          mode === 'catalog' ? catalogBody : mode === 'local' ? localBody : customBody,
          actions,
          modelPicker
        );
      }
      return h('div', { className: MC.editor },
        keyField,
        h('details', {
          className: MC.customized,
          open: advanced,
          onToggle: (e) => setAdvanced(e.currentTarget.open)
        },
          h('summary', { className: MC.customizedSummary }, t('form.advanced')),
          h('div', { className: MC.customizedBody },
            nameField,
            urlField,
            protocolField,
            routePanel,
            hostModelField,
            modelDirectory
          )
        ),
        actions,
        modelPicker
      );
    }

    /** 设置页标题行：左边标题与说明，右边在有新版时显示更新按钮。 */
    function UpdateHeader(props) {
      const t = props.t || fallbackTranslate;
      const status = props.status || {};
      const busy = status.state === 'updating';
      return h(React.Fragment, null,
        h('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
        },
          h('h2', { className: MC.title }, t('section.title')),
          busy || status.state === 'available'
            ? h('button', {
                type: 'button',
                className: MC.linkButton,
                'data-mo-image-update': '',
                disabled: busy,
                onClick: props.onOpen,
                style: {
                  flex: 'none',
                  padding: '3px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--dsw-alias-state-business-primary, #4d6bfe)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                  fontSize: 12,
                  lineHeight: '18px',
                  fontWeight: 500,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                  whiteSpace: 'nowrap'
                }
              }, busy ? t('update.starting') : t('update.available'))
            : null
        ),
        h('p', { className: MC.intro }, t('section.intro'))
      );
    }

    /** 更新对话框：标题、版本号、固定高度可滚动的说明、取消 / 更新。 */
    function UpdateDialog(props) {
      const t = props.t || fallbackTranslate;
      const status = props.status || {};
      const blocks = renderUpdateNotes(status.notes);
      React.useEffect(() => {
        const onKey = (event) => {
          if (event && event.key === 'Escape' && typeof props.onClose === 'function') props.onClose();
        };
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey);
          return () => {
            if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKey);
          };
        }
        return undefined;
      }, []);
      return h('div', {
        role: 'presentation',
        tabIndex: -1,
        style: {
          position: 'fixed', inset: 0, zIndex: 2000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.45)'
        },
        onKeyDown: (event) => {
          if (event && event.key === 'Escape' && typeof props.onClose === 'function') props.onClose();
        },
        onClick: (event) => {
          if (event && event.target === event.currentTarget && typeof props.onClose === 'function') props.onClose();
        }
      },
        h('div', {
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('update.title'),
          style: {
            width: 'min(560px, calc(100vw - 48px))',
            display: 'flex', flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
            color: 'var(--dsw-alias-label-primary, #1f2329)',
            borderRadius: 12, padding: 20,
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)'
          }
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('update.title')),
            h('button', {
              type: 'button',
              'aria-label': t('update.close'),
              onClick: props.onClose,
              style: {
                border: 0, background: 'transparent', cursor: 'pointer',
                fontSize: 18, lineHeight: 1, color: 'var(--dsw-alias-label-secondary, #646a73)'
              }
            }, '×')
          ),
          h('p', {
            style: { margin: '8px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #646a73)' }
          }, t('update.version', { from: status.current || '', to: status.latest || '' })),
          h('div', {
            style: {
              marginTop: 12, maxHeight: 320, overflowY: 'auto', overflowWrap: 'anywhere',
              fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap'
            }
          },
            blocks.length
              ? blocks.map((block, index) => {
                  if (block.kind === 'h') return h('div', { key: index, style: { fontWeight: 600, marginTop: 8 } }, block.text);
                  if (block.kind === 'li') return h('div', { key: index, style: { display: 'flex', gap: 6 } }, h('span', null, '•'), h('span', null, block.text));
                  return h('div', { key: index, style: { marginTop: 6 } }, block.text);
                })
              : h('div', null,
                  h('p', { style: { margin: 0 } }, t('update.noNotes')),
                  status.url
                    ? h('a', { href: status.url, target: '_blank', rel: 'noreferrer' }, t('update.viewRelease'))
                    : null
                )
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
            h('button', { type: 'button', className: MC.secondaryButton, onClick: props.onClose }, t('update.cancel')),
            h('button', { type: 'button', className: MC.primaryButton, onClick: props.onApply }, t('update.apply'))
          )
        )
      );
    }

    /** 页面底部的气泡宿主：显示队列里的最新一条，并在更新落定后负责收尾。 */
    function UpdateToastHost(props) {
      const t = props.t || fallbackTranslate;
      const [toast, setToast] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        setToast(toastQueue.current());
        const unsubscribe = toastQueue.subscribe((next) => setToast(next));
        const started = Date.now();
        const tick = async () => {
          if (!alive) return;
          // 插件正在被换掉时这条路由会短 404/断连；拿不到就当「再等等」。
    const status = await fetchUpdateStatus();
          if (!alive) return;
          if (status) {
            const text = updateToastFor(status, t);
            if (text && (status.state === 'done' || status.state === 'failed')) {
              toastQueue.push(text, status.state === 'failed' ? 'warning' : 'success');
              postUpdateAction({ action: 'ack' });
              return;
            }
          }
          const watching = Date.now() < updateWatchUntil || (status && status.state === 'updating');
          if (watching && Date.now() - started < 180_000) {
            setTimeout(() => { if (alive) tick(); }, 2000);
          }
        };
        tick();
        return () => { alive = false; unsubscribe(); };
      }, []);
      if (!toast) return null;
      if (DshToast) {
        return h(DshToast, {
          text: toast.text,
          tone: toast.tone === 'info' ? undefined : toast.tone,
          onDone: () => toastQueue.clear()
        });
      }
      return h('div', {
        role: 'status',
        style: {
          position: 'fixed', left: '50%', bottom: 48, transform: 'translateX(-50%)',
          zIndex: 2100, maxWidth: 'min(560px, calc(100vw - 48px))',
          padding: '8px 14px', borderRadius: 8, fontSize: 13,
          background: 'var(--dsw-alias-bg-layer-3, #2b2f36)',
          color: 'var(--dsw-alias-label-primary-inverse, #ffffff)',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.24)'
        }
      }, toast.text);
    }

    function ImageModelSettings(props) {
      useThemeClassRevision();
      const t = props.t || fallbackTranslate;
      const imageStore = useImageStore({ saved: true, t: t });
      const store = imageStore.store;
      const setStore = imageStore.setStore;
      const saveError = imageStore.error;
      const setSaveError = imageStore.setError;
      const [edit, setEdit] = React.useState(null);
      const [update, setUpdate] = React.useState(null);
      const [updateOpen, setUpdateOpen] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const load = async (attempt) => {
          const status = await fetchUpdateStatus();
          if (!alive || !status) return;
          setUpdate(status);
          // 首次检查可能要跑十几秒（API 超时后还要试降级地址），多等几轮。
  if ((status.state === 'checking' || !status.checkedAt) && attempt < 10) {
            setTimeout(() => { if (alive) load(attempt + 1); }, 2000);
          }
        };
        load(0);
        return () => { alive = false; };
      }, []);
      const applyUpdate = () => {
        setUpdateOpen(false);
        const status = update || {};
        if (!status.installable) {
          if (/^(link|file):/i.test(String(status.source || ''))) {
            pushToast(t('update.localDev'), 'warning');
          } else {
            pushToast(t('update.unsupported', { command: t('update.command', { tag: 'v' + String(status.latest || '') }) }), 'warning');
          }
          return;
        }
        watchUpdate();
        setUpdate({ ...status, state: 'updating' });
        pushToast(t('update.starting'), 'info');
        postUpdateAction({ action: 'apply' }).then((code) => {
          if (!code) return;
          pushToast(
            code === 'update.localDev'
              ? t('update.localDev')
              : t('update.unsupported', { command: t('update.command', { tag: 'v' + String(status.latest || '') }) }),
            'warning'
          );
        });
      };
      const save = (provider) => {
        setSaveError('');
        const exists = store.providers.some((p) => p.id === provider.id);
        const providers = exists ? store.providers.map((p) => p.id === provider.id ? provider : p) : store.providers.concat(provider);
        const activeModelStillThere = store.active.model === 'auto' || providers.some((p) => p.id === store.active.providerId && p.models.includes(store.active.model));
        const nextActive = activeModelStillThere ? store.active : { providerId: provider.id, model: provider.models[0] || '' };
        const saved = writeImageStore({ providers: providers, active: nextActive, defaults: store.defaults }, t);
        setStore(saved);
        setEdit(null);
      };
      const remove = (provider) => {
        const providers = store.providers.filter((p) => p.id !== provider.id);
        const active = store.active.providerId === provider.id ? { providerId: providers[0] ? providers[0].id : '', model: providers[0] && providers[0].models[0] ? providers[0].models[0] : '' } : store.active;
        const saved = writeImageStore({ providers: providers, active: active, defaults: store.defaults }, t);
        setStore(saved);
      };
      return h('div', { className: MC.section },
        h(UpdateHeader, { t: t, status: update || {}, onOpen: () => setUpdateOpen(true) }),
        saveError ? h('p', { className: MC.intro, role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, saveError) : null,
        h('ul', { className: MC.rows },
          store.providers.map((provider) => {
            const ready = !!(provider.baseUrl && (provider.hasKey || provider.key || provider.optionalKey) && provider.models.length);
            const local = !!provider.optionalKey || ['a1111', 'comfyui', 'swarmui'].includes(String(provider.adapter || ''));
            // 内置提供商有名字有官网，只在自定义端点时才需要「自定义」标签。
            const tag = local ? t('tag.local') : (isBuiltinProvider(provider) ? '' : t('tag.custom'));
            const editing = edit && !edit.isNew && edit.provider.id === provider.id;
            return h('li', { className: MC.rowCard, key: provider.id },
              h('div', { className: MC.rowHead },
                h('span', { className: MC.rowIdentity },
                  h('span', { className: MC.rowName }, provider.name || t('section.unnamedProvider')),
                  tag ? h('span', { className: MC.rowTag }, tag) : null,
                  h('span', {
                    className: MC.credentialDot + ' ' + (ready ? MC.credentialDotConfigured : MC.credentialDotMissing),
                    title: ready ? t('status.ready') : (provider.optionalKey ? t('status.missingLocal') : t('status.missingCloud')),
                    'aria-label': ready ? t('status.ready') : t('status.missingConfig')
                  })
                ),
                h('span', { className: MC.rowActions },
                  h('button', { type: 'button', className: MC.secondaryButton, onClick: () => setEdit({ provider: provider, isNew: false }) }, t('action.edit')),
                  h('button', { type: 'button', className: MC.dangerButton, onClick: () => remove(provider) }, t('action.delete'))
                )
              ),
              editing ? h(ImageProviderForm, { provider: edit.provider, onSave: save, onClose: () => setEdit(null), sizeAuto: store.defaults.auto !== false, t: t }) : null
            );
          })
        ),
        h('div', { className: MC.addBlock },
          edit && edit.isNew
            ? h('div', { className: MC.addCard }, h(ImageProviderForm, { provider: edit.provider, isNew: true, onSave: save, onClose: () => setEdit(null), sizeAuto: store.defaults.auto !== false, t: t }))
            : h('div', { className: MC.addActions },
                h('button', { type: 'button', className: MC.addButton, onClick: () => setEdit({ provider: { id: makeId(), name: '', baseUrl: '', key: '', apiKeyEnv: '', adapter: '', protocol: 'openai-images', optionalKey: false, models: [] }, isNew: true }) }, '+ ' + t('action.addProvider'))
              )
        ),
        updateOpen ? h(UpdateDialog, {
          t: t,
          status: update || {},
          onClose: () => setUpdateOpen(false),
          onApply: applyUpdate
        }) : null
      );
    }

    /** 「?」帮助标记：悬停立刻出现（不走 title 的原生延迟），点击/键盘聚焦也能看。 */
    function MoHelp(props) {
      const text = String((props && props.text) || '');
      const [pos, setPos] = React.useState(null);
      const ref = React.useRef(null);
      if (!text) return null;
      const show = () => {
        const el = ref.current;
        if (!el || typeof window === 'undefined') return;
        const box = el.getBoundingClientRect();
        const width = 236;
        // 生图席在输入框上方，气泡往下弹会被视口切掉；下面放不下就翻到上面。
        const below = window.innerHeight - box.bottom;
        const above = below < 96;
        setPos({
          left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
          top: above ? box.top - 6 : box.bottom + 6,
          above: above
        });
      };
      const hide = () => setPos(null);
      return h('span', {
        ref: ref,
        role: 'img',
        tabIndex: 0,
        'aria-label': text,
        onPointerEnter: show,
        onPointerLeave: hide,
        onFocus: show,
        onBlur: hide,
        style: {
          width: 14, height: 14, flex: 'none', borderRadius: '50%',
          border: '1px solid currentColor', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: 10, lineHeight: 1, opacity: 0.55, cursor: 'help'
        }
      }, '?', pos && typeof document !== 'undefined' ? createPortal(h('div', {
        role: 'tooltip',
        style: {
          // 席菜单/弹层都在 2000 以上（Codex 弹层是 2147482000），气泡必须压过它们。
          position: 'fixed', left: pos.left, top: pos.top, zIndex: 2147483000,
          transform: pos.above ? 'translateY(-100%)' : undefined,
          width: 236, padding: '6px 8px', borderRadius: 8,
          border: '.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2, #2b2b2d)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 12, lineHeight: 1.45, textAlign: 'left', fontWeight: 400,
          boxShadow: '0 8px 24px rgba(0, 0, 0, .24)'
        }
      }, text), document.body) : null);
    }

    /**
     * Codex skin for the image seat. It reuses the global cmes-* classes and the
     * DOM shape already injected by dsh-codex-model-effort-selector, so both
     * seats read as one skin. "Quality" takes the effort rail slot; size and
     * prompt optimization live in the gear "other settings" page.
     */
    function CodexImageSeat(props) {
      const t = props.t || fallbackTranslate;
      const store = props.store || { providers: [], active: { providerId: '', model: '' }, defaults: normalizeDefaults(null) };
      const setStore = typeof props.setStore === 'function' ? props.setStore : () => {};
      const seatView = deriveSeatView(store, t, props.qualitySpec);
      const defaults = seatView.defaults;
      const active = seatView.active;
      const activeProvider = seatView.activeProvider;
      const activeModelName = seatView.activeModelName;
      const triggerLabel = seatView.triggerLabel;
      const activeSpec = seatView.qualitySpec;
      const levels = qualityRailLevels(activeSpec);

      // 真正写进请求的提示词优化开关，不是 codex 的纯视觉 Fast。
      const promptOptimization = defaults.promptOptimization !== false;
      // The visual peak is always "Ultra", whatever the backend calls its top
      // stop (high/max/xhigh/...). The stored value and request are untouched.
      const topLevelValue = levels.length > 1 ? levels[levels.length - 1].value : null;
      const codexQualityLabel = (value) => (
        topLevelValue !== null && qualityValueFor(value, activeSpec) === topLevelValue
          ? 'Ultra'
          : qualityLabelFor(value, activeSpec, t)
      );
      // Ultra is a frontend skin: whatever id the backend uses for its top
      // stop, the label and its violet ink both use the codex peak bucket.
      const codexVisualValue = (value) => (
        topLevelValue !== null && qualityValueFor(value, activeSpec) === topLevelValue
          ? 'max'
          : value
      );

      function isDarkNow() {
        try {
          return typeof document !== 'undefined' && document.body != null
            && typeof document.body.hasAttribute === 'function'
            && document.body.hasAttribute('data-ds-dark-theme');
        } catch (_error) { return false; }
      }
      const [dark, setDark] = React.useState(isDarkNow());
      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return undefined;
        const observer = new MutationObserver(() => setDark(isDarkNow()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        return () => observer.disconnect();
      }, []);
      const [open, setOpen] = React.useState(false);
      const [pane, setPane] = React.useState('quality');
      const [view, setView] = React.useState(1);
      const [subProvider, setSubProvider] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [highlight, setHighlight] = React.useState(0);
      const [preview, setPreview] = React.useState(null);
      const [dragging, setDragging] = React.useState(false);
      const [message, setMessage] = React.useState(false);
      const [bloom, setBloom] = React.useState(0);
      const [widthDraft, setWidthDraft] = React.useState('');
      const [heightDraft, setHeightDraft] = React.useState('');
      const [menuPos, setMenuPos] = React.useState(null);
      const [liveFraction, setLiveFraction] = React.useState(null);
      const [hoveredDot, setHoveredDot] = React.useState(-1);
      const [tipOn, setTipOn] = React.useState(false);
      const triggerRef = React.useRef(null);
      const popoverRef = React.useRef(null);
      const fastBtnRef = React.useRef(null);
      const tipRef = React.useRef(null);
      const railRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const messageTimer = React.useRef(0);
      const dragRef = React.useRef(null);
      const seenIndexRef = React.useRef(null);

      const value = qualityValueFor(defaults.quality, activeSpec);
      const levelIndex = Math.max(0, levels.findIndex((level) => level.value === value));
      const displayed = preview !== null ? preview : value;
      const displayIndex = Math.max(0, levels.findIndex((level) => level.value === displayed));
      const fraction = dragging && liveFraction !== null
        ? liveFraction
        : (levels.length > 1 ? displayIndex / (levels.length - 1) : 0);
      // 动画和额度提示都跟「滑到最高档」走；Auto 不在最高档时不误报。
    const atTop = levels.length > 1 && displayIndex === levels.length - 1;
      const peak = atTop;
      const qualityLabel = levels.length ? codexQualityLabel(value) : '';
      const displayLabel = levels.length ? codexQualityLabel(displayed) : '';
      const tipShown = tipOn && open && pane === 'quality';
      const sparkles = React.useMemo(() => buildCodexSparkles(22), []);
      const bloomMotes = React.useMemo(() => buildCodexBloom(18), []);
      const hasAnyModel = seatView.hasAnyModel;
      const selectedAuto = active.model === 'auto';
      const showAutoRow = hasAnyModel;
      // subProvider 三种取值：提供商 id、__size（尺寸设置页）、__size-aspect / __size-tier / __size-preset（尺寸选项页）。
      const activeProviderForPage = subProvider && String(subProvider).charAt(0) !== '_'
        ? store.providers.find((provider) => provider.id === subProvider) || null
        : null;
      const isSettingsPage = subProvider === '__size';
      const sizeSubPage = typeof subProvider === 'string' && subProvider.indexOf('__size-') === 0
        ? subProvider.slice('__size-'.length)
        : '';

      const closeMenu = () => {
        setOpen(false);
        setPane('quality');
        setView(1);
        setSubProvider(null);
        setQuery('');
        setMessage(false);
      };

      const saveDefaults = (patch) => commitSeatDefaults(store, defaults, setStore, patch, t);
      const isTopQuality = (value) => levels.length > 1
        && levels.findIndex((level) => level.value === value) === levels.length - 1;
      const flashPeakWarning = (nextValue, previousValue) => {
        const wasTop = isTopQuality(previousValue);
        const nowTop = isTopQuality(nextValue);
        if (messageTimer.current) { clearTimeout(messageTimer.current); messageTimer.current = 0; }
        if (nowTop && !wasTop) {
          setMessage(true);
          messageTimer.current = setTimeout(() => { messageTimer.current = 0; setMessage(false); }, 1800);
        } else if (!nowTop) {
          setMessage(false);
        }
      };
      const chooseQuality = (nextValue) => {
        const wanted = activeSpec ? qualityValueFor(nextValue, activeSpec) : nextValue;
        flashPeakWarning(wanted, value);
        saveDefaults({ quality: wanted });
        setPreview(null);
      };
      const chooseModel = (providerId, model) => {
        commitSeatModel(store, defaults, setStore, providerId, model, t);
        setPane('quality');
        setView(1);
        setSubProvider(null);
        setQuery('');
        setPreview(null);
      };
      const chooseAuto = () => {
        chooseModel(activeProvider ? activeProvider.id : '', 'auto');
      };
      const openProvider = (providerId) => {
        setSubProvider(providerId);
        setView(2);
        setQuery('');
        setHighlight(0);
      };
      const openSettings = () => {
        setPane('models');
        setSubProvider('__size');
        setView(2);
        setQuery('');
      };
      const backFromSizePage = () => {
        if (sizeSubPage) { setSubProvider('__size'); return; }
        goBack();
      };
      const goBack = () => {
        if (isSettingsPage) {
          setPane('quality');
          setView(1);
          setSubProvider(null);
          setQuery('');
          setHighlight(0);
          return;
        }
        setView(1);
        setSubProvider(null);
        setQuery('');
        setHighlight(0);
      };

      // 弹层定位：贴住触发器右缘向上展开（生图席在输入区最右侧）。
  React.useLayoutEffect(() => {
        // 关闭时保留最后一次位置给退场动画用；清空会 .closed 的过渡在
        // left:0/bottom:40 的兜底位置播放，看起来就是左下角闪一下。
  if (!open) return undefined;
        const place = () => {
          const trigger = triggerRef.current;
          if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;
          setMenuPos(codexPlacement(
            trigger.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            CODEX_POPOVER_WIDTH,
            CODEX_MARGIN
          ));
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        const observer = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => place())
          : null;
        if (observer && triggerRef.current) observer.observe(triggerRef.current);
        return () => {
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
          if (observer) observer.disconnect();
        };
      }, [open, pane]);

      // 外部点击 / Escape 逐层退避。
  React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const trigger = triggerRef.current;
          const popover = popoverRef.current;
          if (trigger && trigger.contains(event.target)) return;
          if (popover && popover.contains(event.target)) return;
          closeMenu();
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          event.preventDefault();
          if (pane === 'models' && view === 2 && sizeSubPage) { setSubProvider('__size'); return; }
          if (pane === 'models' && view === 2) goBack();
          else if (pane === 'models') setPane('quality');
          else closeMenu();
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open, pane, view, subProvider]);

      React.useEffect(() => {
        if (!open || pane !== 'models' || view !== 2 || isSettingsPage) return undefined;
        const timer = setTimeout(() => {
          try { if (searchRef.current) searchRef.current.focus(); } catch (_error) { /* ignore */ }
        }, 40);
        return () => clearTimeout(timer);
      }, [open, pane, view, isSettingsPage]);

      // 抵达峰值档时触发一次绽开；打开时本来就停在峰值不炸。
  React.useEffect(() => {
        if (!open || !levels.length) { seenIndexRef.current = null; return; }
        const previous = seenIndexRef.current;
        seenIndexRef.current = displayIndex;
        if (previous === null) return;
        if (displayIndex === levels.length - 1 && previous !== displayIndex) {
          setBloom((count) => count + 1);
        }
      }, [open, displayIndex, levels.length, displayed]);

      React.useEffect(() => () => {
        if (messageTimer.current) clearTimeout(messageTimer.current);
      }, []);

      // Codex 的 Fast 浮层同款：fixed 定位，贴在星标按钮上方。工具提示不能
      // 放进弹层内部，弹层的 backdrop-filter 会成为 fixed 后代的包含块并裁剪它。
      function positionTip() {
        const tip = tipRef.current;
        const btn = fastBtnRef.current;
        if (!tip || !btn) return;
        const rect = btn.getBoundingClientRect();
        const tipWidth = tip.offsetWidth || 120;
        const tipHeight = tip.offsetHeight || 44;
        const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipWidth / 2, window.innerWidth - tipWidth - 8));
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(8, rect.top - tipHeight - 7)}px`;
      }
      React.useLayoutEffect(() => {
        if (!tipShown) return undefined;
        positionTip();
        const settle = () => positionTip();
        window.addEventListener('resize', settle);
        document.addEventListener('scroll', settle, true);
        return () => {
          window.removeEventListener('resize', settle);
          document.removeEventListener('scroll', settle, true);
        };
      }, [tipShown]);
      React.useEffect(() => { if (!open) setTipOn(false); }, [open]);
      React.useEffect(() => { if (pane !== 'quality') setTipOn(false); }, [pane]);

      /* Ramp the run layer's speed instead of snapping from 1x to 0x: entering
       * Fast eases 0.15x -> 1x; leaving it eases to 0 while CSS fades the layer. */
      React.useEffect(() => {
        const root = popoverRef.current;
        if (!root || typeof root.querySelectorAll !== 'function'
          || typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') return undefined;
        const animations = Array.from(root.querySelectorAll('.cmes-sp-run'))
          .flatMap(node => (typeof node.getAnimations === 'function' ? node.getAnimations() : []));
        if (!animations.length) return undefined;
        if (promptOptimization) {
          animations.forEach(animation => {
            animation.currentTime = 0;
            animation.playbackRate = 0.15;
          });
        }
        const from = animations.map(animation => animation.playbackRate || 1);
        const started = performance.now();
        const duration = promptOptimization ? 900 : 800;
        let frame = 0;
        const step = (now) => {
          const t = Math.min(1, (now - started) / duration);
          animations.forEach((animation, index) => {
            animation.playbackRate = promptOptimization
              ? from[index] + (1 - from[index]) * t
              : from[index] * (1 - t);
          });
          if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
      }, [promptOptimization]);

      const commitSide = (side, text) => {
        const digits = String(text || '').replace(/[^0-9]/g, '');
        const number = Number(digits);
        if (!Number.isFinite(number) || number < IMAGE_MIN_SIDE || number > IMAGE_MAX_SIDE) return;
        saveDefaults(side === 'width' ? { width: number } : { height: number });
      };
      const fractionAt = (clientX) => {
        const rail = railRef.current;
        if (!rail || typeof rail.getBoundingClientRect !== 'function') return 0;
        const box = rail.getBoundingClientRect();
        if (!box || box.width <= 30) return 0;
        return Math.max(0, Math.min(1, (clientX - box.left - 15) / (box.width - 30)));
      };
      const paintLive = (fractionValue) => {
        const rail = railRef.current;
        if (rail && rail.style && typeof rail.style.setProperty === 'function') {
          rail.style.setProperty('--cmes-pos', String(fractionValue));
        }
      };
      const snapTo = (index) => {
        const safe = Math.max(0, Math.min(levels.length - 1, index));
        paintLive(levels.length > 1 ? safe / (levels.length - 1) : 0);
        return safe;
      };
      /* On release, `.dragging` disables the knob's left transition. Remove the
       * class first and snap on the next frame so the knob slides to the stop. */
      const settleTo = (index) => {
        const safe = Math.max(0, Math.min(levels.length - 1, index));
        const fractionValue = levels.length > 1 ? safe / (levels.length - 1) : 0;
        try {
          if (railRef.current && railRef.current.classList) railRef.current.classList.remove('dragging');
        } catch (_error) { /* ignore */ }
        const write = () => paintLive(fractionValue);
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(write);
        else write();
        return safe;
      };
      const pointerDown = (event) => {
        if (!levels.length) return;
        if (event && event.button !== undefined && event.button !== 0) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        try { if (railRef.current && railRef.current.focus) railRef.current.focus({ preventScroll: true }); } catch (_error) { /* ignore */ }
        const pointerId = event && event.pointerId !== undefined ? event.pointerId : 0;
        dragRef.current = { pointerId: pointerId, startX: event ? event.clientX : 0, moved: false };
        const move = (moveEvent) => {
          if (!dragRef.current || (moveEvent.pointerId !== undefined && moveEvent.pointerId !== dragRef.current.pointerId)) return;
          if (!dragRef.current.moved) {
            if (Math.abs(moveEvent.clientX - dragRef.current.startX) < 3) return;
            dragRef.current.moved = true;
            setDragging(true);
            try { if (railRef.current && railRef.current.classList) railRef.current.classList.add('dragging'); } catch (_error) { /* ignore */ }
          }
          const ratio = fractionAt(moveEvent.clientX);
          paintLive(ratio);
          setLiveFraction(ratio);
          const nearest = Math.round(ratio * (levels.length - 1));
          setPreview(levels[Math.max(0, Math.min(levels.length - 1, nearest))].value);
        };
        const finish = (upEvent) => {
          if (!dragRef.current) return;
          dragRef.current = null;
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', finish, true);
          document.removeEventListener('pointercancel', cancel, true);
          setDragging(false);
          setLiveFraction(null);
          const index = upEvent && upEvent.clientX !== undefined
            ? Math.round(fractionAt(upEvent.clientX) * (levels.length - 1))
            : levelIndex;
          const safe = settleTo(index);
          const target = levels[safe];
          if (target) chooseQuality(target.value);
          else setPreview(null);
        };
        const cancel = () => {
          if (!dragRef.current) return;
          dragRef.current = null;
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', finish, true);
          document.removeEventListener('pointercancel', cancel, true);
          setDragging(false);
          setLiveFraction(null);
          setPreview(null);
          settleTo(levelIndex);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', finish, true);
        document.addEventListener('pointercancel', cancel, true);
      };
      const railKeyDown = (event) => {
        if (!levels.length) return;
        let next = displayIndex;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = levels.length - 1;
        else return;
        event.preventDefault();
        const safe = snapTo(next);
        chooseQuality(levels[safe].value);
      };

      const providerModels = activeProviderForPage
        ? activeProviderForPage.models.filter((model) => {
          const needle = query.trim().toLowerCase();
          if (!needle) return true;
          const display = modelDisplayName(activeProviderForPage, model).toLowerCase();
          if (model.toLowerCase().includes(needle) || display.includes(needle)) return true;
          let at = 0;
          for (const char of display) if (char === needle[at]) at += 1;
          return at === needle.length;
        })
        : [];
      const page2Rows = providerModels.length;
      const page1Rows = (showAutoRow ? 1 : 0) + store.providers.length;

      const checkIcon = (on) => h('span', { className: 'cmes-ck' },
        on ? h('svg', {
          viewBox: '0 0 24 24', 'aria-hidden': true,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
        }, h('path', { d: 'm20 6-11 11-5-5' })) : null);
      const chevron = (cls) => h('svg', {
        className: cls, viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      }, h('path', { d: 'm9 18 6-6-6-6' }));
      const backChevron = h('svg', {
        className: 'cmes-iconSmall', viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      }, h('path', { d: 'm15 18-6-6 6-6' }));
      const downChevron = h('svg', {
        className: 'cmes-chev', viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      }, h('path', { d: 'm6 9 6 6 6-6' }));
      const starIcon = (cls, on) => h('svg', {
        className: (cls ? cls + ' ' : '') + 'cmes-star', viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: on ? 'currentColor' : 'none', stroke: 'currentColor',
        strokeWidth: on ? 0.7 : 1.4, strokeLinejoin: 'round', strokeLinecap: 'round',
        style: { width: 16, height: 16, display: 'block', flex: 'none', margin: '0 auto' }
      },
        // Big centre sparkle plus the two small ones — the familiar AI mark.
        h('path', {
          d: 'M12 3.5c.85 5.1 2.45 6.7 7.55 7.55-5.1.85-6.7 2.45-7.55 7.55-.85-5.1-2.45-6.7-7.55-7.55 5.1-.85 6.7-2.45 7.55-7.55Z'
        }),
        h('path', {
          d: 'M19 1.5c.35 2.1 1.05 2.8 3.15 3.15-2.1.35-2.8 1.05-3.15 3.15-.35-2.1-1.05-2.8-3.15-3.15 2.1-.35 2.8-1.05 3.15-3.15Z'
        }),
        h('path', {
          d: 'M5 15.5c.35 2.1 1.05 2.8 3.15 3.15-2.1.35-2.8 1.05-3.15 3.15-.35-2.1-1.05-2.8-3.15-3.15 2.1-.35 2.8-1.05 3.15-3.15Z'
        }));
      // 其他设置工具用齿轮，避免和尺寸/全屏混淆。
    const sizeIcon = h('svg', {
        className: 'cmes-iconSmall', viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'
      },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', {
          d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z'
        }));
      const imageIcon = h('svg', {
        viewBox: '0 0 24 24', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { width: 15, height: 15 }
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
        h('circle', { cx: 8.2, cy: 9.2, r: 1.4 }),
        h('path', { d: 'M4 17l5-4.6 3.2 3 3.8-4.2L20 17' }));

      const visualDisplay = codexVisualValue(displayed);
      const railColors = {
        '--cmes-fill': codexFillFor(visualDisplay, dark),
        '--cmes-track': codexTrackFor(codexFillFor(visualDisplay, dark), dark),
        '--cmes-ink': codexInkFor(visualDisplay, dark),
        '--cmes-dot': 'var(--dsw-alias-label-caption,#b6b6b8)',
        '--cmes-mote': codexMixHex(codexFillFor(visualDisplay, dark), '#ffffff', dark ? 0.30 : 0.42),
        '--cmes-pos': String(fraction)
      };
      const triggerStyle = { '--cmes-ink': codexInkFor(codexVisualValue(value), dark) };

      const autoRow = h('button', {
        key: '__auto', type: 'button', className: 'cmes-row',
        'aria-pressed': selectedAuto,
        onClick: chooseAuto,
        title: t('seat.modelAutoHint')
      },
        h('span', { className: 'cmes-rowName' }, t('seat.auto')),
        selectedAuto ? h('span', { className: 'cmes-rowDot', 'aria-hidden': true }) : null,
        null
      );
      const providerRows = store.providers.map((provider) => h('button', {
        key: provider.id, type: 'button', className: 'cmes-row',
        'aria-expanded': view === 2 && subProvider === provider.id,
        onClick: () => openProvider(provider.id)
      },
        h('span', { className: 'cmes-rowName' }, provider.name || t('section.unnamedProvider')),
        !selectedAuto && store.active.providerId === provider.id
          ? h('span', { className: 'cmes-rowDot', 'aria-hidden': true })
          : null,
        chevron('cmes-rowChev')
      ));
      const page1RowsNode = h('div', { className: 'cmes-rows' },
        showAutoRow ? autoRow : null,
        providerRows,
        store.providers.length ? null : h('div', { className: 'cmes-empty' }, t('seat.empty'))
      );
      const modelRows = providerModels.map((model) => {
        const modelSpec = qualitySpecFor(activeProviderForPage.id, model);
        const count = qualityRailLevels(modelSpec).length;
        const selected = store.active.providerId === activeProviderForPage.id && store.active.model === model;
        return h('button', {
          key: model, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
          className: 'cmes-model' + (selected ? ' sel' : '') + (count ? '' : ' na'),
          onClick: () => chooseModel(activeProviderForPage.id, model),
          title: modelDisplayName(activeProviderForPage, model)
        },
          h('span', { className: 'cmes-modelName' },
            h('span', null, modelDisplayName(activeProviderForPage, model)),
            h('span', { className: 'cmes-cnt' }, count ? t('seat.levelsCount', { count: count }) : t('seat.levelsNone'))
          ),
          checkIcon(selected)
        );
      });
      // Codex 皮肤的这一页也按模型形态渲染：宽高 / 比例+档位 / 预设（档位）/ 写进提示词。
      // 设置页（subProvider === '__size'）没有 provider 上下文，要退回当前生效的提供商；
      // 模型是 Auto、或者是能力表里没有的模型时，取该提供商的第一张模型。
      const pageProvider = activeProviderForPage
        || store.providers.find((provider) => provider.id === store.active.providerId)
        || null;
      const pageProviderId = pageProvider ? pageProvider.id : '';
      const activeModelId = store.active.model && store.active.model !== 'auto' ? store.active.model : '';
      let pageSizeSpec = activeModelId ? sizeSpecFor(pageProviderId, activeModelId) : null;
      let pageModel = activeModelId;
      if (!pageSizeSpec) {
        pageModel = String((pageProvider && pageProvider.models[0]) || '');
        pageSizeSpec = pageModel ? sizeSpecFor(pageProviderId, pageModel) : null;
      }
      const pageControl = sizeControlOf(pageSizeSpec);
      const pageAspects = pageSizeSpec && Array.isArray(pageSizeSpec.aspects) ? pageSizeSpec.aspects : [];
      const pageTiers = pageSizeSpec && Array.isArray(pageSizeSpec.tiers) ? pageSizeSpec.tiers.map((tier) => String(tier.value)) : [];
      const pageCustom = !!(pageSizeSpec && pageSizeSpec.custom);
      const pagePreset = pageTiers.includes(String(defaults.preset))
        ? String(defaults.preset)
        : (pageCustom ? '__custom' : String(pageTiers[0] || ''));
      const pageCustomMode = pageControl === 'preset' && pageCustom && pagePreset === '__custom';
      const inputStyle = { width: 92, height: 26, borderRadius: 8, border: '.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12, textAlign: 'right', padding: '0 8px', outline: 'none' };
      /**
       * 比例有十几档，原生下拉在弹层里会拉成一长条；这里自己画一个限高可滚动的列表。
       * 选项少（档位通常 3-4 个）时仍然用原生 select，交互更顺。
       */
      // 和模型列表一样用 N 级菜单：点行进入下一页，选完回到尺寸设置页，没有 select。
      const codexLink = (label, value, target) => h('button', {
        type: 'button', className: 'cmes-row', disabled: defaults.auto,
        // button 默认按基线排，箭头会偏低；这里显式做成居中三栏。
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left' },
        'aria-label': label + ' ' + value,
        onClick: () => setSubProvider(target)
      },
        h('span', { className: 'cmes-rowName', style: { flex: '1 1 auto', minWidth: 0 } }, label),
        h('span', { className: 'cmes-rowValue' }, value),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' } }, chevron('cmes-iconSmall'))
      );
      const sizeSubLabel = (which) => (which === 'aspect' ? t('seat.sizeAspect')
        : which === 'tier' ? t('seat.sizeTier')
        : t('seat.sizePreset'));
      // 档位是字符串，预设末尾还要追加一条「自定义」；两者不能混成一个数组再统一
      // String()，否则那条对象会被拼成 [object Object]，标签和取值一起坏掉。
      const sizeSubItems = (which) => {
        if (which === 'aspect') return pageAspects.map((value) => ({ value: String(value), label: String(value) }));
        const values = pageTiers.slice();
        if (which === 'preset' && pageCustom) values.push('__custom');
        return values.map((value) => ({
          value: value,
          label: value === '__custom' ? t('seat.sizeCustom') : value
        }));
      };
      const sizeSubCurrent = (which) => (which === 'aspect'
        ? (String(defaults.aspect || '') || String(pageAspects[0] || ''))
        : which === 'tier'
          ? (String(defaults.tier || '') || String(pageTiers[0] || ''))
          : pagePreset);
      const sizeSubPick = (which, value) => {
        if (which === 'aspect') saveDefaults({ aspect: value });
        else if (which === 'tier') saveDefaults({ tier: value });
        else saveDefaults({ preset: value });
        setSubProvider('__size');
      };
      // 严格模式紧跟自动尺寸：它管的是请求里的尺寸算不算数，与自动/固定无关。
      const codexRows = [h('div', { className: 'cmes-row', style: { cursor: 'default' } },
        h('span', { className: 'cmes-rowName', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          t('seat.sizeStrict'), h(MoHelp, { text: t('seat.sizeStrictHelp') })),
        h('input', {
          type: 'checkbox', checked: !!defaults.strict, 'aria-label': t('seat.sizeStrict'),
          title: t('seat.sizeStrictHint'),
          style: { accentColor: 'var(--dsw-alias-state-business-primary, #3989f6)', width: 16, height: 16 },
          onChange: (event) => saveDefaults({ strict: event.target.checked })
        })
      )];
      if (pageControl === 'aspect' && pageAspects.length) {
        codexRows.push(codexLink(t('seat.sizeAspect'), sizeSubCurrent('aspect'), '__size-aspect'));
        if (pageTiers.length) {
          codexRows.push(codexLink(t('seat.sizeTier'), sizeSubCurrent('tier'), '__size-tier'));
        }
      } else if (pageControl === 'preset') {
        codexRows.push(codexLink(t('seat.sizePreset'),
          pagePreset === '__custom' ? t('seat.sizeCustom') : pagePreset,
          '__size-preset'));
      }
      // 档位就是最终尺寸，宽高这两行只在「自定义」下才有意义。
      if (pageControl === 'wh' || pageControl === 'prompt' || (pageControl === 'preset' && pageCustomMode)) {
        codexRows.push(h('div', { className: 'cmes-row', style: { cursor: 'default' } },
          h('span', { className: 'cmes-rowName' }, t('seat.width')),
          h('input', {
            type: 'text', inputMode: 'numeric', disabled: defaults.auto, 'aria-label': t('seat.width'),
            value: widthDraft || String(defaults.width),
            style: inputStyle,
            onBlur: () => setWidthDraft(''),
            onChange: (event) => {
              const text = String(event.target.value).replace(/[^0-9]/g, '');
              setWidthDraft(text);
              commitSide('width', text);
            }
          })
        ));
        codexRows.push(h('div', { className: 'cmes-row', style: { cursor: 'default' } },
          h('span', { className: 'cmes-rowName' }, t('seat.height')),
          h('input', {
            type: 'text', inputMode: 'numeric', disabled: defaults.auto, 'aria-label': t('seat.height'),
            value: heightDraft || String(defaults.height),
            style: inputStyle,
            onBlur: () => setHeightDraft(''),
            onChange: (event) => {
              const text = String(event.target.value).replace(/[^0-9]/g, '');
              setHeightDraft(text);
              commitSide('height', text);
            }
          })
        ));
      }
      if (pageControl === 'prompt') {
        codexRows.push(h('div', { className: 'cmes-row', style: { cursor: 'default' } },
          h('span', { className: 'cmes-rowName', style: { opacity: 0.7 } }, t('seat.sizePromptHint'))));
      }
      if (pageSizeSpec && pageSizeSpec.hint) {
        const pageHintKey = 'seat.sizeHint.' + String(pageSizeSpec.hint);
        codexRows.push(h('div', { className: 'cmes-row', style: { cursor: 'default' } },
          h('span', { className: 'cmes-rowName', style: { opacity: 0.7 } }, t(pageHintKey))));
      }
      const settingsForm = h('div', { key: 'size-form', className: 'cmes-rows' },
        h('div', { className: 'cmes-sec' }, t('seat.sizeTitle')),
        h('div', { className: 'cmes-row', style: { cursor: 'default' } },
          h('span', { className: 'cmes-rowName', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            t('seat.sizeAutoValue'), h(MoHelp, { text: t('seat.sizeAutoHelp') })),
          h('input', {
            type: 'checkbox', checked: !!defaults.auto, 'aria-label': t('seat.sizeAutoAria'),
            style: { accentColor: 'var(--dsw-alias-state-business-primary, #3989f6)', width: 16, height: 16 },
            onChange: (event) => saveDefaults({ auto: event.target.checked })
          })
        ),
        ...codexRows
      );
      let desiredHeight = CODEX_QUALITY_HEIGHT;
      if (pane === 'models') {
        const M = CODEX_METRICS;
        desiredHeight = sizeSubPage
          ? M.pad + M.head + Math.min(sizeSubItems(sizeSubPage).length * M.model + M.listPad, M.listMax)
          : isSettingsPage
          ? M.pad + M.head + M.section + (1 + codexRows.length) * M.row + 2 * M.listPad
          : (view === 2
            ? M.pad + Math.max(44, M.head + M.search
              + Math.min(page2Rows * M.model + M.listPad, M.listMax)
              + (providerModels.length ? 0 : M.empty))
            : M.pad + Math.max(44, M.section + page1Rows * M.row
              + (store.providers.length ? 0 : M.empty)));
      }
      const roomAbove = menuPos ? Math.max(120, window.innerHeight - menuPos.bottom - CODEX_MARGIN) : desiredHeight;
      const popoverHeight = Math.min(desiredHeight, roomAbove);
      const sizeSubList = sizeSubPage
        ? h('div', { key: 'size-pick', className: 'cmes-list' },
          sizeSubItems(sizeSubPage).map((item) => {
            const selected = item.value === sizeSubCurrent(sizeSubPage);
            return h('button', {
              key: item.value, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
              className: 'cmes-model' + (selected ? ' sel' : ''),
              onClick: () => sizeSubPick(sizeSubPage, item.value)
            },
              h('span', { className: 'cmes-modelName' }, h('span', null, item.label)),
              checkIcon(selected)
            );
          }))
        : null;
      const page2Body = sizeSubPage
        ? sizeSubList
        : isSettingsPage
        ? settingsForm
        : [
            h('label', { key: 'search', className: 'cmes-search' },
              h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', style: { width: 13, height: 13, flex: 'none' } },
                h('path', { d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4' })),
              h('input', {
                ref: searchRef, type: 'text', value: query,
                placeholder: t('seat.searchPlaceholder'), 'aria-label': t('seat.searchAria'),
                spellCheck: false,
                onChange: (event) => { setQuery(event.target.value); setHighlight(0); },
                onKeyDown: (event) => {
                  if (!providerModels.length) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setHighlight((current) => (current + delta + providerModels.length) % providerModels.length);
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const model = providerModels[Math.max(0, Math.min(highlight, providerModels.length - 1))];
                    if (model) chooseModel(activeProviderForPage.id, model);
                  }
                }
              })
            ),
            h('div', {
              key: 'list', className: 'cmes-list',
              onKeyDown: (event) => {
                if (!providerModels.length) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  setHighlight((current) => (current + delta + providerModels.length) % providerModels.length);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const model = providerModels[Math.max(0, Math.min(highlight, providerModels.length - 1))];
                  if (model) chooseModel(activeProviderForPage.id, model);
                }
              }
            },
              modelRows,
              modelRows.length ? null : h('div', { className: 'cmes-empty' }, t('seat.noMatches'))
            )
          ];
      const modelsPane = h('div', {
        className: 'cmes-pane cmes-models' + (pane === 'models' ? '' : ' hidden'),
        role: 'menu', 'aria-label': t('seat.menuModel'),
        inert: pane !== 'models' ? '' : undefined
      },
        h('div', { className: 'cmes-viewport' + (view === 2 ? ' view2' : '') },
          // 不要在这里写 transition：`.cmes-page` 的 .3s cubic-bezier(.32,.72,.28,1)
          // 由 codex 样式表提供；内联 ease 会让滑动比 codex 更快、还会抖。
          h('div', {
            className: 'cmes-page slot1',
            inert: view === 2 ? '' : undefined
          },
            h('div', { className: 'cmes-sec' }, t('seat.menuModel')),
            page1RowsNode
          ),
          h('div', {
            className: 'cmes-page slot2',
            inert: view === 2 ? undefined : ''
          },
            h('div', { className: 'cmes-head' },
              h('button', {
                type: 'button', className: 'cmes-back', 'aria-label': t('seat.back'), title: t('seat.back'),
                onClick: sizeSubPage ? () => setSubProvider('__size') : goBack
              }, backChevron),
              h('span', { className: 'cmes-title' },
                sizeSubPage ? sizeSubLabel(sizeSubPage)
                  : isSettingsPage ? t('seat.moreSettings')
                  : (activeProviderForPage ? activeProviderForPage.name : t('seat.menuModel')))
            ),
            page2Body
          )
        )
      );

      const qualityPane = h('div', {
        className: 'cmes-pane cmes-main' + (pane === 'quality' ? '' : ' hidden'),
        inert: pane !== 'quality' ? '' : undefined
      },
        h('button', {
          className: 'cmes-tool cmes-fast' + (promptOptimization ? ' active' : ''),
          ref: fastBtnRef,
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 0 },
          'aria-label': t('seat.menuPromptOptimization'),
          'aria-describedby': 'mo-image-prompt-tip',
          'aria-pressed': promptOptimization,
          onPointerEnter: () => setTipOn(true),
          onPointerLeave: () => setTipOn(false),
          onFocus: () => setTipOn(true),
          onBlur: () => setTipOn(false),
          onClick: () => saveDefaults({ promptOptimization: !promptOptimization })
        }, starIcon('', promptOptimization)),
        h('button', {
          className: 'cmes-modelLink', type: 'button',
          onClick: () => setPane('models'),
          'aria-label': t('seat.choose'), title: activeModelName
        },
          h('span', { className: 'cmes-heading' }, displayLabel || t('seat.menuQuality'), chevron('cmes-iconSmall')),
          h('span', { className: 'cmes-modelName' }, activeModelName || t('seat.fallback'))
        ),
        h('div', { className: 'cmes-warning' }, h('span', null, t('seat.qualityWarning'))),
        h('button', {
          className: 'cmes-tool cmes-reset', type: 'button',
          'aria-label': t('seat.moreSettings'), title: t('seat.moreSettings'),
          onClick: openSettings
        }, sizeIcon),
        levels.length ? h('div', {
          className: 'cmes-rail' + (dragging ? ' dragging' : ''),
          ref: railRef,
          style: railColors,
          role: 'slider', tabIndex: 0,
          'aria-label': t('seat.menuQuality'),
          'aria-valuemin': 0, 'aria-valuemax': levels.length - 1,
          'aria-valuenow': displayIndex, 'aria-valuetext': displayLabel,
          onPointerDown: pointerDown,
          onPointerMove: (event) => {
            if (dragRef.current || levels.length < 2) return;
            const rail = railRef.current;
            if (!rail || typeof rail.getBoundingClientRect !== 'function') return;
            const box = rail.getBoundingClientRect();
            if (!box || box.width <= 30) return;
            const ratio = fractionAt(event.clientX);
            const nearest = Math.round(ratio * (levels.length - 1));
            const tick = nearest / (levels.length - 1);
            setHoveredDot(Math.abs(ratio - tick) * (box.width - 30) < 10 ? nearest : -1);
          },
          onPointerLeave: () => setHoveredDot(-1),
          onKeyDown: railKeyDown
        },
          h('div', { className: 'cmes-fill' }),
          levels.map((level, index) => h('i', {
            key: level.value,
            className: 'cmes-dot' + (index <= displayIndex ? ' passed' : '') + (hoveredDot === index ? ' hovered' : ''),
            style: { '--cmes-tick': levels.length > 1 ? index / (levels.length - 1) : 0 }
          })),
          h('div', { className: 'cmes-sparks cmes-sparks-float' },
            sparkles.map((sparkle) => h('i', {
              key: sparkle.key, className: 'cmes-sp cmes-sp-float',
              style: { left: sparkle.x, '--x': sparkle.x, top: sparkle.top, '--b': sparkle.b, '--dur': sparkle.dur, '--delay': sparkle.delay }
            }))),
          h('div', { className: 'cmes-sparks cmes-sparks-run' },
            sparkles.map((sparkle) => h('i', {
              key: sparkle.key, className: 'cmes-sp cmes-sp-run',
              style: { top: sparkle.top, '--b': sparkle.b, '--dur': sparkle.dur, '--delay': sparkle.delay }
            }))),
          bloom
            ? h('div', { key: 'bloom-' + bloom, className: 'cmes-bloom', 'aria-hidden': true },
              h('i', { className: 'cmes-halo' }),
              bloomMotes.map((mote) => h('i', {
                key: mote.key, className: 'cmes-bp',
                style: {
                  '--x0': mote.x0, '--y0': mote.y0, '--x1': mote.x1, '--y1': mote.y1,
                  '--sz': mote.sz, '--bmax': mote.bmax, '--bd': mote.bd, '--bdel': mote.bdel
                }
              })))
            : null,
          h('div', { className: 'cmes-knob' })
        ) : h('div', { className: 'cmes-noeffort' }, t('seat.qualityUnsupported'))
      );

      const popoverClasses = [
        'cmes-popover',
        open ? '' : ' closed',
        peak ? ' peak' : '',
        promptOptimization ? ' fast-mode' : '',
        message ? ' message' : ''
      ].filter(Boolean).join(' ');
      const popoverStyle = {
        '--cmes-height': popoverHeight + 'px',
        '--cmes-left': (menuPos ? menuPos.left : 0) + 'px',
        '--cmes-bottom': (menuPos ? menuPos.bottom : 40) + 'px',
        // Heading and trigger share the same ink; at the top stop that is the
        // codex violet even when the backend calls the stop high/max/xhigh.
        '--cmes-ink': codexInkFor(visualDisplay, dark),
        // codex 样式没到位（ CSP/加载时序挡住）时也要保证它脱离文档流。
        // 否则整块弹层会把输入区顶上去、页面底部多出一大片空白。
    position: 'fixed',
        zIndex: 1100,
        left: (menuPos ? menuPos.left : 0) + 'px',
        bottom: (menuPos ? menuPos.bottom : 40) + 'px',
        width: CODEX_POPOVER_WIDTH + 'px',
        maxWidth: 'calc(100vw - 24px)',
        height: popoverHeight + 'px',
        overflow: 'hidden',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #fff))',
        borderRadius: 14,
        boxShadow: 'var(--dsw-elevation-panel, 0 18px 48px rgba(0,0,0,.18))',
        pointerEvents: open ? 'auto' : 'none',
        // 生图席在输入区最右侧，弹层贴右缘展开；Codex 默认 transform-origin
        //  bottom left，这里改 bottom right，缩放才从贴边的一侧起。
    transformOrigin: 'bottom right',
        visibility: menuPos || !open ? undefined : 'hidden'
      };
      const portalNode = (node) => {
        if (!node) return null;
        if (typeof document === 'undefined' || !document.body) return node;
        // 固定定位的零尺寸容器：保 codex 的深色变量，又不占任何文档流。
  return createPortal(h('div', {
          className: 'cmes-root',
          style: {
            position: 'fixed', left: 0, top: 0, width: 0, height: 0,
            overflow: 'visible', pointerEvents: 'none',
            // position:fixed 会建立自己的 stacking context；z-index 必须放在
            // 这一层，否则弹层内部再高 z-index 也压不过输入区。
    zIndex: 2147482000
          }
        }, node), document.body);
      };

      return h('div', { className: 'cmes-root', 'data-mo-image-seat': '' },
        h('button', {
          type: 'button', ref: triggerRef,
          className: 'cmes-trigger' + (promptOptimization ? ' fast' : ''),
          style: triggerStyle,
          'aria-label': qualityLabel ? t('seat.triggerAriaQuality', { model: triggerLabel, quality: qualityLabel }) : t('seat.triggerAria', { model: triggerLabel }),
          'aria-haspopup': 'dialog', 'aria-expanded': open,
          'aria-controls': open ? 'mo-image-codex-popover' : undefined,
          onClick: () => {
            if (open) { closeMenu(); return; }
            // 先清掉旧位置，让 useLayoutEffect 在绘制前重新定位；关闭时。
            // 保留位置，避免退场动画跑到左下角。
    setMenuPos(null);
            setPane('quality');
            setOpen(true);
          }
        },
          promptOptimization ? starIcon('cmes-bolt', true) : null,
          h('span', { className: 'cmes-compact' }, imageIcon),
          h('span', { className: 'cmes-caption' }, triggerLabel),
          qualityLabel ? h('span', { className: 'cmes-triggerEffort' }, qualityLabel) : null,
          downChevron
        ),
        // 弹层必须挂到 body：输入区里任何 transform/filter/backdrop-filter 都会
        // 把 position:fixed 变成相对包含块，位置和裁剪都会错。
        portalNode(h(React.Fragment, null,
          h('section', {
            ref: popoverRef, id: 'mo-image-codex-popover', className: popoverClasses, role: 'dialog',
            'data-mo-image-codex-popover': '',
            'aria-label': pane === 'models' ? t('seat.menuModel') : t('seat.menuQuality'),
            'aria-hidden': !open,
            inert: !open ? '' : undefined,
            style: popoverStyle
          },
            modelsPane,
            qualityPane
          ),
          // Same two-line codex tooltip card as the Fast button, but this one
          // describes the real prompt-optimization switch. It stays outside the
          // popover: backdrop-filter would otherwise become its containing block.
          h('span', {
            role: 'tooltip', id: 'mo-image-prompt-tip',
            className: 'cmes-tip' + (tipShown ? ' show' : ''),
            ref: tipRef, 'aria-hidden': tipShown ? undefined : 'true'
          },
            h('span', { className: 'cmes-tipTitle' }, t('seat.menuPromptOptimization')),
            h('span', null, t('seat.promptOptimizationUsage')))
        ))
      );
    }

    function ImageModelSeat(props) {
      // 子代理没有自己的对话模型选择器；生图选择器也沿用主对话配置。
      // 这里 session.origin 判断，子代理里不渲染右下角的生图模型 seat。
  if (!props || typeof props.useSessions !== 'function') return h(ImageModelSeatInner, props);
      return h(ImageModelSeatScoped, props);
    }

    function ImageModelSeatScoped(props) {
      const isSubagent = props.useSessions((state) => {
        const session = state && state.byId ? state.byId[props.sessionId] : undefined;
        return !!(session && session.origin === 'subagent');
      });
      return isSubagent ? null : h(ImageModelSeatInner, props);
    }

    function ImageModelSeatInner(props) {
      useThemeClassRevision();
      const t = (props && props.t) || fallbackTranslate;
      const imageStore = useImageStore({ t: t });
      if (seatSkinNow() === SEAT_SKIN.CODEX) {
        return h(CodexImageSeat, {
          t: t, store: imageStore.store, setStore: imageStore.setStore,
          sessionId: props && props.sessionId
        });
      }
      return h(OfficialImageSeat, {
        t: t, store: imageStore.store, setStore: imageStore.setStore
      });
    }

    function OfficialImageSeat(props) {
      const t = props.t || fallbackTranslate;
      const store = props.store;
      const setStore = props.setStore;
      const [open, setOpen] = React.useState(false);
      const [panel, setPanel] = React.useState('home');
      const [query, setQuery] = React.useState('');
      const [activeIndex, setActiveIndex] = React.useState(-1);
      const [menuPos, setMenuPos] = React.useState(null);
      const [widthDraft, setWidthDraft] = React.useState('');
      const [heightDraft, setHeightDraft] = React.useState('');
      const searchRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const groupsRef = React.useRef(null);
      const closeMenu = React.useCallback(() => {
        setOpen(false);
        setPanel('home');
        setQuery('');
      }, []);
      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const root = menuRef.current;
        if (!root) return;
        const items = Array.from(root.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter((item) => !item.disabled);
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        let next = 0;
        if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
        else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
        try { items[next].focus(); } catch (_error) { /* ignore */ }
        const index = items[next].getAttribute('data-option-index');
        if (index !== null && index !== '') setActiveIndex(Number(index));
      };
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (triggerRef.current && triggerRef.current.contains(event.target)) return;
          if (menuRef.current && menuRef.current.contains(event.target)) return;
          closeMenu();
        };
        const onKey = (event) => { if (event.key === 'Escape') closeMenu(); };
        document.addEventListener('mousedown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          window.removeEventListener('keydown', onKey);
        };
      }, [open, closeMenu]);
      React.useEffect(() => {
        if (!open) return undefined;
        const el = menuRef.current;
        if (!el) return undefined;
        el.addEventListener('keydown', onMenuKeyDown);
        return () => el.removeEventListener('keydown', onMenuKeyDown);
      }, [open, panel]);
      React.useEffect(() => {
        if (!open || panel !== 'model') return undefined;
        const timer = setTimeout(() => { try { searchRef.current && searchRef.current.focus(); } catch (_error) { /* ignore */ } }, 30);
        return () => clearTimeout(timer);
      }, [open, panel]);
      React.useEffect(() => {
        if (!open || panel === 'model') return undefined;
        const timer = setTimeout(() => {
          try {
            const root = menuRef.current;
            if (!root) return;
            const first = root.querySelector('[role="menuitem"], [role="menuitemradio"], input');
            if (first) first.focus();
          } catch (_error) { /* ignore */ }
        }, 30);
        return () => clearTimeout(timer);
      }, [open, panel]);
      React.useLayoutEffect(() => {
        if (!open) { setMenuPos(null); return undefined; }
        const el = menuRef.current;
        const trigger = triggerRef.current;
        if (!el || !trigger) return undefined;
        const place = () => {
          const rect = trigger.getBoundingClientRect();
          const lw = el.offsetWidth || 0;
          const lh = el.offsetHeight || 0;
          const MARGIN = 12;
          let x = rect.right - lw;
          const above = rect.top - 8 - lh;
          const below = rect.bottom + 8;
          let y = above >= MARGIN ? above : (below + lh <= window.innerHeight - MARGIN ? below : above);
          if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
          if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
          setMenuPos({ left: x, top: y });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
        if (observer) observer.observe(el);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
        };
      }, [open, panel]);
      React.useEffect(() => {
        if (!open || panel !== 'model' || !groupsRef.current || !observeStickyMenuGroups) return undefined;
        return observeStickyMenuGroups(groupsRef.current);
      }, [open, panel, query]);
      React.useEffect(() => {
        if (!open || panel !== 'model') { setActiveIndex(-1); return; }
        const q = query.trim().toLowerCase();
        const flat = [];
        const hasModels = store.providers.some((provider) => Array.isArray(provider.models) && provider.models.length > 0);
        if (hasModels && (!q || 'auto'.includes(q))) flat.push({ providerId: store.active.providerId, model: 'auto' });
        for (const provider of store.providers) {
          for (const model of provider.models) {
            const display = modelDisplayName(provider, model);
            if (!q || model.toLowerCase().includes(q) || display.toLowerCase().includes(q)) {
              flat.push({ providerId: provider.id, model });
            }
          }
        }
        const selected = flat.findIndex((item) => item.providerId === store.active.providerId && item.model === store.active.model);
        setActiveIndex(selected >= 0 ? selected : (flat.length ? 0 : -1));
      }, [open, panel, query, store]);
      const seatView = deriveSeatView(store, t);
      const {
        defaults, active, activeProvider, hasAnyModel,
        activeModelName, triggerLabel, qualitySpec, qualityValue, qualityLabel
      } = seatView;
      const saveDefaults = (patch) => commitSeatDefaults(store, defaults, setStore, patch, t);
      const choose = (providerId, model) => {
        commitSeatModel(store, defaults, setStore, providerId, model, t);
        closeMenu();
      };
      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        return store.providers.map((provider) => ({
          ...provider,
          models: provider.models.filter((model) => !needle
            || model.toLowerCase().includes(needle)
            || modelDisplayName(provider, model).toLowerCase().includes(needle))
        })).filter((provider) => provider.models.length > 0);
      }, [store, query]);
      const needle = query.trim().toLowerCase();
      const emptyModelHint = hasAnyModel && needle ? t('seat.noMatches') : t('seat.empty');
      const autoVisible = hasAnyModel && (!needle || 'auto'.includes(needle));
      let optionIndex = autoVisible ? 0 : -1;
      const Menu = DshMenuSurface || 'div';
      const Group = DshMenuGroup || 'div';
      const Search = DshInput || 'input';
      const chevronRight = IconChevronRight
        ? h(IconChevronRight, { className: MS.cellChevron })
        : h('span', { className: MS.cellChevron }, '\u203a');
      const checkMark = (on) => (on ? h('span', { className: MS.check },
        IconCheck ? h(IconCheck, { size: 14 }) : h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M3.5 8.5L6.5 11.5L12.5 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))) : null);
      const cellRow = (key, label, value, onOpen) => h('button', {
        key: key, type: 'button', role: 'menuitem', className: MS.cell, onClick: onOpen
      },
        h('span', { className: MS.cellLabel }, label),
        h('span', { className: MS.cellValue }, value),
        chevronRight
      );
      const homePanel = [
        cellRow('model', t('seat.menuModel'), activeModelName || t('seat.notSelected'), () => setPanel('model'))
      ];
      if (qualitySpec) homePanel.push(cellRow('quality', t('seat.menuQuality'), qualityLabel, () => setPanel('quality')));
      homePanel.push(
        cellRow('size', t('seat.menuSize'), sizeValueLabel(sizeSpecFor(active.providerId, active.model), defaults, t), () => setPanel('size')),
        cellRow('promptOptimization', t('seat.menuPromptOptimization'), defaults.promptOptimization === false ? t('seat.off') : t('seat.on'), () => setPanel('promptOptimization'))
      );
      // 尺寸面板里的行是静态表单，不要 cell 的悬停高光；
      // option + modelOption 这一组合在样式表里被排除 hover 规则之外。
    const plainRow = MS.option + ' ' + MS.modelOption;
      // 行内文字用二级菜单那套 optionCopy > modelName，字号才不会和列表项对不上。
      const plainLabel = (label, style) => h('span', {
        className: MS.optionCopy,
        style: { flex: '0 0 auto', whiteSpace: 'nowrap' }
      },
        h('span', Object.assign({ className: MS.modelName }, style || {}), label));

      const sideInput = (key, label, value, display, min, max, onCommit, draft, setDraft, placeholder, locked) => h('div', { key: key, className: plainRow },
        plainLabel(label),
        h('input', {
          className: MC.input + ' ' + MC.modelReasoningValueInput, type: 'text', inputMode: 'numeric',
          style: { flex: '1 1 auto', minWidth: 0, width: 'auto' },
          value: draft || String(display), disabled: defaults.auto || locked === true,
          'aria-label': label, placeholder: placeholder,
          onBlur: () => setDraft(''),
          onChange: (event) => {
            const text = String(event.target.value).replace(/[^0-9]/g, '');
            setDraft(text);
            const number = Number(text);
            if (number >= min && number <= max) onCommit(number);
          }
        })
      );
      // 尺寸面板按所选模型的形态渲染：宽高 / 比例+档位 / 档位下拉 / 写进提示词。
      const seatSizeSpec = sizeSpecFor(active.providerId, active.model);
      const seatControl = sizeControlOf(seatSizeSpec);
      const seatAspects = seatSizeSpec && Array.isArray(seatSizeSpec.aspects) ? seatSizeSpec.aspects : [];
      const seatTiers = seatSizeSpec && Array.isArray(seatSizeSpec.tiers) ? seatSizeSpec.tiers : [];
      const seatPresets = seatTiers.map((tier) => String(tier.value));
      const seatCustom = !!(seatSizeSpec && seatSizeSpec.custom);
      // 和选模型一样：这几种取值都改成点开一页、选完回来，不再用原生 select。
      const optionPage = (key, label, items, current, onPick) => [
        h('div', { key: key, className: MS.groups + ' scrollable', role: 'menu', 'aria-label': label },
          h('button', {
            key: '__back', type: 'button', role: 'menuitem', className: MS.option,
            onClick: () => setPanel('size')
          },
            h('span', { className: MS.optionCopy }, h('span', { className: MS.modelName }, '\u2039 ' + t('seat.back')))),
          items.map((item) => h('button', {
            key: item.value, type: 'button', role: 'menuitemradio',
            'aria-checked': item.value === current,
            className: MS.option + (item.value === current ? ' ' + MS.selected : ''),
            onClick: () => { onPick(item.value); setPanel('size'); }
          },
            h('span', { className: MS.optionCopy }, h('span', { className: MS.modelName }, item.label)),
            checkMark(item.value === current))))
      ];
      const aspectCurrent = String(defaults.aspect || '') || String(seatAspects[0] || '');
      const tierCurrent = String(defaults.tier || '') || String(seatPresets[0] || '');
      const presetInList = seatPresets.includes(String(defaults.preset || ''));
      const presetCurrent = presetInList
        ? String(defaults.preset)
        : (seatCustom ? '__custom' : String(seatPresets[0] || ''));
      const customMode = seatControl === 'preset' && presetCurrent === '__custom';
      const sizeRows = [];
      if (seatControl === 'aspect' && seatAspects.length) {
        sizeRows.push(cellRow('aspect', t('seat.sizeAspect'), aspectCurrent, () => setPanel('size-aspect')));
        if (seatTiers.length) {
          sizeRows.push(cellRow('tier', t('seat.sizeTier'), tierCurrent, () => setPanel('size-tier')));
        }
      } else if (seatControl === 'preset') {
        sizeRows.push(cellRow('preset', t('seat.sizePreset'),
          presetCurrent === '__custom' ? t('seat.sizeCustom') : presetCurrent,
          () => setPanel('size-preset')));
        // 档位就是最终尺寸，宽高这两行只在「自定义」下才有意义。
        if (customMode) {
          sizeRows.push(sideInput('width', t('seat.width'), defaults.width, defaults.width, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ width: value, preset: value + 'x' + defaults.height }), widthDraft, setWidthDraft, t('seat.width')));
          sizeRows.push(sideInput('height', t('seat.height'), defaults.height, defaults.height, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ height: value, preset: defaults.width + 'x' + value }), heightDraft, setHeightDraft, t('seat.height')));
        }
      } else {
        // wh / prompt：两个宽高输入框；prompt 另加一句说明。
        sizeRows.push(sideInput('width', t('seat.width'), defaults.width, defaults.width, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
          (value) => saveDefaults({ width: value }), widthDraft, setWidthDraft, t('seat.width')));
        sizeRows.push(sideInput('height', t('seat.height'), defaults.height, defaults.height, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
          (value) => saveDefaults({ height: value }), heightDraft, setHeightDraft, t('seat.height')));
        if (seatControl === 'prompt') {
          sizeRows.push(h('div', { key: 'promptHint', className: plainRow },
            plainLabel(t('seat.sizePromptHint'), { opacity: 0.7 })));
        }
      }
      const sizeHintKey = seatSizeSpec && seatSizeSpec.hint ? 'seat.sizeHint.' + String(seatSizeSpec.hint) : '';
      if (sizeHintKey) {
        sizeRows.push(h('div', { key: 'sizeHint', className: plainRow },
          plainLabel(t(sizeHintKey), { opacity: 0.7 })));
      }
      const sizePanel = [
        h('div', { key: 'size', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': t('seat.menuSize') },
          h('div', { key: 'auto', className: plainRow },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
              plainLabel(t('seat.sizeAutoValue')),
              h(MoHelp, { text: t('seat.sizeAutoHelp') })),
            h('label', { className: MS.cellValue, title: t('seat.sizeAutoHint') },
              h('input', {
                type: 'checkbox', checked: !!defaults.auto,
                'aria-label': t('seat.sizeAutoAria'),
                onChange: (event) => saveDefaults({ auto: event.target.checked })
              })
            )
          ),
          // 严格模式紧跟自动尺寸：它管的是请求里的尺寸算不算数，与自动/固定无关。
          h('div', { key: 'strict', className: plainRow },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
              plainLabel(t('seat.sizeStrict')),
              h(MoHelp, { text: t('seat.sizeStrictHelp') })),
            h('label', { className: MS.cellValue, title: t('seat.sizeStrictHint') },
              h('input', {
                type: 'checkbox', checked: !!defaults.strict, 'aria-label': t('seat.sizeStrict'),
                onChange: (event) => saveDefaults({ strict: event.target.checked })
              })
            )
          ),
          ...sizeRows
        )
      ];
      // Auto 行固定在第一行（搜索框下面）：只有它被选中时，对话模型才能挑模型。
    const autoSelected = hasAnyModel && store.active.model === 'auto';
      const autoRow = autoVisible ? h('button', {
        key: '__auto', type: 'button', role: 'menuitemradio', 'aria-checked': autoSelected,
        className: MS.option + ' ' + MS.modelOption + (autoSelected ? ' ' + MS.selected : '') + (activeIndex === 0 ? ' ' + MS.optionActive : ''),
        'data-highlighted': activeIndex === 0 ? '' : undefined,
        'data-option-index': 0,
        onMouseMove: () => setActiveIndex(0),
        onMouseEnter: () => setActiveIndex(0),
        onFocus: () => setActiveIndex(0),
        onClick: () => choose(activeProvider ? activeProvider.id : '', 'auto'),
        title: t('seat.auto')
      },
        h('span', { className: MS.optionCopy },
          h('span', { className: MS.modelName }, t('seat.auto'))
        ),
        checkMark(autoSelected)
      ) : null;
      const modelPanel = [
        h('div', { key: 'search', className: MS.searchRow },
          h(Search, {
            ref: searchRef,
            className: MS.search + (query ? ' ' + MS.searchWithQuery : ''),
            type: 'text', role: 'searchbox', 'aria-label': t('seat.searchAria'),
            placeholder: t('seat.searchPlaceholder'), value: query,
            onChange: (event) => setQuery(event.target.value)
          }),
          query ? h('button', {
            type: 'button', className: MS.searchClear, 'aria-label': t('seat.clearSearch'),
            onClick: () => { setQuery(''); try { searchRef.current && searchRef.current.focus(); } catch (_error) { /* ignore */ } }
          }, IconCloseFill ? h(IconCloseFill, {}) : h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
            h('path', { d: 'M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))) : null
        ),
        h('div', { key: 'groups', ref: groupsRef, className: MS.groups + ' scrollable', role: 'menu', 'aria-label': t('seat.menuAria') },
          autoRow,
          visible.length ? visible.map((provider) => h(Group, { key: provider.id, label: provider.name || t('section.unnamedProvider') },
            provider.models.map((model) => {
              const index = ++optionIndex;
              const selected = store.active.providerId === provider.id && store.active.model === model;
              const highlighted = index === activeIndex;
              const display = modelDisplayName(provider, model);
              return h('button', {
                key: model, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
                className: MS.option + ' ' + MS.modelOption + (selected ? ' ' + MS.selected : '') + (highlighted ? ' ' + MS.optionActive : ''),
                'data-highlighted': highlighted ? '' : undefined,
                'data-option-index': index,
                onMouseMove: () => setActiveIndex(index),
                onMouseEnter: () => setActiveIndex(index),
                onFocus: () => setActiveIndex(index),
                onClick: () => choose(provider.id, model),
                title: display
              },
                h('span', { className: MS.optionCopy },
                  h('span', { className: MS.modelName }, display)
                ),
                checkMark(selected)
              );
            })
          )) : (autoVisible ? null : h('div', { className: MS.empty }, emptyModelHint))
        )
      ];
      const qualityPanel = [
        h('div', { key: 'quality', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': t('seat.menuQuality') },
          qualityRailLevels(qualitySpec).map((level) => h('button', {
            key: level.value, type: 'button', role: 'menuitemradio',
            'aria-checked': qualityValue === level.value,
            className: MS.option + (qualityValue === level.value ? ' ' + MS.selected : ''),
            onClick: () => { saveDefaults({ quality: level.value }); closeMenu(); }
          },
            h('span', { className: MS.optionCopy },
              h('span', { className: MS.modelName }, qualityLabelFor(level.value, qualitySpec, t))
            ),
            checkMark(qualityValue === level.value)
          ))
        )
      ];
      const promptOptimizationPanel = [
        h('div', { key: 'promptOptimization', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': t('seat.menuPromptOptimization') },
          [{ value: true, label: t('seat.on') }, { value: false, label: t('seat.off') }].map((item) => {
            const selected = (defaults.promptOptimization !== false) === item.value;
            return h('button', {
              key: item.label, type: 'button', role: 'menuitemradio',
              'aria-checked': selected,
              className: MS.option + (selected ? ' ' + MS.selected : ''),
              onClick: () => { saveDefaults({ promptOptimization: item.value }); closeMenu(); }
            },
              h('span', { className: MS.optionCopy },
                h('span', { className: MS.modelName }, item.label)
              ),
              checkMark(selected)
            );
          })
        )
      ];
      const sizeAspectPanel = optionPage('size-aspect', t('seat.sizeAspect'),
        seatAspects.map((value) => ({ value: value, label: value })), aspectCurrent, (value) => saveDefaults({ aspect: value }));
      const sizeTierPanel = optionPage('size-tier', t('seat.sizeTier'),
        seatPresets.map((value) => ({ value: value, label: value })), tierCurrent, (value) => saveDefaults({ tier: value }));
      const sizePresetPanel = optionPage('size-preset', t('seat.sizePreset'),
        seatPresets.map((value) => ({ value: value, label: value }))
          .concat(seatCustom ? [{ value: '__custom', label: t('seat.sizeCustom') }] : []),
        presetCurrent, (value) => saveDefaults({ preset: value }));
      const panelBody = panel === 'model' ? modelPanel
        : panel === 'quality' ? qualityPanel
        : panel === 'size' ? sizePanel
        : panel === 'size-aspect' ? sizeAspectPanel
        : panel === 'size-tier' ? sizeTierPanel
        : panel === 'size-preset' ? sizePresetPanel
        : panel === 'promptOptimization' ? promptOptimizationPanel
        : homePanel;
      const genericTriggerStyle = seatSkinNow() === SEAT_SKIN.GENERIC ? genericChatTriggerStyle() : null;
      return h('div', { className: MS.root, 'data-mo-image-seat': '' },
        h('button', {
          type: 'button', ref: triggerRef, className: MS.trigger,
          style: genericTriggerStyle || undefined,
          onClick: () => {
            if (open) { closeMenu(); return; }
            setPanel('home');
            setQuery('');
            setOpen(true);
          },
          onKeyDown: (event) => {
            if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
            event.preventDefault();
            setPanel('home');
            setQuery('');
            setOpen(true);
          },
          title: active.model ? activeModelName + (qualitySpec ? ' · ' + qualityLabel : '') : t('seat.choose'),
          'aria-label': active.model
            ? (qualitySpec ? t('seat.triggerAriaQuality', { model: activeModelName, quality: qualityLabel }) : t('seat.triggerAria', { model: activeModelName }))
            : t('seat.choose'),
          'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-controls': open ? 'mo-image-model-menu' : undefined
        },
          h('svg', { className: MS.triggerIcon, viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 2.2, y: 2.75, width: 11.6, height: 10.5, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.25 }),
            h('circle', { cx: 5.7, cy: 6.2, r: 1, stroke: 'currentColor', strokeWidth: 1.25 }),
            h('path', { d: 'M2.8 11.6l3.2-3.1 2.1 2.1 2.5-2.8 2.6 3.2', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' })),
          h('span', { className: MS.triggerLabel }, triggerLabel),
          qualitySpec ? h('span', { className: MS.triggerEffort }, qualityLabel) : null,
          IconChevronDown
            ? h(IconChevronDown, { className: MS.chevron + (open ? ' ' + MS.chevronOpen : ''), size: 14 })
            : h('svg', { className: MS.chevron + (open ? ' ' + MS.chevronOpen : ''), viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M4 6.25L8 10.25L12 6.25', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
        ),
        open ? createPortal(h(Menu, {
          ref: menuRef,
          id: 'mo-image-model-menu',
          className: MS.menu,
          style: menuPos ? { left: menuPos.left, top: menuPos.top } : { left: 0, top: 0, visibility: 'hidden' },
          role: 'group',
          'aria-label': t('seat.settingsAria')
        }, panelBody), document.body) : null
      );
    }

    function ImageSectionIcon(props) {
      const size = Number(props && props.size) || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.6 }),
        h('circle', { cx: 5.6, cy: 6.8, r: 1.1 }),
        h('path', { d: 'M2.8 11.4l3.4-3 2 2 2.4-2.6 2 3.4' })
      );
    }

    // BEGIN GENERATED LOCALES — source: locale/messages.csv; regenerate with `npm run build:locales`.
    const MESSAGES = {
      "zh": {
        "nav": "生图模型",
        "section.title": "生图模型",
        "section.intro": "填入云平台密钥，或连接本机、局域网里的生图服务。",
        "section.unnamedProvider": "未命名提供商",
        "tag.local": "本地",
        "tag.custom": "自定义",
        "status.ready": "可用",
        "status.missingLocal": "缺少 API 地址或模型",
        "status.missingCloud": "缺少 API 地址、密钥或模型",
        "status.missingConfig": "缺少配置",
        "action.edit": "编辑",
        "action.delete": "删除",
        "action.addProvider": "添加模型提供商",
        "form.displayName": "显示名称",
        "form.baseUrl": "API 地址",
        "form.protocol": "API 协议",
        "form.protocolAuto": "自动识别",
        "form.protocolRoutes": "协议地址说明",
        "form.route.generate": "文生图",
        "form.route.edit": "图生图",
        "form.route.models": "获取模型列表",
        "form.routeUnsupported": "不支持",
        "form.customProtocol": "自定义（自己填地址）",
        "form.hostModel": "调度模型",
        "form.hostModelHint": "Responses API 需要一个能调用生图工具的主模型。",
        "form.apiKey": "API 密钥",
        "form.keyLocalOptional": "本地无鉴权可留空",
        "form.keyEnter": "输入 API 密钥",
        "form.keyEnvSaved": "使用环境变量中的已保存密钥",
        "form.keySaved": "留空使用已保存凭证",
        "form.modelDirectory": "模型目录",
        "form.modelDirectoryCustom": "已自定义模型目录",
        "form.modelDirectoryDefault": "正在使用适配器默认模型",
        "form.fetchNeedsBaseUrl": "先填写 API 地址",
        "form.fetching": "获取中…",
        "form.fetchModels": "获取可用模型",
        "form.modelId": "模型 ID",
        "form.reorderModel": "调整模型顺序",
        "form.reorderModelHelp": "拖动排序，或使用上下方向键调整顺序。",
        "form.deleteModel": "删除模型",
        "form.modelOptions": "模型选项",
        "form.modelOptionsHint": "给这个模型单独指定 ComfyUI 工作流。留空则按模型类型自动选择内置工作流。",
        "form.modelOptionsUnsupported": "自定义工作流仅在 ComfyUI 部署器下可用",
        "form.modelWorkflow": "自定义工作流（ComfyUI API 格式）",
        "form.modelWorkflowPlaceholder": "在 ComfyUI 里用「导出（API）」保存，把 JSON 粘到这里",
        "form.modelWorkflowHelp": "可用占位符：{{prompt}}、{{negative_prompt}}、{{width}}、{{height}}、{{seed}}、{{model}}、{{image}}（图生图时自动换成上传的参考图）",
        "form.modelOptionsDone": "收起",
        "form.modelWorkflowSample": "插入示例模板",
        "form.modelEmpty": "模型选择器中将不显示任何模型；请先在模型目录里添加模型 ID。",
        "form.addModel": "添加模型",
        "form.advanced": "自定义设置",
        "form.addMode": "添加方式",
        "form.modeCatalog": "第三方模型提供商",
        "form.modeCustom": "自定义模型 API",
        "form.modeLocal": "本地模型",
        "form.modeCatalogHint": "从内置目录中选择 OpenAI、火山方舟、阿里云百炼等官方或大型平台，填入 API 密钥即可使用。",
        "form.modeCustomHint": "接入自部署服务或其他兼容 OpenAI Images 的接口。",
        "form.modeLocalHint": "连接本机或局域网里的生图服务；无鉴权的本地服务可以留空 API 密钥。",
        "form.provider": "提供商",
        "form.providerWebsite": "前往提供商官网",
        "form.localDeployer": "本地部署器",
        "form.localPresetsMissing": "宿主没有下发本地部署器列表，请刷新页面后重试。",
        "form.save": "保存",
        "form.cancel": "取消",
        "picker.title": "选择模型",
        "picker.close": "关闭",
        "picker.description": "以下是模型提供商的可用模型，勾选的模型即为模型列表。",
        "picker.search": "搜索模型",
        "picker.selectAll": "全选",
        "picker.deselectAll": "取消全选",
        "picker.showAll": "显示全部模型",
        "picker.filtered": "已过滤 {count} 个可能非生图的模型",
        "picker.noMatches": "没有匹配的模型",
        "picker.adopt": "更新列表",
        "picker.keepOne": "至少保留一个模型。",
        "seat.noMatches": "没有匹配的模型",
        "seat.empty": "还没有模型，去“设置 → 生图模型”添加",
        "seat.auto": "自动",
        "seat.fallback": "生图模型",
        "seat.menuModel": "模型",
        "seat.menuQuality": "质量",
        "seat.menuSize": "尺寸",
        "seat.menuPromptOptimization": "提示词优化",
        "seat.promptOptimizationUsage": "用量更多",
        "seat.notSelected": "未选择",
        "seat.on": "开",
        "seat.off": "关",
        "seat.sizeAutoValue": "自动",
        "seat.sizeAutoHint": "自动尺寸，交给模型决定",
        "seat.sizeAutoAria": "自动尺寸",
        "seat.width": "宽",
        "seat.height": "高",
        "seat.searchAria": "搜索生图模型",
        "seat.searchPlaceholder": "搜索模型",
        "seat.clearSearch": "清除搜索",
        "seat.menuAria": "生图模型",
        "seat.choose": "选择生图模型",
        "seat.triggerAria": "生图模型：{model}",
        "seat.triggerAriaQuality": "生图模型：{model}，质量 {quality}",
        "seat.settingsAria": "生图设置",
        "seat.moreSettings": "其他设置",
        "seat.qualityUnsupported": "此模型未提供质量档位",
        "seat.qualityWarning": "更快消耗使用额度",
        "seat.levelsCount": "{count} 档",
        "seat.levelsNone": "不支持",
        "seat.sizeTitle": "尺寸",
        "seat.back": "返回",
        "seat.modelAutoHint": "让模型自己挑一个",
        "errors.loadConfig": "读取生图配置失败：HTTP {status}",
        "errors.loadConfigDetail": "读取生图配置失败：{message}",
        "errors.saveConfig": "保存生图配置失败：HTTP {status}",
        "errors.saveConfigDetail": "保存生图配置失败：{message}",
        "errors.saveFailed": "生图配置保存失败",
        "errors.fetchModels": "获取模型列表失败：HTTP {status}",
        "errors.fetchModelsDetail": "获取模型列表失败：{message}",
        "errors.noModels": "服务没有返回模型，请手动填写模型 ID。",
        "errors.localUnreachable": "无法连接插件的本地服务，请确认 DSH 宿主仍在运行。",
        "errors.localTimeout": "本地服务响应超时，请稍后重试。",
        "serverError.network.format": "网络请求失败：{host} {cause}，{via}。{hint}",
        "serverError.network.viaDirect": "直连",
        "serverError.network.viaIndirect": "经系统网络配置",
        "serverError.network.hint.timeout": "TCP 连接超时。",
        "serverError.network.hint.dns": "DNS 解析失败：域名可能拼写错误，或当前 DNS 不可用。",
        "serverError.network.hint.connection": "连接被拒绝或重置：目标端口可能未监听，或服务已断开。",
        "serverError.network.hint.tls": "TLS 证书校验失败：证书可能过期或自签名。",
        "serverError.network.timeout": "请求 {host} 超时。",
        "serverError.network.routeInvalid": "网络连接配置无效，请检查宿主或系统的网络设置。",
        "serverError.upstream.http": "生图服务返回 HTTP {status}：{detail}",
        "serverError.upstream.httpNoDetail": "生图服务返回 HTTP {status}",
        "serverError.upstream.invalidJson": "生图服务返回的不是 JSON",
        "serverError.upstream.invalidResponse": "{service} 的响应缺少 {field}",
        "serverError.upstream.tooLarge": "生图服务的响应体超过大小限制",
        "serverError.provider.notFound": "找不到指定的生图提供商",
        "serverError.provider.missingBaseUrl": "请先填写 API 地址",
        "serverError.provider.missingKey": "生图提供商「{provider}」缺少 API Key",
        "serverError.provider.missingKeyWithRef": "生图提供商「{provider}」缺少 API Key（凭据 {ref}）",
        "serverError.models.unsupported": "该部署方式不支持获取模型列表",
        "serverError.models.notFound": "该地址没有模型列表接口（HTTP 404），请手动填写模型 ID",
        "serverError.adapter.unknownProtocol": "暂不支持该生图协议：{protocol}（可用：{available}）",
        "serverError.adapter.notFound": "找不到生图适配器：{adapter}（可用：{available}）",
        "serverError.config.credentialsUnavailable": "凭据服务未挂载，无法安全保存 API Key",
        "serverError.config.credentialSaveFailed": "保存 API Key 失败：{message}",
        "serverError.config.legacyKeyMigrationFailed": "旧 API Key 迁移失败：{message}",
        "serverError.config.writeFailed": "保存生图配置失败：{message}",
        "serverError.request.methodNotAllowed": "请求方法不被允许",
        "serverError.request.bodyTooLarge": "请求体过大",
        "serverError.request.invalidJson": "请求体不是有效的 JSON",
        "quality.off": "关闭",
        "quality.low": "低",
        "quality.medium": "中",
        "quality.high": "高",
        "quality.xhigh": "极高",
        "quality.max": "最高",
        "quality.auto": "自动",
        "quality.standard": "标准",
        "quality.hd": "高清",
        "quality.default": "默认",
        "quality.quality": "高质量",
        "quality.turbo": "极速",
        "localPreset.sd-server.urlHint": "只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。",
        "localPreset.sd-server.hint": "原生 OpenAI Images 接口，生成和 /images/edits 编辑都支持；模型名通常是 sd-cpp-local，可从 /v1/models 获取。",
        "localPreset.localai.urlHint": "只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。",
        "localPreset.localai.hint": "OpenAI Images 兼容，生成可用；模型名填 LocalAI 模型 YAML 里的 name，可从 /v1/models 获取。LocalAI 没有 /images/edits，图生图需要走「其他 OpenAI 兼容网关」。",
        "localPreset.a1111.urlHint": "只填服务根地址，不要带 /sdapi/v1；插件会拼 /sdapi/v1/txt2img、/img2img、/sd-models。",
        "localPreset.a1111.hint": "走 /sdapi/v1/txt2img 和 /sdapi/v1/img2img，模型列表来自 /sdapi/v1/sd-models；A1111 需要启动时加 --api。",
        "localPreset.comfyui.urlHint": "只填服务根地址，不要带 /prompt；插件会拼 /prompt、/upload/image、/history、/view。",
        "localPreset.comfyui.hint": "内置 SD/SDXL、FLUX.2 和 MOSS-Image 工作流，生成和参考图编辑都支持；其它架构（Qwen-Image、Z-Image 等）可在模型行的「模型选项」里粘贴自己的 ComfyUI 工作流，或改用 OpenAI 兼容网关。",
        "localPreset.swarmui.urlHint": "只填服务根地址，不要带 /API；插件会拼 /API/GetNewSession、/API/ListModels、/API/GenerateText2Image。",
        "localPreset.swarmui.hint": "走 /API/GenerateText2Image，模型列表来自 /API/ListModels；生成可用，原生编辑暂不支持。",
        "localPreset.openai-gateway.urlHint": "只填 OpenAI API 根地址（通常带 /v1）；插件会拼 /images/generations 和 /models。",
        "localPreset.openai-gateway.hint": "InvokeAI、Fooocus、复杂 ComfyUI 工作流或自建服务，只要暴露 /v1/images/generations 就选这个。",
        "update.available": "有可用更新",
        "update.title": "有可用更新",
        "update.version": "{from} → {to}",
        "update.cancel": "取消",
        "update.apply": "更新",
        "update.close": "关闭",
        "update.starting": "正在更新 dsh-mo-image…",
        "update.doneRestart": "更新已完成，重启 DSH 后生效",
        "update.done": "已更新到 {version}",
        "update.failed": "更新未完成，请重试",
        "update.failedRestored": "更新安装失败，已装回原来的版本",
        "update.failedBroken": "更新安装失败，原版本也没能装回，请在插件管理里重新安装",
        "update.unsupported": "当前环境不支持自助更新，请运行 {command}",
        "update.localDev": "本地开发安装，请自行 git pull",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "在 npm 查看",
        "update.noNotes": "暂无更新说明",
        "form.modelMappingParse": "解析工作流",
        "form.modelMappingParsing": "解析中…",
        "form.modelMappingFailed": "解析失败",
        "form.modelMappingSkip": "不注入",
        "form.modelMappingFormatApi": "API 格式",
        "form.modelMappingFormatUi": "UI 格式",
        "form.modelMappingSampler": "采样器",
        "form.modelMappingWidth": "宽度",
        "form.modelMappingHeight": "高度",
        "form.modelMappingSeed": "种子",
        "form.modelMappingModel": "模型",
        "form.modelMappingImage": "参考图",
        "form.modelMappingColName": "参数名",
        "form.modelMappingColTarget": "参数映射",
        "form.modelMappingColExpose": "是否暴露",
        "form.modelAutoInjectHint": "提示词与负面词由工具参数直接写入，不需要在这里配置。",
        "param.steps": "步数",
        "param.cfg": "提示词强度",
        "param.sampler_name": "采样器",
        "param.scheduler": "调度器",
        "param.denoise": "重绘幅度",
        "param.batch_size": "批量张数",
        "param.guidance": "引导强度",
        "param.cfg.desc": "提示词对画面的约束强度；过高画面僵硬，过低容易跑题",
        "param.sampler_name.desc": "采样算法，决定收敛方式和画面质感",
        "param.scheduler.desc": "噪声调度曲线，和采样器配合决定去噪节奏",
        "param.denoise.desc": "图生图时保留原图的程度；1 表示完全重绘",
        "param.batch_size.desc": "一次生成的图片数量，越大越占显存",
        "param.guidance.desc": "蒸馏模型的引导系数，通常固定在 1 附近",
        "form.a1111ParamsHint": "勾选后对话模型可以通过 params 覆盖这些参数；不勾选就沿用 WebUI 里的设置",
        "form.a1111ColType": "类型",
        "seat.sizeAspect": "比例",
        "seat.sizeTier": "档位",
        "seat.sizePreset": "预设",
        "seat.sizeCustom": "自定义",
        "seat.sizeStrict": "严格",
        "seat.sizeStrictHint": "成品尺寸一定等于设置值；会话里没指定尺寸时不生效",
        "seat.sizePromptHint": "该模型不接收尺寸参数；尺寸会写进提示词",
        "seat.sizeHint.ratioOnly": "分辨率由模型按比例决定",
        "seat.sizeHint.fixedPixels": "分辨率由平台固定：core 1.5MP，sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "该模型不接收尺寸参数",
        "seat.sizeHint.modelDecides": "不传尺寸时由模型自选",
        "form.sizeParamsHint": "该模型的尺寸参数怎么发由适配器决定；这里可以覆盖，留空即跟随默认。",
        "form.sizeMode": "编码方式",
        "form.sizeModeDefault": "跟随默认",
        "form.sizeModeWhString": "size = 宽x高",
        "form.sizeModeWhFields": "width + height 两个字段",
        "form.sizeModeAspect": "宽高比（aspect_ratio）",
        "form.sizeModeTier": "档位名（1K / 2K）",
        "form.sizeModePrompt": "写进提示词",
        "form.sizeField": "参数名",
        "form.sizeFieldHint": "留空用默认；支持 a.b.c 这种嵌套路径。",
        "form.sizeSeparator": "分隔符",
        "form.sizeSeparatorCustom": "自定义",
        "form.sizeSecond": "第二个字段",
        "form.sizeSecondHint": "可选：把比例或档位另写一个字段，留空表示不发。",
        "form.sizeFieldWidth": "参数名：宽",
        "form.sizeFieldHeight": "参数名：高",
        "form.sizeFieldAspect": "参数名：比例",
        "form.sizeFieldResolution": "参数名：分辨率",
        "seat.sizeAutoHelp": "启用后模型根据用户要求自行调整尺寸",
        "seat.sizeStrictHelp": "启用后强制将图片缩放至设置大小（原图会保留）",
        "form.paramSize": "尺寸",
        "form.paramQuality": "质量",
        "form.paramPrompt": "提示词",
        "form.paramNegative": "负面词",
        "form.paramModel": "模型",
        "form.paramN": "张数",
        "form.paramImage": "参考图",
        "form.paramLock": "锁定该键",
        "form.lockOn": "已上锁：一键配置与自动检测都会跳过",
        "form.lockOff": "未上锁：会被一键配置覆盖",
        "form.unlockAll": "全部解锁",
        "form.advancedParams": "高级（手填字段名）",
        "form.paramsCommon": "常规",
        "form.paramsHint": "上锁的键不会被一键配置与自动检测改动；解锁后可以手填。",
        "form.imageAs": "传法",
        "form.imageField": "字段名",
        "form.autoDetect": "自动检测",
        "form.detecting": "检测中…",
        "form.detectNeedsModels": "先添加模型",
        "form.bulkConfigure": "一键配置",
        "form.bulkConfiguring": "配置中…",
        "form.bulkConfigDone": "已配置 {count} 个模型，{unmatched} 个未命中规则",
        "form.bulkConfigNone": "没有一个模型命中规则，按 OpenAI 兼容发送",
        "form.bulkConfigSkipped": "这些键都上锁了，一键配置没有写入任何值",
        "errors.detectRule": "规则检测失败",
      },
      "en": {
        "nav": "Image models",
        "section.title": "Image models",
        "section.intro": "Add a cloud API key, or connect to an image service on this machine or your local network.",
        "section.unnamedProvider": "Unnamed provider",
        "tag.local": "Local",
        "tag.custom": "Custom",
        "status.ready": "Ready",
        "status.missingLocal": "Missing API URL or model",
        "status.missingCloud": "Missing API URL, key, or model",
        "status.missingConfig": "Not configured",
        "action.edit": "Edit",
        "action.delete": "Delete",
        "action.addProvider": "Add provider",
        "form.displayName": "Display name",
        "form.baseUrl": "API URL",
        "form.protocol": "API protocol",
        "form.protocolAuto": "Auto-detect",
        "form.protocolRoutes": "Protocol endpoints",
        "form.route.generate": "Text-to-image",
        "form.route.edit": "Image-to-image",
        "form.route.models": "List models",
        "form.routeUnsupported": "Not supported",
        "form.customProtocol": "Custom (enter URLs)",
        "form.hostModel": "Host model",
        "form.hostModelHint": "The Responses API needs a main model that can call the image tool.",
        "form.apiKey": "API key",
        "form.keyLocalOptional": "Optional for local services without auth",
        "form.keyEnter": "Enter API key",
        "form.keyEnvSaved": "Using the saved key from the environment",
        "form.keySaved": "Leave blank to use the saved credential",
        "form.modelDirectory": "Model catalog",
        "form.modelDirectoryCustom": "Custom model catalog",
        "form.modelDirectoryDefault": "Using the adapter's default models",
        "form.fetchNeedsBaseUrl": "Enter the API URL first",
        "form.fetching": "Fetching…",
        "form.fetchModels": "Fetch available models",
        "form.modelId": "Model ID",
        "form.reorderModel": "Reorder model",
        "form.reorderModelHelp": "Drag to reorder, or use the up and down arrow keys.",
        "form.deleteModel": "Remove model",
        "form.modelOptions": "Model options",
        "form.modelOptionsHint": "Override the ComfyUI workflow for this model. Leave blank to use the builtin workflow picked from the model type.",
        "form.modelOptionsUnsupported": "Custom workflows are only available with the ComfyUI deployment",
        "form.modelWorkflow": "Custom workflow (ComfyUI API format)",
        "form.modelWorkflowPlaceholder": "In ComfyUI use Export (API), then paste the JSON here",
        "form.modelWorkflowHelp": "Placeholders: {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (replaced by the uploaded reference on image edit)",
        "form.modelOptionsDone": "Done",
        "form.modelWorkflowSample": "Insert sample template",
        "form.modelEmpty": "The model picker will be empty. Add at least one model ID to the catalog first.",
        "form.addModel": "Add model",
        "form.advanced": "Advanced settings",
        "form.addMode": "Add method",
        "form.modeCatalog": "Model provider",
        "form.modeCustom": "Custom API",
        "form.modeLocal": "Local model",
        "form.modeCatalogHint": "Pick an official or major platform from the built-in list—OpenAI, Volcengine Ark, Alibaba Cloud Bailian, and others—then add its API key.",
        "form.modeCustomHint": "Connect a self-hosted service or any other OpenAI Images–compatible endpoint.",
        "form.modeLocalHint": "Connect to an image service on this machine or your local network. Local services without auth can leave the API key blank.",
        "form.provider": "Provider",
        "form.providerWebsite": "Provider website",
        "form.localDeployer": "Local deployment",
        "form.localPresetsMissing": "The host did not provide the local deployment list. Refresh the page and try again.",
        "form.save": "Save",
        "form.cancel": "Cancel",
        "picker.title": "Choose models",
        "picker.close": "Close",
        "picker.description": "These are the models this provider has available. Checked models make up the list.",
        "picker.search": "Search models",
        "picker.selectAll": "Select all",
        "picker.deselectAll": "Deselect all",
        "picker.showAll": "Show all models",
        "picker.filtered": "Filtered as likely non-image: {count}",
        "picker.noMatches": "No matching models",
        "picker.adopt": "Update list",
        "picker.keepOne": "Keep at least one model checked.",
        "seat.noMatches": "No matching models",
        "seat.empty": "No models yet. Add one in Settings → Image models.",
        "seat.auto": "Auto",
        "seat.fallback": "Image model",
        "seat.menuModel": "Model",
        "seat.menuQuality": "Quality",
        "seat.menuSize": "Size",
        "seat.menuPromptOptimization": "Prompt optimization",
        "seat.promptOptimizationUsage": "Uses more quota",
        "seat.notSelected": "Not selected",
        "seat.on": "On",
        "seat.off": "Off",
        "seat.sizeAutoValue": "Auto",
        "seat.sizeAutoHint": "Let the model choose the size",
        "seat.sizeAutoAria": "Automatic size",
        "seat.width": "Width",
        "seat.height": "Height",
        "seat.searchAria": "Search image models",
        "seat.searchPlaceholder": "Search models",
        "seat.clearSearch": "Clear search",
        "seat.menuAria": "Image models",
        "seat.choose": "Choose an image model",
        "seat.triggerAria": "Image model: {model}",
        "seat.triggerAriaQuality": "Image model: {model}, quality {quality}",
        "seat.settingsAria": "Image settings",
        "seat.moreSettings": "More settings",
        "seat.qualityUnsupported": "This model has no quality levels",
        "seat.qualityWarning": "Consumes usage quota faster",
        "seat.levelsCount": "{count} levels",
        "seat.levelsNone": "Unsupported",
        "seat.sizeTitle": "Size",
        "seat.back": "Back",
        "seat.modelAutoHint": "Let the model pick one",
        "errors.loadConfig": "Could not load image settings: HTTP {status}",
        "errors.loadConfigDetail": "Could not load image settings: {message}",
        "errors.saveConfig": "Could not save image settings: HTTP {status}",
        "errors.saveConfigDetail": "Could not save image settings: {message}",
        "errors.saveFailed": "Could not save image settings",
        "errors.fetchModels": "Could not fetch the model list: HTTP {status}",
        "errors.fetchModelsDetail": "Could not fetch the model list: {message}",
        "errors.noModels": "The service returned no models. Enter a model ID manually.",
        "errors.localUnreachable": "Could not reach the plugin's local service. Check that the DSH host is running.",
        "errors.localTimeout": "The local service timed out. Try again.",
        "serverError.network.format": "Network request failed: {host} {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "direct",
        "serverError.network.viaIndirect": "via the system network configuration",
        "serverError.network.hint.timeout": "TCP connection timed out.",
        "serverError.network.hint.dns": "DNS lookup failed. Check the domain spelling or your DNS.",
        "serverError.network.hint.connection": "Connection refused or reset. The port may be closed, or the service dropped the connection.",
        "serverError.network.hint.tls": "TLS certificate verification failed. The certificate may be expired or self-signed.",
        "serverError.network.timeout": "The request to {host} timed out.",
        "serverError.network.routeInvalid": "The network connection configuration is invalid. Check the network settings of the host or system.",
        "serverError.upstream.http": "The image service returned HTTP {status}: {detail}",
        "serverError.upstream.httpNoDetail": "The image service returned HTTP {status}.",
        "serverError.upstream.invalidJson": "The image service returned a non-JSON response.",
        "serverError.upstream.invalidResponse": "The {service} response is missing {field}.",
        "serverError.upstream.tooLarge": "The image service response exceeded the size limit.",
        "serverError.provider.notFound": "The selected image provider was not found.",
        "serverError.provider.missingBaseUrl": "Enter the API URL first.",
        "serverError.provider.missingKey": "The image provider “{provider}” has no API key.",
        "serverError.provider.missingKeyWithRef": "The image provider “{provider}” has no API key (credential {ref}).",
        "serverError.models.unsupported": "This provider does not expose a model list.",
        "serverError.models.notFound": "This address has no model list endpoint (HTTP 404). Type the model ID manually.",
        "serverError.adapter.unknownProtocol": "Unsupported image protocol: {protocol}. Available: {available}.",
        "serverError.adapter.notFound": "Image adapter not found: {adapter}. Available: {available}.",
        "serverError.config.credentialsUnavailable": "The credentials service is unavailable, so the API key cannot be stored securely.",
        "serverError.config.credentialSaveFailed": "Could not save the API key: {message}",
        "serverError.config.legacyKeyMigrationFailed": "Could not migrate the old API key: {message}",
        "serverError.config.writeFailed": "Could not save image settings: {message}",
        "serverError.request.methodNotAllowed": "That request method is not allowed.",
        "serverError.request.bodyTooLarge": "The request body is too large.",
        "serverError.request.invalidJson": "The request body is not valid JSON.",
        "quality.off": "Off",
        "quality.low": "Low",
        "quality.medium": "Medium",
        "quality.high": "High",
        "quality.xhigh": "XHigh",
        "quality.max": "Max",
        "quality.auto": "Auto",
        "quality.standard": "Standard",
        "quality.hd": "HD",
        "quality.default": "Default",
        "quality.quality": "Quality",
        "quality.turbo": "Turbo",
        "localPreset.sd-server.urlHint": "Enter the service root URL and keep the trailing /v1. The plugin appends /images/generations and /models.",
        "localPreset.sd-server.hint": "Native OpenAI Images API with both generation and /images/edits. The model is usually sd-cpp-local and can be listed from /v1/models.",
        "localPreset.localai.urlHint": "Enter the service root URL and keep the trailing /v1. The plugin appends /images/generations and /models.",
        "localPreset.localai.hint": "OpenAI Images compatible for generation; use the name from the LocalAI model YAML, listable from /v1/models. LocalAI has no /images/edits, so use an OpenAI-compatible gateway for image editing.",
        "localPreset.a1111.urlHint": "Enter the service root URL without /sdapi/v1. The plugin appends /sdapi/v1/txt2img, /img2img, and /sd-models.",
        "localPreset.a1111.hint": "Uses /sdapi/v1/txt2img and /sdapi/v1/img2img; the model list comes from /sdapi/v1/sd-models. Start A1111 with --api.",
        "localPreset.comfyui.urlHint": "Enter the service root URL without /prompt. The plugin appends /prompt, /upload/image, /history, and /view.",
        "localPreset.comfyui.hint": "Builtin workflows cover SD/SDXL, FLUX.2 and MOSS-Image for both generation and reference editing. For other architectures (Qwen-Image, Z-Image, …) paste your own ComfyUI workflow under \"Model options\" on the model row, or use an OpenAI-compatible gateway.",
        "localPreset.swarmui.urlHint": "Enter the service root URL without /API. The plugin appends /API/GetNewSession, /API/ListModels, and /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Uses /API/GenerateText2Image; the model list comes from /API/ListModels. Generation works; native editing is not supported yet.",
        "localPreset.openai-gateway.urlHint": "Enter the OpenAI API root URL (usually with /v1). The plugin appends /images/generations and /models.",
        "localPreset.openai-gateway.hint": "Choose this for InvokeAI, Fooocus, complex ComfyUI workflows, or a self-hosted service that exposes /v1/images/generations.",
        "update.available": "Update available",
        "update.title": "Update available",
        "update.version": "{from} → {to}",
        "update.cancel": "Cancel",
        "update.apply": "Update",
        "update.close": "Close",
        "update.starting": "Updating dsh-mo-image…",
        "update.doneRestart": "Update installed — restart DSH to apply",
        "update.done": "Updated to {version}",
        "update.failed": "Update did not finish — try again",
        "update.failedRestored": "The update failed — the previous version was restored",
        "update.failedBroken": "The update failed and the previous version was not restored — reinstall it from plugin management",
        "update.unsupported": "This environment cannot self-update; run {command}",
        "update.localDev": "Local development install — run git pull yourself",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "View on npm",
        "update.noNotes": "This release has no notes.",
        "form.modelMappingParse": "Parse workflow",
        "form.modelMappingParsing": "Parsing…",
        "form.modelMappingFailed": "Parsing failed",
        "form.modelMappingSkip": "Do not inject",
        "form.modelMappingFormatApi": "API format",
        "form.modelMappingFormatUi": "UI format",
        "form.modelMappingSampler": "Sampler",
        "form.modelMappingWidth": "Width",
        "form.modelMappingHeight": "Height",
        "form.modelMappingSeed": "Seed",
        "form.modelMappingModel": "Model",
        "form.modelMappingImage": "Reference image",
        "form.modelMappingColName": "Parameter",
        "form.modelMappingColTarget": "Mapping",
        "form.modelMappingColExpose": "Exposed",
        "form.modelAutoInjectHint": "The prompt and negative prompt come straight from the tool call, so there is nothing to configure here.",
        "param.steps": "Steps",
        "param.cfg": "CFG scale",
        "param.sampler_name": "Sampler",
        "param.scheduler": "Scheduler",
        "param.denoise": "Denoise",
        "param.batch_size": "Batch size",
        "param.guidance": "Guidance",
        "param.cfg.desc": "How strongly the prompt constrains the image; too high looks stiff, too low drifts off topic",
        "param.sampler_name.desc": "Sampling algorithm that decides convergence and texture",
        "param.scheduler.desc": "Noise schedule; with the sampler it sets the denoising rhythm",
        "param.denoise.desc": "How much of the source image is kept in image-to-image; 1 redraws it completely",
        "param.batch_size.desc": "Images generated per run; larger values use more VRAM",
        "param.guidance.desc": "Guidance scale for distilled models, usually close to 1",
        "form.a1111ParamsHint": "Checked parameters can be overridden through params; unchecked ones follow the WebUI settings",
        "form.a1111ColType": "Type",
        "seat.sizeAspect": "Ratio",
        "seat.sizeTier": "Tier",
        "seat.sizePreset": "Preset",
        "seat.sizeCustom": "Custom",
        "seat.sizeStrict": "Strict",
        "seat.sizeStrictHint": "The result is forced to the configured size; no effect when the request carries no size",
        "seat.sizePromptHint": "This model takes no size field; the size is written into the prompt",
        "seat.sizeHint.ratioOnly": "Resolution follows the ratio",
        "seat.sizeHint.fixedPixels": "Resolution is fixed by the platform: core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "This model takes no size field",
        "seat.sizeHint.modelDecides": "The model picks when no size is sent",
        "form.sizeParamsHint": "The adapter decides how this model takes its size; override it here, leave blank to keep the default.",
        "form.sizeMode": "Encoding",
        "form.sizeModeDefault": "Follow default",
        "form.sizeModeWhString": "size = WxH",
        "form.sizeModeWhFields": "width + height fields",
        "form.sizeModeAspect": "Aspect ratio",
        "form.sizeModeTier": "Tier name",
        "form.sizeModePrompt": "Append to prompt",
        "form.sizeField": "Parameter name",
        "form.sizeFieldHint": "Leave blank for the default; dotted paths like a.b.c are supported.",
        "form.sizeSeparator": "Separator",
        "form.sizeSeparatorCustom": "Custom",
        "form.sizeSecond": "Second field",
        "form.sizeSecondHint": "Optional: send the ratio or tier to another field; leave blank to skip.",
        "form.sizeFieldWidth": "Parameter name: width",
        "form.sizeFieldHeight": "Parameter name: height",
        "form.sizeFieldAspect": "Parameter name: ratio",
        "form.sizeFieldResolution": "Parameter name: resolution",
        "seat.sizeAutoHelp": "When enabled the model picks the size from the user's request.",
        "seat.sizeStrictHelp": "Forces the output to the configured size (the original is kept).",
        "form.paramSize": "Size",
        "form.paramQuality": "Quality",
        "form.paramPrompt": "Prompt",
        "form.paramNegative": "Negative prompt",
        "form.paramModel": "Model",
        "form.paramN": "Count",
        "form.paramImage": "Reference image",
        "form.paramLock": "Lock this key",
        "form.lockOn": "Locked: bulk and single detection skip it",
        "form.lockOff": "Unlocked: bulk configuration may overwrite it",
        "form.unlockAll": "Unlock all",
        "form.advancedParams": "Advanced (field names)",
        "form.paramsCommon": "General",
        "form.paramsHint": "Locked keys survive bulk and single detection; unlock one to edit it by hand.",
        "form.imageAs": "Encoding",
        "form.imageField": "Field name",
        "form.autoDetect": "Auto-detect",
        "form.detecting": "Detecting…",
        "form.detectNeedsModels": "Add a model first",
        "form.bulkConfigure": "Configure all",
        "form.bulkConfiguring": "Configuring…",
        "form.bulkConfigDone": "Configured {count} model(s) — {unmatched} did not match a rule",
        "form.bulkConfigNone": "No model matched a rule — sending the OpenAI-compatible body",
        "form.bulkConfigSkipped": "Every key is locked — bulk configuration wrote nothing",
        "errors.detectRule": "Rule detection failed",
      },
      "ja": {
        "nav": "画像生成モデル",
        "section.title": "画像生成モデル",
        "section.intro": "クラウドの API キーを入力するか、この PC または LAN 上の画像生成サービスに接続します。",
        "section.unnamedProvider": "名称未設定のプロバイダー",
        "tag.local": "ローカル",
        "tag.custom": "カスタム",
        "status.ready": "使用可能",
        "status.missingLocal": "API URL またはモデルが未設定",
        "status.missingCloud": "API URL、キー、モデルが未設定",
        "status.missingConfig": "設定が不足しています",
        "action.edit": "編集",
        "action.delete": "削除",
        "action.addProvider": "モデルプロバイダーを追加",
        "form.displayName": "表示名",
        "form.baseUrl": "API URL",
        "form.protocol": "API プロトコル",
        "form.protocolAuto": "自動判別",
        "form.protocolRoutes": "プロトコルの接続先",
        "form.route.generate": "テキストから生成",
        "form.route.edit": "画像から生成",
        "form.route.models": "モデル一覧",
        "form.routeUnsupported": "非対応",
        "form.customProtocol": "カスタム（URL を入力）",
        "form.hostModel": "ホストモデル",
        "form.hostModelHint": "Responses API では画像ツールを呼び出せるメインモデルが必要です。",
        "form.apiKey": "API キー",
        "form.keyLocalOptional": "認証なしのローカルサービスでは空欄可",
        "form.keyEnter": "API キーを入力",
        "form.keyEnvSaved": "環境変数の保存済みキーを使用中",
        "form.keySaved": "空欄のままにすると保存済みの認証情報を使用",
        "form.modelDirectory": "モデルカタログ",
        "form.modelDirectoryCustom": "カスタムモデルカタログ",
        "form.modelDirectoryDefault": "アダプターのデフォルトモデルを使用中",
        "form.fetchNeedsBaseUrl": "先に API URL を入力してください",
        "form.fetching": "取得中…",
        "form.fetchModels": "利用可能なモデルを取得",
        "form.modelId": "モデル ID",
        "form.reorderModel": "モデルの順序を変更",
        "form.reorderModelHelp": "ドラッグ、または上下の矢印キーで順序を変更できます。",
        "form.deleteModel": "モデルを削除",
        "form.modelOptions": "モデルオプション",
        "form.modelOptionsHint": "このモデル専用の ComfyUI ワークフローを指定します。空欄ならモデル種別に応じた組み込みワークフローを使います。",
        "form.modelOptionsUnsupported": "カスタムワークフローは ComfyUI デプロイ時のみ利用できます",
        "form.modelWorkflow": "カスタムワークフロー（ComfyUI API 形式）",
        "form.modelWorkflowPlaceholder": "ComfyUI で「エクスポート（API）」して JSON をここに貼り付け",
        "form.modelWorkflowHelp": "利用できるプレースホルダー：{{prompt}}、{{negative_prompt}}、{{width}}、{{height}}、{{seed}}、{{model}}、{{image}}（画像編集時はアップロードした参照画像に置き換わります）",
        "form.modelOptionsDone": "閉じる",
        "form.modelWorkflowSample": "サンプルを挿入",
        "form.modelEmpty": "モデル選択には何も表示されません。先にモデルカタログへモデル ID を追加してください。",
        "form.addModel": "モデルを追加",
        "form.advanced": "詳細設定",
        "form.addMode": "追加方法",
        "form.modeCatalog": "モデルプロバイダー",
        "form.modeCustom": "カスタム API",
        "form.modeLocal": "ローカルモデル",
        "form.modeCatalogHint": "組み込みリストから OpenAI、Volcengine Ark、Alibaba Cloud Bailian などの公式・大手プラットフォームを選び、API キーを入力します。",
        "form.modeCustomHint": "セルフホストサービスや、OpenAI Images 互換のその他のエンドポイントに接続します。",
        "form.modeLocalHint": "この PC または LAN 上の画像生成サービスに接続します。認証なしのローカルサービスなら API キーは空欄で構いません。",
        "form.provider": "プロバイダー",
        "form.providerWebsite": "プロバイダーのサイト",
        "form.localDeployer": "ローカルデプロイ",
        "form.localPresetsMissing": "ホストからローカルデプロイの一覧が届いていません。ページを再読み込みしてください。",
        "form.save": "保存",
        "form.cancel": "キャンセル",
        "picker.title": "モデルを選択",
        "picker.close": "閉じる",
        "picker.description": "プロバイダーが利用可能なモデルです。チェックしたモデルがリストになります。",
        "picker.search": "モデルを検索",
        "picker.selectAll": "すべて選択",
        "picker.deselectAll": "選択を解除",
        "picker.showAll": "すべてのモデルを表示",
        "picker.filtered": "画像生成向けではない可能性があるモデルを {count} 件除外しました",
        "picker.noMatches": "一致するモデルがありません",
        "picker.adopt": "リストを更新",
        "picker.keepOne": "少なくとも 1 つのモデルをチェックしたままにしてください。",
        "seat.noMatches": "一致するモデルがありません",
        "seat.empty": "モデルがまだありません。「設定 → 画像生成モデル」で追加してください。",
        "seat.auto": "自動",
        "seat.fallback": "画像生成モデル",
        "seat.menuModel": "モデル",
        "seat.menuQuality": "画質",
        "seat.menuSize": "サイズ",
        "seat.menuPromptOptimization": "プロンプト最適化",
        "seat.promptOptimizationUsage": "使用量が増えます",
        "seat.notSelected": "未選択",
        "seat.on": "オン",
        "seat.off": "オフ",
        "seat.sizeAutoValue": "自動",
        "seat.sizeAutoHint": "サイズはモデルに任せます",
        "seat.sizeAutoAria": "自動サイズ",
        "seat.width": "幅",
        "seat.height": "高さ",
        "seat.searchAria": "画像生成モデルを検索",
        "seat.searchPlaceholder": "モデルを検索",
        "seat.clearSearch": "検索をクリア",
        "seat.menuAria": "画像生成モデル",
        "seat.choose": "画像生成モデルを選択",
        "seat.triggerAria": "画像生成モデル：{model}",
        "seat.triggerAriaQuality": "画像生成モデル：{model}、画質 {quality}",
        "seat.settingsAria": "画像生成設定",
        "seat.moreSettings": "その他の設定",
        "seat.qualityUnsupported": "このモデルには画質レベルがありません",
        "seat.qualityWarning": "使用量を早く消費します",
        "seat.levelsCount": "{count} 段階",
        "seat.levelsNone": "非対応",
        "seat.sizeTitle": "サイズ",
        "seat.back": "戻る",
        "seat.modelAutoHint": "モデルに任せる",
        "errors.loadConfig": "画像設定を読み込めませんでした：HTTP {status}",
        "errors.loadConfigDetail": "画像設定を読み込めませんでした：{message}",
        "errors.saveConfig": "画像設定を保存できませんでした：HTTP {status}",
        "errors.saveConfigDetail": "画像設定を保存できませんでした：{message}",
        "errors.saveFailed": "画像設定を保存できませんでした",
        "errors.fetchModels": "モデル一覧を取得できませんでした：HTTP {status}",
        "errors.fetchModelsDetail": "モデル一覧を取得できませんでした：{message}",
        "errors.noModels": "サービスがモデルを返しませんでした。モデル ID を手動で入力してください。",
        "errors.localUnreachable": "プラグインのローカルサービスに接続できません。DSH ホストが実行中か確認してください。",
        "errors.localTimeout": "ローカルサービスの応答がタイムアウトしました。しばらくしてから再試行してください。",
        "serverError.network.format": "ネットワークリクエストに失敗しました：{host} {cause}（{via}）。{hint}",
        "serverError.network.viaDirect": "直接接続",
        "serverError.network.viaIndirect": "システムのネットワーク設定経由",
        "serverError.network.hint.timeout": "TCP 接続がタイムアウトしました。",
        "serverError.network.hint.dns": "DNS 解決に失敗しました。ドメイン名の誤り、または DNS の不調が考えられます。",
        "serverError.network.hint.connection": "接続が拒否またはリセットされました。ポートが閉じているか、サービスが切断した可能性があります。",
        "serverError.network.hint.tls": "TLS 証明書の検証に失敗しました。証明書が期限切れか自己署名の可能性があります。",
        "serverError.network.timeout": "{host} へのリクエストがタイムアウトしました。",
        "serverError.network.routeInvalid": "ネットワーク接続の設定が無効です。ホストまたはシステムのネットワーク設定を確認してください。",
        "serverError.upstream.http": "画像サービスが HTTP {status} を返しました：{detail}",
        "serverError.upstream.httpNoDetail": "画像サービスが HTTP {status} を返しました。",
        "serverError.upstream.invalidJson": "画像サービスが JSON 以外の応答を返しました。",
        "serverError.upstream.invalidResponse": "{service} の応答に {field} がありません。",
        "serverError.upstream.tooLarge": "画像サービスの応答がサイズ上限を超えました。",
        "serverError.provider.notFound": "指定された画像プロバイダーが見つかりません。",
        "serverError.provider.missingBaseUrl": "先に API URL を入力してください。",
        "serverError.provider.missingKey": "画像プロバイダー「{provider}」に API キーがありません。",
        "serverError.provider.missingKeyWithRef": "画像プロバイダー「{provider}」に API キーがありません（認証情報 {ref}）。",
        "serverError.models.unsupported": "このデプロイ方法ではモデル一覧を取得できません。",
        "serverError.models.notFound": "このアドレスにはモデル一覧の API がありません（HTTP 404）。モデル ID を手動で入力してください。",
        "serverError.adapter.unknownProtocol": "未対応の画像プロトコルです：{protocol}（利用可能：{available}）",
        "serverError.adapter.notFound": "画像アダプターが見つかりません：{adapter}（利用可能：{available}）",
        "serverError.config.credentialsUnavailable": "認証情報サービスが利用できないため、API キーを安全に保存できません。",
        "serverError.config.credentialSaveFailed": "API キーを保存できませんでした：{message}",
        "serverError.config.legacyKeyMigrationFailed": "古い API キーの移行に失敗しました：{message}",
        "serverError.config.writeFailed": "画像設定を保存できませんでした：{message}",
        "serverError.request.methodNotAllowed": "そのリクエストメソッドは許可されていません。",
        "serverError.request.bodyTooLarge": "リクエスト本文が大きすぎます。",
        "serverError.request.invalidJson": "リクエスト本文が有効な JSON ではありません。",
        "quality.off": "オフ",
        "quality.low": "低",
        "quality.medium": "中",
        "quality.high": "高",
        "quality.xhigh": "極高",
        "quality.max": "最大",
        "quality.auto": "自動",
        "quality.standard": "標準",
        "quality.hd": "HD",
        "quality.default": "デフォルト",
        "quality.quality": "高品質",
        "quality.turbo": "ターボ",
        "localPreset.sd-server.urlHint": "サービスのルート URL のみを入力し、末尾の /v1 は残してください。プラグインが /images/generations と /models を追加します。",
        "localPreset.sd-server.hint": "ネイティブな OpenAI Images API で、生成と /images/edits による編集の両方に対応します。モデル名は通常 sd-cpp-local で、/v1/models から取得できます。",
        "localPreset.localai.urlHint": "サービスのルート URL のみを入力し、末尾の /v1 は残してください。プラグインが /images/generations と /models を追加します。",
        "localPreset.localai.hint": "生成は OpenAI Images 互換です。モデル名は LocalAI のモデル YAML にある name を指定し、/v1/models から取得できます。LocalAI には /images/edits がないため、画像編集は「その他の OpenAI 互換ゲートウェイ」を使用してください。",
        "localPreset.a1111.urlHint": "サービスのルート URL のみを入力し、/sdapi/v1 は含めないでください。プラグインが /sdapi/v1/txt2img、/img2img、/sd-models を追加します。",
        "localPreset.a1111.hint": "/sdapi/v1/txt2img と /sdapi/v1/img2img を使用し、モデル一覧は /sdapi/v1/sd-models から取得します。A1111 は --api 付きで起動してください。",
        "localPreset.comfyui.urlHint": "サービスのルート URL のみを入力し、/prompt は含めないでください。プラグインが /prompt、/upload/image、/history、/view を追加します。",
        "localPreset.comfyui.hint": "SD/SDXL、FLUX.2、MOSS-Image の組み込みワークフローで生成と参照画像編集に対応します。その他の構成（Qwen-Image、Z-Image など）は、モデル行の「モデルオプション」にご自身の ComfyUI ワークフローを貼り付けるか、OpenAI 互換ゲートウェイをご利用ください。",
        "localPreset.swarmui.urlHint": "サービスのルート URL のみを入力し、/API は含めないでください。プラグインが /API/GetNewSession、/API/ListModels、/API/GenerateText2Image を追加します。",
        "localPreset.swarmui.hint": "/API/GenerateText2Image を使用し、モデル一覧は /API/ListModels から取得します。生成は利用できますが、ネイティブ編集には未対応です。",
        "localPreset.openai-gateway.urlHint": "OpenAI API のルート URL（通常は /v1 付き）を入力してください。プラグインが /images/generations と /models を追加します。",
        "localPreset.openai-gateway.hint": "InvokeAI、Fooocus、複雑な ComfyUI ワークフロー、または /v1/images/generations を公開するセルフホストサービスにはこれを選んでください。",
        "update.available": "アップデートがあります",
        "update.title": "アップデートがあります",
        "update.version": "{from} → {to}",
        "update.cancel": "キャンセル",
        "update.apply": "更新",
        "update.close": "閉じる",
        "update.starting": "dsh-mo-image を更新中…",
        "update.doneRestart": "更新が完了しました。DSH を再起動すると有効になります",
        "update.done": "{version} に更新しました",
        "update.failed": "更新が完了しませんでした。もう一度お試しください",
        "update.failedRestored": "更新のインストールに失敗しました。元のバージョンに戻しました",
        "update.failedBroken": "更新のインストールに失敗し、元のバージョンにも戻せませんでした。プラグイン管理から再インストールしてください",
        "update.unsupported": "この環境では自動更新できません。{command} を実行してください",
        "update.localDev": "ローカル開発用のインストールです。git pull を実行してください",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "npm で見る",
        "update.noNotes": "このリリースには説明がありません。",
        "form.modelMappingParse": "ワークフローを解析",
        "form.modelMappingParsing": "解析中…",
        "form.modelMappingFailed": "解析に失敗しました",
        "form.modelMappingSkip": "注入しない",
        "form.modelMappingFormatApi": "API 形式",
        "form.modelMappingFormatUi": "UI 形式",
        "form.modelMappingSampler": "サンプラー",
        "form.modelMappingWidth": "幅",
        "form.modelMappingHeight": "高さ",
        "form.modelMappingSeed": "シード",
        "form.modelMappingModel": "モデル",
        "form.modelMappingImage": "参照画像",
        "form.modelMappingColName": "パラメータ",
        "form.modelMappingColTarget": "マッピング",
        "form.modelMappingColExpose": "公開",
        "form.modelAutoInjectHint": "プロンプトとネガティブプロンプトはツール引数から直接書き込まれるため、ここでの設定は不要です。",
        "param.steps": "ステップ数",
        "param.cfg": "プロンプト強度",
        "param.sampler_name": "サンプラー",
        "param.scheduler": "スケジューラー",
        "param.denoise": "再描画量",
        "param.batch_size": "バッチ数",
        "param.guidance": "ガイダンス強度",
        "param.cfg.desc": "プロンプトが画像を拘束する強さ。高すぎると硬く、低すぎると意図から外れる",
        "param.sampler_name.desc": "収束の仕方と質感を決めるサンプリングアルゴリズム",
        "param.scheduler.desc": "ノイズのスケジュール。サンプラーと組で除去のリズムを決める",
        "param.denoise.desc": "画像から画像で元画像を残す度合い。1 は完全な再描画",
        "param.batch_size.desc": "一度に生成する枚数。大きいほど VRAM を使う",
        "param.guidance.desc": "蒸留モデルのガイダンス係数。通常は 1 付近",
        "form.a1111ParamsHint": "チェックした項目だけ params で上書きできます。チェックしない項目は WebUI の設定に従います",
        "form.a1111ColType": "種類",
        "seat.sizeAspect": "比率",
        "seat.sizeTier": "解像度",
        "seat.sizePreset": "プリセット",
        "seat.sizeCustom": "カスタム",
        "seat.sizeStrict": "厳密",
        "seat.sizeStrictHint": "出力サイズを設定値に揃えます。指定がない場合は無効です",
        "seat.sizePromptHint": "このモデルはサイズ指定を受け取らないためプロンプトに書き込みます",
        "seat.sizeHint.ratioOnly": "解像度は比率に応じて決まります",
        "seat.sizeHint.fixedPixels": "解像度は固定です：core 1.5MP、sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "このモデルはサイズ指定を受け取りません",
        "seat.sizeHint.modelDecides": "未指定ならモデルが選びます",
        "form.sizeParamsHint": "サイズの渡し方はアダプタが決めます。ここで上書きでき、空欄なら既定のままです。",
        "form.sizeMode": "エンコード方式",
        "form.sizeModeDefault": "既定に従う",
        "form.sizeModeWhString": "size = 幅x高さ",
        "form.sizeModeWhFields": "width + height の2項目",
        "form.sizeModeAspect": "アスペクト比",
        "form.sizeModeTier": "段階名（1K / 2K）",
        "form.sizeModePrompt": "プロンプトに追記",
        "form.sizeField": "パラメータ名",
        "form.sizeFieldHint": "空欄で既定値。a.b.c のような入れ子パスも可。",
        "form.sizeSeparator": "区切り文字",
        "form.sizeSeparatorCustom": "カスタム",
        "form.sizeSecond": "2つ目の項目",
        "form.sizeSecondHint": "任意：比率や段階を別の項目にも送れます。空欄なら送りません。",
        "form.sizeFieldWidth": "パラメータ名：幅",
        "form.sizeFieldHeight": "パラメータ名：高さ",
        "form.sizeFieldAspect": "パラメータ名：比率",
        "form.sizeFieldResolution": "パラメータ名：解像度",
        "seat.sizeAutoHelp": "有効にすると、モデルがユーザーの要望に応じてサイズを調整します。",
        "seat.sizeStrictHelp": "有効にすると出力を設定サイズに縮小・拡大します（元画像は保存されます）。",
        "form.paramSize": "サイズ",
        "form.paramQuality": "品質",
        "form.paramPrompt": "プロンプト",
        "form.paramNegative": "ネガティブプロンプト",
        "form.paramModel": "モデル",
        "form.paramN": "枚数",
        "form.paramImage": "参照画像",
        "form.paramLock": "この項目をロック",
        "form.lockOn": "ロック中：一括設定と自動検出は触りません",
        "form.lockOff": "未ロック：一括設定で上書きされます",
        "form.unlockAll": "すべてロック解除",
        "form.advancedParams": "詳細（項目名の手入力）",
        "form.paramsCommon": "一般",
        "form.paramsHint": "ロックした項目は一括設定と自動検出では変更されません。手入力するにはロックを解除してください。",
        "form.imageAs": "送信形式",
        "form.imageField": "フィールド名",
        "form.autoDetect": "自動検出",
        "form.detecting": "検出中…",
        "form.detectNeedsModels": "先にモデルを追加してください",
        "form.bulkConfigure": "一括設定",
        "form.bulkConfiguring": "設定中…",
        "form.bulkConfigDone": "モデル {count} 件を設定しました — {unmatched} 件はルールに一致しません",
        "form.bulkConfigNone": "ルールに一致したモデルがないため OpenAI 互換で送信します",
        "form.bulkConfigSkipped": "すべての項目がロックされているため一括設定は何も書きませんでした",
        "errors.detectRule": "ルール検出に失敗しました",
      },
      "es": {
        "nav": "Modelos de imagen",
        "section.title": "Modelos de imagen",
        "section.intro": "Añade una clave de API en la nube o conéctate a un servicio de imágenes en este equipo o en tu red local.",
        "section.unnamedProvider": "Proveedor sin nombre",
        "tag.local": "Local",
        "tag.custom": "Personalizado",
        "status.ready": "Listo",
        "status.missingLocal": "Falta la URL de la API o el modelo",
        "status.missingCloud": "Falta la URL de la API, la clave o el modelo",
        "status.missingConfig": "Sin configurar",
        "action.edit": "Editar",
        "action.delete": "Eliminar",
        "action.addProvider": "Añadir proveedor",
        "form.displayName": "Nombre visible",
        "form.baseUrl": "URL de la API",
        "form.protocol": "Protocolo de API",
        "form.protocolAuto": "Detección automática",
        "form.protocolRoutes": "Direcciones del protocolo",
        "form.route.generate": "Texto a imagen",
        "form.route.edit": "Imagen a imagen",
        "form.route.models": "Listar modelos",
        "form.routeUnsupported": "No compatible",
        "form.customProtocol": "Personalizado (introducir URLs)",
        "form.hostModel": "Modelo anfitrión",
        "form.hostModelHint": "La API Responses necesita un modelo principal que pueda llamar a la herramienta de imagen.",
        "form.apiKey": "Clave de API",
        "form.keyLocalOptional": "Opcional para servicios locales sin autenticación",
        "form.keyEnter": "Introduce la clave de API",
        "form.keyEnvSaved": "Usando la clave guardada en el entorno",
        "form.keySaved": "Déjalo vacío para usar la credencial guardada",
        "form.modelDirectory": "Catálogo de modelos",
        "form.modelDirectoryCustom": "Catálogo de modelos personalizado",
        "form.modelDirectoryDefault": "Usando los modelos predeterminados del adaptador",
        "form.fetchNeedsBaseUrl": "Introduce primero la URL de la API",
        "form.fetching": "Obteniendo…",
        "form.fetchModels": "Obtener modelos disponibles",
        "form.modelId": "ID del modelo",
        "form.reorderModel": "Reordenar modelo",
        "form.reorderModelHelp": "Arrastre para reordenar o use las teclas de flecha hacia arriba y hacia abajo.",
        "form.deleteModel": "Eliminar modelo",
        "form.modelOptions": "Opciones del modelo",
        "form.modelOptionsHint": "Sobrescribe el flujo de trabajo de ComfyUI para este modelo. Déjalo vacío para usar el flujo integrado según el tipo de modelo.",
        "form.modelOptionsUnsupported": "Los flujos personalizados solo están disponibles con el despliegue ComfyUI",
        "form.modelWorkflow": "Flujo de trabajo personalizado (formato API de ComfyUI)",
        "form.modelWorkflowPlaceholder": "En ComfyUI usa Exportar (API) y pega el JSON aquí",
        "form.modelWorkflowHelp": "Marcadores: {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (se sustituye por la referencia subida al editar)",
        "form.modelOptionsDone": "Listo",
        "form.modelWorkflowSample": "Insertar plantilla de ejemplo",
        "form.modelEmpty": "El selector de modelos estará vacío. Añade primero al menos un ID de modelo al catálogo.",
        "form.addModel": "Añadir modelo",
        "form.advanced": "Ajustes avanzados",
        "form.addMode": "Forma de añadir",
        "form.modeCatalog": "Proveedor de modelos",
        "form.modeCustom": "API personalizada",
        "form.modeLocal": "Modelo local",
        "form.modeCatalogHint": "Elige una plataforma oficial o importante de la lista integrada (OpenAI, Volcengine Ark, Alibaba Cloud Bailian y otras) y añade su clave de API.",
        "form.modeCustomHint": "Conecta un servicio autoalojado o cualquier otro endpoint compatible con OpenAI Images.",
        "form.modeLocalHint": "Conecta un servicio de imágenes en este equipo o en tu red local. Los servicios locales sin autenticación pueden dejar la clave de API vacía.",
        "form.provider": "Proveedor",
        "form.providerWebsite": "Web del proveedor",
        "form.localDeployer": "Despliegue local",
        "form.localPresetsMissing": "El host no envió la lista de despliegues locales. Recarga la página e inténtalo de nuevo.",
        "form.save": "Guardar",
        "form.cancel": "Cancelar",
        "picker.title": "Elegir modelos",
        "picker.close": "Cerrar",
        "picker.description": "Estos son los modelos que tiene disponibles este proveedor. Los modelos marcados componen la lista.",
        "picker.search": "Buscar modelos",
        "picker.selectAll": "Seleccionar todo",
        "picker.deselectAll": "Anular selección",
        "picker.showAll": "Mostrar todos los modelos",
        "picker.filtered": "Se han filtrado {count} modelos que probablemente no generan imágenes",
        "picker.noMatches": "No hay modelos coincidentes",
        "picker.adopt": "Actualizar lista",
        "picker.keepOne": "Mantén al menos un modelo marcado.",
        "seat.noMatches": "No hay modelos coincidentes",
        "seat.empty": "Aún no hay modelos. Añade uno en Ajustes → Modelos de imagen.",
        "seat.auto": "Automático",
        "seat.fallback": "Modelo de imagen",
        "seat.menuModel": "Modelo",
        "seat.menuQuality": "Calidad",
        "seat.menuSize": "Tamaño",
        "seat.menuPromptOptimization": "Optimización de prompts",
        "seat.promptOptimizationUsage": "Usa más cuota",
        "seat.notSelected": "Sin seleccionar",
        "seat.on": "Activado",
        "seat.off": "Desactivado",
        "seat.sizeAutoValue": "Automático",
        "seat.sizeAutoHint": "Deja que el modelo elija el tamaño",
        "seat.sizeAutoAria": "Tamaño automático",
        "seat.width": "Ancho",
        "seat.height": "Alto",
        "seat.searchAria": "Buscar modelos de imagen",
        "seat.searchPlaceholder": "Buscar modelos",
        "seat.clearSearch": "Borrar búsqueda",
        "seat.menuAria": "Modelos de imagen",
        "seat.choose": "Elegir un modelo de imagen",
        "seat.triggerAria": "Modelo de imagen: {model}",
        "seat.triggerAriaQuality": "Modelo de imagen: {model}, calidad {quality}",
        "seat.settingsAria": "Ajustes de imagen",
        "seat.moreSettings": "Más ajustes",
        "seat.qualityUnsupported": "Este modelo no ofrece niveles de calidad",
        "seat.qualityWarning": "Consume la cuota más rápido",
        "seat.levelsCount": "{count} niveles",
        "seat.levelsNone": "No compatible",
        "seat.sizeTitle": "Tamaño",
        "seat.back": "Volver",
        "seat.modelAutoHint": "Deja que el modelo elija",
        "errors.loadConfig": "No se pudo cargar la configuración de imagen: HTTP {status}",
        "errors.loadConfigDetail": "No se pudo cargar la configuración de imagen: {message}",
        "errors.saveConfig": "No se pudo guardar la configuración de imagen: HTTP {status}",
        "errors.saveConfigDetail": "No se pudo guardar la configuración de imagen: {message}",
        "errors.saveFailed": "No se pudo guardar la configuración de imagen",
        "errors.fetchModels": "No se pudo obtener la lista de modelos: HTTP {status}",
        "errors.fetchModelsDetail": "No se pudo obtener la lista de modelos: {message}",
        "errors.noModels": "El servicio no devolvió modelos. Introduce un ID de modelo manualmente.",
        "errors.localUnreachable": "No se pudo conectar con el servicio local del plugin. Comprueba que el host de DSH esté en ejecución.",
        "errors.localTimeout": "El servicio local agotó el tiempo de espera. Inténtalo de nuevo.",
        "serverError.network.format": "No se pudo conectar con {host}: {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "conexión directa",
        "serverError.network.viaIndirect": "mediante la configuración de red del sistema",
        "serverError.network.hint.timeout": "Se agotó el tiempo de conexión TCP.",
        "serverError.network.hint.dns": "No se pudo resolver el DNS. Revisa el dominio o tu DNS.",
        "serverError.network.hint.connection": "Conexión rechazada o restablecida. El puerto puede estar cerrado o el servicio cortó la conexión.",
        "serverError.network.hint.tls": "No se pudo verificar el certificado TLS. Puede estar caducado o ser autofirmado.",
        "serverError.network.timeout": "La solicitud a {host} agotó el tiempo de espera.",
        "serverError.network.routeInvalid": "La configuración de conexión de red no es válida. Revisa la configuración de red del host o del sistema.",
        "serverError.upstream.http": "El servicio de imágenes devolvió HTTP {status}: {detail}",
        "serverError.upstream.httpNoDetail": "El servicio de imágenes devolvió HTTP {status}.",
        "serverError.upstream.invalidJson": "El servicio de imágenes devolvió una respuesta que no es JSON.",
        "serverError.upstream.invalidResponse": "La respuesta de {service} no incluye {field}.",
        "serverError.upstream.tooLarge": "La respuesta del servicio de imágenes superó el límite de tamaño.",
        "serverError.provider.notFound": "No se encontró el proveedor de imágenes seleccionado.",
        "serverError.provider.missingBaseUrl": "Introduce primero la URL de la API.",
        "serverError.provider.missingKey": "El proveedor de imágenes «{provider}» no tiene clave de API.",
        "serverError.provider.missingKeyWithRef": "El proveedor de imágenes «{provider}» no tiene clave de API (credencial {ref}).",
        "serverError.models.unsupported": "Este proveedor no ofrece una lista de modelos.",
        "serverError.models.notFound": "Esta dirección no tiene un endpoint de lista de modelos (HTTP 404). Escribe el ID del modelo manualmente.",
        "serverError.adapter.unknownProtocol": "Protocolo de imagen no compatible: {protocol}. Disponibles: {available}.",
        "serverError.adapter.notFound": "No se encontró el adaptador de imágenes: {adapter}. Disponibles: {available}.",
        "serverError.config.credentialsUnavailable": "El servicio de credenciales no está disponible, así que la clave de API no se puede guardar de forma segura.",
        "serverError.config.credentialSaveFailed": "No se pudo guardar la clave de API: {message}",
        "serverError.config.legacyKeyMigrationFailed": "No se pudo migrar la clave de API anterior: {message}",
        "serverError.config.writeFailed": "No se pudo guardar la configuración de imagen: {message}",
        "serverError.request.methodNotAllowed": "Ese método de solicitud no está permitido.",
        "serverError.request.bodyTooLarge": "El cuerpo de la solicitud es demasiado grande.",
        "serverError.request.invalidJson": "El cuerpo de la solicitud no es JSON válido.",
        "quality.off": "Desactivado",
        "quality.low": "Baja",
        "quality.medium": "Media",
        "quality.high": "Alta",
        "quality.xhigh": "Muy alta",
        "quality.max": "Máxima",
        "quality.auto": "Automática",
        "quality.standard": "Estándar",
        "quality.hd": "HD",
        "quality.default": "Predeterminada",
        "quality.quality": "Alta calidad",
        "quality.turbo": "Turbo",
        "localPreset.sd-server.urlHint": "Introduce solo la URL raíz del servicio y conserva /v1 al final. El plugin añade /images/generations y /models.",
        "localPreset.sd-server.hint": "API nativa de OpenAI Images; admite generación y edición con /images/edits. El modelo suele ser sd-cpp-local y se puede listar desde /v1/models.",
        "localPreset.localai.urlHint": "Introduce solo la URL raíz del servicio y conserva /v1 al final. El plugin añade /images/generations y /models.",
        "localPreset.localai.hint": "Compatible con OpenAI Images para generar; usa el name del YAML de modelos de LocalAI, listable desde /v1/models. LocalAI no tiene /images/edits, así que para editar imágenes usa una pasarela compatible con OpenAI.",
        "localPreset.a1111.urlHint": "Introduce solo la URL raíz del servicio, sin /sdapi/v1. El plugin añade /sdapi/v1/txt2img, /img2img y /sd-models.",
        "localPreset.a1111.hint": "Usa /sdapi/v1/txt2img y /sdapi/v1/img2img; la lista de modelos viene de /sdapi/v1/sd-models. Inicia A1111 con --api.",
        "localPreset.comfyui.urlHint": "Introduce solo la URL raíz del servicio, sin /prompt. El plugin añade /prompt, /upload/image, /history y /view.",
        "localPreset.comfyui.hint": "Los flujos integrados cubren SD/SDXL, FLUX.2 y MOSS-Image, tanto para generar como para editar con referencia. Para otras arquitecturas (Qwen-Image, Z-Image…) pega tu flujo de ComfyUI en «Opciones del modelo» o usa una pasarela compatible con OpenAI.",
        "localPreset.swarmui.urlHint": "Introduce solo la URL raíz del servicio, sin /API. El plugin añade /API/GetNewSession, /API/ListModels y /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Usa /API/GenerateText2Image; la lista de modelos viene de /API/ListModels. La generación funciona; la edición nativa aún no es compatible.",
        "localPreset.openai-gateway.urlHint": "Introduce la URL raíz de la API de OpenAI (normalmente con /v1). El plugin añade /images/generations y /models.",
        "localPreset.openai-gateway.hint": "Elige esta opción para InvokeAI, Fooocus, flujos complejos de ComfyUI o un servicio autoalojado que exponga /v1/images/generations.",
        "update.available": "Actualización disponible",
        "update.title": "Actualización disponible",
        "update.version": "{from} → {to}",
        "update.cancel": "Cancelar",
        "update.apply": "Actualizar",
        "update.close": "Cerrar",
        "update.starting": "Actualizando dsh-mo-image…",
        "update.doneRestart": "Actualización instalada. Reinicia DSH para aplicarla",
        "update.done": "Actualizado a {version}",
        "update.failed": "La actualización no terminó. Inténtalo de nuevo",
        "update.failedRestored": "La actualización falló; se restauró la versión anterior",
        "update.failedBroken": "La actualización falló y no se restauró la versión anterior; reinstálala desde la gestión de complementos",
        "update.unsupported": "Este entorno no admite la actualización automática; ejecuta {command}",
        "update.localDev": "Instalación de desarrollo local: ejecuta git pull",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "Ver en npm",
        "update.noNotes": "Esta versión no tiene notas.",
        "form.modelMappingParse": "Analizar flujo de trabajo",
        "form.modelMappingParsing": "Analizando…",
        "form.modelMappingFailed": "No se pudo analizar",
        "form.modelMappingSkip": "No inyectar",
        "form.modelMappingFormatApi": "Formato API",
        "form.modelMappingFormatUi": "Formato UI",
        "form.modelMappingSampler": "Muestreador",
        "form.modelMappingWidth": "Ancho",
        "form.modelMappingHeight": "Alto",
        "form.modelMappingSeed": "Semilla",
        "form.modelMappingModel": "Modelo",
        "form.modelMappingImage": "Imagen de referencia",
        "form.modelMappingColName": "Parámetro",
        "form.modelMappingColTarget": "Mapeo",
        "form.modelMappingColExpose": "Expuesto",
        "form.modelAutoInjectHint": "El prompt y el prompt negativo llegan de la llamada de la herramienta, así que aquí no hay nada que configurar.",
        "param.steps": "Pasos",
        "param.cfg": "Intensidad del prompt",
        "param.sampler_name": "Muestreador",
        "param.scheduler": "Planificador",
        "param.denoise": "Redibujado",
        "param.batch_size": "Tamaño de lote",
        "param.guidance": "Intensidad de guía",
        "param.cfg.desc": "Cuánto constriñe el prompt la imagen; demasiado alto la vuelve rígida, demasiado bajo se desvía",
        "param.sampler_name.desc": "Algoritmo de muestreo que decide la convergencia y la textura",
        "param.scheduler.desc": "Curva de ruido; junto al muestreador marca el ritmo de eliminación de ruido",
        "param.denoise.desc": "Cuánto de la imagen original se conserva; 1 la redibuja por completo",
        "param.batch_size.desc": "Imágenes por ejecución; valores mayores usan más VRAM",
        "param.guidance.desc": "Escala de guía para modelos destilados, normalmente cerca de 1",
        "form.a1111ParamsHint": "Los parámetros marcados se pueden sobrescribir con params; los demás siguen la configuración del WebUI",
        "form.a1111ColType": "Tipo",
        "seat.sizeAspect": "Proporción",
        "seat.sizeTier": "Nivel",
        "seat.sizePreset": "Preajuste",
        "seat.sizeCustom": "Personalizado",
        "seat.sizeStrict": "Estricto",
        "seat.sizeStrictHint": "El resultado se ajusta al tamaño configurado; sin tamaño no aplica",
        "seat.sizePromptHint": "Este modelo no acepta tamaño; se escribe en el prompt",
        "seat.sizeHint.ratioOnly": "La resolución depende de la proporción",
        "seat.sizeHint.fixedPixels": "La resolución la fija la plataforma: core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "Este modelo no acepta tamaño",
        "seat.sizeHint.modelDecides": "Si no se envía tamaño, lo elige el modelo",
        "form.sizeParamsHint": "El adaptador decide cómo recibe el tamaño este modelo; puedes cambiarlo aquí y dejarlo vacío para usar el valor por defecto.",
        "form.sizeMode": "Codificación",
        "form.sizeModeDefault": "Seguir el valor por defecto",
        "form.sizeModeWhString": "size = AnxAl",
        "form.sizeModeWhFields": "campos width + height",
        "form.sizeModeAspect": "Relación de aspecto",
        "form.sizeModeTier": "Nombre de nivel",
        "form.sizeModePrompt": "Añadir al prompt",
        "form.sizeField": "Nombre del parámetro",
        "form.sizeFieldHint": "Vacío para el valor por defecto; admite rutas como a.b.c.",
        "form.sizeSeparator": "Separador",
        "form.sizeSeparatorCustom": "Personalizado",
        "form.sizeSecond": "Segundo campo",
        "form.sizeSecondHint": "Opcional: envía la proporción o el nivel en otro campo; vacío para no enviarlo.",
        "form.sizeFieldWidth": "Nombre del parámetro: ancho",
        "form.sizeFieldHeight": "Nombre del parámetro: alto",
        "form.sizeFieldAspect": "Nombre del parámetro: proporción",
        "form.sizeFieldResolution": "Nombre del parámetro: resolución",
        "seat.sizeAutoHelp": "Activado, el modelo ajusta el tamaño según lo que pida el usuario.",
        "seat.sizeStrictHelp": "Fuerza el tamaño configurado (la imagen original se conserva).",
        "form.paramSize": "Tamaño",
        "form.paramQuality": "Calidad",
        "form.paramPrompt": "Prompt",
        "form.paramNegative": "Prompt negativo",
        "form.paramModel": "Modelo",
        "form.paramN": "Cantidad",
        "form.paramImage": "Imagen de referencia",
        "form.paramLock": "Bloquear esta clave",
        "form.lockOn": "Bloqueado: la configuración y la detección lo omiten",
        "form.lockOff": "Desbloqueado: la configuración puede sobrescribirlo",
        "form.unlockAll": "Desbloquear todo",
        "form.advancedParams": "Avanzado (nombres de campo)",
        "form.paramsCommon": "General",
        "form.paramsHint": "Las claves bloqueadas no las cambia la configuración ni la detección; desbloquea una para editarla a mano.",
        "form.imageAs": "Codificación",
        "form.imageField": "Nombre del campo",
        "form.autoDetect": "Detección automática",
        "form.detecting": "Detectando…",
        "form.detectNeedsModels": "Añade primero un modelo",
        "form.bulkConfigure": "Configurar todo",
        "form.bulkConfiguring": "Configurando…",
        "form.bulkConfigDone": "Se configuraron {count} modelos — {unmatched} sin regla correspondiente",
        "form.bulkConfigNone": "Ningún modelo coincidió con una regla — se envía en modo compatible con OpenAI",
        "form.bulkConfigSkipped": "Todas las claves están bloqueadas — la configuración no escribió nada",
        "errors.detectRule": "Falló la detección de reglas",
      },
      "fr": {
        "nav": "Modèles d'image",
        "section.title": "Modèles d'image",
        "section.intro": "Ajoutez une clé d'API cloud ou connectez un service d'images sur cet ordinateur ou votre réseau local.",
        "section.unnamedProvider": "Fournisseur sans nom",
        "tag.local": "Local",
        "tag.custom": "Personnalisé",
        "status.ready": "Prêt",
        "status.missingLocal": "URL d'API ou modèle manquant",
        "status.missingCloud": "URL d'API, clé ou modèle manquant",
        "status.missingConfig": "Non configuré",
        "action.edit": "Modifier",
        "action.delete": "Supprimer",
        "action.addProvider": "Ajouter un fournisseur",
        "form.displayName": "Nom affiché",
        "form.baseUrl": "URL de l'API",
        "form.protocol": "Protocole d'API",
        "form.protocolAuto": "Détection automatique",
        "form.protocolRoutes": "Adresses du protocole",
        "form.route.generate": "Texte vers image",
        "form.route.edit": "Image vers image",
        "form.route.models": "Lister les modèles",
        "form.routeUnsupported": "Non pris en charge",
        "form.customProtocol": "Personnalisé (saisir les URL)",
        "form.hostModel": "Modèle hôte",
        "form.hostModelHint": "L'API Responses nécessite un modèle principal capable d'appeler l'outil d'image.",
        "form.apiKey": "Clé d'API",
        "form.keyLocalOptional": "Facultatif pour un service local sans authentification",
        "form.keyEnter": "Saisissez la clé d'API",
        "form.keyEnvSaved": "Utilisation de la clé enregistrée dans l'environnement",
        "form.keySaved": "Laissez vide pour utiliser les identifiants enregistrés",
        "form.modelDirectory": "Catalogue de modèles",
        "form.modelDirectoryCustom": "Catalogue de modèles personnalisé",
        "form.modelDirectoryDefault": "Utilisation des modèles par défaut de l'adaptateur",
        "form.fetchNeedsBaseUrl": "Saisissez d'abord l'URL de l'API",
        "form.fetching": "Récupération…",
        "form.fetchModels": "Récupérer les modèles disponibles",
        "form.modelId": "ID du modèle",
        "form.reorderModel": "Réorganiser le modèle",
        "form.reorderModelHelp": "Faites glisser pour réorganiser ou utilisez les touches fléchées haut et bas.",
        "form.deleteModel": "Supprimer le modèle",
        "form.modelOptions": "Options du modèle",
        "form.modelOptionsHint": "Remplace le workflow ComfyUI de ce modèle. Laissez vide pour utiliser le workflow intégré choisi selon le type de modèle.",
        "form.modelOptionsUnsupported": "Les workflows personnalisés ne sont disponibles qu’avec le déploiement ComfyUI",
        "form.modelWorkflow": "Workflow personnalisé (format API ComfyUI)",
        "form.modelWorkflowPlaceholder": "Dans ComfyUI, utilisez Exporter (API) puis collez le JSON ici",
        "form.modelWorkflowHelp": "Variables : {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (remplacé par l'image de référence envoyée lors de l'édition)",
        "form.modelOptionsDone": "Terminé",
        "form.modelWorkflowSample": "Insérer un modèle d’exemple",
        "form.modelEmpty": "Le sélecteur de modèles sera vide. Ajoutez d'abord au moins un ID de modèle au catalogue.",
        "form.addModel": "Ajouter un modèle",
        "form.advanced": "Paramètres avancés",
        "form.addMode": "Mode d'ajout",
        "form.modeCatalog": "Fournisseur de modèles",
        "form.modeCustom": "API personnalisée",
        "form.modeLocal": "Modèle local",
        "form.modeCatalogHint": "Choisissez une plateforme officielle ou majeure dans la liste intégrée (OpenAI, Volcengine Ark, Alibaba Cloud Bailian, etc.), puis ajoutez sa clé d'API.",
        "form.modeCustomHint": "Connectez un service auto-hébergé ou tout autre point de terminaison compatible OpenAI Images.",
        "form.modeLocalHint": "Connectez un service d'images sur cet ordinateur ou votre réseau local. Un service local sans authentification peut laisser la clé d'API vide.",
        "form.provider": "Fournisseur",
        "form.providerWebsite": "Site du fournisseur",
        "form.localDeployer": "Déploiement local",
        "form.localPresetsMissing": "L'hôte n'a pas fourni la liste des déploiements locaux. Rechargez la page et réessayez.",
        "form.save": "Enregistrer",
        "form.cancel": "Annuler",
        "picker.title": "Choisir les modèles",
        "picker.close": "Fermer",
        "picker.description": "Voici les modèles disponibles chez ce fournisseur. Les modèles cochés constituent la liste.",
        "picker.search": "Rechercher des modèles",
        "picker.selectAll": "Tout sélectionner",
        "picker.deselectAll": "Tout désélectionner",
        "picker.showAll": "Afficher tous les modèles",
        "picker.filtered": "Modèles probablement non génératifs écartés : {count}",
        "picker.noMatches": "Aucun modèle correspondant",
        "picker.adopt": "Mettre à jour la liste",
        "picker.keepOne": "Gardez au moins un modèle coché.",
        "seat.noMatches": "Aucun modèle correspondant",
        "seat.empty": "Aucun modèle pour l'instant. Ajoutez-en un dans Paramètres → Modèles d'image.",
        "seat.auto": "Automatique",
        "seat.fallback": "Modèle d'image",
        "seat.menuModel": "Modèle",
        "seat.menuQuality": "Qualité",
        "seat.menuSize": "Taille",
        "seat.menuPromptOptimization": "Optimisation du prompt",
        "seat.promptOptimizationUsage": "Consomme plus de quota",
        "seat.notSelected": "Non sélectionné",
        "seat.on": "Activé",
        "seat.off": "Désactivé",
        "seat.sizeAutoValue": "Auto",
        "seat.sizeAutoHint": "Laissez le modèle choisir la taille",
        "seat.sizeAutoAria": "Taille automatique",
        "seat.width": "Largeur",
        "seat.height": "Hauteur",
        "seat.searchAria": "Rechercher des modèles d'image",
        "seat.searchPlaceholder": "Rechercher des modèles",
        "seat.clearSearch": "Effacer la recherche",
        "seat.menuAria": "Modèles d'image",
        "seat.choose": "Choisir un modèle d'image",
        "seat.triggerAria": "Modèle d'image : {model}",
        "seat.triggerAriaQuality": "Modèle d'image : {model}, qualité {quality}",
        "seat.settingsAria": "Paramètres d'image",
        "seat.moreSettings": "Autres réglages",
        "seat.qualityUnsupported": "Ce modèle n'expose pas de niveaux de qualité",
        "seat.qualityWarning": "Consomme le quota plus vite",
        "seat.levelsCount": "{count} niveaux",
        "seat.levelsNone": "Non pris en charge",
        "seat.sizeTitle": "Taille",
        "seat.back": "Retour",
        "seat.modelAutoHint": "Laissez le modèle choisir",
        "errors.loadConfig": "Impossible de charger les paramètres d'image : HTTP {status}",
        "errors.loadConfigDetail": "Impossible de charger les paramètres d'image : {message}",
        "errors.saveConfig": "Impossible d'enregistrer les paramètres d'image : HTTP {status}",
        "errors.saveConfigDetail": "Impossible d'enregistrer les paramètres d'image : {message}",
        "errors.saveFailed": "Impossible d'enregistrer les paramètres d'image",
        "errors.fetchModels": "Impossible de récupérer la liste des modèles : HTTP {status}",
        "errors.fetchModelsDetail": "Impossible de récupérer la liste des modèles : {message}",
        "errors.noModels": "Le service n'a renvoyé aucun modèle. Saisissez un ID de modèle manuellement.",
        "errors.localUnreachable": "Impossible de joindre le service local du plugin. Vérifiez que l'hôte DSH est en cours d'exécution.",
        "errors.localTimeout": "Le service local a expiré. Réessayez.",
        "serverError.network.format": "Échec de la requête réseau vers {host} : {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "connexion directe",
        "serverError.network.viaIndirect": "via la configuration réseau du système",
        "serverError.network.hint.timeout": "Délai de connexion TCP dépassé.",
        "serverError.network.hint.dns": "Échec de la résolution DNS. Vérifiez le domaine ou votre DNS.",
        "serverError.network.hint.connection": "Connexion refusée ou réinitialisée. Le port est peut-être fermé, ou le service a coupé la connexion.",
        "serverError.network.hint.tls": "La vérification du certificat TLS a échoué. Il est peut-être expiré ou auto-signé.",
        "serverError.network.timeout": "La requête vers {host} a expiré.",
        "serverError.network.routeInvalid": "La configuration de connexion réseau n'est pas valide. Vérifiez les paramètres réseau de l'hôte ou du système.",
        "serverError.upstream.http": "Le service d'images a renvoyé HTTP {status} : {detail}",
        "serverError.upstream.httpNoDetail": "Le service d'images a renvoyé HTTP {status}.",
        "serverError.upstream.invalidJson": "Le service d'images a renvoyé une réponse non JSON.",
        "serverError.upstream.invalidResponse": "La réponse de {service} ne contient pas {field}.",
        "serverError.upstream.tooLarge": "La réponse du service d'images dépasse la limite de taille.",
        "serverError.provider.notFound": "Le fournisseur d'images sélectionné est introuvable.",
        "serverError.provider.missingBaseUrl": "Saisissez d'abord l'URL de l'API.",
        "serverError.provider.missingKey": "Le fournisseur d'images « {provider} » n'a pas de clé d'API.",
        "serverError.provider.missingKeyWithRef": "Le fournisseur d'images « {provider} » n'a pas de clé d'API (identifiant {ref}).",
        "serverError.models.unsupported": "Ce fournisseur n'expose pas de liste de modèles.",
        "serverError.models.notFound": "Cette adresse n'a pas d'endpoint de liste de modèles (HTTP 404). Saisissez l'ID du modèle manuellement.",
        "serverError.adapter.unknownProtocol": "Protocole d'image non pris en charge : {protocol}. Disponibles : {available}.",
        "serverError.adapter.notFound": "Adaptateur d'images introuvable : {adapter}. Disponibles : {available}.",
        "serverError.config.credentialsUnavailable": "Le service d'identifiants n'est pas disponible ; la clé d'API ne peut pas être stockée en toute sécurité.",
        "serverError.config.credentialSaveFailed": "Impossible d'enregistrer la clé d'API : {message}",
        "serverError.config.legacyKeyMigrationFailed": "Impossible de migrer l'ancienne clé d'API : {message}",
        "serverError.config.writeFailed": "Impossible d'enregistrer les paramètres d'image : {message}",
        "serverError.request.methodNotAllowed": "Cette méthode de requête n'est pas autorisée.",
        "serverError.request.bodyTooLarge": "Le corps de la requête est trop volumineux.",
        "serverError.request.invalidJson": "Le corps de la requête n'est pas un JSON valide.",
        "quality.off": "Désactivée",
        "quality.low": "Basse",
        "quality.medium": "Moyenne",
        "quality.high": "Haute",
        "quality.xhigh": "Très haute",
        "quality.max": "Maximale",
        "quality.auto": "Automatique",
        "quality.standard": "Standard",
        "quality.hd": "HD",
        "quality.default": "Par défaut",
        "quality.quality": "Haute qualité",
        "quality.turbo": "Turbo",
        "localPreset.sd-server.urlHint": "Indiquez uniquement l'URL racine du service, en conservant /v1 à la fin. Le plugin ajoute /images/generations et /models.",
        "localPreset.sd-server.hint": "API OpenAI Images native, compatible avec la génération et l'édition via /images/edits. Le modèle est généralement sd-cpp-local et peut être listé depuis /v1/models.",
        "localPreset.localai.urlHint": "Indiquez uniquement l'URL racine du service, en conservant /v1 à la fin. Le plugin ajoute /images/generations et /models.",
        "localPreset.localai.hint": "Compatible OpenAI Images pour la génération ; utilisez le name du YAML de modèles LocalAI, listable depuis /v1/models. LocalAI n'a pas /images/edits : pour l'édition, passez par une passerelle compatible OpenAI.",
        "localPreset.a1111.urlHint": "Indiquez uniquement l'URL racine du service, sans /sdapi/v1. Le plugin ajoute /sdapi/v1/txt2img, /img2img et /sd-models.",
        "localPreset.a1111.hint": "Utilise /sdapi/v1/txt2img et /sdapi/v1/img2img ; la liste des modèles provient de /sdapi/v1/sd-models. Lancez A1111 avec --api.",
        "localPreset.comfyui.urlHint": "Indiquez uniquement l'URL racine du service, sans /prompt. Le plugin ajoute /prompt, /upload/image, /history et /view.",
        "localPreset.comfyui.hint": "Les workflows intégrés couvrent SD/SDXL, FLUX.2 et MOSS-Image, en génération comme en édition avec image de référence. Pour d'autres architectures (Qwen-Image, Z-Image…), collez votre propre workflow ComfyUI dans « Options du modèle » ou utilisez une passerelle compatible OpenAI.",
        "localPreset.swarmui.urlHint": "Indiquez uniquement l'URL racine du service, sans /API. Le plugin ajoute /API/GetNewSession, /API/ListModels et /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Utilise /API/GenerateText2Image ; la liste des modèles provient de /API/ListModels. La génération fonctionne ; l'édition native n'est pas encore prise en charge.",
        "localPreset.openai-gateway.urlHint": "Indiquez l'URL racine de l'API OpenAI (généralement avec /v1). Le plugin ajoute /images/generations et /models.",
        "localPreset.openai-gateway.hint": "Choisissez cette option pour InvokeAI, Fooocus, les workflows ComfyUI complexes ou un service auto-hébergé exposant /v1/images/generations.",
        "update.available": "Mise à jour disponible",
        "update.title": "Mise à jour disponible",
        "update.version": "{from} → {to}",
        "update.cancel": "Annuler",
        "update.apply": "Mettre à jour",
        "update.close": "Fermer",
        "update.starting": "Mise à jour de dsh-mo-image…",
        "update.doneRestart": "Mise à jour installée — redémarrez DSH pour l'appliquer",
        "update.done": "Mis à jour vers {version}",
        "update.failed": "La mise à jour ne s'est pas terminée — réessayez",
        "update.failedRestored": "La mise à jour a échoué ; la version précédente a été restaurée",
        "update.failedBroken": "La mise à jour a échoué et la version précédente n'a pas été restaurée ; réinstallez le greffon depuis la gestion des plugins",
        "update.unsupported": "Cet environnement ne permet pas la mise à jour automatique ; exécutez {command}",
        "update.localDev": "Installation de développement local — lancez git pull",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "Voir sur npm",
        "update.noNotes": "Cette version n'a pas de notes.",
        "form.modelMappingParse": "Analyser le workflow",
        "form.modelMappingParsing": "Analyse…",
        "form.modelMappingFailed": "Analyse impossible",
        "form.modelMappingSkip": "Ne pas injecter",
        "form.modelMappingFormatApi": "Format API",
        "form.modelMappingFormatUi": "Format UI",
        "form.modelMappingSampler": "Sampler",
        "form.modelMappingWidth": "Largeur",
        "form.modelMappingHeight": "Hauteur",
        "form.modelMappingSeed": "Graine",
        "form.modelMappingModel": "Modèle",
        "form.modelMappingImage": "Image de référence",
        "form.modelMappingColName": "Paramètre",
        "form.modelMappingColTarget": "Correspondance",
        "form.modelMappingColExpose": "Exposé",
        "form.modelAutoInjectHint": "Les prompts positif et négatif viennent de l'appel d'outil : rien à configurer ici.",
        "param.steps": "Étapes",
        "param.cfg": "Intensité du prompt",
        "param.sampler_name": "Échantillonneur",
        "param.scheduler": "Planificateur",
        "param.denoise": "Redessin",
        "param.batch_size": "Taille du lot",
        "param.guidance": "Intensité du guidage",
        "param.cfg.desc": "Force avec laquelle le prompt contraint l’image ; trop élevé fige, trop bas dérive",
        "param.sampler_name.desc": "Algorithme d’échantillonnage qui décide de la convergence et de la texture",
        "param.scheduler.desc": "Courbe de bruit ; avec l’échantillonneur, règle le rythme de débruitage",
        "param.denoise.desc": "Part de l’image d’origine conservée ; 1 la redessine entièrement",
        "param.batch_size.desc": "Nombre d’images par exécution ; plus grand consomme plus de VRAM",
        "param.guidance.desc": "Échelle de guidage des modèles distillés, généralement proche de 1",
        "form.a1111ParamsHint": "Les paramètres cochés peuvent être remplacés via params ; les autres suivent les réglages du WebUI",
        "form.a1111ColType": "Type",
        "seat.sizeAspect": "Ratio",
        "seat.sizeTier": "Palier",
        "seat.sizePreset": "Préréglage",
        "seat.sizeCustom": "Personnalisé",
        "seat.sizeStrict": "Strict",
        "seat.sizeStrictHint": "La taille finale est forcée; sans taille demandée cela ne s applique pas",
        "seat.sizePromptHint": "Ce modèle n accepte pas de taille ; elle est écrite dans le prompt",
        "seat.sizeHint.ratioOnly": "La résolution suit le ratio",
        "seat.sizeHint.fixedPixels": "La résolution est fixe : core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "Ce modèle n accepte pas de taille",
        "seat.sizeHint.modelDecides": "Sans taille, le modèle choisit",
        "form.sizeParamsHint": "C'est l'adaptateur qui décide comment ce modèle reçoit sa taille ; surchargez-le ici, laissez vide pour garder la valeur par défaut.",
        "form.sizeMode": "Encodage",
        "form.sizeModeDefault": "Suivre la valeur par défaut",
        "form.sizeModeWhString": "size = LxH",
        "form.sizeModeWhFields": "champs width + height",
        "form.sizeModeAspect": "Format d'image",
        "form.sizeModeTier": "Nom de palier",
        "form.sizeModePrompt": "Ajouter au prompt",
        "form.sizeField": "Nom du paramètre",
        "form.sizeFieldHint": "Vide pour la valeur par défaut ; les chemins a.b.c sont acceptés.",
        "form.sizeSeparator": "Séparateur",
        "form.sizeSeparatorCustom": "Personnalisé",
        "form.sizeSecond": "Second champ",
        "form.sizeSecondHint": "Facultatif : envoyer le format ou le palier dans un autre champ ; vide pour ne rien envoyer.",
        "form.sizeFieldWidth": "Nom du paramètre : largeur",
        "form.sizeFieldHeight": "Nom du paramètre : hauteur",
        "form.sizeFieldAspect": "Nom du paramètre : ratio",
        "form.sizeFieldResolution": "Nom du paramètre : résolution",
        "seat.sizeAutoHelp": "Activé, le modèle adapte la taille d'après la demande de l'utilisateur.",
        "seat.sizeStrictHelp": "Force la taille configurée (l'original est conservé).",
        "form.paramSize": "Taille",
        "form.paramQuality": "Qualité",
        "form.paramPrompt": "Prompt",
        "form.paramNegative": "Prompt négatif",
        "form.paramModel": "Modèle",
        "form.paramN": "Nombre",
        "form.paramImage": "Image de référence",
        "form.paramLock": "Verrouiller cette clé",
        "form.lockOn": "Verrouillé : la configuration et la détection l'ignorent",
        "form.lockOff": "Déverrouillé : la configuration peut l'écraser",
        "form.unlockAll": "Tout déverrouiller",
        "form.advancedParams": "Avancé (noms de champs)",
        "form.paramsCommon": "Général",
        "form.paramsHint": "Les clés verrouillées ne sont jamais modifiées ; déverrouillez-en une pour la saisir à la main.",
        "form.imageAs": "Encodage",
        "form.imageField": "Nom du champ",
        "form.autoDetect": "Détection automatique",
        "form.detecting": "Détection…",
        "form.detectNeedsModels": "Ajoutez d'abord un modèle",
        "form.bulkConfigure": "Tout configurer",
        "form.bulkConfiguring": "Configuration…",
        "form.bulkConfigDone": "{count} modèles configurés — {unmatched} sans règle correspondante",
        "form.bulkConfigNone": "Aucun modèle ne correspond à une règle — envoi compatible OpenAI",
        "form.bulkConfigSkipped": "Toutes les clés sont verrouillées — la configuration n'a rien écrit",
        "errors.detectRule": "Échec de la détection des règles",
      },
      "de": {
        "nav": "Bildmodelle",
        "section.title": "Bildmodelle",
        "section.intro": "Fügen Sie einen Cloud-API-Schlüssel hinzu oder verbinden Sie einen Bilddienst auf diesem Rechner oder im lokalen Netzwerk.",
        "section.unnamedProvider": "Unbenannter Anbieter",
        "tag.local": "Lokal",
        "tag.custom": "Benutzerdefiniert",
        "status.ready": "Bereit",
        "status.missingLocal": "API-URL oder Modell fehlt",
        "status.missingCloud": "API-URL, Schlüssel oder Modell fehlt",
        "status.missingConfig": "Nicht konfiguriert",
        "action.edit": "Bearbeiten",
        "action.delete": "Löschen",
        "action.addProvider": "Anbieter hinzufügen",
        "form.displayName": "Anzeigename",
        "form.baseUrl": "API-URL",
        "form.protocol": "API-Protokoll",
        "form.protocolAuto": "Automatisch erkennen",
        "form.protocolRoutes": "Protokoll-Endpunkte",
        "form.route.generate": "Text zu Bild",
        "form.route.edit": "Bild zu Bild",
        "form.route.models": "Modelle laden",
        "form.routeUnsupported": "Nicht unterstützt",
        "form.customProtocol": "Benutzerdefiniert (URLs eingeben)",
        "form.hostModel": "Host-Modell",
        "form.hostModelHint": "Die Responses-API benötigt ein Hauptmodell, das das Bildwerkzeug aufrufen kann.",
        "form.apiKey": "API-Schlüssel",
        "form.keyLocalOptional": "Optional für lokale Dienste ohne Authentifizierung",
        "form.keyEnter": "API-Schlüssel eingeben",
        "form.keyEnvSaved": "Gespeicherter Schlüssel aus der Umgebung wird verwendet",
        "form.keySaved": "Leer lassen, um die gespeicherten Anmeldedaten zu verwenden",
        "form.modelDirectory": "Modellkatalog",
        "form.modelDirectoryCustom": "Benutzerdefinierter Modellkatalog",
        "form.modelDirectoryDefault": "Standardmodelle des Adapters werden verwendet",
        "form.fetchNeedsBaseUrl": "Zuerst die API-URL eingeben",
        "form.fetching": "Wird abgerufen…",
        "form.fetchModels": "Verfügbare Modelle abrufen",
        "form.modelId": "Modell-ID",
        "form.reorderModel": "Modell neu anordnen",
        "form.reorderModelHelp": "Ziehen Sie, um die Reihenfolge neu anzuordnen, oder verwenden Sie die Aufwärts- und Abwärtspfeiltasten.",
        "form.deleteModel": "Modell entfernen",
        "form.modelOptions": "Modelloptionen",
        "form.modelOptionsHint": "Überschreibt den ComfyUI-Workflow für dieses Modell. Leer lassen, um den eingebauten Workflow passend zum Modelltyp zu nutzen.",
        "form.modelOptionsUnsupported": "Eigene Workflows gibt es nur bei der ComfyUI-Bereitstellung",
        "form.modelWorkflow": "Eigener Workflow (ComfyUI-API-Format)",
        "form.modelWorkflowPlaceholder": "In ComfyUI „Exportieren (API)\" nutzen und das JSON hier einfügen",
        "form.modelWorkflowHelp": "Platzhalter: {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (wird beim Bearbeiten durch das hochgeladene Referenzbild ersetzt)",
        "form.modelOptionsDone": "Fertig",
        "form.modelWorkflowSample": "Beispiel einfügen",
        "form.modelEmpty": "Die Modellauswahl bleibt leer. Fügen Sie zuerst mindestens eine Modell-ID zum Katalog hinzu.",
        "form.addModel": "Modell hinzufügen",
        "form.advanced": "Erweiterte Einstellungen",
        "form.addMode": "Hinzufügen über",
        "form.modeCatalog": "Modellanbieter",
        "form.modeCustom": "Benutzerdefinierte API",
        "form.modeLocal": "Lokales Modell",
        "form.modeCatalogHint": "Wählen Sie eine offizielle oder große Plattform aus der integrierten Liste (OpenAI, Volcengine Ark, Alibaba Cloud Bailian und weitere) und geben Sie den API-Schlüssel ein.",
        "form.modeCustomHint": "Verbinden Sie einen selbst gehosteten Dienst oder einen anderen OpenAI-Images-kompatiblen Endpunkt.",
        "form.modeLocalHint": "Verbinden Sie einen Bilddienst auf diesem Rechner oder im lokalen Netzwerk. Lokale Dienste ohne Authentifizierung können den API-Schlüssel leer lassen.",
        "form.provider": "Anbieter",
        "form.providerWebsite": "Anbieterseite",
        "form.localDeployer": "Lokale Bereitstellung",
        "form.localPresetsMissing": "Der Host hat die Liste lokaler Bereitstellungen nicht bereitgestellt. Laden Sie die Seite neu und versuchen Sie es erneut.",
        "form.save": "Speichern",
        "form.cancel": "Abbrechen",
        "picker.title": "Modelle auswählen",
        "picker.close": "Schließen",
        "picker.description": "Dies sind die vom Anbieter verfügbaren Modelle. Angehakte Modelle bilden die Liste.",
        "picker.search": "Modelle suchen",
        "picker.selectAll": "Alle auswählen",
        "picker.deselectAll": "Auswahl aufheben",
        "picker.showAll": "Alle Modelle anzeigen",
        "picker.filtered": "Als wahrscheinlich nicht bildgenerierend gefiltert: {count}",
        "picker.noMatches": "Keine passenden Modelle",
        "picker.adopt": "Liste aktualisieren",
        "picker.keepOne": "Mindestens ein Modell muss angehakt bleiben.",
        "seat.noMatches": "Keine passenden Modelle",
        "seat.empty": "Noch keine Modelle. Fügen Sie eines unter Einstellungen → Bildmodelle hinzu.",
        "seat.auto": "Automatisch",
        "seat.fallback": "Bildmodell",
        "seat.menuModel": "Modell",
        "seat.menuQuality": "Qualität",
        "seat.menuSize": "Größe",
        "seat.menuPromptOptimization": "Prompt-Optimierung",
        "seat.promptOptimizationUsage": "Verbraucht mehr Kontingent",
        "seat.notSelected": "Nicht ausgewählt",
        "seat.on": "Ein",
        "seat.off": "Aus",
        "seat.sizeAutoValue": "Auto",
        "seat.sizeAutoHint": "Größe dem Modell überlassen",
        "seat.sizeAutoAria": "Automatische Größe",
        "seat.width": "Breite",
        "seat.height": "Höhe",
        "seat.searchAria": "Bildmodelle suchen",
        "seat.searchPlaceholder": "Modelle suchen",
        "seat.clearSearch": "Suche löschen",
        "seat.menuAria": "Bildmodelle",
        "seat.choose": "Bildmodell auswählen",
        "seat.triggerAria": "Bildmodell: {model}",
        "seat.triggerAriaQuality": "Bildmodell: {model}, Qualität {quality}",
        "seat.settingsAria": "Bildeinstellungen",
        "seat.moreSettings": "Weitere Einstellungen",
        "seat.qualityUnsupported": "Dieses Modell bietet keine Qualitätsstufen",
        "seat.qualityWarning": "Verbraucht das Kontingent schneller",
        "seat.levelsCount": "{count} Stufen",
        "seat.levelsNone": "Nicht unterstützt",
        "seat.sizeTitle": "Größe",
        "seat.back": "Zurück",
        "seat.modelAutoHint": "Das Modell wählen lassen",
        "errors.loadConfig": "Bildeinstellungen konnten nicht geladen werden: HTTP {status}",
        "errors.loadConfigDetail": "Bildeinstellungen konnten nicht geladen werden: {message}",
        "errors.saveConfig": "Bildeinstellungen konnten nicht gespeichert werden: HTTP {status}",
        "errors.saveConfigDetail": "Bildeinstellungen konnten nicht gespeichert werden: {message}",
        "errors.saveFailed": "Bildeinstellungen konnten nicht gespeichert werden",
        "errors.fetchModels": "Modellliste konnte nicht abgerufen werden: HTTP {status}",
        "errors.fetchModelsDetail": "Modellliste konnte nicht abgerufen werden: {message}",
        "errors.noModels": "Der Dienst hat keine Modelle zurückgegeben. Geben Sie eine Modell-ID manuell ein.",
        "errors.localUnreachable": "Der lokale Dienst des Plugins ist nicht erreichbar. Prüfen Sie, ob der DSH-Host läuft.",
        "errors.localTimeout": "Der lokale Dienst hat nicht rechtzeitig geantwortet. Versuchen Sie es erneut.",
        "serverError.network.format": "Netzwerkanfrage an {host} fehlgeschlagen: {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "direkt",
        "serverError.network.viaIndirect": "über die Systemnetzwerkkonfiguration",
        "serverError.network.hint.timeout": "TCP-Verbindungs-Timeout.",
        "serverError.network.hint.dns": "DNS-Auflösung fehlgeschlagen. Prüfen Sie die Domain oder Ihr DNS.",
        "serverError.network.hint.connection": "Verbindung abgelehnt oder zurückgesetzt. Der Port ist möglicherweise geschlossen oder der Dienst hat die Verbindung getrennt.",
        "serverError.network.hint.tls": "Die TLS-Zertifikatsprüfung ist fehlgeschlagen. Das Zertifikat ist möglicherweise abgelaufen oder selbstsigniert.",
        "serverError.network.timeout": "Zeitüberschreitung bei der Anfrage an {host}.",
        "serverError.network.routeInvalid": "Die Netzwerkverbindungskonfiguration ist ungültig. Prüfen Sie die Netzwerkeinstellungen des Hosts oder Systems.",
        "serverError.upstream.http": "Der Bilddienst hat HTTP {status} zurückgegeben: {detail}",
        "serverError.upstream.httpNoDetail": "Der Bilddienst hat HTTP {status} zurückgegeben.",
        "serverError.upstream.invalidJson": "Der Bilddienst hat eine Antwort zurückgegeben, die kein JSON ist.",
        "serverError.upstream.invalidResponse": "In der {service}-Antwort fehlt {field}.",
        "serverError.upstream.tooLarge": "Die Antwort des Bilddienstes überschreitet das Größenlimit.",
        "serverError.provider.notFound": "Der ausgewählte Bildanbieter wurde nicht gefunden.",
        "serverError.provider.missingBaseUrl": "Geben Sie zuerst die API-URL ein.",
        "serverError.provider.missingKey": "Der Bildanbieter „{provider}“ hat keinen API-Schlüssel.",
        "serverError.provider.missingKeyWithRef": "Der Bildanbieter „{provider}“ hat keinen API-Schlüssel (Anmeldedaten {ref}).",
        "serverError.models.unsupported": "Dieser Anbieter stellt keine Modellliste bereit.",
        "serverError.models.notFound": "Diese Adresse hat keinen Modelllisten-Endpunkt (HTTP 404). Geben Sie die Modell-ID manuell ein.",
        "serverError.adapter.unknownProtocol": "Nicht unterstütztes Bildprotokoll: {protocol}. Verfügbar: {available}.",
        "serverError.adapter.notFound": "Bildadapter nicht gefunden: {adapter}. Verfügbar: {available}.",
        "serverError.config.credentialsUnavailable": "Der Anmeldedatendienst ist nicht verfügbar; der API-Schlüssel kann nicht sicher gespeichert werden.",
        "serverError.config.credentialSaveFailed": "Der API-Schlüssel konnte nicht gespeichert werden: {message}",
        "serverError.config.legacyKeyMigrationFailed": "Der alte API-Schlüssel konnte nicht migriert werden: {message}",
        "serverError.config.writeFailed": "Bildeinstellungen konnten nicht gespeichert werden: {message}",
        "serverError.request.methodNotAllowed": "Diese Anforderungsmethode ist nicht zulässig.",
        "serverError.request.bodyTooLarge": "Der Anfragetext ist zu groß.",
        "serverError.request.invalidJson": "Der Anfragetext ist kein gültiges JSON.",
        "quality.off": "Aus",
        "quality.low": "Niedrig",
        "quality.medium": "Mittel",
        "quality.high": "Hoch",
        "quality.xhigh": "Sehr hoch",
        "quality.max": "Maximal",
        "quality.auto": "Automatisch",
        "quality.standard": "Standard",
        "quality.hd": "HD",
        "quality.default": "Standard",
        "quality.quality": "Hohe Qualität",
        "quality.turbo": "Turbo",
        "localPreset.sd-server.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein und behalten Sie das abschließende /v1 bei. Das Plugin ergänzt /images/generations und /models.",
        "localPreset.sd-server.hint": "Native OpenAI-Images-API mit Unterstützung für Generierung und Bearbeitung über /images/edits. Das Modell heißt meist sd-cpp-local und lässt sich über /v1/models auflisten.",
        "localPreset.localai.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein und behalten Sie das abschließende /v1 bei. Das Plugin ergänzt /images/generations und /models.",
        "localPreset.localai.hint": "OpenAI-Images-kompatibel für die Generierung; verwenden Sie den name aus der LocalAI-Modell-YAML, abrufbar über /v1/models. LocalAI hat kein /images/edits – nutzen Sie für Bildbearbeitung ein OpenAI-kompatibles Gateway.",
        "localPreset.a1111.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein, ohne /sdapi/v1. Das Plugin ergänzt /sdapi/v1/txt2img, /img2img und /sd-models.",
        "localPreset.a1111.hint": "Nutzt /sdapi/v1/txt2img und /sdapi/v1/img2img; die Modellliste stammt aus /sdapi/v1/sd-models. Starten Sie A1111 mit --api.",
        "localPreset.comfyui.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein, ohne /prompt. Das Plugin ergänzt /prompt, /upload/image, /history und /view.",
        "localPreset.comfyui.hint": "Eingebaute Workflows decken SD/SDXL, FLUX.2 und MOSS-Image ab – für Generierung und Bearbeitung mit Referenzbild. Für andere Architekturen (Qwen-Image, Z-Image …) den eigenen ComfyUI-Workflow unter „Modelloptionen\" einfügen oder ein OpenAI-kompatibles Gateway nutzen.",
        "localPreset.swarmui.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein, ohne /API. Das Plugin ergänzt /API/GetNewSession, /API/ListModels und /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Nutzt /API/GenerateText2Image; die Modellliste stammt aus /API/ListModels. Die Generierung funktioniert; native Bearbeitung wird noch nicht unterstützt.",
        "localPreset.openai-gateway.urlHint": "Geben Sie die Stamm-URL der OpenAI-API ein (meist mit /v1). Das Plugin ergänzt /images/generations und /models.",
        "localPreset.openai-gateway.hint": "Wählen Sie dies für InvokeAI, Fooocus, komplexe ComfyUI-Workflows oder einen selbst gehosteten Dienst, der /v1/images/generations bereitstellt.",
        "update.available": "Update verfügbar",
        "update.title": "Update verfügbar",
        "update.version": "{from} → {to}",
        "update.cancel": "Abbrechen",
        "update.apply": "Aktualisieren",
        "update.close": "Schließen",
        "update.starting": "dsh-mo-image wird aktualisiert…",
        "update.doneRestart": "Update installiert – DSH neu starten, um es anzuwenden",
        "update.done": "Auf {version} aktualisiert",
        "update.failed": "Das Update wurde nicht abgeschlossen – bitte erneut versuchen",
        "update.failedRestored": "Das Update ist fehlgeschlagen – die vorherige Version wurde wiederhergestellt",
        "update.failedBroken": "Das Update ist fehlgeschlagen und die vorherige Version wurde nicht wiederhergestellt – installieren Sie das Plugin über die Plugin-Verwaltung neu",
        "update.unsupported": "Diese Umgebung kann sich nicht selbst aktualisieren; führen Sie {command} aus",
        "update.localDev": "Lokale Entwicklungsinstallation – bitte selbst git pull ausführen",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "Auf npm ansehen",
        "update.noNotes": "Diese Version hat keine Hinweise.",
        "form.modelMappingParse": "Workflow analysieren",
        "form.modelMappingParsing": "Analysiere…",
        "form.modelMappingFailed": "Analyse fehlgeschlagen",
        "form.modelMappingSkip": "Nicht einsetzen",
        "form.modelMappingFormatApi": "API-Format",
        "form.modelMappingFormatUi": "UI-Format",
        "form.modelMappingSampler": "Sampler",
        "form.modelMappingWidth": "Breite",
        "form.modelMappingHeight": "Höhe",
        "form.modelMappingSeed": "Seed",
        "form.modelMappingModel": "Modell",
        "form.modelMappingImage": "Referenzbild",
        "form.modelMappingColName": "Parameter",
        "form.modelMappingColTarget": "Zuordnung",
        "form.modelMappingColExpose": "Freigeben",
        "form.modelAutoInjectHint": "Prompt und Negativ-Prompt kommen direkt aus dem Werkzeugaufruf, hier ist nichts einzustellen.",
        "param.steps": "Schritte",
        "param.cfg": "Prompt-Stärke",
        "param.sampler_name": "Sampler",
        "param.scheduler": "Scheduler",
        "param.denoise": "Neuzeichnen",
        "param.batch_size": "Stapelgröße",
        "param.guidance": "Führungsstärke",
        "param.cfg.desc": "Wie stark der Prompt das Bild bestimmt; zu hoch wirkt starr, zu niedrig schweift ab",
        "param.sampler_name.desc": "Sampling-Algorithmus, der Konvergenz und Textur bestimmt",
        "param.scheduler.desc": "Rauschplan; legt mit dem Sampler den Entrauschungsrhythmus fest",
        "param.denoise.desc": "Wie viel vom Ausgangsbild erhalten bleibt; 1 zeichnet komplett neu",
        "param.batch_size.desc": "Bilder pro Lauf; größere Werte brauchen mehr VRAM",
        "param.guidance.desc": "Führungsskala für distillierte Modelle, meist nahe 1",
        "form.a1111ParamsHint": "Angehakte Parameter lassen sich über params überschreiben; die übrigen folgen den WebUI-Einstellungen",
        "form.a1111ColType": "Typ",
        "seat.sizeAspect": "Seitenverhältnis",
        "seat.sizeTier": "Stufe",
        "seat.sizePreset": "Voreinstellung",
        "seat.sizeCustom": "Benutzerdefiniert",
        "seat.sizeStrict": "Strikt",
        "seat.sizeStrictHint": "Die Ausgabegröße wird erzwungen; ohne Größe im Request wirkungslos",
        "seat.sizePromptHint": "Dieses Modell nimmt keine Größe an; sie wird in den Prompt geschrieben",
        "seat.sizeHint.ratioOnly": "Die Auflösung folgt dem Seitenverhältnis",
        "seat.sizeHint.fixedPixels": "Die Auflösung ist fest: core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "Dieses Modell nimmt keine Größe an",
        "seat.sizeHint.modelDecides": "Ohne Größe wählt das Modell",
        "form.sizeParamsHint": "Wie dieses Modell seine Größe erhält, entscheidet der Adapter; hier überschreibbar, leer lassen für den Standard.",
        "form.sizeMode": "Kodierung",
        "form.sizeModeDefault": "Standard folgen",
        "form.sizeModeWhString": "size = BxH",
        "form.sizeModeWhFields": "Felder width + height",
        "form.sizeModeAspect": "Seitenverhältnis",
        "form.sizeModeTier": "Stufenname",
        "form.sizeModePrompt": "An den Prompt anhängen",
        "form.sizeField": "Parametername",
        "form.sizeFieldHint": "Leer lassen für den Standard; Pfade wie a.b.c werden unterstützt.",
        "form.sizeSeparator": "Trennzeichen",
        "form.sizeSeparatorCustom": "Benutzerdefiniert",
        "form.sizeSecond": "Zweites Feld",
        "form.sizeSecondHint": "Optional: Verhältnis oder Stufe in ein weiteres Feld schreiben; leer lassen zum Auslassen.",
        "form.sizeFieldWidth": "Parametername: Breite",
        "form.sizeFieldHeight": "Parametername: Höhe",
        "form.sizeFieldAspect": "Parametername: Verhältnis",
        "form.sizeFieldResolution": "Parametername: Auflösung",
        "seat.sizeAutoHelp": "Aktiviert wählt das Modell die Größe passend zur Anfrage.",
        "seat.sizeStrictHelp": "Erzwingt die eingestellte Größe (das Original bleibt erhalten).",
        "form.paramSize": "Größe",
        "form.paramQuality": "Qualität",
        "form.paramPrompt": "Prompt",
        "form.paramNegative": "Negativ-Prompt",
        "form.paramModel": "Modell",
        "form.paramN": "Anzahl",
        "form.paramImage": "Referenzbild",
        "form.paramLock": "Diesen Schlüssel sperren",
        "form.lockOn": "Gesperrt: Konfiguration und Erkennung überspringen es",
        "form.lockOff": "Entsperrt: Konfiguration darf es überschreiben",
        "form.unlockAll": "Alle entsperren",
        "form.advancedParams": "Erweitert (Feldnamen)",
        "form.paramsCommon": "Allgemein",
        "form.paramsHint": "Gesperrte Schlüssel werden nicht überschrieben; zum Bearbeiten entsperren.",
        "form.imageAs": "Kodierung",
        "form.imageField": "Feldname",
        "form.autoDetect": "Automatisch erkennen",
        "form.detecting": "Wird erkannt…",
        "form.detectNeedsModels": "Zuerst ein Modell hinzufügen",
        "form.bulkConfigure": "Alle konfigurieren",
        "form.bulkConfiguring": "Wird konfiguriert…",
        "form.bulkConfigDone": "{count} Modelle konfiguriert — {unmatched} ohne passende Regel",
        "form.bulkConfigNone": "Kein Modell passt zu einer Regel — Versand OpenAI-kompatibel",
        "form.bulkConfigSkipped": "Alle Schlüssel sind gesperrt — die Konfiguration hat nichts geschrieben",
        "errors.detectRule": "Regelerkennung fehlgeschlagen",
      },
      "ru": {
        "nav": "Модели изображений",
        "section.title": "Модели изображений",
        "section.intro": "Добавьте облачный ключ API или подключите службу изображений на этом компьютере или в локальной сети.",
        "section.unnamedProvider": "Поставщик без названия",
        "tag.local": "Локальный",
        "tag.custom": "Пользовательский",
        "status.ready": "Готово",
        "status.missingLocal": "Не указан URL API или модель",
        "status.missingCloud": "Не указан URL API, ключ или модель",
        "status.missingConfig": "Не настроено",
        "action.edit": "Изменить",
        "action.delete": "Удалить",
        "action.addProvider": "Добавить поставщика",
        "form.displayName": "Отображаемое имя",
        "form.baseUrl": "URL API",
        "form.protocol": "Протокол API",
        "form.protocolAuto": "Автоопределение",
        "form.protocolRoutes": "Адреса протокола",
        "form.route.generate": "Из текста",
        "form.route.edit": "Из изображения",
        "form.route.models": "Список моделей",
        "form.routeUnsupported": "Не поддерживается",
        "form.customProtocol": "Свой (ввести адреса)",
        "form.hostModel": "Ведущая модель",
        "form.hostModelHint": "Responses API требует основную модель, которая может вызывать инструмент изображений.",
        "form.apiKey": "Ключ API",
        "form.keyLocalOptional": "Необязательно для локальных служб без авторизации",
        "form.keyEnter": "Введите ключ API",
        "form.keyEnvSaved": "Используется сохранённый ключ из окружения",
        "form.keySaved": "Оставьте пустым, чтобы использовать сохранённые учётные данные",
        "form.modelDirectory": "Каталог моделей",
        "form.modelDirectoryCustom": "Пользовательский каталог моделей",
        "form.modelDirectoryDefault": "Используются модели адаптера по умолчанию",
        "form.fetchNeedsBaseUrl": "Сначала укажите URL API",
        "form.fetching": "Получение…",
        "form.fetchModels": "Получить доступные модели",
        "form.modelId": "ID модели",
        "form.reorderModel": "Изменить порядок модели",
        "form.reorderModelHelp": "Перетащите, чтобы изменить порядок, или используйте клавиши со стрелками вверх и вниз.",
        "form.deleteModel": "Удалить модель",
        "form.modelOptions": "Параметры модели",
        "form.modelOptionsHint": "Задаёт отдельный workflow ComfyUI для этой модели. Оставьте пустым, чтобы использовать встроенный workflow по типу модели.",
        "form.modelOptionsUnsupported": "Свои workflow доступны только при развёртывании ComfyUI",
        "form.modelWorkflow": "Свой workflow (формат API ComfyUI)",
        "form.modelWorkflowPlaceholder": "В ComfyUI выберите «Экспорт (API)» и вставьте JSON сюда",
        "form.modelWorkflowHelp": "Доступные подстановки: {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (при редактировании подставляется загруженный референс)",
        "form.modelOptionsDone": "Готово",
        "form.modelWorkflowSample": "Вставить пример",
        "form.modelEmpty": "Выбор моделей будет пустым. Сначала добавьте хотя бы один ID модели в каталог.",
        "form.addModel": "Добавить модель",
        "form.advanced": "Дополнительные настройки",
        "form.addMode": "Способ добавления",
        "form.modeCatalog": "Поставщик моделей",
        "form.modeCustom": "Пользовательский API",
        "form.modeLocal": "Локальная модель",
        "form.modeCatalogHint": "Выберите официальную или крупную платформу из встроенного списка (OpenAI, Volcengine Ark, Alibaba Cloud Bailian и другие) и укажите её ключ API.",
        "form.modeCustomHint": "Подключите самостоятельно размещённую службу или другую конечную точку, совместимую с OpenAI Images.",
        "form.modeLocalHint": "Подключите службу изображений на этом компьютере или в локальной сети. Для локальных служб без авторизации ключ API можно оставить пустым.",
        "form.provider": "Поставщик",
        "form.providerWebsite": "Сайт поставщика",
        "form.localDeployer": "Локальное развёртывание",
        "form.localPresetsMissing": "Хост не передал список локальных развёртываний. Обновите страницу и повторите попытку.",
        "form.save": "Сохранить",
        "form.cancel": "Отмена",
        "picker.title": "Выберите модели",
        "picker.close": "Закрыть",
        "picker.description": "Это модели, доступные у поставщика. Отмеченные модели составят список.",
        "picker.search": "Поиск моделей",
        "picker.selectAll": "Выбрать все",
        "picker.deselectAll": "Снять выбор",
        "picker.showAll": "Показать все модели",
        "picker.filtered": "Исключено как вероятно не-изображения: {count}",
        "picker.noMatches": "Подходящих моделей нет",
        "picker.adopt": "Обновить список",
        "picker.keepOne": "Оставьте отмеченной хотя бы одну модель.",
        "seat.noMatches": "Подходящих моделей нет",
        "seat.empty": "Моделей пока нет. Добавьте их в «Настройки → Модели изображений».",
        "seat.auto": "Авто",
        "seat.fallback": "Модель изображений",
        "seat.menuModel": "Модель",
        "seat.menuQuality": "Качество",
        "seat.menuSize": "Размер",
        "seat.menuPromptOptimization": "Оптимизация промпта",
        "seat.promptOptimizationUsage": "Расходует больше квоты",
        "seat.notSelected": "Не выбрано",
        "seat.on": "Вкл.",
        "seat.off": "Выкл.",
        "seat.sizeAutoValue": "Авто",
        "seat.sizeAutoHint": "Размер выбирает модель",
        "seat.sizeAutoAria": "Автоматический размер",
        "seat.width": "Ширина",
        "seat.height": "Высота",
        "seat.searchAria": "Поиск моделей изображений",
        "seat.searchPlaceholder": "Поиск моделей",
        "seat.clearSearch": "Очистить поиск",
        "seat.menuAria": "Модели изображений",
        "seat.choose": "Выберите модель изображений",
        "seat.triggerAria": "Модель изображений: {model}",
        "seat.triggerAriaQuality": "Модель изображений: {model}, качество {quality}",
        "seat.settingsAria": "Настройки изображений",
        "seat.moreSettings": "Другие настройки",
        "seat.qualityUnsupported": "У этой модели нет уровней качества",
        "seat.qualityWarning": "Быстрее расходует квоту",
        "seat.levelsCount": "{count} уровней",
        "seat.levelsNone": "Не поддерживается",
        "seat.sizeTitle": "Размер",
        "seat.back": "Назад",
        "seat.modelAutoHint": "Пусть модель выберет",
        "errors.loadConfig": "Не удалось загрузить настройки изображений: HTTP {status}",
        "errors.loadConfigDetail": "Не удалось загрузить настройки изображений: {message}",
        "errors.saveConfig": "Не удалось сохранить настройки изображений: HTTP {status}",
        "errors.saveConfigDetail": "Не удалось сохранить настройки изображений: {message}",
        "errors.saveFailed": "Не удалось сохранить настройки изображений",
        "errors.fetchModels": "Не удалось получить список моделей: HTTP {status}",
        "errors.fetchModelsDetail": "Не удалось получить список моделей: {message}",
        "errors.noModels": "Служба не вернула модели. Введите ID модели вручную.",
        "errors.localUnreachable": "Не удалось подключиться к локальной службе плагина. Проверьте, что хост DSH запущен.",
        "errors.localTimeout": "Локальная служба не ответила вовремя. Повторите попытку.",
        "serverError.network.format": "Ошибка сети при запросе к {host}: {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "напрямую",
        "serverError.network.viaIndirect": "через сетевые настройки системы",
        "serverError.network.hint.timeout": "Тайм-аут TCP-соединения.",
        "serverError.network.hint.dns": "Не удалось разрешить DNS. Проверьте домен или DNS.",
        "serverError.network.hint.connection": "Соединение отклонено или сброшено. Порт может быть закрыт, или служба разорвала соединение.",
        "serverError.network.hint.tls": "Не удалось проверить TLS-сертификат. Возможно, он просрочен или самоподписан.",
        "serverError.network.timeout": "Время ожидания запроса к {host} истекло.",
        "serverError.network.routeInvalid": "Конфигурация сетевого подключения недействительна. Проверьте сетевые настройки хоста или системы.",
        "serverError.upstream.http": "Служба изображений вернула HTTP {status}: {detail}",
        "serverError.upstream.httpNoDetail": "Служба изображений вернула HTTP {status}.",
        "serverError.upstream.invalidJson": "Служба изображений вернула ответ, который не является JSON.",
        "serverError.upstream.invalidResponse": "В ответе {service} отсутствует {field}.",
        "serverError.upstream.tooLarge": "Ответ службы изображений превысил ограничение размера.",
        "serverError.provider.notFound": "Выбранный поставщик изображений не найден.",
        "serverError.provider.missingBaseUrl": "Сначала укажите URL API.",
        "serverError.provider.missingKey": "У поставщика изображений «{provider}» нет ключа API.",
        "serverError.provider.missingKeyWithRef": "У поставщика изображений «{provider}» нет ключа API (учётные данные {ref}).",
        "serverError.models.unsupported": "Этот поставщик не предоставляет список моделей.",
        "serverError.models.notFound": "У этого адреса нет эндпоинта списка моделей (HTTP 404). Введите ID модели вручную.",
        "serverError.adapter.unknownProtocol": "Неподдерживаемый протокол изображений: {protocol}. Доступны: {available}.",
        "serverError.adapter.notFound": "Адаптер изображений не найден: {adapter}. Доступны: {available}.",
        "serverError.config.credentialsUnavailable": "Служба учётных данных недоступна, поэтому ключ API нельзя сохранить безопасно.",
        "serverError.config.credentialSaveFailed": "Не удалось сохранить ключ API: {message}",
        "serverError.config.legacyKeyMigrationFailed": "Не удалось перенести старый ключ API: {message}",
        "serverError.config.writeFailed": "Не удалось сохранить настройки изображений: {message}",
        "serverError.request.methodNotAllowed": "Этот метод запроса не разрешён.",
        "serverError.request.bodyTooLarge": "Тело запроса слишком велико.",
        "serverError.request.invalidJson": "Тело запроса не является допустимым JSON.",
        "quality.off": "Выкл.",
        "quality.low": "Низкое",
        "quality.medium": "Среднее",
        "quality.high": "Высокое",
        "quality.xhigh": "Очень высокое",
        "quality.max": "Максимум",
        "quality.auto": "Авто",
        "quality.standard": "Стандартное",
        "quality.hd": "HD",
        "quality.default": "По умолчанию",
        "quality.quality": "Высокое качество",
        "quality.turbo": "Турбо",
        "localPreset.sd-server.urlHint": "Укажите только корневой URL службы, сохранив /v1 в конце. Плагин добавит /images/generations и /models.",
        "localPreset.sd-server.hint": "Нативный API OpenAI Images: поддерживает генерацию и редактирование через /images/edits. Модель обычно называется sd-cpp-local; список доступен в /v1/models.",
        "localPreset.localai.urlHint": "Укажите только корневой URL службы, сохранив /v1 в конце. Плагин добавит /images/generations и /models.",
        "localPreset.localai.hint": "Совместимо с OpenAI Images для генерации; укажите name из YAML-файла моделей LocalAI, список доступен в /v1/models. В LocalAI нет /images/edits, поэтому для редактирования используйте шлюз, совместимый с OpenAI.",
        "localPreset.a1111.urlHint": "Укажите только корневой URL службы, без /sdapi/v1. Плагин добавит /sdapi/v1/txt2img, /img2img и /sd-models.",
        "localPreset.a1111.hint": "Использует /sdapi/v1/txt2img и /sdapi/v1/img2img; список моделей берётся из /sdapi/v1/sd-models. Запускайте A1111 с параметром --api.",
        "localPreset.comfyui.urlHint": "Укажите только корневой URL службы, без /prompt. Плагин добавит /prompt, /upload/image, /history и /view.",
        "localPreset.comfyui.hint": "Встроенные workflow покрывают SD/SDXL, FLUX.2 и MOSS-Image — и генерацию, и редактирование по референсу. Для других архитектур (Qwen-Image, Z-Image и т. п.) вставьте свой workflow ComfyUI в «Параметры модели» или используйте шлюз, совместимый с OpenAI.",
        "localPreset.swarmui.urlHint": "Укажите только корневой URL службы, без /API. Плагин добавит /API/GetNewSession, /API/ListModels и /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Использует /API/GenerateText2Image; список моделей берётся из /API/ListModels. Генерация работает, нативное редактирование пока не поддерживается.",
        "localPreset.openai-gateway.urlHint": "Укажите корневой URL API OpenAI (обычно с /v1). Плагин добавит /images/generations и /models.",
        "localPreset.openai-gateway.hint": "Выберите этот вариант для InvokeAI, Fooocus, сложных workflow ComfyUI или собственной службы с /v1/images/generations.",
        "update.available": "Доступно обновление",
        "update.title": "Доступно обновление",
        "update.version": "{from} → {to}",
        "update.cancel": "Отмена",
        "update.apply": "Обновить",
        "update.close": "Закрыть",
        "update.starting": "Обновление dsh-mo-image…",
        "update.doneRestart": "Обновление установлено — перезапустите DSH",
        "update.done": "Обновлено до {version}",
        "update.failed": "Обновление не завершено — повторите попытку",
        "update.failedRestored": "Обновление не удалось — прежняя версия восстановлена",
        "update.failedBroken": "Обновление не удалось, и прежняя версия не восстановлена — переустановите плагин в управлении плагинами",
        "update.unsupported": "Эта среда не поддерживает самообновление — выполните {command}",
        "update.localDev": "Локальная установка для разработки — выполните git pull",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "Открыть на npm",
        "update.noNotes": "В этом выпуске нет примечаний.",
        "form.modelMappingParse": "Разобрать workflow",
        "form.modelMappingParsing": "Разбор…",
        "form.modelMappingFailed": "Не удалось разобрать",
        "form.modelMappingSkip": "Не внедрять",
        "form.modelMappingFormatApi": "Формат API",
        "form.modelMappingFormatUi": "Формат UI",
        "form.modelMappingSampler": "Сэмплер",
        "form.modelMappingWidth": "Ширина",
        "form.modelMappingHeight": "Высота",
        "form.modelMappingSeed": "Сид",
        "form.modelMappingModel": "Модель",
        "form.modelMappingImage": "Референс",
        "form.modelMappingColName": "Параметр",
        "form.modelMappingColTarget": "Привязка",
        "form.modelMappingColExpose": "Доступен",
        "form.modelAutoInjectHint": "Промпт и негативный промпт подставляются из вызова инструмента, здесь настраивать нечего.",
        "param.steps": "Шаги",
        "param.cfg": "Сила промпта",
        "param.sampler_name": "Сэмплер",
        "param.scheduler": "Планировщик",
        "param.denoise": "Перерисовка",
        "param.batch_size": "Размер пакета",
        "param.guidance": "Сила наведения",
        "param.cfg.desc": "Насколько промпт управляет изображением; слишком высоко — жёстко, слишком низко — уходит в сторону",
        "param.sampler_name.desc": "Алгоритм сэмплирования, определяющий сходимость и текстуру",
        "param.scheduler.desc": "Расписание шума; вместе с сэмплером задаёт ритм удаления шума",
        "param.denoise.desc": "Доля исходного изображения, которая сохраняется; 1 — полная перерисовка",
        "param.batch_size.desc": "Сколько изображений за запуск; больше — больше видеопамяти",
        "param.guidance.desc": "Коэффициент наведения для дистиллированных моделей, обычно около 1",
        "form.a1111ParamsHint": "Отмеченные параметры можно переопределить через params; остальные берутся из настроек WebUI",
        "form.a1111ColType": "Тип",
        "seat.sizeAspect": "Пропорции",
        "seat.sizeTier": "Уровень",
        "seat.sizePreset": "Пресет",
        "seat.sizeCustom": "Свой",
        "seat.sizeStrict": "Строго",
        "seat.sizeStrictHint": "Размер результата принудительно задаётся; без размера в запросе не действует",
        "seat.sizePromptHint": "Модель не принимает размер; он добавляется в промпт",
        "seat.sizeHint.ratioOnly": "Разрешение зависит от пропорций",
        "seat.sizeHint.fixedPixels": "Разрешение задаёт платформа: core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "Модель не принимает размер",
        "seat.sizeHint.modelDecides": "Без размера выбирает модель",
        "form.sizeParamsHint": "Как передавать размер, решает адаптер; здесь можно переопределить, пусто — значение по умолчанию.",
        "form.sizeMode": "Кодирование",
        "form.sizeModeDefault": "Как по умолчанию",
        "form.sizeModeWhString": "size = ШxВ",
        "form.sizeModeWhFields": "поля width + height",
        "form.sizeModeAspect": "Соотношение сторон",
        "form.sizeModeTier": "Название ступени",
        "form.sizeModePrompt": "Дописать в промпт",
        "form.sizeField": "Имя параметра",
        "form.sizeFieldHint": "Пусто — значение по умолчанию; поддерживаются пути вида a.b.c.",
        "form.sizeSeparator": "Разделитель",
        "form.sizeSeparatorCustom": "Другой",
        "form.sizeSecond": "Второе поле",
        "form.sizeSecondHint": "Необязательно: отправить пропорцию или ступень в другое поле; пусто — не отправлять.",
        "form.sizeFieldWidth": "Имя параметра: ширина",
        "form.sizeFieldHeight": "Имя параметра: высота",
        "form.sizeFieldAspect": "Имя параметра: пропорция",
        "form.sizeFieldResolution": "Имя параметра: разрешение",
        "seat.sizeAutoHelp": "Включено — модель сама подбирает размер под запрос.",
        "seat.sizeStrictHelp": "Принудительно приводит к заданному размеру (оригинал сохраняется).",
        "form.paramSize": "Размер",
        "form.paramQuality": "Качество",
        "form.paramPrompt": "Промпт",
        "form.paramNegative": "Негативный промпт",
        "form.paramModel": "Модель",
        "form.paramN": "Количество",
        "form.paramImage": "Референсное изображение",
        "form.paramLock": "Заблокировать ключ",
        "form.lockOn": "Заблокировано: настройка и определение его пропускают",
        "form.lockOff": "Разблокировано: настройка может перезаписать",
        "form.unlockAll": "Разблокировать всё",
        "form.advancedParams": "Дополнительно (имена полей)",
        "form.paramsCommon": "Общие",
        "form.paramsHint": "Заблокированные ключи не изменяются; разблокируйте чтобы править вручную.",
        "form.imageAs": "Кодирование",
        "form.imageField": "Имя поля",
        "form.autoDetect": "Автоопределение",
        "form.detecting": "Определение…",
        "form.detectNeedsModels": "Сначала добавьте модель",
        "form.bulkConfigure": "Настроить всё",
        "form.bulkConfiguring": "Настройка…",
        "form.bulkConfigDone": "Настроено моделей: {count} — без правила: {unmatched}",
        "form.bulkConfigNone": "Ни одна модель не совпала с правилом — отправка в режиме совместимости с OpenAI",
        "form.bulkConfigSkipped": "Все ключи заблокированы — настройка ничего не записала",
        "errors.detectRule": "Не удалось определить правила",
      },
      "pt": {
        "nav": "Modelos de imagem",
        "section.title": "Modelos de imagem",
        "section.intro": "Adicione uma chave de API na nuvem ou conecte um serviço de imagens neste computador ou na sua rede local.",
        "section.unnamedProvider": "Provedor sem nome",
        "tag.local": "Local",
        "tag.custom": "Personalizado",
        "status.ready": "Pronto",
        "status.missingLocal": "Falta a URL da API ou o modelo",
        "status.missingCloud": "Falta a URL da API, a chave ou o modelo",
        "status.missingConfig": "Não configurado",
        "action.edit": "Editar",
        "action.delete": "Excluir",
        "action.addProvider": "Adicionar provedor",
        "form.displayName": "Nome de exibição",
        "form.baseUrl": "URL da API",
        "form.protocol": "Protocolo da API",
        "form.protocolAuto": "Detecção automática",
        "form.protocolRoutes": "Endereços do protocolo",
        "form.route.generate": "Texto para imagem",
        "form.route.edit": "Imagem para imagem",
        "form.route.models": "Listar modelos",
        "form.routeUnsupported": "Não suportado",
        "form.customProtocol": "Personalizado (inserir URLs)",
        "form.hostModel": "Modelo host",
        "form.hostModelHint": "A API Responses precisa de um modelo principal que possa chamar a ferramenta de imagem.",
        "form.apiKey": "Chave de API",
        "form.keyLocalOptional": "Opcional para serviços locais sem autenticação",
        "form.keyEnter": "Insira a chave de API",
        "form.keyEnvSaved": "Usando a chave salva no ambiente",
        "form.keySaved": "Deixe em branco para usar a credencial salva",
        "form.modelDirectory": "Catálogo de modelos",
        "form.modelDirectoryCustom": "Catálogo de modelos personalizado",
        "form.modelDirectoryDefault": "Usando os modelos padrão do adaptador",
        "form.fetchNeedsBaseUrl": "Insira a URL da API primeiro",
        "form.fetching": "Obtendo…",
        "form.fetchModels": "Obter modelos disponíveis",
        "form.modelId": "ID do modelo",
        "form.reorderModel": "Reordenar modelo",
        "form.reorderModelHelp": "Arraste para reordenar ou use as teclas de seta para cima e para baixo.",
        "form.deleteModel": "Remover modelo",
        "form.modelOptions": "Opções do modelo",
        "form.modelOptionsHint": "Substitui o fluxo de trabalho do ComfyUI para este modelo. Deixe vazio para usar o fluxo integrado conforme o tipo do modelo.",
        "form.modelOptionsUnsupported": "Fluxos de trabalho personalizados só estão disponíveis na implantação ComfyUI",
        "form.modelWorkflow": "Fluxo de trabalho personalizado (formato API do ComfyUI)",
        "form.modelWorkflowPlaceholder": "No ComfyUI use Exportar (API) e cole o JSON aqui",
        "form.modelWorkflowHelp": "Marcadores: {{prompt}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{model}}, {{image}} (substituído pela referência enviada ao editar)",
        "form.modelOptionsDone": "Concluído",
        "form.modelWorkflowSample": "Inserir modelo de exemplo",
        "form.modelEmpty": "O seletor de modelos ficará vazio. Adicione pelo menos um ID de modelo ao catálogo primeiro.",
        "form.addModel": "Adicionar modelo",
        "form.advanced": "Configurações avançadas",
        "form.addMode": "Forma de adicionar",
        "form.modeCatalog": "Provedor de modelos",
        "form.modeCustom": "API personalizada",
        "form.modeLocal": "Modelo local",
        "form.modeCatalogHint": "Escolha uma plataforma oficial ou de grande porte na lista integrada (OpenAI, Volcengine Ark, Alibaba Cloud Bailian e outras) e adicione a chave de API.",
        "form.modeCustomHint": "Conecte um serviço auto-hospedado ou qualquer outro endpoint compatível com OpenAI Images.",
        "form.modeLocalHint": "Conecte um serviço de imagens neste computador ou na sua rede local. Serviços locais sem autenticação podem deixar a chave de API em branco.",
        "form.provider": "Provedor",
        "form.providerWebsite": "Site do provedor",
        "form.localDeployer": "Implantação local",
        "form.localPresetsMissing": "O host não enviou a lista de implantações locais. Recarregue a página e tente novamente.",
        "form.save": "Salvar",
        "form.cancel": "Cancelar",
        "picker.title": "Escolher modelos",
        "picker.close": "Fechar",
        "picker.description": "Estes são os modelos disponíveis neste provedor. Os modelos marcados compõem a lista.",
        "picker.search": "Pesquisar modelos",
        "picker.selectAll": "Selecionar tudo",
        "picker.deselectAll": "Desmarcar tudo",
        "picker.showAll": "Mostrar todos os modelos",
        "picker.filtered": "Filtrados como prováveis não-imagens: {count}",
        "picker.noMatches": "Nenhum modelo correspondente",
        "picker.adopt": "Atualizar lista",
        "picker.keepOne": "Mantenha pelo menos um modelo marcado.",
        "seat.noMatches": "Nenhum modelo correspondente",
        "seat.empty": "Ainda não há modelos. Adicione um em Configurações → Modelos de imagem.",
        "seat.auto": "Automático",
        "seat.fallback": "Modelo de imagem",
        "seat.menuModel": "Modelo",
        "seat.menuQuality": "Qualidade",
        "seat.menuSize": "Tamanho",
        "seat.menuPromptOptimization": "Otimização de prompt",
        "seat.promptOptimizationUsage": "Usa mais cota",
        "seat.notSelected": "Não selecionado",
        "seat.on": "Ativado",
        "seat.off": "Desativado",
        "seat.sizeAutoValue": "Automático",
        "seat.sizeAutoHint": "Deixe o modelo escolher o tamanho",
        "seat.sizeAutoAria": "Tamanho automático",
        "seat.width": "Largura",
        "seat.height": "Altura",
        "seat.searchAria": "Pesquisar modelos de imagem",
        "seat.searchPlaceholder": "Pesquisar modelos",
        "seat.clearSearch": "Limpar pesquisa",
        "seat.menuAria": "Modelos de imagem",
        "seat.choose": "Escolher um modelo de imagem",
        "seat.triggerAria": "Modelo de imagem: {model}",
        "seat.triggerAriaQuality": "Modelo de imagem: {model}, qualidade {quality}",
        "seat.settingsAria": "Configurações de imagem",
        "seat.moreSettings": "Mais ajustes",
        "seat.qualityUnsupported": "Este modelo não oferece níveis de qualidade",
        "seat.qualityWarning": "Consome a cota mais rápido",
        "seat.levelsCount": "{count} níveis",
        "seat.levelsNone": "Não suportado",
        "seat.sizeTitle": "Tamanho",
        "seat.back": "Voltar",
        "seat.modelAutoHint": "Deixe o modelo escolher",
        "errors.loadConfig": "Não foi possível carregar as configurações de imagem: HTTP {status}",
        "errors.loadConfigDetail": "Não foi possível carregar as configurações de imagem: {message}",
        "errors.saveConfig": "Não foi possível salvar as configurações de imagem: HTTP {status}",
        "errors.saveConfigDetail": "Não foi possível salvar as configurações de imagem: {message}",
        "errors.saveFailed": "Não foi possível salvar as configurações de imagem",
        "errors.fetchModels": "Não foi possível obter a lista de modelos: HTTP {status}",
        "errors.fetchModelsDetail": "Não foi possível obter a lista de modelos: {message}",
        "errors.noModels": "O serviço não retornou modelos. Insira um ID de modelo manualmente.",
        "errors.localUnreachable": "Não foi possível conectar ao serviço local do plugin. Verifique se o host do DSH está em execução.",
        "errors.localTimeout": "O serviço local expirou. Tente novamente.",
        "serverError.network.format": "Falha na requisição de rede para {host}: {cause} ({via}). {hint}",
        "serverError.network.viaDirect": "conexão direta",
        "serverError.network.viaIndirect": "via configuração de rede do sistema",
        "serverError.network.hint.timeout": "Tempo limite de conexão TCP.",
        "serverError.network.hint.dns": "Falha na resolução DNS. Verifique o domínio ou o DNS.",
        "serverError.network.hint.connection": "Conexão recusada ou redefinida. A porta pode estar fechada ou o serviço encerrou a conexão.",
        "serverError.network.hint.tls": "Falha na verificação do certificado TLS. Ele pode estar expirado ou ser autoassinado.",
        "serverError.network.timeout": "A solicitação para {host} expirou.",
        "serverError.network.routeInvalid": "A configuração de conexão de rede não é válida. Verifique as configurações de rede do host ou do sistema.",
        "serverError.upstream.http": "O serviço de imagens retornou HTTP {status}: {detail}",
        "serverError.upstream.httpNoDetail": "O serviço de imagens retornou HTTP {status}.",
        "serverError.upstream.invalidJson": "O serviço de imagens retornou uma resposta que não é JSON.",
        "serverError.upstream.invalidResponse": "A resposta de {service} não inclui {field}.",
        "serverError.upstream.tooLarge": "A resposta do serviço de imagens excedeu o limite de tamanho.",
        "serverError.provider.notFound": "O provedor de imagens selecionado não foi encontrado.",
        "serverError.provider.missingBaseUrl": "Insira a URL da API primeiro.",
        "serverError.provider.missingKey": "O provedor de imagens “{provider}” não tem chave de API.",
        "serverError.provider.missingKeyWithRef": "O provedor de imagens “{provider}” não tem chave de API (credencial {ref}).",
        "serverError.models.unsupported": "Este provedor não expõe uma lista de modelos.",
        "serverError.models.notFound": "Este endereço não tem endpoint de lista de modelos (HTTP 404). Digite o ID do modelo manualmente.",
        "serverError.adapter.unknownProtocol": "Protocolo de imagem não suportado: {protocol}. Disponíveis: {available}.",
        "serverError.adapter.notFound": "Adaptador de imagem não encontrado: {adapter}. Disponíveis: {available}.",
        "serverError.config.credentialsUnavailable": "O serviço de credenciais não está disponível, então a chave de API não pode ser armazenada com segurança.",
        "serverError.config.credentialSaveFailed": "Não foi possível salvar a chave de API: {message}",
        "serverError.config.legacyKeyMigrationFailed": "Não foi possível migrar a chave de API antiga: {message}",
        "serverError.config.writeFailed": "Não foi possível salvar as configurações de imagem: {message}",
        "serverError.request.methodNotAllowed": "Esse método de solicitação não é permitido.",
        "serverError.request.bodyTooLarge": "O corpo da solicitação é muito grande.",
        "serverError.request.invalidJson": "O corpo da solicitação não é um JSON válido.",
        "quality.off": "Desativado",
        "quality.low": "Baixa",
        "quality.medium": "Média",
        "quality.high": "Alta",
        "quality.xhigh": "Muito alta",
        "quality.max": "Máxima",
        "quality.auto": "Automática",
        "quality.standard": "Padrão",
        "quality.hd": "HD",
        "quality.default": "Padrão",
        "quality.quality": "Alta qualidade",
        "quality.turbo": "Turbo",
        "localPreset.sd-server.urlHint": "Informe apenas a URL raiz do serviço e mantenha o /v1 no final. O plugin acrescenta /images/generations e /models.",
        "localPreset.sd-server.hint": "API nativa do OpenAI Images; oferece geração e edição com /images/edits. O modelo geralmente é sd-cpp-local e pode ser listado em /v1/models.",
        "localPreset.localai.urlHint": "Informe apenas a URL raiz do serviço e mantenha o /v1 no final. O plugin acrescenta /images/generations e /models.",
        "localPreset.localai.hint": "Compatível com OpenAI Images para gerar; use o name do YAML de modelos do LocalAI, listável em /v1/models. O LocalAI não tem /images/edits, então use um gateway compatível com OpenAI para editar imagens.",
        "localPreset.a1111.urlHint": "Informe apenas a URL raiz do serviço, sem /sdapi/v1. O plugin acrescenta /sdapi/v1/txt2img, /img2img e /sd-models.",
        "localPreset.a1111.hint": "Usa /sdapi/v1/txt2img e /sdapi/v1/img2img; a lista de modelos vem de /sdapi/v1/sd-models. Inicie o A1111 com --api.",
        "localPreset.comfyui.urlHint": "Informe apenas a URL raiz do serviço, sem /prompt. O plugin acrescenta /prompt, /upload/image, /history e /view.",
        "localPreset.comfyui.hint": "Os fluxos integrados cobrem SD/SDXL, FLUX.2 e MOSS-Image, tanto para gerar quanto para editar com referência. Para outras arquiteturas (Qwen-Image, Z-Image…), cole seu fluxo do ComfyUI em «Opções do modelo» ou use um gateway compatível com OpenAI.",
        "localPreset.swarmui.urlHint": "Informe apenas a URL raiz do serviço, sem /API. O plugin acrescenta /API/GetNewSession, /API/ListModels e /API/GenerateText2Image.",
        "localPreset.swarmui.hint": "Usa /API/GenerateText2Image; a lista de modelos vem de /API/ListModels. A geração funciona; a edição nativa ainda não é suportada.",
        "localPreset.openai-gateway.urlHint": "Informe a URL raiz da API OpenAI (normalmente com /v1). O plugin acrescenta /images/generations e /models.",
        "localPreset.openai-gateway.hint": "Escolha esta opção para InvokeAI, Fooocus, fluxos complexos do ComfyUI ou um serviço auto-hospedado que exponha /v1/images/generations.",
        "update.available": "Atualização disponível",
        "update.title": "Atualização disponível",
        "update.version": "{from} → {to}",
        "update.cancel": "Cancelar",
        "update.apply": "Atualizar",
        "update.close": "Fechar",
        "update.starting": "Atualizando dsh-mo-image…",
        "update.doneRestart": "Atualização instalada — reinicie o DSH para aplicar",
        "update.done": "Atualizado para {version}",
        "update.failed": "A atualização não terminou — tente novamente",
        "update.failedRestored": "A atualização falhou — a versão anterior foi restaurada",
        "update.failedBroken": "A atualização falhou e a versão anterior não foi restaurada — reinstale pelo gerenciamento de plugins",
        "update.unsupported": "Este ambiente não permite atualização automática; execute {command}",
        "update.localDev": "Instalação de desenvolvimento local — execute git pull",
        "update.command": "dsh plugin add dsh-mo-image@{tag}",
        "update.viewRelease": "Ver no npm",
        "update.noNotes": "Esta versão não tem notas.",
        "form.modelMappingParse": "Analisar fluxo",
        "form.modelMappingParsing": "Analisando…",
        "form.modelMappingFailed": "Falha ao analisar",
        "form.modelMappingSkip": "Não injetar",
        "form.modelMappingFormatApi": "Formato API",
        "form.modelMappingFormatUi": "Formato UI",
        "form.modelMappingSampler": "Amostrador",
        "form.modelMappingWidth": "Largura",
        "form.modelMappingHeight": "Altura",
        "form.modelMappingSeed": "Semente",
        "form.modelMappingModel": "Modelo",
        "form.modelMappingImage": "Imagem de referência",
        "form.modelMappingColName": "Parâmetro",
        "form.modelMappingColTarget": "Mapeamento",
        "form.modelMappingColExpose": "Exposto",
        "form.modelAutoInjectHint": "O prompt e o prompt negativo vêm da chamada da ferramenta; não há nada para configurar aqui.",
        "param.steps": "Passos",
        "param.cfg": "Intensidade do prompt",
        "param.sampler_name": "Amostrador",
        "param.scheduler": "Agendador",
        "param.denoise": "Redesenho",
        "param.batch_size": "Tamanho do lote",
        "param.guidance": "Intensidade de orientação",
        "param.cfg.desc": "Quanto o prompt restringe a imagem; alto demais fica rígido, baixo demais desvia",
        "param.sampler_name.desc": "Algoritmo de amostragem que define convergência e textura",
        "param.scheduler.desc": "Curva de ruído; com o amostrador define o ritmo de remoção de ruído",
        "param.denoise.desc": "Quanto da imagem original é mantido; 1 redesenha por completo",
        "param.batch_size.desc": "Imagens por execução; valores maiores usam mais VRAM",
        "param.guidance.desc": "Escala de orientação para modelos destilados, normalmente perto de 1",
        "form.a1111ParamsHint": "Os parâmetros marcados podem ser substituídos via params; os demais seguem as configurações do WebUI",
        "form.a1111ColType": "Tipo",
        "seat.sizeAspect": "Proporção",
        "seat.sizeTier": "Nível",
        "seat.sizePreset": "Predefinição",
        "seat.sizeCustom": "Personalizado",
        "seat.sizeStrict": "Estrito",
        "seat.sizeStrictHint": "O resultado é forçado ao tamanho configurado; sem tamanho no pedido não se aplica",
        "seat.sizePromptHint": "Este modelo não aceita tamanho; ele vai no prompt",
        "seat.sizeHint.ratioOnly": "A resolução segue a proporção",
        "seat.sizeHint.fixedPixels": "A resolução é fixa: core 1.5MP, sd3/ultra 1MP",
        "seat.sizeHint.noSizeField": "Este modelo não aceita tamanho",
        "seat.sizeHint.modelDecides": "Sem tamanho, o modelo escolhe",
        "form.sizeParamsHint": "O adaptador decide como este modelo recebe o tamanho; sobrescreva aqui, deixe vazio para o padrão.",
        "form.sizeMode": "Codificação",
        "form.sizeModeDefault": "Seguir o padrão",
        "form.sizeModeWhString": "size = LxA",
        "form.sizeModeWhFields": "campos width + height",
        "form.sizeModeAspect": "Proporção",
        "form.sizeModeTier": "Nome do nível",
        "form.sizeModePrompt": "Anexar ao prompt",
        "form.sizeField": "Nome do parâmetro",
        "form.sizeFieldHint": "Vazio para o padrão; aceita caminhos como a.b.c.",
        "form.sizeSeparator": "Separador",
        "form.sizeSeparatorCustom": "Personalizado",
        "form.sizeSecond": "Segundo campo",
        "form.sizeSecondHint": "Opcional: enviar a proporção ou o nível em outro campo; deixe vazio para não enviar.",
        "form.sizeFieldWidth": "Nome do parâmetro: largura",
        "form.sizeFieldHeight": "Nome do parâmetro: altura",
        "form.sizeFieldAspect": "Nome do parâmetro: proporção",
        "form.sizeFieldResolution": "Nome do parâmetro: resolução",
        "seat.sizeAutoHelp": "Ativado, o modelo ajusta o tamanho conforme o pedido do usuário.",
        "seat.sizeStrictHelp": "Força o tamanho configurado (o original é mantido).",
        "form.paramSize": "Tamanho",
        "form.paramQuality": "Qualidade",
        "form.paramPrompt": "Prompt",
        "form.paramNegative": "Prompt negativo",
        "form.paramModel": "Modelo",
        "form.paramN": "Quantidade",
        "form.paramImage": "Imagem de referência",
        "form.paramLock": "Bloquear esta chave",
        "form.lockOn": "Bloqueado: configuração e detecção o ignoram",
        "form.lockOff": "Desbloqueado: a configuração pode sobrescrever",
        "form.unlockAll": "Desbloquear tudo",
        "form.advancedParams": "Avançado (nomes de campos)",
        "form.paramsCommon": "Geral",
        "form.paramsHint": "Chaves bloqueadas não são alteradas; desbloqueie para editar à mão.",
        "form.imageAs": "Codificação",
        "form.imageField": "Nome do campo",
        "form.autoDetect": "Detecção automática",
        "form.detecting": "Detectando…",
        "form.detectNeedsModels": "Adicione um modelo primeiro",
        "form.bulkConfigure": "Configurar tudo",
        "form.bulkConfiguring": "Configurando…",
        "form.bulkConfigDone": "{count} modelos configurados — {unmatched} sem regra correspondente",
        "form.bulkConfigNone": "Nenhum modelo correspondeu a uma regra — envio compatível com OpenAI",
        "form.bulkConfigSkipped": "Todas as chaves estão bloqueadas — a configuração não gravou nada",
        "errors.detectRule": "Falha na detecção de regras",
      },
    };
    // END GENERATED LOCALES

    const inject = ['slots', 'locale'];
    function apply(ctx) {
      const locale = ctx.locale;
      const t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackTranslate;
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, MESSAGES), 'mo-image: locale dictionaries');
      }
      loadImageStore(t);
      refreshThemeClasses();
      // DSH 的客户端插件样式是异步注入的：启动后再补几次解析，并在新 <style>
      // 出现时重试，保证拿到的是当前页面真正在用的前缀。
  ctx.effect(() => {
        let queued = 0;
        const schedule = () => {
          if (queued) return;
          queued = setTimeout(() => {
            queued = 0;
            refreshThemeClasses();
          }, 50);
        };
        const timers = [0, 120, 600, 1500, 3000].map((delay) => setTimeout(refreshThemeClasses, delay));
        const onFocus = () => refreshThemeClasses();
        const onVisible = () => { if (!document.hidden) refreshThemeClasses(); };
        if (typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus);
        if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisible);
        const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node && node.nodeName === 'STYLE') {
                schedule();
                return;
              }
            }
          }
        });
        if (observer) observer.observe(document.head, { childList: true });
        return () => {
          for (const timer of timers) clearTimeout(timer);
          if (queued) clearTimeout(queued);
          if (observer) observer.disconnect();
          if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', onFocus);
          if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisible);
        };
      }, 'mo-image: theme classes');
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'mo-image-models', order: 12
      }, ImageSectionIcon));
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'mo-image-model-seat', order: 10,
        inject: () => ({ t: t })
      }, ImageModelSeat));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'mo-image-models', order: 12, label: () => t('nav'),
        inject: () => ({ t: t })
      }, ImageModelSettings));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'mo-image-update-toast', order: 90,
        inject: () => ({ t: t })
      }, UpdateToastHost));
    }
    /** 读宿主下发的更新状态；拿不到就返回 null，界面保持安静。 */
    async function fetchUpdateStatus() {
      try {
        const response = await fetch('/api/mo-image/update', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response || !response.ok) return null;
        const body = await response.json();
        return body && body.ok ? body : null;
      } catch (_error) {
        return null;
      }
    }

    /** 把 Release 的 markdown 拆成能渲染的块：标题、列表项、段落。不执行 HTML。 */
    function renderUpdateNotes(markdown) {
      const blocks = [];
      for (const raw of String(markdown || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#{1,6}\s+/.test(line)) {
          blocks.push({ kind: 'h', text: line.replace(/^#{1,6}\s+/, '') });
          continue;
        }
        const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(line);
        if (bullet) {
          blocks.push({ kind: 'li', text: bullet[1] });
          continue;
        }
        blocks.push({ kind: 'p', text: line });
      }
      return blocks;
    }

    /** 状态对应的气泡文案；没有可弹的就返回 null。 */
    function updateToastFor(status, translate) {
      const state = status && status.state;
      if (state === 'done') {
        return status.updatedBeforeRestart
          ? translate('update.done', { version: status.latest })
          : translate('update.doneRestart');
      }
      if (state === 'failed') {
        if (status.error === 'update.failedRestored') return translate('update.failedRestored');
        if (status.error === 'update.failedBroken') return translate('update.failedBroken');
        return translate('update.failed');
      }
      if (state === 'updating') return translate('update.starting');
      return null;
    }

    /** 页面底部的一条气泡；只保留最新一条，4 秒后自己消失。 */
    function createToastQueue() {
      let current = null;
      let timer = 0;
      const listeners = new Set();
      const notify = () => {
        for (const listener of [...listeners]) {
          try { listener(current); } catch (_error) { /* 单个订阅者出错不影响别人 */ }
        }
      };
      return {
        push(text, tone) {
          if (!text) return;
          current = { text: String(text), tone: tone || 'info', seq: (current ? current.seq : 0) + 1 };
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { current = null; timer = 0; notify(); }, 4000);
          if (timer && typeof timer.unref === 'function') timer.unref();
          notify();
        },
        clear() {
          current = null;
          if (timer) clearTimeout(timer);
          timer = 0;
          notify();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        current() { return current; }
      };
    }
    const toastQueue = createToastQueue();
    function pushToast(text, tone) { toastQueue.push(text, tone); }

    // 点过「更新」之后的一段时间里，气泡宿主持续问状态：装新版本时插件会被
    // 替换，路由会短暂 404，所以拿不到状态也要接着问，不能一失败就放弃。
    let updateWatchUntil = 0;
    function watchUpdate() { updateWatchUntil = Date.now() + 180_000; }

    /** 给宿主发一条更新指令；返回失败码（空串表示成功或已忽略）。 */
    function postUpdateAction(body) {
      try {
        return fetch('/api/mo-image/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }).then((response) => (response && response.ok ? response.json() : null))
          .then((data) => (data && data.ok === false ? String(data.code || 'update.unsupported') : ''))
          .catch(() => '');
      } catch (_error) {
        return Promise.resolve('');
      }
    }

    // Test-only seam: the module loader ignores extra exports; browser code only
    // consumes inject/apply. Kept here so error composition can be unit-tested.
    const __test = {
      serverErrorText: serverErrorText,
      responseError: responseError,
      fetchUpdateStatus: fetchUpdateStatus,
      renderUpdateNotes: renderUpdateNotes,
      updateToastFor: updateToastFor,
      UpdateHeader: UpdateHeader,
      UpdateDialog: UpdateDialog,
      toastQueue: toastQueue,
      postUpdateAction: postUpdateAction,
      qualityRailLevels: qualityRailLevels,
      qualityBucketOf: qualityBucketOf,
      sizeSpecFor: sizeSpecFor,
      sizeValueLabel: sizeValueLabel,
      sizeControlOf: sizeControlOf,
      normalizeImageStore: normalizeImageStore,
      normalizeDefaults: normalizeDefaults,
      codexSkinProbe: codexSkinProbe,
      deriveSeatView: deriveSeatView,
      detectSeatSkinFromMarkers: detectSeatSkinFromMarkers,
      detectSeatSkin: detectSeatSkin,
      pickTriggerStyle: pickTriggerStyle,
      codexPlacement: codexPlacement,
      buildCodexSparkles: buildCodexSparkles,
      buildCodexBloom: buildCodexBloom,
      CodexImageSeat: CodexImageSeat,
      OfficialImageSeat: OfficialImageSeat,
      ImageProviderForm: ImageProviderForm,
      applyCatalog: applyCatalog,
      // 键锁与「一键配置」的合并逻辑：纯函数，测试直接驱动，不必渲染整张表单。
      PARAM_KEYS: PARAM_KEYS,
      lockDefaultsFor: lockDefaultsFor,
      lockedMapOf: lockedMapOf,
      writeLock: writeLock,
      writeAllLocks: writeAllLocks,
      mergeRuleResult: mergeRuleResult,
      ruleEntriesOf: ruleEntriesOf,
      sizeOverrideFromRule: sizeOverrideFromRule,
      qualityOverrideFromRule: qualityOverrideFromRule,
      fieldPathOf: fieldPathOf
    };
    return { inject, apply, __test };
  }
});
