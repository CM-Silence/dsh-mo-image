import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageQueue, defaultImageQueue } from '../lib/image-queue.js';

/**
 * 冲刷一轮微任务。
 *
 * 队列的唤醒全部发生在 Promise 里，`await Promise.resolve()` 只前进一个微任务，
 * 断言「还没人启动」时容易假绿；用 setImmediate 等一个宏任务，微任务队列一定清空。
 * 这不是定时器轮询，只是测试里的确定同步点。
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an acquire takes a free slot immediately', async () => {
  const queue = createImageQueue({ concurrency: 2, maxWaiting: 8 });
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 2, maxWaiting: 8 });

  const release = await queue.acquire();
  assert.deepEqual(queue.stats(), { active: 1, waiting: 0, concurrency: 2, maxWaiting: 8 });

  release();
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 2, maxWaiting: 8 });
});

test('a third acquire waits while the concurrency limit is two', async () => {
  const queue = createImageQueue({ concurrency: 2, maxWaiting: 8 });
  const holders = [];
  let peak = 0;
  const grab = async () => {
    const release = await queue.acquire();
    holders.push(release);
    peak = Math.max(peak, queue.stats().active);
    return release;
  };

  const first = grab();
  const second = grab();
  const third = grab();
  await flush();

  // 前两个占住槽位，第三个必须停在队列里，而不是拿到一个「超发」的槽位。
  assert.equal(holders.length, 2);
  assert.deepEqual(queue.stats(), { active: 2, waiting: 1, concurrency: 2, maxWaiting: 8 });
  assert.equal(peak, 2);

  holders[0]();
  await third;
  assert.equal(holders.length, 3);
  assert.deepEqual(queue.stats(), { active: 2, waiting: 0, concurrency: 2, maxWaiting: 8 });
  // 释放一个才启动一个：全程同时活着的占用没有超过上限。
  assert.equal(peak, 2);

  for (const release of holders) release();
  await first;
  await second;
  assert.equal(queue.stats().active, 0);
});

test('waiters start in the order they asked', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 8 });
  const held = await queue.acquire();
  const started = [];
  const waiting = [0, 1, 2].map((index) => queue.acquire().then((release) => {
    started.push(index);
    return release;
  }));

  await flush();
  assert.deepEqual(started, [], '没有 release 就不该有人启动');

  held();
  const release0 = await waiting[0];
  assert.deepEqual(started, [0]);

  release0();
  const release1 = await waiting[1];
  assert.deepEqual(started, [0, 1]);

  release1();
  const release2 = await waiting[2];
  assert.deepEqual(started, [0, 1, 2]);

  release2();
  assert.equal(queue.stats().active, 0);
});

test('a full waiting queue rejects with queue_full without burning a slot', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 2 });
  const held = await queue.acquire();
  const queued = [queue.acquire(), queue.acquire()];

  await assert.rejects(queue.acquire(), (error) => {
    assert.equal(error.code, 'queue_full');
    // 文案要能说明是「并发/排队上限」卡住了，而不是泛泛的失败。
    assert.match(error.message, /并发/);
    assert.match(error.message, /排队/);
    return true;
  });
  // 被拒绝的那次不能改变任何计数：槽位仍被占着，两个等待者还在排队。
  assert.deepEqual(queue.stats(), { active: 1, waiting: 2, concurrency: 1, maxWaiting: 2 });

  held();
  const [first, second] = queued;
  (await first)();
  (await second)();
  assert.equal(queue.stats().active, 0);
});

test('aborting a queued acquire rejects it and keeps the slot free', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 4 });
  const held = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal);
  await flush();
  assert.equal(queue.stats().waiting, 1);

  controller.abort();
  await assert.rejects(waiting, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'queue_aborted');
    return true;
  });
  // 等待者已经出队：不占并发槽，也不占排队名额。
  assert.deepEqual(queue.stats(), { active: 1, waiting: 0, concurrency: 1, maxWaiting: 4 });

  // 后续 acquire 仍然正常：先排队，槽位释放时启动。
  const next = queue.acquire();
  await flush();
  assert.equal(queue.stats().waiting, 1);
  held();
  const releaseNext = await next;
  assert.equal(queue.stats().active, 1);
  releaseNext();
  assert.equal(queue.stats().active, 0);
});

test('an aborted waiter frees its waiting slot for the next caller', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 1 });
  const held = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal);

  // 排队名额只有 1，现在被上面那次占满。
  await assert.rejects(queue.acquire(), (error) => error.code === 'queue_full');

  controller.abort();
  await assert.rejects(waiting, (error) => error.code === 'queue_aborted');

  // 摘掉之后名额立刻回到可用的 1 个，不该还要等别人释放。
  const next = queue.acquire();
  await flush();
  assert.deepEqual(queue.stats(), { active: 1, waiting: 1, concurrency: 1, maxWaiting: 1 });

  held();
  (await next)();
  assert.equal(queue.stats().active, 0);
});

test('release is idempotent and wakes exactly one waiter', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 4 });
  const held = await queue.acquire();
  const waitingOne = queue.acquire();
  const waitingTwo = queue.acquire();
  await flush();
  assert.equal(queue.stats().waiting, 2);

  held();
  held();
  // 同一个 release 再调一次，不能把并发顶到 2，也不能多唤醒一个等待者。
  const releaseOne = await waitingOne;
  assert.deepEqual(queue.stats(), { active: 1, waiting: 1, concurrency: 1, maxWaiting: 4 });

  releaseOne();
  const releaseTwo = await waitingTwo;
  assert.deepEqual(queue.stats(), { active: 1, waiting: 0, concurrency: 1, maxWaiting: 4 });

  releaseTwo();
  releaseTwo();
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 1, maxWaiting: 4 });
});

test('an already aborted signal takes no slot', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 1 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(queue.acquire(controller.signal), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'queue_aborted');
    return true;
  });
  // 槽位和排队名额都没被占：还能立刻拿到并发，也还能排一个。
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 1, maxWaiting: 1 });

  const held = await queue.acquire();
  assert.equal(queue.stats().active, 1);
  const queued = queue.acquire();
  await flush();
  assert.equal(queue.stats().waiting, 1);

  held();
  (await queued)();
  assert.equal(queue.stats().active, 0);
});

test('reset rejects the queued waiters and clears the counters', async () => {
  const queue = createImageQueue({ concurrency: 1, maxWaiting: 2 });
  const stale = await queue.acquire();
  const queued = queue.acquire();

  queue.reset();
  await assert.rejects(queued, (error) => {
    assert.equal(error.code, 'queue_reset');
    return true;
  });
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 1, maxWaiting: 2 });

  // reset 之后队列还能用；上一轮的 release 不能偷走新一轮的槽位。
  const held = await queue.acquire();
  stale();
  assert.deepEqual(queue.stats(), { active: 1, waiting: 0, concurrency: 1, maxWaiting: 2 });

  held();
  assert.equal(queue.stats().active, 0);
});

test('the defaults are two slots and eight waiters', () => {
  const queue = createImageQueue();
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, concurrency: 2, maxWaiting: 8 });

  // 配置可能来自用户设置（0、负数、NaN）：收敛回默认值，否则并发判断会失效。
  const normalized = createImageQueue({ concurrency: 0, maxWaiting: -1 });
  assert.deepEqual(normalized.stats(), { active: 0, waiting: 0, concurrency: 2, maxWaiting: 8 });

  // 字符串数字（设置项常见形态）按数字用。
  assert.equal(createImageQueue({ concurrency: '1' }).stats().concurrency, 1);
});

test('the shared default queue starts idle', () => {
  assert.deepEqual(
    defaultImageQueue.stats(),
    { active: 0, waiting: 0, concurrency: 2, maxWaiting: 8 }
  );
  assert.equal(typeof defaultImageQueue.acquire, 'function');
  assert.equal(typeof defaultImageQueue.reset, 'function');
});
