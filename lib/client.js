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

    // DSH 的组件样式是 CSS Modules：类名形如 `<构建前缀>_<语义名>`。前缀会随
    // DSH 版本/构建变化，所以这里不写死完整类名，只保留语义名；运行时从当前
    // 已加载的样式表里解析出前缀，再拼成真实类名。这样 DSH 升级换了 hash，
    // 或者美化插件重写了同一批类名的样式，插件都能继续复用当前样式。
    const SETTINGS_CLASS_LOCALS = {
      section: 'section', title: 'title', intro: 'intro',
      rows: 'rows', rowCard: 'rowCard', rowHead: 'rowHead',
      rowIdentity: 'rowIdentity', rowName: 'rowName', rowTag: 'rowTag',
      credentialDot: 'credentialDot', credentialDotConfigured: 'credentialDotConfigured', credentialDotMissing: 'credentialDotMissing',
      rowActions: 'rowActions', secondaryButton: 'secondaryButton', primaryButton: 'primaryButton', dangerButton: 'dangerButton',
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

    /** 从 CSS 里找出 `.前缀语义名` 中的前缀；找不到返回空串。 */
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

    function qualityLabelFor(value, spec) {
      if (!spec) return '';
      const wanted = qualityValueFor(value, spec);
      const hit = spec.options.find((item) => item.value === wanted);
      return hit ? hit.label : wanted;
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

    function sizeLabelOf(defaults) {
      if (!defaults || defaults.auto) return 'Auto';
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
            name: String(p.name || ('地址 ' + (i + 1))),
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
          const model = provider.models.includes(active.model) ? active.model : (provider.models[0] || '');
          out.active = { providerId: provider.id, model: model };
        }
        return out;
      }
      if (raw.baseUrl || raw.model) {
        const models = raw.model ? [String(raw.model)] : [];
        const provider = {
          id: makeId(), name: '默认地址', baseUrl: String(raw.baseUrl || ''),
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

    function loadImageStore() {
      if (imageStoreLoadPromise) return imageStoreLoadPromise;
      imageStoreLoadPromise = (async () => {
        try {
          const response = await fetch('/api/mo-image/config', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
          const data = await response.json();
          if (!response.ok) throw new Error('读取生图配置失败：HTTP ' + response.status);
          applyCatalog(data);
          imageStoreCache = normalizeImageStore(data.config);
          imageStoreLoaded = true;
          window.dispatchEvent(new Event('mo-image-config'));
        } catch (error) {
          try { window.dispatchEvent(new CustomEvent('mo-image-config-error', { detail: { message: String(error && error.message ? error.message : error) } })); } catch (_error) { /* ignore */ }
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
    function writeImageStore(store) {
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
          if (!response.ok) throw new Error(data.error || ('保存生图配置失败：HTTP ' + response.status));
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
              detail: { message: String(error && error.message ? error.message : error) }
            }));
          } catch (_error) { /* ignore */ }
        }
      });
      return next;
    }

    function useImageStore(options) {
      const [store, setStore] = React.useState(readImageStore);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        const sync = () => setStore(readImageStore());
        const onError = (event) => setError((event && event.detail && event.detail.message) || '生图配置保存失败');
        const onSaved = () => setError('');
        window.addEventListener('mo-image-config', sync);
        window.addEventListener('storage', sync);
        window.addEventListener('mo-image-config-error', onError);
        if (options && options.saved) window.addEventListener('mo-image-config-saved', onSaved);
        if (!imageStoreLoaded) loadImageStore();
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
      const providerPresets = providerPresetsForUi();
      const localPresets = localPresetsForUi();
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
      const canFetchModels = adapterSupportsModels(draft.adapter);
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
          if (!response.ok) throw new Error(data.error || ('获取模型列表失败：HTTP ' + response.status));
          const ids = Array.isArray(data.models) ? data.models : [];
          if (!ids.length) throw new Error('服务没有返回模型；请手动填写模型 ID');
          setDraft((previous) => {
            const models = previous.models.slice();
            const existing = new Set(models);
            const names = { ...previous.names };
            for (const id of ids) {
              if (!existing.has(id)) { models.push(id); existing.add(id); }
              if (!(id in names)) names[id] = '';
            }
            return { ...previous, models: models, names: names };
          });
          setModelFetch({ loading: false, error: '' });
        } catch (error) {
          setModelFetch({ loading: false, error: String(error && error.message ? error.message : error) });
        }
      };
      const field = (label, control) => h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, label),
        control
      );
      const nameField = field('显示名称', h('input', { className: MC.input, value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }), placeholder: '显示名称' }));
      const urlHint = (localPresets.find((item) => item.adapter === draft.adapter) || {}).urlHint || '';
      const urlPlaceholder = mode === 'local' && localPreset ? localPreset.baseUrl : 'https://gateway.example/v1';
      const urlField = h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, 'API 地址'),
        h('input', { className: MC.input, value: draft.baseUrl, onChange: (e) => setDraft({ ...draft, baseUrl: e.target.value }), placeholder: urlPlaceholder }),
        urlHint ? h('p', { className: MC.advancedHint, style: { margin: 0 } }, urlHint) : null
      );
      const protocolField = field('API 协议', h('select', { className: MC.input + ' ' + MC.selectInput, value: 'openai-images', disabled: true }, h('option', { value: 'openai-images' }, 'OpenAI Images')));
      const keyField = field('API 密钥', h('input', { className: MC.input, type: 'password', value: draft.key, onChange: (e) => setDraft({ ...draft, key: e.target.value }), placeholder: isNew ? (draft.optionalKey ? '本地无鉴权可留空' : '输入 API 密钥') : (props.provider.hasKey || props.provider.key ? (props.provider.keySource === 'env' ? '使用环境变量中的已保存密钥' : '留空使用已保存凭证') : (props.provider.optionalKey ? '本地无鉴权可留空' : '输入 API 密钥')) }));
      const modelDirectory = h('div', { className: MC.modelCatalog },
        h('div', { className: MC.modelListHead, style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 } },
          h('div', { className: MC.modelCatalogHeading },
            h('span', { className: MC.modelCatalogTitle }, '模型目录'),
            h('p', { className: MC.modelCatalogMeta }, draft.models.length ? '已自定义模型目录' : '正在使用适配器默认模型')
          ),
          canFetchModels ? h('button', {
            type: 'button', className: MC.secondaryButton,
            style: { height: 28, padding: '0 10px', fontSize: 12, whiteSpace: 'nowrap' },
            disabled: modelFetch.loading,
            onClick: fetchModels
          }, modelFetch.loading ? '获取中…' : '获取可用模型') : null
        ),
        modelFetch.error ? h('p', { className: MC.advancedHint, style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, modelFetch.error) : null,
        draft.models.length ? h('div', { className: MC.modelList },
          draft.models.map((model, index) => h('div', { className: MC.modelEntry, key: index },
            h('div', { className: MC.modelRow },
              h('input', {
                className: MC.input, value: model, placeholder: '模型 ID',
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
              h('input', { className: MC.input, value: draft.names[model] || '', onChange: (e) => setDraft({ ...draft, names: { ...draft.names, [model]: e.target.value } }), placeholder: '显示名称' }),
              h('button', { type: 'button', className: MC.iconButton, disabled: true, title: '模型设置', 'aria-label': '模型设置' },
                IconChevronRight ? h(IconChevronRight, {}) : '›'
              ),
              h('button', {
                type: 'button', className: MC.iconButton + ' ' + MC.iconButtonDanger,
                onClick: () => {
                  const names = { ...draft.names };
                  delete names[model];
                  setDraft({ ...draft, models: draft.models.filter((_m, at) => at !== index), names: names });
                },
                title: '删除模型', 'aria-label': '删除模型'
              }, IconTrash ? h(IconTrash, { size: 14 }) : '×')
            )
          ))
        ) : h('div', { className: MC.modelEmpty }, '模型选择器中将不显示任何模型；需要先在模型目录里添加模型 ID。'),
        h('button', { type: 'button', className: MC.addModelButton, onClick: addModel },
          IconPlus ? h(IconPlus, { size: 14 }) : null,
          '添加模型'
        )
      );
      const actions = h('div', { className: MC.editorActions },
        h('button', { type: 'button', className: MC.secondaryButton, onClick: props.onClose }, '取消'),
        h('button', { type: 'button', className: MC.primaryButton, onClick: () => props.onSave({ ...draft, key: draft.key.trim() }) }, '保存')
      );
      if (isNew) {
        const modes = DshSegmentedControl
          ? h(DshSegmentedControl, {
              id: 'mo-image-add-mode',
              label: '添加方式',
              value: mode,
              options: [
                { value: 'catalog', label: '第三方模型提供商' },
                { value: 'custom', label: '自定义模型 API' },
                { value: 'local', label: '本地模型' }
              ],
              onChange: (next) => switchMode(next)
            })
          : h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-1)' } },
              ['catalog', 'custom', 'local'].map((value) => h('button', {
                key: value, type: 'button', onClick: () => switchMode(value),
                style: { height: 28, padding: '0 12px', border: value === mode ? '.5px solid var(--dsw-alias-border-l3)' : 0, borderRadius: 'var(--dsw-radius-md)', background: value === mode ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: value === mode ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }
              }, value === 'catalog' ? '第三方模型提供商' : value === 'custom' ? '自定义模型 API' : '本地模型'))
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
        const catalogBody = h(React.Fragment, null,
          field('提供商', h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: presetId,
            onChange: (e) => choosePreset(e.target.value)
          }, providerPresets.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
          keyField,
          h('details', {
            className: MC.customized,
            open: advanced,
            onToggle: (e) => setAdvanced(e.currentTarget.open)
          },
            h('summary', { className: MC.customizedSummary }, '自定义设置'),
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
          localPresets.length ? field('本地部署器', h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: localPreset ? localPreset.id : localPresetId,
            onChange: (e) => applyLocalPreset(e.target.value)
          }, localPresets.map((item) => h('option', { key: item.id, value: item.id }, item.name)))) : h('p', { className: MC.advancedHint }, '宿主没有下发本地部署器列表，请刷新页面后重试。'),
          nameField,
          urlField,
          keyField,
          localPreset && localPreset.hint ? h('p', { className: MC.advancedHint }, localPreset.hint) : null,
          modelDirectory
        );
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { className: MC.addModes },
            modes,
            h('p', { className: MC.advancedHint }, mode === 'catalog'
              ? '从内置目录中选择 OpenAI、火山方舟、阿里云百炼等官方或大型模型平台，填入其 API 密钥即可使用。'
              : mode === 'local'
                ? '连接本机或局域网里的生图服务；无鉴权的本地服务可以留空 API 密钥。'
                : '接入自部署或其他兼容 OpenAI Images 的接口。')
          ),
          mode === 'catalog' ? catalogBody : mode === 'local' ? localBody : customBody,
          actions
        );
      }
      return h('div', { className: MC.editor },
        keyField,
        h('details', {
          className: MC.customized,
          open: advanced,
          onToggle: (e) => setAdvanced(e.currentTarget.open)
        },
          h('summary', { className: MC.customizedSummary }, '自定义设置'),
          h('div', { className: MC.customizedBody },
            nameField,
            urlField,
            protocolField,
            modelDirectory
          )
        ),
        actions
      );
    }

    function ImageModelSettings() {
      useThemeClassRevision();
      const imageStore = useImageStore({ saved: true });
      const store = imageStore.store;
      const setStore = imageStore.setStore;
      const saveError = imageStore.error;
      const setSaveError = imageStore.setError;
      const [edit, setEdit] = React.useState(null);
      const save = (provider) => {
        setSaveError('');
        const exists = store.providers.some((p) => p.id === provider.id);
        const providers = exists ? store.providers.map((p) => p.id === provider.id ? provider : p) : store.providers.concat(provider);
        const activeModelStillThere = providers.some((p) => p.id === store.active.providerId && p.models.includes(store.active.model));
        const nextActive = activeModelStillThere ? store.active : { providerId: provider.id, model: provider.models[0] || '' };
        const saved = writeImageStore({ providers: providers, active: nextActive, defaults: store.defaults });
        setStore(saved);
        setEdit(null);
      };
      const remove = (provider) => {
        const providers = store.providers.filter((p) => p.id !== provider.id);
        const active = store.active.providerId === provider.id ? { providerId: providers[0] ? providers[0].id : '', model: providers[0] && providers[0].models[0] ? providers[0].models[0] : '' } : store.active;
        const saved = writeImageStore({ providers: providers, active: active, defaults: store.defaults });
        setStore(saved);
      };
      return h('div', { className: MC.section },
        h('h2', { className: MC.title }, '生图模型'),
        h('p', { className: MC.intro }, '填入云平台密钥，或连接本机/局域网里的生图服务。'),
        saveError ? h('p', { className: MC.intro, role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, saveError) : null,
        h('ul', { className: MC.rows },
          store.providers.map((provider) => {
            const ready = !!(provider.baseUrl && (provider.hasKey || provider.key || provider.optionalKey) && provider.models.length);
            const local = !!provider.optionalKey || ['a1111', 'comfyui', 'swarmui'].includes(String(provider.adapter || ''));
            const editing = edit && !edit.isNew && edit.provider.id === provider.id;
            return h('li', { className: MC.rowCard, key: provider.id },
              h('div', { className: MC.rowHead },
                h('span', { className: MC.rowIdentity },
                  h('span', { className: MC.rowName }, provider.name || '未命名提供商'),
                  h('span', { className: MC.rowTag }, local ? '本地' : '自定义'),
                  h('span', {
                    className: MC.credentialDot + ' ' + (ready ? MC.credentialDotConfigured : MC.credentialDotMissing),
                    title: ready ? '可用' : (provider.optionalKey ? '缺少 API 地址 / 模型' : '缺少 API 地址 / 密钥 / 模型'),
                    'aria-label': ready ? '可用' : '缺少配置'
                  })
                ),
                h('span', { className: MC.rowActions },
                  h('button', { type: 'button', className: MC.secondaryButton, onClick: () => setEdit({ provider: provider, isNew: false }) }, '编辑'),
                  h('button', { type: 'button', className: MC.dangerButton, onClick: () => remove(provider) }, '删除')
                )
              ),
              editing ? h(ImageProviderForm, { provider: edit.provider, onSave: save, onClose: () => setEdit(null) }) : null
            );
          })
        ),
        h('div', { className: MC.addBlock },
          edit && edit.isNew
            ? h('div', { className: MC.addCard }, h(ImageProviderForm, { provider: edit.provider, isNew: true, onSave: save, onClose: () => setEdit(null) }))
            : h('div', { className: MC.addActions },
                h('button', { type: 'button', className: MC.addButton, onClick: () => setEdit({ provider: { id: makeId(), name: '', baseUrl: '', key: '', apiKeyEnv: '', adapter: '', protocol: 'openai-images', optionalKey: false, models: [] }, isNew: true }) }, '+ 添加模型提供商')
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

    function ImageModelSeatInner() {
      useThemeClassRevision();
      const imageStore = useImageStore();
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
      const qualityLabel = qualityLabelFor(defaults.quality, qualitySpec);
      const saveDefaults = (patch) => {
        const next = writeImageStore({ ...store, defaults: { ...defaults, ...patch } });
        setStore(next);
      };
      const choose = (providerId, model) => {
        const targetSpec = qualitySpecFor(providerId, model);
        const next = writeImageStore({
          ...store,
          active: { providerId: providerId, model: model },
          defaults: { ...defaults, quality: targetSpec ? qualityValueFor(defaults.quality, targetSpec) : defaults.quality }
        });
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
      const activeProvider = store.providers.find((provider) => provider.id === store.active.providerId) || store.providers[0];
      const activeModelName = active.model ? modelDisplayName(activeProvider, active.model) : '';
      const triggerLabel = activeModelName || '生图模型';
      let optionIndex = -1;
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
        cellRow('model', '模型', active.model || '未选择', () => setPanel('model'))
      ];
      if (qualitySpec) homePanel.push(cellRow('quality', '质量', qualityLabel, () => setPanel('quality')));
      homePanel.push(
        cellRow('size', '尺寸', sizeLabelOf(defaults), () => setPanel('size')),
        cellRow('promptOptimization', '提示词优化', defaults.promptOptimization === false ? 'Off' : 'On', () => setPanel('promptOptimization'))
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
        h('div', { key: 'size', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': '尺寸' },
          h('div', { key: 'auto', className: plainRow },
            h('span', { className: MS.cellLabel }, 'Auto'),
            h('label', { className: MS.cellValue, title: '自动尺寸，交给模型决定' },
              h('input', {
                type: 'checkbox', checked: !!defaults.auto,
                'aria-label': '自动尺寸',
                onChange: (event) => saveDefaults({ auto: event.target.checked })
              })
            )
          ),
          // 宽 = width，高 = height；一级菜单同样按「宽 × 高」显示
          sideInput('width', '宽', defaults.width, defaults.width, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ width: value }), widthDraft, setWidthDraft, '宽'),
          sideInput('height', '高', defaults.height, defaults.height, IMAGE_MIN_SIDE, IMAGE_MAX_SIDE,
            (value) => saveDefaults({ height: value }), heightDraft, setHeightDraft, '高')
        )
      ];
      const modelPanel = [
        h('div', { key: 'search', className: MS.searchRow },
          h(Search, {
            ref: searchRef,
            className: MS.search + (query ? ' ' + MS.searchWithQuery : ''),
            type: 'text', role: 'searchbox', 'aria-label': '搜索生图模型',
            placeholder: '搜索模型', value: query,
            onChange: (event) => setQuery(event.target.value)
          }),
          query ? h('button', {
            type: 'button', className: MS.searchClear, 'aria-label': '清除搜索',
            onClick: () => { setQuery(''); try { searchRef.current && searchRef.current.focus(); } catch (_error) { /* ignore */ } }
          }, IconCloseFill ? h(IconCloseFill, {}) : h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
            h('path', { d: 'M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))) : null
        ),
        h('div', { key: 'groups', ref: groupsRef, className: MS.groups + ' scrollable', role: 'menu', 'aria-label': '生图模型' },
          visible.length ? visible.map((provider) => h(Group, { key: provider.id, label: provider.name || '未命名地址' },
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
          )) : h('div', { className: MS.empty }, query ? '没有匹配的模型' : '还没有模型，去设置 → 生图模型添加')
        )
      ];
      const qualityPanel = [
        h('div', { key: 'quality', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': '质量' },
          (qualitySpec ? qualitySpec.options : []).map((level) => h('button', {
            key: level.value, type: 'button', role: 'menuitemradio',
            'aria-checked': qualityValue === level.value,
            className: MS.option + (qualityValue === level.value ? ' ' + MS.selected : ''),
            onClick: () => { saveDefaults({ quality: level.value }); closeMenu(); }
          },
            h('span', { className: MS.optionCopy },
              h('span', { className: MS.modelName }, level.label)
            ),
            checkMark(qualityValue === level.value)
          ))
        )
      ];
      const promptOptimizationPanel = [
        h('div', { key: 'promptOptimization', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': '提示词优化' },
          [{ value: true, label: 'On' }, { value: false, label: 'Off' }].map((item) => {
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
          title: active.model ? activeModelName + (qualitySpec ? ' · ' + qualityLabel : '') : '选择生图模型',
          'aria-label': active.model ? '生图模型：' + activeModelName + (qualitySpec ? '，质量 ' + qualityLabel : '') : '选择生图模型',
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
          'aria-label': '生图设置'
        }, panelBody), document.body) : null
      );
    }

    const NAV_ICON_CSS = 'button[data-mo-image-nav] svg{display:none!important}button[data-mo-image-nav]::before{content:"";width:16px;height:16px;flex:none;display:inline-block;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.3%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Crect x=%222.2%22 y=%223.2%22 width=%2211.6%22 height=%229.6%22 rx=%221.6%22/%3E%3Ccircle cx=%225.6%22 cy=%226.8%22 r=%221.1%22/%3E%3Cpath d=%22M2.8 11.4l3.4-3 2 2 2.4-2.6 2 3.4%22/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.3%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Crect x=%222.2%22 y=%223.2%22 width=%2211.6%22 height=%229.6%22 rx=%221.6%22/%3E%3Ccircle cx=%225.6%22 cy=%226.8%22 r=%221.1%22/%3E%3Cpath d=%22M2.8 11.4l3.4-3 2 2 2.4-2.6 2 3.4%22/%3E%3C/svg%3E") center/contain no-repeat}';

    function installSettingsNavIcon(ctx) {
      const install = () => {
        let style = document.getElementById('mo-image-nav-icon-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'mo-image-nav-icon-style';
          style.textContent = NAV_ICON_CSS;
          document.head.appendChild(style);
        }
        const SETTINGS_SELECTOR = '[data-shortcut-modal="settings"]';
        let panel = null;
        const mark = () => {
          const current = document.querySelector(SETTINGS_SELECTOR);
          if (!current) return null;
          const buttons = current.querySelectorAll('[class*="navList"] button');
          for (const button of buttons) {
            const label = button.querySelector('[class*="navLabel"]');
            if (label && label.textContent.trim() === '生图模型') button.setAttribute('data-mo-image-nav', '');
          }
          return current;
        };
        let scheduled = 0;
        const schedule = () => {
          if (scheduled) return;
          if (typeof requestAnimationFrame !== 'function') { mark(); return; }
          scheduled = requestAnimationFrame(() => { scheduled = 0; mark(); });
        };
        // 只在设置面板出现/内部变化时调度，避免流式输出期间每帧全文档扫描。
        const observer = new MutationObserver((records) => {
          if (panel && panel.isConnected) {
            for (const record of records) {
              if (panel.contains(record.target)) { schedule(); return; }
            }
            return;
          }
          panel = null;
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!node || node.nodeType !== 1) continue;
              const hit = node.matches(SETTINGS_SELECTOR) ? node : node.querySelector(SETTINGS_SELECTOR);
              if (hit) { panel = hit; schedule(); return; }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        panel = mark();
        return () => {
          if (scheduled && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled);
          observer.disconnect();
          if (style && style.parentNode) style.remove();
          document.querySelectorAll('[data-mo-image-nav]').forEach((button) => button.removeAttribute('data-mo-image-nav'));
        };
      };
      if (ctx && typeof ctx.effect === 'function') return ctx.effect(install, 'mo-image: settings icon');
      return install();
    }

    const inject = ['slots'];
    function apply(ctx) {
      loadImageStore();
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
      installSettingsNavIcon(ctx);
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'mo-image-model-seat', order: 10
      }, ImageModelSeat));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'mo-image-models', order: 12, label: () => '生图模型'
      }, ImageModelSettings));
    }
    return { inject, apply };
  }
});
