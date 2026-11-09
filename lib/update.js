/**
 * 更新检查的纯函数：版本比较、tag 解析、安装来源分类、标记文件判定，
 * 以及从 GitHub 读最新 Release。没有状态、没有定时器，方便单测。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REPO = 'CM-Silence/dsh-mo-image';
export const NPM_NAME = 'dsh-mo-image';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
  const match = SEMVER.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : []
  };
}

/** semver 预发布比较：标识符按数字/字符串分开比，数字段小于递增 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

/**
 * 比较两个版本号。
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null} 解析不了时返回 null
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * 把 Release 的 tag 变成版本号：'v0.4.0' → '0.4.0'；不像版本号时返回空串。
 * @param {string} tag
 * @returns {string}
 */
export function tagToVersion(tag) {
  const match = SEMVER.exec(String(tag == null ? '' : tag).trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}${match[4] ? '-' + match[4] : ''}` : '';
}

/**
 * profile 里记录的安装形式：本地链接、git、tarball 还是看不出来。
 * @param {string|undefined} source
 * @returns {'link'|'git'|'tarball'|'unknown'}
 */
export function classifySource(source) {
  const value = String(source == null ? '' : source).trim();
  if (!value) return 'unknown';
  if (/^(link|file):/i.test(value)) return 'link';
  if (/\.(?:tar\.gz|tgz)(?:[?#].*)?$/i.test(value)) return 'tarball';
  if (/^(?:github|git|git\+https?|git\+ssh):/i.test(value) || /^https?:\/\/[^/]+\/[^/]+\/[^/]+(?:\.git)?(?:[?#].*)?$/i.test(value)) return 'git';
  return 'unknown';
}

/**
 * 用标记文件 + 当前版本判断更新结果。
 * @param {{from?: string, to?: string, startedAt?: number}|null} marker
 * @param {string} currentVersion
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {{state: 'none'|'done'|'updating'|'failed', to?: string}}
 */
export function judgeMarker(marker, currentVersion, now, ttlMs = 90_000) {
  if (!marker || typeof marker !== 'object') return { state: 'none' };
  const to = typeof marker.to === 'string' ? marker.to : '';
  const from = typeof marker.from === 'string' ? marker.from : '';
  if (!to) return { state: 'none' };
  if (currentVersion === to) return { state: 'done', to };
  // 版本既不是旧的也不是新的：用户自己装了别的版本，这枚标记已经没有意义。
  // 静默清掉，不要弹"已更新到 X"。
  if (currentVersion !== from) return { state: 'stale' };
  const startedAt = Number(marker.startedAt) || 0;
  return now - startedAt > ttlMs ? { state: 'failed', to } : { state: 'updating', to };
}

/**
 * 读标记文件；不存在或内容坏了都当成没有。
 * @param {string} file
 * @returns {object|null}
 */
export function readMarker(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.to !== 'string' || !parsed.to) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

/**
 * 写标记文件：先写 .tmp 再 rename，避免进程中途被杀留下半截 JSON。
 * @param {string} file
 * @param {{from: string, to: string, requestId?: string, startedAt?: number}} marker
 */
export function writeMarker(file, marker) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** 删除标记文件；不存在也不报错。 */
export function clearMarker(file) {
  try { unlinkSync(file); } catch (_error) { /* 已经没了 */ }
}

/** alpha / beta 版本只给内部验证用：发版时它们被标成 GitHub 的 prerelease。 */
export function isHiddenPrerelease(version) {
  return /-(?:a|b)\d+$/i.test(String(version || '').trim());
}

/** 读版本号时依次尝试的 registry：官方源，再退国内镜像。 */
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

/** 读 CHANGELOG 时依次尝试的 CDN（都按版本取包内文件）。 */
export const DEFAULT_CDN_SOURCES = [
  (version) => `https://cdn.jsdelivr.net/npm/${NPM_NAME}@${version}/CHANGELOG.md`,
  (version) => `https://unpkg.com/${NPM_NAME}@${version}/CHANGELOG.md`,
  (version) => `https://registry.npmmirror.com/${NPM_NAME}/${version}/files/CHANGELOG.md`
];

/**
 * 从 CHANGELOG 里抠出某个版本的小节。
 * @param {string} markdown
 * @param {string} version 例如 0.4.2 / v0.4.2
 * @returns {string} 找不到时返回空串
 */
export function parseChangelogSection(markdown, version) {
  const wanted = String(version || '').trim().replace(/^v/i, '');
  if (!wanted) return '';
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^##\s+v?(\S+)\s*$/.exec(lines[i].trim());
    if (match && match[1] === wanted) { start = i + 1; break; }
  }
  if (start < 0) return '';
  const section = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    section.push(lines[i]);
  }
  return section.join('\n').trim();
}

/**
 * 读 npm 上的最新版本。`/latest` 只指向 latest dist-tag，所以 rc 发到 next
 * 时天然不会被这里看到。
 * @param {{registryBase?: string, mirrorBase?: string, request?: Function, timeoutMs?: number, onError?: Function}} options
 * @returns {Promise<{version: string, url: string}|null>}
 */
export async function fetchLatestVersion(options = {}) {
  const request = typeof options.request === 'function' ? options.request : fetch;
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const registries = [
    String(options.registryBase || REGISTRIES[0]).replace(/\/+$/, ''),
    String(options.mirrorBase || REGISTRIES[1]).replace(/\/+$/, '')
  ];
  const reasons = [];
  for (const base of registries) {
    try {
      const response = await request(`${base}/${NPM_NAME}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response && response.ok) {
        const data = await response.json();
        const version = tagToVersion(data && data.version);
        if (version && !isHiddenPrerelease(version)) {
          return { version, url: `https://www.npmjs.com/package/${NPM_NAME}/v/${version}` };
        }
        reasons.push(`${base}: no usable version`);
      } else {
        reasons.push(`${base}: HTTP ${response ? response.status : 'nothing'}`);
      }
    } catch (error) {
      reasons.push(`${base}: ${String(error && error.message ? error.message : error)}`);
    }
  }
  if (typeof options.onError === 'function') {
    try { options.onError(reasons.join('; ')); } catch (_error) { /* 日志回调不该影响结果 */ }
  }
  return null;
}

/**
 * 读某个版本的更新说明。来源是包里的 CHANGELOG.md，按 CDN 依次尝试；
 * 拿不到就返回空串（界面显示"暂无更新说明"）。
 * @param {string} version
 * @param {{request?: Function, timeoutMs?: number, cdnSources?: Function[]}} options
 * @returns {Promise<string>}
 */
export async function fetchChangelogNotes(version, options = {}) {
  const request = typeof options.request === 'function' ? options.request : fetch;
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const sources = Array.isArray(options.cdnSources) && options.cdnSources.length
    ? options.cdnSources
    : DEFAULT_CDN_SOURCES;
  for (const build of sources) {
    try {
      const response = await request(build(version), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response || !response.ok) continue;
      const text = await response.text();
      const section = parseChangelogSection(text, version);
      if (section) return section;
    } catch (_error) { /* 换下一个 CDN */ }
  }
  return '';
}
