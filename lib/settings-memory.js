/**
 * 「这个会话看到的配置有没有变」：按会话记住上一次读到的配置快照。
 *
 * 比较的是快照，不是变更次数：用户把某个值改了又改回去、中间没有对话时，
 * 快照与上次相同，仍然算「没有变化」，不会白白作废一次读取。
 *
 * 快照挂在 session 对象上（WeakMap），所以天然不跨会话共享：新会话没有快照，
 * 状态是 unread，要读一次才放行。
 */
const snapshots = new WeakMap();
const modelReads = new WeakMap();
const MAX_MODEL_READS = 512;

/** 配置快照：settings 返回给模型的那份 payload 的稳定文本。 */
export function settingsSignature(payload) {
  return JSON.stringify(payload || {});
}

/** 记下这个会话刚刚看到的配置。 */
export function rememberSettings(session, signature) {
  // WeakMap 只接受对象键：宿主要么给 Session 实例，要么什么都不给；给字符串时安静忽略。
  if (!session || typeof session !== 'object') return;
  if (typeof signature !== 'string') return;
  snapshots.set(session, signature);
}

/**
 * @returns {'unread'|'fresh'|'stale'} unread = 本会话还没读过；fresh = 和上次读到的一致；stale = 配置改过
 */
export function settingsState(session, signature) {
  if (!session || typeof session !== 'object') return 'unread';
  const last = snapshots.get(session);
  if (last === undefined) return 'unread';
  return last === signature ? 'fresh' : 'stale';
}

/** Candidate reads don't mark the full catalog as read. */
export function recordModelSettingsRead(session, signature, model) {
  if (!session || typeof session !== 'object') return false;
  let reads = modelReads.get(session);
  if (!reads) {
    reads = new Map();
    modelReads.set(session, reads);
  }
  const seen = reads.get(model) === signature;
  reads.delete(model);
  reads.set(model, signature);
  if (reads.size > MAX_MODEL_READS) reads.delete(reads.keys().next().value);
  return seen;
}
