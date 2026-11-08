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
    } catch (_error) { /* optional */ }

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
      modelCatalog: 'modelCatalog', modelCatalogHeading: 'modelCatalogHeading', modelCatalogTitle: 'modelCatalogTitle', modelCatalogMeta: 'modelCatalogMeta',
      modelList: 'modelList', modelListHead: 'modelListHead', modelEntry: 'modelEntry', modelRow: 'modelRow', modelEmpty: 'modelEmpty',
      addModelButton: 'addModelButton', iconButton: 'iconButton', iconButtonDanger: 'iconButtonDanger',
      // 两列数字 + 尾部控件：沿用设置页里「推理深度的最小/最大」那一行
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

    /** 重新解析类名前缀；变化时通知已挂载的组件重绘。 */
    function refreshThemeClasses() {
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
      themeClassRevision += 1;
      try { window.dispatchEvent(new Event('mo-image-theme')); } catch (_error) { /* ignore */ }
      return true;
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
    const QUALITY_VALUES = new Set(['off', 'low', 'medium', 'high', 'max', 'auto', 'standard', 'hd', 'default', 'quality', 'turbo']);
    const IMAGE_MIN_SIDE = 64;
    const IMAGE_MAX_SIDE = 4096;

    function normalizeQuality(value) {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'xhigh') return 'max';     // 旧的极高 → Max
      return QUALITY_VALUES.has(raw) ? raw : IMAGE_DEFAULT_QUALITY;
    }

    function qualitySpecFor(providerId, model) {
      const provider = imageCatalog.capabilities.find((item) => item && item.providerId === providerId);
      const entry = provider && Array.isArray(provider.models)
        ? provider.models.find((item) => item && item.model === model)
        : undefined;
      const spec = entry && entry.quality;
      return spec && Array.isArray(spec.options) && spec.options.length ? spec : null;
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
      return {
        quality: normalizeQuality(source.quality),
        auto: source.auto === undefined ? true : !!source.auto,
        width: clampSide(width, 1024),
        height: clampSide(height, 1024),
        promptOptimization: source.promptOptimization === undefined ? true : !!source.promptOptimization
      };
    }

    function sizeLabelOf(defaults, translate) {
      if (!defaults || defaults.auto) return (translate || fallbackTranslate)('seat.sizeAutoValue');
      return defaults.width + ' × ' + defaults.height;
    }

    function makeId() {
      return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function modelDisplayName(provider, model) {
      const id = String(model || '');
      const alias = provider && provider.names && typeof provider.names[id] === 'string' ? provider.names[id].trim() : '';
      return alias || id;
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
          // 服务端才是 provider 字段的权威；这里保留未知字段，避免客户端白名单
          // 与 normalizeConfig 漂移（adapter/protocol 就曾因此丢失）。
          return {
            ...p,
            id: id,
            name: String(p.name || ''),
            baseUrl: String(p.baseUrl || ''),
            key: String(p.key || ''),
            apiKeyEnv: String(p.apiKeyEnv || ''),
            keySource: String(p.keySource || ''),
            adapter: String(p.adapter || ''),
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

    function ImageProviderForm(props) {
      useThemeClassRevision();
      const t = props.t || fallbackTranslate;
      const isNew = !!props.isNew;
      const [draft, setDraft] = React.useState(() => ({
        ...props.provider,
        id: props.provider.id,
        name: props.provider.name || '',
        baseUrl: props.provider.baseUrl || '',
        key: isNew ? (props.provider.key || '') : '',
        apiKeyEnv: props.provider.apiKeyEnv || '',
        keySource: props.provider.keySource || '',
        adapter: props.provider.adapter || '',
        protocol: props.provider.protocol || 'openai-images',
        optionalKey: !!props.provider.optionalKey,
        models: (props.provider.models || []).slice(),
        names: { ...(props.provider.names || {}) }
      }));
      const [advanced, setAdvanced] = React.useState(false);
      const [mode, setMode] = React.useState('catalog');
      const [presetId, setPresetId] = React.useState('openai');
      const [localPresetId, setLocalPresetId] = React.useState('sd-server');
      const [modelFetch, setModelFetch] = React.useState({ loading: false, error: '' });
      const [candidates, setCandidates] = React.useState(null);
      const [candidateQuery, setCandidateQuery] = React.useState('');
      const [picked, setPicked] = React.useState([]);
      const [showAllCandidates, setShowAllCandidates] = React.useState(false);
      const candidateSearchRef = React.useRef(null);
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
        setDraft({ ...draft, models: draft.models.concat(''), names: { ...draft.names, '': '' } });
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
          key: '',
          models: [],
          names: {}
        }));
      };
      // 宿主 manifest 比设置页晚到时（例如首屏刚打开），补一次本地 preset 初始化。
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
            models: nextPreset ? (nextPreset.models || []).slice() : [],
            names: {}
          }));
        } else {
          setDraft((previous) => ({
            ...previous,
            adapter: '',
            protocol: 'openai-images',
            optionalKey: false
          }));
        }
      };
      // 新建表单默认带出第一个云端 preset（通常是 OpenAI），避免用户先看到空地址。
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
          models: (preset.models || []).slice(),
          names: {}
        }));
      }, [isNew, mode, providerPresets.length, presetId]);
      const canFetchModels = !draft.adapter || adapterSupportsModels(draft.adapter);
      const closeCandidates = () => {
        setCandidates(null);
        setCandidateQuery('');
        setPicked([]);
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
          const initial = ids.length ? ids : allModels;
          setCandidates({
            models: ids,
            allModels: allModels,
            filteredCount: Number(data.filteredCount) || 0
          });
          setShowAllCandidates(ids.length === 0 && allModels.length > 0);
          setPicked(initial.filter((id) => !draft.models.includes(id)));
          setCandidateQuery('');
          setModelFetch({ loading: false, error: '' });
        } catch (error) {
          setModelFetch({ loading: false, error: serverErrorText(t, error) });
        }
      };
      const candidateSource = candidates
        ? (showAllCandidates ? candidates.allModels : candidates.models)
        : [];
      const normalizedCandidateQuery = candidateQuery.trim().toLowerCase();
      const visibleCandidates = normalizedCandidateQuery
        ? candidateSource.filter((id) => id.toLowerCase().includes(normalizedCandidateQuery))
        : candidateSource;
      const allVisiblePicked = visibleCandidates.length > 0
        && visibleCandidates.every((id) => picked.includes(id));
      const toggleCandidate = (id) => {
        setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : current.concat(id));
      };
      const toggleVisibleCandidates = () => {
        if (!visibleCandidates.length) return;
        setPicked((current) => {
          const visible = new Set(visibleCandidates);
          if (visibleCandidates.every((id) => current.includes(id))) return current.filter((id) => !visible.has(id));
          const next = new Set(current);
          for (const id of visibleCandidates) next.add(id);
          return Array.from(next);
        });
      };
      const adoptCandidates = () => {
        if (!picked.length) return;
        const models = draft.models.slice();
        const names = { ...draft.names };
        for (const id of picked) {
          if (!models.includes(id)) {
            models.push(id);
            names[id] = '';
          }
        }
        setDraft({ ...draft, models: models, names: names });
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
        h('input', { className: MC.input, value: draft.baseUrl, onChange: (e) => setDraft({ ...draft, baseUrl: e.target.value }), placeholder: urlPlaceholder }),
        urlHint ? h('p', { className: MC.advancedHint, style: { margin: 0 } }, urlHint) : null
      );
      const protocolField = field(t('form.protocol'), h('select', { className: MC.input + ' ' + MC.selectInput, value: 'openai-images', disabled: true }, h('option', { value: 'openai-images' }, 'OpenAI Images')));
      const keyPlaceholder = isNew
        ? (draft.optionalKey ? t('form.keyLocalOptional') : t('form.keyEnter'))
        : (props.provider.hasKey || props.provider.key
          ? (props.provider.keySource === 'env' ? t('form.keyEnvSaved') : t('form.keySaved'))
          : (props.provider.optionalKey ? t('form.keyLocalOptional') : t('form.keyEnter')));
      const keyField = field(t('form.apiKey'), h('input', { className: MC.input, type: 'password', value: draft.key, onChange: (e) => setDraft({ ...draft, key: e.target.value }), placeholder: keyPlaceholder }));
      const modelDirectory = h('div', { className: MC.modelCatalog },
        h('div', { className: MC.modelListHead, style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 } },
          h('div', { className: MC.modelCatalogHeading },
            h('span', { className: MC.modelCatalogTitle }, t('form.modelDirectory')),
            h('p', { className: MC.modelCatalogMeta }, draft.models.length ? t('form.modelDirectoryCustom') : t('form.modelDirectoryDefault'))
          ),
          canFetchModels ? h('button', {
            type: 'button', className: MC.linkButton,
            disabled: modelFetch.loading || !draft.baseUrl.trim(),
            title: !draft.baseUrl.trim() ? t('form.fetchNeedsBaseUrl') : undefined,
            onClick: fetchModels
          }, modelFetch.loading ? t('form.fetching') : t('form.fetchModels')) : null
        ),
        modelFetch.error ? h('p', { className: MC.advancedHint, style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, modelFetch.error) : null,
        draft.models.length ? h('div', { className: MC.modelList },
          draft.models.map((model, index) => h('div', { className: MC.modelEntry, key: index },
            h('div', { className: MC.modelRow },
              h('input', {
                className: MC.input, value: model, placeholder: t('form.modelId'),
                onChange: (e) => {
                  const next = draft.models.slice();
                  const old = next[index];
                  next[index] = e.target.value;
                  const names = { ...draft.names };
                  if (old !== e.target.value) {
                    names[e.target.value] = names[old] || '';
                    delete names[old];
                  }
                  setDraft({ ...draft, models: next, names: names });
                }
              }),
              h('input', { className: MC.input, value: draft.names[model] || '', onChange: (e) => setDraft({ ...draft, names: { ...draft.names, [model]: e.target.value } }), placeholder: t('form.displayName') }),
              h('button', { type: 'button', className: MC.iconButton, disabled: true, title: t('form.modelSettings'), 'aria-label': t('form.modelSettings') },
                IconChevronRight ? h(IconChevronRight, {}) : '›'
              ),
              h('button', {
                type: 'button', className: MC.iconButton + ' ' + MC.iconButtonDanger,
                onClick: () => {
                  const names = { ...draft.names };
                  delete names[model];
                  setDraft({ ...draft, models: draft.models.filter((_m, at) => at !== index), names: names });
                },
                title: t('form.deleteModel'), 'aria-label': t('form.deleteModel')
              }, IconTrash ? h(IconTrash, { size: 14 }) : '×')
            )
          ))
        ) : h('div', { className: MC.modelEmpty }, t('form.modelEmpty')),
        h('button', { type: 'button', className: MC.addModelButton, onClick: addModel },
          IconPlus ? h(IconPlus, { size: 14 }) : null,
          t('form.addModel')
        )
      );
      const modelPicker = candidates ? createPortal(h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 10000, padding: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.45)'
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeCandidates(); }
      }, h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': t('picker.title'), tabIndex: -1,
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); closeCandidates(); }
        },
        style: {
          width: 'min(560px, 100%)', maxHeight: 'min(82vh, 760px)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px',
          border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-xl)',
          background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)'
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('strong', { style: { fontSize: 15 } }, t('picker.title')),
          h('button', { type: 'button', className: MC.linkButton, style: { marginLeft: 'auto' }, onClick: closeCandidates }, t('picker.close'))
        ),
        h('p', { className: MC.advancedHint, style: { margin: 0 } },
          t('picker.description')
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            ref: candidateSearchRef, className: MC.input, type: 'search',
            value: candidateQuery, placeholder: t('picker.search'), 'aria-label': t('picker.search'),
            style: { flex: 1 }, autoFocus: true,
            onChange: (event) => setCandidateQuery(event.target.value)
          }),
          h('button', {
            type: 'button', className: MC.linkButton,
            disabled: !visibleCandidates.length,
            onClick: toggleVisibleCandidates
          }, allVisiblePicked ? t('picker.deselectAll') : t('picker.selectAll'))
        ),
        candidates.filteredCount > 0 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('input', {
              type: 'checkbox', checked: showAllCandidates,
              onChange: (event) => setShowAllCandidates(event.target.checked)
            }),
            t('picker.showAll')
          ),
          h('span', { className: MC.advancedHint, style: { margin: 0 } },
            t('picker.filtered', { count: candidates.filteredCount })
          )
        ) : null,
        h('div', {
          role: 'list', 'aria-label': t('picker.listAria'),
          style: { minHeight: 120, maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }
        },
          visibleCandidates.length ? visibleCandidates.map((id) => h('label', {
            key: id,
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              borderRadius: 'var(--dsw-radius-md)', cursor: 'pointer', fontSize: 13
            }
          },
            h('input', {
              type: 'checkbox', checked: picked.includes(id),
              onChange: () => toggleCandidate(id)
            }),
            h('span', {
              title: id,
              style: {
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontFamily: 'var(--ds-font-family-code)'
              }
            }, id)
          )) : h('p', { className: MC.modelEmpty, style: { margin: 'auto' } }, t('picker.noMatches'))
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h('button', { type: 'button', className: MC.secondaryButton, onClick: closeCandidates }, t('form.cancel')),
          h('button', {
            type: 'button', className: MC.primaryButton,
            disabled: !picked.length, onClick: adoptCandidates
          }, picked.length ? t('picker.adoptCount', { count: picked.length }) : t('picker.adopt'))
        )
      )), document.body) : null;
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
            modelDirectory
          )
        ),
        actions,
        modelPicker
      );
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
        h('h2', { className: MC.title }, t('section.title')),
        h('p', { className: MC.intro }, t('section.intro')),
        saveError ? h('p', { className: MC.intro, role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, saveError) : null,
        h('ul', { className: MC.rows },
          store.providers.map((provider) => {
            const ready = !!(provider.baseUrl && (provider.hasKey || provider.key || provider.optionalKey) && provider.models.length);
            const local = !!provider.optionalKey || ['a1111', 'comfyui', 'swarmui'].includes(String(provider.adapter || ''));
            const editing = edit && !edit.isNew && edit.provider.id === provider.id;
            return h('li', { className: MC.rowCard, key: provider.id },
              h('div', { className: MC.rowHead },
                h('span', { className: MC.rowIdentity },
                  h('span', { className: MC.rowName }, provider.name || t('section.unnamedProvider')),
                  h('span', { className: MC.rowTag }, local ? t('tag.local') : t('tag.custom')),
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
              editing ? h(ImageProviderForm, { provider: edit.provider, onSave: save, onClose: () => setEdit(null), t: t }) : null
            );
          })
        ),
        h('div', { className: MC.addBlock },
          edit && edit.isNew
            ? h('div', { className: MC.addCard }, h(ImageProviderForm, { provider: edit.provider, isNew: true, onSave: save, onClose: () => setEdit(null), t: t }))
            : h('div', { className: MC.addActions },
                h('button', { type: 'button', className: MC.addButton, onClick: () => setEdit({ provider: { id: makeId(), name: '', baseUrl: '', key: '', apiKeyEnv: '', adapter: '', protocol: 'openai-images', optionalKey: false, models: [] }, isNew: true }) }, '+ ' + t('action.addProvider'))
              )
        )
      );
    }

    function ImageModelSeat(props) {
      // 子代理没有自己的对话模型选择器；生图选择器也沿用主对话配置。
      // 这里按 session.origin 判断，子代理里不渲染右下角的生图模型 seat。
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
      const store = imageStore.store;
      const setStore = imageStore.setStore;
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
      const defaults = store.defaults || normalizeDefaults(null);
      const active = activeImageConfig(store);
      const qualitySpec = qualitySpecFor(active.providerId, active.model);
      const qualityValue = qualityValueFor(defaults.quality, qualitySpec);
      const qualityLabel = qualityLabelFor(defaults.quality, qualitySpec, t);
      const saveDefaults = (patch) => {
        const next = writeImageStore({ ...store, defaults: { ...defaults, ...patch } }, t);
        setStore(next);
      };
      const choose = (providerId, model) => {
        const targetSpec = qualitySpecFor(providerId, model);
        const next = writeImageStore({
          ...store,
          active: { providerId: providerId, model: model },
          defaults: { ...defaults, quality: targetSpec ? qualityValueFor(defaults.quality, targetSpec) : defaults.quality }
        }, t);
        setStore(next);
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
      const hasAnyModel = store.providers.some((provider) => Array.isArray(provider.models) && provider.models.length > 0);
      const emptyModelHint = hasAnyModel && needle ? t('seat.noMatches') : t('seat.empty');
      const autoVisible = hasAnyModel && (!needle || 'auto'.includes(needle));
      const activeProvider = store.providers.find((provider) => provider.id === store.active.providerId) || store.providers[0];
      const activeModelName = hasAnyModel && active.model === 'auto' ? t('seat.auto') : (hasAnyModel && active.model ? modelDisplayName(activeProvider, active.model) : '');
      const triggerLabel = activeModelName || t('seat.fallback');
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
        cellRow('model', t('seat.menuModel'), hasAnyModel ? (active.model === 'auto' ? t('seat.auto') : (active.model || t('seat.notSelected'))) : t('seat.notSelected'), () => setPanel('model'))
      ];
      if (qualitySpec) homePanel.push(cellRow('quality', t('seat.menuQuality'), qualityLabel, () => setPanel('quality')));
      homePanel.push(
        cellRow('size', t('seat.menuSize'), sizeLabelOf(defaults, t), () => setPanel('size')),
        cellRow('promptOptimization', t('seat.menuPromptOptimization'), defaults.promptOptimization === false ? t('seat.off') : t('seat.on'), () => setPanel('promptOptimization'))
      );
      // 尺寸面板里的行是静态表单，不要 cell 的悬停高光；
      // option + modelOption 这一组合在样式表里被排除在 hover 规则之外。
      const plainRow = MS.option + ' ' + MS.modelOption;
      const sideInput = (key, label, value, display, min, max, onCommit, draft, setDraft, placeholder) => h('div', { key: key, className: plainRow },
        h('span', { className: MS.cellLabel }, label),
        h('input', {
          className: MC.input + ' ' + MC.modelReasoningValueInput, type: 'text', inputMode: 'numeric',
          value: draft || String(display), disabled: defaults.auto,
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
      const sizePanel = [
        h('div', { key: 'size', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': t('seat.menuSize') },
          h('div', { key: 'auto', className: plainRow },
            h('span', { className: MS.cellLabel }, t('seat.sizeAutoValue')),
            h('label', { className: MS.cellValue, title: t('seat.sizeAutoHint') },
              h('input', {
                type: 'checkbox', checked: !!defaults.auto,
                'aria-label': t('seat.sizeAutoAria'),
                onChange: (event) => saveDefaults({ auto: event.target.checked })
              })
            )
          ),
          // 宽 = width，高 = height；一级菜单同样按「宽 × 高」显示
          sideInput('width', t('seat.width'), defaults.width, defaults.width, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ width: value }), widthDraft, setWidthDraft, t('seat.width')),
          sideInput('height', t('seat.height'), defaults.height, defaults.height, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ height: value }), heightDraft, setHeightDraft, t('seat.height'))
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
          (qualitySpec ? qualitySpec.options : []).map((level) => h('button', {
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
      const panelBody = panel === 'model' ? modelPanel
        : panel === 'quality' ? qualityPanel
        : panel === 'size' ? sizePanel
        : panel === 'promptOptimization' ? promptOptimizationPanel
        : homePanel;
      return h('div', { className: MS.root },
        h('button', {
          type: 'button', ref: triggerRef, className: MS.trigger,
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
        "form.modelSettings": "模型设置",
        "form.deleteModel": "删除模型",
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
        "picker.title": "获取可用模型",
        "picker.close": "关闭",
        "picker.description": "选择要加入模型目录的模型；只有点“添加所选”才会写入当前草稿。",
        "picker.search": "搜索模型",
        "picker.selectAll": "全选",
        "picker.deselectAll": "取消全选",
        "picker.showAll": "显示全部模型",
        "picker.filtered": "已过滤 {count} 个可能非生图的模型",
        "picker.listAria": "可用模型",
        "picker.noMatches": "没有匹配的模型",
        "picker.adopt": "添加所选",
        "picker.adoptCount": "添加所选（{count}）",
        "seat.noMatches": "没有匹配的模型",
        "seat.empty": "还没有模型，去“设置 → 生图模型”添加",
        "seat.auto": "自动",
        "seat.fallback": "生图模型",
        "seat.menuModel": "模型",
        "seat.menuQuality": "质量",
        "seat.menuSize": "尺寸",
        "seat.menuPromptOptimization": "提示词优化",
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
        "localPreset.localai.hint": "OpenAI Images 兼容；模型名填 LocalAI 模型 YAML 里的 name，可从 /v1/models 获取。",
        "localPreset.a1111.urlHint": "只填服务根地址，不要带 /sdapi/v1；插件会拼 /sdapi/v1/txt2img、/img2img、/sd-models。",
        "localPreset.a1111.hint": "走 /sdapi/v1/txt2img 和 /sdapi/v1/img2img，模型列表来自 /sdapi/v1/sd-models；A1111 需要启动时加 --api。",
        "localPreset.comfyui.urlHint": "只填服务根地址，不要带 /prompt；插件会拼 /prompt、/history、/view。",
        "localPreset.comfyui.hint": "使用默认 SD/SDXL checkpoint 工作流；模型列表来自 /object_info。Flux/Qwen 等复杂工作流建议走 OpenAI 兼容网关。",
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
        "update.unsupported": "当前环境不支持自助更新，请运行 {command}",
        "update.localDev": "本地开发安装，请自行 git pull",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "在 GitHub 查看更新说明",
        "update.noNotes": "这次发布没有写更新说明。",
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
        "form.modelSettings": "Model settings",
        "form.deleteModel": "Remove model",
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
        "picker.title": "Fetch available models",
        "picker.close": "Close",
        "picker.description": "Select the models to add to the catalog. Nothing is written to the draft until you choose “Add selected”.",
        "picker.search": "Search models",
        "picker.selectAll": "Select all",
        "picker.deselectAll": "Clear selection",
        "picker.showAll": "Show all models",
        "picker.filtered": "Filtered as likely non-image: {count}",
        "picker.listAria": "Available models",
        "picker.noMatches": "No matching models",
        "picker.adopt": "Add selected",
        "picker.adoptCount": "Add selected ({count})",
        "seat.noMatches": "No matching models",
        "seat.empty": "No models yet. Add one in Settings → Image models.",
        "seat.auto": "Auto",
        "seat.fallback": "Image model",
        "seat.menuModel": "Model",
        "seat.menuQuality": "Quality",
        "seat.menuSize": "Size",
        "seat.menuPromptOptimization": "Prompt optimization",
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
        "localPreset.localai.hint": "OpenAI Images compatible. Use the name from the LocalAI model YAML; it can be listed from /v1/models.",
        "localPreset.a1111.urlHint": "Enter the service root URL without /sdapi/v1. The plugin appends /sdapi/v1/txt2img, /img2img, and /sd-models.",
        "localPreset.a1111.hint": "Uses /sdapi/v1/txt2img and /sdapi/v1/img2img; the model list comes from /sdapi/v1/sd-models. Start A1111 with --api.",
        "localPreset.comfyui.urlHint": "Enter the service root URL without /prompt. The plugin appends /prompt, /history, and /view.",
        "localPreset.comfyui.hint": "Uses the default SD/SDXL checkpoint workflow; the model list comes from /object_info. For complex workflows such as Flux or Qwen, use an OpenAI-compatible gateway.",
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
        "update.unsupported": "This environment cannot self-update; run {command}",
        "update.localDev": "Local development install — run git pull yourself",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "View release notes on GitHub",
        "update.noNotes": "This release has no notes.",
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
        "form.modelSettings": "モデル設定",
        "form.deleteModel": "モデルを削除",
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
        "picker.title": "利用可能なモデルを取得",
        "picker.close": "閉じる",
        "picker.description": "モデルカタログに追加するモデルを選択します。「選択項目を追加」を押すまで下書きには反映されません。",
        "picker.search": "モデルを検索",
        "picker.selectAll": "すべて選択",
        "picker.deselectAll": "選択を解除",
        "picker.showAll": "すべてのモデルを表示",
        "picker.filtered": "画像生成向けではない可能性があるモデルを {count} 件除外しました",
        "picker.listAria": "利用可能なモデル",
        "picker.noMatches": "一致するモデルがありません",
        "picker.adopt": "選択項目を追加",
        "picker.adoptCount": "選択項目を追加（{count}）",
        "seat.noMatches": "一致するモデルがありません",
        "seat.empty": "モデルがまだありません。「設定 → 画像生成モデル」で追加してください。",
        "seat.auto": "自動",
        "seat.fallback": "画像生成モデル",
        "seat.menuModel": "モデル",
        "seat.menuQuality": "画質",
        "seat.menuSize": "サイズ",
        "seat.menuPromptOptimization": "プロンプト最適化",
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
        "localPreset.localai.hint": "OpenAI Images 互換です。LocalAI のモデル YAML にある name を指定してください。/v1/models から取得できます。",
        "localPreset.a1111.urlHint": "サービスのルート URL のみを入力し、/sdapi/v1 は含めないでください。プラグインが /sdapi/v1/txt2img、/img2img、/sd-models を追加します。",
        "localPreset.a1111.hint": "/sdapi/v1/txt2img と /sdapi/v1/img2img を使用し、モデル一覧は /sdapi/v1/sd-models から取得します。A1111 は --api 付きで起動してください。",
        "localPreset.comfyui.urlHint": "サービスのルート URL のみを入力し、/prompt は含めないでください。プラグインが /prompt、/history、/view を追加します。",
        "localPreset.comfyui.hint": "既定の SD/SDXL チェックポイントワークフローを使用し、モデル一覧は /object_info から取得します。Flux や Qwen などの複雑なワークフローには OpenAI 互換ゲートウェイをおすすめします。",
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
        "update.unsupported": "この環境では自動更新できません。{command} を実行してください",
        "update.localDev": "ローカル開発用のインストールです。git pull を実行してください",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "GitHub でリリースノートを見る",
        "update.noNotes": "このリリースには説明がありません。",
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
        "form.modelSettings": "Ajustes del modelo",
        "form.deleteModel": "Eliminar modelo",
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
        "picker.title": "Obtener modelos disponibles",
        "picker.close": "Cerrar",
        "picker.description": "Selecciona los modelos que quieras añadir al catálogo. No se escribirá nada en el borrador hasta que elijas «Añadir seleccionados».",
        "picker.search": "Buscar modelos",
        "picker.selectAll": "Seleccionar todo",
        "picker.deselectAll": "Anular selección",
        "picker.showAll": "Mostrar todos los modelos",
        "picker.filtered": "Se han filtrado {count} modelos que probablemente no generan imágenes",
        "picker.listAria": "Modelos disponibles",
        "picker.noMatches": "No hay modelos coincidentes",
        "picker.adopt": "Añadir seleccionados",
        "picker.adoptCount": "Añadir seleccionados ({count})",
        "seat.noMatches": "No hay modelos coincidentes",
        "seat.empty": "Aún no hay modelos. Añade uno en Ajustes → Modelos de imagen.",
        "seat.auto": "Automático",
        "seat.fallback": "Modelo de imagen",
        "seat.menuModel": "Modelo",
        "seat.menuQuality": "Calidad",
        "seat.menuSize": "Tamaño",
        "seat.menuPromptOptimization": "Optimización de prompts",
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
        "localPreset.localai.hint": "Compatible con OpenAI Images. Usa el name del YAML de modelos de LocalAI; puedes listarlo desde /v1/models.",
        "localPreset.a1111.urlHint": "Introduce solo la URL raíz del servicio, sin /sdapi/v1. El plugin añade /sdapi/v1/txt2img, /img2img y /sd-models.",
        "localPreset.a1111.hint": "Usa /sdapi/v1/txt2img y /sdapi/v1/img2img; la lista de modelos viene de /sdapi/v1/sd-models. Inicia A1111 con --api.",
        "localPreset.comfyui.urlHint": "Introduce solo la URL raíz del servicio, sin /prompt. El plugin añade /prompt, /history y /view.",
        "localPreset.comfyui.hint": "Usa el flujo de trabajo predeterminado con checkpoint SD/SDXL; la lista de modelos viene de /object_info. Para flujos complejos como Flux o Qwen, usa una pasarela compatible con OpenAI.",
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
        "update.unsupported": "Este entorno no admite la actualización automática; ejecuta {command}",
        "update.localDev": "Instalación de desarrollo local: ejecuta git pull",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "Ver las notas de la versión en GitHub",
        "update.noNotes": "Esta versión no tiene notas.",
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
        "form.modelSettings": "Paramètres du modèle",
        "form.deleteModel": "Supprimer le modèle",
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
        "picker.title": "Récupérer les modèles disponibles",
        "picker.close": "Fermer",
        "picker.description": "Sélectionnez les modèles à ajouter au catalogue. Rien n'est écrit dans le brouillon avant « Ajouter la sélection ».",
        "picker.search": "Rechercher des modèles",
        "picker.selectAll": "Tout sélectionner",
        "picker.deselectAll": "Tout désélectionner",
        "picker.showAll": "Afficher tous les modèles",
        "picker.filtered": "Modèles probablement non génératifs écartés : {count}",
        "picker.listAria": "Modèles disponibles",
        "picker.noMatches": "Aucun modèle correspondant",
        "picker.adopt": "Ajouter la sélection",
        "picker.adoptCount": "Ajouter la sélection ({count})",
        "seat.noMatches": "Aucun modèle correspondant",
        "seat.empty": "Aucun modèle pour l'instant. Ajoutez-en un dans Paramètres → Modèles d'image.",
        "seat.auto": "Automatique",
        "seat.fallback": "Modèle d'image",
        "seat.menuModel": "Modèle",
        "seat.menuQuality": "Qualité",
        "seat.menuSize": "Taille",
        "seat.menuPromptOptimization": "Optimisation du prompt",
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
        "localPreset.localai.hint": "Compatible OpenAI Images. Utilisez le name du YAML de modèles LocalAI ; il peut être listé depuis /v1/models.",
        "localPreset.a1111.urlHint": "Indiquez uniquement l'URL racine du service, sans /sdapi/v1. Le plugin ajoute /sdapi/v1/txt2img, /img2img et /sd-models.",
        "localPreset.a1111.hint": "Utilise /sdapi/v1/txt2img et /sdapi/v1/img2img ; la liste des modèles provient de /sdapi/v1/sd-models. Lancez A1111 avec --api.",
        "localPreset.comfyui.urlHint": "Indiquez uniquement l'URL racine du service, sans /prompt. Le plugin ajoute /prompt, /history et /view.",
        "localPreset.comfyui.hint": "Utilise le workflow de checkpoint SD/SDXL par défaut ; la liste des modèles provient de /object_info. Pour les workflows complexes comme Flux ou Qwen, utilisez une passerelle compatible OpenAI.",
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
        "update.unsupported": "Cet environnement ne permet pas la mise à jour automatique ; exécutez {command}",
        "update.localDev": "Installation de développement local — lancez git pull",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "Voir les notes de version sur GitHub",
        "update.noNotes": "Cette version n'a pas de notes.",
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
        "form.modelSettings": "Modelleinstellungen",
        "form.deleteModel": "Modell entfernen",
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
        "picker.title": "Verfügbare Modelle abrufen",
        "picker.close": "Schließen",
        "picker.description": "Wählen Sie die Modelle aus, die dem Katalog hinzugefügt werden sollen. Erst mit „Auswahl hinzufügen“ wird der Entwurf geändert.",
        "picker.search": "Modelle suchen",
        "picker.selectAll": "Alle auswählen",
        "picker.deselectAll": "Auswahl aufheben",
        "picker.showAll": "Alle Modelle anzeigen",
        "picker.filtered": "Als wahrscheinlich nicht bildgenerierend gefiltert: {count}",
        "picker.listAria": "Verfügbare Modelle",
        "picker.noMatches": "Keine passenden Modelle",
        "picker.adopt": "Auswahl hinzufügen",
        "picker.adoptCount": "Auswahl hinzufügen ({count})",
        "seat.noMatches": "Keine passenden Modelle",
        "seat.empty": "Noch keine Modelle. Fügen Sie eines unter Einstellungen → Bildmodelle hinzu.",
        "seat.auto": "Automatisch",
        "seat.fallback": "Bildmodell",
        "seat.menuModel": "Modell",
        "seat.menuQuality": "Qualität",
        "seat.menuSize": "Größe",
        "seat.menuPromptOptimization": "Prompt-Optimierung",
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
        "localPreset.localai.hint": "OpenAI-Images-kompatibel. Verwenden Sie den name aus der LocalAI-Modell-YAML; er lässt sich über /v1/models auflisten.",
        "localPreset.a1111.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein, ohne /sdapi/v1. Das Plugin ergänzt /sdapi/v1/txt2img, /img2img und /sd-models.",
        "localPreset.a1111.hint": "Nutzt /sdapi/v1/txt2img und /sdapi/v1/img2img; die Modellliste stammt aus /sdapi/v1/sd-models. Starten Sie A1111 mit --api.",
        "localPreset.comfyui.urlHint": "Geben Sie nur die Stamm-URL des Dienstes ein, ohne /prompt. Das Plugin ergänzt /prompt, /history und /view.",
        "localPreset.comfyui.hint": "Nutzt den Standard-Workflow mit SD/SDXL-Checkpoint; die Modellliste stammt aus /object_info. Für komplexe Workflows wie Flux oder Qwen verwenden Sie ein OpenAI-kompatibles Gateway.",
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
        "update.unsupported": "Diese Umgebung kann sich nicht selbst aktualisieren; führen Sie {command} aus",
        "update.localDev": "Lokale Entwicklungsinstallation – bitte selbst git pull ausführen",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "Versionshinweise auf GitHub ansehen",
        "update.noNotes": "Diese Version hat keine Hinweise.",
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
        "form.modelSettings": "Настройки модели",
        "form.deleteModel": "Удалить модель",
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
        "picker.title": "Получить доступные модели",
        "picker.close": "Закрыть",
        "picker.description": "Выберите модели для добавления в каталог. В черновик ничего не попадёт, пока вы не нажмёте «Добавить выбранные».",
        "picker.search": "Поиск моделей",
        "picker.selectAll": "Выбрать все",
        "picker.deselectAll": "Снять выбор",
        "picker.showAll": "Показать все модели",
        "picker.filtered": "Исключено как вероятно не-изображения: {count}",
        "picker.listAria": "Доступные модели",
        "picker.noMatches": "Подходящих моделей нет",
        "picker.adopt": "Добавить выбранные",
        "picker.adoptCount": "Добавить выбранные ({count})",
        "seat.noMatches": "Подходящих моделей нет",
        "seat.empty": "Моделей пока нет. Добавьте их в «Настройки → Модели изображений».",
        "seat.auto": "Авто",
        "seat.fallback": "Модель изображений",
        "seat.menuModel": "Модель",
        "seat.menuQuality": "Качество",
        "seat.menuSize": "Размер",
        "seat.menuPromptOptimization": "Оптимизация промпта",
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
        "localPreset.localai.hint": "Совместимо с OpenAI Images. Укажите name из YAML-файла моделей LocalAI; список доступен в /v1/models.",
        "localPreset.a1111.urlHint": "Укажите только корневой URL службы, без /sdapi/v1. Плагин добавит /sdapi/v1/txt2img, /img2img и /sd-models.",
        "localPreset.a1111.hint": "Использует /sdapi/v1/txt2img и /sdapi/v1/img2img; список моделей берётся из /sdapi/v1/sd-models. Запускайте A1111 с параметром --api.",
        "localPreset.comfyui.urlHint": "Укажите только корневой URL службы, без /prompt. Плагин добавит /prompt, /history и /view.",
        "localPreset.comfyui.hint": "Использует стандартный workflow с checkpoint SD/SDXL; список моделей берётся из /object_info. Для сложных workflow (Flux, Qwen и т. п.) используйте шлюз, совместимый с OpenAI.",
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
        "update.unsupported": "Эта среда не поддерживает самообновление — выполните {command}",
        "update.localDev": "Локальная установка для разработки — выполните git pull",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "Посмотреть примечания к выпуску на GitHub",
        "update.noNotes": "В этом выпуске нет примечаний.",
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
        "form.modelSettings": "Configurações do modelo",
        "form.deleteModel": "Remover modelo",
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
        "picker.title": "Obter modelos disponíveis",
        "picker.close": "Fechar",
        "picker.description": "Selecione os modelos para adicionar ao catálogo. Nada é gravado no rascunho até você escolher “Adicionar selecionados”.",
        "picker.search": "Pesquisar modelos",
        "picker.selectAll": "Selecionar tudo",
        "picker.deselectAll": "Desmarcar tudo",
        "picker.showAll": "Mostrar todos os modelos",
        "picker.filtered": "Filtrados como prováveis não-imagens: {count}",
        "picker.listAria": "Modelos disponíveis",
        "picker.noMatches": "Nenhum modelo correspondente",
        "picker.adopt": "Adicionar selecionados",
        "picker.adoptCount": "Adicionar selecionados ({count})",
        "seat.noMatches": "Nenhum modelo correspondente",
        "seat.empty": "Ainda não há modelos. Adicione um em Configurações → Modelos de imagem.",
        "seat.auto": "Automático",
        "seat.fallback": "Modelo de imagem",
        "seat.menuModel": "Modelo",
        "seat.menuQuality": "Qualidade",
        "seat.menuSize": "Tamanho",
        "seat.menuPromptOptimization": "Otimização de prompt",
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
        "localPreset.localai.hint": "Compatível com OpenAI Images. Use o name do YAML de modelos do LocalAI; ele pode ser listado em /v1/models.",
        "localPreset.a1111.urlHint": "Informe apenas a URL raiz do serviço, sem /sdapi/v1. O plugin acrescenta /sdapi/v1/txt2img, /img2img e /sd-models.",
        "localPreset.a1111.hint": "Usa /sdapi/v1/txt2img e /sdapi/v1/img2img; a lista de modelos vem de /sdapi/v1/sd-models. Inicie o A1111 com --api.",
        "localPreset.comfyui.urlHint": "Informe apenas a URL raiz do serviço, sem /prompt. O plugin acrescenta /prompt, /history e /view.",
        "localPreset.comfyui.hint": "Usa o fluxo de trabalho padrão com checkpoint SD/SDXL; a lista de modelos vem de /object_info. Para fluxos complexos como Flux ou Qwen, use um gateway compatível com OpenAI.",
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
        "update.unsupported": "Este ambiente não permite atualização automática; execute {command}",
        "update.localDev": "Instalação de desenvolvimento local — execute git pull",
        "update.command": "dsh plugin add github:CM-Silence/dsh-mo-image#{tag}",
        "update.viewRelease": "Ver notas da versão no GitHub",
        "update.noNotes": "Esta versão não tem notas.",
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
        const timers = [0, 120, 600, 1500].map((delay) => setTimeout(refreshThemeClasses, delay));
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
      if (state === 'failed') return translate('update.failed');
      if (state === 'updating') return translate('update.starting');
      return null;
    }

    // Test-only seam: the module loader ignores extra exports; browser code only
    // consumes inject/apply. Kept here so error composition can be unit-tested.
    const __test = {
      serverErrorText: serverErrorText,
      responseError: responseError,
      fetchUpdateStatus: fetchUpdateStatus,
      renderUpdateNotes: renderUpdateNotes,
      updateToastFor: updateToastFor
    };
    return { inject, apply, __test };
  }
});
