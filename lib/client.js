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
    // paramDefaults 是「这个协议零配置时该有哪些参数行」（目前只有 A1111）。
    // authModes 是鉴权方式的取值表（宿主 `AUTH_MODES`）：鉴权是提供商字段，与协议无关。
    let imageCatalog = { adapters: [], providerPresets: [], localPresets: [], capabilities: [], paramDefaults: {}, authModes: [], outputPresets: [] };

    /**
     * 鉴权方式的取值（没有任何协议级声明，不随协议变）。
     * 宿主清单没到（首屏 / 老清单）时用这份兜底，顺序与宿主一致。
     */
    const AUTH_MODES_FALLBACK = ['bearer', 'api-key', 'x-key', 'fal-key', 'custom', 'none', 'basic', 'query'];
    function authModesForUi() {
      const declared = imageCatalog.authModes;
      return Array.isArray(declared) && declared.length ? declared : AUTH_MODES_FALLBACK;
    }
    /** `provider.auth` 归一（面板显示用）：认不出的 mode 回落到 bearer，免得下拉没有选中项。 */
    function authDraftOf(provider) {
      const source = provider && provider.auth && typeof provider.auth === 'object' ? provider.auth : {};
      return { ...source };
    }

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

    /**
     * 一次没命中的探针属于哪一类失败。`status` 是宿主带回来的 HTTP 状态（0 = 没拿到响应），
     * `reason` 只补状态说不出来的那两种（timeout / network）。返回 null = 没有具体指针。
     *
     * rank 就是「该怪谁」的优先级：401/403 怪 Key，404 怪地址，5xx 怪服务端，超时 / 连不上
     * 怪网络。多条探针都失败时取 rank 最高的那条而不是最后一条——公网 `/models` 打头，
     * 它回 401 时后面几条本地端点天然是 404，不能让 404 把「Key 不对」盖掉。
     */
    function probeIssueOf(step) {
      const probe = String((step && step.probe) || '');
      const status = Number(step && step.status) || 0;
      const reason = String((step && step.reason) || '');
      if (status === 401 || status === 403) return { kind: 'auth', status: status, probe: probe, rank: 5 };
      if (status === 404) return { kind: 'endpoint', status: status, probe: probe, rank: 4 };
      if (status >= 400) return { kind: 'http', status: status, probe: probe, rank: 3 };
      if (reason === 'timeout') return { kind: 'timeout', status: status, probe: probe, rank: 2 };
      if (reason === 'network') return { kind: 'network', status: status, probe: probe, rank: 1 };
      if (reason === 'unreadable' || reason === 'invalid') {
        return { kind: 'invalid', status: status, probe: probe, rank: 0 };
      }
      return null;
    }

    /** 两条失败取更该报警的那条；同 rank 保留先出现的（探针顺序本身就是优先级）。 */
    function dominantProbeIssue(current, next) {
      if (!next) return current;
      if (!current) return next;
      return next.rank > current.rank ? next : current;
    }

    /**
     * 失败指针 → 提示文案。401/404 这类是「与协议有关」的结论；连不上 / 超时只说连不上，
     * 不评价「像不像」（连都没连上，无从判断），地址给拼好的完整 URL。
     */
    function probeIssueText(translate, issue, credentialMissing) {
      if (!issue) return '';
      const probe = issue.probe || '';
      if (issue.kind === 'auth') {
        return credentialMissing
          ? translate('form.detectProtocolNoKey', { probe: probe })
          : translate('form.detectProtocolAuthFailed', { probe: probe, status: issue.status });
      }
      if (issue.kind === 'endpoint') {
        return translate('form.detectProtocolNoEndpoint', { probe: probe, status: issue.status });
      }
      if (issue.kind === 'timeout') {
        return translate('form.detectProtocolTimeout', { url: issue.url || probe });
      }
      if (issue.kind === 'network') {
        return translate('form.detectProtocolUnreachable', { url: issue.url || probe });
      }
      if (issue.kind === 'http') {
        return translate('form.detectProtocolHttpError', { probe: probe, status: issue.status });
      }
      return '';
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

    /**
     * 本地部署器：地址由预设自动填好，身份就是部署器本身（换端口 / 换机器还是它）。
     * 列表里的「本地」标签按这条判。
     */
    function isLocalDeployment(provider) {
      return Boolean(provider && provider.optionalKey)
        || ['a1111', 'comfyui', 'swarmui'].includes(String((provider && provider.adapter) || ''));
    }

    /**
     * 「自定义」提供商：列表里的「自定义」标签与编辑页顶部的「未识别出来源」红字共用
     * 这一份判据，两处不能各说各话。
     *
     * 用户自己填的端点（地址不在任何预设里、也不是本地部署器）算；自定义协议也算——
     * 请求形状是用户自己写的，不因为地址像哪家预设就变成预设来源。
     */
    function isCustomProvider(provider) {
      if (String((provider && provider.adapter) || '') === 'custom') return true;
      if (isLocalDeployment(provider)) return false;
      return !isBuiltinProvider(provider);
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
    const CODEX_PAGE_TRANSITION = 'transform .3s cubic-bezier(.32,.72,.28,1)';
    const CODEX_VIEWPORT_TRANSITION = 'height .3s cubic-bezier(.32,.72,.28,1)';
    const CODEX_PAGE_BASE = {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      transition: CODEX_PAGE_TRANSITION
    };
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
          phase: (100 - 92 * (i * CODEX_PHI % 1)) / 108,
          top: (8 + 84 * codexHash01(i * 13 + 5)).toFixed(1) + '%',
          b: b.toFixed(2),
          dur: (3.2 + 2.4 * codexHash01(i * 3 + 11)).toFixed(2) + 's',
          delay: (-(i * CODEX_PHI % 1) * 5.6).toFixed(2) + 's',
          travel: 1800 + 1800 * codexHash01(i * 19 + 7)
        });
      }
      return out;
    }

    /** Codex's one-field dust engine, shared with the selector's rail. */
    function createCodexDustMotion(rail, sparkles) {
      const paths = Array.from(rail.querySelectorAll('.cmes-sp-path'));
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      let animations = [];
      let state = { active: false, fast: false, peak: false };
      let rate = 0;
      let frame = 0;

      function stop() {
        cancelAnimationFrame(frame);
        frame = 0;
        animations.forEach((animation) => animation.pause());
        rail.removeAttribute('data-animating');
      }

      function setRate(value) {
        rate = value;
        const speed = reduced?.matches ? value / 2.6 : value;
        animations.forEach((animation) => {
          animation.updatePlaybackRate(speed);
          if (value === 0) animation.pause();
          else if (animation.playState === 'paused') animation.play();
        });
      }

      function refresh() {
        stop();
        if (!state.active || document.hidden) return;
        if (!(state.fast || state.peak || rate > 0)) return;
        rail.setAttribute('data-animating', '');
        if (!animations.length) {
          animations = paths.flatMap((node, i) => {
            if (typeof node.animate !== 'function') return [];
            const { travel, phase } = sparkles[i];
            const animation = node.animate([
              { transform: 'translateX(0)', opacity: 0, offset: 0 },
              { opacity: 1, offset: 0.04 },
              { opacity: 1, offset: 0.96 },
              { transform: 'translateX(-108%)', opacity: 0, offset: 1 }
            ], { duration: travel, iterations: Infinity, easing: 'linear' });
            animation.pause();
            animation.currentTime = phase * travel;
            return [animation];
          });
        }
        setRate(rate);
        const target = state.fast ? 1 : 0;
        if (rate === target) return;
        const from = rate;
        const started = performance.now();
        const duration = state.fast ? 1050 : 850;
        function ramp(now) {
          const progress = Math.min(1, (now - started) / duration);
          const eased = progress * progress * (3 - 2 * progress);
          setRate(from + (target - from) * eased);
          if (progress < 1) frame = requestAnimationFrame(ramp);
          else {
            frame = 0;
            if (!state.fast && !state.peak) rail.removeAttribute('data-animating');
          }
        }
        frame = requestAnimationFrame(ramp);
      }

      document.addEventListener('visibilitychange', refresh);
      reduced?.addEventListener('change', refresh);
      return {
        setState(next) {
          /* Once Fast starts from Ultra, keep every tick hidden for the rest
           * of this Fast activation, even after moving to a lower level. */
          if (!next.fast) rail.removeAttribute('data-fast-ticks-hidden');
          else if (next.peak) rail.setAttribute('data-fast-ticks-hidden', '');
          state = next;
          refresh();
        },
        destroy() {
          stop();
          rail.removeAttribute('data-fast-ticks-hidden');
          animations.forEach((animation) => animation.cancel());
          document.removeEventListener('visibilitychange', refresh);
          reduced?.removeEventListener('change', refresh);
        }
      };
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
    function codexFillFor(value, dark, index, total) {
      const bucket = qualityBucketOf(value);
      if (bucket) return (dark ? CODEX_FILL_DARK : CODEX_FILL)[bucket];
      if (Number.isInteger(index) && total > 1) {
        const t = index / (total - 1);
        return codexMixHex(
          dark ? CODEX_FILL_DARK.low : CODEX_FILL.low,
          dark ? CODEX_FILL_DARK.max : CODEX_FILL.max,
          t
        );
      }
      return dark ? '#448dff' : '#3a83f7';
    }
    function codexInkFor(value, dark, index, total) {
      const bucket = qualityBucketOf(value);
      if (bucket) return (dark ? CODEX_INK_DARK : CODEX_INK)[bucket];
      if (Number.isInteger(index) && total > 1) {
        const t = index / (total - 1);
        return codexMixHex(
          dark ? CODEX_INK_DARK.low : CODEX_INK.low,
          dark ? CODEX_INK_DARK.max : CODEX_INK.max,
          t
        );
      }
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
     * 参考图能力：宿主按「提供商 + 模型」下发的**声明层**模板（预设 + 模型规则算出来的
     * 那条，不含用户覆盖）。面板拿它当「支持参考图」的默认勾选值——用户没勾过也能看出
     * 这家网关收不收参考图；取消勾选写的是 `fields.image = null`，所以它不能跟着覆盖走。
     */
    function imageSpecFor(providerId, model) {
      const provider = imageCatalog.capabilities.find((item) => item && item.providerId === providerId);
      const entry = provider && Array.isArray(provider.models)
        ? provider.models.find((item) => item && item.model === model)
        : undefined;
      const spec = entry && entry.image;
      return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
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

    /**
     * 只认工作流参数的协议：A1111 / ComfyUI / SwarmUI 的尺寸与质量写在 workflow 或
     * sdapi 参数里，规则表（/detect-model-rule）里根本没有它们——「一键配置」对这三种
     * 协议没有可写的东西。localai / sd-server 走 OpenAI 兼容参数，不在这里。
     * 也别按 baseUrl 判本地：跑在本机的兼容网关照样该有一键配置。
     */
    const RULELESS_ADAPTERS = ['a1111', 'comfyui', 'swarmui'];

    /**
     * 协议下拉默认只列这几条常用协议。
     *
     * 绝大多数提供商的协议由预设决定（presetId 在的时候根本不用手选），手选协议主要是给
     * 中转站用的——这几条就够。厂商原生 / 本地部署 / 异步任务属于长尾，收进「更多协议…」
     * 里展开；展开后的顺序与分组由宿主的 adapterManifest（adapter.group）给。
     */
    const COMMON_PROTOCOLS = ['openai-images', 'openai-chat', 'openai-responses', 'google-gemini'];

    /** 「更多协议…」的哨兵值：选中它只展开列表，绝不写进配置——它也不是一条协议。 */
    const PROTOCOL_MORE = '__more__';

    /**
     * 「自定义」协议的 id。
     *
     * 它不在宿主的 adapterManifest 里（清单只有真实协议，自定义是按需拼出来的适配器），
     * 标签走 i18n，下拉里由客户端固定补一条。所以凡是「把 draft.adapter 原样回显成选项」的
     * 地方都要先把它排掉：否则一个 adapter 为 custom 的提供商会让下拉里出现两条同值选项，
     * 一条是裸 id、一条是正经标签。
     */
    const CUSTOM_PROTOCOL = 'custom';
    const isCustomProtocol = (id) => String(id || '') === CUSTOM_PROTOCOL;

    /**
     * 模型行（`.modelRow`）里我们自己塞的选项面板：整行铺开，不参与那一行的列宽计算。
     *
     * `.modelRow` 的列模板（拖动把手 / ID / 显示名称 / 展开 / 删除）和窄宽度重排都写在
     * 宿主样式表里，插件不内联抄一份——抄了会盖住宿主的 `@container`，还不会跟着 DSH 升级。
     * 但面板得自己声明跨行：漏了这条，它会被当成下一个网格项排进第 1 列，把 `auto` 轨道
     * 撑大、压塌同一列里的两个输入框。
     */
    const MODEL_ROW_PANEL_STYLE = { gridColumn: '1 / -1', minWidth: 0 };

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

    /**
     * 造一条字段模板。字段名为空就返回 null：`{ path: '' }` 这类模板过不了
     * field-templates 的编译（path 必须非空），写进配置会让请求直接失败。
     * 传法（as）只挂在认它的形状上——multipart 的白名单里没有 as，硬塞会变成坏模板。
     */
    function fieldTemplateOf(kind, name, as) {
      const target = String(name === undefined || name === null ? '' : name).trim();
      if (!target) return null;
      const template = kind === 'multipart' ? { multipart: target } : kind === 'numbered' ? { numbered: target } : { path: target };
      if (as && kind !== 'multipart') template.as = as;
      return template;
    }

    /**
     * 还没配上字段名的传法（`fieldsAs`）：参考图的「传法」可以先选、字段名后填，
     * 那时模板造不出来（空 path 是坏配置），就先把它记在这里，等字段名填上时并进模板。
     *
     * 它只是草稿里的暂存：config-store 的模型选项只认 workflow / mapping / params /
     * expose / size / fields / quality / locked，保存时这个键自然被丢掉——所以配置里
     * 永远不会出现「只有 as、没有 path」的模板。
     */
    function pendingFieldAsOf(entry, key) {
      const map = entry && entry.fieldsAs && typeof entry.fieldsAs === 'object' && !Array.isArray(entry.fieldsAs)
        ? entry.fieldsAs
        : null;
      const value = map && typeof map[key] === 'string' ? map[key] : '';
      return value === 'dataUrl' || value === 'base64' || value === 'url' ? value : '';
    }

    /* ── 参考图的「多图策略」 ──────────────────────────────────────────
     *
     * 三种策略不是三个字段，而是同一份 `fields.image` 的三种形状——读回来从形状反推，
     * 写回去按形状落盘（field-templates 只认这六种形状，加一个 strategy 键会让模板整个坏掉）：
     *
     *   single   { path: 'image' } / { multipart: 'image' }    同一个字段；一张是标量
     *   array    { path: 'image[]' } / { multipart: 'image[]' } 全部追加到同一个字段的数组
     *   numbered { numbered: 'image' }                         image / image_2 / image_3 …
     *
     * `[]` 是「位置」的一部分（追加到数组），不是字段名的一部分，所以输入框里只放底座，
     * 后缀归策略管：切策略时字段名和传法都不会被改掉。
     */

    /** 模板 → 策略。认不出的形状按单张摆（面板总得显示一个值）。 */
    function imageStrategyOf(template) {
      if (!template || typeof template !== 'object' || Array.isArray(template)) return 'single';
      if (typeof template.numbered === 'string' && template.numbered.trim()) return 'numbered';
      return fieldPathOf(template).endsWith('[]') ? 'array' : 'single';
    }

    /** 字段名的底座：去掉策略负责的 [] 后缀（image[] → image）。 */
    function imageNameOf(template) {
      return fieldPathOf(template).replace(/\[\]$/, '');
    }

    /**
     * 模板的「挂法」：multipart 的字段名只能留在 multipart 形状上（换成 path 的话，
     * 表单端点里的参考图会被静默丢掉——multipartFields 只认 multipart），所以策略只在
     * 同一个挂法里换字段名。numbered 没有挂法可言，退回 JSON 路径。
     */
    function imageKindOf(template) {
      const kind = fieldKindOf(template);
      return kind === 'numbered' ? 'path' : kind;
    }

    /**
     * 按策略造一条参考图模板。字段名为空返回 null（空 path 是坏配置，见 fieldTemplateOf）。
     * 字段名自带 [] 也可以：后缀由策略统一给，叠不出 [][]。
     */
    function imageTemplateOf(kind, strategy, name, as) {
      const base = String(name === undefined || name === null ? '' : name).trim().replace(/\[\]$/, '');
      if (!base) return null;
      if (strategy === 'numbered') return fieldTemplateOf('numbered', base, as);
      return fieldTemplateOf(kind === 'multipart' ? 'multipart' : 'path', strategy === 'array' ? base + '[]' : base, as);
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

    /**
     * 质量覆盖的形状兜底：面板只认这一份，两种写法都读得动。
     *
     *   { supported, field, options: [{ label, value, default }] }   ← 「质量」方框（新）
     *   { field, options: [string], default: string }                ← 老配置
     *
     * 老形状按「收质量」（supported 缺省即 true）+ 空显示名处理，顶层 default 折成某一条上的
     * 标记——面板只有「单选」这一种表达。这里不做小写化、去重、去 `off`：那是 config-store
     * 落盘时的活，编辑过程中就地把行改掉会让用户打不出字。
     */
    function qualityStateOf(raw) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const options = (Array.isArray(source.options) ? source.options : []).map((item) => {
        const object = Boolean(item) && typeof item === 'object' && !Array.isArray(item);
        return {
          label: object && typeof item.label === 'string' ? item.label : '',
          value: String(object
            ? (item.value === undefined || item.value === null ? '' : item.value)
            : (item === undefined || item === null ? '' : item)).trim(),
          default: object && item.default === true
        };
      });
      const declared = String(source.default || '').trim().toLowerCase();
      if (declared && !options.some((item) => item.default)) {
        const hit = options.find((item) => item.value.toLowerCase() === declared);
        if (hit) hit.default = true;
      }
      return {
        supported: source.supported !== false,
        field: typeof source.field === 'string' ? source.field.trim() : '',
        options: options
      };
    }

    /** 质量规则 → modelOptions 里能存的覆盖对象（新形状：勾选 + 挡位表 + 那一条的默认标记）。 */
    function qualityOverrideFromRule(quality) {
      if (!quality || typeof quality !== 'object') return null;
      const next = { supported: true };
      if (typeof quality.field === 'string' && quality.field.trim()) next.field = quality.field.trim();
      const wanted = String(quality.default || '').trim().toLowerCase();
      if (Array.isArray(quality.options) && quality.options.length) {
        next.options = quality.options.map((item) => String(item)).map((value) => ({
          label: '',
          value: value,
          default: Boolean(wanted) && value.trim().toLowerCase() === wanted
        }));
      }
      if (quality.map && typeof quality.map === 'object' && !Array.isArray(quality.map)) next.map = { ...quality.map };
      if (wanted) next.default = wanted;
      // 只有 supported 一条不算「规则给了质量说明」：没有字段名、档位表、值映射就没什么可写的。
      return next.field || next.options || next.map ? next : null;
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
          // 用户明确关掉过这个模型的质量（「质量」方框里取消勾选）就跟上锁一样别再打开，
          // 否则一键配置会把「这个模型不发质量参数」这个决定悄悄撤销。
          const declined = Boolean(entry.quality) && typeof entry.quality === 'object'
            && entry.quality.supported === false;
          if (declined) held += 1;
          else {
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
        }
        const resolved = hit.fields && typeof hit.fields === 'object' ? hit.fields : null;
        if (resolved) {
          // 用户在「参考图」方框里取消过勾选（`image: null` / `false` = 显式不发）就像上锁
          // 一样挡住规则：那是「这个模型不发参考图」的决定，别被一键配置悄悄撤销。
          const declined = Boolean(entry.fields && typeof entry.fields === 'object')
            && (entry.fields.image === null || entry.fields.image === false);
          for (const key of FIELD_KEYS) {
            const spec = resolved[key];
            // 没给（undefined）与显式不发（null）都不写：规则已经决定了不发，落盘只会挡住后续重试。
            if (spec === undefined || spec === null || spec === false) continue;
            if (key === 'image' && declined) { held += 1; continue; }
            apply(key, () => {
              const fields = { ...(entry.fields || {}) };
              fields[key] = spec;
              entry.fields = fields;
              // 已经存过离散参数表（「常规」）的模型：内置行的名字就是字段路径，
              // 一起更新，免得配置里 fields 与 params 各说一个名字。用户删掉的行不复活，
              // 行级上锁的行也不动——那正是行锁的意义。
              const fieldName = fieldPathOf(spec);
              if (fieldName && Array.isArray(entry.params)) {
                entry.params = entry.params.map((row) => (
                  row && row.role === key && row.locked !== true ? { ...row, name: fieldName } : row
                ));
              }
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
      // 用户在「质量」方框里写了显示名就用他的（哪怕值是内置档位，比如 low 写成「省钱档」）；
      // 没写才回落到本地化词表。spec.labels 只有覆盖层会带。
      const custom = spec.labels && spec.labels[wanted] ? String(spec.labels[wanted]) : '';
      if (custom) return custom;
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
      if (Array.isArray(data.authModes) && data.authModes.length) imageCatalog.authModes = data.authModes;
      if (Array.isArray(data.outputPresets)) imageCatalog.outputPresets = data.outputPresets;
      if (data.paramDefaults && typeof data.paramDefaults === 'object') imageCatalog.paramDefaults = data.paramDefaults;
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
    function writeImageStore(store, translate, waitForSave = false) {
      const t = translate || fallbackTranslate;
      const next = normalizeImageStore(store);
      const seq = ++configWriteSeq;
      if (!waitForSave) {
        imageStoreCache = next;
        try { window.dispatchEvent(new Event('mo-image-config')); } catch (_error) { /* ignore */ }
      }
      const saving = configWriteChain.then(async () => {
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
          return data.config ? normalizeImageStore(data.config) : next;
        } catch (error) {
          if (seq === configWriteSeq) try {
            window.dispatchEvent(new CustomEvent('mo-image-config-error', {
              detail: { message: serverErrorText(t, error) }
            }));
          } catch (_error) { /* ignore */ }
          throw error;
        }
      });
      configWriteChain = saving.catch(() => {});
      return waitForSave ? saving : next;
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
              h(TipSpan, {
                className: MC.candidateId,
                tip: typeof names[id] === 'string' && names[id] ? names[id] : id,
                tipOptions: { width: 260, onlyWhenClipped: true },
                children: id
              })
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
      const adoptBase = DshButton
        ? h(DshButton, {
          variant: 'outline', disabled: !!props.emptiesList,
          onClick: props.onAdopt
        }, t('picker.adopt'))
        : h('button', {
          type: 'button', className: MC.primaryButton, disabled: !!props.emptiesList,
          onClick: props.onAdopt
        }, t('picker.adopt'));
      // 按钮被禁用时说明原因：气泡挂在外面那层，禁用按钮自己收不到指针事件。
      const adoptButton = props.emptiesList
        ? h(TipSpan, {
          style: { display: 'inline-flex', minWidth: 0 },
          tip: t('picker.keepOne'),
          children: adoptBase
        })
        : adoptBase;
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

    /**
     * 提供商表单的共用布局 —— 新建「自定义模型 API」与编辑已有提供商渲染的就是这段代码。
     *
     * 布局只写一次：常显三件套（API 密钥 / 显示名称 / API 地址）→「协议设置」折叠区
     * →「自定义设置」折叠区（模型目录 / 路由 / 调度模型）→ 按钮行。字段顺序、折叠区的
     * 划分、默认收起都住在这里；以后改一边不会忘了另一边。
     *
     * 差异全部由参数表达，而且都只是「有 / 没有」，不是另一套布局：
     *   - leading        新建才有的「第三方 → 本地 → 自定义」模式开关
     *   - identity       新建目录模式才有的厂商预设下拉（编辑页没有「选哪家」这一步）
     *   - notice         认不出来源时的顶栏提醒（在 API 密钥上方，没有就是 null）
     *   - fields         各字段块；某一侧没有的（比如新建没有的已存密钥回显）传 null
     *   - protocolFields 协议设置里的一组控件：协议 → 鉴权 → 图生图端点 → 返回格式
     *   - advancedFields 自定义设置里的一组控件
     *   - presetSourced  预设来源整块不渲染协议设置：判据只在这一处
     *   - protocolOpen / advancedOpen + onToggle：开合是调用方的受控状态，默认收起
     *   - body           目录 / 本地两条入口沿用它们自己的平铺字段（本来就没有折叠区）
     *   - actions        按钮行（新建与编辑各自决定文案与提交行为）
     *   - modelPicker    拉取模型用的弹窗
     */
    function ProviderFormLayout(options) {
      const t = options.t || fallbackTranslate;
      const fields = options.fields || {};
      /** 一个折叠区：标题即入口，开合状态由调用方持有（默认收起）。 */
      const section = (labelKey, marker, open, onToggle, content) => h('details', {
        className: MC.customized,
        [marker]: '',
        open: !!open,
        onToggle: onToggle
      },
        h('summary', { className: MC.customizedSummary }, t(labelKey)),
        h('div', { className: MC.customizedBody }, content || null)
      );
      return h('div', { className: MC.editor },
        options.leading || null,
        options.identity || null,
        options.body || h(React.Fragment, null,
          // 提醒排在最前：它在 API 密钥上方，读起来是「先看这一句，再开始填」。
          options.notice || null,
          fields.key,
          fields.name,
          fields.url,
          // 预设来源：协议 / 鉴权 / 返回格式都由预设写好，整块不渲染（值仍在 draft 里，保存原样带回）。
          options.presetSourced ? null : section('form.protocolSettings', 'data-mo-image-protocol-settings',
            options.protocolOpen, options.onProtocolToggle, options.protocolFields),
          // 自定义设置：从主字段派生出来的接入细节，改一次就很少再动，默认收起。
          section('form.advanced', 'data-mo-image-advanced',
            options.advancedOpen, options.onAdvancedToggle, options.advancedFields)
        ),
        options.actions,
        options.modelPicker
      );
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
        // 协议级选项（edit）：只存用户真的选过的值，缺省 = 协议声明的默认值。
        protocolOptions: { ...(props.provider.protocolOptions || {}) },
        // 鉴权方式是提供商字段（provider.auth）：不跟协议走，所以单独一栏。
        auth: authDraftOf(props.provider),
        optionalKey: !!props.provider.optionalKey,
        // 预设来源：决定锁的默认值（有它全锁）与「一键配置」显不显示。
        presetId: props.provider.presetId || '',
        models: (props.provider.models || []).slice(),
        names: { ...(props.provider.names || {}) },
        modelOptions: { ...(props.provider.modelOptions || {}) }
      }));
      const [optionsFor, setOptionsFor] = React.useState('');
      const [operationTexts, setOperationTexts] = React.useState({});
      const [submitError, setSubmitError] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const connectionInFlight = React.useRef(new Set());
      const [advanced, setAdvanced] = React.useState(false);
      // 「协议设置」折叠区的展开状态：默认收起（自己填地址的提供商多数只改密钥 / 地址 / 模型目录）。
      // 预设来源的提供商整块不渲染，这个状态对它们没有意义。
      const [protocolOpen, setProtocolOpen] = React.useState(false);
      // 协议下拉是否展开了长尾协议：只活在这一次面板里，不进配置（面板重开就是收起的）。
      const [protocolExpanded, setProtocolExpanded] = React.useState(false);
      // 「自动识别」的结果提示（busy / ok / warn）：同样只是这一屏的话，不落盘。
      const [protocolNote, setProtocolNote] = React.useState({ busy: false, tone: '', text: '' });
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
      // 参数行删除的二次确认：只活在这一屏（不落盘）。3 秒没点第二次就复原。
      const [pendingParamRemove, setPendingParamRemove] = React.useState('');
      const pendingParamRemoveTimer = React.useRef(0);
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
        setOperationTexts({});
        setDraft((previous) => ({
          ...previous,
          name: next.name,
          baseUrl: next.baseUrl,
          adapter: next.adapter,
          protocol: 'openai-images',
          protocolOptions: { ...(next.protocolOptions || {}) },
          // 预设可以自带鉴权形态（Azure 的 api-key）：换预设就换成它，与换协议无关。
          auth: authDraftOf(next),
          optionalKey: next.optionalKey,
          presetId: next.id,
          operations: next.operations,
          customEndpoints: { ...(next.customEndpoints || {}) },
          modelOptions: { ...(next.modelOptions || {}) },
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
          setOperationTexts({});
          setDraft((previous) => ({
            ...previous,
            name: nextPreset ? nextPreset.name : '',
            baseUrl: nextPreset ? nextPreset.baseUrl : '',
            adapter: nextPreset ? (nextPreset.adapter || '') : '',
            protocol: nextPreset ? (nextPreset.protocol || 'openai-images') : 'openai-images',
            protocolOptions: { ...((nextPreset && nextPreset.protocolOptions) || {}) },
            auth: authDraftOf(nextPreset),
            optionalKey: false,
            presetId: nextPreset ? nextPreset.id : '',
            operations: nextPreset?.operations,
            customEndpoints: { ...(nextPreset?.customEndpoints || {}) },
            modelOptions: { ...(nextPreset?.modelOptions || {}) },
            key: '',
            models: nextPreset ? (nextPreset.models || []).slice() : [],
            names: {}
          }));
        } else {
          setDraft((previous) => ({
            ...previous,
            adapter: '',
            protocol: 'openai-images',
            protocolOptions: {},
            auth: {},
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
          protocolOptions: { ...(preset.protocolOptions || {}) },
          auth: authDraftOf(preset),
          optionalKey: false,
          presetId: preset.id,
          operations: preset.operations,
          customEndpoints: { ...(preset.customEndpoints || {}) },
          modelOptions: { ...(preset.modelOptions || {}) },
          models: (preset.models || []).slice(),
          names: {}
        }));
      }, [isNew, mode, providerPresets.length, presetId]);
      const operationsOf = (model) => {
        const source = model ? draft.modelOptions[model] : draft;
        const text = operationTexts[model || ''];
        if (text === undefined) return source?.operations;
        if (!text.trim()) return undefined;
        let parsed;
        try { parsed = JSON.parse(text); } catch (_error) { throw new Error(t('form.operationsInvalidJson')); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('form.operationsInvalidJson'));
        return parsed;
      };
      let providerOperations;
      let operationsError;
      try { providerOperations = operationsOf(''); } catch (error) { operationsError = error; }
      const connectionDraft = () => {
        if (operationsError) throw operationsError;
        return {
          providerId: isNew ? '' : draft.id,
          baseUrl: draft.baseUrl.trim(),
          adapter: draft.adapter,
          protocol: draft.protocol,
          protocolOptions: draft.protocolOptions,
          auth: draft.auth,
          optionalKey: draft.optionalKey,
          customEndpoints: draft.customEndpoints,
          operations: providerOperations || null,
          key: draft.key.trim()
        };
      };
      const customPathOf = (kind) => String(providerOperations?.[kind]?.path ?? draft.customEndpoints?.[kind] ?? '').trim();
      let connectionBase = draft.baseUrl.trim();
      if (!connectionBase && draft.adapter === 'custom') {
        for (const kind of ['generate', 'edit', 'models']) {
          try {
            const url = new URL(customPathOf(kind));
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            connectionBase = url.origin;
            break;
          } catch (_error) { /* a relative endpoint needs an explicit or inferred base */ }
        }
      }
      const canFetchModels = draft.adapter === 'custom'
        ? Boolean(customPathOf('models'))
        : (!draft.adapter || adapterSupportsModels(draft.adapter));
      const closeCandidates = () => {
        setCandidates(null);
        setCandidateQuery('');
        setFlipped(new Set());
        setShowAllCandidates(false);
      };
      const fetchModels = async () => {
        if (connectionInFlight.current.has('models')) return;
        connectionInFlight.current.add('models');
        setModelFetch({ loading: true, error: '' });
        try {
          const draftConnection = connectionDraft();
          const response = await fetch('/api/mo-image/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...draftConnection, known: draft.models.filter(Boolean) }),
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
        } finally { connectionInFlight.current.delete('models'); }
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
      // 本地预设的地址提示（urlHint / hint）不再渲染：表单只留字段本身，
      // 选哪个部署器由上面的下拉说明，字段下面不重复铺说明文字。
      const urlPlaceholder = mode === 'local' && localPreset ? localPreset.baseUrl : 'https://gateway.example/v1';
      const urlField = h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, t('form.baseUrl')),
        h('input', {
          className: MC.input,
          value: draft.baseUrl,
          // 改地址**不动** presetId：同一家提供商换个地址（反代、换域名、私有化部署）很常见，
          // 它仍然是那份预设带来的字段模板与锁。真要换一套配置，用户可以另建一个提供商。
          onChange: (e) => setDraft({ ...draft, baseUrl: e.target.value }),
          placeholder: urlPlaceholder
        })
      );
      /** 协议声明的是相对路径，面板里要看的是拼好 baseUrl 之后真正会被请求的地址。 */
      const joinRoute = (base, route) => {
        const path = String(route || '').trim();
        if (!path) return '';
        if (/^https?:\/\//i.test(path)) return path;
        const root = String(base || '').trim().replace(/\/+$/, '');
        if (!root) return path;
        const [withoutHash] = root.split('#');
        const queryAt = withoutHash.indexOf('?');
        const prefix = queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt);
        const url = prefix.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
        if (queryAt < 0) return url;
        try {
          const target = new URL(url);
          const overridden = new Set(target.searchParams.keys());
          for (const [name, value] of new URLSearchParams(withoutHash.slice(queryAt + 1))) {
            if (!overridden.has(name)) target.searchParams.append(name, value);
          }
          return target.href.replace(/%7Bmodel%7D/gi, '{model}');
        } catch (_error) { return url; }
      };
      /** 当前协议声明的协议级选项（edit）：没有选项的协议整块不渲染。 */
      const protocolOptions = (() => {
        const hit = imageCatalog.adapters.find((item) => item && item.id === (draft.adapter || ''));
        return hit && Array.isArray(hit.options) ? hit.options.filter((spec) => spec && spec.name) : [];
      })();
      /** 某个选项当前生效的取值：没选过（或存坏了）就回落到协议声明的默认值。 */
      const protocolOptionValueOf = (spec) => {
        const raw = String((draft.protocolOptions || {})[spec.name] || '');
        return spec.values.includes(raw) ? raw : spec.default;
      };
      /**
       * 协议声明的三条地址。
       * 带协议级选项的协议（现在只有 openai-images 的 edit）会给出每个取值下的地址，
       * 这里按当前选择叠一层——「edit:'same' 就是 /images/generations」这种知识
       * 只写在宿主（lib/adapters.js 的 PROTOCOL_OPTIONS），客户端不复制一份。
       */
      const routesOf = (id) => {
        const hit = imageCatalog.adapters.find((item) => item && item.id === id);
        let routes = (hit && hit.routes) || { generate: '', edit: '', models: '' };
        const withRoutes = (hit && Array.isArray(hit.options) ? hit.options : [])
          .filter((spec) => spec && spec.routes && typeof spec.routes === 'object');
        for (const spec of withRoutes) {
          const picked = protocolOptionValueOf(spec);
          const overrides = spec.routes[picked];
          if (overrides) routes = { ...routes, ...overrides };
        }
        return routes;
      };
      /** 一类请求在当前地址下的真实地址；自定义协议的三条端点就是用户自己填的那三个。 */
      const routeValueOf = (kind) => {
        const path = draft.adapter === 'custom' ? customPathOf(kind) : routesOf(draft.adapter)[kind];
        return joinRoute(connectionBase, path) || t('form.routeUnsupported');
      };
      // 协议 label 右侧的问号：三条真实地址收进即时气泡，一行一条，不再各占一行版面。
      const routeHelp = h(RouteHelp, {
        className: MC.helpButton,
        label: t('form.protocolRoutes'),
        text: [
          t('form.route.generate') + '：' + routeValueOf('generate'),
          t('form.route.edit') + '：' + routeValueOf('edit'),
          t('form.route.models') + '：' + routeValueOf('models')
        ].join('\n')
      });
      const protocolField = (() => {
        /**
         * 协议名：宿主下发的 label 是 i18n key（protocol.<id>），按当前语言翻；认不出的 key
         * 退回 id——老清单或测试夹具里是纯文本 label，就原样显示。
         */
        const protocolLabelOf = (item) => {
          const raw = String((item && item.label) || '');
          const id = String((item && item.id) || '');
          if (!raw.startsWith('protocol.')) return raw || id;
          const value = t(raw);
          return value === raw ? id : value;
        };
        const adapterOptions = imageCatalog.adapters.filter((item) => item && item.id);
        const commonAdapters = COMMON_PROTOCOLS
          .map((id) => adapterOptions.find((item) => item.id === id))
          .filter(Boolean);
        const adapterOptionOf = (item) => h('option', { key: item.id, value: item.id }, protocolLabelOf(item));
        /** 分段标题：清单里的 group 没有对应文案时就不分段（老清单别把 key 显示出来）。 */
        const groupLabelOf = (group) => {
          if (!group) return '';
          const key = 'protocolGroup.' + group;
          const value = t(key);
          return value === key ? '' : value;
        };
        /** 展开后的清单按宿主给的 group 分段（顺序已经是「通用 → 网关 → 原生 → 本地 → 异步」）。 */
        const groupedAdapters = () => {
          const buckets = [];
          for (const adapter of adapterOptions) {
            const group = String(adapter.group || '');
            let bucket = buckets.find((item) => item.group === group);
            if (!bucket) { bucket = { group: group, items: [] }; buckets.push(bucket); }
            bucket.items.push(adapter);
          }
          return buckets;
        };
        /**
         * 下拉里的选项。
         *
         * 17 条协议平铺一长串，展开就像「一堆协议」；默认只给常用几条 + 自定义 + 更多协议…，
         * 点开「更多协议…」才分组铺开全部（展开状态是 UI，不是配置值）。
         */
        const protocolNodes = () => {
          const nodes = [];
          // 「自动」：协议没选过（adapter 为空）时的当前状态，本身不能再被选中（按钮才是动作）。
          if (!draft.adapter) {
            nodes.push(h('option', { key: 'auto', value: '', disabled: true }, t('form.protocolAuto')));
          }
          if (protocolExpanded) {
            for (const bucket of groupedAdapters()) {
              const label = groupLabelOf(bucket.group);
              const items = bucket.items.map(adapterOptionOf);
              nodes.push(label
                ? h('optgroup', { key: 'group:' + bucket.group, label: label }, items)
                : h(React.Fragment, { key: 'group:' + bucket.group }, items));
            }
          } else {
            for (const adapter of commonAdapters) nodes.push(adapterOptionOf(adapter));
            // 收起时也要能显示已选的长尾协议：否则下拉退回第一项，看起来像「没选」。
            // 「自定义」不在清单里，下面固定补一条 i18n 标签的，别把它当成漏掉的 id 再列一遍。
            if (draft.adapter && !isCustomProtocol(draft.adapter) && !commonAdapters.some((item) => item.id === draft.adapter)) {
              const hit = adapterOptions.find((item) => item.id === draft.adapter);
              nodes.push(adapterOptionOf(hit || { id: draft.adapter, label: '' }));
            }
          }
          // 配置里存着一条清单里已经没有的协议（插件降级/手改过）：原样列出来，别静默改名。
          // 「自定义」同样跳过：它永远不在清单里，但它是上面那条正经选项，不是漏掉的协议。
          if (protocolExpanded && draft.adapter && !isCustomProtocol(draft.adapter) && !adapterOptions.some((item) => item.id === draft.adapter)) {
            nodes.push(h('option', { key: 'stale', value: draft.adapter }, draft.adapter));
          }
          nodes.push(h('option', { key: CUSTOM_PROTOCOL, value: CUSTOM_PROTOCOL }, t('form.customProtocol')));
          // 已经展开了就不用再给入口。
          if (!protocolExpanded) nodes.push(h('option', { key: 'more', value: PROTOCOL_MORE }, t('form.protocolMore')));
          return nodes;
        };
        /**
         * 「识别协议」按钮（原来是下拉里的「自动识别」一项）。
         *
         * 一次识别 = 客户端驱动的一小段循环，**每轮只问宿主一条路径**：
         *   1. 先问一次（不带 probe）：宿主做静态判定——主机 + 模型名认得出具体协议，
         *      或者地址是已知的 OpenAI 兼容主机，就直接给结论，一个上游请求都不发；
         *   2. 认不出来时宿主只返回**探测顺序**（公网 `/models` 打头、再试本地那三条，
         *      内网反过来），客户端按顺序逐条请求，每发一条就把「正在尝试访问 xxx」
         *      写进提示——用户看到的是真实进度，不是假轮播；
         *   3. 哪条回来说的形状能证明某个协议就停（宿主只翻译形状，「命中即停」与
         *      顺序都在这里）；全都不中就切自定义，提示里带上最后试过的路径。
         *
         * **手选过协议时改成「只校验」**：下拉里已经是某条具体协议（不是「自动」、
         * 不是「自定义」），就把它作为 expectedProtocol 一起送去；宿主的顺序会以
         * 那条协议自己的探针打头，这里**不写回任何字段**（协议、协议级选项一律不动）。
         * 没通过时把「看起来像谁」写进提示，要不要采纳由用户点下拉决定。
         */
        /** 忙碌时按钮里的转圈：内联 SVG，不依赖宿主样式表里有没有 spinner 类。 */
        const detectSpinner = () => h('span', {
          'data-mo-image-spinner': '',
          'aria-hidden': 'true',
          style: { display: 'inline-flex', width: 12, height: 12, marginRight: 6, verticalAlign: '-1px' }
        }, h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, focusable: 'false' },
          h('circle', {
            cx: 8, cy: 8, r: 6, fill: 'none',
            stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 2
          }),
          h('path', {
            d: 'M8 2a6 6 0 0 1 6 6', fill: 'none',
            stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round'
          }, h('animateTransform', {
            attributeName: 'transform', type: 'rotate', from: '0 8 8', to: '360 8 8',
            dur: '0.9s', repeatCount: 'indefinite'
          }))));
        /** 把一次「终局」结论写回界面：切协议 / 写提示 / 校验模式一个字都不改 draft。 */
        const applyDetectResult = (data) => {
          const protocol = String((data && data.protocol) || '').trim();
          if (!protocol) throw new Error(t('errors.detectProtocol'));
          const label = protocolLabelOf({ id: protocol, label: 'protocol.' + protocol });
          // 探针细节：命中的路径 + 返回形状（形状是协议清单里那四种之一）。缺文案时
          // 退回形状 id，至少不会显示成半截 key。openai-images 是通用兜底：`{data:[...]}`
          // 只证明「兼容」、说不出是谁，所以不带细节（保持原来的提示形状）。
          const probePath = String((data && data.probe) || '');
          const shapeId = String((data && data.shape) || '');
          const shapeKey = shapeId ? 'form.probeShape.' + shapeId : '';
          const shapeLabel = shapeKey ? t(shapeKey) : '';
          const details = probePath && protocol !== 'openai-images'
            ? { probe: probePath, shape: shapeLabel && shapeLabel !== shapeKey ? shapeLabel : shapeId }
            : null;
          const withProbe = (key) => (details
            ? t(key, { protocol: label, probe: details.probe, shape: details.shape })
            : t(key, { protocol: label }));
          // 全都不中时把「最后试过哪条」带上：用户得知道这次识别走到哪一步才放弃的。
          const lastTried = String((data && data.lastProbe) || '');
          const withLastTried = (text) => (lastTried
            ? text + t('form.detectProtocolLastTried', { path: lastTried })
            : text);
          // 失败指针（401 / 404 / 超时 …）：有它就不再甩一句笼统的「没认出协议」。
          // `issue` 是调用方已经翻好的文案（宿主回的状态 → probeIssueText），这里只排版。
          const issue = String((data && data.issue) || '');
          const issueKind = String((data && data.issueKind) || '');
          // 连不上 / 超时：连都没连上就无从判断「像不像」，只说连不上，保住那句「没认出」反而自相矛盾。
          const connectionFailure = issueKind === 'network' || issueKind === 'timeout';
          // 校验模式：只报告像不像，一个字都不写回 draft。
          if (data && (data.verified === true || data.verified === false)) {
            const verified = data.verified === true;
            const suggestedId = String((data && data.suggested) || '');
            const suggestedLabel = suggestedId
              ? protocolLabelOf({ id: suggestedId, label: 'protocol.' + suggestedId })
              : '';
            const mismatch = suggestedLabel
              ? t('form.detectProtocolMismatchSuggested', { protocol: label, suggested: suggestedLabel })
              : t('form.detectProtocolMismatch', { protocol: label });
            const text = verified
              ? withProbe(details ? 'form.detectProtocolVerifiedProbe' : 'form.detectProtocolVerified')
              : (issue
                ? (connectionFailure
                  ? issue
                  : mismatch + t('form.detectProtocolIssueSuffix', { issue: issue }))
                : withLastTried(mismatch));
            setProtocolNote({ busy: false, tone: verified ? 'ok' : 'warn', text: text });
            return;
          }
          // 切协议 = 换一套协议级选项。宿主认出「已知主机」时会连选项一起给
          // （Azure 的鉴权头形态是 api-key、方舟的编辑端点是同一个 generations），
          // 那是这次识别的结论，照抄；没给就是全走默认。自定义兜底顺手把三条相对地址
          // 填好（与 baseUrl 拼）。
          const detectedOptions = data && data.protocolOptions && typeof data.protocolOptions === 'object'
            ? data.protocolOptions
            : {};
          // 鉴权（provider.auth）是提供商字段：识别出 Azure 这类「只认某个头」的主机时一并带回来；
          // 没带就保留用户自己填的那一栏——一次识别不该把鉴权清空。
          const detectedMode = String((data && data.auth && data.auth.mode) || '');
          const detectedAuth = authModesForUi().includes(detectedMode) ? authDraftOf(data) : null;
          setDraft((prev) => {
            const next = { ...prev, adapter: protocol, protocolOptions: { ...detectedOptions } };
            if (detectedAuth && !prev.auth?.mode) next.auth = detectedAuth;
            if (protocol === 'custom') {
              next.customEndpoints = {
                generate: '/images/generations',
                edit: '/images/edits',
                models: '/models',
                ...prev.customEndpoints
              };
            }
            return next;
          });
          setProtocolExpanded(false);
          // 连不上/超时的文案自带句号；接「；已切到自定义…」前把句号收掉，别出现「。；」。
          const issueWithSuffix = issue
            ? issue.replace(/[。．.]$/, '') + t('form.detectProtocolSwitchedToCustom')
            : '';
          const text = protocol === 'custom'
            ? (issue ? issueWithSuffix : withLastTried(t('form.detectProtocolCustom')))
            : (details
              ? withProbe('form.detectProtocolProbe')
              : (data && data.matched
                ? t('form.detectProtocolMatched', { protocol: label })
                : t('form.detectProtocolCompatible', { protocol: label })));
          setProtocolNote({ busy: false, tone: protocol === 'custom' ? 'warn' : 'ok', text: text });
        };
        const detectProtocol = async () => {
          if (connectionInFlight.current.has('detect')) return;
          if (!connectionBase) {
            setProtocolNote({ busy: false, tone: 'warn', text: t('form.fetchNeedsBaseUrl') });
            return;
          }
          // 具体协议（清单里有的 id）才进校验模式；'' / 'custom' / 「更多协议…」都不算。
          const picked = String(draft.adapter || '');
          const expectedProtocol = adapterOptions.some((item) => item.id === picked) ? picked : '';
          connectionInFlight.current.add('detect');
          setProtocolNote({ busy: true, tone: '', text: t('form.detectProtocolBusy') });
          try {
            const connection = connectionDraft();
            /** 问宿主：probe 为空 = 静态结论或探测顺序；否则只探这一条路径。 */
            const ask = async (probe) => {
              const payload = {
                ...connection,
                // 协议匹配也看模型名（百炼 Qwen-Image 这类），没有模型就只按主机判。
                model: String((draft.models || []).find((id) => typeof id === 'string' && id.trim()) || '').trim(),
                // 手选了协议 = 只校验；空着 = 让宿主判断这个地址像谁。
                expectedProtocol: expectedProtocol
              };
              if (probe) payload.probe = probe;
              const response = await fetch('/api/mo-image/detect-protocol', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(20000)
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) throw responseError(data, response.status, 'errors.detectProtocol', t);
              return data && typeof data === 'object' ? data : {};
            };
            const start = await ask('');
            if (start.done === true) {
              applyDetectResult(start);
              return;
            }
            const probes = Array.isArray(start.probes)
              ? start.probes.filter((path) => typeof path === 'string' && path)
              : [];
            if (!probes.length) throw new Error(t('errors.detectProtocol'));
            // 宿主在探测前就知道「没有可用的 Key」：这个事实要进最终提示，不能让 401 一律
            // 说成「Key 无效」（也可能是根本没填 / 凭据库解析不出来）。
            const credentialMissing = start.credential === 'missing';
            // 校验模式下宿主的顺序一定以「用户选的那条协议的探针」打头，它就是校验目标。
            const expectedProbe = expectedProtocol ? probes[0] : '';
            let suggested = '';
            let suggestedProbe = '';
            let lastProbe = '';
            let issue = null;
            for (const probe of probes) {
              lastProbe = probe;
              // 进度是真的：请求发出去之前就写清现在试的是哪条路径。
              setProtocolNote({ busy: true, tone: '', text: t('form.detectProtocolTrying', { path: probe }) });
              const step = await ask(probe);
              const protocols = Array.isArray(step.protocols)
                ? step.protocols.filter((id) => typeof id === 'string' && id)
                : [];
              if (!protocols.length) {
                // 没命中就记下失败指针；判断逻辑不变——401 / 404 / 超时都只是失败，
                // 不是「另一种命中」。
                issue = dominantProbeIssue(issue, probeIssueOf(step));
                continue;
              }
              if (expectedProtocol) {
                // 这条形状能证明用户选的协议 → 校验通过；否则记下「更像谁」继续问。
                if (protocols.includes(expectedProtocol)) {
                  applyDetectResult({
                    protocol: expectedProtocol, matched: true, probed: true, verified: true,
                    probe: probe, shape: step.shape
                  });
                  return;
                }
                if (!suggested) { suggested = protocols[0]; suggestedProbe = probe; }
                continue;
              }
              applyDetectResult({
                protocol: protocols[0], matched: false, probed: true, probe: probe, shape: step.shape
              });
              return;
            }
            // 全都不中：校验模式保留原协议、只报告「不像」；自动模式落自定义。
            // 两种都把失败指针写进提示：401 指 Key、404 指地址、超时 / 连不上指网络，别合成一句。
            const connectionFailure = issue && (issue.kind === 'network' || issue.kind === 'timeout');
            // 连不上 / 超时说不清「像不像」：该报的是用户所选协议自己的探针（就看协议清单里
            // 它声明的 models 路由，不依赖探测顺序），「自动」则报探测顺序里的第一条；
            // 地址给 baseUrl + 探针拼好的完整 URL。
            const expectedAdapter = adapterOptions.find((item) => item.id === expectedProtocol);
            const expectedRoute = String((expectedAdapter && expectedAdapter.routes && expectedAdapter.routes.models) || '');
            const connectionProbe = expectedRoute && probes.includes(expectedRoute) ? expectedRoute : probes[0];
            const issueText = probeIssueText(t, issue && connectionFailure
              ? { ...issue, probe: connectionProbe, url: joinRoute(connectionBase, connectionProbe) }
              : issue, credentialMissing);
            if (expectedProtocol) {
              applyDetectResult({
                protocol: expectedProtocol, matched: false, probed: true, verified: false,
                probe: expectedProbe, suggested: suggested, suggestedProbe: suggestedProbe,
                lastProbe: lastProbe, issue: issueText, issueKind: issue && issue.kind
              });
              return;
            }
            applyDetectResult({
              protocol: 'custom', matched: false, probed: true, lastProbe: lastProbe,
              issue: issueText, issueKind: issue && issue.kind
            });
          } catch (error) {
            setProtocolNote({ busy: false, tone: 'warn', text: serverErrorText(t, error) });
          } finally { connectionInFlight.current.delete('detect'); }
        };
        const detectButton = h('button', {
          type: 'button',
          className: MC.linkButton,
          'data-mo-image-detect-protocol': '',
          title: t('form.detectProtocol'),
          disabled: protocolNote.busy,
          'aria-busy': protocolNote.busy ? 'true' : undefined,
          style: { flex: 'none', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' },
          // 返回 promise 只为测试能 await；浏览器忽略返回值。
          onClick: () => detectProtocol()
        }, protocolNote.busy
          ? h(React.Fragment, null, detectSpinner(), t('form.detectProtocolBusy'))
          : t('form.detectProtocol'));
        return h('div', { className: MC.field },
          // label 与问号一行：问号在 label 自己的容器里，hover 互不影响。
          h('div', {
            'data-mo-image-protocol-label-row': '',
            style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
          },
            h('label', { className: MC.fieldLabel, style: { margin: 0 } }, t('form.protocol')),
            routeHelp
          ),
          // 识别按钮紧贴下拉框右侧，和它同处一行；不要塞进 label 里。
          h('div', {
            'data-mo-image-protocol-row': '',
            style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
          },
            h('select', {
              className: MC.input + ' ' + MC.selectInput,
              'data-mo-image-protocol': '',
              style: { flex: '1 1 auto', minWidth: 0 },
              value: draft.adapter || '',
              onChange: (e) => {
                const picked = String(e.target.value || '');
                // 「更多协议…」只展开列表，不改配置：它不是一个能存下来的协议。
                if (picked === PROTOCOL_MORE) { setProtocolExpanded(true); return; }
                setProtocolExpanded(false);
                // 换协议 = 换一套选项：旧协议的选项对新协议没有意义，一律回到新协议的默认值；
                // 上一次识别的提示也一并作废，免得「已识别为 X」挂在另一个协议下面。
                setProtocolNote({ busy: false, tone: '', text: '' });
                setDraft({ ...draft, adapter: picked, protocolOptions: {} });
              }
            }, protocolNodes()),
            detectButton
          ),
          protocolNote.text
            ? h('p', {
                className: MC.advancedHint,
                style: { margin: 0 },
                'data-mo-image-protocol-note': protocolNote.tone || 'info'
              }, protocolNote.text)
            : null
        );
      })();
      /**
       * 协议级选项（现在只剩图生图端点 edit）。
       *
       * 文案键是拼出来的（form.protocolOption <name> / <value> / Hint），所以先把键拼成
       * 变量再交给 t()，不写字面量参数——半截键会被 test/locales.test.mjs 的
       * 「every literal t() key」用例当成一个真的键。缺失的键由同一文件的
       * 「dynamic protocol option keys」用例兜住。
       */
      const protocolOptionText = (suffix) => {
        const key = 'form.protocolOption.' + suffix;
        return t(key);
      };
      /** 单个协议级选项的控件（现在只剩图生图端点）：位置固定在协议下拉下面，跟协议一起常显。 */
      const protocolOptionField = (spec) => {
        const hintText = protocolOptionText(spec.name + 'Hint');
        // 图生图端点只显示路径本身；none 说「不支持」。
        const valueText = (value) => {
          if (spec.name !== 'edit') return protocolOptionText(spec.name + '.' + value);
          if (value === 'edits') return '/images/edits';
          if (value === 'same') return '/images/generations';
          return t('form.routeUnsupported');
        };
        return h('div', { className: MC.field, key: spec.name },
          h('div', {
            'data-protocol-option-label': spec.name,
            style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
          },
            h('label', { className: MC.fieldLabel, style: { margin: 0 } }, protocolOptionText(spec.name))),
          h('select', {
            className: MC.input + ' ' + MC.selectInput,
            'data-mo-image-protocol-option': spec.name,
            value: protocolOptionValueOf(spec),
            onChange: (e) => setDraft((prev) => ({
              ...prev,
              protocolOptions: { ...(prev.protocolOptions || {}), [spec.name]: e.target.value }
            }))
          }, spec.values.map((value) => h('option', { key: value, value: value }, valueText(value)))),
          spec.name === 'edit'
            ? null
            : h('p', { className: MC.advancedHint, style: { margin: 0 } }, hintText)
        );
      };
      /**
       * 鉴权方式：**提供商自己的字段**（`provider.auth`），不是协议级选项。
       *
       * 为什么放在这里、为什么常显：它回答「这个地址怎么认证」，和 API 地址是一对，所以紧跟
       * 在地址下面、排在协议下拉上面，不跟着「高级」折叠。识别协议失败的绝大多数原因是 401，
       * 鉴权摆在协议上方，排查时不用在地址区和协议区之间来回看。
       * 也正因为它是提供商字段，**任何协议下都显示**——切到 ComfyUI / 百炼 / Gemini 不会消失。
       *
       * 文案键是拼出来的（form.auth / form.auth.<mode> / form.authHint），所以先把键拼成变量
       * 再交给 t()，不写字面量参数（见 test/locales.test.mjs 的说明）。
       */
      const authText = (suffix) => t('form.auth' + (suffix || ''));
      const authField = (() => {
        const modes = authModesForUi();
        const auth = draft.auth && typeof draft.auth === 'object' ? draft.auth : {};
        const declared = String(auth.mode || '');
        const preset = providerPresets.concat(localPresets).find((item) => item.id === draft.presetId
          && item.adapter === draft.adapter);
        const defaultAuth = preset?.defaultAuth || imageCatalog.adapters.find((item) => item.id === draft.adapter)?.defaultAuth;
        // 显式写过就回显它；没写（或写坏了）=「跟随协议」——不落 provider.auth，
        // 请求时回落到协议自己的默认形态（authSpecOf）。
        const mode = modes.includes(declared) ? declared : '';
        // 改一项不动其它项：切回 custom 时上次填的头名/前缀还在，省一次重填。
        const update = (patch) => setDraft((prev) => ({
          ...prev,
          auth: { ...(prev.auth && typeof prev.auth === 'object' ? prev.auth : {}), ...patch }
        }));
        const customFields = mode === 'custom'
          ? h('div', { 'data-mo-image-auth-custom': '', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: MC.field },
                h('label', { className: MC.fieldLabel }, authText('Header')),
                h('input', {
                  className: MC.input,
                  name: 'auth-header',
                  value: String(auth.header || ''),
                  placeholder: 'X-API-Key',
                  onChange: (e) => update({ header: e.target.value })
                })),
              h('div', { className: MC.field },
                h('label', { className: MC.fieldLabel }, authText('Prefix')),
                h('input', {
                  className: MC.input,
                  name: 'auth-prefix',
                  value: String(auth.prefix || ''),
                  placeholder: 'Bearer ',
                  onChange: (e) => update({ prefix: e.target.value })
                })))
          : null;
        const queryField = mode === 'query' ? h('label', { className: MC.field },
          h('span', { className: MC.fieldLabel }, authText('QueryName')),
          h('input', {
            className: MC.input,
            name: 'auth-query',
            value: String(auth.name || ''),
            placeholder: 'api_key',
            onChange: (e) => update({ name: e.target.value })
          })
        ) : null;
        return h('div', { className: MC.field, 'data-mo-image-auth': '' },
          h('div', {
            'data-mo-image-auth-label-row': '',
            style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
          },
            h('label', { className: MC.fieldLabel, style: { margin: 0 } }, authText('')),
            h(HelpTip, {
              text: authText('Hint'),
              label: authText(''),
              attributes: { 'data-mo-image-auth-help': '' }
            })),
          h('select', {
            className: MC.input + ' ' + MC.selectInput,
            'data-mo-image-auth-mode': '',
            value: mode,
            onChange: (e) => update({ mode: e.target.value })
          }, h('option', { value: '' }, defaultAuth
            ? t('form.authFollow') + ' · ' + (defaultAuth.header || authText('.' + defaultAuth.mode))
            : t('form.authFollow')),
          modes.map((value) => h('option', { key: value, value: value }, authText('.' + value)))),
          customFields,
          queryField
        );
      })();
      // 协议级选项（图生图端点）紧跟协议下拉、常显：它是协议的属性，不进「高级」折叠区。
      const protocolOptionsField = protocolOptions.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            protocolOptions.map((spec) => protocolOptionField(spec))
          )
        : null;
      // 自定义协议的三条端点没法从协议表里推出来，仍旧给三个输入框。
      // 示例写相对路径：这三个字段本来就和上面的 baseUrl 拼，给完整地址会让人以为要填整条 URL。
      const ROUTE_PLACEHOLDER = { generate: '/images/generations', edit: '/images/edits', models: '/models' };
      const routeField = (kind, label) => h('div', { className: MC.field, key: kind },
        h('label', { className: MC.fieldLabel }, label),
        h('input', {
          className: MC.input,
          name: 'route-' + kind,
          value: String((draft.customEndpoints && draft.customEndpoints[kind]) || ''),
          placeholder: ROUTE_PLACEHOLDER[kind] || '',
          onChange: (e) => setDraft((prev) => ({
            ...prev,
            customEndpoints: { ...(prev.customEndpoints || {}), [kind]: e.target.value }
          }))
        })
      );
      /** 某个作用域（提供商 / 某个模型）当前的操作配置：有手改文本就解析它，否则用草稿里的值。 */
      const operationConfigOf = (model) => (model
        ? (draft.modelOptions[model]?.operations || {})
        : (providerOperations || {}));
      /**
       * 按操作选返回预设。值就是宿主下发的 preset 名（`imageCatalog.outputPresets`）。
       * 匹配不上任何预设 = 以前手写的 output（对象或未知字符串）：只读显示成
       * 「自定义（来自旧配置）」并原样保留，用户重新选一个预设即可覆盖它。
       */
      const operationOutputSelect = (kind, model) => {
        if (operationsError) return null;
        const presets = imageCatalog.outputPresets;
        if (!presets.length) return null;
        const operation = operationConfigOf(model)[kind] || {};
        const value = operation.output;
        const matchesPreset = typeof value === 'string' && presets.includes(value);
        const selected = !value ? 'auto' : matchesPreset ? value : 'custom';
        const operationLabel = 'form.route.' + kind;
        return h('label', { className: MC.field, key: kind },
          h('span', { className: MC.fieldLabel }, t('form.operationOutput', { operation: t(operationLabel) })),
          h('select', {
            className: MC.input + ' ' + MC.selectInput,
            'data-mo-image-output-preset': kind,
            value: selected,
            onChange: (event) => {
              const next = event.target.value;
              const config = { ...operationConfigOf(model) };
              const entry = { ...(config[kind] || {}) };
              if (next === 'auto') delete entry.output;
              else entry.output = next;
              if (Object.keys(entry).length) config[kind] = entry;
              else delete config[kind];
              setOperationTexts((prev) => ({ ...prev, [model || '']: JSON.stringify(config, null, 2) }));
            }
          },
          presets.map((preset) => h('option', { key: preset, value: preset }, translatedOr(t, 'form.outputPreset.' + preset, preset))),
          selected === 'custom'
            ? h('option', { key: 'custom', value: 'custom', disabled: true, 'data-mo-image-output-legacy': '' },
                t('form.outputPreset.customLegacy'))
            : null)
        );
      };
      /** 这里存着用户以前手写、匹配不到预设的 output（保留原值，不静默丢弃）。 */
      const hasLegacyOutput = (model) => {
        const presets = imageCatalog.outputPresets;
        return ['generate', 'edit'].some((kind) => {
          const value = (operationConfigOf(model)[kind] || {}).output;
          return value !== undefined && value !== null && value !== ''
            && !(typeof value === 'string' && presets.includes(value));
        });
      };
      /** 内置协议的返回格式：只有「按操作选预设」，没有手写 JSON。 */
      const outputPresetPanel = (model) => {
        const fields = ['generate', 'edit'].map((kind) => operationOutputSelect(kind, model)).filter(Boolean);
        if (!fields.length) return null;
        return h('div', {
          className: MC.field,
          'data-mo-image-output-presets': model || 'provider',
          // 模型行是网格：面板整行铺开（见 MODEL_ROW_PANEL_STYLE），展开不会挤压上面的输入框。
          style: { ...MODEL_ROW_PANEL_STYLE, display: 'flex', flexDirection: 'column', gap: 6 }
        },
          // 两个下拉各占半宽、并排一行：它们本来就短，不占两行。
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 } }, fields),
          hasLegacyOutput(model)
            ? h('p', {
                className: MC.advancedHint,
                style: { margin: 0 },
                'data-mo-image-output-legacy-hint': ''
              }, t('form.outputPreset.customLegacyHint'))
            : null);
      };
      const operationEditor = (model) => {
        // 预设来源（第三方目录 / 本地部署）：协议、返回格式预设里已经写好了，模型选项里不再给
        // 一份重复的「返回格式」；要自己配的走「自定义模型 API」。判据与「协议设置」同一份。
        if (model && presetSourced) return null;
        // 内置协议的返回格式只剩预设下拉：手写 JSON 的口子已经删掉（预设已穷举这些形态）。
        if (draft.adapter !== 'custom') return outputPresetPanel(model);
        const current = (model ? draft.modelOptions[model] : draft)?.operations;
        const text = operationTexts[model || ''] ?? (current ? JSON.stringify(current, null, 2) : '');
        return h('details', {
          className: MC.customized,
          'data-mo-image-operations': model || 'provider',
          style: MODEL_ROW_PANEL_STYLE
        },
          h('summary', { className: MC.customizedSummary }, t(model ? 'form.modelOperations' : 'form.operations')),
          h('div', { className: MC.customizedBody },
            !model && h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 } },
              operationOutputSelect('generate', model), operationOutputSelect('edit', model)),
            h('p', { className: MC.advancedHint }, t(model ? 'form.modelOperationsHint' : 'form.operationsHint')),
            h('textarea', {
              className: MC.input,
              rows: 8,
              spellCheck: false,
              'aria-label': t(model ? 'form.modelOperations' : 'form.operations'),
              value: text,
              placeholder: '{ "version": 1, "generate": { "method": "POST", "transport": "json", "output": "auto" } }',
              onChange: (event) => {
                const value = event.target.value;
                setOperationTexts((prev) => ({ ...prev, [model || '']: value }));
              }
            })
          )
        );
      };
      // 自定义协议的三条端点没法从协议表里推出来，仍旧给三个输入框。
      // 「请求与返回格式」编辑器不在这里：它属于返回值那一块，跟着协议常显（见协议设置）。
      const routePanel = draft.adapter === 'custom'
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            routeField('generate', t('form.route.generate')),
            routeField('edit', t('form.route.edit')),
            routeField('models', t('form.route.models'))
          )
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
      const keyField = draft.auth?.mode === 'none' ? null : field(
        draft.auth?.mode === 'basic' ? t('form.authBasicCredential') : t('form.apiKey'),
        h('input', { className: MC.input, type: 'password', value: draft.key, onChange: (e) => setDraft({ ...draft, key: e.target.value }),
          placeholder: draft.auth?.mode === 'basic' && !(props.provider.hasKey && !draft.key) ? 'username:password' : keyPlaceholder })
      );
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
            || entry.fields || entry.fieldsAs || entry.quality || entry.locked || entry.mapping) modelOptions[id] = entry;
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
      /**
       * 「常规」参数表的整块锁：显示沿用 prompt 这个键，落盘把四个逻辑字段一起写。
       * 只写 prompt 的话，一键配置/自动检测仍会按负向词/模型/张数各自的锁去改它们。
       */
      const toggleCommonLock = (id) => updateModelEntry(id, (entry) => {
        const next = !lockedMapOf(entry, draft).prompt;
        for (const key of ['prompt', 'negative', 'model', 'n']) writeLock(entry, key, next, draft);
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
      /**
       * 解析结果一次写进 draft。
       *
       * params 是**合并**不是替换：这张表现在是唯一一张参数表，用户手填的行都在里面；
       * 重新解析工作流只该补上新出现的落点，不该把它们清掉。
       */
      const applyAnalysis = (id, analysis) => updateModelEntry(id, (entry) => {
        if (analysis && analysis.mapping) entry.mapping = analysis.mapping;
        const incoming = Array.isArray(analysis && analysis.params) ? analysis.params : [];
        const merged = Array.isArray(entry.params) ? entry.params.slice() : [];
        for (const param of incoming) {
          if (!param || !param.node || !param.input) continue;
          // 提示词 / 负面词由工具参数直接写进工作流，不进参数表。
          if (PROMPT_PARAM_NAMES.has(String(param.name || ''))) continue;
          if (merged.some((row) => row && row.node === param.node && row.input === param.input)) continue;
          const row = { name: param.name, node: param.node, input: param.input, type: paramTypeOf(param.type, 'text') };
          if (param.role === true) row.role = true;
          merged.push(row);
        }
        if (merged.length) entry.params = merged;
        else delete entry.params;
      });

      /** 一行是不是工作流行（有节点落点）：和宿主 config-store 用同一个判据。 */
      const isWorkflowRow = (row) => Boolean(row) && (row.node !== undefined || row.input !== undefined);

      /** 提示词与负面词永远不是参数行：它们走工具自己的参数（和宿主同一个清单）。 */
      const PROMPT_PARAM_NAMES = new Set(['prompt', 'negative_prompt']);

      /**
       * 某个参数键是不是「暴露给对话模型」：行的 expose 或老配置的开关表，任一为真即可
       * （和宿主 workflowParamsOf 的口径一致；两者打架时以「暴露」为准）。
       */
      const exposedOf = (id, name) => {
        const entry = draft.modelOptions[id];
        const rows = Array.isArray(entry && entry.params) ? entry.params : [];
        const row = rows.find((item) => item && item.name === name);
        if (row && row.expose === true) return true;
        const map = entry && entry.expose;
        if (map && Object.prototype.hasOwnProperty.call(map, name)) return map[name] === true;
        return row ? row.expose === true : false;
      };

      /**
       * 改某个参数键的暴露开关。
       *
       * 新配置写在行上；老配置的开关表里同名的键同时清掉，否则「取消勾选」会被
       * 那份老开关表重新打开（workflowParamsOf 取两者的或）。
       */
      const setExposed = (id, name, checked) => updateModelEntry(id, (entry) => {
        const rows = Array.isArray(entry.params) ? entry.params.map((row) => ({ ...row })) : [];
        const hit = rows.find((row) => row && row.name === name);
        if (hit) hit.expose = !!checked;
        if (rows.length) entry.params = rows;
        if (entry.expose && Object.prototype.hasOwnProperty.call(entry.expose, name)) {
          const map = { ...entry.expose };
          delete map[name];
          if (Object.keys(map).length) entry.expose = map;
          else delete entry.expose;
        }
      });
      /** 把工作流交给宿主解析，结果原样留着给面板渲染。 */
      const analyzeModelWorkflow = async (id) => {
        const workflow = modelWorkflowOf(id);
        const request = 'comfy-workflow:' + id;
        if (!workflow.trim() || connectionInFlight.current.has(request)) return;
        connectionInFlight.current.add(request);
        setWorkflowAnalysis((prev) => ({ ...prev, [id]: { loading: true } }));
        try {
          const response = await fetch('/api/mo-image/comfy/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...connectionDraft(), workflow }),
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
        } finally { connectionInFlight.current.delete(request); }
      };
      /** 下拉里只显示输入名，节点 id 对用户没有意义。 */
      const mappingOptionLabel = (item) => (item ? item.input : '');

      /** 尺寸由选择器经 mapping 注入；认出来就不占列表，认不出来才留手选。 */
      const SIZE_ROLES = new Set(['width', 'height']);
      /**
       * 只列要手选落点的映射。提示词与负面词不在这里——它们由工具调用自己的
       * prompt / negative_prompt 直接写入工作流，落点仍按解析结果自动填；种子与模型
       * 也不在这里——它们是参数表里的普通行（见 paramFieldsPanel），不再重复一遍下拉。
       */
      const MAPPING_ROWS = [
        ['width', 'form.modelMappingWidth'],
        ['height', 'form.modelMappingHeight'],
        ['image', 'form.modelMappingImage']
      ];
      /**
       * 映射面板：宽高 / 参考图各自落到哪个节点输入。
       *
       * 可调参数（含种子与模型）不在这张表里——它们是离散参数表的行（见 paramFieldsPanel），
       * 暴露开关也归那张表。
       */
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
                key, name: key, label: t(labelKey), value: current ? current.node + '::' + current.input : '',
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
            const cell = {
              display: 'grid', gridTemplateColumns: 'minmax(88px, 1fr) 168px',
              alignItems: 'center', gap: 8, minHeight: 32
            };
            const rowView = (row) => {
              const list = row.options.map((item) => ({
                value: item.node + '::' + item.input,
                label: mappingOptionLabel(item)
              }));
              list.unshift({ value: '', label: t('form.modelMappingSkip') });
              if (row.value && !list.some((option) => option.value === row.value)) {
                list.push({ value: row.value, label: row.value.split('::')[1] });
              }
              return h('div', { key: row.key, style: cell },
                h('span', {
                  className: MC.modelFieldLabel,
                  style: { margin: 0, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }
                },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label)),
                h('select', {
                  className: MC.input + ' ' + MC.selectInput,
                  style: { width: '100%', minWidth: 0 },
                  'data-mapping-key': row.key,
                  value: row.value,
                  onChange: (event) => row.onPick(event.target.value)
                }, list.map((option) => h('option', { key: option.value || 'none', value: option.value }, option.label)))
              );
            };
            // 提示词与负面词不占这里的行：它们由工具参数直接写入，落点按解析结果自动填。
            return h('div', { style: { display: 'grid', gap: 4 } },
              h('p', { className: MC.advancedHint, style: { margin: 0 } },
                t('form.modelAutoInjectHint')),
              rows.length ? h('div', { className: MC.advancedHint, style: Object.assign({}, cell, { minHeight: 0 }) },
                h('span', null, t('form.modelMappingColName')),
                h('span', null, t('form.modelMappingColTarget'))) : null,
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
      // 每格都是 DSH 设置页的 modelField：输入框样式和列位（`.modelName` 钉第 3 列）
      // 都由宿主的类规则决定，插件不再内联抄一份，展开选项面板也不会让它们挪位。
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
          // 输入框各自可压缩：超长的模型名截在自己那一格里，不去挤邻格。
          style: { minWidth: 0 },
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
        const button = h(TipButton, {
          className: MC.iconButton + ' ' + MC.modelDragHandle,
          tip: DshTooltip ? '' : t('form.reorderModelHelp'),
          attributes: {
            'aria-label': t('form.reorderModel') + ' ' + (index + 1),
            'aria-keyshortcuts': 'ArrowUp ArrowDown',
            'aria-description': t('form.reorderModelHelp'),
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
          },
          children: IconDragHandle ? h(IconDragHandle, { size: 14 }) : '\u22ee'
        });
        return DshTooltip ? h(DshTooltip, { label: t('form.reorderModelHelp'), portal: true }, button) : button;
      };
      /** 键名右侧的锁图标：上锁 = 该值不可被修改（输入框禁用、自动填跳过）。 */
      const lockButton = (id, key, locked, labelText) => h(BoxLockButton, {
        className: MC.iconButton,
        locked: locked,
        tip: locked ? t('form.lockOn') : t('form.lockOff'),
        onClick: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          // 「常规」参数表的锁复用了 prompt 这个键：整块上锁 = 四个逻辑字段的锁一起落。
          if (key === 'prompt' && labelText) toggleCommonLock(id);
          else toggleLock(id, key);
        },
        attributes: {
          'data-lock-key': key,
          'data-locked': locked ? 'true' : 'false',
          'aria-pressed': locked ? 'true' : 'false',
          'aria-label': t('form.paramLock') + ': ' + (labelText || t(PARAM_LABELS[key]))
        }
      });
      /**
       * 参数行 label 的宽度：定值，所有行的输入框都从同一个 x 起（对齐是固定宽度换来的）。
       * 上一版按 label 内容自适应，德语/俄语的长键名会把输入框挤到看不见；这一版反过来：
       * label 只占这一格，超出的部分截断，悬停看全名。
       */
      const PARAM_LABEL_WIDTH = 88;
      /** 行 label：固定宽度 + 单行截断；flex:none 让它不参与伸缩，输入框的起点就钉死了。 */
      const PARAM_LABEL_STYLE = {
        margin: 0, flex: 'none',
        width: PARAM_LABEL_WIDTH, minWidth: PARAM_LABEL_WIDTH,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      };
      /**
       * 方框标题：比正文大一号并加粗 —— 正文 label 是 12px，这里 14px / 600，标题行才像标题。
       * 标题行没有输入框，不需要固定列宽；锁仍然紧跟标题（位置不变）。
       * 颜色显式取正文主色：宿主的 modelFieldLabel 是次要灰（深色主题下发虚），方框标题是这一块
       * 的名字，应该跟正文一个层次；行 label、表头、提示文字仍保留原来的灰。
       */
      const PARAM_BOX_TITLE_STYLE = {
        margin: 0, flex: '0 1 auto', minWidth: 0,
        fontSize: 14, fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      };
      /** 行 label / 方框标题：截断时悬停立刻给出全名（和问号同一套自绘气泡，不用原生 title）。 */
      const paramRowLabel = (text) => h(ParamLabel, {
        className: MC.modelFieldLabel, style: PARAM_LABEL_STYLE, text: text
      });
      const paramBoxTitle = (text) => h(ParamLabel, {
        className: MC.modelFieldLabel, style: PARAM_BOX_TITLE_STYLE, text: text
      });
      /** 参数输入：吃掉剩下的宽度；min-width 0 才允许被压窄。 */
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
        const lockLabel = options && options.lockLabel ? options.lockLabel : '';
        // 方框标识与锁键通常同名；「常规」整张表复用 prompt 这个键（见 toggleCommonLock）。
        const lockKey = options && options.lockKey ? options.lockKey : key;
        // 标题行上的额外操作（enum / 模型方框把行级的暴露 / 删除 / 行锁摆在这里）。
        const headExtra = options && Array.isArray(options.headExtra) ? options.headExtra : [];
        // 框内校验没过（模型参数名留空）：整框描红，提示就在框里。
        const invalid = !!(options && options.invalid);
        return h('div', {
          'data-param-box': key,
          'data-param-invalid': invalid ? 'true' : undefined,
          style: {
            gridColumn: '1 / -1', justifySelf: 'stretch',
            width: '100%', boxSizing: 'border-box',
            display: 'grid', gap: 6, minWidth: 0,
            padding: '8px 10px',
            border: '.5px solid ' + (invalid
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-border-l3)'),
            borderRadius: 'var(--dsw-radius-md, 8px)'
          }
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            paramBoxTitle(titleText),
            lockInHead ? lockButton(id, lockKey, !!locks[lockKey], lockLabel) : null,
            ...headExtra),
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
        rows.push(h(TipFieldRow, {
          rowKey: 'size:mode',
          label: t('form.sizeMode'),
          labelStyle: PARAM_LABEL_STYLE,
          tip: t('form.sizeParamsHint'),
          control: 'select',
          controlClassName: MC.input + ' ' + MC.selectInput,
          controlStyle: PARAM_INPUT_STYLE,
          attributes: { 'data-param-key': 'size', 'aria-label': t('form.sizeMode') },
          disabled: locked,
          value: mode,
          onChange: (event) => setSize({ mode: String(event.target.value) }),
          options: modes.map((option) => h('option', { key: option.value, value: option.value }, option.label))
        }));
        // 宽+高 的两个键名：field 是宽、second.field 是高（留空就用 width / height）。
        // 说明（留空用默认 / 支持 a.b.c 嵌套路径）挂在输入框的即时气泡上，不用原生 title。
        const nameFieldRow = (rowKey, labelText, value, placeholder, onChange) => h(TipFieldRow, {
          rowKey: rowKey,
          label: labelText,
          labelStyle: PARAM_LABEL_STYLE,
          tip: t('form.sizeFieldHint'),
          controlClassName: MC.input,
          controlStyle: PARAM_INPUT_STYLE,
          attributes: { 'data-param-key': 'size', 'aria-label': labelText },
          disabled: locked,
          value: String(value || ''),
          placeholder: placeholder,
          onChange: onChange
        });
        if (effective === 'wh-fields') {
          rows.push(nameFieldRow('size:width', t('form.sizeFieldWidth'), entry.field || 'width', 'width',
            (event) => setSize({ field: event.target.value.trim() })));
          rows.push(nameFieldRow('size:height', t('form.sizeFieldHeight'), second.field || 'height', 'height',
            (event) => setSecond({ field: event.target.value.trim() })));
        } else if (effective === 'aspect') {
          rows.push(nameFieldRow('size:field', t('form.sizeFieldAspect'), entry.field,
            String((spec && spec.field) || '') || 'aspect_ratio',
            (event) => setSize({ field: event.target.value.trim() })));
          rows.push(h(TipSecondRow, {
            rowKey: 'size:second',
            // 这个 label 在 `from: 'tier'` 时略偏：那时发的是档位名（1K / 2K），不是分辨率。
            // 两种取值共用一个字段，label 只按「比例之外的那一格」命名，不为它再拆一个文案。
            label: t('form.sizeFieldResolution'),
            labelStyle: PARAM_LABEL_STYLE,
            tip: t('form.sizeSecondHint'),
            controlClassName: MC.input + ' ' + MC.selectInput,
            controlStyle: PARAM_INPUT_STYLE,
            attributes: { 'data-param-key': 'size', 'aria-label': t('form.sizeFieldResolution') },
            disabled: locked,
            value: String(second.field || ''),
            placeholder: 'imageSize',
            onChange: (event) => setSecond({ field: event.target.value.trim() }),
            secondary: second.field ? h('select', {
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
            ].map((option) => h('option', { key: option.value, value: option.value }, option.label))) : null
          }));
        } else if (effective !== 'prompt') {
          rows.push(nameFieldRow('size:field', t('form.sizeField'), entry.field,
            String((spec && spec.field) || 'size'),
            (event) => setSize({ field: event.target.value.trim() })));
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
       * 「质量」方框：收不收 + 参数名 + 挡位表。和「尺寸」同级的一块（质量不再是「常规」里的一行）。
       *
       *   ① 勾「支持质量参数」= 这个模型收质量参数；不勾时下面的参数名与挡位表**整块不渲染**
       *      （不勾的话填什么都不会发出去，摆着只会误导）。
       *   ② 参数名 = 质量写到哪个字段，留空跟随规则；支持 a.b.c 嵌套。
       *   ③ 挡位表：挡位名（显示给用户看的）/ 值（真正发出去的）/ 是否默认（单选）/ 删除，
       *      行序就是下拉里的顺序，末尾「+ 添加挡位」。
       *
       * 参数名要**两处一起写**：quality.field 喂面板与识别路由，fields.quality 才是真正
       * 决定 body 落点的字段模板（和 mergeRuleResult 里补模板是同一个理由）。勾选时若模板
       * 还没有 quality，也顺手补一条——否则勾了照样发不出去。
       */
      const qualityOptionsPanel = (id, locks) => {
        const locked = !!locks.quality;
        const entry = draft.modelOptions[id] || {};
        const configured = Boolean(entry.quality) && typeof entry.quality === 'object' && !Array.isArray(entry.quality);
        const stored = qualityStateOf(configured ? entry.quality : {});
        // 没配过的时候摆的是宿主下发的能力（规则 + 预设算出来的那一份）：
        // 模型根本不收质量 → 复选框不勾；收 → 勾上，并把它现在的档位先列出来。
        const capability = qualitySpecFor(draft.id, id);
        const fallbackOptions = capability && Array.isArray(capability.options)
          ? capability.options
            .filter((item) => item && item.value && item.value !== 'off')
            .map((item) => ({
              label: String((item && item.label) || ''),
              value: String((item && item.value) || ''),
              default: Boolean(capability.default) && item.value === capability.default
            }))
          : [];
        const state = {
          supported: configured ? stored.supported : Boolean(capability),
          field: stored.field,
          options: stored.options.length ? stored.options : fallbackOptions
        };
        /**
         * 写回质量覆盖：一律写成新形状（supported / field / options / default），
         * 面板不编辑的键（值映射 map）原样留着。空值的行留着——用户正要在里面打字。
         */
        const writeQuality = (mutate) => updateModelEntry(id, (next) => {
          const previous = next.quality && typeof next.quality === 'object' && !Array.isArray(next.quality)
            ? next.quality
            : {};
          const nextState = qualityStateOf(previous);
          mutate(nextState, next);
          const options = nextState.options.map((item) => ({
            label: String(item.label || '').trim(),
            value: String(item.value || '').trim(),
            default: !!item.default
          }));
          // 默认档最多一个：单选是唯一的表达，多个 true 只留第一个。
          const chosen = options.find((item) => item.default);
          for (const item of options) item.default = Boolean(chosen) && item === chosen;
          const quality = { supported: nextState.supported };
          if (nextState.field) quality.field = nextState.field;
          if (options.length) quality.options = options;
          if (chosen && chosen.value) quality.default = chosen.value;
          if (previous.map && typeof previous.map === 'object' && !Array.isArray(previous.map)) {
            quality.map = { ...previous.map };
          }
          next.quality = quality;
        });
        /**
         * 改挡位表：没配过的时候先把宿主下发的那份抄进来，第一次编辑就落在它上面
         * （否则改的是一条「还没存在于配置里」的行，改动会凭空消失）。
         */
        const seedOptions = (nextState) => {
          if (!nextState.options.length) nextState.options = fallbackOptions.map((item) => ({ ...item }));
          return nextState.options;
        };
        /** 勾选 / 取消勾选；勾上时给字段模板补上 quality 这条闸门。 */
        const setSupported = (on) => writeQuality((nextState, next) => {
          nextState.supported = !!on;
          if (!on) return;
          const fields = { ...(next.fields || {}) };
          const hasQuality = fields.quality !== undefined && fields.quality !== null && fields.quality !== false;
          if (!hasQuality) fields.quality = { path: nextState.field || 'quality' };
          next.fields = fields;
        });
        /** 参数名：quality.field 与字段模板一起改，留空就删掉模板覆盖（回落到规则/预设）。 */
        const setFieldName = (text) => writeQuality((nextState, next) => {
          nextState.field = text || '';
          const fields = { ...(next.fields || {}) };
          if (!text) delete fields.quality;
          else {
            // 保留模板原来的形状（multipart / numbered 不会被手填改成扁平路径）。
            const template = fields.quality;
            const kind = fieldKindOf(template);
            const as = template && typeof template === 'object' && typeof template.as === 'string' ? template.as : '';
            fields.quality = fieldTemplateOf(kind, text, as);
          }
          if (Object.keys(fields).length) next.fields = fields;
          else delete next.fields;
        });
        const setOption = (index, patch) => writeQuality((nextState) => {
          nextState.options = seedOptions(nextState)
            .map((item, at) => (at === index ? { ...item, ...patch } : item));
        });
        const removeOption = (index) => writeQuality((nextState) => {
          nextState.options = seedOptions(nextState).filter((_item, at) => at !== index);
        });
        const addOption = () => writeQuality((nextState) => {
          const options = seedOptions(nextState);
          nextState.options = options.concat({ label: '', value: '', default: options.length === 0 });
        });
        const setDefaultOption = (index) => writeQuality((nextState) => {
          nextState.options = seedOptions(nextState).map((item, at) => ({ ...item, default: at === index }));
        });

        const rows = [];
        // ① 收不收：这是整块的总闸，永远在。
        rows.push(paramLine(t('form.qualitySupported'), h('input', {
          type: 'checkbox',
          style: { flex: 'none', margin: 0 },
          'data-param-key': 'quality',
          'aria-label': t('form.qualitySupported'),
          disabled: locked,
          checked: state.supported,
          onChange: (event) => setSupported(!!event.target.checked)
        }), null, 'quality:supported'));
        if (state.supported) {
          // ② 参数名：留空跟随规则；嵌套路径由 config-store 与字段模板各自认。
          rows.push(h(TipFieldRow, {
            rowKey: 'quality:field',
            label: t('form.qualityField'),
            labelStyle: PARAM_LABEL_STYLE,
            tip: t('form.sizeFieldHint'),
            controlClassName: MC.input,
            controlStyle: PARAM_INPUT_STYLE,
            attributes: { 'data-param-key': 'quality.field', 'aria-label': t('form.qualityField') },
            disabled: locked,
            value: state.field,
            placeholder: 'quality',
            onChange: (event) => setFieldName(event.target.value.trim())
          }));

          // ③ 挡位表：和「常规」参数表同一套 grid（挡位名 / 值 / 是否默认 / 操作），行尾删除。
          // 表头与表体是「挡位表」的行，不是「参数行」（后者是 label + 一个控件的那种），
          // 所以用 data-param-grid 而不是 data-param-row，别去污染参数行的全局约定。
          rows.push(h('div', {
            'data-param-table': 'quality',
            style: SUBTABLE_FRAME
          },
            h('div', { 'data-param-grid': 'quality:head', style: SUBTABLE_HEAD },
              commonHeadCell(t('form.qualityOptionLabel'), 'label'),
              commonHeadCell(t('form.qualityOptionValue'), 'value'),
              commonHeadCell(t('form.qualityOptionDefault'), 'default'),
              commonHeadCell(t('form.paramActions'), 'actions')
            ),
            state.options.map((option, index) => h('div', {
              key: 'option-' + index,
              'data-param-grid': 'quality:option',
              'data-param-index': String(index),
              style: subtableRow(index === 0)
            },
              h(ParamCellInput, {
                value: option.label,
                disabled: locked,
                onChange: (event) => setOption(index, { label: event.target.value }),
                className: MC.input,
                style: COMMON_PARAM_CONTROL,
                attributes: {
                  'data-param-key': 'quality.option.label',
                  'aria-label': t('form.qualityOptionLabel') + ' ' + (index + 1),
                  placeholder: t('form.qualityOptionLabel')
                }
              }),
              h(ParamCellInput, {
                value: option.value,
                disabled: locked,
                onChange: (event) => setOption(index, { value: event.target.value.trim() }),
                className: MC.input,
                style: COMMON_PARAM_CONTROL,
                attributes: {
                  'data-param-key': 'quality.option.value',
                  'aria-label': t('form.qualityOptionValue') + ' ' + (index + 1),
                  placeholder: 'low'
                }
              }),
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 } },
                h('input', {
                  type: 'radio',
                  style: { flex: 'none', margin: 0 },
                  name: 'quality-default-' + id,
                  'data-param-key': 'quality.option.default',
                  'aria-label': t('form.qualityOptionDefault') + ' ' + (index + 1),
                  disabled: locked,
                  checked: option.default,
                  onChange: () => setDefaultOption(index)
                })),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', minWidth: 0 } },
                h(RowDeleteButton, {
                  style: COMMON_PARAM_ACTION,
                  disabled: locked,
                  tip: t('form.qualityRemoveOption'),
                  onClick: () => removeOption(index),
                  attributes: {
                    'data-param-key': 'quality.option.remove',
                    'aria-label': t('form.qualityRemoveOption') + ' ' + (index + 1)
                  }
                }))
            ))
          ));
          rows.push(h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button', className: MC.linkButton,
              'data-param-key': 'quality.option.add',
              disabled: locked,
              onClick: addOption
            }, IconPlus ? h(IconPlus, { size: 14 }) : null, t('form.qualityAddOption'))
          ));
        }
        return paramBox(id, 'quality', locks, t(PARAM_LABELS.quality), rows);
      };
      /**
       * 「常规」方框：一张离散参数表，一行一个参数（prompt / negative / n + 用户行）。
       *
       * 数据落在 modelOptions[id].params（形状见 config-store 的 sanitizeParamTable）：
       *   { role?, name, type, default, description, expose, options?, locked? }
       *
       * 呈现是一张五列表格（参数名 / 类型 / 默认值 / 描述 / 操作）：工作流的落点只留在
       * 数据里（node / input 不渲染），所有操作（暴露 / 行级锁 / 删除）在行尾。
       * 表里只装 text / number / boolean 的行——enum 行搬进各自的方框（见 enumBox），
       * 一张表混两种形状时 enum 的选项表没地方摆。locked 只挡一键配置与自动检测，
       * 手动编辑照旧。
       *
       * 内置四行与 fields 里的逻辑字段是同一件事：行名就是字段模板的 path，改名同步
       * fields[role]（保留 multipart / numbered 形状），删行就是去掉那条模板覆盖（回落到
       * 规则/预设）。用户新增的行没有 role，只存在参数表里。
       * 老配置没有 params 时按 fields 派生，没有字段模板的行不显示；提示词是固定第一行。
       * 模型行（role:model）也在数据里，但渲染在自己那个方框（见 modelBox）：固定、不可删、
       * 没有暴露开关——是否暴露由选择器是不是「自动」在运行时推导，行上不写 expose。
       */
      const COMMON_PARAM_ROLES = ['prompt', 'negative', 'model', 'n'];
      const COMMON_PARAM_TYPES = ['text', 'number', 'boolean', 'enum', 'json'];
      const PARAM_TYPE_ALIASES = {
        int: 'number', integer: 'number', float: 'number', double: 'number',
        string: 'text', str: 'text', bool: 'boolean'
      };
      const COMMON_PARAM_NAMES = { prompt: 'prompt', negative: 'negative_prompt', model: 'model', n: 'n' };
      /** 内置行的默认值 / 描述（描述是给对话模型看的，用户可改）。 */
      const commonParamSpec = (role) => {
        switch (role) {
          case 'negative': return { type: 'text', default: '', description: t('form.paramDescNegative') };
          case 'model': return { type: 'text', default: '', description: t('form.paramDescModel') };
          case 'n': return { type: 'number', default: '1', description: t('form.paramDescN') };
          default: return { type: 'text', default: '', description: t('form.paramDescPrompt') };
        }
      };
      const paramTypeOf = (value, fallback) => {
        const raw = String(value || '').trim().toLowerCase();
        // 老配置的工作流参数写的是 INT / FLOAT / STRING，读进来折成表里的四个值。
        const type = PARAM_TYPE_ALIASES[raw] || raw;
        return COMMON_PARAM_TYPES.includes(type) ? type : fallback;
      };
      /** A1111 那六行的说明：字段名 → i18n key（描述是给人看的，落在表里可改）。 */
      const A1111_PARAM_DESCRIPTIONS = {
        steps: 'param.steps.desc',
        cfg_scale: 'param.cfg.desc',
        sampler_name: 'param.sampler_name.desc',
        scheduler: 'param.scheduler.desc',
        seed: 'param.seed.desc',
        denoising_strength: 'param.denoise.desc'
      };
      /**
       * 协议预置行：宿主下发的参数清单（paramDefaults）加一行行描述。
       * A1111 的采样参数就是这样第一次出现在空表里的；老配置的开关表状态一并带过来，
       * 免得「以前勾着 steps」在表里看着像没勾。
       */
      const paramSeedRows = (id, kind) => {
        const list = imageCatalog.paramDefaults && Array.isArray(imageCatalog.paramDefaults[kind])
          ? imageCatalog.paramDefaults[kind]
          : [];
        return list.map((param) => {
          const name = String((param && param.name) || '').trim();
          const descKey = A1111_PARAM_DESCRIPTIONS[name];
          return {
            role: '',
            workflow: false,
            name: name,
            type: paramTypeOf(param && param.type, 'text'),
            default: String(param && param.default !== undefined && param.default !== null ? param.default : ''),
            description: descKey ? t(descKey) : '',
            expose: exposedOf(id, name),
            options: []
          };
        }).filter((row) => row.name);
      };
      /** 选项数组：空字符串也留着——用户刚点「添加选项」还没打字，那一行不能凭空消失。 */
      const paramOptionsOf = (value) => (Array.isArray(value)
        ? value.map((item) => String(item === undefined || item === null ? '' : item))
        : []);
      /** 表格列宽：参数名 / 类型 / 默认值 / 描述 / 操作。表头与表体共用这一份。 */
      const COMMON_PARAM_COLUMNS = 'minmax(0, 1.35fr) 92px minmax(0, .9fr) minmax(0, 1.6fr) 88px';
      /** 行最小高度：参数行与子表的一行（挡位 / 选项）都按这个高度走，一行一行等高。 */
      const COMMON_PARAM_ROW_HEIGHT = 48;
      /** 表头与表体共用的网格：同一套列宽 + 同一个列间距。 */
      const COMMON_PARAM_GRID = {
        display: 'grid', gridTemplateColumns: COMMON_PARAM_COLUMNS, columnGap: 8,
        alignItems: 'center', minWidth: 0
      };
      const COMMON_PARAM_HEAD = Object.assign({}, COMMON_PARAM_GRID, {
        padding: '4px 8px',
        borderBottom: '.5px solid var(--dsw-alias-border-l3)'
      });
      /** 单元格：超宽一律截断（悬停气泡给全文）。 */
      const COMMON_PARAM_CELL = {
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      };
      const COMMON_PARAM_CONTROL = {
        width: '100%', minWidth: 0, boxSizing: 'border-box',
        height: 28, padding: '2px 6px', fontSize: 12,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      };
      const COMMON_PARAM_ACTION = {
        flex: 'none', width: 24, height: 24, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, lineHeight: 1
      };
      const commonHeadCell = (text, key) => h('span', {
        key,
        className: MC.modelFieldLabel,
        style: {
          fontSize: 11, lineHeight: '16px', opacity: 0.72, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          // 只有表头居中；表体保持左对齐（操作列是图标按钮，不算文字对齐）。
          textAlign: 'center'
        }
      }, text);
      /**
       * 子表（质量挡位 / enum 选项）与「常规」参数表同一套 grid：
       * 同一个 grid 容器（列宽固定 + 列间距固定）、同样的表头居中、
       * 同样的行高与单元格截断，末尾一列留给删除。
       */
      const SUBTABLE_COLUMNS = 'minmax(0, 1.4fr) minmax(0, 1.1fr) 84px 88px';
      const SUBTABLE_GRID = {
        display: 'grid', gridTemplateColumns: SUBTABLE_COLUMNS, columnGap: 8,
        alignItems: 'center', minWidth: 0
      };
      const SUBTABLE_HEAD = Object.assign({}, SUBTABLE_GRID, {
        padding: '4px 8px',
        borderBottom: '.5px solid var(--dsw-alias-border-l3)'
      });
      /** 表体行：与参数行同高，行间一条细线（首行不画，靠表头的下边线分隔）。 */
      const subtableRow = (first) => Object.assign({}, SUBTABLE_GRID, {
        minHeight: COMMON_PARAM_ROW_HEIGHT,
        padding: '0 8px',
        borderTop: first ? undefined : '.5px solid var(--dsw-alias-border-l3)'
      });
      /** 子表外框：与「常规」参数表同一个边框 + 圆角 + 裁切。 */
      const SUBTABLE_FRAME = {
        display: 'grid', gap: 0, minWidth: 0,
        border: '.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        overflow: 'hidden'
      };
      /** 只读的值格（enum 的「值」= 真正发出去的字符串）：与表体其它格子同一套截断。 */
      const SUBTABLE_VALUE = Object.assign({}, COMMON_PARAM_CELL, {
        fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)'
      });

      /**
       * 「常规」参数表 + 「模型」方框：一张表两种绑定，外加一个特殊行。
       *
       *   工作流行   有 `node` / `input`：指向 ComfyUI 工作流里哪个节点的哪个输入。
       *              解析工作流 / 解析参数的产物，行里带着默认值与推断出的类型。
       *   HTTP 行    `name` 是请求体路径：云端网关与 A1111 的 sdapi 字段名。
       *   内置四行  带 role（prompt / negative / model / n），行名与字段模板双向同步。
       *              其中模型行搬出了这张表，单独一个「模型」方框（见 modelBox）：
       *              每个请求都要带模型名，它不该和可增删的普通行摆在一起。
       *
       * 判据只有形状（有没有节点落点），和宿主 config-store 的 sanitizeParams 一致。
       * workflow 协议（ComfyUI / A1111）没有字段模板，不给内置四行——它们的参数
       * 全是「请求体字段」或「工作流落点」，多出来的 role 行只会写进去占位。
       *
       * @param {{roles?:boolean, workflow?:boolean, seed?:string, allowAdd?:boolean}} [options]
       */
      const paramFieldsPanel = (id, locks, options) => {
        const settings = options || {};
        const hasRoles = settings.roles !== false;
        const entry = draft.modelOptions[id] || {};
        const fieldEntry = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
        const stored = Array.isArray(entry.params)
          ? entry.params.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
          : [];
        const savedByRole = new Map();
        for (const row of stored) {
          const role = COMMON_PARAM_ROLES.includes(String(row.role || '')) ? String(row.role) : '';
          if (role && !savedByRole.has(role)) savedByRole.set(role, row);
        }
        // 行数据：内置四行以字段模板为准（params 是兼容老配置的种子），其余行全看 params。
        const rows = [];
        if (hasRoles) {
          for (const role of COMMON_PARAM_ROLES) {
            const spec = commonParamSpec(role);
            const saved = savedByRole.get(role) || null;
            const savedName = saved && typeof saved.name === 'string' ? saved.name : null;
            const fieldName = fieldPathOf(fieldEntry[role]);
            // 提示词与模型是固定行，永远在（模型默认参数名 model）；用户清空的名字保持空，
            // 留给模型框标红提示，别自己弹回默认值。
            const fallback = role === 'prompt'
              ? COMMON_PARAM_NAMES.prompt
              : (role === 'model' ? COMMON_PARAM_NAMES.model : '');
            const name = fieldName
              || (savedName !== null ? savedName.trim() : fallback);
            // 没有字段模板、也没存过这一行 → 不显示；固定行例外。
            if (!name && role !== 'prompt' && role !== 'model') continue;
            const built = {
              role,
              name,
              type: role === 'prompt' ? 'text' : paramTypeOf(saved && saved.type, spec.type),
              default: role === 'prompt' ? '' : (saved && typeof saved.default === 'string' ? saved.default : spec.default),
              description: saved && typeof saved.description === 'string' ? saved.description : spec.description,
              options: paramOptionsOf(saved && saved.options),
              locked: Boolean(saved && saved.locked === true)
            };
            // 模型行没有「暴露」这回事：它由选择器（是不是自动）在运行时推导，
            // 框里没有控件、行上不写 expose，老配置里存过的值也不读。
            if (role !== 'model') {
              built.expose = role === 'prompt' ? true : Boolean(saved && saved.expose === true);
            }
            rows.push(built);
          }
        }
        for (const row of stored) {
          if (COMMON_PARAM_ROLES.includes(String(row.role || ''))) continue;
          rows.push({
            role: '',
            // 工作流行的 role: true 是解析器留下的标记（宽高/种子/模型这类角色参数），
            // 面板不显示它，但写回去时要带着，免得一次保存把它抹掉。
            keepRole: row.role === true,
            workflow: isWorkflowRow(row),
            node: typeof row.node === 'string' ? row.node : '',
            input: typeof row.input === 'string' ? row.input : '',
            name: typeof row.name === 'string' ? row.name : '',
            type: paramTypeOf(row.type, 'text'),
            default: typeof row.default === 'string' ? row.default : '',
            description: typeof row.description === 'string' ? row.description : '',
            expose: exposedOf(id, String(row.name || '')) || row.expose === true,
            options: paramOptionsOf(row.options),
            locked: row.locked === true
          });
        }
        // 协议预置行：A1111 第一次展开时把默认采样参数摆出来（存不存由用户保存时决定）。
        if (!rows.length && settings.seed) rows.push(...paramSeedRows(id, settings.seed));
        const locked = !!locks.prompt;
        /** 行 → params：空名字的行也留着（用户正在输入，保存时由 config-store 丢掉）。 */
        const applyRows = (next, nextRows) => {
          const out = [];
          for (const row of nextRows) {
            const row2 = {
              name: String(row.name || '').trim(),
              type: COMMON_PARAM_TYPES.includes(row.type) ? row.type : 'text',
              default: String(row.default === undefined || row.default === null ? '' : row.default),
              description: String(row.description || '')
            };
            // 提示词固定暴露；模型行不写 expose——它在运行时按「选择器是不是自动」推导，
            // 写了也没人读，只会变成假数据。
            if (row.role !== 'model') row2.expose = row.role === 'prompt' ? true : !!row.expose;
            if (row.workflow) {
              // 工作流行必须带着落点落盘；落点丢了这个参数就写不进工作流。
              row2.node = String(row.node || '').trim();
              row2.input = String(row.input || '').trim();
              if (!row2.name) row2.name = row2.input;
              if (row.keepRole === true) row2.role = true;
            } else if (row.role) {
              row2.role = row.role;
              // 提示词行固定：类型 text、默认值空、暴露。
              if (row.role === 'prompt') { row2.type = 'text'; row2.default = ''; }
            }
            // 行级锁只存 true（不写 = 未锁），和 config-store 的 sanitize 一致。
            if (row.locked === true) row2.locked = true;
            if (Array.isArray(row.options) && row.options.length) row2.options = row.options.slice();
            out.push(row2);
          }
          if (out.length) next.params = out;
          else delete next.params;
        };
        /** 写整张表；内置行改名 / 删行时顺带改字段模板（清空 = 删掉覆盖）。 */
        const commitRows = (nextRows, fieldEdit) => updateModelEntry(id, (next) => {
          applyRows(next, nextRows);
          if (!fieldEdit || !fieldEdit.role) return;
          const fields = { ...(next.fields || {}) };
          const name = String(fieldEdit.name || '').trim();
          if (!name) delete fields[fieldEdit.role];
          else {
            const previous = fields[fieldEdit.role];
            const kind = fieldKindOf(previous);
            const asValue = previous && typeof previous === 'object' && typeof previous.as === 'string'
              ? previous.as
              : pendingFieldAsOf(next, fieldEdit.role);
            fields[fieldEdit.role] = fieldTemplateOf(kind, name, asValue);
          }
          if (Object.keys(fields).length) next.fields = fields;
          else delete next.fields;
        });
        const patchRow = (index, patch, fieldEdit) => {
          const nextRows = rows.map((row, at) => (at === index ? { ...row, ...patch } : { ...row }));
          commitRows(nextRows, fieldEdit);
        };
        const setExpose = (index, checked) => {
          patchRow(index, { expose: checked });
          // 老配置的 expose 开关表里同名的键一起清掉，否则取消勾选会被它重新打开。
          setExposed(id, rows[index].name, checked);
        };
        const onChange = (index, field) => (event) => {
          const value = String((event && event.target && event.target.value) || '');
          // 内置行改名要同步字段模板；清空名字 = 去掉覆盖。
          const fieldEdit = field === 'name' && rows[index].role
            ? { role: rows[index].role, name: value }
            : null;
          patchRow(index, { [field]: value }, fieldEdit);
        };
        const onType = (index) => (event) => patchRow(index, {
          type: String((event && event.target && event.target.value) || 'text')
        });
        /** enum 选项：一格改一位；选项名就是发出去的值（options 仍是字符串数组）。 */
        const setOptionText = (index, at) => (event) => {
          const options = rows[index].options.slice();
          options[at] = String((event && event.target && event.target.value) || '');
          patchRow(index, { options });
        };
        const addOption = (index) => () => patchRow(index, { options: rows[index].options.concat('') });
        const removeOptionAt = (index, at) => () => {
          const options = rows[index].options.filter((_value, position) => position !== at);
          const patch = { options };
          // 默认值不能指向已经不存在的选项：删掉默认那条就清空，退回「没有默认」。
          if (rows[index].default && !options.includes(rows[index].default)) patch.default = '';
          patchRow(index, patch);
        };
        const setDefaultOptionAt = (index, at) => () => patchRow(index, { default: rows[index].options[at] || '' });
        /** 行级锁：只挡一键配置/自动检测，手动编辑照旧。 */
        const toggleRowLock = (index) => () => patchRow(index, { locked: rows[index].locked !== true });
        const removeRow = (index) => () => {
          const row = rows[index];
          // 提示词与模型是固定行：没有删除按钮，这里再兜一道（调用方不该拿到它们的行号）。
          if (!row || row.role === 'prompt' || row.role === 'model') return;
          commitRows(rows.filter((_item, at) => at !== index),
            row.role ? { role: row.role, name: '' } : null);
        };
        /**
         * 删除按钮的二次确认：第一次只把按钮换成「确认删除？」，3 秒内再点才真删；
         * 换到别的行或超时都自动复原。状态只在这一屏，不落盘。
         */
        const disarmParamRemove = () => {
          if (pendingParamRemoveTimer.current) clearTimeout(pendingParamRemoveTimer.current);
          pendingParamRemoveTimer.current = 0;
          if (pendingParamRemove) setPendingParamRemove('');
        };
        const requestRemove = (index) => () => {
          const token = id + '::' + index;
          if (pendingParamRemove === token) {
            disarmParamRemove();
            removeRow(index)();
            return;
          }
          if (pendingParamRemoveTimer.current) clearTimeout(pendingParamRemoveTimer.current);
          setPendingParamRemove(token);
          pendingParamRemoveTimer.current = setTimeout(() => {
            pendingParamRemoveTimer.current = 0;
            setPendingParamRemove('');
          }, 3000);
        };
        const addRow = () => commitRows(rows.concat({
          role: '', workflow: false, name: '', type: 'text', default: '', description: '',
          expose: false, options: [], locked: false
        }));

        const tableRows = [];
        const enumRows = [];
        let modelRow = null;
        for (const [index, row] of rows.entries()) {
          const key = row.role || 'params:row:' + index;
          const fixed = row.role === 'prompt';
          const confirming = pendingParamRemove === id + '::' + index;
          // 模型行不在这张表里：它有自己的方框（参数名 / 暴露 / 行级锁，不可删）。
          if (row.role === 'model') {
            modelRow = { index, row };
            continue;
          }
          // enum 行不在这张表里：每个 enum 参数一个方框（见下面的 enumRows）。
          if (row.type === 'enum') {
            enumRows.push({ index, row });
            continue;
          }

          // ① 参数名：一格一个输入框（工作流的落点只留在数据里，不再渲染第二行小字）。
          const nameCell = h('div', {
            'data-param-cell': 'name',
            style: COMMON_PARAM_CELL
          },
            h(ParamCellInput, {
              value: row.name,
              disabled: locked,
              onChange: onChange(index, 'name'),
              className: MC.input,
              style: COMMON_PARAM_CONTROL,
              attributes: {
                'data-param-key': key,
                'data-param-field': 'name',
                'aria-label': t('form.paramName') + ' ' + (index + 1),
                'aria-description': row.workflow ? t('form.paramNameHintWorkflow') : t('form.paramNameHint'),
                placeholder: row.role ? COMMON_PARAM_NAMES[row.role] : (row.workflow ? row.input : 'seed')
              }
            })
          );

          // ② 类型。
          const typeCell = h('div', { 'data-param-cell': 'type', style: COMMON_PARAM_CELL },
            h(ParamCellSelect, {
              value: row.type,
              disabled: locked || fixed,
              onChange: onType(index),
              className: MC.input + ' ' + MC.selectInput,
              style: Object.assign({}, COMMON_PARAM_CONTROL, { paddingRight: 18 }),
              attributes: {
                'data-param-key': key + '.type',
                'data-param-field': 'type',
                'aria-label': t('form.paramType') + ' ' + (index + 1)
              },
              children: COMMON_PARAM_TYPES.filter((type) => type !== 'json' || (!row.workflow && !row.role))
                .map((type) => h('option', { key: type, value: type }, type))
            })
          );

          // ③ 默认值。
          const defaultCell = h('div', { 'data-param-cell': 'default', style: COMMON_PARAM_CELL },
            h(ParamCellInput, {
              value: row.default,
              disabled: locked || fixed,
              onChange: onChange(index, 'default'),
              className: MC.input,
              style: COMMON_PARAM_CONTROL,
              attributes: {
                'data-param-key': key + '.default',
                'data-param-field': 'default',
                'aria-label': t('form.paramDefault') + ' ' + (index + 1),
                placeholder: '—'
              }
            })
          );

          // ④ 描述：给对话模型看的说明（enum 的选项不在这里，见 enum 方框）。
          const descriptionCell = h('div', { 'data-param-cell': 'description', style: COMMON_PARAM_CELL },
            h(ParamCellInput, {
              value: row.description,
              disabled: locked,
              onChange: onChange(index, 'description'),
              className: MC.input,
              style: COMMON_PARAM_CONTROL,
              attributes: {
                'data-param-key': key + '.description',
                'data-param-field': 'description',
                'aria-label': t('form.paramDescription') + ' ' + (index + 1),
                'aria-description': t('form.paramDescriptionHint')
              }
            })
          );

          // ⑤ 操作：暴露 / 行级锁 / 删除（第 1 次点击只换成警告图标，不换文字）。
          const exposeButton = h(ParamActionButton, {
            className: MC.iconButton,
            style: Object.assign({}, COMMON_PARAM_ACTION, { opacity: row.expose ? 1 : 0.35 }),
            disabled: locked || fixed,
            tip: t('form.paramExposeHint'),
            onClick: () => setExpose(index, !row.expose),
            attributes: {
              'data-param-key': key + '.expose',
              'data-param-field': 'expose',
              'aria-pressed': row.expose ? 'true' : 'false',
              'aria-label': t('form.paramExpose') + ' ' + (index + 1)
            }
          }, h(ParamActionGlyph, { name: row.expose ? 'eye' : 'eye-off' }));
          const lockRowButton = h(ParamActionButton, {
            className: MC.iconButton,
            style: COMMON_PARAM_ACTION,
            disabled: locked,
            tip: row.locked ? t('form.lockOn') : t('form.paramRowLockHint'),
            onClick: toggleRowLock(index),
            attributes: {
              'data-param-key': key + '.lock',
              'data-param-field': 'lock',
              'aria-pressed': row.locked ? 'true' : 'false',
              'aria-label': t('form.paramLock') + ' ' + (index + 1)
            }
          }, h(ParamActionGlyph, { name: row.locked ? 'lock' : 'unlock' }));
          const removeButton = h(RowDeleteButton, {
            style: COMMON_PARAM_ACTION,
            disabled: locked,
            confirming: confirming,
            tip: confirming ? t('form.paramConfirmRemove') : t('form.paramRemove'),
            onClick: requestRemove(index),
            attributes: {
              'data-param-key': key + '.remove',
              'data-param-field': 'remove',
              'aria-label': (confirming ? t('form.paramConfirmRemove') : t('form.paramRemove')) + ' ' + (index + 1)
            }
          });
          const actionsCell = h('div', {
            'data-param-cell': 'actions',
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2,
              minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap'
            }
          },
            exposeButton,
            lockRowButton,
            fixed ? h('span', { key: 'remove', style: { flex: 'none', width: 24, height: 24 } }) : removeButton
          );

          tableRows.push(h('div', {
            key: 'param-' + index,
            'data-param-grid': 'params:row',
            'data-param-role': row.role || undefined,
            'data-param-bind': row.workflow ? 'workflow' : 'http',
            'data-param-index': String(index),
            style: Object.assign({}, COMMON_PARAM_GRID, {
              minHeight: COMMON_PARAM_ROW_HEIGHT,
              padding: '0 8px',
              borderTop: index === 0 ? undefined : '.5px solid var(--dsw-alias-border-l3)'
            })
          }, nameCell, typeCell, defaultCell, descriptionCell, actionsCell));
        }
        /**
         * enum 参数一个方框（和「质量」方框同构）：标题是参数名，框内是参数名 / 描述两条线，
         * 加一张「选项名 / 值 / 是否默认」的选项表（和参数表同一套 grid），末尾「+ 添加选项」。
         *
         * 数据仍是 params 里的一行（`type:'enum'` + `options` 字符串数组）：选项名就是发出去
         * 的值，所以「值」列显示的是同一份字符串（只读，截断规则与参数表一致）；「是否默认」
         * 直接落在行上的 `default`（默认值命中哪一项就勾哪一项）。
         *
         * 行级的暴露 / 行锁 / 删除跟着搬进标题行：enum 行已经不在这张表里了，留在这里
         * 才不会丢掉「能不能给对话模型用」和「这一行删不删得掉」。
         */
        const enumBox = (index, row) => {
          const key = row.role || 'params:row:' + index;
          const boxKey = 'enum:' + index;
          const title = String(row.name || '').trim()
            || (row.role && PARAM_LABELS[row.role] ? t(PARAM_LABELS[row.role]) : '')
            || t('form.paramOptions');
          const confirming = pendingParamRemove === id + '::' + index;
          const defaultAt = row.options.indexOf(row.default);
          const headExtra = [
            h(ParamActionButton, {
              key: 'expose',
              className: MC.iconButton,
              style: Object.assign({}, COMMON_PARAM_ACTION, { opacity: row.expose ? 1 : 0.35 }),
              disabled: locked,
              tip: t('form.paramExposeHint'),
              onClick: () => setExpose(index, !row.expose),
              attributes: {
                'data-param-key': boxKey + '.expose',
                'data-param-field': 'expose',
                'aria-pressed': row.expose ? 'true' : 'false',
                'aria-label': t('form.paramExpose') + ': ' + title
              }
            }, h(ParamActionGlyph, { name: row.expose ? 'eye' : 'eye-off' })),
            h(RowDeleteButton, {
              key: 'remove',
              style: COMMON_PARAM_ACTION,
              disabled: locked,
              confirming: confirming,
              tip: confirming ? t('form.paramConfirmRemove') : t('form.paramRemove'),
              onClick: requestRemove(index),
              attributes: {
                'data-param-key': boxKey + '.remove',
                'data-param-field': 'remove',
                'aria-label': (confirming ? t('form.paramConfirmRemove') : t('form.paramRemove')) + ': ' + title
              }
            }),
            // 行级锁：只挡一键配置与自动检测，手动编辑照旧（和参数行上的锁同一套语义）。
            h(BoxLockButton, {
              key: 'lock',
              className: MC.iconButton,
              locked: row.locked,
              disabled: locked,
              tip: row.locked ? t('form.lockOn') : t('form.lockOff'),
              onClick: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                toggleRowLock(index)();
              },
              attributes: {
                'data-lock-key': boxKey,
                'data-locked': row.locked ? 'true' : 'false',
                'aria-pressed': row.locked ? 'true' : 'false',
                'aria-label': t('form.paramLock') + ': ' + title
              }
            })
          ];
          const nameLine = paramLine(t('form.paramName'), h('input', {
            className: MC.input, type: 'text', spellCheck: false,
            style: PARAM_INPUT_STYLE,
            'data-param-key': key,
            'data-param-field': 'name',
            'aria-label': t('form.paramName') + ': ' + title,
            'aria-description': row.workflow ? t('form.paramNameHintWorkflow') : t('form.paramNameHint'),
            disabled: locked,
            value: row.name,
            placeholder: row.role ? COMMON_PARAM_NAMES[row.role] : (row.workflow ? row.input : 'seed'),
            onChange: onChange(index, 'name')
          }), null, boxKey + ':name');
          const descriptionLine = paramLine(t('form.paramDescription'), h('input', {
            className: MC.input, type: 'text', spellCheck: false,
            style: PARAM_INPUT_STYLE,
            'data-param-key': key + '.description',
            'data-param-field': 'description',
            'aria-label': t('form.paramDescription') + ': ' + title,
            'aria-description': t('form.paramDescriptionHint'),
            disabled: locked,
            value: row.description,
            onChange: onChange(index, 'description')
          }), null, boxKey + ':description');
          const optionRows = row.options.map((option, at) => h('div', {
            key: 'option-' + at,
            'data-param-grid': boxKey + ':option',
            'data-param-index': String(at),
            style: subtableRow(at === 0)
          },
            h(ParamCellInput, {
              value: option,
              disabled: locked,
              onChange: setOptionText(index, at),
              className: MC.input,
              style: COMMON_PARAM_CONTROL,
              attributes: {
                'data-param-key': boxKey + '.option.label',
                'aria-label': t('form.paramOptionLabel') + ' ' + (at + 1),
                placeholder: t('form.paramOptionLabel')
              }
            }),
            h(ParamLabel, {
              style: SUBTABLE_VALUE,
              text: option,
              extra: {
                'data-param-key': boxKey + '.option.value',
                'data-param-cell': 'value',
                'aria-label': t('form.paramOptionValue') + ' ' + (at + 1)
              }
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 } },
              h('input', {
                type: 'radio',
                style: { flex: 'none', margin: 0 },
                name: 'enum-default-' + id + '-' + index,
                'data-param-key': boxKey + '.option.default',
                'aria-label': t('form.paramOptionDefault') + ' ' + (at + 1),
                disabled: locked,
                checked: defaultAt === at,
                onChange: setDefaultOptionAt(index, at)
              })),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', minWidth: 0 } },
              h(RowDeleteButton, {
                style: COMMON_PARAM_ACTION,
                disabled: locked,
                tip: t('form.paramRemoveOption'),
                onClick: removeOptionAt(index, at),
                attributes: {
                  'data-param-key': boxKey + '.option.remove',
                  'aria-label': t('form.paramRemoveOption') + ' ' + (at + 1)
                }
              }))
          ));
          return paramBox(id, boxKey, locks, title, [
            nameLine,
            descriptionLine,
            h('div', { 'data-param-table': 'enum', style: SUBTABLE_FRAME },
              h('div', { 'data-param-grid': boxKey + ':head', style: SUBTABLE_HEAD },
                commonHeadCell(t('form.paramOptionLabel'), 'label'),
                commonHeadCell(t('form.paramOptionValue'), 'value'),
                commonHeadCell(t('form.paramOptionDefault'), 'default'),
                commonHeadCell(t('form.paramActions'), 'actions')
              ),
              ...optionRows
            ),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              h('button', {
                type: 'button', className: MC.linkButton,
                'data-param-key': boxKey + '.option.add',
                disabled: locked,
                onClick: addOption(index)
              }, IconPlus ? h(IconPlus, { size: 14 }) : null, t('form.paramAddOption'))
            )
          ], { lockInHead: false, headExtra });
        };
        /** 参数名为空时输入框用的红边框（只标红，不拦保存）。 */
        const INVALID_INPUT_STYLE = {
          borderColor: 'var(--dsw-alias-state-error-primary)',
          boxShadow: '0 0 0 1px var(--dsw-alias-state-error-primary)'
        };
        /** 框内提示文字：和「高级」里那些说明同一档字号，颜色换成错误色。 */
        const INVALID_HINT_STYLE = {
          gridColumn: '1 / -1', margin: 0, fontSize: 12, lineHeight: '16px',
          color: 'var(--dsw-alias-state-error-primary)'
        };
        /**
         * 「模型」方框：「常规」表里唯一的特殊行，搬出来单独一个框（和 enum 方框同构）。
         *
         * 框里只有两样东西：参数名输入、行级锁（🔒）；**没有删除按钮**——每个请求都要带
         * 模型名，删掉这一行只会让请求悄悄少一个字段。**也没有暴露开关**：模型是特殊值，
         * 是否暴露只由「选择器是不是停在自动」推导（宿主 config-store 的 modelRowExposed），
         * 用户不需要也不应该手动设，行上也不落 expose。
         *
         * 参数名是这一行唯一的必填项（默认值可以是空——「自动」时模型名由对话模型填）：
         * 留空只把该行标红并在框里给一句提示，保存照常放行。
         */
        const modelBox = (index, row) => {
          const boxKey = 'model';
          const title = t('form.paramModel');
          const blank = !String(row.name || '').trim();
          // 行级锁：只挡一键配置与自动检测，手动编辑照旧（和 enum 方框同一套语义）。
          const lockButton = h(BoxLockButton, {
            key: 'lock',
            className: MC.iconButton,
            locked: row.locked,
            disabled: locked,
            tip: row.locked ? t('form.lockOn') : t('form.lockOff'),
            onClick: (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault();
              toggleRowLock(index)();
            },
            attributes: {
              'data-lock-key': boxKey,
              'data-param-key': 'model.lock',
              'data-param-field': 'lock',
              'data-locked': row.locked ? 'true' : 'false',
              'aria-pressed': row.locked ? 'true' : 'false',
              'aria-label': t('form.paramLock') + ': ' + title
            }
          });
          const nameLine = paramLine(t('form.paramName'), h('input', {
            className: MC.input, type: 'text', spellCheck: false,
            style: blank ? Object.assign({}, PARAM_INPUT_STYLE, INVALID_INPUT_STYLE) : PARAM_INPUT_STYLE,
            'data-param-key': boxKey,
            'data-param-field': 'name',
            'aria-label': t('form.paramName') + ': ' + title,
            'aria-description': t('form.paramNameHint'),
            'aria-invalid': blank ? 'true' : undefined,
            disabled: locked,
            value: row.name,
            placeholder: COMMON_PARAM_NAMES.model,
            onChange: onChange(index, 'name')
          }), null, boxKey + ':name');
          // 必填只针对参数名：值为空是合法的（「自动」时由对话模型填）。只提示，不拦保存。
          const blankHint = blank ? h('p', {
            'data-param-hint': boxKey,
            role: 'alert',
            style: INVALID_HINT_STYLE
          }, t('form.paramNameRequired')) : null;
          return paramBox(id, boxKey, locks, title, [nameLine, blankHint], {
            lockInHead: false,
            headExtra: [lockButton],
            invalid: blank
          });
        };
        /**
         * 「自定义工作流」：搬进「常规」方框，作为参数表前面的第一块。
         * textarea 高度减半（4 行 / 80px）——粘 JSON 够用，又不把参数表挤出屏幕。
         * label 行右侧是「插入示例模板」；「留空则自动选内置工作流」这句并进 placeholder，
         * 不再单独占一行。
         */
        const workflowEditor = settings.workflow ? [
          h('div', {
            'data-param-workflow': 'label',
            style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%' }
          },
            h('span', {
              className: MC.modelFieldLabel,
              style: {
                margin: 0, minWidth: 0, flex: '0 1 auto',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }
            }, t('form.modelWorkflow')),
            h('button', {
              type: 'button', className: MC.secondaryButton,
              'data-param-workflow-action': 'sample',
              style: { marginLeft: 'auto', flex: 'none', whiteSpace: 'nowrap' },
              onClick: () => setModelWorkflow(id, modelWorkflowTemplate())
            }, t('form.modelWorkflowSample'))
          ),
          h('textarea', {
            'data-param-workflow': 'input',
            className: MC.input,
            rows: 4,
            spellCheck: false,
            'aria-label': t('form.modelWorkflow'),
            style: {
              fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
              fontSize: 13,
              minHeight: 80,
              resize: 'vertical'
            },
            value: modelWorkflowOf(id),
            placeholder: t('form.modelWorkflowPlaceholder'),
            onChange: (event) => setModelWorkflow(id, event.target.value)
          }),
          h('div', {
            'data-param-workflow': 'actions',
            className: MC.rowActions,
            style: { gridColumn: '1 / -1', justifyContent: 'flex-start' }
          },
            modelWorkflowOf(id) ? h('button', {
              type: 'button', className: MC.secondaryButton,
              disabled: !!(workflowAnalysis[id] && workflowAnalysis[id].loading),
              onClick: () => analyzeModelWorkflow(id)
            }, workflowAnalysis[id] && workflowAnalysis[id].loading
              ? t('form.modelMappingParsing')
              : t('form.modelMappingParse')) : null
          ),
          mappingPanel(id),
          h('p', { className: MC.advancedHint, style: { margin: 0 } },
            t('form.paramWorkflowTableHint'))
        ] : [];
        // 空表不只留一个表头：ComfyUI / A1111 各给一句下一步该做什么。
        const emptyHint = tableRows.length === 0 ? h('div', {
          'data-param-empty': settings.workflow ? 'workflow' : 'generic',
          style: {
            padding: '12px 8px', fontSize: 12, lineHeight: '18px',
            color: 'var(--dsw-alias-label-tertiary)', textAlign: 'left'
          }
        }, settings.workflow ? t('form.paramsEmptyWorkflow') : t('form.paramsEmpty')) : null;
        const commonTable = paramBox(id, 'common', locks, t('form.paramsCommon'), [
          ...workflowEditor,
          h('div', {
            'data-param-table': 'common',
            style: SUBTABLE_FRAME
          },
            h('div', {
              'data-param-grid': 'params:head',
              style: COMMON_PARAM_HEAD
            },
              commonHeadCell(t('form.paramName'), 'name'),
              commonHeadCell(t('form.paramType'), 'type'),
              commonHeadCell(t('form.paramDefault'), 'default'),
              commonHeadCell(t('form.paramDescription'), 'description'),
              commonHeadCell(t('form.paramActions'), 'actions')
            ),
            emptyHint,
            ...tableRows
          ),
          settings.allowAdd === false ? null : h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button', className: MC.linkButton,
              'data-param-key': 'params:add',
              disabled: locked,
              onClick: addRow
            }, IconPlus ? h(IconPlus, { size: 14 }) : null, t('form.paramAdd'))
          )
        ], { lockLabel: t('form.paramsCommon'), lockKey: 'prompt' });
        // 方框顺序：常规 → 模型 → 各 enum 方框（按表里的顺序）→ 调用方接的尺寸 / 质量 / 参考图。
        return h(React.Fragment, null,
          commonTable,
          modelRow ? modelBox(modelRow.index, modelRow.row) : null,
          ...enumRows.map((item) => enumBox(item.index, item.row)));
      };
      /**
       * 「参考图」方框：收不收 + 字段名 + 传法 + 多图策略。
       *
       *   ① 勾「支持参考图」= 这个模型收参考图。不勾时框内其余行**整块不渲染**，
       *      字段模板写 `image: null`（显式不发：合并时后面两层不许盖掉，写 body 时跳过）。
       *   ② 勾上时若三层都没有模板（既没覆盖、宿主也没声明）就补一条
       *      `{ path: 'image', as: 'dataUrl' }`——否则勾了照样发不出去。宿主声明了模板时
       *      不写覆盖：继承比复制一份更稳（预设升级后还能跟着变，取消勾选也回得去）。
       *   ③ 字段名 / 传法：沿用「先选传法、后填字段名」的那套（fieldsAs 暂存），
       *      清空字段名就删掉覆盖。
       *   ④ 多图策略：模板形状的另一种呈现，不额外存一个字段——single 是 { path }、
       *      array 是 { path: 'image[]' }、numbered 是 { numbered }。multipart 端点
       *      保留 multipart 挂法（只换字段名），换成 JSON 路径会让表单端点静默丢图。
       */
      const imageOptionsPanel = (id, locks) => {
        const locked = !!locks.image;
        const entry = draft.modelOptions[id] || {};
        const fieldEntry = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
        const stored = fieldEntry.image;
        const capability = imageSpecFor(draft.id, id);
        // 没配过的时候摆的是宿主声明的形状；配过就只看覆盖（null / false = 显式不发）。
        const supported = stored === undefined ? Boolean(capability) : Boolean(stored);
        const declared = stored === undefined
          ? capability
          : (stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null);
        const strategy = imageStrategyOf(declared);
        // 手填的字段名/传法跟着「这条覆盖」的形状走（和改动前一致：没有覆盖就当 JSON 路径）；
        // 策略要动的是真正会发的那个形状（覆盖优先，其次宿主声明），否则在表单端点上把
        // 形状从 multipart 换成 path 会让参考图静默丢掉（multipartFields 只认 multipart）。
        const override = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
        const kind = imageKindOf(override);
        const editStrategy = imageStrategyOf(override);
        const shapeKind = imageKindOf(override || declared);
        const name = override ? imageNameOf(override) : '';
        const asValue = declared && typeof declared.as === 'string' ? declared.as : pendingFieldAsOf(entry, 'image');

        /** 改 fields：一条都不剩就把这个键也去掉（空的 fields 不算配置）。 */
        const writeFields = (mutate) => updateModelEntry(id, (next) => {
          const fields = { ...(next.fields || {}) };
          mutate(fields);
          if (Object.keys(fields).length) next.fields = fields;
          else delete next.fields;
        });
        /** 字段名还没填时的传法暂存（见 pendingFieldAsOf）。 */
        const setPendingFieldAs = (value) => updateModelEntry(id, (next) => {
          const merged = { ...(next.fieldsAs && typeof next.fieldsAs === 'object' ? next.fieldsAs : {}) };
          if (value) merged.image = value;
          else delete merged.image;
          if (Object.keys(merged).length) next.fieldsAs = merged;
          else delete next.fieldsAs;
        });
        const writeTemplate = (template) => writeFields((fields) => {
          if (template) fields.image = template;
          else delete fields.image;
        });
        /** ① 总闸。勾上时按「有没有宿主声明」决定是继承还是补默认模板。 */
        const setSupported = (on) => writeFields((fields) => {
          if (!on) { fields.image = null; return; }
          const current = fields.image;
          if (current && typeof current === 'object' && !Array.isArray(current)) return;
          if (capability) delete fields.image;
          else fields.image = { path: 'image', as: 'dataUrl' };
        });
        /** ③ 字段名：按当前策略与传法合成模板；清空就删掉覆盖（传法留下来）。 */
        const setName = (text) => {
          if (!text) {
            writeTemplate(null);
            setPendingFieldAs(asValue);
            return;
          }
          writeTemplate(imageTemplateOf(kind, editStrategy, text, asValue));
          setPendingFieldAs('');
        };
        const setAs = (picked) => {
          const template = imageTemplateOf(kind, editStrategy, name, picked);
          if (template) {
            writeTemplate(template);
            setPendingFieldAs('');
            return;
          }
          // 字段名还没填也别拦着：模板造不出来（空 path 是坏配置），先把传法记进暂存，
          // 等字段名填上时由 setName 合成 { path: name, as: picked }。
          setPendingFieldAs(picked);
        };
        /** ④ 多图策略：字段名取底座（继承时用宿主声明的那个），其余原样保留。 */
        const setStrategy = (picked) => writeTemplate(
          imageTemplateOf(shapeKind, picked, name || imageNameOf(declared) || 'image', asValue)
        );

        const rows = [];
        // ① 收不收：整块的总闸，永远在。
        rows.push(paramLine(t('form.imageSupported'), h('input', {
          type: 'checkbox',
          style: { flex: 'none', margin: 0 },
          'data-param-key': 'image',
          'aria-label': t('form.imageSupported'),
          disabled: locked,
          checked: supported,
          onChange: (event) => setSupported(!!event.target.checked)
        }), null, 'image:supported'));
        if (supported) {
          // ② 字段名：留空跟随规则/预设。
          rows.push(paramLine(t('form.imageField'), h('input', {
            className: MC.input, type: 'text', spellCheck: false,
            style: PARAM_INPUT_STYLE,
            'data-param-key': 'image',
            'aria-label': t('form.imageField'),
            disabled: locked,
            value: name,
            placeholder: 'image',
            onChange: (event) => setName(event.target.value.trim())
          }), null, 'image:field'));
          // ③ 传法：编码形态（multipart 的形状不认 as，select 照样摆，写进模板时会被忽略）。
          rows.push(paramLine(t('form.imageAs'), h('select', {
            className: MC.input + ' ' + MC.selectInput,
            style: PARAM_INPUT_STYLE,
            'data-param-key': 'image.as',
            'aria-label': t('form.imageAs'),
            disabled: locked,
            value: asValue,
            onChange: (event) => setAs(String(event.target.value))
          }, [
            { value: '', label: t('form.sizeModeDefault') },
            { value: 'dataUrl', label: 'dataUrl' },
            { value: 'base64', label: 'base64' },
            { value: 'url', label: 'url' }
          ].map((option) => h('option', { key: option.value, value: option.value }, option.label))), null, 'image:as'));
          // ④ 多图策略：三种形状，字段名当底座。
          rows.push(h(TipFieldRow, {
            rowKey: 'image:mode',
            label: t('form.imageMode'),
            labelStyle: PARAM_LABEL_STYLE,
            tip: t('form.imageModeHint'),
            control: 'select',
            controlClassName: MC.input + ' ' + MC.selectInput,
            controlStyle: PARAM_INPUT_STYLE,
            attributes: { 'data-param-key': 'image.mode', 'aria-label': t('form.imageMode') },
            disabled: locked,
            value: strategy,
            onChange: (event) => setStrategy(String(event.target.value)),
            options: [
              { value: 'single', label: t('form.imageModeSingle') },
              { value: 'array', label: t('form.imageModeArray') },
              // 按序号写的是 JSON body 里的平行键（image / image_2 …），表单端点没有这个位置：
              // 选了它参考图会被静默丢掉（multipartFields 只认 multipart），所以不给选。
              { value: 'numbered', label: t('form.imageModeNumbered'), disabled: shapeKind === 'multipart' }
            ].map((option) => h('option', {
              key: option.value, value: option.value, disabled: option.disabled
            }, option.label))
          }));
        }
        return paramBox(id, 'image', locks, t(PARAM_LABELS.image), rows);
      };
      /**
       * 模型选项的面板：一个占满宽度的「高级」折叠区，展开后是
       * 「常规 → 各 enum 方框 → 尺寸 → 质量 → 参考图」一串全宽方框。
       * 自动检测与全部解锁挪到「高级」这一行的右端（同一个 <summary> 里），不再单独散在面板上。
       * 预设来源的提供商默认全锁，展开后看到的是锁，而不是一堆待填的空格。
       */
      const modelParamsPanel = (id) => {
        const locks = lockedMapOf(draft.modelOptions[id], draft);
        // 「常规」+ 模型 + 各 enum 方框：一个 Fragment，方框们仍是面板网格的直接子项。
        const paramBoxes = paramFieldsPanel(id, locks);
        // summary 里的按钮别把折叠区一起开合。
        const keepOpen = (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        };
        return h('div', { className: MC.modelAdvanced, style: MODEL_ROW_PANEL_STYLE },
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
              paramBoxes,
              sizeOptionsPanel(id, locks),
              qualityOptionsPanel(id, locks),
              imageOptionsPanel(id, locks)
            )
          )
        );
      };

      /**
       * 预设来源的提供商：`provider.presetId` 在 = 从预设 / 目录建的。
       *
       * 这类提供商的协议、鉴权、返回格式预设里已经写好了，用户零配置就该能用——所以整块
       * 「协议设置」不渲染，别让人去改一个已经正确的配置。自己填地址的（自定义 API、中转站、
       * 老配置）没有 presetId，形状未知，这一块照样给。
       *
       * 判据**只看来源**，不看地址像谁：手改 API 地址不动 presetId（见 urlField），改完仍是
       * 预设来源。本地部署预设（ComfyUI / A1111 / SwarmUI / sd-server …）与云厂商预设
       * 一视同仁——要配 `?token=`、自定义鉴权头或反向代理的人，本身就走「自定义模型 API」
       * 那条路。
       *
       * 同一份判据也用在「锁的默认值」与「一键配置」上（writeLock / canBulkConfigure），
       * 三处不能各说各话。
       */
      const presetSourced = Boolean(String(draft.presetId || '').trim());
      /**
       * 「认不出是哪家」的提醒：没有预设来源、又不是用户自己配的那一类 —— 这才是
       * 「本该是某个已知提供商，但说不出是哪家」的那一档（地址是预设的、协议却不是
       * 预设里的那一条）。
       *
       * 不提醒的几处，它们本来就没有预设来源，是设计如此：
       *   - 自定义 API / 自定义协议：判据与列表里的「自定义」标签是同一份
       *     （isCustomProvider），别另写一套条件；
       *   - 新建表单里的「自定义模型 API」入口（mode === 'custom'）：用户已经明确选了
       *     「我自己配」，再红字告诉他「没认出预设」纯属噪音。
       */
      const isCustomMode = isNew && mode === 'custom';
      const customProvider = isCustomMode || isCustomProvider(draft);
      const unrecognizedProvider = !presetSourced && !customProvider;
      const presetNotice = unrecognizedProvider
        ? h('p', {
            className: MC.advancedHint,
            // 红字用现有的错误色变量，与表单里其它报错同一个颜色。
            style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' },
            'data-mo-image-provider-notice': ''
          }, t('form.providerUnrecognized'))
        : null;
      // 「一键配置」只给「规则表管得着」的提供商：自定义协议与 adapter 为空的中转站都需要它；
      // 从预设创建的那些开箱即用、默认全锁，按了也不会写任何键；只认工作流参数的协议
      // （RULELESS_ADAPTERS）规则表里根本没有它们的尺寸与质量，按了只会往配置里写噪音。
      const canBulkConfigure = !presetSourced
        && !RULELESS_ADAPTERS.includes(String(draft.adapter || '').trim().toLowerCase());
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
            canFetchModels ? h(TipButton, {
              className: MC.linkButton,
              disabled: modelFetch.loading || !connectionBase,
              tip: !connectionBase ? t('form.fetchNeedsBaseUrl') : '',
              onClick: fetchModels,
              children: modelFetch.loading ? t('form.fetching') : t('form.fetchModels')
            }) : null
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
            const rowLocks = lockedMapOf(draft.modelOptions[model], draft);
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
              h('div', {
                className: MC.modelRow,
                'data-expanded': optionsOpen || undefined
              },
                modelDragHandle(index),
                modelField('id', index, model),
                // 「模型选项」：和 DSH 设置页一致，是 ID 与删除之间的折叠箭头图标按钮
                h(TipButton, {
                  className: MC.iconButton,
                  tip: t('form.modelOptions'),
                  onClick: (event) => {
                    event.currentTarget.focus();
                    setOptionsFor(optionsOpen ? '' : model);
                  },
                  attributes: {
                    'aria-label': t('form.modelOptions') + ' ' + (index + 1),
                    'aria-expanded': optionsOpen
                  },
                  children: optionsOpen
                    ? (IconChevronDown ? h(IconChevronDown, {}) : '\u25be')
                    : (IconChevronRight ? h(IconChevronRight, {}) : '\u25b8')
                }),
                h(RowDeleteButton, {
                  tip: t('form.deleteModel'),
                  onClick: () => removeModel(index),
                  attributes: { 'aria-label': t('form.deleteModel') + ' ' + (index + 1) }
                }),
                modelField('name', index, model),
                optionsOpen ? (workflowSupported ? (String(draft.adapter || '') === 'a1111'
                  ? h('div', { className: MC.modelAdvanced, style: MODEL_ROW_PANEL_STYLE },
                    h('p', { className: MC.advancedHint, style: { gridColumn: '1 / -1', margin: 0 } },
                      t('form.a1111ParamRowsHint')),
                    paramFieldsPanel(model, rowLocks, { roles: false, seed: 'a1111' })
                  )
                  : h('div', { className: MC.modelAdvanced, style: MODEL_ROW_PANEL_STYLE },
                    paramFieldsPanel(model, rowLocks, { roles: false, workflow: true, allowAdd: false })
                  )) : modelParamsPanel(model)) : null,
                optionsOpen ? operationEditor(model) : null
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
      const saveDraft = async () => {
        if (connectionInFlight.current.has('save')) return;
        connectionInFlight.current.add('save');
        setSubmitError('');
        setSaving(true);
        try {
          const next = { ...draft, key: draft.auth?.mode === 'none' ? '' : draft.key.trim() };
          // 「跟随协议」= 不显式设置鉴权，落盘上等于没有 provider.auth：空 mode 不是一个
          // 能落盘的鉴权形态，别把 {mode: ''} 这种假值写进配置（宿主那边同样会丢掉它）。
          const authMode = String(draft.auth?.mode || '').trim();
          if (authMode) next.auth = { ...draft.auth, mode: authMode };
          else delete next.auth;
          if (operationTexts[''] !== undefined || draft.operations) {
            next.operations = operationsOf('');
          }
          next.modelOptions = { ...draft.modelOptions };
          for (const model of draft.models.filter(Boolean)) {
            if (operationTexts[model] === undefined) continue;
            const entry = { ...next.modelOptions[model], operations: operationsOf(model) };
            next.modelOptions[model] = entry;
          }
          await props.onSave(next);
        } catch (error) {
          setSubmitError(serverErrorText(t, error));
        } finally {
          connectionInFlight.current.delete('save');
          setSaving(false);
        }
      };
      const actions = h(React.Fragment, null,
        submitError ? h('p', { className: MC.error, role: 'alert' }, submitError) : null,
        h('div', { className: MC.editorActions },
          h('button', { type: 'button', className: MC.secondaryButton, disabled: saving, onClick: props.onClose }, t('form.cancel')),
          h('button', { type: 'button', className: MC.primaryButton, disabled: saving, onClick: saveDraft }, saving ? t('form.saving') : t('form.save'))
        )
      );
      /**
       * 两个折叠区的内容：新建（自定义模型 API）与编辑传的是同一组，顺序也一样。
       * 「协议设置」里协议在前、鉴权在后；「自定义设置」里模型目录 → 路由 → 调度模型。
       * 删掉或挪动这里的任意一项，新建与编辑会同时变——这正是要的效果。
       */
      const protocolSettingsFields = [protocolField, authField, protocolOptionsField, operationEditor('')];
      const advancedSettingsFields = [modelDirectory, routePanel, hostModelField];
      /**
       * 新建 / 编辑共用的那份布局参数。这里只填「哪些字段有、折叠区开没开、按钮行长什么样」，
       * 字段顺序与折叠区划分由 ProviderFormLayout 一处决定。
       */
      const sharedFormLayout = {
        t: t,
        presetSourced: presetSourced,
        // 认不出提供商时的那句红字：排在 API 密钥上方（表单最顶部），见 ProviderFormLayout。
        notice: presetNotice,
        // 三个主字段常显：密钥、显示名称、API 地址 ——「接哪家、叫它什么、地址是什么」，不进折叠区。
        fields: { key: keyField, name: nameField, url: urlField },
        protocolFields: protocolSettingsFields,
        advancedFields: advancedSettingsFields,
        protocolOpen: protocolOpen,
        advancedOpen: advanced,
        onProtocolToggle: (event) => setProtocolOpen(event.currentTarget.open),
        onAdvancedToggle: (event) => setAdvanced(event.currentTarget.open),
        actions: actions,
        modelPicker: modelPicker
      };
      if (isNew) {
        const modes = DshSegmentedControl
          ? h(DshSegmentedControl, {
              id: 'mo-image-add-mode',
              label: t('form.addMode'),
              value: mode,
              options: [
                // 从「填个 key 就行」到「要先自己把服务跑起来」到「懂的人才用」：
                // 第三方预设 → 本地模型 → 自定义 API。顺序只影响展示，默认值仍是 catalog。
                { value: 'catalog', label: t('form.modeCatalog') },
                { value: 'local', label: t('form.modeLocal') },
                { value: 'custom', label: t('form.modeCustom') }
              ],
              onChange: (next) => switchMode(next)
            })
          : h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-1)' } },
              ['catalog', 'local', 'custom'].map((value) => h('button', {
                key: value, type: 'button', onClick: () => switchMode(value),
                style: { height: 28, padding: '0 12px', border: value === mode ? '.5px solid var(--dsw-alias-border-l3)' : 0, borderRadius: 'var(--dsw-radius-md)', background: value === mode ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: value === mode ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }
              }, value === 'catalog' ? t('form.modeCatalog') : value === 'custom' ? t('form.modeCustom') : t('form.modeLocal')))
            );
        const choosePreset = (id) => {
          const next = providerPresets.find((p) => p.id === id) || providerPresets[0];
          if (!next) return;
          setPresetId(next.id);
          setOperationTexts({});
          setDraft({
            ...draft,
            name: next.name,
            baseUrl: next.baseUrl,
            adapter: next.adapter || '',
            protocol: next.protocol || 'openai-images',
            protocolOptions: { ...(next.protocolOptions || {}) },
            auth: authDraftOf(next),
            optionalKey: false,
            presetId: next.id,
            operations: next.operations,
            customEndpoints: { ...(next.customEndpoints || {}) },
            modelOptions: { ...(next.modelOptions || {}) },
            key: '',
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
              // 目录里选的预设已经把协议 / 鉴权 / 返回格式都写好了：与编辑页同一套判据，
              // presetSourced 时不渲染返回格式编辑器（要自己填这些的走「自定义模型 API」）。
              presetSourced ? null : operationEditor(''),
              modelDirectory
            )
          )
        );
        const localBody = h(React.Fragment, null,
          localPresets.length ? field(t('form.localDeployer'), h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: localPreset ? localPreset.id : localPresetId,
            onChange: (e) => applyLocalPreset(e.target.value)
          }, localPresets.map((item) => h('option', { key: item.id, value: item.id }, item.name)))) : h('p', { className: MC.advancedHint }, t('form.localPresetsMissing')),
          nameField,
          keyField,
          // 地址跟着本地部署器走，选完就填好了：常显它只会让人以为还得核对一遍。
          // 真要改（反向代理、换端口）展开「自定义设置」就能改；标题沿用同一句。
          h('details', {
            className: MC.customized,
            'data-mo-image-local-endpoint': '',
            open: advanced,
            onToggle: (e) => setAdvanced(e.currentTarget.open)
          },
            h('summary', { className: MC.customizedSummary }, t('form.advanced')),
            h('div', { className: MC.customizedBody }, urlField)
          ),
          // 本地部署也是 presetId 来源：与云厂商同一套规则，鉴权 / 返回格式整块不渲染。
          // 要配 ?token= / 自定义鉴权头 / 反向代理的，走「自定义模型 API」。
          presetSourced ? null : authField,
          presetSourced ? null : operationEditor(''),
          modelDirectory
        );
        return ProviderFormLayout({
          ...sharedFormLayout,
          // 只有新建有「第三方 / 本地 / 自定义」这一排开关：它是入口，不是表单字段。
          leading: h('div', { className: MC.addModes },
            modes,
            h('p', { className: MC.advancedHint }, mode === 'catalog'
              ? t('form.modeCatalogHint')
              : mode === 'local'
                ? t('form.modeLocalHint')
                : t('form.modeCustomHint'))
          ),
          // 「自定义模型 API」走共用布局（不传 body）：字段顺序与折叠区跟编辑页逐项一致。
          // 目录 / 本地两条入口各用各的字段顺序（本地把地址收进了「自定义设置」），整体替换常显与两个折叠区。
          body: mode === 'catalog' ? catalogBody : mode === 'local' ? localBody : undefined
        });
      }
      // 编辑页与新建的「自定义模型 API」是同一段布局：这里只剩「传哪些字段」这件事。
      return ProviderFormLayout(sharedFormLayout);
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
      const save = async (provider) => {
        setSaveError('');
        const exists = store.providers.some((p) => p.id === provider.id);
        const providers = exists ? store.providers.map((p) => p.id === provider.id ? provider : p) : store.providers.concat(provider);
        const activeModelStillThere = store.active.model === 'auto' || providers.some((p) => p.id === store.active.providerId && p.models.includes(store.active.model));
        const nextActive = activeModelStillThere ? store.active : { providerId: provider.id, model: provider.models[0] || '' };
        const saved = await writeImageStore({ providers: providers, active: nextActive, defaults: store.defaults }, t, true);
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
            const ready = !!(provider.baseUrl && (provider.hasKey || provider.key || provider.optionalKey || provider.auth?.mode === 'none') && provider.models.length);
            const local = isLocalDeployment(provider);
            const custom = isCustomProvider(provider);
            // 内置提供商有名字有官网，只在自定义端点时才需要「自定义」标签。
            const tag = custom ? t('tag.custom') : (local ? t('tag.local') : '');
            const editing = edit && !edit.isNew && edit.provider.id === provider.id;
            return h('li', { className: MC.rowCard, key: provider.id },
              h('div', { className: MC.rowHead },
                h('span', { className: MC.rowIdentity },
                  h('span', { className: MC.rowName }, provider.name || t('section.unnamedProvider')),
                  tag ? h('span', { className: MC.rowTag }, tag) : null,
                  h(TipSpan, {
                    className: MC.credentialDot + ' ' + (ready ? MC.credentialDotConfigured : MC.credentialDotMissing),
                    tip: ready ? t('status.ready') : (provider.optionalKey ? t('status.missingLocal') : t('status.missingCloud')),
                    attributes: { 'aria-label': ready ? t('status.ready') : t('status.missingConfig') }
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

    /**
     * 即时提示气泡：悬停/键盘聚焦立刻弹出 —— 原生 title 有约 1 秒延迟，这类提示不能用它。
     * 走 portal + fixed 定位，不被设置面板的滚动/裁剪容器切掉；下面放不下就翻到上面。
     * 不注入 CSS：整套气泡就是这段内联样式，跟着组件走。
     * @param {string} text 气泡正文（`\n` 分行，行首行尾的空白由 pre-line 保留）
     * @param {{ width?: number|null, onlyWhenClipped?: boolean, clipped?: (el: any) => boolean }} [options]
     *   width 只当上限用（数字 = 该宽度，null / 缺省 = 260）；气泡本身按内容收缩，
     *   到上限再换行。旧调用点传的数字不再意味着固定宽度——短说明不该被拉成一长条。
     *   onlyWhenClipped 时只在内容被截断才弹；clipped 可提供自定义的截断判断
     *   （输入框的 scrollWidth 不可靠，用等宽镜像量）。
     * @returns {{ ref: object, handlers: object, node: any }} ref/handlers 挂到触发器上，node 是气泡。
     */
    function useInstantTip(text, options) {
      const opts = options || {};
      const content = String(text || '');
      // 宽度跟随内容：width:max-content + maxWidth 上限，超过才折行。
      const cap = typeof opts.width === 'number' ? opts.width : 260;
      const [pos, setPos] = React.useState(null);
      const ref = React.useRef(null);
      const show = () => {
        const el = ref.current;
        if (!content || !el || typeof window === 'undefined') return;
        // 没被截断就不用弹：完整文案本来就在眼前。
        // 输入框自己不上报文字溢出（scrollWidth 常等于 clientWidth），
        // 调用方可以用 clipped 提供一个等宽镜像的量法。
        if (opts.onlyWhenClipped) {
          const clipped = typeof opts.clipped === 'function'
            ? opts.clipped(el)
            : el.scrollWidth > el.clientWidth + 1;
          if (!clipped) return;
        }
        const box = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!box) return;
        const viewportWidth = Number(window.innerWidth) || (cap + 16);
        const viewportHeight = Number(window.innerHeight) || 0;
        // 生图席在输入框上方，气泡往下弹会被视口切掉；下面放不下就翻到上面。
        const above = viewportHeight - box.bottom < 96;
        setPos({
          left: Math.max(8, Math.min(box.left, viewportWidth - cap - 8)),
          top: above ? box.top - 6 : box.bottom + 6,
          above: above
        });
      };
      const hide = () => setPos(null);
      const node = pos && typeof document !== 'undefined'
        ? createPortal(h('div', {
            role: 'tooltip',
            'data-instant-tip': '',
            style: {
              // 席菜单/弹层都在 2000 以上（Codex 弹层是 2147482000），气泡必须压过它们。
              position: 'fixed', left: pos.left, top: pos.top, zIndex: 2147483000,
              transform: pos.above ? 'translateY(-100%)' : undefined,
              width: 'max-content',
              maxWidth: cap,
              boxSizing: 'border-box',
              padding: '6px 8px', borderRadius: 8,
              border: '.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2, #2b2b2d)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12, lineHeight: 1.45, textAlign: 'left', fontWeight: 400,
              // 一行一条：地址里没有可折的地方，按词断不开时允许断在任意处。
              whiteSpace: content.includes('\n') ? 'pre-line' : 'normal',
              wordBreak: 'break-word',
              boxShadow: '0 8px 24px rgba(0, 0, 0, .24)'
            }
          }, content), document.body)
        : null;
      return {
        ref: ref,
        handlers: { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide },
        node: node
      };
    }

    /**
     * 参数 label / 方框标题：超宽截断（ellipsis），悬停立刻给全名。
     * 原生 title 那约 1 秒的延迟对「差一个字就认错键名」的场景不可接受，所以走自绘气泡。
     */
    function ParamLabel(props) {
      const text = String((props && props.text) || '');
      const tip = useInstantTip(text, { width: null, onlyWhenClipped: true });
      return h('span', Object.assign({
        ref: tip.ref,
        className: props && props.className,
        style: props && props.style
      }, props && props.extra, tip.handlers), text, tip.node);
    }

    /**
     * 参数表单元格里的文本输入：内容超宽时截断，悬停用即时气泡给全文。
     * input 是 void 元素，气泡节点不能塞进去，所以外面包一层 span 当网格格子的内容。
     */
    function ParamCellInput(props) {
      const raw = props ? props.value : '';
      const value = String(raw === undefined || raw === null ? '' : raw);
      const mirrorRef = React.useRef(null);
      const tip = useInstantTip(value, {
        width: 280,
        onlyWhenClipped: true,
        clipped: () => {
          const input = tip.ref.current;
          const mirror = mirrorRef.current;
          if (!mirror) return Boolean(input) && input.scrollWidth > input.clientWidth + 1;
          if (!input) return false;
          // 镜像跟着输入框的实际字体量，避免 host 的 input 字体和正文不同导致误判。
          if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const style = window.getComputedStyle(input);
            if (style) {
              mirror.style.font = style.font;
              mirror.style.letterSpacing = style.letterSpacing;
            }
          }
          return mirror.scrollWidth > Math.max(0, input.clientWidth - 12);
        }
      });
      return h('span', { style: { display: 'block', minWidth: 0, maxWidth: '100%', position: 'relative' } },
        h('input', Object.assign({}, props && props.attributes, {
          ref: tip.ref,
          className: props && props.className,
          type: 'text',
          spellCheck: false,
          style: props && props.style,
          value: props && props.value,
          disabled: props && props.disabled,
          onChange: props && props.onChange
        }, tip.handlers)),
        h('span', {
          ref: mirrorRef,
          'aria-hidden': 'true',
          style: {
            position: 'absolute', left: 0, top: 0, visibility: 'hidden',
            whiteSpace: 'nowrap', fontSize: 12, pointerEvents: 'none'
          }
        }, value),
        tip.node
      );
    }

    /** 参数表单元格里的下拉：与文本输入同一套截断 + 气泡。 */
    function ParamCellSelect(props) {
      const tip = useInstantTip(String((props && props.value) || ''), { width: 220, onlyWhenClipped: true });
      const children = props && props.children;
      return h('span', { style: { display: 'block', minWidth: 0, maxWidth: '100%' } },
        h('select', Object.assign({}, props && props.attributes, {
          ref: tip.ref,
          className: props && props.className,
          style: props && props.style,
          value: props && props.value,
          disabled: props && props.disabled,
          onChange: props && props.onChange
        }, tip.handlers), Array.isArray(children) ? children : (children === undefined ? null : children)),
        tip.node
      );
    }

    /**
     * 操作列的图标字形：暴露 / 锁定 / 删除确认共用一个包装，尺寸、描边、
     * 基线才对得齐（之前是 👁 🔒 🗑 三个 emoji，字号和基线都不一致）。
     * 删除本身复用模型列表的垃圾桶图标（IconTrash），不在这里再画一份。
     */
    const PARAM_GLYPHS = {
      // 已暴露：正常睁开的眼睛。
      eye: [
        ['path', 'M1.5 8c1.55-2.85 3.9-4.4 6.5-4.4s4.95 1.55 6.5 4.4c-1.55 2.85-3.9 4.4-6.5 4.4S3.05 10.85 1.5 8Z'],
        ['circle', { cx: 8, cy: 8, r: 2.1 }]
      ],
      // 未暴露：同一只眼睛压一道斜线（eye-off）——不靠颜色，形状本身就能分辨。
      'eye-off': [
        ['path', 'M1.5 8c1.55-2.85 3.9-4.4 6.5-4.4s4.95 1.55 6.5 4.4c-1.55 2.85-3.9 4.4-6.5 4.4S3.05 10.85 1.5 8Z'],
        ['circle', { cx: 8, cy: 8, r: 2.1 }],
        ['path', 'M2.3 2.3 13.7 13.7']
      ],
      // 上锁：闭合的锁——锁梁两端都落回锁体，锁体上方是完整的「∩」。
      lock: [
        ['rect', { x: 3.3, y: 7.1, width: 9.4, height: 6.3, rx: 1.3 }],
        ['path', 'M5.4 7.1V4.6a2.6 2.6 0 0 1 5.2 0v2.5'],
        ['path', 'M8 9.5v1.6']
      ],
      // 未锁：开锁——锁梁整体抬起、右端悬空在锁体上方，缺口和高度差都看得见。
      unlock: [
        ['rect', { x: 3.3, y: 7.1, width: 9.4, height: 6.3, rx: 1.3 }],
        ['path', 'M5.4 7.1V4.2a2.6 2.6 0 0 1 4.9-1.4'],
        ['path', 'M8 9.5v1.6']
      ],
      // 删除的二次确认：三角感叹号（同一个按钮换图标，不换文字）。
      warning: [
        ['path', 'M8 2.3 14.4 13.2H1.6Z'],
        ['path', 'M8 6.1v3.2'],
        ['path', 'M8 11.6v.01']
      ]
    };

    function ParamActionGlyph(props) {
      const name = String((props && props.name) || '');
      const shapes = PARAM_GLYPHS[name] || [];
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-param-glyph': name || undefined,
        style: { display: 'block', flex: 'none' }
      }, shapes.map(([tag, spec], at) => (tag === 'circle'
        ? h('circle', { key: at, cx: spec.cx, cy: spec.cy, r: spec.r })
        : tag === 'rect'
          ? h('rect', { key: at, x: spec.x, y: spec.y, width: spec.width, height: spec.height, rx: spec.rx })
          : h('path', { key: at, d: spec }))));
    }

    /** 操作列里的图标按钮：悬停立刻出说明（原生 title 有延迟，不用）。 */
    function ParamActionButton(props) {
      const tip = useInstantTip(String((props && props.tip) || ''), { width: 260 });
      return h(React.Fragment, null,
        h('button', Object.assign({}, props && props.attributes, {
          ref: tip.ref,
          type: 'button',
          className: props && props.className,
          style: props && props.style,
          disabled: props && props.disabled,
          onClick: props && props.onClick
        }, tip.handlers), props && props.children),
        tip.node
      );
    }

    /** 方框标题旁的锁按钮样式：锁紧贴标题，占位与标题行其它操作一致。 */
    const LOCK_BUTTON_STYLE = { flex: 'none', padding: 0, fontSize: 12, lineHeight: '18px' };

    /**
     * 方框标题旁的锁：闭锁 / 开锁两套形状（形状差异，不靠颜色），
     * 说明走即时气泡 —— 原生 title 有约 1 秒延迟，和别的按钮不一致。
     */
    function BoxLockButton(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), { width: 260 });
      const button = h('button', Object.assign({}, p.attributes, {
        ref: tip.ref,
        type: 'button',
        className: p.className || MC.iconButton,
        style: p.style || LOCK_BUTTON_STYLE,
        disabled: p.disabled,
        onClick: p.onClick
      }, tip.handlers), h(ParamActionGlyph, { name: p.locked ? 'lock' : 'unlock' }));
      // 没弹气泡时直接返回按钮：标题行的最后一个子元素仍是 <button>（结构断言不用改）。
      return tip.node ? h(React.Fragment, null, button, tip.node) : button;
    }

    /**
     * 模型行那个「删除」图标按钮：常规参数表 / enum 选项表 / 质量挡位表的删除按钮
     * 全部复用它 —— 同一个组件、同一套样式（iconButtonDanger + 垃圾桶图标）。
     * 二次确认不换文字：confirming 时同一个按钮换成警告图标，再点才真删。
     */
    function RowDeleteButton(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), { width: 260 });
      const button = h('button', Object.assign({}, p.attributes, {
        ref: tip.ref,
        type: 'button',
        className: p.className || (MC.iconButton + ' ' + MC.iconButtonDanger),
        style: p.style,
        disabled: p.disabled,
        onClick: p.onClick
      }, tip.handlers), p.confirming
        ? h(ParamActionGlyph, { name: 'warning' })
        : (IconTrash ? h(IconTrash, { size: 14 }) : '\u00d7'));
      return tip.node ? h(React.Fragment, null, button, tip.node) : button;
    }

    /** 行内文本元素 + 即时气泡（元素本身不变，气泡节点跟在后面）。 */
    function TipSpan(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), p.tipOptions || { width: 260 });
      const node = h('span', Object.assign({}, p.attributes, {
        ref: tip.ref,
        className: p.className,
        style: p.style
      }, tip.handlers), p.children);
      return tip.node ? h(React.Fragment, null, node, tip.node) : node;
    }

    /** 普通按钮 + 即时气泡（seat 皮肤里的图标按钮用，原生 title 不再出现）。 */
    function TipButton(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), p.tipOptions || { width: 260 });
      const node = h('button', Object.assign({}, p.attributes, {
        ref: tip.ref,
        type: 'button',
        className: p.className,
        style: p.style,
        disabled: p.disabled,
        onClick: p.onClick
      }, tip.handlers), p.children);
      return tip.node ? h(React.Fragment, null, node, tip.node) : node;
    }

    /**
     * 带即时气泡的一行参数（label + 一个控件）。
     * 控件仍是这一行的第二个子元素（和 paramLine 的结构一致），气泡节点挂在行尾、不占位。
     */
    function TipFieldRow(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), p.tipOptions || { width: 300 });
      const control = p.control === 'select'
        ? h('select', Object.assign({}, p.attributes, {
          ref: tip.ref,
          className: p.controlClassName,
          style: p.controlStyle,
          disabled: p.disabled,
          value: p.value,
          onChange: p.onChange
        }, tip.handlers), p.options)
        : h('input', Object.assign({}, p.attributes, {
          ref: tip.ref,
          className: p.controlClassName,
          type: p.type || 'text',
          spellCheck: false,
          style: p.controlStyle,
          disabled: p.disabled,
          value: p.value,
          placeholder: p.placeholder,
          onChange: p.onChange
        }, tip.handlers));
      return h('div', {
        'data-param-row': p.rowKey || undefined,
        style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
      }, h(ParamLabel, { className: MC.modelFieldLabel, style: p.labelStyle, text: p.label }), control, tip.node);
    }

    /** 「比例 / 档位另写一个字段」行：输入框 + 可选来源下拉，气泡挂在输入框上。 */
    function TipSecondRow(props) {
      const p = props || {};
      const tip = useInstantTip(String(p.tip || ''), p.tipOptions || { width: 300 });
      const input = h('input', Object.assign({}, p.attributes, {
        ref: tip.ref,
        className: p.controlClassName,
        type: 'text',
        spellCheck: false,
        style: p.controlStyle,
        disabled: p.disabled,
        value: p.value,
        placeholder: p.placeholder,
        onChange: p.onChange
      }, tip.handlers));
      return h('div', {
        'data-param-row': p.rowKey || undefined,
        style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
      }, h(ParamLabel, { className: MC.modelFieldLabel, style: p.labelStyle, text: p.label }), input, p.secondary || null, tip.node);
    }

    /**
     * 「?」帮助按钮的通用外壳：圆形 helpButton + 即时气泡。
     * 协议地址与鉴权方式共用同一套样式，但各自持有自己的 hover 处理器——
     * 悬停相邻按钮不会把问号带进 hover 态。
     */
    function HelpTip(props) {
      const text = String((props && props.text) || '');
      const label = String((props && props.label) || '');
      const tip = useInstantTip(text, { width: 300 });
      return h('button', Object.assign({
        ref: tip.ref,
        type: 'button',
        className: (props && props.className) || MC.helpButton,
        'aria-label': label,
        // 读屏器同样能拿到完整说明，不必靠悬停。
        'aria-description': text,
        onClick: (event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault(); }
      }, props && props.attributes, tip.handlers), '?', tip.node);
    }

    /**
     * 协议 label 右侧的问号：三条真实地址收进即时气泡，一行一条，不再各占一行版面。
     * 与 label 全名同一套自绘气泡（原生 title 有约 1 秒延迟）。
     */
    function RouteHelp(props) {
      return h(HelpTip, {
        text: String((props && props.text) || ''),
        label: String((props && props.label) || ''),
        className: (props && props.className) || MC.helpButton,
        attributes: { 'data-route-help': '' }
      });
    }

    /** 「?」帮助标记：悬停立刻出现（不走 title 的原生延迟），点击/键盘聚焦也能看。 */
    function MoHelp(props) {
      const text = String((props && props.text) || '');
      const tip = useInstantTip(text, { width: 236 });
      if (!text) return null;
      return h('span', Object.assign({
        ref: tip.ref,
        role: 'img',
        tabIndex: 0,
        'aria-label': text,
        style: {
          width: 14, height: 14, flex: 'none', borderRadius: '50%',
          border: '1px solid currentColor', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: 10, lineHeight: 1, opacity: 0.55, cursor: 'help'
        }
      }, tip.handlers), '?', tip.node);
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
      const topLevelLabel = levels.length ? (levels[levels.length - 1].label || levels[levels.length - 1].value) : '';
      const lowerHasUltra = levels.slice(0, -1).some((level) => (
        String(level.value || '').trim().toLowerCase() === 'ultra'
        || String(level.label || '').trim().toLowerCase() === 'ultra'
      ));
      const codexQualityLabel = (value) => (
        topLevelValue !== null && qualityValueFor(value, activeSpec) === topLevelValue
          ? (lowerHasUltra ? topLevelLabel : 'Ultra')
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
      // Keep this last so the test harness's positional seed stays stable.
      const [present, setPresent] = React.useState(false);
      const triggerRef = React.useRef(null);
      const popoverRef = React.useRef(null);
      const fastBtnRef = React.useRef(null);
      const tipRef = React.useRef(null);
      const railRef = React.useRef(null);
      const dustMotionRef = React.useRef(null);
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
      };

      React.useLayoutEffect(() => {
        if (open) { setPresent(true); return undefined; }
        /* Keep the visible page intact during the close animation; reset it
         * underneath the hidden popover so reopening starts on quality. */
        const timer = setTimeout(() => {
          setPresent(false);
          setPane('quality');
          setView(1);
          setSubProvider(null);
          setQuery('');
          setMessage(false);
        }, 180);
        return () => clearTimeout(timer);
      }, [open]);

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

      // Codex does not move focus when entering a provider's model page.
      // Focusing the search box 40ms into the slide scrolled the incoming page
      // and made the transition look faster and jittery; leave focus alone.

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

      /* Keep one dust field alive across Ultra/Fast transitions. The path
       * animation only needs JS frames while its playback rate ramps. */
      React.useLayoutEffect(() => {
        if (!open || !railRef.current) return undefined;
        const motion = createCodexDustMotion(railRef.current, sparkles);
        dustMotionRef.current = motion;
        return () => {
          motion.destroy();
          dustMotionRef.current = null;
        };
      }, [open, sparkles]);

      React.useLayoutEffect(() => {
        dustMotionRef.current?.setState({
          active: open && pane === 'quality',
          fast: promptOptimization,
          peak
        });
      }, [open, pane, promptOptimization, peak]);

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
        '--cmes-fill': codexFillFor(visualDisplay, dark, displayIndex, levels.length),
        '--cmes-track': codexTrackFor(codexFillFor(visualDisplay, dark, displayIndex, levels.length), dark),
        '--cmes-ink': codexInkFor(visualDisplay, dark, displayIndex, levels.length),
        '--cmes-dot': 'var(--dsw-alias-label-caption,#b6b6b8)',
        '--cmes-mote': codexMixHex(codexFillFor(visualDisplay, dark, displayIndex, levels.length), '#ffffff', dark ? 0.30 : 0.42),
        '--cmes-pos': String(fraction)
      };
      const triggerStyle = { '--cmes-ink': codexInkFor(codexVisualValue(value), dark, levelIndex, levels.length) };

      const autoRow = h(TipButton, {
        className: 'cmes-row',
        tip: t('seat.modelAutoHint'),
        onClick: chooseAuto,
        attributes: { 'aria-pressed': selectedAuto },
        children: [
          h('span', { className: 'cmes-rowName' }, t('seat.auto')),
          selectedAuto ? h('span', { className: 'cmes-rowDot', 'aria-hidden': true }) : null,
          null
        ]
      });
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
          onClick: () => chooseModel(activeProviderForPage.id, model)
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
          // 说明给读屏器；视觉上的解释由旁边的问号气泡负责（原生 title 有延迟，不再用）。
          'aria-description': t('seat.sizeStrictHint'),
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
      const codexPageStyle = (slot) => Object.assign({}, CODEX_PAGE_BASE, {
        transform: view === 2
          ? (slot === 1 ? 'translateX(-100%)' : 'translateX(0)')
          : (slot === 1 ? 'translateX(0)' : 'translateX(100%)')
      });
      const modelsPane = h('div', {
        className: 'cmes-pane cmes-models' + (pane === 'models' ? '' : ' hidden'),
        role: 'menu', 'aria-label': t('seat.menuModel'),
        inert: pane !== 'models' ? '' : undefined
      },
        h('div', {
          className: 'cmes-viewport' + (view === 2 ? ' view2' : ''),
          style: {
            position: 'relative', overflow: 'hidden', flex: '1 1 auto', minHeight: 0,
            transition: CODEX_VIEWPORT_TRANSITION
          }
        },
          // Keep these exact values in sync with codex's `.cmes-page` /
          // `.cmes-viewport` CSS. Inline avoids depending on the external style
          // tag having loaded before the first provider click.
          h('div', {
            className: 'cmes-page slot1',
            style: codexPageStyle(1),
            inert: view === 2 ? '' : undefined
          },
            h('div', { className: 'cmes-sec' }, t('seat.chooseModel')),
            page1RowsNode
          ),
          h('div', {
            className: 'cmes-page slot2',
            style: codexPageStyle(2),
            inert: view === 2 ? undefined : ''
          },
            h('div', { className: 'cmes-head' },
              h(TipButton, {
                className: 'cmes-back',
                tip: t('seat.back'),
                onClick: sizeSubPage ? () => setSubProvider('__size') : goBack,
                attributes: { 'aria-label': t('seat.back') },
                children: backChevron
              }),
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
          'aria-label': t('seat.choose')
        },
          h('span', { className: 'cmes-heading' }, displayLabel || t('seat.menuQuality'), chevron('cmes-iconSmall')),
          h('span', { className: 'cmes-modelName' }, activeModelName || t('seat.fallback'))
        ),
        h('div', { className: 'cmes-warning' }, h('span', null, t('seat.qualityWarning'))),
        h(TipButton, {
          className: 'cmes-tool cmes-reset',
          tip: t('seat.moreSettings'),
          onClick: openSettings,
          attributes: { 'aria-label': t('seat.moreSettings') },
          children: sizeIcon
        }),
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
          h('div', { className: 'cmes-dots' },
            levels.map((level, index) => h('i', {
              key: level.value,
              className: 'cmes-dot' + (hoveredDot === index ? ' hovered' : ''),
              style: { '--cmes-tick': levels.length > 1 ? index / (levels.length - 1) : 0 }
            }))),
          h('div', { className: 'cmes-fill' }),
          h('div', { className: 'cmes-dots cmes-tickOverlay', 'aria-hidden': true },
            h('div', { className: 'cmes-tickMotion' },
              levels.map((level, index) => h('i', {
                key: level.value,
                className: 'cmes-dot' + (index <= displayIndex ? ' passed' : '') + (index < displayIndex ? ' left-of-knob' : '') + (hoveredDot === index ? ' hovered' : ''),
                style: { '--cmes-tick': levels.length > 1 ? index / (levels.length - 1) : 0 }
              })))),
          h('div', { className: 'cmes-sparks', 'aria-hidden': true },
            sparkles.map((sparkle) => h('div', {
              key: sparkle.key,
              className: 'cmes-sp-path',
              style: { '--phase': sparkle.phase }
            }, h('i', {
              className: 'cmes-sp',
              style: {
                '--sp-top': sparkle.top,
                '--b': sparkle.b,
                '--dur': sparkle.dur,
                '--delay': sparkle.delay
              }
            })))) ,
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
        present ? ' present' : '',
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
        '--cmes-ink': codexInkFor(visualDisplay, dark, displayIndex, levels.length),
        // codex 样式没到位（ CSP/加载时序挡住）时也要保证它脱离文档流。
        // 否则整块弹层会把输入区顶上去、页面底部多出一大片空白。
    position: 'fixed',
        zIndex: 1100,
        left: (menuPos ? menuPos.left : 0) + 'px',
        bottom: (menuPos ? menuPos.bottom : 40) + 'px',
        width: CODEX_POPOVER_WIDTH + 'px',
        maxWidth: 'calc(100vw - 24px)',
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
        // Match the codex selector's portal layer exactly: display:contents
        // keeps the cmes-root variables but produces no layout/containing box.
        // A fixed 0x0 wrapper changes how the fixed popover is contained and
        // makes the page/height transitions behave differently from codex.
        return createPortal(h('div', {
          className: 'cmes-root',
          style: { display: 'contents' }
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
        const timer = setTimeout(() => { try { searchRef.current && searchRef.current.focus({ preventScroll: true }); } catch (_error) { /* ignore */ } }, 30);
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
            h('label', { className: MS.cellValue },
              h('input', {
                type: 'checkbox', checked: !!defaults.auto,
                'aria-label': t('seat.sizeAutoAria'),
                'aria-description': t('seat.sizeAutoHint'),
                onChange: (event) => saveDefaults({ auto: event.target.checked })
              })
            )
          ),
          // 严格模式紧跟自动尺寸：它管的是请求里的尺寸算不算数，与自动/固定无关。
          h('div', { key: 'strict', className: plainRow },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
              plainLabel(t('seat.sizeStrict')),
              h(MoHelp, { text: t('seat.sizeStrictHelp') })),
            h('label', { className: MS.cellValue },
              h('input', {
                type: 'checkbox', checked: !!defaults.strict, 'aria-label': t('seat.sizeStrict'),
                'aria-description': t('seat.sizeStrictHint'),
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
        onClick: () => choose(activeProvider ? activeProvider.id : '', 'auto')
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
            onClick: () => { setQuery(''); try { searchRef.current && searchRef.current.focus({ preventScroll: true }); } catch (_error) { /* ignore */ } }
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
                onClick: () => choose(provider.id, model)
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
        "form.protocolAuto": "自动",
        "form.protocolRoutes": "协议地址说明",
        "form.protocolSettings": "协议设置",
        "form.protocolOption.edit": "图生图端点",
        "form.protocolOption.edit.edits": "单独的 /images/edits",
        "form.protocolOption.edit.same": "同一个 /images/generations",
        "form.protocolOption.edit.none": "不支持图生图",
        "form.protocolOption.editHint": "编辑请求发到哪个地址：上游只有 /images/generations 时选「同一个」，完全不支持图生图时选「不支持」。",
        "form.auth": "鉴权方式",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "自定义请求头",
        "form.auth.none": "无鉴权",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "查询参数",
        "form.authFollow": "跟随协议",
        "form.authQueryName": "查询参数名",
        "form.authBasicCredential": "用户名与密码（username:password）",
        "form.operations": "请求与返回格式",
        "form.modelOperations": "此模型的请求与返回格式",
        "form.operationsHint": "选择返回预设，或用 JSON 配置 generate、edit 和 models 的方法、字段映射及响应。",
        "form.modelOperationsHint": "在 JSON 里覆盖 generate 或 edit。省略的选项沿用提供商设置。",
        "form.operationsInvalidJson": "请填写有效的 JSON 对象。",
        "form.operationOutput": "{operation}返回格式",
        "form.outputPreset.auto": "跟随协议",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "二进制图片",
        "form.outputPreset.image-url": "图片 URL",
        "form.outputPreset.image-base64": "Base64 图片",
        "form.outputPreset.task-location": "异步任务（Location）",
        "form.outputPreset.task-json": "异步任务（JSON ID）",
        "form.outputPreset.customLegacy": "自定义（来自旧配置）",
        "form.outputPreset.customLegacyHint": "当前值是以前手写的返回配置，原样保留；上面的预设选一个即可覆盖它。",
        "form.saving": "正在保存…",
        "serverError.provider.invalidAuth": "请检查鉴权方式及其字段。",
        "serverError.provider.invalidOperations": "请检查操作配置。{message}",
        "form.authHint": "密钥放在哪个请求头里：多数服务用 Authorization: Bearer，Azure 一类用 api-key；自定义可以填任意头名与前缀。",
        "form.authHeader": "请求头名称",
        "form.authPrefix": "前缀",
        "form.route.generate": "文生图",
        "form.route.edit": "图生图",
        "form.route.models": "获取模型列表",
        "form.routeUnsupported": "不支持",
        "form.customProtocol": "自定义",
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
        "form.modelOptionsUnsupported": "自定义工作流仅在 ComfyUI 部署器下可用",
        "form.modelWorkflow": "自定义工作流（ComfyUI API 格式）",
        "form.modelWorkflowPlaceholder": "在 ComfyUI 里用「导出（API）」保存，把 JSON 粘到这里 · 留空则按模型类型自动选择内置工作流",
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
        "form.modeCustomHint": "接入第三方或本地 HTTP 生图服务，可自定义请求地址、鉴权、参数和返回格式。",
        "form.modeLocalHint": "连接本机或局域网里的生图服务；无鉴权的本地服务可以留空 API 密钥。",
        "form.provider": "提供商",
        "form.providerWebsite": "前往提供商官网",
        "form.localDeployer": "本地部署器",
        "form.localPresetsMissing": "宿主没有下发本地部署器列表，请刷新页面后重试。",
        "form.providerUnrecognized": "未识别出提供商预设，将使用通用协议配置；如需零配置体验，请从「第三方模型提供商」里选择。",
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
        "seat.chooseModel": "切换模型",
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
        "serverError.provider.invalidProbe": "识别请求里的探测路径不在这个地址的计划里",
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
        "form.modelMappingImage": "参考图",
        "form.modelMappingColName": "参数名",
        "form.modelMappingColTarget": "参数映射",
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
        "param.steps.desc": "采样步数；越高细节越多，耗时也越长",
        "param.seed.desc": "随机种子；同一个种子加同样的参数会得到同一张图",
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
        "form.paramName": "参数名",
        "form.paramType": "类型",
        "form.paramDefault": "默认值",
        "form.paramDescription": "描述",
        "form.paramExpose": "暴露",
        "form.paramOptions": "选项",
        "form.paramNameHint": "发到请求体里的字段名；提示词行只能改名",
        "form.paramDescriptionHint": "给对话模型看的说明",
        "form.paramExposeHint": "勾上后对话模型才能用 params 改这个值",
        "form.paramOptionLabel": "选项名",
        "form.paramOptionValue": "值",
        "form.paramOptionDefault": "是否默认",
        "form.paramAddOption": "添加选项",
        "form.paramRemoveOption": "删除该选项",
        "form.paramActions": "操作",
        "form.paramRowLockHint": "锁定后不会被一键配置或自动检测改掉",
        "form.paramAdd": "添加参数",
        "form.paramRemove": "删除参数",
        "form.paramConfirmRemove": "确认删除？",
        "form.paramDescPrompt": "生图提示词",
        "form.paramDescNegative": "不想出现的内容",
        "form.paramDescModel": "请求里发送的模型名",
        "form.paramDescN": "一次生成的张数",
        "form.paramNameHintWorkflow": "工作流参数的名字只是给对话模型看的键",
        "form.paramNameRequired": "参数名不能为空；留空的话请求里没有模型名，这个模型就发不出去",
        "form.paramWorkflowTableHint": "下面是这个模型的参数表：解析工作流与解析参数得到的行都在这里，勾上「暴露」对话模型才能用 params 调",
        "form.paramsEmptyWorkflow": "还没解析出参数。先粘贴工作流，再点「解析工作流」。",
        "form.paramsEmpty": "这个模型还没有可调参数，点「添加参数」自己加。",
        "form.a1111ParamRowsHint": "默认值会随请求发送；清空某一行的默认值就沿用 WebUI 里的设置",
        "form.qualitySupported": "支持质量参数",
        "form.qualityField": "参数名",
        "form.qualityOptionLabel": "挡位名",
        "form.qualityOptionValue": "值",
        "form.qualityOptionDefault": "是否默认",
        "form.qualityAddOption": "添加挡位",
        "form.qualityRemoveOption": "删除该挡位",
        "form.imageAs": "传法",
        "form.imageField": "字段名",
        "form.imageSupported": "支持参考图",
        "form.imageMode": "多图策略",
        "form.imageModeSingle": "单张",
        "form.imageModeArray": "数组",
        "form.imageModeNumbered": "按序号",
        "form.imageModeHint": "单张写同一个字段；数组把所有图塞进这个字段；按序号展开成 name / name_2 / name_3 …",
        "form.autoDetect": "自动检测",
        "form.detecting": "检测中…",
        "form.detectNeedsModels": "先添加模型",
        "form.bulkConfigure": "一键配置",
        "form.bulkConfiguring": "配置中…",
        "form.bulkConfigDone": "已配置 {count} 个模型，{unmatched} 个未命中规则",
        "form.bulkConfigNone": "没有一个模型命中规则，按 OpenAI 兼容发送",
        "form.bulkConfigSkipped": "这些键都上锁了，一键配置没有写入任何值",
        "errors.detectRule": "规则检测失败",
        "form.protocolMore": "更多协议…",
        "form.detectProtocol": "识别协议",
        "form.detectProtocolBusy": "识别中…",
        "form.detectProtocolTrying": "正在尝试访问 {path}…",
        "form.detectProtocolLastTried": "；最后尝试 {path}",
        "form.detectProtocolMatched": "已识别为 {protocol}",
        "form.detectProtocolCompatible": "地址可用，已设为 {protocol}",
        "form.detectProtocolCustom": "没认出协议，已切到自定义并预填地址",
        "form.detectProtocolProbe": "已识别为 {protocol}（{probe} 返回 {shape}）",
        "form.detectProtocolVerified": "地址匹配 {protocol} 预设",
        "form.detectProtocolVerifiedProbe": "模型列表可访问（{probe} 返回 {shape}）",
        "form.detectProtocolMismatch": "地址不像 {protocol}，未改动当前选择",
        "form.detectProtocolMismatchSuggested": "地址不像 {protocol}；看起来像 {suggested}，未改动当前选择",
        "form.detectProtocolNoKey": "没有可用的 API Key（未填写或凭据解析失败），{probe} 无法鉴权",
        "form.detectProtocolAuthFailed": "鉴权失败（{probe} 返回 {status}）：Key 无效、未填写或没有权限",
        "form.detectProtocolNoEndpoint": "这个地址没有该接口（{probe} 返回 {status}）",
        "form.detectProtocolUnreachable": "无法连接到 {url}，请确保服务已经启动后再重试。",
        "form.detectProtocolTimeout": "连接 {url} 超时，请检查网络或代理后重试。",
        "form.detectProtocolHttpError": "服务端返回 {status}（{probe}）",
        "form.detectProtocolIssueSuffix": "；{issue}",
        "form.detectProtocolSwitchedToCustom": "；已切到自定义并预填地址",
        "form.probeShape.openai-data": "data 列表",
        "form.probeShape.gemini-models": "models 列表",
        "form.probeShape.array": "数组",
        "form.probeShape.object": "JSON 对象",
        "errors.detectProtocol": "识别协议失败",
        "protocolGroup.general": "通用",
        "protocolGroup.gateway": "兼容网关",
        "protocolGroup.native": "各家原生",
        "protocolGroup.local": "本地部署",
        "protocolGroup.async": "异步任务",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "百炼 Qwen-Image",
        "protocol.dashscope-wanx": "百炼 通义万相",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "魔搭 ModelScope",
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
        "form.protocolAuto": "Auto",
        "form.protocolRoutes": "Protocol endpoints",
        "form.protocolSettings": "Protocol settings",
        "form.protocolOption.edit": "Image-to-image endpoint",
        "form.protocolOption.edit.edits": "Separate /images/edits",
        "form.protocolOption.edit.same": "Same /images/generations",
        "form.protocolOption.edit.none": "No image editing",
        "form.protocolOption.editHint": "Where edit requests go: pick Same if the provider only exposes /images/generations, or No image editing if it has none.",
        "form.auth": "Authentication",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "Custom header",
        "form.auth.none": "No authentication",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Query parameter",
        "form.authFollow": "Follow protocol",
        "form.authQueryName": "Query parameter name",
        "form.authBasicCredential": "Credentials (username:password)",
        "form.operations": "Request and response formats",
        "form.modelOperations": "Request and response formats for this model",
        "form.operationsHint": "Select an output preset or configure the methods, field mappings, and responses for generate, edit, and models in JSON.",
        "form.modelOperationsHint": "Override generate or edit in JSON. Omitted options inherit the provider settings.",
        "form.operationsInvalidJson": "Enter a valid JSON object.",
        "form.operationOutput": "Response format for {operation}",
        "form.outputPreset.auto": "Follow protocol",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Binary image",
        "form.outputPreset.image-url": "Image URL",
        "form.outputPreset.image-base64": "Base64 image",
        "form.outputPreset.task-location": "Async job (Location)",
        "form.outputPreset.task-json": "Async job (JSON ID)",
        "form.outputPreset.customLegacy": "Custom (from legacy config)",
        "form.outputPreset.customLegacyHint": "This value was hand-written earlier and is kept as is. Pick a preset above to override it.",
        "form.saving": "Saving…",
        "serverError.provider.invalidAuth": "Check the authentication method and its fields.",
        "serverError.provider.invalidOperations": "Check the operation configuration. {message}",
        "form.authHint": "Which header carries the key: most services use Authorization: Bearer, Azure-style ones use api-key; Custom takes any header name and prefix.",
        "form.authHeader": "Header name",
        "form.authPrefix": "Prefix",
        "form.route.generate": "Text-to-image",
        "form.route.edit": "Image-to-image",
        "form.route.models": "List models",
        "form.routeUnsupported": "Not supported",
        "form.customProtocol": "Custom",
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
        "form.modelOptionsUnsupported": "Custom workflows are only available with the ComfyUI deployment",
        "form.modelWorkflow": "Custom workflow (ComfyUI API format)",
        "form.modelWorkflowPlaceholder": "In ComfyUI use Export (API), then paste the JSON here · Leave blank to use the builtin workflow picked from the model type.",
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
        "form.modeCustomHint": "Connect a third-party or local image API with configurable endpoints, authentication, parameters, and response formats.",
        "form.modeLocalHint": "Connect to an image service on this machine or your local network. Local services without auth can leave the API key blank.",
        "form.provider": "Provider",
        "form.providerWebsite": "Provider website",
        "form.localDeployer": "Local deployment",
        "form.localPresetsMissing": "The host did not provide the local deployment list. Refresh the page and try again.",
        "form.providerUnrecognized": "No provider preset recognized; generic protocol settings will be used. For a zero-config setup, choose one from “Model provider”.",
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
        "seat.chooseModel": "Switch model",
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
        "serverError.provider.invalidProbe": "That probe path is not part of this address's detection plan.",
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
        "form.modelMappingImage": "Reference image",
        "form.modelMappingColName": "Parameter",
        "form.modelMappingColTarget": "Mapping",
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
        "param.steps.desc": "Sampling steps; more steps add detail and cost time",
        "param.seed.desc": "Random seed; the same seed with the same settings reproduces the image",
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
        "form.paramName": "Parameter name",
        "form.paramType": "Type",
        "form.paramDefault": "Default",
        "form.paramDescription": "Description",
        "form.paramExpose": "Expose",
        "form.paramOptions": "Options",
        "form.paramNameHint": "Field name sent in the request body; the prompt row can only be renamed",
        "form.paramDescriptionHint": "Shown to the chat model",
        "form.paramExposeHint": "Only exposed rows can be tuned through params",
        "form.paramOptionLabel": "Option name",
        "form.paramOptionValue": "Value",
        "form.paramOptionDefault": "Default",
        "form.paramAddOption": "Add option",
        "form.paramRemoveOption": "Remove option",
        "form.paramActions": "Actions",
        "form.paramRowLockHint": "Locked rows are skipped by bulk configuration and auto-detection",
        "form.paramAdd": "Add parameter",
        "form.paramRemove": "Remove parameter",
        "form.paramConfirmRemove": "Confirm delete?",
        "form.paramDescPrompt": "Image prompt",
        "form.paramDescNegative": "What to avoid",
        "form.paramDescModel": "Model name sent in the request",
        "form.paramDescN": "Images per request",
        "form.paramNameHintWorkflow": "A workflow parameter name is only the key the chat model sees",
        "form.paramNameRequired": "Parameter name cannot be empty; without it the request carries no model name and this model cannot be sent",
        "form.paramWorkflowTableHint": "This is the model parameter table: rows from parsing the workflow and the inputs land here; only exposed rows can be tuned through params",
        "form.paramsEmptyWorkflow": "No parameters parsed yet. Paste a workflow, then click “Parse workflow”.",
        "form.paramsEmpty": "This model has no tunable parameters yet. Click “Add parameter” to add one.",
        "form.a1111ParamRowsHint": "Defaults are sent with the request; clear a default to fall back to the WebUI setting",
        "form.qualitySupported": "Supports quality",
        "form.qualityField": "Parameter name",
        "form.qualityOptionLabel": "Level name",
        "form.qualityOptionValue": "Value",
        "form.qualityOptionDefault": "Default",
        "form.qualityAddOption": "Add level",
        "form.qualityRemoveOption": "Remove level",
        "form.imageAs": "Encoding",
        "form.imageField": "Field name",
        "form.imageSupported": "Supports reference image",
        "form.imageMode": "Multiple images",
        "form.imageModeSingle": "Single",
        "form.imageModeArray": "Array",
        "form.imageModeNumbered": "Numbered",
        "form.imageModeHint": "Single uses one field; array puts every image in that field; numbered expands to name / name_2 / name_3 …",
        "form.autoDetect": "Auto-detect",
        "form.detecting": "Detecting…",
        "form.detectNeedsModels": "Add a model first",
        "form.bulkConfigure": "Configure all",
        "form.bulkConfiguring": "Configuring…",
        "form.bulkConfigDone": "Configured {count} model(s) — {unmatched} did not match a rule",
        "form.bulkConfigNone": "No model matched a rule — sending the OpenAI-compatible body",
        "form.bulkConfigSkipped": "Every key is locked — bulk configuration wrote nothing",
        "errors.detectRule": "Rule detection failed",
        "form.protocolMore": "More protocols…",
        "form.detectProtocol": "Detect protocol",
        "form.detectProtocolBusy": "Detecting…",
        "form.detectProtocolTrying": "Trying {path}…",
        "form.detectProtocolLastTried": "; last tried {path}",
        "form.detectProtocolMatched": "Detected {protocol}",
        "form.detectProtocolCompatible": "Endpoint works — set to {protocol}",
        "form.detectProtocolCustom": "Protocol not recognized — switched to Custom with prefilled URLs",
        "form.detectProtocolProbe": "Detected {protocol} ({probe} returned {shape})",
        "form.detectProtocolVerified": "URL matches the {protocol} preset",
        "form.detectProtocolVerifiedProbe": "Model list reachable ({probe} returned {shape})",
        "form.detectProtocolMismatch": "This address does not look like {protocol} — selection unchanged",
        "form.detectProtocolMismatchSuggested": "This address does not look like {protocol} — it looks like {suggested}. Selection unchanged.",
        "form.detectProtocolNoKey": "No usable API key (not filled in or could not be resolved) — {probe} cannot authenticate",
        "form.detectProtocolAuthFailed": "Authentication failed ({probe} returned {status}): the key is invalid, missing, or lacks permission",
        "form.detectProtocolNoEndpoint": "This address has no such endpoint ({probe} returned {status})",
        "form.detectProtocolUnreachable": "Cannot connect to {url}. Make sure the service is running, then try again.",
        "form.detectProtocolTimeout": "Timed out connecting to {url}. Check your network or proxy, then try again.",
        "form.detectProtocolHttpError": "Server returned {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; switched to Custom with URLs prefilled",
        "form.probeShape.openai-data": "a data list",
        "form.probeShape.gemini-models": "a models list",
        "form.probeShape.array": "an array",
        "form.probeShape.object": "a JSON object",
        "errors.detectProtocol": "Protocol detection failed",
        "protocolGroup.general": "General",
        "protocolGroup.gateway": "Gateways",
        "protocolGroup.native": "Vendor APIs",
        "protocolGroup.local": "Local",
        "protocolGroup.async": "Async",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "自動",
        "form.protocolRoutes": "プロトコルの接続先",
        "form.protocolSettings": "プロトコル設定",
        "form.protocolOption.edit": "画像から画像のエンドポイント",
        "form.protocolOption.edit.edits": "別の /images/edits",
        "form.protocolOption.edit.same": "同じ /images/generations",
        "form.protocolOption.edit.none": "画像編集なし",
        "form.protocolOption.editHint": "編集リクエストの送信先です。提供側が /images/generations しか持たない場合は「同じ」、画像編集が一切ない場合は「画像編集なし」を選びます。",
        "form.auth": "認証方式",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "カスタムヘッダー",
        "form.auth.none": "認証なし",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "クエリパラメータ",
        "form.authFollow": "プロトコルに従う",
        "form.authQueryName": "クエリパラメータ名",
        "form.authBasicCredential": "認証情報（username:password）",
        "form.operations": "リクエストとレスポンス形式",
        "form.modelOperations": "このモデルのリクエストとレスポンス形式",
        "form.operationsHint": "出力プリセットを選ぶか、generate、edit、models のメソッド、フィールド対応、レスポンスを JSON で指定します。",
        "form.modelOperationsHint": "generate または edit を JSON で上書きします。省略した項目はプロバイダーの設定を継承します。",
        "form.operationsInvalidJson": "有効な JSON オブジェクトを入力してください。",
        "form.operationOutput": "{operation}のレスポンス形式",
        "form.outputPreset.auto": "プロトコルに従う",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "バイナリ画像",
        "form.outputPreset.image-url": "画像 URL",
        "form.outputPreset.image-base64": "Base64 画像",
        "form.outputPreset.task-location": "非同期ジョブ（Location）",
        "form.outputPreset.task-json": "非同期ジョブ（JSON ID）",
        "form.outputPreset.customLegacy": "カスタム（旧設定から）",
        "form.outputPreset.customLegacyHint": "この値は以前手書きされた設定で、そのまま保持されます。上でプリセットを選ぶと上書きされます。",
        "form.saving": "保存中…",
        "serverError.provider.invalidAuth": "認証方式と入力欄を確認してください。",
        "serverError.provider.invalidOperations": "操作設定を確認してください。{message}",
        "form.authHint": "キーをどのヘッダーで送るか：多くのサービスは Authorization: Bearer、Azure 系は api-key。カスタムでは任意のヘッダー名と接頭辞を指定できます。",
        "form.authHeader": "ヘッダー名",
        "form.authPrefix": "接頭辞",
        "form.route.generate": "テキストから生成",
        "form.route.edit": "画像から生成",
        "form.route.models": "モデル一覧",
        "form.routeUnsupported": "非対応",
        "form.customProtocol": "カスタム",
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
        "form.modelOptionsUnsupported": "カスタムワークフローは ComfyUI デプロイ時のみ利用できます",
        "form.modelWorkflow": "カスタムワークフロー（ComfyUI API 形式）",
        "form.modelWorkflowPlaceholder": "ComfyUI で「エクスポート（API）」して JSON をここに貼り付け · 空欄ならモデル種別に応じた組み込みワークフローを使います。",
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
        "form.modeCustomHint": "外部またはローカルの画像生成 API に接続し、エンドポイント、認証、パラメーター、レスポンス形式を設定できます。",
        "form.modeLocalHint": "この PC または LAN 上の画像生成サービスに接続します。認証なしのローカルサービスなら API キーは空欄で構いません。",
        "form.provider": "プロバイダー",
        "form.providerWebsite": "プロバイダーのサイト",
        "form.localDeployer": "ローカルデプロイ",
        "form.localPresetsMissing": "ホストからローカルデプロイの一覧が届いていません。ページを再読み込みしてください。",
        "form.providerUnrecognized": "プロバイダーのプリセットを認識できませんでした。汎用のプロトコル設定を使用します。ゼロ設定で使いたい場合は「モデルプロバイダー」から選択してください。",
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
        "seat.chooseModel": "モデルを切り替え",
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
        "serverError.provider.invalidProbe": "このアドレスの検出計画にないプローブパスです。",
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
        "form.modelMappingImage": "参照画像",
        "form.modelMappingColName": "パラメータ",
        "form.modelMappingColTarget": "マッピング",
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
        "param.steps.desc": "サンプリング回数。増やすと細部が増え、時間もかかります",
        "param.seed.desc": "乱数シード。同じシードと同じ設定なら同じ画像になります",
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
        "form.paramName": "パラメータ名",
        "form.paramType": "型",
        "form.paramDefault": "既定値",
        "form.paramDescription": "説明",
        "form.paramExpose": "公開",
        "form.paramOptions": "選択肢",
        "form.paramNameHint": "リクエスト本文に送る項目名。プロンプト行は名前だけ変更できます",
        "form.paramDescriptionHint": "対話モデルに表示される説明",
        "form.paramExposeHint": "オンにすると対話モデルが params でこの値を変更できます",
        "form.paramOptionLabel": "選択肢名",
        "form.paramOptionValue": "値",
        "form.paramOptionDefault": "既定",
        "form.paramAddOption": "選択肢を追加",
        "form.paramRemoveOption": "この選択肢を削除",
        "form.paramActions": "操作",
        "form.paramRowLockHint": "ロックすると一括設定や自動検出で変更されません",
        "form.paramAdd": "パラメータを追加",
        "form.paramRemove": "パラメータを削除",
        "form.paramConfirmRemove": "削除しますか？",
        "form.paramDescPrompt": "画像生成プロンプト",
        "form.paramDescNegative": "避けたい内容",
        "form.paramDescModel": "リクエストで送るモデル名",
        "form.paramDescN": "1回に生成する枚数",
        "form.paramNameHintWorkflow": "ワークフローパラメータの名前は対話モデルが見るキーです",
        "form.paramNameRequired": "パラメータ名は必須です。空欄だとリクエストにモデル名が入らず、このモデルは送信できません",
        "form.paramWorkflowTableHint": "このモデルのパラメータ表です。ワークフロー解析とパラメータ解析の行はここに入り、「公開」した行だけ params で調整できます",
        "form.paramsEmptyWorkflow": "まだパラメータを解析していません。先にワークフローを貼り付け、「ワークフローを解析」をクリックしてください。",
        "form.paramsEmpty": "このモデルにはまだ調整できるパラメータがありません。「パラメータを追加」から追加してください。",
        "form.a1111ParamRowsHint": "既定値はリクエストと一緒に送信されます。空にすると WebUI の設定に従います",
        "form.qualitySupported": "品質パラメータ対応",
        "form.qualityField": "パラメータ名",
        "form.qualityOptionLabel": "段階名",
        "form.qualityOptionValue": "値",
        "form.qualityOptionDefault": "既定",
        "form.qualityAddOption": "段階を追加",
        "form.qualityRemoveOption": "この段階を削除",
        "form.imageAs": "送信形式",
        "form.imageField": "フィールド名",
        "form.imageSupported": "参照画像対応",
        "form.imageMode": "複数画像の扱い",
        "form.imageModeSingle": "単枚",
        "form.imageModeArray": "配列",
        "form.imageModeNumbered": "連番",
        "form.imageModeHint": "単枚は同じ項目に 1 つ、配列はすべての画像をその項目に入れ、連番は name / name_2 / name_3 … に展開します",
        "form.autoDetect": "自動検出",
        "form.detecting": "検出中…",
        "form.detectNeedsModels": "先にモデルを追加してください",
        "form.bulkConfigure": "一括設定",
        "form.bulkConfiguring": "設定中…",
        "form.bulkConfigDone": "モデル {count} 件を設定しました — {unmatched} 件はルールに一致しません",
        "form.bulkConfigNone": "ルールに一致したモデルがないため OpenAI 互換で送信します",
        "form.bulkConfigSkipped": "すべての項目がロックされているため一括設定は何も書きませんでした",
        "errors.detectRule": "ルール検出に失敗しました",
        "form.protocolMore": "その他のプロトコル…",
        "form.detectProtocol": "プロトコル識別",
        "form.detectProtocolBusy": "識別中…",
        "form.detectProtocolTrying": "{path} を試しています…",
        "form.detectProtocolLastTried": "（最後に試したのは {path}）",
        "form.detectProtocolMatched": "{protocol} として識別しました",
        "form.detectProtocolCompatible": "接続を確認し、{protocol} に設定しました",
        "form.detectProtocolCustom": "プロトコルを識別できません。「カスタム」に切り替えて URL を埋めました",
        "form.detectProtocolProbe": "{protocol} として識別しました（{probe} が {shape} を返しました）",
        "form.detectProtocolVerified": "URL が {protocol} のプリセットに一致しました",
        "form.detectProtocolVerifiedProbe": "モデル一覧に接続できました（{probe} が {shape} を返しました）",
        "form.detectProtocolMismatch": "このアドレスは {protocol} ではないようです（選択は変更していません）",
        "form.detectProtocolMismatchSuggested": "このアドレスは {protocol} ではなく {suggested} のようです（選択は変更していません）",
        "form.detectProtocolNoKey": "使用できる API キーがありません（未入力または認証情報を解決できません）。{probe} は認証できません",
        "form.detectProtocolAuthFailed": "認証に失敗しました（{probe} が {status} を返しました）：キーが無効・未入力、または権限がありません",
        "form.detectProtocolNoEndpoint": "このアドレスにそのエンドポイントはありません（{probe} が {status} を返しました）",
        "form.detectProtocolUnreachable": "{url} に接続できません。サービスが起動しているか確認してから再試行してください。",
        "form.detectProtocolTimeout": "{url} への接続がタイムアウトしました。ネットワークまたはプロキシを確認してから再試行してください。",
        "form.detectProtocolHttpError": "サーバーが {status} を返しました（{probe}）",
        "form.detectProtocolIssueSuffix": "；{issue}",
        "form.detectProtocolSwitchedToCustom": "；カスタムに切り替えて URL を埋めました",
        "form.probeShape.openai-data": "data リスト",
        "form.probeShape.gemini-models": "models リスト",
        "form.probeShape.array": "配列",
        "form.probeShape.object": "JSON オブジェクト",
        "errors.detectProtocol": "プロトコル識別に失敗しました",
        "protocolGroup.general": "汎用",
        "protocolGroup.gateway": "互換ゲートウェイ",
        "protocolGroup.native": "各社ネイティブ",
        "protocolGroup.local": "ローカル",
        "protocolGroup.async": "非同期",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "Auto",
        "form.protocolRoutes": "Direcciones del protocolo",
        "form.protocolSettings": "Ajustes del protocolo",
        "form.protocolOption.edit": "Endpoint de imagen a imagen",
        "form.protocolOption.edit.edits": "/images/edits aparte",
        "form.protocolOption.edit.same": "El mismo /images/generations",
        "form.protocolOption.edit.none": "Sin edición de imágenes",
        "form.protocolOption.editHint": "A dónde van las peticiones de edición: elige El mismo si el proveedor solo expone /images/generations o Sin edición de imágenes si no admite edición.",
        "form.auth": "Autenticación",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "Cabecera personalizada",
        "form.auth.none": "Sin autenticación",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Parámetro de consulta",
        "form.authFollow": "Seguir el protocolo",
        "form.authQueryName": "Nombre del parámetro",
        "form.authBasicCredential": "Credenciales (username:password)",
        "form.operations": "Formatos de solicitud y respuesta",
        "form.modelOperations": "Formatos para este modelo",
        "form.operationsHint": "Elige un ajuste de salida o configura en JSON el método, los campos y la respuesta de generate, edit y models.",
        "form.modelOperationsHint": "Sobrescribe generate o edit en JSON. Las opciones omitidas se heredan del proveedor.",
        "form.operationsInvalidJson": "Introduce un objeto JSON válido.",
        "form.operationOutput": "Formato de respuesta de {operation}",
        "form.outputPreset.auto": "Seguir el protocolo",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Imagen binaria",
        "form.outputPreset.image-url": "URL de imagen",
        "form.outputPreset.image-base64": "Imagen Base64",
        "form.outputPreset.task-location": "Tarea asíncrona (Location)",
        "form.outputPreset.task-json": "Tarea asíncrona (ID JSON)",
        "form.outputPreset.customLegacy": "Personalizado (de configuración antigua)",
        "form.outputPreset.customLegacyHint": "Este valor se escribió a mano anteriormente y se conserva tal cual. Elige un ajuste arriba para sobrescribirlo.",
        "form.saving": "Guardando…",
        "serverError.provider.invalidAuth": "Revisa el método de autenticación y sus campos.",
        "serverError.provider.invalidOperations": "Revisa la configuración de la operación. {message}",
        "form.authHint": "Qué cabecera lleva la clave: la mayoría de los servicios usan Authorization: Bearer, los de estilo Azure usan api-key; Personalizado acepta cualquier nombre de cabecera y prefijo.",
        "form.authHeader": "Nombre de la cabecera",
        "form.authPrefix": "Prefijo",
        "form.route.generate": "Texto a imagen",
        "form.route.edit": "Imagen a imagen",
        "form.route.models": "Listar modelos",
        "form.routeUnsupported": "No compatible",
        "form.customProtocol": "Personalizado",
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
        "form.modelOptionsUnsupported": "Los flujos personalizados solo están disponibles con el despliegue ComfyUI",
        "form.modelWorkflow": "Flujo de trabajo personalizado (formato API de ComfyUI)",
        "form.modelWorkflowPlaceholder": "En ComfyUI usa Exportar (API) y pega el JSON aquí · Déjalo vacío para usar el flujo integrado según el tipo de modelo.",
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
        "form.modeCustomHint": "Conecta una API de imágenes externa o local y configura sus endpoints, autenticación, parámetros y formatos de respuesta.",
        "form.modeLocalHint": "Conecta un servicio de imágenes en este equipo o en tu red local. Los servicios locales sin autenticación pueden dejar la clave de API vacía.",
        "form.provider": "Proveedor",
        "form.providerWebsite": "Web del proveedor",
        "form.localDeployer": "Despliegue local",
        "form.localPresetsMissing": "El host no envió la lista de despliegues locales. Recarga la página e inténtalo de nuevo.",
        "form.providerUnrecognized": "No se reconoció ningún preset de proveedor; se usará la configuración genérica del protocolo. Para una experiencia sin configuración, elige en «Proveedor de modelos».",
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
        "seat.chooseModel": "Cambiar modelo",
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
        "serverError.provider.invalidProbe": "Esa ruta de sondeo no forma parte del plan de detección de esta dirección.",
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
        "form.modelMappingImage": "Imagen de referencia",
        "form.modelMappingColName": "Parámetro",
        "form.modelMappingColTarget": "Mapeo",
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
        "param.steps.desc": "Pasos de muestreo; más pasos añaden detalle y tiempo",
        "param.seed.desc": "Semilla aleatoria; la misma semilla y ajustes producen la misma imagen",
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
        "form.paramName": "Nombre del parámetro",
        "form.paramType": "Tipo",
        "form.paramDefault": "Valor predeterminado",
        "form.paramDescription": "Descripción",
        "form.paramExpose": "Exponer",
        "form.paramOptions": "Opciones",
        "form.paramNameHint": "Nombre del campo que se envía en el cuerpo; la fila del prompt solo se puede renombrar",
        "form.paramDescriptionHint": "Se muestra al modelo de chat",
        "form.paramExposeHint": "Solo las filas expuestas se pueden ajustar con params",
        "form.paramOptionLabel": "Nombre de la opción",
        "form.paramOptionValue": "Valor",
        "form.paramOptionDefault": "Predeterminado",
        "form.paramAddOption": "Añadir opción",
        "form.paramRemoveOption": "Eliminar esta opción",
        "form.paramActions": "Acciones",
        "form.paramRowLockHint": "Al bloquearla, la configuración masiva y la detección automática no la cambiarán",
        "form.paramAdd": "Añadir parámetro",
        "form.paramRemove": "Eliminar parámetro",
        "form.paramConfirmRemove": "¿Eliminar?",
        "form.paramDescPrompt": "Prompt de imagen",
        "form.paramDescNegative": "Lo que se debe evitar",
        "form.paramDescModel": "Nombre del modelo enviado en la petición",
        "form.paramDescN": "Imágenes por petición",
        "form.paramNameHintWorkflow": "El nombre de un parámetro de flujo es solo la clave que ve el modelo",
        "form.paramNameRequired": "El nombre del parámetro no puede estar vacío; sin él la petición no lleva nombre de modelo y este modelo no se puede enviar",
        "form.paramWorkflowTableHint": "Esta es la tabla de parámetros del modelo: aquí llegan las filas del flujo y de los parámetros analizados; solo las expuestas se ajustan con params",
        "form.paramsEmptyWorkflow": "Aún no hay parámetros analizados. Pega un flujo de trabajo y luego pulsa «Analizar flujo de trabajo».",
        "form.paramsEmpty": "Este modelo aún no tiene parámetros ajustables. Pulsa «Añadir parámetro» para crear uno.",
        "form.a1111ParamRowsHint": "Los valores por defecto se envían con la petición; vacía uno para usar la configuración del WebUI",
        "form.qualitySupported": "Admite calidad",
        "form.qualityField": "Nombre del parámetro",
        "form.qualityOptionLabel": "Nombre del nivel",
        "form.qualityOptionValue": "Valor",
        "form.qualityOptionDefault": "Predeterminado",
        "form.qualityAddOption": "Añadir nivel",
        "form.qualityRemoveOption": "Eliminar este nivel",
        "form.imageAs": "Codificación",
        "form.imageField": "Nombre del campo",
        "form.imageSupported": "Admite imagen de referencia",
        "form.imageMode": "Varias imágenes",
        "form.imageModeSingle": "Una sola",
        "form.imageModeArray": "Matriz",
        "form.imageModeNumbered": "Numeradas",
        "form.imageModeHint": "Una sola usa un campo; matriz mete todas las imágenes en ese campo; numeradas expande a name / name_2 / name_3 …",
        "form.autoDetect": "Detección automática",
        "form.detecting": "Detectando…",
        "form.detectNeedsModels": "Añade primero un modelo",
        "form.bulkConfigure": "Configurar todo",
        "form.bulkConfiguring": "Configurando…",
        "form.bulkConfigDone": "Se configuraron {count} modelos — {unmatched} sin regla correspondiente",
        "form.bulkConfigNone": "Ningún modelo coincidió con una regla — se envía en modo compatible con OpenAI",
        "form.bulkConfigSkipped": "Todas las claves están bloqueadas — la configuración no escribió nada",
        "errors.detectRule": "Falló la detección de reglas",
        "form.protocolMore": "Más protocolos…",
        "form.detectProtocol": "Detectar protocolo",
        "form.detectProtocolBusy": "Detectando…",
        "form.detectProtocolTrying": "Probando {path}…",
        "form.detectProtocolLastTried": "; último intento: {path}",
        "form.detectProtocolMatched": "Detectado: {protocol}",
        "form.detectProtocolCompatible": "El endpoint responde: {protocol}",
        "form.detectProtocolCustom": "No se reconoce el protocolo: cambiado a Personalizado con las URL rellenadas",
        "form.detectProtocolProbe": "Detectado: {protocol} ({probe} devolvió {shape})",
        "form.detectProtocolVerified": "La URL coincide con el ajuste {protocol}",
        "form.detectProtocolVerifiedProbe": "Lista de modelos accesible ({probe} devolvió {shape})",
        "form.detectProtocolMismatch": "La dirección no parece {protocol}: la selección no se ha cambiado",
        "form.detectProtocolMismatchSuggested": "La dirección no parece {protocol}, sino {suggested}. La selección no se ha cambiado.",
        "form.detectProtocolNoKey": "No hay ninguna clave de API utilizable (sin rellenar o no se pudo resolver): {probe} no puede autenticarse",
        "form.detectProtocolAuthFailed": "Falló la autenticación ({probe} devolvió {status}): la clave no es válida, falta o no tiene permiso",
        "form.detectProtocolNoEndpoint": "Esta dirección no tiene ese endpoint ({probe} devolvió {status})",
        "form.detectProtocolUnreachable": "No se puede conectar con {url}. Comprueba que el servicio esté iniciado y vuelve a intentarlo.",
        "form.detectProtocolTimeout": "Se agotó el tiempo de espera al conectar con {url}. Comprueba la red o el proxy y vuelve a intentarlo.",
        "form.detectProtocolHttpError": "El servidor devolvió {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; cambiado a Personalizado con las URL rellenadas",
        "form.probeShape.openai-data": "una lista data",
        "form.probeShape.gemini-models": "una lista models",
        "form.probeShape.array": "una matriz",
        "form.probeShape.object": "un objeto JSON",
        "errors.detectProtocol": "Falló la detección del protocolo",
        "protocolGroup.general": "Generales",
        "protocolGroup.gateway": "Pasarelas",
        "protocolGroup.native": "APIs nativas",
        "protocolGroup.local": "Local",
        "protocolGroup.async": "Asíncrono",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "Auto",
        "form.protocolRoutes": "Adresses du protocole",
        "form.protocolSettings": "Paramètres du protocole",
        "form.protocolOption.edit": "Point d’accès image-vers-image",
        "form.protocolOption.edit.edits": "/images/edits distinct",
        "form.protocolOption.edit.same": "Même /images/generations",
        "form.protocolOption.edit.none": "Pas d'édition d'image",
        "form.protocolOption.editHint": "Où partent les requêtes d'édition : choisissez Même si le fournisseur n'expose que /images/generations, ou Pas d'édition d'image s'il n'en propose aucune.",
        "form.auth": "Authentification",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "En-tête personnalisé",
        "form.auth.none": "Sans authentification",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Paramètre de requête",
        "form.authFollow": "Suivre le protocole",
        "form.authQueryName": "Nom du paramètre",
        "form.authBasicCredential": "Identifiants (username:password)",
        "form.operations": "Formats de requête et de réponse",
        "form.modelOperations": "Formats pour ce modèle",
        "form.operationsHint": "Choisissez un format de sortie ou définissez en JSON les méthodes, champs et réponses de generate, edit et models.",
        "form.modelOperationsHint": "Remplacez generate ou edit en JSON. Les options omises héritent des réglages du fournisseur.",
        "form.operationsInvalidJson": "Saisissez un objet JSON valide.",
        "form.operationOutput": "Format de réponse pour {operation}",
        "form.outputPreset.auto": "Suivre le protocole",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Image binaire",
        "form.outputPreset.image-url": "URL de l’image",
        "form.outputPreset.image-base64": "Image Base64",
        "form.outputPreset.task-location": "Tâche asynchrone (Location)",
        "form.outputPreset.task-json": "Tâche asynchrone (ID JSON)",
        "form.outputPreset.customLegacy": "Personnalisé (configuration héritée)",
        "form.outputPreset.customLegacyHint": "Cette valeur a été saisie à la main auparavant et reste inchangée. Choisissez un préréglage ci-dessus pour la remplacer.",
        "form.saving": "Enregistrement…",
        "serverError.provider.invalidAuth": "Vérifiez le mode d’authentification et ses champs.",
        "serverError.provider.invalidOperations": "Vérifiez la configuration des opérations. {message}",
        "form.authHint": "Quel en-tête porte la clé : la plupart des services utilisent Authorization: Bearer, ceux de type Azure utilisent api-key ; Personnalisé accepte n'importe quel nom d'en-tête et préfixe.",
        "form.authHeader": "Nom de l'en-tête",
        "form.authPrefix": "Préfixe",
        "form.route.generate": "Texte vers image",
        "form.route.edit": "Image vers image",
        "form.route.models": "Lister les modèles",
        "form.routeUnsupported": "Non pris en charge",
        "form.customProtocol": "Personnalisé",
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
        "form.modelOptionsUnsupported": "Les workflows personnalisés ne sont disponibles qu’avec le déploiement ComfyUI",
        "form.modelWorkflow": "Workflow personnalisé (format API ComfyUI)",
        "form.modelWorkflowPlaceholder": "Dans ComfyUI, utilisez Exporter (API) puis collez le JSON ici · Laissez vide pour utiliser le workflow intégré choisi selon le type de modèle.",
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
        "form.modeCustomHint": "Connectez une API d’images tierce ou locale et configurez ses points de terminaison, son authentification, ses paramètres et ses formats de réponse.",
        "form.modeLocalHint": "Connectez un service d'images sur cet ordinateur ou votre réseau local. Un service local sans authentification peut laisser la clé d'API vide.",
        "form.provider": "Fournisseur",
        "form.providerWebsite": "Site du fournisseur",
        "form.localDeployer": "Déploiement local",
        "form.localPresetsMissing": "L'hôte n'a pas fourni la liste des déploiements locaux. Rechargez la page et réessayez.",
        "form.providerUnrecognized": "Aucun préréglage de fournisseur reconnu ; la configuration générique du protocole sera utilisée. Pour une configuration sans effort, choisissez dans « Fournisseur de modèles ».",
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
        "seat.chooseModel": "Changer de modèle",
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
        "serverError.provider.invalidProbe": "Ce chemin de sonde ne fait pas partie du plan de détection de cette adresse.",
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
        "form.modelMappingImage": "Image de référence",
        "form.modelMappingColName": "Paramètre",
        "form.modelMappingColTarget": "Correspondance",
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
        "param.steps.desc": "Étapes d’échantillonnage ; plus d’étapes = plus de détail et de temps",
        "param.seed.desc": "Graine aléatoire ; même graine et mêmes réglages reproduisent l’image",
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
        "form.paramName": "Nom du paramètre",
        "form.paramType": "Type",
        "form.paramDefault": "Valeur par défaut",
        "form.paramDescription": "Description",
        "form.paramExpose": "Exposer",
        "form.paramOptions": "Options",
        "form.paramNameHint": "Nom du champ envoyé dans le corps ; la ligne du prompt peut seulement être renommée",
        "form.paramDescriptionHint": "Affiché au modèle de conversation",
        "form.paramExposeHint": "Seules les lignes exposées sont réglables via params",
        "form.paramOptionLabel": "Nom de l'option",
        "form.paramOptionValue": "Valeur",
        "form.paramOptionDefault": "Par défaut",
        "form.paramAddOption": "Ajouter une option",
        "form.paramRemoveOption": "Supprimer cette option",
        "form.paramActions": "Actions",
        "form.paramRowLockHint": "Verrouillée, la ligne est ignorée par la configuration groupée et la détection automatique",
        "form.paramAdd": "Ajouter un paramètre",
        "form.paramRemove": "Supprimer le paramètre",
        "form.paramConfirmRemove": "Supprimer ?",
        "form.paramDescPrompt": "Prompt d'image",
        "form.paramDescNegative": "Ce qu'il faut éviter",
        "form.paramDescModel": "Nom du modèle envoyé dans la requête",
        "form.paramDescN": "Images par requête",
        "form.paramNameHintWorkflow": "Le nom d'un paramètre de workflow n'est que la clé vue par le modèle",
        "form.paramNameRequired": "Le nom du paramètre ne peut pas être vide ; sans lui la requête ne porte pas de nom de modèle et ce modèle ne peut pas être envoyé",
        "form.paramWorkflowTableHint": "Voici la table des paramètres du modèle : les lignes issues de l'analyse du workflow et des entrées arrivent ici ; seules les lignes exposées se règlent via params",
        "form.paramsEmptyWorkflow": "Aucun paramètre analysé pour l’instant. Collez un workflow, puis cliquez sur « Analyser le workflow ».",
        "form.paramsEmpty": "Ce modèle n’a pas encore de paramètres réglables. Cliquez sur « Ajouter un paramètre » pour en créer un.",
        "form.a1111ParamRowsHint": "Les valeurs par défaut sont envoyées avec la requête ; videz-en une pour suivre le réglage du WebUI",
        "form.qualitySupported": "Gère la qualité",
        "form.qualityField": "Nom du paramètre",
        "form.qualityOptionLabel": "Nom du palier",
        "form.qualityOptionValue": "Valeur",
        "form.qualityOptionDefault": "Par défaut",
        "form.qualityAddOption": "Ajouter un palier",
        "form.qualityRemoveOption": "Supprimer ce palier",
        "form.imageAs": "Encodage",
        "form.imageField": "Nom du champ",
        "form.imageSupported": "Gère l'image de référence",
        "form.imageMode": "Images multiples",
        "form.imageModeSingle": "Une seule",
        "form.imageModeArray": "Tableau",
        "form.imageModeNumbered": "Numéroté",
        "form.imageModeHint": "Une seule utilise un champ ; tableau y met toutes les images ; numéroté développe en name / name_2 / name_3 …",
        "form.autoDetect": "Détection automatique",
        "form.detecting": "Détection…",
        "form.detectNeedsModels": "Ajoutez d'abord un modèle",
        "form.bulkConfigure": "Tout configurer",
        "form.bulkConfiguring": "Configuration…",
        "form.bulkConfigDone": "{count} modèles configurés — {unmatched} sans règle correspondante",
        "form.bulkConfigNone": "Aucun modèle ne correspond à une règle — envoi compatible OpenAI",
        "form.bulkConfigSkipped": "Toutes les clés sont verrouillées — la configuration n'a rien écrit",
        "errors.detectRule": "Échec de la détection des règles",
        "form.protocolMore": "Plus de protocoles…",
        "form.detectProtocol": "Détecter le protocole",
        "form.detectProtocolBusy": "Détection…",
        "form.detectProtocolTrying": "Essai de {path}…",
        "form.detectProtocolLastTried": "; dernière tentative : {path}",
        "form.detectProtocolMatched": "Détecté : {protocol}",
        "form.detectProtocolCompatible": "Point d'accès OK : {protocol}",
        "form.detectProtocolCustom": "Protocole non reconnu : passé en Personnalisé avec les URL préremplies",
        "form.detectProtocolProbe": "Détecté : {protocol} ({probe} a renvoyé {shape})",
        "form.detectProtocolVerified": "L’URL correspond au préréglage {protocol}",
        "form.detectProtocolVerifiedProbe": "Liste de modèles accessible ({probe} a renvoyé {shape})",
        "form.detectProtocolMismatch": "Cette adresse ne ressemble pas à {protocol} — sélection inchangée",
        "form.detectProtocolMismatchSuggested": "Cette adresse ne ressemble pas à {protocol} mais à {suggested}. Sélection inchangée.",
        "form.detectProtocolNoKey": "Aucune clé d'API utilisable (non renseignée ou impossible à résoudre) : {probe} ne peut pas s'authentifier",
        "form.detectProtocolAuthFailed": "Échec de l'authentification ({probe} a renvoyé {status}) : la clé est invalide, absente ou sans permission",
        "form.detectProtocolNoEndpoint": "Cette adresse n'a pas cet endpoint ({probe} a renvoyé {status})",
        "form.detectProtocolUnreachable": "Impossible de se connecter à {url}. Vérifiez que le service est démarré, puis réessayez.",
        "form.detectProtocolTimeout": "Délai d'attente dépassé en se connectant à {url}. Vérifiez le réseau ou le proxy, puis réessayez.",
        "form.detectProtocolHttpError": "Le serveur a renvoyé {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; passé en Personnalisé avec les URL préremplies",
        "form.probeShape.openai-data": "une liste data",
        "form.probeShape.gemini-models": "une liste models",
        "form.probeShape.array": "un tableau",
        "form.probeShape.object": "un objet JSON",
        "errors.detectProtocol": "Échec de la détection du protocole",
        "protocolGroup.general": "Généraux",
        "protocolGroup.gateway": "Passerelles",
        "protocolGroup.native": "API natives",
        "protocolGroup.local": "Local",
        "protocolGroup.async": "Asynchrone",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "Auto",
        "form.protocolRoutes": "Protokoll-Endpunkte",
        "form.protocolSettings": "Protokoll-Einstellungen",
        "form.protocolOption.edit": "Bild-zu-Bild-Endpunkt",
        "form.protocolOption.edit.edits": "Eigenes /images/edits",
        "form.protocolOption.edit.same": "Gleiches /images/generations",
        "form.protocolOption.edit.none": "Keine Bildbearbeitung",
        "form.protocolOption.editHint": "Wohin Bearbeitungsanfragen gehen: Wählen Sie Gleiches, wenn der Anbieter nur /images/generations anbietet, oder Keine Bildbearbeitung, wenn er keine unterstützt.",
        "form.auth": "Authentifizierung",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "Benutzerdefinierter Header",
        "form.auth.none": "Keine Authentifizierung",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Abfrageparameter",
        "form.authFollow": "Protokoll folgen",
        "form.authQueryName": "Parametername",
        "form.authBasicCredential": "Zugangsdaten (username:password)",
        "form.operations": "Anfrage- und Antwortformate",
        "form.modelOperations": "Formate für dieses Modell",
        "form.operationsHint": "Wählen Sie eine Ausgabevorlage oder legen Sie Methoden, Felder und Antworten für generate, edit und models in JSON fest.",
        "form.modelOperationsHint": "Überschreiben Sie generate oder edit in JSON. Fehlende Optionen werden vom Anbieter übernommen.",
        "form.operationsInvalidJson": "Geben Sie ein gültiges JSON-Objekt ein.",
        "form.operationOutput": "Antwortformat für {operation}",
        "form.outputPreset.auto": "Protokoll folgen",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Binärbild",
        "form.outputPreset.image-url": "Bild-URL",
        "form.outputPreset.image-base64": "Base64-Bild",
        "form.outputPreset.task-location": "Asynchroner Auftrag (Location)",
        "form.outputPreset.task-json": "Asynchroner Auftrag (JSON-ID)",
        "form.outputPreset.customLegacy": "Benutzerdefiniert (aus alter Konfiguration)",
        "form.outputPreset.customLegacyHint": "Dieser Wert wurde früher von Hand geschrieben und bleibt unverändert. Wählen Sie oben eine Vorlage, um ihn zu überschreiben.",
        "form.saving": "Wird gespeichert…",
        "serverError.provider.invalidAuth": "Prüfen Sie die Authentifizierungsmethode und ihre Felder.",
        "serverError.provider.invalidOperations": "Prüfen Sie die Konfiguration der Vorgänge. {message}",
        "form.authHint": "Welcher Header den Schlüssel trägt: Die meisten Dienste nutzen Authorization: Bearer, Azure-ähnliche api-key; Benutzerdefiniert akzeptiert jeden Header-Namen und jedes Präfix.",
        "form.authHeader": "Header-Name",
        "form.authPrefix": "Präfix",
        "form.route.generate": "Text zu Bild",
        "form.route.edit": "Bild zu Bild",
        "form.route.models": "Modelle laden",
        "form.routeUnsupported": "Nicht unterstützt",
        "form.customProtocol": "Benutzerdefiniert",
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
        "form.modelOptionsUnsupported": "Eigene Workflows gibt es nur bei der ComfyUI-Bereitstellung",
        "form.modelWorkflow": "Eigener Workflow (ComfyUI-API-Format)",
        "form.modelWorkflowPlaceholder": "In ComfyUI „Exportieren (API)“ nutzen und das JSON hier einfügen · Leer lassen, um den eingebauten Workflow passend zum Modelltyp zu nutzen.",
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
        "form.modeCustomHint": "Verbinden Sie eine externe oder lokale Bild-API und konfigurieren Sie Endpunkte, Authentifizierung, Parameter und Antwortformate.",
        "form.modeLocalHint": "Verbinden Sie einen Bilddienst auf diesem Rechner oder im lokalen Netzwerk. Lokale Dienste ohne Authentifizierung können den API-Schlüssel leer lassen.",
        "form.provider": "Anbieter",
        "form.providerWebsite": "Anbieterseite",
        "form.localDeployer": "Lokale Bereitstellung",
        "form.localPresetsMissing": "Der Host hat die Liste lokaler Bereitstellungen nicht bereitgestellt. Laden Sie die Seite neu und versuchen Sie es erneut.",
        "form.providerUnrecognized": "Keine Anbieter-Voreinstellung erkannt; es wird die allgemeine Protokollkonfiguration verwendet. Für eine Konfiguration ohne Einrichtung wählen Sie unter „Modellanbieter“.",
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
        "seat.chooseModel": "Modell wechseln",
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
        "serverError.provider.invalidProbe": "Dieser Prüfpfad gehört nicht zum Erkennungsplan dieser Adresse.",
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
        "form.modelMappingImage": "Referenzbild",
        "form.modelMappingColName": "Parameter",
        "form.modelMappingColTarget": "Zuordnung",
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
        "param.steps.desc": "Sampling-Schritte; mehr Schritte = mehr Detail und längere Laufzeit",
        "param.seed.desc": "Zufalls-Seed; gleicher Seed und gleiche Einstellungen ergeben dasselbe Bild",
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
        "form.paramName": "Parametername",
        "form.paramType": "Typ",
        "form.paramDefault": "Standardwert",
        "form.paramDescription": "Beschreibung",
        "form.paramExpose": "Bereitstellen",
        "form.paramOptions": "Optionen",
        "form.paramNameHint": "Feldname im Anfrage-Body; die Prompt-Zeile lässt sich nur umbenennen",
        "form.paramDescriptionHint": "Wird dem Chat-Modell angezeigt",
        "form.paramExposeHint": "Nur freigegebene Zeilen lassen sich über params ändern",
        "form.paramOptionLabel": "Optionsname",
        "form.paramOptionValue": "Wert",
        "form.paramOptionDefault": "Standard",
        "form.paramAddOption": "Option hinzufügen",
        "form.paramRemoveOption": "Diese Option entfernen",
        "form.paramActions": "Aktionen",
        "form.paramRowLockHint": "Gesperrte Zeilen werden von Sammelkonfiguration und automatischer Erkennung übersprungen",
        "form.paramAdd": "Parameter hinzufügen",
        "form.paramRemove": "Parameter entfernen",
        "form.paramConfirmRemove": "Löschen?",
        "form.paramDescPrompt": "Bild-Prompt",
        "form.paramDescNegative": "Was vermieden werden soll",
        "form.paramDescModel": "Im Request gesendeter Modellname",
        "form.paramDescN": "Bilder pro Anfrage",
        "form.paramNameHintWorkflow": "Der Name eines Workflow-Parameters ist nur der Schlüssel für das Chat-Modell",
        "form.paramNameRequired": "Der Parametername darf nicht leer sein; ohne ihn enthält die Anfrage keinen Modellnamen und dieses Modell kann nicht gesendet werden",
        "form.paramWorkflowTableHint": "Das ist die Parametertabelle des Modells: Zeilen aus Workflow- und Parameteranalyse landen hier; nur freigegebene Zeilen lassen sich über params steuern",
        "form.paramsEmptyWorkflow": "Noch keine Parameter analysiert. Fügen Sie zuerst einen Workflow ein und klicken Sie dann auf „Workflow analysieren“.",
        "form.paramsEmpty": "Dieses Modell hat noch keine einstellbaren Parameter. Klicken Sie auf „Parameter hinzufügen“, um einen anzulegen.",
        "form.a1111ParamRowsHint": "Standardwerte werden mitgesendet; ein geleerter Wert folgt der WebUI-Einstellung",
        "form.qualitySupported": "Unterstützt Qualität",
        "form.qualityField": "Parametername",
        "form.qualityOptionLabel": "Stufenname",
        "form.qualityOptionValue": "Wert",
        "form.qualityOptionDefault": "Standard",
        "form.qualityAddOption": "Stufe hinzufügen",
        "form.qualityRemoveOption": "Diese Stufe entfernen",
        "form.imageAs": "Kodierung",
        "form.imageField": "Feldname",
        "form.imageSupported": "Unterstützt Referenzbild",
        "form.imageMode": "Mehrere Bilder",
        "form.imageModeSingle": "Einzeln",
        "form.imageModeArray": "Array",
        "form.imageModeNumbered": "Nummeriert",
        "form.imageModeHint": "Einzeln nutzt ein Feld; Array legt alle Bilder hinein; nummeriert expandiert zu name / name_2 / name_3 …",
        "form.autoDetect": "Automatisch erkennen",
        "form.detecting": "Wird erkannt…",
        "form.detectNeedsModels": "Zuerst ein Modell hinzufügen",
        "form.bulkConfigure": "Alle konfigurieren",
        "form.bulkConfiguring": "Wird konfiguriert…",
        "form.bulkConfigDone": "{count} Modelle konfiguriert — {unmatched} ohne passende Regel",
        "form.bulkConfigNone": "Kein Modell passt zu einer Regel — Versand OpenAI-kompatibel",
        "form.bulkConfigSkipped": "Alle Schlüssel sind gesperrt — die Konfiguration hat nichts geschrieben",
        "errors.detectRule": "Regelerkennung fehlgeschlagen",
        "form.protocolMore": "Weitere Protokolle…",
        "form.detectProtocol": "Protokoll erkennen",
        "form.detectProtocolBusy": "Wird erkannt…",
        "form.detectProtocolTrying": "Versuche {path}…",
        "form.detectProtocolLastTried": "; zuletzt versucht: {path}",
        "form.detectProtocolMatched": "Erkannt: {protocol}",
        "form.detectProtocolCompatible": "Endpoint erreichbar: {protocol}",
        "form.detectProtocolCustom": "Protokoll nicht erkannt – auf Benutzerdefiniert umgestellt, URLs vorausgefüllt",
        "form.detectProtocolProbe": "Erkannt: {protocol} ({probe} lieferte {shape})",
        "form.detectProtocolVerified": "Die URL passt zur Vorlage {protocol}",
        "form.detectProtocolVerifiedProbe": "Modellliste erreichbar ({probe} lieferte {shape})",
        "form.detectProtocolMismatch": "Diese Adresse sieht nicht nach {protocol} aus – Auswahl unverändert",
        "form.detectProtocolMismatchSuggested": "Diese Adresse sieht nicht nach {protocol} aus, sondern nach {suggested}. Auswahl unverändert.",
        "form.detectProtocolNoKey": "Kein nutzbarer API-Schlüssel (fehlt oder konnte nicht aufgelöst werden) – {probe} kann sich nicht authentifizieren",
        "form.detectProtocolAuthFailed": "Authentifizierung fehlgeschlagen ({probe} lieferte {status}): Schlüssel ungültig, fehlt oder ohne Berechtigung",
        "form.detectProtocolNoEndpoint": "Diese Adresse hat keinen solchen Endpunkt ({probe} lieferte {status})",
        "form.detectProtocolUnreachable": "Keine Verbindung zu {url}. Stellen Sie sicher, dass der Dienst läuft, und versuchen Sie es erneut.",
        "form.detectProtocolTimeout": "Zeitüberschreitung beim Verbinden mit {url}. Prüfen Sie Netzwerk oder Proxy und versuchen Sie es erneut.",
        "form.detectProtocolHttpError": "Server lieferte {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; auf Benutzerdefiniert umgestellt, URLs vorausgefüllt",
        "form.probeShape.openai-data": "eine data-Liste",
        "form.probeShape.gemini-models": "eine models-Liste",
        "form.probeShape.array": "ein Array",
        "form.probeShape.object": "ein JSON-Objekt",
        "errors.detectProtocol": "Protokollerkennung fehlgeschlagen",
        "protocolGroup.general": "Allgemein",
        "protocolGroup.gateway": "Gateways",
        "protocolGroup.native": "Anbieter-APIs",
        "protocolGroup.local": "Lokal",
        "protocolGroup.async": "Asynchron",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "Авто",
        "form.protocolRoutes": "Адреса протокола",
        "form.protocolSettings": "Настройки протокола",
        "form.protocolOption.edit": "Эндпоинт «из изображения»",
        "form.protocolOption.edit.edits": "Отдельный /images/edits",
        "form.protocolOption.edit.same": "Тот же /images/generations",
        "form.protocolOption.edit.none": "Без редактирования",
        "form.protocolOption.editHint": "Куда отправляются запросы редактирования: выберите Тот же, если провайдер предоставляет только /images/generations, или Без редактирования, если редактирование не поддерживается.",
        "form.auth": "Аутентификация",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "Свой заголовок",
        "form.auth.none": "Без аутентификации",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Параметр запроса",
        "form.authFollow": "По протоколу",
        "form.authQueryName": "Имя параметра",
        "form.authBasicCredential": "Данные входа (username:password)",
        "form.operations": "Форматы запроса и ответа",
        "form.modelOperations": "Форматы для этой модели",
        "form.operationsHint": "Выберите шаблон вывода или задайте методы, поля и ответы для generate, edit и models в JSON.",
        "form.modelOperationsHint": "Переопределите generate или edit в JSON. Пропущенные параметры берутся из настроек поставщика.",
        "form.operationsInvalidJson": "Введите допустимый объект JSON.",
        "form.operationOutput": "Формат ответа для {operation}",
        "form.outputPreset.auto": "По протоколу",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Двоичное изображение",
        "form.outputPreset.image-url": "URL изображения",
        "form.outputPreset.image-base64": "Изображение Base64",
        "form.outputPreset.task-location": "Асинхронная задача (Location)",
        "form.outputPreset.task-json": "Асинхронная задача (ID JSON)",
        "form.outputPreset.customLegacy": "Своё (из старой конфигурации)",
        "form.outputPreset.customLegacyHint": "Это значение было задано вручную раньше и сохраняется как есть. Выберите шаблон выше, чтобы переопределить его.",
        "form.saving": "Сохранение…",
        "serverError.provider.invalidAuth": "Проверьте способ аутентификации и его поля.",
        "serverError.provider.invalidOperations": "Проверьте конфигурацию операций. {message}",
        "form.authHint": "Какой заголовок несёт ключ: большинство сервисов использует Authorization: Bearer, сервисы вроде Azure — api-key; «Свой заголовок» принимает любое имя заголовка и префикс.",
        "form.authHeader": "Имя заголовка",
        "form.authPrefix": "Префикс",
        "form.route.generate": "Из текста",
        "form.route.edit": "Из изображения",
        "form.route.models": "Список моделей",
        "form.routeUnsupported": "Не поддерживается",
        "form.customProtocol": "Свой",
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
        "form.modelOptionsUnsupported": "Свои workflow доступны только при развёртывании ComfyUI",
        "form.modelWorkflow": "Свой workflow (формат API ComfyUI)",
        "form.modelWorkflowPlaceholder": "В ComfyUI выберите «Экспорт (API)» и вставьте JSON сюда · Оставьте пустым, чтобы использовать встроенный workflow по типу модели.",
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
        "form.modeCustomHint": "Подключите сторонний или локальный API генерации изображений и настройте адреса запросов, аутентификацию, параметры и форматы ответов.",
        "form.modeLocalHint": "Подключите службу изображений на этом компьютере или в локальной сети. Для локальных служб без авторизации ключ API можно оставить пустым.",
        "form.provider": "Поставщик",
        "form.providerWebsite": "Сайт поставщика",
        "form.localDeployer": "Локальное развёртывание",
        "form.localPresetsMissing": "Хост не передал список локальных развёртываний. Обновите страницу и повторите попытку.",
        "form.providerUnrecognized": "Предустановка провайдера не распознана; будет использована общая конфигурация протокола. Чтобы настроить без параметров, выберите в «Поставщик моделей».",
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
        "seat.chooseModel": "Сменить модель",
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
        "serverError.provider.invalidProbe": "Этот путь проверки не входит в план определения для этого адреса.",
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
        "form.modelMappingImage": "Референс",
        "form.modelMappingColName": "Параметр",
        "form.modelMappingColTarget": "Привязка",
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
        "param.steps.desc": "Шаги сэмплирования; больше шагов — больше деталей и времени",
        "param.seed.desc": "Сид; тот же сид и те же настройки дают ту же картинку",
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
        "form.paramName": "Имя параметра",
        "form.paramType": "Тип",
        "form.paramDefault": "По умолчанию",
        "form.paramDescription": "Описание",
        "form.paramExpose": "Показывать",
        "form.paramOptions": "Варианты",
        "form.paramNameHint": "Имя поля в теле запроса; строку промпта можно только переименовать",
        "form.paramDescriptionHint": "Показывается чат-модели",
        "form.paramExposeHint": "Только показанные строки можно менять через params",
        "form.paramOptionLabel": "Название варианта",
        "form.paramOptionValue": "Значение",
        "form.paramOptionDefault": "По умолчанию",
        "form.paramAddOption": "Добавить вариант",
        "form.paramRemoveOption": "Удалить этот вариант",
        "form.paramActions": "Действия",
        "form.paramRowLockHint": "Заблокированная строка не изменяется массовой настройкой и автоопределением",
        "form.paramAdd": "Добавить параметр",
        "form.paramRemove": "Удалить параметр",
        "form.paramConfirmRemove": "Удалить?",
        "form.paramDescPrompt": "Промпт изображения",
        "form.paramDescNegative": "Чего не должно быть",
        "form.paramDescModel": "Имя модели в запросе",
        "form.paramDescN": "Изображений за запрос",
        "form.paramNameHintWorkflow": "Имя параметра workflow — только ключ для чат-модели",
        "form.paramNameRequired": "Имя параметра не может быть пустым; без него в запросе нет имени модели и эту модель нельзя отправить",
        "form.paramWorkflowTableHint": "Это таблица параметров модели: строки из разбора workflow и входов попадают сюда; настраивать через params можно только показанные строки",
        "form.paramsEmptyWorkflow": "Параметры ещё не разобраны. Вставьте workflow и нажмите «Разобрать workflow».",
        "form.paramsEmpty": "У этой модели пока нет настраиваемых параметров. Нажмите «Добавить параметр», чтобы создать.",
        "form.a1111ParamRowsHint": "Значения по умолчанию отправляются с запросом; очистите — возьмётся настройка WebUI",
        "form.qualitySupported": "Поддерживает качество",
        "form.qualityField": "Имя параметра",
        "form.qualityOptionLabel": "Название ступени",
        "form.qualityOptionValue": "Значение",
        "form.qualityOptionDefault": "По умолчанию",
        "form.qualityAddOption": "Добавить ступень",
        "form.qualityRemoveOption": "Удалить эту ступень",
        "form.imageAs": "Кодирование",
        "form.imageField": "Имя поля",
        "form.imageSupported": "Поддерживает референсное изображение",
        "form.imageMode": "Несколько изображений",
        "form.imageModeSingle": "По одной",
        "form.imageModeArray": "Массив",
        "form.imageModeNumbered": "По номерам",
        "form.imageModeHint": "По одной — одно поле; массив — все изображения в этом поле; по номерам — name / name_2 / name_3 …",
        "form.autoDetect": "Автоопределение",
        "form.detecting": "Определение…",
        "form.detectNeedsModels": "Сначала добавьте модель",
        "form.bulkConfigure": "Настроить всё",
        "form.bulkConfiguring": "Настройка…",
        "form.bulkConfigDone": "Настроено моделей: {count} — без правила: {unmatched}",
        "form.bulkConfigNone": "Ни одна модель не совпала с правилом — отправка в режиме совместимости с OpenAI",
        "form.bulkConfigSkipped": "Все ключи заблокированы — настройка ничего не записала",
        "errors.detectRule": "Не удалось определить правила",
        "form.protocolMore": "Ещё протоколы…",
        "form.detectProtocol": "Определить протокол",
        "form.detectProtocolBusy": "Определение…",
        "form.detectProtocolTrying": "Проверяем {path}…",
        "form.detectProtocolLastTried": "; последняя попытка: {path}",
        "form.detectProtocolMatched": "Определено: {protocol}",
        "form.detectProtocolCompatible": "Адрес отвечает: {protocol}",
        "form.detectProtocolCustom": "Протокол не распознан: включён «Свой» с заполненными адресами",
        "form.detectProtocolProbe": "Определено: {protocol} ({probe} вернул {shape})",
        "form.detectProtocolVerified": "URL соответствует шаблону {protocol}",
        "form.detectProtocolVerifiedProbe": "Список моделей доступен ({probe} вернул {shape})",
        "form.detectProtocolMismatch": "Адрес не похож на {protocol} — выбор не изменён",
        "form.detectProtocolMismatchSuggested": "Адрес похож не на {protocol}, а на {suggested}. Выбор не изменён.",
        "form.detectProtocolNoKey": "Нет доступного ключа API (не заполнен или не удалось получить): {probe} не может пройти аутентификацию",
        "form.detectProtocolAuthFailed": "Ошибка аутентификации ({probe} вернул {status}): ключ недействителен, отсутствует или без прав",
        "form.detectProtocolNoEndpoint": "По этому адресу нет такого эндпоинта ({probe} вернул {status})",
        "form.detectProtocolUnreachable": "Не удалось подключиться к {url}. Убедитесь, что служба запущена, и повторите попытку.",
        "form.detectProtocolTimeout": "Истекло время ожидания подключения к {url}. Проверьте сеть или прокси и повторите попытку.",
        "form.detectProtocolHttpError": "Сервер вернул {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; включён «Свой» с заполненными адресами",
        "form.probeShape.openai-data": "список data",
        "form.probeShape.gemini-models": "список models",
        "form.probeShape.array": "массив",
        "form.probeShape.object": "JSON-объект",
        "errors.detectProtocol": "Не удалось определить протокол",
        "protocolGroup.general": "Общие",
        "protocolGroup.gateway": "Шлюзы",
        "protocolGroup.native": "Собственные API",
        "protocolGroup.local": "Локально",
        "protocolGroup.async": "Асинхронно",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
        "form.protocolAuto": "Auto",
        "form.protocolRoutes": "Endereços do protocolo",
        "form.protocolSettings": "Configurações do protocolo",
        "form.protocolOption.edit": "Endpoint de imagem para imagem",
        "form.protocolOption.edit.edits": "/images/edits separado",
        "form.protocolOption.edit.same": "Mesmo /images/generations",
        "form.protocolOption.edit.none": "Sem edição de imagem",
        "form.protocolOption.editHint": "Para onde vão as requisições de edição: escolha Mesmo se o provedor só expõe /images/generations, ou Sem edição de imagem se não houver edição.",
        "form.auth": "Autenticação",
        "form.auth.bearer": "Authorization: Bearer <key>",
        "form.auth.api-key": "api-key: <key>",
        "form.auth.x-key": "x-key: <key>",
        "form.auth.fal-key": "Authorization: Key <key>",
        "form.auth.custom": "Cabeçalho personalizado",
        "form.auth.none": "Sem autenticação",
        "form.auth.basic": "HTTP Basic",
        "form.auth.query": "Parâmetro de consulta",
        "form.authFollow": "Seguir o protocolo",
        "form.authQueryName": "Nome do parâmetro",
        "form.authBasicCredential": "Credenciais (username:password)",
        "form.operations": "Formatos de solicitação e resposta",
        "form.modelOperations": "Formatos para este modelo",
        "form.operationsHint": "Escolha um formato de saída ou configure em JSON os métodos, campos e respostas de generate, edit e models.",
        "form.modelOperationsHint": "Sobrescreva generate ou edit em JSON. Opções omitidas herdam os valores do provedor.",
        "form.operationsInvalidJson": "Insira um objeto JSON válido.",
        "form.operationOutput": "Formato de resposta de {operation}",
        "form.outputPreset.auto": "Seguir o protocolo",
        "form.outputPreset.openai": "OpenAI Images",
        "form.outputPreset.binary": "Imagem binária",
        "form.outputPreset.image-url": "URL da imagem",
        "form.outputPreset.image-base64": "Imagem Base64",
        "form.outputPreset.task-location": "Tarefa assíncrona (Location)",
        "form.outputPreset.task-json": "Tarefa assíncrona (ID JSON)",
        "form.outputPreset.customLegacy": "Personalizado (de configuração antiga)",
        "form.outputPreset.customLegacyHint": "Este valor foi escrito à mão anteriormente e é mantido como está. Escolha um ajuste acima para substituí-lo.",
        "form.saving": "Salvando…",
        "serverError.provider.invalidAuth": "Verifique o método de autenticação e os campos.",
        "serverError.provider.invalidOperations": "Verifique a configuração das operações. {message}",
        "form.authHint": "Qual cabeçalho leva a chave: a maioria dos serviços usa Authorization: Bearer, os no estilo Azure usam api-key; Personalizado aceita qualquer nome de cabeçalho e prefixo.",
        "form.authHeader": "Nome do cabeçalho",
        "form.authPrefix": "Prefixo",
        "form.route.generate": "Texto para imagem",
        "form.route.edit": "Imagem para imagem",
        "form.route.models": "Listar modelos",
        "form.routeUnsupported": "Não suportado",
        "form.customProtocol": "Personalizado",
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
        "form.modelOptionsUnsupported": "Fluxos de trabalho personalizados só estão disponíveis na implantação ComfyUI",
        "form.modelWorkflow": "Fluxo de trabalho personalizado (formato API do ComfyUI)",
        "form.modelWorkflowPlaceholder": "No ComfyUI use Exportar (API) e cole o JSON aqui · Deixe vazio para usar o fluxo integrado conforme o tipo do modelo.",
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
        "form.modeCustomHint": "Conecte uma API externa ou local de geração de imagens e configure endpoints, autenticação, parâmetros e formatos de resposta.",
        "form.modeLocalHint": "Conecte um serviço de imagens neste computador ou na sua rede local. Serviços locais sem autenticação podem deixar a chave de API em branco.",
        "form.provider": "Provedor",
        "form.providerWebsite": "Site do provedor",
        "form.localDeployer": "Implantação local",
        "form.localPresetsMissing": "O host não enviou a lista de implantações locais. Recarregue a página e tente novamente.",
        "form.providerUnrecognized": "Nenhum preset de provedor reconhecido; será usada a configuração genérica do protocolo. Para uma experiência sem configuração, escolha em «Provedor de modelos».",
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
        "seat.chooseModel": "Trocar modelo",
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
        "serverError.provider.invalidProbe": "Esse caminho de sondagem não faz parte do plano de detecção deste endereço.",
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
        "form.modelMappingImage": "Imagem de referência",
        "form.modelMappingColName": "Parâmetro",
        "form.modelMappingColTarget": "Mapeamento",
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
        "param.steps.desc": "Passos de amostragem; mais passos dão mais detalhe e demoram mais",
        "param.seed.desc": "Semente aleatória; a mesma semente e ajustes geram a mesma imagem",
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
        "form.paramName": "Nome do parâmetro",
        "form.paramType": "Tipo",
        "form.paramDefault": "Valor padrão",
        "form.paramDescription": "Descrição",
        "form.paramExpose": "Expor",
        "form.paramOptions": "Opções",
        "form.paramNameHint": "Nome do campo enviado no corpo; a linha do prompt só pode ser renomeada",
        "form.paramDescriptionHint": "Mostrado ao modelo de conversa",
        "form.paramExposeHint": "Só as linhas expostas podem ser ajustadas via params",
        "form.paramOptionLabel": "Nome da opção",
        "form.paramOptionValue": "Valor",
        "form.paramOptionDefault": "Padrão",
        "form.paramAddOption": "Adicionar opção",
        "form.paramRemoveOption": "Remover esta opção",
        "form.paramActions": "Ações",
        "form.paramRowLockHint": "Bloqueada, a linha não é alterada pela configuração em massa nem pela detecção automática",
        "form.paramAdd": "Adicionar parâmetro",
        "form.paramRemove": "Remover parâmetro",
        "form.paramConfirmRemove": "Excluir?",
        "form.paramDescPrompt": "Prompt da imagem",
        "form.paramDescNegative": "O que deve ser evitado",
        "form.paramDescModel": "Nome do modelo enviado na requisição",
        "form.paramDescN": "Imagens por requisição",
        "form.paramNameHintWorkflow": "O nome de um parâmetro de fluxo é só a chave vista pelo modelo",
        "form.paramNameRequired": "O nome do parâmetro não pode ficar vazio; sem ele a requisição não leva nome de modelo e este modelo não pode ser enviado",
        "form.paramWorkflowTableHint": "Esta é a tabela de parâmetros do modelo: as linhas da análise do fluxo e das entradas ficam aqui; só as expostas podem ser ajustadas via params",
        "form.paramsEmptyWorkflow": "Nenhum parâmetro analisado ainda. Cole um fluxo de trabalho e clique em «Analisar fluxo».",
        "form.paramsEmpty": "Este modelo ainda não tem parâmetros ajustáveis. Clique em «Adicionar parâmetro» para criar um.",
        "form.a1111ParamRowsHint": "Os padrões são enviados com a requisição; limpe um valor para seguir a configuração do WebUI",
        "form.qualitySupported": "Aceita qualidade",
        "form.qualityField": "Nome do parâmetro",
        "form.qualityOptionLabel": "Nome do nível",
        "form.qualityOptionValue": "Valor",
        "form.qualityOptionDefault": "Padrão",
        "form.qualityAddOption": "Adicionar nível",
        "form.qualityRemoveOption": "Remover este nível",
        "form.imageAs": "Codificação",
        "form.imageField": "Nome do campo",
        "form.imageSupported": "Aceita imagem de referência",
        "form.imageMode": "Várias imagens",
        "form.imageModeSingle": "Uma só",
        "form.imageModeArray": "Array",
        "form.imageModeNumbered": "Numeradas",
        "form.imageModeHint": "Uma só usa um campo; array põe todas as imagens nesse campo; numeradas expande em name / name_2 / name_3 …",
        "form.autoDetect": "Detecção automática",
        "form.detecting": "Detectando…",
        "form.detectNeedsModels": "Adicione um modelo primeiro",
        "form.bulkConfigure": "Configurar tudo",
        "form.bulkConfiguring": "Configurando…",
        "form.bulkConfigDone": "{count} modelos configurados — {unmatched} sem regra correspondente",
        "form.bulkConfigNone": "Nenhum modelo correspondeu a uma regra — envio compatível com OpenAI",
        "form.bulkConfigSkipped": "Todas as chaves estão bloqueadas — a configuração não gravou nada",
        "errors.detectRule": "Falha na detecção de regras",
        "form.protocolMore": "Mais protocolos…",
        "form.detectProtocol": "Detectar protocolo",
        "form.detectProtocolBusy": "Detectando…",
        "form.detectProtocolTrying": "Tentando {path}…",
        "form.detectProtocolLastTried": "; última tentativa: {path}",
        "form.detectProtocolMatched": "Detectado: {protocol}",
        "form.detectProtocolCompatible": "Endpoint responde: {protocol}",
        "form.detectProtocolCustom": "Protocolo não reconhecido: mudado para Personalizado com as URL preenchidas",
        "form.detectProtocolProbe": "Detectado: {protocol} ({probe} retornou {shape})",
        "form.detectProtocolVerified": "A URL corresponde à predefinição {protocol}",
        "form.detectProtocolVerifiedProbe": "Lista de modelos acessível ({probe} retornou {shape})",
        "form.detectProtocolMismatch": "O endereço não parece {protocol} — seleção inalterada",
        "form.detectProtocolMismatchSuggested": "O endereço não parece {protocol}, e sim {suggested}. Seleção inalterada.",
        "form.detectProtocolNoKey": "Nenhuma chave de API utilizável (não preenchida ou não foi possível resolver): {probe} não consegue autenticar",
        "form.detectProtocolAuthFailed": "Falha na autenticação ({probe} retornou {status}): a chave é inválida, está ausente ou não tem permissão",
        "form.detectProtocolNoEndpoint": "Este endereço não tem esse endpoint ({probe} retornou {status})",
        "form.detectProtocolUnreachable": "Não foi possível conectar a {url}. Verifique se o serviço está iniciado e tente novamente.",
        "form.detectProtocolTimeout": "Tempo esgotado ao conectar a {url}. Verifique a rede ou o proxy e tente novamente.",
        "form.detectProtocolHttpError": "O servidor retornou {status} ({probe})",
        "form.detectProtocolIssueSuffix": "; {issue}",
        "form.detectProtocolSwitchedToCustom": "; mudado para Personalizado com as URL preenchidas",
        "form.probeShape.openai-data": "uma lista data",
        "form.probeShape.gemini-models": "uma lista models",
        "form.probeShape.array": "uma matriz",
        "form.probeShape.object": "um objeto JSON",
        "errors.detectProtocol": "Falha na detecção do protocolo",
        "protocolGroup.general": "Gerais",
        "protocolGroup.gateway": "Gateways",
        "protocolGroup.native": "APIs nativas",
        "protocolGroup.local": "Local",
        "protocolGroup.async": "Assíncrono",
        "protocol.openai-images": "OpenAI Images",
        "protocol.openai-responses": "OpenAI Responses",
        "protocol.openai-chat": "OpenAI Chat Completions",
        "protocol.openrouter-images": "OpenRouter Images",
        "protocol.google-gemini": "Google Gemini",
        "protocol.recraft": "Recraft",
        "protocol.ideogram": "Ideogram",
        "protocol.stability": "Stability AI",
        "protocol.dashscope-qwen-image": "Alibaba Qwen-Image",
        "protocol.dashscope-wanx": "Alibaba Wanx",
        "protocol.a1111": "AUTOMATIC1111",
        "protocol.comfyui": "ComfyUI",
        "protocol.swarmui": "SwarmUI",
        "protocol.bfl": "Black Forest Labs",
        "protocol.fal": "fal.ai",
        "protocol.replicate": "Replicate",
        "protocol.modelscope": "ModelScope",
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
      fieldPathOf: fieldPathOf,
      fieldTemplateOf: fieldTemplateOf,
      pendingFieldAsOf: pendingFieldAsOf,
      imageStrategyOf: imageStrategyOf,
      imageNameOf: imageNameOf,
      imageKindOf: imageKindOf,
      imageTemplateOf: imageTemplateOf
    };
    return { inject, apply, __test };
  }
});
