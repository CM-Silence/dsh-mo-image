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

const IMAGE_PROVIDER_PRESETS = [
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
      { id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { id: 'dashscope', name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
      { id: 'bigmodel', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
    ];

    const MC = {
      section: '_3nPmjq_section', title: '_3nPmjq_title', intro: '_3nPmjq_intro',
      rows: '_3nPmjq_rows', rowCard: '_3nPmjq_rowCard', rowHead: '_3nPmjq_rowHead',
      rowIdentity: '_3nPmjq_rowIdentity', rowName: '_3nPmjq_rowName', rowTag: '_3nPmjq_rowTag',
      credentialDot: '_3nPmjq_credentialDot', credentialDotConfigured: '_3nPmjq_credentialDotConfigured', credentialDotMissing: '_3nPmjq_credentialDotMissing',
      rowActions: '_3nPmjq_rowActions', secondaryButton: '_3nPmjq_secondaryButton', primaryButton: '_3nPmjq_primaryButton', dangerButton: '_3nPmjq_dangerButton',
      addBlock: '_3nPmjq_addBlock', addActions: '_3nPmjq_addActions', addButton: '_3nPmjq_addButton', addCard: '_3nPmjq_addCard',
      addModes: '_3nPmjq_addModes', addPanel: '_3nPmjq_addPanel', advancedHint: '_3nPmjq_advancedHint',
      editor: '_3nPmjq_editor', editorHeader: '_3nPmjq_editorHeader', editorTitle: '_3nPmjq_editorTitle', editorRoute: '_3nPmjq_editorRoute', editorActions: '_3nPmjq_editorActions',
      field: '_3nPmjq_field', fieldLabel: '_3nPmjq_fieldLabel', input: '_3nPmjq_input', selectInput: '_3nPmjq_selectInput',
      customized: '_3nPmjq_customized', customizedSummary: '_3nPmjq_customizedSummary', customizedBody: '_3nPmjq_customizedBody',
      modelCatalog: '_3nPmjq_modelCatalog', modelCatalogHeading: '_3nPmjq_modelCatalogHeading', modelCatalogTitle: '_3nPmjq_modelCatalogTitle', modelCatalogMeta: '_3nPmjq_modelCatalogMeta',
      modelList: '_3nPmjq_modelList', modelListHead: '_3nPmjq_modelListHead', modelEntry: '_3nPmjq_modelEntry', modelRow: '_3nPmjq_modelRow', modelEmpty: '_3nPmjq_modelEmpty',
      addModelButton: '_3nPmjq_addModelButton', iconButton: '_3nPmjq_iconButton', iconButtonDanger: '_3nPmjq_iconButtonDanger', linkButton: '_3nPmjq_linkButton',
      // 两列数字 + 尾部控件：沿用设置页里「推理深度的最小/最大」那一行
      modelReasoningRow: '_3nPmjq_modelReasoningRow',
      modelReasoningValueInput: '_3nPmjq_modelReasoningValueInput'
    };

    
const IMAGE_STORE_KEY = 'mo.dsh.image.v2';
    const IMAGE_LEGACY_KEY = 'mo.dsh.image';

    // 质量挡位 + 尺寸默认值：给选择器用，也作为工具未显式传参时的默认值。
    // 挡位和对话模型的思考等级保持一致的英文写法；Off 表示不把这个参数发给模型。
    const IMAGE_QUALITY_LEVELS = [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ];
    const IMAGE_DEFAULT_QUALITY = 'high';
    const IMAGE_MIN_SIDE = 64;
    const IMAGE_MAX_SIDE = 4096;

    function normalizeQuality(value) {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'medium') return 'high';   // 旧的三挡：中 → High
      if (raw === 'xhigh') return 'max';     // 旧的极高 → Max
      return IMAGE_QUALITY_LEVELS.some((item) => item.value === raw) ? raw : IMAGE_DEFAULT_QUALITY;
    }

    function qualityLabelOf(value) {
      const hit = IMAGE_QUALITY_LEVELS.find((item) => item.value === normalizeQuality(value));
      return hit ? hit.label : 'High';
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
        height: clampSide(height, 1024)
      };
    }

    function sizeLabelOf(defaults) {
      if (!defaults || defaults.auto) return 'Auto';
      return defaults.width + ' × ' + defaults.height;
    }

    function makeId() {
      return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function normalizeImageStore(raw) {
      const out = { providers: [], active: { providerId: '', model: '' }, defaults: normalizeDefaults(raw && raw.defaults) };
      if (!raw || typeof raw !== 'object') return out;
      if (Array.isArray(raw.providers)) {
        const seen = new Set();
        out.providers = raw.providers.map((p, i) => {
          const id = String(p.id || makeId());
          const models = Array.from(new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m || '').trim()).filter(Boolean)));
          const names = {};
          if (p.names && typeof p.names === 'object') {
            for (const model of models) {
              if (typeof p.names[model] === 'string') names[model] = p.names[model];
            }
          }
          return {
            id: id,
            name: String(p.name || ('地址 ' + (i + 1))),
            baseUrl: String(p.baseUrl || ''),
            key: String(p.key || ''),
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
          key: String(raw.key || ''), models: models
        };
        out.providers = [provider];
        out.active = { providerId: provider.id, model: models[0] || '' };
      }
      return out;
    }

    let imageStoreCache = { providers: [], active: { providerId: '', model: '' } };
    let imageStoreLoaded = false;

    async function loadImageStore() {
      try {
        const response = await fetch('/api/mo-image/config', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) return;
        imageStoreCache = normalizeImageStore(data.config);
        imageStoreLoaded = true;
        window.dispatchEvent(new Event('mo-image-config'));
      } catch (_error) { /* keep cache */ }
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

    function writeImageStore(store) {
      const next = normalizeImageStore(store);
      imageStoreCache = next;
      try { window.dispatchEvent(new Event('mo-image-config')); } catch (_error) { /* ignore */ }
      fetch('/api/mo-image/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: next })
      }).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.config) {
          imageStoreCache = normalizeImageStore(data.config);
          window.dispatchEvent(new Event('mo-image-config'));
        }
      }).catch(() => {});
      return next;
    }

    function readImageCfg() {
      return activeImageConfig(readImageStore());
    }

    function writeImageCfg(cfg) {
      if (!cfg || !cfg.baseUrl) return;
      const store = readImageStore();
      let provider = store.providers.find((p) => p.baseUrl === cfg.baseUrl && p.key === cfg.key) || store.providers.find((p) => p.baseUrl === cfg.baseUrl);
      if (!provider) {
        provider = { id: makeId(), name: '工作台配置', baseUrl: String(cfg.baseUrl), key: String(cfg.key || ''), models: [] };
        store.providers.push(provider);
      } else if (cfg.key) {
        provider.key = String(cfg.key);
      }
      if (cfg.model && !provider.models.includes(cfg.model)) provider.models.push(String(cfg.model));
      store.active = { providerId: provider.id, model: String(cfg.model || provider.models[0] || '') };
      writeImageStore(store);
    }

    function providerLabel(provider) {
      if (!provider) return '';
      const prefix = provider.name || '地址';
      return prefix;
    }

    function ImageProviderForm(props) {
      const isNew = !!props.isNew;
      const [draft, setDraft] = React.useState(() => ({
        id: props.provider.id,
        name: props.provider.name || '',
        baseUrl: props.provider.baseUrl || '',
        key: isNew ? (props.provider.key || '') : '',
        models: (props.provider.models || []).slice(),
        names: { ...(props.provider.names || {}) }
      }));
      const [advanced, setAdvanced] = React.useState(false);
      const [mode, setMode] = React.useState('catalog');
      const [presetId, setPresetId] = React.useState('openai');
      const addModel = () => {
        setDraft({ ...draft, models: draft.models.concat(''), names: { ...draft.names, '': '' } });
      };
      const field = (label, control) => h('div', { className: MC.field },
        h('label', { className: MC.fieldLabel }, label),
        control
      );
      const nameField = field('显示名称', h('input', { className: MC.input, value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }), placeholder: '显示名称' }));
      const urlField = field('API 地址', h('input', { className: MC.input, value: draft.baseUrl, onChange: (e) => setDraft({ ...draft, baseUrl: e.target.value }), placeholder: 'https://gateway.example/v1' }));
      const protocolField = field('API 协议', h('select', { className: MC.input + ' ' + MC.selectInput, value: 'openai-images', disabled: true }, h('option', { value: 'openai-images' }, 'OpenAI Images')));
      const keyField = field('API 密钥', h('input', { className: MC.input, type: 'password', value: draft.key, onChange: (e) => setDraft({ ...draft, key: e.target.value }), placeholder: isNew ? '输入 API 密钥' : (props.provider.key ? '留空使用已保存凭证' : '输入 API 密钥') }));
      const modelDirectory = h('div', { className: MC.modelCatalog },
        h('div', { className: MC.modelListHead },
          h('div', { className: MC.modelCatalogHeading },
            h('span', { className: MC.modelCatalogTitle }, '模型目录'),
            h('p', { className: MC.modelCatalogMeta }, draft.models.length ? '已自定义模型目录' : '正在使用适配器默认模型')
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
            draft.models.length ? h('button', { type: 'button', className: MC.linkButton, onClick: () => setDraft({ ...draft, models: [], names: {} }) }, '恢复默认模型') : null,
            h('button', { type: 'button', className: MC.linkButton, disabled: true, title: '需要提供商支持模型目录接口' }, '获取可用模型')
          )
        ),
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
              h('button', { type: 'button', className: MC.iconButton, title: '模型设置', 'aria-label': '模型设置' },
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
        ) : h('div', { className: MC.modelEmpty }, '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。'),
        h('button', { type: 'button', className: MC.addModelButton, onClick: addModel },
          IconPlus ? h(IconPlus, { size: 14 }) : null,
          '添加模型'
        )
      );
      const actions = h('div', { className: MC.editorActions },
        h('button', { type: 'button', className: MC.secondaryButton, onClick: props.onClose }, '取消'),
        h('button', { type: 'button', className: MC.primaryButton, onClick: () => props.onSave({ ...draft, key: draft.key.trim() || (props.provider.key || '') }) }, '保存')
      );
      if (isNew) {
        const modes = DshSegmentedControl
          ? h(DshSegmentedControl, {
              id: 'mo-image-add-mode',
              label: '添加方式',
              value: mode,
              options: [
                { value: 'catalog', label: '第三方模型提供商' },
                { value: 'custom', label: '自定义模型 API' }
              ],
              onChange: (next) => setMode(next)
            })
          : h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-1)' } },
              ['catalog', 'custom'].map((value) => h('button', {
                key: value, type: 'button', onClick: () => setMode(value),
                style: { height: 28, padding: '0 12px', border: value === mode ? '.5px solid var(--dsw-alias-border-l3)' : 0, borderRadius: 'var(--dsw-radius-md)', background: value === mode ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: value === mode ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }
              }, value === 'catalog' ? '第三方模型提供商' : '自定义模型 API'))
            );
        const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === presetId) || IMAGE_PROVIDER_PRESETS[0];
        const choosePreset = (id) => {
          const next = IMAGE_PROVIDER_PRESETS.find((p) => p.id === id) || IMAGE_PROVIDER_PRESETS[0];
          setPresetId(next.id);
          setDraft({ ...draft, name: next.name, baseUrl: next.baseUrl });
        };
        const catalogBody = h(React.Fragment, null,
          field('提供商', h('select', {
            className: MC.input + ' ' + MC.selectInput,
            value: presetId,
            onChange: (e) => choosePreset(e.target.value)
          }, IMAGE_PROVIDER_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
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
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { className: MC.addModes },
            modes,
            h('p', { className: MC.advancedHint }, mode === 'catalog' ? '从内置目录中选择 OpenAI、火山方舟、阿里云百炼等官方或大型模型平台，填入其 API 密钥即可使用。' : '接入自部署或其他兼容 OpenAI Images 的接口。')
          ),
          mode === 'catalog' ? catalogBody : customBody,
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
      const [store, setStore] = React.useState(readImageStore);
      const [edit, setEdit] = React.useState(null);
      React.useEffect(() => {
        const sync = () => setStore(readImageStore());
        window.addEventListener('mo-image-config', sync);
        window.addEventListener('storage', sync);
        if (!imageStoreLoaded) loadImageStore();
        return () => {
          window.removeEventListener('mo-image-config', sync);
          window.removeEventListener('storage', sync);
        };
      }, []);
      const save = (provider) => {
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
        h('p', { className: MC.intro }, '填入各提供商的 API 密钥即可使用其生图模型。'),
        h('ul', { className: MC.rows },
          store.providers.map((provider) => {
            const ready = !!(provider.baseUrl && provider.key && provider.models.length);
            const editing = edit && !edit.isNew && edit.provider.id === provider.id;
            return h('li', { className: MC.rowCard, key: provider.id },
              h('div', { className: MC.rowHead },
                h('span', { className: MC.rowIdentity },
                  h('span', { className: MC.rowName }, provider.name || '未命名提供商'),
                  h('span', { className: MC.rowTag }, '自定义'),
                  h('span', {
                    className: MC.credentialDot + ' ' + (ready ? MC.credentialDotConfigured : MC.credentialDotMissing),
                    title: ready ? '可用' : '缺少 API 地址 / 密钥 / 模型',
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
                h('button', { type: 'button', className: MC.addButton, onClick: () => setEdit({ provider: { id: makeId(), name: '', baseUrl: '', key: '', models: [] }, isNew: true }) }, '+ 添加模型提供商')
              )
        )
      );
    }

    const MS = {
      root: 'wq12jW_root',
      trigger: 'wq12jW_trigger',
      triggerIcon: 'wq12jW_triggerIcon',
      triggerLabel: 'wq12jW_triggerLabel',
      triggerEffort: 'wq12jW_triggerEffort',
      chevron: 'wq12jW_chevron',
      chevronOpen: 'wq12jW_chevronOpen',
      menu: 'wq12jW_menu',
      searchRow: 'wq12jW_searchRow',
      search: 'wq12jW_search',
      searchWithQuery: 'wq12jW_searchWithQuery',
      searchClear: 'wq12jW_searchClear',
      groups: 'wq12jW_groups',
      option: 'wq12jW_option',
      modelOption: 'wq12jW_modelOption',
      optionActive: 'wq12jW_optionActive',
      optionCopy: 'wq12jW_optionCopy',
      modelName: 'wq12jW_modelName',
      check: 'wq12jW_check',
      selected: 'wq12jW_selected',
      empty: 'wq12jW_empty',
      cell: 'wq12jW_cell',
      cellLabel: 'wq12jW_cellLabel',
      cellValue: 'wq12jW_cellValue',
      cellChevron: 'wq12jW_cellChevron'
    };

    function ImageModelSeat() {
      const [store, setStore] = React.useState(readImageStore);
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
      React.useEffect(() => {
        const sync = () => setStore(readImageStore());
        window.addEventListener('mo-image-config', sync);
        if (!imageStoreLoaded) loadImageStore();
        return () => window.removeEventListener('mo-image-config', sync);
      }, []);
      const closeMenu = React.useCallback(() => {
        setOpen(false);
        setPanel('home');
        setQuery('');
      }, []);
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
        if (!open || panel !== 'model') return undefined;
        const timer = setTimeout(() => { try { searchRef.current && searchRef.current.focus(); } catch (_error) { /* ignore */ } }, 30);
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
          let y = rect.top - 8 - lh;
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
            if (!q || model.toLowerCase().includes(q)) flat.push({ providerId: provider.id, model });
          }
        }
        const selected = flat.findIndex((item) => item.providerId === store.active.providerId && item.model === store.active.model);
        setActiveIndex(selected >= 0 ? selected : (flat.length ? 0 : -1));
      }, [open, panel, query, store]);
      const defaults = store.defaults || normalizeDefaults(null);
      const active = activeImageConfig(store);
      const qualityLabel = qualityLabelOf(defaults.quality);
      const saveDefaults = (patch) => {
        const next = writeImageStore({ ...store, defaults: { ...defaults, ...patch } });
        setStore(next);
      };
      const choose = (providerId, model) => {
        const next = writeImageStore({ ...store, active: { providerId: providerId, model: model } });
        setStore(next);
        closeMenu();
      };
      const q = query.trim().toLowerCase();
      const visible = store.providers.map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => !q || model.toLowerCase().includes(q))
      })).filter((provider) => provider.models.length > 0);
      const triggerLabel = active.model || '生图模型';
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
        cellRow('model', '模型', active.model || '未选择', () => setPanel('model')),
        cellRow('quality', '质量', qualityLabel, () => setPanel('quality')),
        cellRow('size', '尺寸', sizeLabelOf(defaults), () => setPanel('size'))
      ];
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
              return h('button', {
                key: model, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
                className: MS.option + ' ' + MS.modelOption + (selected ? ' ' + MS.selected : '') + (highlighted ? ' ' + MS.optionActive : ''),
                'data-highlighted': highlighted ? '' : undefined,
                onMouseMove: () => setActiveIndex(index),
                onMouseEnter: () => setActiveIndex(index),
                onFocus: () => setActiveIndex(index),
                onClick: () => choose(provider.id, model),
                title: model
              },
                h('span', { className: MS.optionCopy },
                  h('span', { className: MS.modelName }, model)
                ),
                checkMark(selected)
              );
            })
          )) : h('div', { className: MS.empty }, query ? '没有匹配的模型' : '还没有模型，去设置 → 生图模型添加')
        )
      ];
      const qualityPanel = [
        h('div', { key: 'quality', className: MS.groups + ' scrollable', role: 'menu', 'aria-label': '质量' },
          IMAGE_QUALITY_LEVELS.map((level) => h('button', {
            key: level.value, type: 'button', role: 'menuitemradio',
            'aria-checked': defaults.quality === level.value,
            className: MS.option + (defaults.quality === level.value ? ' ' + MS.selected : ''),
            onClick: () => { saveDefaults({ quality: level.value }); closeMenu(); }
          },
            h('span', { className: MS.optionCopy },
              h('span', { className: MS.modelName }, level.label)
            ),
            checkMark(defaults.quality === level.value)
          ))
        )
      ];
      const panelBody = panel === 'model' ? modelPanel
        : panel === 'quality' ? qualityPanel
        : panel === 'size' ? sizePanel
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
          title: active.model || '选择生图模型',
          'aria-label': active.model ? '生图模型：' + active.model + '，质量 ' + qualityLabel : '选择生图模型',
          'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-controls': open ? 'mo-image-model-menu' : undefined
        },
          h('svg', { className: MS.triggerIcon, viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 2.2, y: 2.75, width: 11.6, height: 10.5, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.25 }),
            h('circle', { cx: 5.7, cy: 6.2, r: 1, stroke: 'currentColor', strokeWidth: 1.25 }),
            h('path', { d: 'M2.8 11.6l3.2-3.1 2.1 2.1 2.5-2.8 2.6 3.2', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' })),
          h('span', { className: MS.triggerLabel }, triggerLabel),
          h('span', { className: MS.triggerEffort }, qualityLabel),
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
        const mark = () => {
          const panel = document.querySelector('[data-shortcut-modal="settings"]');
          if (!panel) return;
          const buttons = panel.querySelectorAll('.wCInkW_navList button, [class*="navList"] button');
          for (const button of buttons) {
            const label = button.querySelector('.wCInkW_navLabel, [class*="navLabel"]');
            if (label && label.textContent.trim() === '生图模型') button.setAttribute('data-mo-image-nav', '');
          }
        };
        const observer = new MutationObserver(mark);
        observer.observe(document.body, { childList: true, subtree: true });
        mark();
        return () => {
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
