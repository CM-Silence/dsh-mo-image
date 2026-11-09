/**
 * 更新状态服务：把「检查 GitHub → 有没有新版 → 装哪个 tag → 装完没有」
 * 收成一个有状态对象，路由和启动预热都只跟它打交道。
 *
 * 自我更新有个绕不开的坑：装新版本时插件自己会被卸载，这次调用等不到结果。
 * 所以状态靠标记文件 + 当前版本号事后判定，见 hydrate()。
 */
import { randomUUID } from 'node:crypto';
import {
  classifySource, clearMarker, compareVersions, fetchChangelogNotes, fetchLatestVersion,
  judgeMarker, readMarker, writeMarker
} from './update.js';

// 宿主进程启动时刻：process.uptime 是进程年龄，模块重新 import 不会把它重置。
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/** 安装 spec：带 tag 的 git 依赖，和用户手动装的那条命令一致。 */
export const UPDATE_SPEC = (version) => `github:CM-Silence/dsh-mo-image#v${version}`;

/**
 * @param {object} options
 * @param {string} options.currentVersion 插件自己的版本号
 * @param {string} [options.markerFile] 标记文件路径
 * @param {Function} [options.request] 出站请求（默认 lib/net.js 的 request）
 * @param {object} [options.pluginManager] DSH 的插件管理器服务
 * @param {(line: string) => void} [options.log] 宿主日志
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.installDelayMs] 先让"正在更新"气泡露个脸
 * @param {string} [options.apiBase]
 * @param {string} [options.releasesBase]
 */
export function createUpdateService(options = {}) {
  const currentVersion = String(options.currentVersion || '0.0.0');
  const markerFile = typeof options.markerFile === 'string' ? options.markerFile : '';
  const request = options.request;
  const pluginManager = options.pluginManager;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const installDelayMs = Number.isFinite(options.installDelayMs) ? options.installDelayMs : 800;

  // 服务可能在 pluginManager 就绪之前就建好了（插件加载顺序不保证），
  // 所以这里允许传一个取值函数，每次调用时再解析。
  function manager() {
    const value = typeof pluginManager === 'function' ? pluginManager() : pluginManager;
    return value && typeof value.installBundle === 'function' ? value : null;
  }

  let phase = 'idle';
  let latest = '';
  let notes = '';
  let url = '';
  let checkedAt = '';
  let error = '';
  let source = '';
  let updatable = false;
  let updatedBeforeRestart = false;
  let refreshing = null;
  let applying = null;
  let disposed = false;

  async function readSource() {
    const manager_ = manager();
    if (!manager_ || typeof manager_.listBundles !== 'function') return { source: '', updatable: false };
    try {
      const bundles = await manager_.listBundles();
      const hit = (Array.isArray(bundles) ? bundles : []).find((item) => item && item.name === 'dsh-mo-image');
      return {
        source: hit && typeof hit.source === 'string' ? hit.source : '',
        // 只有以 npm 版本安装的包才能走 updateBundle（卸旧装新、失败自动装回）。
        updatable: !!(hit && hit.updatable)
      };
    } catch (_error) {
      return { source: '', updatable: false };
    }
  }

  function status() {
    return {
      state: phase,
      current: currentVersion,
      latest,
      notes,
      url,
      checkedAt,
      // 没有插件管理器就没法自助更新；本地链接安装同样不行。
      installable: !!manager() && classifySource(source) !== 'link',
      source,
      updatedBeforeRestart: phase === 'done' ? updatedBeforeRestart : false,
      error
    };
  }

  function safeLog(line) {
    try { log(line); } catch (_error) { /* ignore */ }
  }

  /** 查一次 npm 上的最新版本；单飞去重，失败只记日志。 */
  async function refresh() {
    if (disposed) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (phase === 'idle' || phase === 'available') phase = 'checking';
      try {
        const bundle = await readSource();
        if (bundle.source) source = bundle.source;
        updatable = bundle.updatable;
        const release = await fetchLatestVersion({
          request,
          registryBase: options.registryBase,
          mirrorBase: options.mirrorBase,
          onError: (reason) => safeLog('update check failed: ' + String(reason || 'unknown'))
        });
        if (disposed) return;
        checkedAt = new Date(now()).toISOString();
        if (!release) {
          if (phase === 'checking') phase = 'idle';
          error = 'update check failed';
          return;
        }
        const verdict = compareVersions(release.version, currentVersion);
        if (verdict === 1) {
          latest = release.version;
          url = release.url;
          notes = await fetchChangelogNotes(release.version, {
            request,
            cdnSources: options.cdnSources
          });
        } else {
          latest = '';
          notes = '';
          url = '';
        }
        error = '';
        if (phase === 'checking' || phase === 'idle' || phase === 'available') {
          phase = verdict === 1 ? 'available' : 'idle';
        } else if (phase === 'done') {
          // 已经更新完、只是页面还没重启：不要把刚装上的版本号覆盖成"更新版"。
          latest = currentVersion;
        }
      } catch (caught) {
        if (disposed) return;
        checkedAt = new Date(now()).toISOString();
        if (phase === 'checking') phase = 'idle';
        error = 'update check failed';
        safeLog('update check failed: ' + String(caught && caught.message ? caught.message : caught));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /**
   * 发起安装。立刻返回（路由不等 pnpm），安装结果通过 status() 与标记文件体现。
   * @param {string} version
   * @returns {Promise<{ok: true}|{ok: false, code: string}>}
   */
  async function apply(version) {
    if (applying) return { ok: true };
    if (phase === 'updating') return { ok: true };
    const to = String(version || latest || '').trim();
    if (!to) return { ok: true };
    if (phase === 'done' && (to === currentVersion || to === latest)) return { ok: true };
    const active = manager();
    if (!active) {
      return { ok: false, code: 'update.unsupported' };
    }
    if (!source || !updatable) {
      const bundle = await readSource();
      if (bundle.source) source = bundle.source;
      updatable = bundle.updatable;
    }
    if (classifySource(source) === 'link') return { ok: false, code: 'update.localDev' };
    if (applying) return { ok: true };

    const requestId = randomUUID();
    if (markerFile) {
      try {
        writeMarker(markerFile, { from: currentVersion, to, requestId, startedAt: now() });
      } catch (caught) {
        safeLog('update marker write failed: ' + String(caught && caught.message ? caught.message : caught));
      }
    }
    phase = 'updating';
    error = '';

    const work = (async () => {
      try {
        await sleep(installDelayMs);
        let result;
        if (updatable && typeof active.updateBundle === 'function') {
          // npm 安装：走原生更新，它会在装失败时把旧版本装回来。
          result = await active.updateBundle('dsh-mo-image', to, { requestId });
        } else {
          const spec = UPDATE_SPEC(to);
          const installOptions = { requestId, enabled: true };
          try {
            result = await active.installBundle(spec, installOptions);
          } catch (caught) {
            if (caught && caught.code === 'already-installed') {
              await active.removeBundle('dsh-mo-image');
              result = await active.installBundle(spec, installOptions);
            } else {
              throw caught;
            }
          }
        }
        const application = result && result.result && result.result.application;
        if (application === 'failed' || application === 'cancelled') {
          phase = 'failed';
          error = application;
          if (markerFile) clearMarker(markerFile);
          safeLog('update failed: ' + application);
          return;
        }
        phase = 'done';
        updatedBeforeRestart = false;
        latest = to;
      } catch (caught) {
        phase = 'failed';
        error = String(caught && caught.message ? caught.message : caught);
        if (markerFile) clearMarker(markerFile);
        safeLog('update failed: ' + error);
      }
    })();

    applying = work;
    work.finally(() => { applying = null; });
    return { ok: true };
  }

  /**
   * 启动时读标记文件：上一次更新到底成没成。
   * - 当前版本已经等于目标 → done（本次会话第一次加载就说"更新完成"）
   * - 仍是旧版本且超时 → failed
   * - 仍在进行中 → updating
   */
  async function hydrate() {
    if (!markerFile) return;
    const marker = readMarker(markerFile);
    if (!marker) {
      if (phase === 'done' || phase === 'failed') { phase = 'idle'; error = ''; }
      return;
    }
    const verdict = judgeMarker(marker, currentVersion, now());
    if (verdict.state === 'stale') {
      clearMarker(markerFile);
      return;
    }
    if (verdict.state === 'done') {
      latest = verdict.to || latest;
      phase = 'done';
      updatedBeforeRestart = (Number(marker.startedAt) || 0) < PROCESS_STARTED_AT;
      clearMarker(markerFile);
      return;
    }
    if (verdict.state === 'failed') {
      latest = verdict.to || latest;
      phase = 'failed';
      error = 'update incomplete';
      clearMarker(markerFile);
      return;
    }
    if (verdict.state === 'updating') {
      latest = verdict.to || latest;
      phase = 'updating';
    }
  }

  /** 客户端弹完气泡后的回执：同一件事不再重复提示。 */
  async function ack() {
    if (markerFile) clearMarker(markerFile);
    if (phase === 'done' || phase === 'failed') {
      phase = latest && compareVersions(latest, currentVersion) === 1 ? 'available' : 'idle';
      error = '';
    }
    return { ok: true };
  }

  return {
    status,
    refresh,
    apply,
    hydrate,
    ack,
    /** 等到当前安装结束（测试与调试用；正常路径不需要等它）。 */
    settled: () => (applying ? applying.catch(() => {}) : Promise.resolve()),
    dispose() {
      disposed = true;
      refreshing = null;
      applying = null;
    }
  };
}
