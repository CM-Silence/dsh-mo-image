/**
 * 只读状态契约：给其它插件（当前是 dsh-mo-workbench）一份固定的“生图现在能不能用”快照。
 *
 * 为什么要有这个文件：工作台以前自己读 config.json、自己解析凭据库、还用模型名去猜
 * “有没有编辑模型”。这些都随 mo-image 的配置结构和适配器能力变化，且 0.6 已经没有
 * 独立编辑模型。把判断收回到插件内部，外部只消费这个形状。
 *
 * 纯函数，不发请求、不写配置；凭据由调用方（index.js）解析后以 key 传入。
 */
import { adapterSupportsKind, resolveAdapter, sizeSpecFor } from './adapters.js';

export const STATUS_CONTRACT = 1;
/** mo-image 工具一次最多接受的参考图数量（与 lib/index.js 的 MAX_REF_COUNT 对齐）。 */
export const MAX_REFS = 16;

function adapterFor(provider, model) {
  try { return resolveAdapter(provider, model); } catch (_error) { return null; }
}

/**
 * 当前模型能不能图生图。
 * - ComfyUI 由工作流决定：自定义工作流必须带 {{image}} 或 image 映射；内置工作流可以。
 * - 异步入队型看 async.edit；普通适配器看 endpoints.edit。
 */
export function canEditModel(provider, model, adapter) {
  if (!adapter) return false;
  if (adapter.id === 'comfyui') {
    const entry = provider && provider.modelOptions ? provider.modelOptions[model] : null;
    const workflow = String(entry?.workflow || '');
    if (!workflow) return true;
    const hasSlot = /\{\{\s*image\s*\}\}/.test(workflow);
    const mapped = Boolean(entry.mapping && entry.mapping.image);
    return hasSlot || mapped;
  }
  const edit = adapter.operations?.edit;
  if (edit?.fields?.image === null || edit?.fields?.image === false
      || (edit?.input === 'explicit' && !edit.fields?.image)) return false;
  if (adapter.async && typeof adapter.async === 'object') return Boolean(adapter.async.edit);
  return adapterSupportsKind(adapter, 'edit');
}

/**
 * 与 buildImageStatus 分开导出，方便 Auto 选模型时复用同一套判断。
 * 顺序保持提供商模型列表的顺序。
 */
export function editCapableModels(provider, models) {
  return (Array.isArray(models) ? models : []).filter((model) => canEditModel(provider, model, adapterFor(provider, model)));
}

/**
 * Auto 模式改图选模型：没传就取第一个可图生图的；传了但不可图生图就返回空，
 * 由调用方给出“可改图的模型有哪些”的错误。
 */
export function pickAutoEditModel(provider, models, requested) {
  const capable = editCapableModels(provider, models);
  const wanted = String(requested || '').trim();
  if (wanted) return { model: capable.includes(wanted) ? wanted : '', capable };
  return { model: capable[0] || '', capable };
}

/**
 * 把 DSH 凭据服务的 source 归一到契约里的四种：
 * optional / credentials / env / config。
 * credentials.describe() 实际会报 `file`（凭据文件）、keychain、process 等实现细节，
 * 外部插件不该依赖这些存储后端名字。
 */
export function normalizeKeySource(source) {
  const raw = String(source || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'optional') return 'optional';
  if (raw === 'config') return 'config';
  if (raw === 'env' || raw === 'environment' || raw === 'process') return 'env';
  return 'credentials';
}

function keyText(source) {
  if (source === 'optional') return '本地模型，无需 API Key';
  if (source === 'credentials') return 'Key 来源：DSH 凭据库';
  if (source === 'env') return 'Key 来源：环境变量';
  return 'Key 来源：配置文件';
}

function messageOf(view) {
  const { provider, providerName, hasBaseUrl, key, auto, models, model, configured } = view;
  if (!provider) return '还没有选择生图提供商。请到 DSH 设置 → 生图模型 添加提供商、模型和 API Key。';
  if (!hasBaseUrl) return '生图提供商「' + providerName + '」缺少 Base URL，请到 DSH 设置 → 生图模型 补上。';
  if (!key.ok) {
    return '生图提供商「' + providerName + '」的 API Key 没找到'
      + (key.ref ? '（凭据库里没有 ' + key.ref + '，环境变量也没设）' : '（配置里没有 apiKeyEnv）')
      + '。请到 DSH 设置 → 生图模型 重新填一次 Key 并保存。';
  }
  if (auto && !models.length) return '生图提供商「' + providerName + '」还没有模型 ID，请到 DSH 设置 → 生图模型添加并选择模型。';
  if (!auto && !model) return '生图提供商已就绪，但当前没有选中模型（或选中的模型不在模型列表里）。请到 DSH 设置 → 生图模型 选一个模型。';
  if (!configured) return '生图模型还没有配置完整，请到 DSH 设置 → 生图模型检查。';
  return '生图模型可用：' + providerName + ' / '
    + (auto ? 'Auto（' + models.length + ' 个可选模型）' : model)
    + '（' + keyText(key.source) + '）';
}

/**
 * @param {object} input
 * @param {object} input.config 已归一化的 mo-image 配置
 * @param {string} [input.version] 插件版本号
 * @param {{ok:boolean, source:string, ref:string}} [input.key] 凭据解析结果
 */
export function buildImageStatus(input) {
  const config = input && input.config && typeof input.config === 'object' ? input.config : {};
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const active = config.active && typeof config.active === 'object' ? config.active : {};
  const provider = providers.find((item) => item && item.id === active.providerId) || null;
  const models = provider && Array.isArray(provider.models)
    ? provider.models.map((model) => String(model || '').trim()).filter(Boolean)
    : [];
  const wanted = String(active.model || '').trim();
  const auto = wanted === 'auto';
  const model = provider && (auto || models.includes(wanted)) ? wanted : '';
  const adapter = provider && model && !auto ? adapterFor(provider, model) : null;
  const key = {
    ok: Boolean(input && input.key && input.key.ok),
    source: String((input && input.key && input.key.source) || ''),
    ref: String((input && input.key && input.key.ref) || '')
  };
  const hasBaseUrl = Boolean(provider && String(provider.baseUrl || '').trim());
  const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};
  const sizeMode = defaults.auto === false ? 'fixed' : 'auto';
  const promptOptimization = defaults.promptOptimization !== false;
  const configured = Boolean(provider && hasBaseUrl && key.ok && (auto ? models.length > 0 : Boolean(model)));
  // Auto 下“能改图”的意思是至少有一个候选能改图，editModels 就是可选项；
  // 固定模型下只有当前这一张能选，所以 editModels 要么是它、要么为空。
  const capable = provider ? editCapableModels(provider, models) : [];
  const fixedCanEdit = Boolean(model && canEditModel(provider, model, adapter));
  const editModels = auto ? capable : (fixedCanEdit ? [model] : []);
  const edit = auto ? capable.length > 0 : fixedCanEdit;
  const providerName = provider ? String(provider.name || provider.id || '') : '';
  return {
    contract: STATUS_CONTRACT,
    version: String((input && input.version) || '0.0.0'),
    ready: configured,
    configured,
    missing: !provider ? 'provider'
      : !hasBaseUrl ? 'baseUrl'
        : !key.ok ? 'key'
          : auto ? (models.length > 0 ? '' : 'model')
            : !model ? 'model' : '',
    message: messageOf({ provider, providerName, hasBaseUrl, key, auto, models, model, configured }),
    providers: providers.length,
    provider: provider ? {
      id: String(provider.id || ''),
      name: providerName,
      baseUrl: String(provider.baseUrl || ''),
      optionalKey: Boolean(provider.optionalKey),
      protocol: String(provider.protocol || ''),
      adapter: String((adapter && adapter.id) || provider.adapter || '')
    } : null,
    model,
    auto,
    models,
    promptOptimization,
    defaults: {
      quality: String(defaults.quality || 'high'),
      auto: defaults.auto !== false,
      width: Number(defaults.width) || 1024,
      height: Number(defaults.height) || 1024,
      aspect: String(defaults.aspect || ''),
      tier: String(defaults.tier || ''),
      preset: String(defaults.preset || ''),
      strict: defaults.strict === true
    },
    key,
    capabilities: {
      generate: Boolean(provider && (auto ? models.length > 0 : Boolean(adapter))),
      edit: Boolean(provider && edit),
      editModels,
      maxRefs: MAX_REFS,
      size: Object.assign(
        { mode: sizeMode, strict: defaults.strict === true },
        sizeMode === 'fixed'
          ? {
            width: Number(defaults.width) || 1024,
            height: Number(defaults.height) || 1024,
            aspect: String(defaults.aspect || ''),
            tier: String(defaults.tier || ''),
            preset: String(defaults.preset || '')
          }
          : {},
        adapter ? { control: sizeSpecFor(provider, model, adapter).control } : {}
      )
    }
  };
}
