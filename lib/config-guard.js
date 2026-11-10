/**
 * 工具守卫：把「生图配置只能由用户改」从提示词约束升级成执行层拦截。
 *
 * 通过 ctx.tools.guard() 注册到宿主，任何工具调用只要“目标”指向插件配置文件
 * 或配置接口，就在调度阶段被拒（不是提示词劝告）。
 *
 * 只拦写入：只读工具（read / grep / glob / read_image）可以照常读配置，
 * 想看有哪些模型时读得到；写入和 shell 仍然被拒。shell 里区分「读」和「写」
 * 不可靠（重定向、管道、编码都绕得过去），所以命令一律按写入处理。
 *
 * 只看目标字段（路径 / URL / 命令行），不在正文里误伤：例如修改插件源码时，
 * 新代码里出现 '/api/mo-image/config' 不应该被拦。
 *
 * 注意：这是参数级匹配，刻意混淆的 shell 命令（base64、字符串拼接）拦不住；
 * 真正的硬边界仍然是宿主给不给这个 Agent 开 shell。
 */
const CONFIG_TARGET = /(?:^|[^a-z0-9_-])mo-image[\\/]+config\.json(?![a-z0-9_-])|\/api\/mo-image\/config(?![a-z0-9_-])/i;

const TARGET_FIELDS = ['path', 'file_path', 'filePath', 'files', 'url', 'command', 'cmd', 'script', 'target', 'cwd'];

/** 只读工具：读配置不算修改，放行。 */
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'grep', 'glob']);

export const CONFIG_GUARD_REASON = '生图配置只能由用户在该插件的设置页修改（dsh-mo-image 已拦截对配置的写入）。';

function normalize(text) {
  return String(text || '').replace(/\\\\/g, '\\').replace(/\\/g, '/');
}

function hits(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return CONFIG_TARGET.test(normalize(value));
  if (Array.isArray(value)) return value.some((item) => hits(item));
  if (typeof value === 'object') return Object.keys(value).some((key) => hits(value[key]));
  return false;
}

/**
 * @param {unknown} args 工具参数
 * @param {string} [toolName] 工具名；只读工具放行，缺省按写入处理
 * @returns {string|undefined} 返回字符串即拒绝该工具调用。
 */
export function configWriteReason(args, toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (name && READ_ONLY_TOOLS.has(name)) return undefined;
  if (!args || typeof args !== 'object') return undefined;
  for (const field of TARGET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(args, field) && hits(args[field])) return CONFIG_GUARD_REASON;
  }
  return undefined;
}
