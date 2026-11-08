/**
 * 更新检查的纯函数：版本比较、tag 解析、安装来源分类、标记文件判定，
 * 以及从 GitHub 读最新 Release。没有状态、没有定时器，方便单测。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REPO = 'CM-Silence/dsh-mo-image';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PLACEHOLDER = /(?:^|\/)tag\/(v[^/?#]+)/;

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
  // 版本既不是旧的也不是新的：用户自己装了别的版本，按"已经不是原来那一步"处理。
  if (currentVersion !== from) return { state: 'done', to };
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

/**
 * 读最新 Release。先把 api.github.com 试一遍，不通就退到 github.com 的
 * `/releases/latest` 跳转——后者拿不到正文，只能给版本号和链接。
 * @param {{apiBase?: string, releasesBase?: string, request?: Function, timeoutMs?: number}} options
 * @returns {Promise<{version: string, notes: string, url: string, via: 'api'|'redirect'}|null>}
 */
export async function fetchLatestRelease(options = {}) {
  const apiBase = String(options.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const releasesBase = String(options.releasesBase || 'https://github.com').replace(/\/+$/, '');
  const request = typeof options.request === 'function' ? options.request : fetch;
  const timeoutMs = Number(options.timeoutMs) || 8000;

  try {
    const response = await request(`${apiBase}/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response && response.ok) {
      const data = await response.json();
      const version = tagToVersion(data && data.tag_name);
      if (version) {
        return {
          version,
          notes: data && typeof data.body === 'string' ? data.body : '',
          url: data && typeof data.html_url === 'string' && data.html_url
            ? data.html_url
            : `${releasesBase}/${REPO}/releases/tag/${data.tag_name}`,
          via: 'api'
        };
      }
    }
  } catch (_error) { /* 退到跳转 */ }

  try {
    const response = await request(`${releasesBase}/${REPO}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const location = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location')
      : '';
    const match = PLACEHOLDER.exec(String(location || ''));
    const version = match ? tagToVersion(match[1]) : '';
    if (version) {
      const target = new URL(location, `${releasesBase}/${REPO}/releases/latest`);
      return { version, notes: '', url: target.toString(), via: 'redirect' };
    }
  } catch (_error) { /* 两条都不通 */ }

  return null;
}
