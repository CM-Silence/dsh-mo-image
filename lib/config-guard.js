/**
 * 工具守卫：把「生图配置只能由用户改」从提示词约束升级成执行层拦截。
 *
 * 通过 ctx.tools.guard() 注册到宿主，任何工具调用只要“目标”指向插件配置文件
 * 或配置接口，就在调度阶段被拒（不是提示词劝告）。
 *
 * 只看目标字段（路径 / URL / 命令行），不在正文里误伤：例如修改插件源码时，
 * 新代码里出现 '/api/mo-image/config' 不应该被拦。
 *
 * 注意：这是参数级匹配，刻意混淆的 shell 命令（base64、字符串拼接）拦不住；
 * 真正的硬边界仍然是宿主给不给这个 Agent 开 shell。
 */
const CONFIG_TARGET = /(?:^|[^a-z0-9_-])mo-image[\\/]+config\.json(?![a-z0-9_-])|\/api\/mo-image\/config(?![a-z0-9_-])/i;

const TARGET_FIELDS = ['path', 'file_path', 'filePath', 'files', 'url', 'command', 'cmd', 'script', 'target', 'cwd'];

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

/** @returns {string|undefined} 返回字符串即拒绝该工具调用。 */
export function configWriteReason(args) {
  if (!args || typeof args !== 'object') return undefined;
  for (const field of TARGET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(args, field) && hits(args[field])) return CONFIG_GUARD_REASON;
  }
  return undefined;
}
