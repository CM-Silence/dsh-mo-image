/**
 * 工具调用身份 + 请求指纹的内存注册表（OPTIMIZATION_PLAN 阶段 C1 的最小实现）。
 *
 * 为什么需要它：一次生成/编辑是一笔要花钱的远端任务。宿主会重放工具调用
 * （用户重试、客户端重发、Agent 在同一个 callId 上再调一次），这些重放不能
 * 变成第二次提交。判断依据只能是两个：
 *
 * - `key`：谁在调（会话 ID + callId）。同一个 key 指同一次工具调用。
 * - `fingerprint`：调的是什么（有效请求摘要 / 语义指纹）。同一个 key 换了请求，
 *   就不是重放，而是「同一个身份挂了两份请求」。
 *
 * 于是规则只有三条：
 *
 * 1. 同 key 同指纹：第一次真跑，后来的等它（进行中）或直接拿它的结果（已完成）。
 * 2. 同 key 不同指纹：报 `call_conflict`，绝不复用旧结果——否则会把 A 请求的结果
 *    当成 B 请求的交付物送出去，比重复提交更难查。
 * 3. 失败不缓存：错误不是结果，同 key 必须还能重试。
 *
 * 只在内存里：进程重启后的恢复靠任务日志（阶段 C2），这里不做持久化，也不做跨进程去重。
 * 只缓存 task 的返回值，不持有 task 闭包、参数或请求体：让一条缓存的大小等于「结果」
 * 而不是「一次完整的请求」。
 */
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 完成态结果的默认存活时间：覆盖一次工具调用的常用重放窗口，又不至于把结果按整天钉在内存里。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 默认容量上限：远大于同时进行的任务数，纯粹用来兜住「调用身份泄漏」时的内存增长。 */
const DEFAULT_MAX_ENTRIES = 200;

function identityError(field) {
  // 用 TypeError 而不是普通 Error：这是调用方传错了值，不是运行时条件。
  const error = new TypeError(`${field} 必须是非空字符串：调用身份和请求指纹是去重的唯一依据`);
  error.code = 'invalid_call_identity';
  return error;
}

function taskError() {
  // 没有 task 就没有结果可缓存；放过去会往表里塞一条永远为 undefined 的条目。
  const error = new TypeError('task 必须是函数');
  error.code = 'invalid_task';
  return error;
}

function conflictError(key) {
  // 消息说清楚「同一个工具调用携带了不同请求」：看到这条日志的人要能立刻判断
  // 是宿主重放变了请求内容，还是上层把两个请求拼成了同一个 key。
  const error = new Error(`工具调用 ${key} 已经携带过不同的请求（请求指纹不一致），拒绝复用旧结果`);
  error.code = 'call_conflict';
  return error;
}

function readTtlMs(value) {
  if (value === undefined) return DEFAULT_TTL_MS;
  const ttlMs = Number(value);
  // 负数会让「刚存下的结果立刻过期」，语义混乱；0 是允许的，表示只做进行中合并、不缓存完成态。
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('ttlMs 必须是 >= 0 的有限毫秒数');
  }
  return ttlMs;
}

function readMaxEntries(value) {
  if (value === undefined) return DEFAULT_MAX_ENTRIES;
  const maxEntries = Number(value);
  // 小于 1 就没有容量可言（刚插入就淘汰），属于配置错误而不是「关掉缓存」。
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries 必须是 >= 1 的整数');
  }
  return maxEntries;
}

function readNow(value) {
  if (value === undefined) return Date.now;
  if (typeof value !== 'function') throw new TypeError('now 必须是返回毫秒数的函数');
  return value;
}

/**
 * 建一个注册表。每个插件实例一个，彼此不共享状态（否则卸载后还能互相串结果）。
 *
 * @param {{ttlMs?:number,maxEntries?:number,now?:()=>number}} [options]
 *   ttlMs 完成态结果的存活时间（默认 10 分钟）；maxEntries 条目上限（默认 200）；
 *   now 可注入的时钟，TTL 测试用。
 * @returns {{run:(key:string,fingerprint:string,task:()=>unknown)=>Promise<{value:unknown,reused:boolean}>,clear:()=>void,size:()=>number}}
 */
export function createCallRegistry(options = {}) {
  const source = options || {};
  const ttlMs = readTtlMs(source.ttlMs);
  const maxEntries = readMaxEntries(source.maxEntries);
  const now = readNow(source.now);

  /**
   * key -> 条目。`state` 只有两种：pending（task 正在跑）和 settled（结果可复用）。
   * 不用「value 有没有值」判断状态：task 返回 undefined 也是合法结果。
   */
  const entries = new Map();

  function isExpired(entry) {
    // 只让完成态过期。进行中的条目一旦过期，第二个同 key 请求就会被放进来跑第二遍，
    // 正好撞破这个注册表存在的理由（重复提交）。进行中的任务有自己的 deadline，
    // 不会永远挂在这里。
    return entry.state === 'settled' && now() - entry.settledAt >= ttlMs;
  }

  function sweepExpired() {
    // 只在插入路径上全表扫：条目数被 maxEntries 压住，成本可忽略；
    // 而访问路径只处理自己那个 key，不必每次调用都 O(n)。
    for (const [key, entry] of entries) {
      if (isExpired(entry)) entries.delete(key);
    }
  }

  function evictOverflow() {
    // Map 保留插入顺序，最前面就是最旧的条目；超过上限时从最旧的开始淘汰。
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  function start(key, fingerprint, task) {
    sweepExpired();

    const entry = {
      fingerprint,
      state: 'pending',
      // 只在 pending 期间持有 promise（它牵着 task 闭包）；settle 后置空。
      promise: null,
      value: undefined,
      settledAt: 0
    };
    entries.set(key, entry);

    // task 放到微任务里启动：run() 返回时这条登记已经完整，
    // 万一 task 同步地又调了一次 run（病态但可能），它看到的是「进行中」而不是再开一次。
    const shared = new Promise((resolve, reject) => {
      Promise.resolve().then(task).then(resolve, reject);
    });
    entry.promise = shared;

    // 清理挂在调用方的 then 之前注册，等第一个等待者被唤醒时条目已经是 settled，
    // 它在同一个 tick 里再调 run 就能直接命中缓存。
    shared.then(
      (value) => {
        // 只留返回值：promise 链上还挂着 task 闭包和它的入参，settle 之后没有理由继续持有。
        entry.state = 'settled';
        entry.value = value;
        entry.promise = null;
        entry.settledAt = now();
      },
      () => {
        entry.promise = null;
        // 失败不缓存：删掉占位，下一次同 key 才能重新执行。
        // 等待者各自通过 shared 拿到同一个错误实例（同一个对象，便于上层按 cause 判断）。
        if (entries.get(key) === entry) entries.delete(key);
      }
    );
    evictOverflow();

    // 第一个调用者拿到了 reused:false：任务确实是它触发的。
    return shared.then((value) => ({ value, reused: false }));
  }

  /**
   * 按「调用身份 + 请求指纹」复用执行。
   *
   * @param {string} key 工具调用身份（会话 ID + callId），必须是非空字符串。
   * @param {string} fingerprint 有效请求摘要，必须是非空字符串。
   * @param {() => unknown} task 真正执行任务的函数，只在需要时调用一次。
   * @returns {Promise<{value:unknown,reused:boolean}>} reused=true 表示这次没有执行 task。
   */
  function run(key, fingerprint, task) {
    // 非法输入统一走 rejection：调用方只需要一条 try/await 的错误路径，
    // 不会出现「有的错同步抛、有的错异步拒绝」这种两套接法。
    if (typeof key !== 'string' || key.length === 0) return Promise.reject(identityError('key'));
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      return Promise.reject(identityError('fingerprint'));
    }
    if (typeof task !== 'function') return Promise.reject(taskError());

    const existing = entries.get(key);
    if (existing) {
      if (isExpired(existing)) {
        // 过期就是没有：删掉再走新建，指纹也随新请求重新绑定。
        entries.delete(key);
      } else if (existing.fingerprint !== fingerprint) {
        // 同一个调用身份配两份不同请求：宁可失败，也不能把旧结果当成新请求的答案。
        return Promise.reject(conflictError(key));
      } else if (existing.state === 'settled') {
        return Promise.resolve({ value: existing.value, reused: true });
      } else {
        // 进行中：只等那一次执行，自己的 task 不跑。每个等待者拿到自己的结果信封，
        // 所以 reused 能按调用者区分（第一个 false、共享者 true），底层执行仍是同一份。
        return existing.promise.then((value) => ({ value, reused: true }));
      }
    }
    return start(key, fingerprint, task);
  }

  function clear() {
    // 只丢登记，不取消进行中的任务：取消是任务自身 signal 的职责，
    // 这里能保证的是「清空之后同 key 会重新执行」。
    entries.clear();
  }

  function size() {
    // 不主动清理过期条目：size() 是 O(1) 的观测接口，清理交给 run 的访问/插入路径。
    return entries.size;
  }

  return { run, clear, size };
}

/* --------------------------------------------------------------- 任务日志 */

/** 任务 id 会拼进文件名，只允许安全字符，避免 `../` 把状态目录写到外面。 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function validJobId(id) {
  return typeof id === 'string' && JOB_ID_PATTERN.test(id);
}

/**
 * 创建任务日志（OPTIMIZATION_PLAN 阶段 C2 的最小落盘实现）。
 *
 * 一次生图在提交后进程重启，内存里的 Promise 已经不存在了；只有把
 * 「远端任务 id / 轮询地址 / 恢复所需的参数」写进磁盘，恢复入口才能继续查。
 * 写入必须原子：临时文件 + rename，避免重启时读到半截 JSON。
 *
 * @param {{dir:string,now?:()=>number}} options
 */
export function createJobJournal(options = {}) {
  const source = options || {};
  const dir = String(source.dir || '').trim();
  if (!dir) throw new TypeError('任务日志需要非空的 dir');
  const now = typeof source.now === 'function' ? source.now : Date.now;
  // 所有写操作串行：update 是「读-改-写」，并发更新不串行会丢字段。
  let writeChain = Promise.resolve();

  function enqueue(task) {
    const next = writeChain.then(task, task);
    // 前一个失败不能毒化后面的写：每个调用方仍然拿到自己的错误。
    writeChain = next.catch(() => {});
    return next;
  }

  function fileOf(id) {
    return path.join(dir, id + '.json');
  }

  async function readRecord(id) {
    if (!validJobId(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(fileOf(id), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  async function writeRecord(record) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, '.' + record.id + '.' + process.pid + '.' + randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmp, fileOf(record.id));
  }

  /** 新建一条任务记录；调用方负责决定 id 之前的字段，id/时间戳由日志统一生成。 */
  function create(record) {
    return enqueue(async () => {
      const stamp = now();
      const id = randomUUID();
      const next = Object.assign({}, record, { id: id, createdAt: stamp, updatedAt: stamp });
      await writeRecord(next);
      return next;
    });
  }

  /** 合并更新；记录不存在时返回 null（恢复入口据此报「找不到任务」）。 */
  function update(id, patch) {
    return enqueue(async () => {
      const current = await readRecord(id);
      if (!current) return null;
      const next = Object.assign({}, current, patch, {
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: now()
      });
      await writeRecord(next);
      return next;
    });
  }

  /** 读取单条记录；坏 JSON/不存在都返回 null。 */
  function get(id) {
    return readRecord(id);
  }

  /** 清掉超过保留期的记录；返回删除条数。 */
  function prune(maxAgeMs) {
    return enqueue(async () => {
      const limit = Math.max(0, Number(maxAgeMs) || 0);
      let names = [];
      try {
        names = await readdir(dir);
      } catch (_error) {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        const record = await readRecord(id);
        if (!record) {
          // 半截/损坏的记录没有恢复价值，顺手清掉。
          try { await unlink(path.join(dir, name)); removed += 1; } catch (_error) { /* ignore */ }
          continue;
        }
        const stamp = Number(record.updatedAt || record.createdAt || 0);
        if (limit > 0 && now() - stamp > limit) {
          try { await unlink(path.join(dir, name)); removed += 1; } catch (_error) { /* ignore */ }
        }
      }
      return removed;
    });
  }

  return { create, update, get, prune };
}
