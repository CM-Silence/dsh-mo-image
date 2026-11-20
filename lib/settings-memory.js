import { createHash } from 'node:crypto';
import { stableStringify } from './image-request.js';
import { settingsForModel } from './prompt-profiles.js';

export const SETTINGS_REFRESH_TURNS = 8;
const MAX_CANDIDATE_READS = 512;

export function settingsSnapshot(payload, signature) {
  const visible = settingsForModel(payload);
  // Keep field digests per session. Large catalogs and parameter lists stay in the live view.
  const fields = new Map();
  for (const [key, value] of Object.entries(visible)) {
    if (value !== undefined) fields.set(key, createHash('sha256').update(stableStringify(value)).digest('hex'));
  }
  return { payload, visible, signature: signature ?? createHash('sha256').update(stableStringify([...fields])).digest('hex'), fields };
}

function contextPosition(ctx, session) {
  let turn;
  try {
    const boundary = ctx.get?.('agents')?.turnBoundaryOf?.(session)
      ?? ctx.get?.('sessionProjections')?.stateOf(session, 'turnBoundary');
    if (Number.isSafeInteger(boundary?.lastTurn)) turn = boundary.lastTurn;
  } catch { /* The host projection is optional. */ }
  // Replacements and tool-result projections can invalidate a baseline without changing the turn.
  const surface = session.surface;
  const generation = surface?.contentGeneration ?? surface?.replaceGeneration;
  return { turn, generation: Number.isSafeInteger(generation) ? generation : undefined };
}

function readingState(previous, signature, position) {
  if (!previous) return 'unread';
  const { checkpoint } = previous;
  if (position.generation !== checkpoint.generation || position.fallback !== checkpoint.fallback
    || position.count < checkpoint.count || position.count - checkpoint.count >= SETTINGS_REFRESH_TURNS) return 'refresh';
  return previous.signature === signature ? 'fresh' : 'stale';
}

function diffSettings(previous, current) {
  const changes = {};
  const removed = [];
  for (const [key, digest] of current.fields) {
    if (previous.fields.get(key) !== digest) changes[key] = current.visible[key];
  }
  for (const key of previous.fields.keys()) {
    if (!current.fields.has(key)) removed.push(key);
  }
  return { changes, removed };
}

export function createSettingsMemory(ctx) {
  const sessions = new WeakMap();
  const countedSteps = new WeakSet();

  function position(session, memory, step, advance) {
    const { turn, generation } = contextPosition(ctx, session);
    if (turn !== undefined) return { count: turn, generation, fallback: false };
    // Legacy hosts: count uses of the image tools, once per available host step.
    if (advance) {
      if (step && typeof step === 'object') {
        if (!countedSteps.has(step)) { countedSteps.add(step); memory.uses++; }
      } else {
        memory.uses++;
      }
    }
    return { count: memory.uses, generation, fallback: true };
  }

  function state(session, signature) {
    const memory = sessions.get(session);
    return memory ? readingState(memory.settings, signature, position(session, memory)) : 'unread';
  }

  function read(session, current, { step, refresh = false, candidate = false, onlyIfNeeded = false } = {}) {
    if (!session || typeof session !== 'object') return { state: 'unread', reply: { ...current.payload, revision: 1 } };
    let memory = sessions.get(session);
    if (!memory) {
      memory = { uses: 0, settings: null, candidates: new Map() };
      sessions.set(session, memory);
    }
    const now = position(session, memory, step, true);
    const key = candidate ? JSON.stringify([current.payload.provider, current.payload.model]) : '';
    const previous = candidate ? memory.candidates.get(key) : memory.settings;
    const status = readingState(previous, current.signature, now);
    const full = refresh || status === 'unread' || status === 'refresh';
    const revision = (previous?.revision || 0) + Number(previous?.signature !== current.signature);
    let reply;
    if (full) {
      reply = { ...current.payload, revision };
    } else if (status === 'stale') {
      const { changes, removed } = diffSettings(previous, current);
      // Some request changes affect only on-demand candidate details or upstream behavior.
      reply = {
        baseRevision: previous.revision, revision, changes,
        ...(removed.length ? { removed } : {}),
        ...(candidate ? { model: current.payload.model } : {}),
        hint: current.payload.model === 'auto'
          ? '应用变更；需要候选细节时查询所选模型。'
          : '应用变更，保留其余字段。'
      };
    } else {
      if (onlyIfNeeded) return { state: status, reply: null };
      return { state: status, reply: { ...(candidate ? { model: current.payload.model } : {}), unchanged: true, hint: '配置没变。' } };
    }
    const saved = { signature: current.signature, fields: current.fields, revision, checkpoint: full ? now : previous.checkpoint };
    if (candidate) {
      memory.candidates.delete(key);
      memory.candidates.set(key, saved);
      if (memory.candidates.size > MAX_CANDIDATE_READS) memory.candidates.delete(memory.candidates.keys().next().value);
    } else {
      memory.settings = saved;
    }
    return { state: status, reply };
  }

  return { state, read };
}
