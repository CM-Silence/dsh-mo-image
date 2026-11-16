import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  resolveAdapter, describeAdapter, fitSize, sizePolicyFor, sizeSpecFor,
  parseSize, nearestAspect, nearestTier, sizeForAspect,
  qualityForAdapter, qualityOptionsFor, filterImageModels,
  readResponseBytes, looksLikeImage, sniffType,
  listProviderModelEntries, adapterManifest, localPresetManifest, providerPresetManifest,
  adapterCanListModels, listsOpenAiCompatibleModels,
  analyzeComfyWorkflow, A1111_PARAMS
} from './adapters.js';
import {
  applySizeStitch, finalizeImage, finalizeImageAsync, saveImage, saveSidecar, sizeLabel, stitchSizePrompt
} from './image-service.js';
export { finalizeImage, finalizeImageAsync, stitchSizePrompt };
import { CONFIG_STATE_MARKER, CONFIG_STATE_VARIABLE, configStateText, promptSectionText, resolvePromptProfile, settingsPayload } from './prompt-profiles.js';
import { rememberSettings, settingsSignature, settingsState } from './settings-memory.js';
import { request, setNetworkLogger } from './net.js';
import { configWriteReason } from './config-guard.js';
import { localizedError, errorBody } from './localized-error.js';
import { createUpdateService } from './update-service.js';
import { createImageQueue } from './image-queue.js';
import { createCallRegistry, createJobJournal } from './image-jobs.js';
import {
  attachFailure, callAsyncImage, callImageApi, followTask,
  setImageExecutionLogger, stableStringify, TOTAL_BUDGET_MS
} from './image-execution.js';
export { callImageApi };
import {
  activeImageState, assertLocalRequest, canUseCredentials, capabilityManifest, createConfigStore,
  describeImageStatus as describeImageStatusBase, normalizeConfig, normalizeDefaults,
  normalizeModelOptions, publicConfig, readConfig, readConfigSync, resolveProviderCredential,
  resolveQuality, resolveSizeRequest, saveConfigWithCredentials
} from './config-store.js';
export {
  capabilityManifest, normalizeConfig, normalizeDefaults, normalizeModelOptions,
  resolveSizeRequest, workflowParamsOf
} from './config-store.js';
import { MAPPING_KEYS } from './comfy-workflow.js';
import { STATUS_CONTRACT, editCapableModels, pickAutoEditModel } from './status.js';

const PLUGIN = 'dsh-mo-image';
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function stateDir() {
  return path.join(dshHome(), 'mo-image');
}
function configFile() {
  return path.join(stateDir(), 'config.json');
}
function outputDir() {
  return path.join(stateDir(), 'out');
}
function hostLogFile() {
  return path.join(stateDir(), 'host.log');
}
/** 插件自己的版本号，用来和 GitHub 上的 Release 比。 */
function pluginVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0');
  } catch (_error) {
    return '0.0.0';
  }
}
/** 配置快照本身不知道插件版本；状态服务在这一层把版本补上。 */
function describeImageStatus(store) {
  return describeImageStatusBase(store, pluginVersion());
}
const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REF_TOTAL = 48 * 1024 * 1024;
const MAX_JSON_EDIT_TOTAL = 10 * 1024 * 1024;
const MAX_REF_COUNT = 16;
const MAX_REF_CONCURRENCY = 3;
const ALLOW_PRIVATE_REFS = String(process.env.MO_IMAGE_ALLOW_PRIVATE_REFS || '').trim() === '1';

function ensureDirs() { mkdirSync(outputDir(), { recursive: true }); }
function logHost(message) {
  try { appendFileSync(hostLogFile(), new Date().toISOString() + ' ' + message + '\n'); } catch (_error) { /* diagnostics */ }
}
function sessionCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : '';
  } catch (_error) { return ''; }
}
/** 新图优先写进当前项目目录；没有 session cwd 时退回 DSH 状态目录。 */
function generatedImageDir(exec) {
  const cwd = sessionCwd(exec);
  return cwd ? path.join(cwd, 'generated-images') : outputDir();
}
let previewKeyCache = null;
/** 预览 URL 用 HMAC 签名，图片本体留在项目目录，宿主只保存一把很小的 key。 */
function previewKey() {
  const file = path.join(stateDir(), 'preview.key');
  if (previewKeyCache && previewKeyCache.file === file) return previewKeyCache.key;
  ensureDirs();
  let key = null;
  try { key = readFileSync(file); } catch (_error) { key = null; }
  if (!key || key.length !== 32) {
    key = randomBytes(32);
    try {
      writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      key = readFileSync(file);
    }
    if (!key || key.length !== 32) throw new Error('preview key is invalid');
  }
  previewKeyCache = { file: file, key: key };
  return key;
}
function signPreview(file) {
  const payload = Buffer.from(JSON.stringify({ p: file }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', previewKey()).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function resolvePreviewToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return '';
  const payload = parts[0];
  try {
    const expected = createHmac('sha256', previewKey()).update(payload).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return '';
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value && typeof value.p === 'string' && path.isAbsolute(value.p) ? value.p : '';
  } catch (_error) { return ''; }
}
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw localizedError(new Error('request body is too large'), 'request.bodyTooLarge');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw localizedError(error, 'request.invalidJson');
  }
}
function pickProvider(config, purpose, args) {
  const providers = config.providers || [];
  if (!providers.length) throw new Error('还没有配置生图模型。请先到 DSH 设置 → 生图模型 添加提供商、模型和 API Key。');
  // 提供商和模型只认用户在选择器里选中的那一组：工具参数里传什么都不认，
  // 避免对话模型在失败后绕过用户去别的提供商/模型上重试。
  const active = config.active || {};
  if (!active.providerId) throw new Error('还没有选择当前生图模型。请先到 DSH 设置 → 生图模型 选择当前模型。');
  const provider = providers.find((p) => p.id === active.providerId) || null;
  if (!provider) throw new Error('当前选中的生图提供商不存在，请到设置 → 生图模型重新选择。');
  // 严格只用用户选中的模型：不做「编辑时自动换 sunburst」这类回退，
  // 模型不支持对应能力时由 callImageApi 明确报「不支持」，而不是偷偷换一个。
  // 唯一例外是用户把选择器设为 Auto：此时由工具传进来的 model 决定，且必须在本提供商列表内。
  const activeModel = String(active.model || '').trim();
  if (!activeModel) throw new Error('还没有选择当前生图模型。请先到 DSH 设置 → 生图模型 选择当前模型。');
  const requestedProvider = String((args && args.provider) || '').trim();
  const requestedModel = String((args && args.model) || '').trim();
  // 模型由用户在设置里选定，工具参数只是可选的一致性核对。不让模型复述环境状态：
  // 它会把对话历史里的旧 id 再抄一遍，用户中途切换模型后必定白失败一轮。
  // 传了不一致的值仍然拒绝，防止对话模型自己换提供商/模型。
  if (requestedProvider && requestedProvider !== provider.id && requestedProvider !== provider.name) {
    throw new Error('提供商由用户在设置里固定（当前：' + (provider.name || provider.id) + '），请求的是 ' + requestedProvider + '。要换提供商请让用户在设置里切换。');
  }
  let model;
  if (activeModel === 'auto') {
    if (purpose === 'edit') {
      // Auto 改图：只在能图生图的模型里选。没传 model 时自动取第一个，
      // 传了但不能图生图就报清楚可选项，不要把问题拖到适配器层。
      if (requestedModel && !(provider.models || []).includes(requestedModel)) {
        throw new Error('Auto 模式只能选当前提供商列表里的模型：' + requestedModel + '。可选：' + ((provider.models || []).join(' / ') || '（列表为空）'));
      }
      const picked = pickAutoEditModel(provider, provider.models || [], requestedModel);
      if (!picked.model) {
        throw new Error(picked.capable.length
          ? 'Auto 模式下该模型不支持图生图：' + requestedModel + '。可改图的模型：' + picked.capable.join(' / ')
          : 'Auto 模式下当前提供商没有支持图生图的模型，请到设置 → 生图模型换一个支持编辑的模型。');
      }
      model = picked.model;
    } else {
      if (!requestedModel) {
        throw new Error('Auto 模式下要由你选一个模型：' + ((provider.models || []).join(' / ') || '（列表为空，请让用户先在设置里添加模型）') + '，通过 model 传入。');
      }
      if (!(provider.models || []).includes(requestedModel)) {
        throw new Error('Auto 模式只能选当前提供商列表里的模型：' + requestedModel + '。可选：' + ((provider.models || []).join(' / ') || '（列表为空）'));
      }
      model = requestedModel;
    }
  } else {
    if (requestedModel && requestedModel !== activeModel) {
      throw new Error('当前选中的模型是 ' + activeModel + '（提供商 ' + (provider.name || provider.id) + '），请求的是 ' + requestedModel + '。模型只能由用户在设置里切换。');
    }
    model = activeModel;
  }
  if (!(provider.models || []).includes(model)) {
    if (provider.models && provider.models.length) throw new Error('当前模型不在提供商的模型目录里，请到设置 → 生图模型补全。');
    throw new Error('当前提供商还没有模型 ID，请到设置 → 生图模型添加并选择模型。');
  }
  // 固定模型改图：提前说清楚，别等调用上游才报错。
  if (purpose === 'edit' && editCapableModels(provider, [model]).length === 0) {
    throw new Error('该模型不支持图生图：' + model + '。请到设置 → 生图模型换一个支持编辑的模型。');
  }
  // 协议/适配器解析交给 resolveAdapter()：不同模型族的请求形状由适配器描述符定义。
  // API Key 由 resolveProviderCredential() 在请求前从 DSH 凭据库解析，不在这里检查。
  if (!provider.baseUrl) throw new Error('生图提供商缺少 API 地址，请到设置 → 生图模型补全。');
  return { provider, model };
}
function makeSignal(exec, timeoutMs) {
  const signals = [];
  if (exec && exec.signal) signals.push(exec.signal);
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  return signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0];
}
/**
 * 上游生图任务的全局并发槽。
 *
 * 排队等待也算在工具总超时里（signal 已经带 timeout）：用户不能看到工具卡在队列里
 * 却一直没有截止时间。槽位只包住真正发往上游的那一段，本地参考图读取不占位。
 */
async function withUpstreamSlot(queue, signal, task) {
  if (!queue) return task();
  const release = await queue.acquire(signal);
  try {
    return await task();
  } finally {
    release();
  }
}
/**
 * 恢复一个已经提交过的异步任务：不重新提交，只沿任务日志里的
 * submission / taskId / pollTarget 继续轮询并下载。
 *
 * 只支持异步任务；同步任务没有可查询的远端状态，任务日志也不会为它们落盘。
 */
async function resumeImageJob(args, exec, store, snapshot, queue, journal) {
  const jobId = String((args && args.resume_job_id) || '').trim();
  if (!jobId) throw new Error('resume_job_id 不能为空');
  const job = await journal.get(jobId);
  if (!job) {
    throw attachFailure(new Error('找不到可恢复的生图任务：' + jobId + '。任务日志只保留最近 7 天，或任务已被清理。'), {
      code: 'job_not_found', phase: 'resume'
    });
  }
  const config = snapshot || await readConfig(store);
  const defaults = (config && config.defaults) || {};

  // 已经保存过、文件还在：直接返回原结果，不再打上游。
  if (job.status === 'saved' && job.file && existsSync(job.file)) {
    return {
      file: job.file, filename: path.basename(job.file), provider: job.providerName || job.providerId,
      model: job.model, size: job.size, bytes: 0, contentType: '',
      generated: job.generated || '', original: job.original || '', note: job.note || '', jobId: job.id
    };
  }
  if (job.status === 'submitting') {
    throw attachFailure(new Error('这个任务在提交途中中断，无法确认上游是否已经受理；请先按原提示词重新提交，避免重复计费。'), {
      code: 'submission_unknown', phase: 'resume', submissionState: 'unknown', jobId: job.id
    });
  }
  if (!job.submission || (!job.pollTarget && !job.submitUrl)) {
    throw attachFailure(new Error('任务日志缺少恢复所需的任务信息（submission / pollTarget / submitUrl），无法继续查询。'), {
      code: 'job_not_resumable', phase: 'resume', jobId: job.id
    });
  }

  const provider = (config.providers || []).find((item) => item && item.id === job.providerId);
  if (!provider) {
    throw attachFailure(new Error('恢复任务所属的提供商已不存在：' + job.providerId + '。请恢复提供商配置后再试。'), {
      code: 'job_provider_missing', phase: 'resume', jobId: job.id
    });
  }
  const resolved = await resolveProviderCredential(store, provider);
  const adapter = resolveAdapter(resolved, job.model);

  const signal = makeSignal(exec, 360000);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let result;
  if (adapter.autoAsync && job.submitUrl) {
    // 通用网关：提交响应就是任务包络；恢复时从同一个 submitUrl 推导轮询候选。
    result = await withUpstreamSlot(queue, signal, () => followTask(
      job.kind === 'edit' ? 'edit' : 'generate',
      adapter, resolved, job.submission, job.submitUrl, null, job.fitted, job.model,
      signal, deadline, { resume: { jobId: job.id } }
    ));
  } else if (adapter.async) {
    result = await withUpstreamSlot(queue, signal, () => callAsyncImage(
      job.kind === 'edit' ? 'edit' : 'generate',
      adapter, resolved,
      { model: job.model, fitted: job.fitted },
      signal,
      {
        journal: null,
        resume: {
          jobId: job.id, submission: job.submission, taskId: job.taskId,
          pollTarget: job.pollTarget, fitted: job.fitted, note: job.note || ''
        }
      }
    ));
  } else {
    throw attachFailure(new Error('该任务不是异步队列任务，无法从任务日志恢复。'), {
      code: 'job_not_resumable', phase: 'resume', jobId: job.id
    });
  }
  const final = await finalizeImageAsync(result, { strict: defaults.strict === true }, logHost);
  const saved = await saveImage(final.bytes, final.contentType, resolved, job.model, sizeLabel(final.fitted), generatedImageDir(exec));
  if (final.generated) saved.generated = final.generated;
  if (final.original) {
    const kept = await saveSidecar(final.original, final.contentType, saved.file, logHost);
    if (kept) saved.original = kept;
  }
  if (final.note) saved.note = final.note;
  saved.jobId = job.id;
  await journal.update(job.id, {
    status: 'saved', file: saved.file, size: saved.size, generated: saved.generated || '',
    original: saved.original || '', note: saved.note || ''
  }).catch((error) => logHost('job journal resume update failed: ' + String(error && error.message ? error.message : error)));
  return saved;
}
/** 只保留有值的 params；别的形状一律当没传。 */
function readParamsArg(args) {
  const raw = args && args.params;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function generate(args, exec, store, snapshot, queue, journal) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：先按当前模型的提示词公式写好完整提示词。');
  const negativePrompt = String(args.negative_prompt || '').trim();
  // 工具入口已经把配置读成快照传进来：同一次调用里不再读第二次，
  // 免得检查、选模型和发请求之间用户改配置，一次生图用到两套设置。
  const config = snapshot || await readConfig(store);
  const picked = pickProvider(config, 'generate', args);
  const model = picked.model;
  const provider = await resolveProviderCredential(store, picked.provider);
  const adapter = resolveAdapter(provider, model);
  const profile = resolvePromptProfile(model, adapter);
  const defaults = (config && config.defaults) || {};
  const quality = qualityForAdapter(provider, model, resolveQuality(defaults), adapter);
  const requested = resolveSizeRequest(provider, model, defaults, args, adapter);
  const fitted = fitSize(provider, { kind: requested.control, text: requested.arg }, model);
  fitted.aspect = requested.aspect || fitted.aspect;
  fitted.stitch = requested.stitch === true;
  if (requested.tier && !fitted.tier) fitted.tier = requested.tier;
  if (fitted.rejected) throw new Error(fitted.reason);
  logHost('generate adapter=' + describeAdapter(adapter) + ' model=' + model + ' promptProfile=' + profile.id + ' quality=' + (quality || 'none') + ' size=' + sizeLabel(fitted) + (fitted.adjusted ? '（' + fitted.reason + '）' : ''));
  const signal = makeSignal(exec, 360000);
  const extraParams = readParamsArg(args);
  const unsupported = extraParams && adapter.id !== 'comfyui' ? Object.keys(extraParams) : [];
  const stitched = applySizeStitch(prompt, fitted, adapter, provider, model);
  const result = await withUpstreamSlot(queue, signal, () => callImageApi('generate', adapter, provider, {
    model: model, prompt: stitched.prompt, negativePrompt: negativePrompt || undefined,
    fitted: fitted, quality: quality, params: extraParams
  }, signal, journal ? { journal: journal, kind: 'generate', providerId: provider.id } : undefined));
  const final = await finalizeImageAsync(result, { strict: defaults.strict === true }, logHost);
  const saved = await saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted), generatedImageDir(exec));
  if (final.generated) saved.generated = final.generated;
  if (final.original) {
    const kept = await saveSidecar(final.original, final.contentType, saved.file, logHost);
    if (kept) saved.original = kept;
  }
  const notes = [];
  if (stitched.note) notes.push(stitched.note);
  if (final.note) notes.push(final.note);
  if (requested.note) notes.push(requested.note);
  if (fitted.reason) notes.push('尺寸 ' + fitted.reason);
  if (unsupported.length) notes.push('当前模型不支持工作流参数，已忽略：' + unsupported.join('、'));
  if (notes.length) saved.note = notes.join('；');
  if (result.jobId) {
    saved.jobId = result.jobId;
    if (journal) {
      await journal.update(result.jobId, {
        status: 'saved', file: saved.file, size: saved.size, generated: saved.generated || '',
        original: saved.original || '', note: saved.note || ''
      }).catch((error) => logHost('job journal save update failed: ' + String(error && error.message ? error.message : error)));
    }
  }
  return saved;
}
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}
function isPrivateAddress(address) {
  const ip = String(address || '').trim().toLowerCase();
  if (!ip) return true;
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  if (isIP(ip) !== 6) return true;
  if (ip === '::' || ip === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;          // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;          // fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(ip)) return true;             // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (ip.startsWith('::ffff:')) return true;               // 十六进制写法的 IPv4-mapped，保守拒绝
  return false;
}
async function assertReferenceUrl(raw) {
  if (ALLOW_PRIVATE_REFS) return;
  let parsed;
  try { parsed = new URL(raw); } catch (_error) { throw new Error('参考图 URL 无效：' + raw); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('参考图只支持 http/https URL：' + raw);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('参考图 URL 不能指向本机地址：' + raw + '（如确需使用，请设置 MO_IMAGE_ALLOW_PRIVATE_REFS=1）');
  }
  let addresses;
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);
    } catch (_error) {
      throw new Error('无法解析参考图域名：' + host);
    }
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error('参考图 URL 不能指向内网地址：' + host + '（如确需使用，请设置 MO_IMAGE_ALLOW_PRIVATE_REFS=1）');
  }
}
/** 手动跟重定向，每一跳都重新做内网检查。 */
async function fetchReferenceResponse(raw, signal) {
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    await assertReferenceUrl(current);
    const response = await request(current, { signal: signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
      if (!location) throw new Error('参考图重定向缺少 Location');
      current = new URL(location, current).href;
      continue;
    }
    return response;
  }
  throw new Error('参考图重定向次数过多');
}
async function readReference(src, signal, index) {
  const raw = String(src || '').trim();
  if (!raw) throw new Error('第 ' + (index + 1) + ' 张参考图为空');
  if (/^https?:\/\//i.test(raw)) {
    const response = await fetchReferenceResponse(raw, signal);
    if (!response.ok) throw new Error('下载参考图失败（第 ' + (index + 1) + ' 张）：HTTP ' + response.status);
    let buffer;
    try {
      buffer = await readResponseBytes(response, MAX_REF_BYTES);
    } catch (error) {
      throw new Error('下载参考图失败（第 ' + (index + 1) + ' 张）：' + String(error && error.message ? error.message : error));
    }
    if (!looksLikeImage(buffer)) throw new Error('参考图不是有效图片（第 ' + (index + 1) + ' 张）：' + raw);
    return { buffer, contentType: sniffType(buffer), filename: 'ref-' + (index + 1) + (/\.(png|jpe?g|webp|gif)$/i.exec(raw) || ['.png'])[0] };
  }
  const file = path.resolve(raw);
  if (!existsSync(file)) throw new Error('找不到参考图：' + raw);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('参考图不是文件：' + raw);
  if (info.size > MAX_REF_BYTES) throw new Error('参考图超过 15MB：' + raw);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('参考图只支持 png / jpg / jpeg / webp / gif：' + raw);
  const buffer = await readFile(file);
  if (!looksLikeImage(buffer)) throw new Error('参考图不是有效图片：' + raw);
  return { buffer, contentType: sniffType(buffer), filename: path.basename(file) };
}
export function referenceLimitFor(adapter) {
  return adapter && adapter.transport && adapter.transport.edit === 'multipart' ? MAX_REF_TOTAL : MAX_JSON_EDIT_TOTAL;
}

/** 有界并发读取参考图；结果按输入顺序返回。 */
export async function readReferences(sources, signal, totalLimit = MAX_REF_TOTAL, concurrency = MAX_REF_CONCURRENCY) {
  const list = Array.isArray(sources) ? sources : [];
  const images = new Array(list.length);
  let totalBytes = 0;
  let failure = null;
  let nextIndex = 0;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex++;
      if (index >= list.length) return;
      try {
        const image = await readReference(list[index], signal, index);
        if (failure) return;
        totalBytes += image.buffer.length;
        if (totalBytes > totalLimit) throw new Error('参考图总大小超过 ' + Math.round(totalLimit / 1024 / 1024) + 'MB，请减少图片数量或压缩后再试。');
        images[index] = image;
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency || 1, list.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure;
  return images;
}

async function edit(args, exec, store, snapshot, queue, journal) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空：图片编辑需要写清保留什么、只改什么。');
  const negativePrompt = String(args.negative_prompt || '').trim();
  const sources = Array.isArray(args.images) ? args.images.filter((item) => String(item || '').trim()) : [];
  if (!sources.length) throw new Error('图片编辑至少需要 1 张参考图。');
  if (sources.length > MAX_REF_COUNT) throw new Error('参考图最多 ' + MAX_REF_COUNT + ' 张，当前 ' + sources.length + ' 张。');
  const config = snapshot || await readConfig(store);
  const defaults = (config && config.defaults) || {};
  const picked = pickProvider(config, 'edit', args);
  const model = picked.model;
  const provider = await resolveProviderCredential(store, picked.provider);
  const adapter = resolveAdapter(provider, model);
  const profile = resolvePromptProfile(model, adapter);
  const quality = qualityForAdapter(provider, model, resolveQuality(defaults), adapter);
  const requested = resolveSizeRequest(provider, model, defaults, args, adapter);
  const fitted = fitSize(provider, { kind: requested.control, text: requested.arg }, model);
  fitted.aspect = requested.aspect || fitted.aspect;
  fitted.stitch = requested.stitch === true;
  if (requested.tier && !fitted.tier) fitted.tier = requested.tier;
  if (fitted.rejected) throw new Error(fitted.reason);
  const signal = makeSignal(exec, 360000);
  const totalLimit = referenceLimitFor(adapter);
  const images = await readReferences(sources, signal, totalLimit);
  logHost('edit adapter=' + describeAdapter(adapter) + ' model=' + model + ' promptProfile=' + profile.id + ' quality=' + (quality || 'none') + ' size=' + sizeLabel(fitted) + ' refs=' + images.length);
  const extraParams = readParamsArg(args);
  const unsupported = extraParams && adapter.id !== 'comfyui' ? Object.keys(extraParams) : [];
  const stitched = applySizeStitch(prompt, fitted, adapter, provider, model);
  const result = await withUpstreamSlot(queue, signal, () => callImageApi('edit', adapter, provider, {
    model: model, prompt: stitched.prompt, negativePrompt: negativePrompt || undefined,
    fitted: fitted, quality: quality, images: images, params: extraParams
  }, signal, journal ? { journal: journal, kind: 'edit', providerId: provider.id } : undefined));
  const final = await finalizeImageAsync(result, { strict: defaults.strict === true }, logHost);
  const saved = await saveImage(final.bytes, final.contentType, provider, model, sizeLabel(final.fitted), generatedImageDir(exec));
  if (final.generated) saved.generated = final.generated;
  if (final.original) {
    const kept = await saveSidecar(final.original, final.contentType, saved.file, logHost);
    if (kept) saved.original = kept;
  }
  const notes = [];
  if (stitched.note) notes.push(stitched.note);
  if (final.note) notes.push(final.note);
  if (requested.note) notes.push(requested.note);
  if (fitted.reason) notes.push('尺寸 ' + fitted.reason);
  if (unsupported.length) notes.push('当前模型不支持工作流参数，已忽略：' + unsupported.join('、'));
  if (notes.length) saved.note = notes.join('；');
  if (result.jobId) {
    saved.jobId = result.jobId;
    if (journal) {
      await journal.update(result.jobId, {
        status: 'saved', file: saved.file, size: saved.size, generated: saved.generated || '',
        original: saved.original || '', note: saved.note || ''
      }).catch((error) => logHost('job journal save update failed: ' + String(error && error.message ? error.message : error)));
    }
  }
  return saved;
}


const SKILL_FILES = [
  {
    name: 'mo-image-generation',
    file: fileURLToPath(new URL('../skills/mo-image-generation/SKILL.md', import.meta.url)),
    description: '生成或重做图片时加载，包含按模型区分的提示词公式、模板和自检清单。'
  },
  {
    name: 'mo-image-editing',
    file: fileURLToPath(new URL('../skills/mo-image-editing/SKILL.md', import.meta.url)),
    description: '局部修改、参考图融合和版本迭代时加载，包含编辑公式、约束词和按模型写法。'
  }
];

/** 只解析 SKILL.md 顶部那几个简单字段，不引入 YAML 依赖。 */
function parseSkillMarkdown(raw) {
  const text = String(raw || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const hit = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!hit) continue;
    let value = hit[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[hit[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** 把当前模型对应的提示词方言注入系统提示词；模型切换后下一次组装自动更新。 */
function installPromptRecipe(ctx, store) {
  const register = (target) => {
    if (!target.systemPrompt || typeof target.systemPrompt.section !== 'function') return;
    // 配置状态按会话算：本会话读过、之后配置没变，模型就直接生图，不必再读一遍。
    // 先登记变量，再写占位符：占位符进了提示词、变量却没登记上，整段组装会报错。
    let marker = '';
    if (typeof target.systemPrompt.variable === 'function') {
      try {
        target.effect(() => target.systemPrompt.variable(CONFIG_STATE_VARIABLE, (context) => {
          try {
            const session = context && context.agent ? context.agent.session : null;
            const signature = settingsSignature(settingsPayload(activeImageState(store)));
            return configStateText(settingsState(session, signature));
          } catch (error) {
            logHost('config state marker error: ' + String(error && error.message ? error.message : error));
            return configStateText('unread');
          }
        }), 'mo-image: config state');
        marker = CONFIG_STATE_MARKER;
      } catch (error) { logHost('config state marker register error: ' + String(error && error.message ? error.message : error)); }
    }
    // 老宿主没有变量机制就当场算：section 的 text 拿到本次组装的上下文，一样按会话算。
    const sectionText = (session) => {
      const state = activeImageState(store);
      if (!state) return '';
      const value = marker || configStateText(settingsState(session, settingsSignature(settingsPayload(state))));
      return promptSectionText(state, value);
    };
    target.effect(() => target.systemPrompt.section({
      name: 'mo-image:prompt-recipe',
      order: 2950,
      text: (context) => {
        try {
          return sectionText(context && context.agent ? context.agent.session : null);
        } catch (error) {
          logHost('prompt recipe error: ' + String(error && error.message ? error.message : error));
          return '';
        }
      }
    }), 'mo-image: prompt recipe');
    logHost('prompt recipe registered (mo-image:prompt-recipe)');
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], register);
    else register(ctx);
  } catch (error) { logHost('prompt recipe install error: ' + String(error && error.message ? error.message : error)); }
}

/** 把插件自带的两个 SKILL.md 注册成运行时技能，模型可按需加载。 */
function installBundledSkills(ctx) {
  const register = (target) => {
    if (!target.skills || typeof target.skills.register !== 'function') return;
    for (const item of SKILL_FILES) {
      try {
        const parsed = parseSkillMarkdown(readFileSync(item.file, 'utf8'));
        target.effect(() => target.skills.register({
          name: parsed.meta.name || item.name,
          description: parsed.meta.description || item.description,
          whenToUse: parsed.meta.whenToUse,
          source: 'runtime',
          content: parsed.body,
          resourceBase: { kind: 'directory', path: path.dirname(item.file) }
        }), 'mo-image: skill ' + item.name);
        logHost('skill registered: ' + item.name);
      } catch (error) { logHost('skill register error ' + item.name + ': ' + String(error && error.message ? error.message : error)); }
    }
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['skills'], register);
    else register(ctx);
  } catch (error) { logHost('skill install error: ' + String(error && error.message ? error.message : error)); }
}

export const name = PLUGIN;
export const inject = ['webServer', 'tools'];

async function modelsForRequest(store, body) {
  const providerId = String(body.providerId || '').trim();
  let provider;
  if (providerId) {
    const config = await readConfig(store);
    provider = (config.providers || []).find((item) => item.id === providerId);
    if (!provider) throw localizedError(new Error('找不到指定的生图提供商'), 'provider.notFound');
    provider = Object.assign({}, provider);
    if (body.baseUrl) provider.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
    if (body.adapter) provider.adapter = String(body.adapter).trim();
    if (body.protocol) provider.protocol = String(body.protocol).trim();
    // 自定义协议的三条地址是用户在表单里现填的，模型列表要靠它。
    if (body.customEndpoints) provider.customEndpoints = body.customEndpoints;
    if (body.optionalKey !== undefined) provider.optionalKey = !!body.optionalKey;
    const supplied = String(body.key || '').trim();
    if (supplied) {
      provider.key = supplied;
      delete provider.apiKeyEnv;
    }
  } else {
    const supplied = String(body.key || '').trim();
    provider = normalizeConfig({
      providers: [{
        id: 'model-list',
        baseUrl: String(body.baseUrl || '').trim(),
        adapter: String(body.adapter || '').trim(),
        protocol: String(body.protocol || 'openai-images').trim(),
        optionalKey: !!body.optionalKey,
        customEndpoints: body.customEndpoints,
        key: supplied
      }]
    }).providers[0];
  }
  if (!provider || !provider.baseUrl) throw localizedError(new Error('请先填写 API 地址'), 'provider.missingBaseUrl');
  try {
    provider = await resolveProviderCredential(store, provider);
  } catch (_error) {
    // 模型列表接口本身可能不需要鉴权；没 key 也让它试一次，真 401 会由上游报出来。
  }
  let adapter = resolveAdapter(provider, '');
  if (!adapterCanListModels(adapter) && !String(provider.adapter || '').trim()) {
    // 没有显式适配器的第三方/兼容网关，退回 OpenAI 兼容的 /models 探测。
    try { adapter = resolveAdapter(Object.assign({}, provider, { adapter: 'openai-images' }), ''); } catch (_error) { /* keep original */ }
  }
  if (!adapterCanListModels(adapter)) throw localizedError(new Error('该部署方式不支持获取模型列表'), 'models.unsupported');
  let entries;
  try {
    entries = await listProviderModelEntries(adapter, provider, AbortSignal.timeout(20000));
  } catch (error) {
    // 没有 /models 的端点常见于网关和特殊版本：提醒用户手动填模型 ID，而不是只甩一个 404。
    const localized = error && error.localized;
    if (localized && localized.code === 'upstream.http' && Number(localized.params && localized.params.status) === 404) {
      const wrapped = localizedError(
        new Error('该地址没有模型列表接口（HTTP 404），请手动填写模型 ID。'),
        'models.notFound'
      );
      wrapped.status = 404;
      throw wrapped;
    }
    throw error;
  }
  const seen = new Set();
  const allModels = [];
  const names = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String((entry && entry.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    allModels.push(id);
    const name = String((entry && entry.name) || '').trim();
    if (name && name !== id) names[id] = name;
    if (allModels.length >= 500) break;
  }
  const models = listsOpenAiCompatibleModels(adapter) ? filterImageModels(allModels) : allModels;
  return { models: models, allModels: allModels, filteredCount: allModels.length - models.length, names: names };
}

export function apply(ctx, options = {}) {
  ensureDirs();
  logHost('apply');
  setImageExecutionLogger(logHost);
  setNetworkLogger(logHost);
  // 配置写入是权限问题，不是提示词问题：任何工具调用只要指向插件配置就拒绝。
  try {
    if (ctx.tools && typeof ctx.tools.guard === 'function') {
      ctx.effect(() => ctx.tools.guard((execution) => configWriteReason(execution && execution.arguments, execution && execution.name)), 'mo-image: config guard');
      logHost('config write guard installed');
    }
  } catch (error) { logHost('config guard install error: ' + String(error && error.message ? error.message : error)); }
  const store = createConfigStore({
    configFile: configFile(),
    ensureDirs: ensureDirs,
    logHost: logHost,
    credentialsAccessor: () => (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined)
  });
  // 上游并发是进程级资源；每个 apply 实例一条队列，测试和多次挂载互不污染。
  const imageQueue = createImageQueue(options.queue && typeof options.queue === 'object' ? options.queue : {});
  // 同一个 callId 的重放复用结果；只在内存里，进程重启后的恢复另由任务日志负责。
  const callRegistry = createCallRegistry();
  // 异步任务日志：提交后先落盘，进程重启时还能凭 jobId 找回远端任务。
  const jobJournal = createJobJournal({ dir: path.join(stateDir(), 'jobs') });
  Promise.resolve(jobJournal.prune(7 * 24 * 60 * 60 * 1000))
    .catch((error) => logHost('job journal prune failed: ' + String(error && error.message ? error.message : error)));
  try { store.webOriginHost = new URL(ctx.webServer.getOrigin()).hostname; } catch (_error) { store.webOriginHost = ''; }
  readConfigSync(store);
  // 只读状态服务：工作台等其它插件通过 ctx.get('moImageStatus') 取快照，
  // 不再各自解析 config.json / 凭据库，也不靠模型名猜编辑能力。
  try {
    if (typeof ctx.provide === 'function') {
      ctx.effect(() => ctx.provide('moImageStatus', {
        contract: STATUS_CONTRACT,
        describe: () => describeImageStatus(store)
      }), 'mo-image: status service');
      logHost('status service registered (moImageStatus)');
    }
  } catch (error) { logHost('status service error: ' + String(error && error.message ? error.message : error)); }
  if (canUseCredentials(store)) {
    readConfig(store).catch((error) => logHost('config key migration failed: ' + String(error && error.message ? error.message : error)));
  }
  installPromptRecipe(ctx, store);
  installBundledSkills(ctx);

  // 更新检查：宿主启动后预热一次，路由再按 12 小时的新鲜度补查。
  // pluginManager 只有桌面版有；没有它时检查照做，只是点"更新"会退化成命令行提示。
  const updateOptions = options.update && typeof options.update === 'object' ? options.update : {};
  const updateService = createUpdateService({
    currentVersion: pluginVersion(),
    markerFile: path.join(stateDir(), 'update.json'),
    request: typeof updateOptions.request === 'function' ? updateOptions.request : request,
    pluginManager: () => (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined),
    log: logHost,
    installDelayMs: Number.isFinite(updateOptions.installDelayMs) ? updateOptions.installDelayMs : 800,
    registryBase: updateOptions.registryBase,
    mirrorBase: updateOptions.mirrorBase,
    cdnSources: updateOptions.cdnSources
  });
  // 上次更新成没成，先看标记文件——这一步不能等网络，否则重启后的
  // 完成气泡要晚好几秒才可能被问到。
  Promise.resolve(updateService.hydrate())
    .catch((error) => logHost('update hydrate failed: ' + String(error && error.message ? error.message : error)));
  if (updateOptions.skipCheck !== true) {
    ctx.effect(() => {
      const delay = Number.isFinite(updateOptions.startupDelayMs) ? updateOptions.startupDelayMs : 5000;
      const timer = setTimeout(() => {
        Promise.resolve(updateService.refresh())
          .catch((error) => logHost('update warmup failed: ' + String(error && error.message ? error.message : error)));
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return () => {
        clearTimeout(timer);
        updateService.dispose();
      };
    }, 'mo-image: update check');
  }
  const publicOrigin = () => {
    // DSH_WEB_URL 是宿主对外公布的地址（远程/反代场景也能用）；getOrigin 只是
    // 本地监听地址，不能直接给远端浏览器用。
    try {
      const advertised = String(process.env.DSH_WEB_URL || '').trim();
      if (/^https?:\/\//i.test(advertised)) return advertised.replace(/\/+$/, '');
    } catch (_error) { /* ignore */ }
    try { if (ctx.webServer && typeof ctx.webServer.getOrigin === 'function') return String(ctx.webServer.getOrigin()).replace(/\/+$/, ''); } catch (_error) { /* ignore */ }
    try { const port = ctx.webServer && ctx.webServer.port; if (port) return 'http://127.0.0.1:' + port; } catch (_error) { /* ignore */ }
    return '';
  };

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/config',
        handler: async (req, res) => {
          try {
            assertLocalRequest(store, req, req.method === 'POST');
            if (req.method === 'GET') {
              const config = await readConfig(store);
              return sendJson(res, 200, { ok: true, config: await publicConfig(store, config), adapters: adapterManifest(), providerPresets: providerPresetManifest(), localPresets: localPresetManifest(), capabilities: capabilityManifest(config) });
            }
            if (req.method === 'POST') {
              const body = await readBody(req);
              const saved = await saveConfigWithCredentials(store, body.config || body);
              return sendJson(res, 200, { ok: true, config: await publicConfig(store, saved), adapters: adapterManifest(), providerPresets: providerPresetManifest(), localPresets: localPresetManifest(), capabilities: capabilityManifest(saved) });
            }
            return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 500, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('config route error: ' + String(error)); return () => {}; }
  }, 'mo-image: config route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/models',
        handler: async (req, res) => {
          try {
            assertLocalRequest(store, req, true);
            if (req.method !== 'POST') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const body = await readBody(req);
            const result = await modelsForRequest(store, body || {});
            return sendJson(res, 200, { ok: true, models: result.models, allModels: result.allModels, filteredCount: result.filteredCount, names: result.names || {} });
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 502, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('models route error: ' + String(error)); return () => {}; }
  }, 'mo-image: models route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/comfy/analyze',
        handler: async (req, res) => {
          try {
            assertLocalRequest(store, req, true);
            if (req.method !== 'POST') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const body = await readBody(req);
            const config = await readConfig(store);
            const providerId = String(body.providerId || '');
            const provider = (config.providers || []).find((item) => item && item.id === providerId) || null;
            const baseUrl = String(body.baseUrl || (provider && provider.baseUrl) || '').trim().replace(/\/+$/, '');
            if (!baseUrl) throw new Error('找不到这个提供商，或它没有填地址。');
            const workflow = String(body.workflow || '');
            if (!workflow.trim()) throw new Error('工作流是空的。');
            const merged = provider ? Object.assign({}, provider, { baseUrl }) : { baseUrl };
            const analysis = await analyzeComfyWorkflow({ base: baseUrl, provider: merged, workflow });
            return sendJson(res, 200, { ok: true, ...analysis });
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        }
      });
    } catch (error) { logHost('analyze route error: ' + String(error)); return () => {}; }
  }, 'mo-image: analyze route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix', path: '/api/mo-image/preview',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (req.method !== 'GET') return sendJson(res, 405, errorBody(localizedError(new Error('method not allowed'), 'request.methodNotAllowed')));
            const raw = decodeURIComponent(url.pathname.slice('/api/mo-image/preview/'.length));
            let file = resolvePreviewToken(raw);
            if (!file) {
              // 兼容旧版 /preview/<basename>：旧图仍在 DSH 状态目录 out/ 下。
              const name = path.basename(raw);
              if (!/^[a-zA-Z0-9._-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad filename' });
              file = path.join(outputDir(), name);
            }
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
            const info = await stat(file);
            if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
            const ext = path.extname(file).toLowerCase();
            const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'private, max-age=3600' });
            res.end(await readFile(file));
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        }
      });
    } catch (error) { logHost('preview route error: ' + String(error)); return () => {}; }
  }, 'mo-image: preview route');

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'exact', path: '/api/mo-image/update',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              assertLocalRequest(store, req, false);
              const status = updateService.status();
              if (!status.checkedAt || Date.now() - Date.parse(status.checkedAt) > UPDATE_CHECK_TTL_MS) {
                Promise.resolve(updateService.refresh()).catch((error) => logHost('update refresh failed: ' + String(error && error.message ? error.message : error)));
              }
              return sendJson(res, 200, { ok: true, ...status });
            }
            if (req.method === 'POST') {
              assertLocalRequest(store, req, true);
              const body = await readBody(req);
              const action = body && typeof body.action === 'string' ? body.action : '';
              if (action === 'ack') {
                await updateService.ack();
                return sendJson(res, 200, { ok: true });
              }
              if (action === 'apply') {
                // 只装服务端自己查到的最新版；请求体里的版本号不可信。
                const outcome = await updateService.apply();
                if (outcome.ok === false) return sendJson(res, 200, { ok: false, code: outcome.code });
                return sendJson(res, 200, { ok: true });
              }
              return sendJson(res, 400, { ok: false, error: 'unknown action' });
            }
            return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          } catch (error) {
            return sendJson(res, Number(error && error.status) || 500, errorBody(error));
          }
        }
      });
    } catch (error) { logHost('update route error: ' + String(error)); return () => {}; }
  }, 'mo-image: update route');

  const renderImage = (_args, value) => {
    // 配置交接：这次没有生成图片，整个返回值按 JSON 交给模型（含 settings），不渲染图片行。
    if (value && value.needsSettings) return [{ type: 'text', text: JSON.stringify(value) }];
    let ref = '';
    try { ref = value && value.path ? signPreview(value.path) : ''; } catch (error) { logHost('preview sign error: ' + String(error && error.message ? error.message : error)); }
    if (!ref) ref = path.basename((value && value.path) || '');
    const blocks = [{
      type: 'text',
      text: '![生成图片](' + publicOrigin() + '/api/mo-image/preview/' + encodeURIComponent(ref) + ')'
    }];
    if (value && value.note) blocks.push({ type: 'text', text: value.note });
    // 异步任务 id 必须让模型看得见：任务中断时，下一轮才有 resume_job_id 可传。
    if (value && value.jobId) blocks.push({ type: 'text', text: '任务 ID：' + value.jobId + '（中断后可用 resume_job_id 继续）' });
    return blocks;
  };
  const pendingPresentations = new Map();
  const presentImage = (exec, result) => {
    try {
      const projections = ctx.get && ctx.get('sessionProjections');
      const boundary = projections && exec.agent ? projections.stateOf(exec.agent.session, 'turnBoundary') : undefined;
      if (boundary && boundary.openTurnStartSeq !== null && boundary.lastTurn !== undefined) {
        pendingPresentations.set(exec, {
          session: exec.agent.session, turn: boundary.lastTurn,
          callId: exec.callId, file: result.file
        });
      }
    } catch (error) { logHost('present error: ' + String(error && error.message ? error.message : error)); }
  };
  const flushPresentation = (exec, result) => {
    const item = pendingPresentations.get(exec);
    if (!item) return;
    pendingPresentations.delete(exec);
    if (result && result.isError) return;
    try {
      item.session.append('deliverables/presented', {
        turn: item.turn, callId: item.callId,
        files: [{ path: item.file, description: 'AI 生成图片' }]
      });
    } catch (error) { logHost('present append error: ' + String(error && error.message ? error.message : error)); }
  };
  if (typeof ctx.on === 'function') ctx.on('tools/result', flushPresentation);
  const output = {
    schema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string' },
        model: { type: 'string' },
        // 成品尺寸与上游原始尺寸：严格模式靠这两个值解释"我缩过 / 上游没按你说的出"。
        size: { type: 'string' },
        generated: { type: 'string' },
        original: { type: 'string' },
        note: { type: 'string' },
        jobId: { type: 'string' },
        // 配置没对齐时用这个形状回答：不生成图片，直接把当前配置交给模型。
        needsSettings: { type: 'boolean' },
        settings: { type: 'object' }
      }
    },
    render: renderImage
  };
  // DSH 的工具契约要求每个工具声明 output { schema, render? }；settings
  // 返回值就是给模型看的全部内容：一个最小 JSON（提供商/模型唯一 id + 优化开关 + 一句写法提示）。
  // 配置没变时只回 { unchanged, hint }，所以 schema 只把 hint 标成必填。
  const modelsOutput = {
    schema: {
      type: 'object', additionalProperties: false,
      required: ['hint'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        promptOptimization: { type: 'boolean' },
        canEdit: { type: 'boolean' },
        sizeMode: { type: 'string', enum: ['auto', 'fixed'] },
        strict: { type: 'boolean' },
        size: { type: 'string' },
        control: { type: 'string' },
        sizeOptions: { type: 'array', items: { type: 'string' } },
        hint: { type: 'string' },
        unchanged: { type: 'boolean' },
        models: { type: 'array', items: { type: 'string' } },
        editModels: { type: 'array', items: { type: 'string' } },
        params: { type: 'array', items: { type: 'object' } }
      }
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  };

  // 生图前要读过当前配置，但只在「这个会话还没读过」或「配置真的变了」时才需要重读。
  // 记忆按会话保存（见 settings-memory），比较的是配置快照而不是变更次数：用户改了又
  // 改回去、中间没有对话，仍然算没有变化。系统提示词里的「配置状态」用同一个判断。
  //
  // 「读过」= 这一刻的配置已经锁进这次调用的结果（settings 的 payload / 交接的 settings）。
  // 之后用户再改，签名就变了，下一次调用会重新判断；所以这次锁定不会因为后续修改而失真，
  // 进行中的请求也不受后续修改影响。
  //
  // 没读完就调用生图工具时不报错：把当前配置直接交回去，让模型按它重写提示词再调一次。
  // 一次失败的工具调用对用户就是一条红字，而模型本来就能从结果里把配置读懂。
  const sessionOf = (exec) => (exec && exec.agent && exec.agent.session) || null;
  const settingsHandoff = (exec, mode, snapshot) => {
    const session = sessionOf(exec);
    if (!session) return null; // 没有会话上下文（脚本调用）时无从比对，不拦。
    const payload = settingsPayload(activeImageState(store, snapshot));
    // 没有选模型不是「配置过期」问题：不记成已读，也别让模型重试到 generate() 里去撞红字。
    if (!payload.model) {
      return {
        path: '',
        needsSettings: true,
        settings: payload,
        note: '还没有选择生图模型，这次没有生成。请让用户先在设置 → 生图模型里选一个，再按 settings 写提示词调用本工具。'
      };
    }
    // 模型不支持改图时不要用交接盖住它：让 edit() 抛那条带模型名、能被本地化的能力错误。
    // 用交接会变成“重写提示词再调用”，重试还是同一个错误，只是多绕一轮。
    if (mode === 'edit' && payload.canEdit === false) return null;
    const signature = settingsSignature(payload);
    const state = settingsState(session, signature);
    if (state === 'fresh') return null;
    rememberSettings(session, signature);
    return {
      path: '',
      needsSettings: true,
      settings: payload,
      note: (state === 'stale'
        ? '配置在你上次读取后改过了，这次没有生成。'
        : '本会话还没读过生图配置，这次没有生成。')
        + '按 settings 里的模型写法和提示词优化状态重写提示词，再调用一次本工具。'
    };
  };

  // 调用身份：同一会话 + 同一个 callId。会话对象用 WeakMap 编号，避免依赖宿主是否
  // 暴露 session id；没有 callId 的脚本入口不做去重（宿主没有稳定身份，猜不得）。
  const sessionIds = new WeakMap();
  let nextSessionId = 0;
  const sessionIdOf = (session) => {
    if (!session || typeof session !== 'object') return 'no-session';
    let id = sessionIds.get(session);
    if (!id) { id = 's' + (++nextSessionId); sessionIds.set(session, id); }
    return id;
  };
  const invocationKey = (exec, tool) => {
    const callId = String((exec && exec.callId) || '').trim();
    if (!callId) return '';
    return tool + ':' + sessionIdOf(sessionOf(exec)) + ':' + callId;
  };
  /** 有效请求摘要：参数 + 配置快照 + 提供商地址。键顺序必须稳定。 */
  const invocationFingerprint = (tool, args, snapshot) => {
    const state = activeImageState(store, snapshot);
    const input = {
      prompt: String((args && args.prompt) || ''),
      negative_prompt: String((args && args.negative_prompt) || ''),
      images: Array.isArray(args && args.images) ? args.images.map((item) => String(item || '')) : [],
      size: String((args && args.size) || ''),
      model: String((args && args.model) || ''),
      provider: String((args && args.provider) || ''),
      params: args && args.params && typeof args.params === 'object' ? args.params : null
    };
    const providerPrint = state
      ? [state.provider.id, state.provider.baseUrl, state.provider.apiKeyEnv || '']
      : null;
    return stableStringify([
      tool,
      state ? settingsSignature(settingsPayload(state)) : '',
      providerPrint,
      input
    ]);
  };
  const imagePayload = (result) => {
    const payload = { path: result.file, model: String(result.model || '') };
    if (result.size) payload.size = String(result.size);
    if (result.generated) payload.generated = String(result.generated);
    if (result.original) payload.original = String(result.original);
    if (result.note) payload.note = result.note;
    // 异步任务 id：日志/恢复入口用；同步任务没有。
    if (result.jobId) payload.jobId = String(result.jobId);
    return payload;
  };

  // 每个工具单独兜底：一个工具的契约不满足时，不会连带其它工具一起注册失败。
  try {
    ctx.tools.register({
      name: 'mo_image_settings',
      description: 'Read the current image settings: provider, model, optimization state, per-model dialect. The <mo-image-prompt> 配置状态 line decides: 还没读过/刚改过 → call this before mo_image_generate/mo_image_edit (they hand back settings, not images); 一致 → skip. An unchanged read answers {"unchanged":true}; refresh:true re-reads after compaction.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          refresh: { type: 'boolean', description: 'Re-read the full payload after compaction, or when the earlier read is no longer in context.' }
        }
      },
      output: modelsOutput,
      timeoutMs: 15000,
      async execute(args, exec) {
        const payload = settingsPayload(activeImageState(store));
        const signature = settingsSignature(payload);
        const session = sessionOf(exec);
        const state = settingsState(session, signature);
        rememberSettings(session, signature);
        if (state === 'fresh' && !(args && args.refresh === true)) {
          return { unchanged: true, hint: '配置没变：沿用上次读到的模型和写法，直接生图/改图；这份配置已经不在上下文里时传 refresh:true 重读。' };
        }
        return payload;
      }
    });
  } catch (error) { logHost('settings tool register error: ' + String(error)); }

  try {
    ctx.tools.register({
      name: 'mo_image_generate',
      description: 'Generate a new image with the active model. If 配置状态 says the settings read is missing or stale, call mo_image_settings first: this tool then returns {"path":"","needsSettings":true,"settings":…} and generates nothing. With current settings: On → write the prompt in the model\'s dialect and pick fitting params; Off → pass the user\'s wording unchanged. Model and quality come from the picker, so leave model out; pass size only when settings report sizeMode "auto" and the user asked for it; in Auto mode pass one id from the list. Load the mo-image-generation skill once; when optimization is Off use its invocation guidance only. Reply with the returned Markdown image line. Output is final: never judge/describe the image, never switch provider/model/tool, and do not open it unless asked. On failure report the error verbatim and at most ask whether to switch.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Final prompt in the model\'s dialect (On) or the user\'s wording (Off). Cover subject, action, environment, style, lighting, composition, constraints; quote in-image text exactly.' },
          negative_prompt: { type: 'string', description: 'Optional; only for models that support it. Artifacts/elements to avoid.' },
          size: { type: 'string', description: 'Optional shape like "1024x1536"; only when settings report sizeMode "auto" and the user asked; ignored when the picker pins the size.' },
          model: { type: 'string', description: 'Optional outside Auto mode: the picker\'s model is used. In Auto mode pass one id from the active list; other values are rejected — never switch models.' },
          provider: { type: 'string', description: 'Optional. The user-selected provider; validated against the picker, never switched.' },
          params: {
            type: 'object', additionalProperties: true,
            description: 'Optional workflow params from mo_image_settings; omit unneeded ones (defaults apply); unsupported keys are ignored and reported.'
          },
          resume_job_id: { type: 'string', description: 'Optional. Resume a previously submitted async job by its jobId; no new submission is made. Leave prompt/images out unless you are starting a new task.' }
        }
      },
      output, timeoutMs: 360000,
      async execute(args, exec) {
        // 一次工具调用只读一次配置：交接判断和真正的请求共用同一份快照。
        const config = await readConfig(store);
        // 恢复入口不重新提交，也不要求先读 settings。
        if (String((args && args.resume_job_id) || '').trim()) {
          const result = await resumeImageJob(args, exec, store, config, imageQueue, jobJournal);
          presentImage(exec, result);
          return imagePayload(result);
        }
        const handoff = settingsHandoff(exec, undefined, config);
        if (handoff) return handoff;
        const run = async () => {
          const result = await generate(args, exec, store, config, imageQueue, jobJournal);
          presentImage(exec, result);
          return imagePayload(result);
        };
        const key = invocationKey(exec, 'generate');
        // 脚本入口没有稳定 callId：不去重，比猜一个身份更安全。
        if (!key) return run();
        const outcome = await callRegistry.run(key, invocationFingerprint('generate', args, config), run);
        return outcome.value;
      }
    });
  } catch (error) { logHost('generate tool register error: ' + String(error)); }

  try {
    ctx.tools.register({
      name: 'mo_image_edit',
      description: 'Edit or refine existing images. If 配置状态 says the settings read is missing or stale, call mo_image_settings first: this tool then returns needsSettings and edits nothing. With current settings: optimization is Off → use the user\'s original edit wording unchanged; On → pick fitting params and say what changed. Model and quality come from the picker; pass size only when settings report sizeMode "auto"; in Auto mode omit model or pass one id from editModels. Name references 图1/图2. For a full redo that must not copy the current image, use mo_image_generate. Load mo-image-editing skill once; when optimization is Off use its invocation guidance only. Reply with the returned Markdown image line. Output is final: never judge/describe the image, never switch provider/model/tool, and do not open it unless asked. On failure report the error verbatim and at most ask whether to switch.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Final edit prompt: name each reference (图1/图2); state exactly what changes and that everything else stays.' },
          images: { type: 'array', items: { type: 'string' }, description: '1–16 absolute local paths or http(s) URLs, in 图1/图2 order.' },
          negative_prompt: { type: 'string', description: 'Optional; only for models that support it. Artifacts/elements to avoid.' },
          size: { type: 'string', description: 'Optional shape like "1024x1536"; only when settings report sizeMode "auto" and the user asked; ignored when the picker pins the size.' },
          model: { type: 'string', description: 'Optional outside Auto mode. In Auto mode omit it (first edit-capable model) or pass one id from editModels; non-editing models are rejected.' },
          provider: { type: 'string', description: 'Optional. The user-selected provider; validated against the picker, never switched.' },
          params: {
            type: 'object', additionalProperties: true,
            description: 'Optional workflow params from mo_image_settings; omit unneeded ones (defaults apply); unsupported keys are ignored and reported.'
          },
          resume_job_id: { type: 'string', description: 'Optional. Resume a previously submitted async job by its jobId; no new submission is made. Leave prompt/images out unless you are starting a new task.' }
        }
      },
      output, timeoutMs: 360000,
      async execute(args, exec) {
        // 同 generate：交接判断与请求共用一份配置快照。
        const config = await readConfig(store);
        if (String((args && args.resume_job_id) || '').trim()) {
          const result = await resumeImageJob(args, exec, store, config, imageQueue, jobJournal);
          presentImage(exec, result);
          return imagePayload(result);
        }
        const handoff = settingsHandoff(exec, 'edit', config);
        if (handoff) return handoff;
        const run = async () => {
          const result = await edit(args, exec, store, config, imageQueue, jobJournal);
          presentImage(exec, result);
          return imagePayload(result);
        };
        const key = invocationKey(exec, 'edit');
        if (!key) return run();
        const outcome = await callRegistry.run(key, invocationFingerprint('edit', args, config), run);
        return outcome.value;
      }
    });
  } catch (error) { logHost('edit tool register error: ' + String(error)); }
}
