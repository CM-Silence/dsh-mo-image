/**
 * 上游生图任务的全局并发队列。
 *
 * 为什么要有这一层：
 * - 一次生图在上游动辄几十秒，而工具调用可以并发；不设上限就会同时开满请求，
 *   既容易被供应商限流，也把内存与连接一起顶高。所以全局最多同时跑 `concurrency` 个。
 * - 排队不能无上限：每个等待者都还牵着请求上下文和 signal，无限排队等于无限吃内存，
 *   并且用户需要一个明确的「现在满了」。所以 `maxWaiting` 满了立刻拒绝并给出原因。
 * - 取消必须立刻生效：用户点了取消还挂在队列里等空位，等于取消按钮失灵；所以排队期间
 *   监听 signal，abort 时把自己从队列里摘掉，不占并发槽也不占排队名额。
 *
 * 调度只靠「入队 + release 时唤醒」，不用定时器轮询：空位只会在 release（或 abort
 * 出队）时出现，轮询不会让空位更早出现，只会白烧 CPU 并给启动加上最多一个间隔的延迟。
 */

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_WAITING = 8;

/**
 * 把配置收敛成正整数。
 *
 * 设置项可能来自用户输入（`"0"`、负数、NaN）。如果直接参与比较，并发 0 会让所有任务
 * 永远排队，负数会让「有空位」永远不成立；这里统一回落到默认值，宁可慢一点也不能卡死。
 * @param {unknown} value 原始配置值。
 * @param {number} fallback 不合法时使用的默认值。
 * @returns {number} 正整数。
 */
function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 1 ? number : fallback;
}

/**
 * 排队被取消时的错误。
 *
 * 用 name 而不是 instanceof/DOMException：上层（retry.js 的 `isAbortError`）按 name/code
 * 识别取消，而 DOMException 在部分宿主里不可用、也不好断言。
 * @returns {Error}
 */
function abortError() {
  const error = new Error('生图任务等待已被取消');
  error.name = 'AbortError';
  error.code = 'queue_aborted';
  return error;
}

/**
 * 排队队列已满时的错误。
 *
 * 文案必须带上当前的两个上限：调用方和模型据此判断是「等一等再试」而不是「请求坏了」。
 * @param {number} concurrency 并发上限。
 * @param {number} maxWaiting 排队上限。
 * @returns {Error}
 */
function queueFullError(concurrency, maxWaiting) {
  const error = new Error(
    `上游生图任务队列已满：并发上限 ${concurrency}，排队上限 ${maxWaiting}，请等前面的任务完成后再试`
  );
  error.code = 'queue_full';
  return error;
}

/** reset() 丢弃等待者时的错误；只用于测试收尾，避免把上一轮的等待者带进下一轮。 */
function resetError() {
  const error = new Error('生图任务队列已被重置');
  error.code = 'queue_reset';
  return error;
}

/**
 * 创建一条并发队列。
 * @param {{concurrency?:number,maxWaiting?:number}} [options]
 * @returns {{acquire:(signal?:AbortSignal)=>Promise<()=>void>,stats:()=>{active:number,waiting:number,concurrency:number,maxWaiting:number},reset:()=>void}}
 */
export function createImageQueue(options = {}) {
  const source = options || {};
  const concurrency = positiveInteger(source.concurrency, DEFAULT_CONCURRENCY);
  const maxWaiting = positiveInteger(source.maxWaiting, DEFAULT_MAX_WAITING);

  /** 当前被占用的并发槽位数，恒满足 0 <= active <= concurrency。 */
  let active = 0;
  /** FIFO 等待队列：数组头是最早的等待者，保证先来先跑。 */
  const waiting = [];
  /**
   * 代次。reset() 会加一，用来让上一轮遗留的 release 失效：
   * 否则上一轮的 release 会减掉新一轮的占用，把别人的槽位「偷」走。
   */
  let generation = 0;

  /**
   * 占用一个槽位并返回幂等的释放函数。
   * @param {number} leaseGeneration 这次占用的代次。
   * @returns {() => void}
   */
  function grant(leaseGeneration) {
    active += 1;
    let released = false;
    return function release() {
      // 幂等：重复 release 不能再减计数、更不能多唤醒一个等待者。
      if (released) return;
      released = true;
      // reset() 之后的旧租约已经没有对应槽位了，直接作废。
      if (leaseGeneration !== generation) return;
      active = Math.max(0, active - 1);
      pump();
    };
  }

  /**
   * 把空位发给最早的等待者。
   * 每次 release 通常只有一个空位，所以这里通常只唤醒一个；用循环是为了
   * reset()/异常路径之后队列不会因为计数漂移而永远卡住。
   */
  function pump() {
    while (active < concurrency && waiting.length > 0) {
      const waiter = waiting.shift();
      // 已被 abort/reset 结算过的等待者不能再执行一次。
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.detach();
      waiter.resolve(grant(waiter.generation));
    }
  }

  /**
   * 申请一个并发槽位。
   * @param {AbortSignal} [signal] 取消信号；排队期间 abort 会立即出队并 reject。
   * @returns {Promise<() => void>} 成功时给出释放函数（reject 不带释放函数）。
   */
  function acquire(signal) {
    // 已经取消的请求不该占位：连排队都不进，否则既占名额又要马上摘掉。
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (active < concurrency) return Promise.resolve(grant(generation));
    if (waiting.length >= maxWaiting) return Promise.reject(queueFullError(concurrency, maxWaiting));

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        settled: false,
        generation,
        // 默认什么都不用摘，signal 不支持事件监听时保持安静。
        detach: () => {}
      };

      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.detach();
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          // 不必 pump：这个等待者从没拿到过槽位，空位还在原处，队列顺序也不用变。
          reject(abortError());
        };
        waiter.detach = () => {
          if (typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      waiting.push(waiter);
    });
  }

  /** 当前队列状态快照（每次返回新对象，调用方改不动内部计数）。 */
  function stats() {
    return { active, waiting: waiting.length, concurrency, maxWaiting };
  }

  /**
   * 复位队列，仅供测试使用。
   *
   * 测试之间共享同一个 `defaultImageQueue` 时，上一个用例漏掉的占用与等待者会污染
   * 下一个用例；这里把它们统一结算掉。先推进代次再清空，保证旧租约的 release 失效。
   */
  function reset() {
    generation += 1;
    const dropped = waiting.splice(0, waiting.length);
    for (const waiter of dropped) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.detach();
      waiter.reject(resetError());
    }
    active = 0;
  }

  return { acquire, stats, reset };
}

/** 整个插件共用的队列：上游并发是全局资源，按实例共享才有意义。 */
export const defaultImageQueue = createImageQueue();
