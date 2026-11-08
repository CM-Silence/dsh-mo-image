/**
 * 代理发现：把「环境变量」和「Windows 系统代理」翻译成一个可用的 HTTP 代理地址。
 *
 * 这里只做纯解析，不发请求、不读注册表；读系统代理由 readSystemProxy() 单独负责，
 * 便于单元测试注入。Windows/WinINET 的设置 Node 自己永远不会用到，必须显式读出来。
 */
import { execFile } from 'node:child_process';

const SUPPORTED = new Set(['http:', 'https:']);

/** 只有「明文 HTTP 代理」这条路在本插件里实现了（CONNECT 隧道）；SOCKS 明确不支持。 */
function normalizeProxySpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw;
  let url;
  try { url = new URL(withScheme); } catch (_error) { return undefined; }
  if (url.protocol !== 'http:') return undefined;
  if (!url.hostname) return undefined;
  const auth = url.username
    ? encodeURIComponent(decodeURIComponent(url.username)) + ':' + encodeURIComponent(decodeURIComponent(url.password || '')) + '@'
    : '';
  return 'http://' + auth + url.host;
}

/**
 * 解析系统代理串。Windows 会写成 `127.0.0.1:7897`，
 * 也可能写成 `http=127.0.0.1:7897;https=127.0.0.1:7897`。
 */
export function parseProxyServer(value) {
  const text = String(value || '').trim();
  if (!text) return { http: undefined, https: undefined };
  if (!text.includes('=')) {
    const single = normalizeProxySpec(text);
    return { http: single, https: single };
  }
  const result = { http: undefined, https: undefined };
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const scheme = part.slice(0, index).trim().toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') continue;   // socks= 直接忽略
    const spec = normalizeProxySpec(part.slice(index + 1));
    if (spec) result[scheme] = spec;
  }
  return result;
}

/** 绕过列表：`;`/`,`/空白分隔；`*` 通配、`.suffix` 后缀、`<local>` 无点主机名。 */
export function parseBypassList(value) {
  const raw = Array.isArray(value) ? value.join(';') : String(value || '');
  const out = [];
  for (const item of raw.split(/[;,\s]+/)) {
    const entry = item.trim().toLowerCase();
    if (entry) out.push(entry);
  }
  return out;
}

function bareHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

export function isLoopbackHost(host) {
  const value = bareHost(host);
  if (!value) return false;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value === '::1' || value === '0.0.0.0') return true;
  const parts = value.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    return Number(parts[0]) === 127;
  }
  return false;
}

export function hostMatchesBypass(host, list) {
  const value = bareHost(host);
  if (!value) return false;
  for (const rawEntry of Array.isArray(list) ? list : parseBypassList(list)) {
    let entry = String(rawEntry || '').trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('*') === false && /^[^:]+:\d+$/.test(entry)) entry = entry.replace(/:\d+$/, '');
    if (entry === '*') return true;
    if (entry === '<local>') {
      if (value.startsWith('::1')) return true;
      if (!value.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(value) && !value.includes(':')) return true;
      continue;
    }
    const suffix = entry.startsWith('.') ? entry.slice(1)
      : entry.startsWith('*.') ? entry.slice(2)
        : '';
    if (suffix) {
      if (value === suffix || value.endsWith('.' + suffix)) return true;
      continue;
    }
    if (entry.includes('*')) {
      const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp('^' + pattern + '$').test(value)) return true;
      continue;
    }
    if (value === entry) return true;
  }
  return false;
}

function pickFromEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 决定「这个 URL 该不该走代理、走哪个」。
 * 优先级：显式覆盖(MO_IMAGE_PROXY) > 环境变量(HTTPS_PROXY/HTTP_PROXY/ALL_PROXY) > 系统代理。
 * 回环地址永远直连——本地部署的适配器（A1111/ComfyUI/…）不能被塞进代理。
 *
 * @returns {{ proxyUrl: string|null, source: 'override'|'env'|'system'|null, reason: string }}
 */
export function resolveProxyForTarget(target, options = {}) {
  const env = options.env || process.env;
  const systemProxy = options.systemProxy === undefined ? null : options.systemProxy;

  let url;
  try { url = new URL(String(target || '')); } catch (_error) {
    return { proxyUrl: null, source: null, reason: 'invalid-url' };
  }
  if (!SUPPORTED.has(url.protocol)) return { proxyUrl: null, source: null, reason: 'unsupported-protocol' };

  const host = bareHost(url.hostname);
  if (isLoopbackHost(host)) return { proxyUrl: null, source: null, reason: 'loopback' };

  const override = String(env.MO_IMAGE_PROXY || '').trim();
  if (override) {
    if (/^(off|none|false|0|direct)$/i.test(override)) return { proxyUrl: null, source: null, reason: 'disabled' };
    const url2 = normalizeProxySpec(override);
    if (url2) return { proxyUrl: url2, source: 'override', reason: 'override' };
  }

  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const noProxy = pickFromEnv(env, ['NO_PROXY', 'no_proxy']);
  if (noProxy && hostMatchesBypass(host, parseBypassList(noProxy))) {
    return { proxyUrl: null, source: null, reason: 'bypass' };
  }

  const envProxy = scheme === 'https'
    ? pickFromEnv(env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])
    : pickFromEnv(env, ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']);
  if (envProxy) {
    const parsed = normalizeProxySpec(envProxy);
    if (parsed) return { proxyUrl: parsed, source: 'env', reason: 'env' };
  }

  if (systemProxy) {
    const candidate = scheme === 'https' ? systemProxy.https : systemProxy.http;
    if (candidate) {
      const bypass = Array.isArray(systemProxy.bypass) ? systemProxy.bypass : parseBypassList(systemProxy.bypass);
      if (hostMatchesBypass(host, bypass)) return { proxyUrl: null, source: null, reason: 'bypass' };
      return { proxyUrl: candidate, source: 'system', reason: 'system' };
    }
  }

  return { proxyUrl: null, source: null, reason: 'none' };
}

const SYSTEM_PROXY_TTL_MS = 30000;
let systemProxyCache = { at: 0, value: null };

export function resetSystemProxyCache() {
  systemProxyCache = { at: 0, value: null };
}

function readRegistryValue(text, name) {
  const pattern = new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'im');
  const match = pattern.exec(text);
  return match ? match[1].trim() : '';
}

/**
 * 读 Windows 的「系统代理」（WinINET）。Node 不会自动用它，所以必须自己来。
 * reg.exe 会被缓存，避免每次请求都起进程。
 *
 * 任何失败都只能退化成 null（直连）：探测代理这件事永远不能把请求本身搞挂。
 */
export async function readSystemProxy(options = {}) {
  const platform = options.platform || process.platform;
  const now = Date.now();
  if (!options.noCache && now - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) return systemProxyCache.value;

  let value = null;
  if (platform === 'win32') {
    const run = typeof options.run === 'function' ? options.run : execFile;
    try {
      value = await new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        try {
          run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
            { windowsHide: true, timeout: 5000, encoding: 'buffer' },
            (error, stdout) => {
              if (error || !stdout) { done(null); return; }
              try {
                const text = Buffer.from(stdout).toString('latin1');
                const enabled = readRegistryValue(text, 'ProxyEnable');
                if (!/^(0x)?1$/i.test(enabled)) { done(null); return; }
                const server = parseProxyServer(readRegistryValue(text, 'ProxyServer'));
                if (!server.http && !server.https) { done(null); return; }
                done({
                  http: server.http,
                  https: server.https,
                  bypass: parseBypassList(readRegistryValue(text, 'ProxyOverride'))
                });
              } catch (_error) { done(null); }
            });
        } catch (_error) {
          // 沙箱/受限环境里 spawn 可能同步抛 EPERM：直接当成「没有系统代理」。
          done(null);
        }
        setTimeout(() => done(null), 5000).unref?.();
      });
    } catch (_error) {
      value = null;
    }
  }
  systemProxyCache = { at: now, value: value };
  return value;
}
