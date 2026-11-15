import test from 'node:test';
import assert from 'node:assert/strict';

import { createCallRegistry } from '../lib/image-jobs.js';

/** 手动决定何时完成的任务闸门：把一次执行按在「进行中」，才观察得到并发去重。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 可拨动的时钟：TTL 测试不用真等十分钟。 */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

/** 取出 rejection 里的错误对象，好同时断言 code 和 message。 */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('预期这个 Promise 会 reject，但它成功了');
}

test('two concurrent calls with the same identity and fingerprint run the task once', async () => {
  const registry = createCallRegistry();
  const gate = deferred();
  let ownerRuns = 0;
  let sharerRuns = 0;

  const owner = registry.run('session-1#call-1', 'fp-abc', async () => {
    ownerRuns += 1;
    await gate.promise;
    return { path: 'a.png' };
  });
  // 第二个调用带相同的请求指纹：它自己的 task 不该被执行，只能等第一次执行。
  const sharer = registry.run('session-1#call-1', 'fp-abc', async () => {
    sharerRuns += 1;
    return { path: 'b.png' };
  });
  gate.resolve();

  const [first, second] = await Promise.all([owner, sharer]);
  assert.equal(ownerRuns, 1);
  assert.equal(sharerRuns, 0);
  // 第一个调用者自己触发了执行 → reused:false；后来的只是共享这次执行 → reused:true。
  assert.deepEqual(first, { value: { path: 'a.png' }, reused: false });
  assert.deepEqual(second, { value: { path: 'a.png' }, reused: true });
  assert.equal(registry.size(), 1);
});

test('deduplication also covers a task that returns a plain value', async () => {
  const registry = createCallRegistry();
  let runs = 0;
  const task = () => {
    runs += 1;
    return 'image';
  };

  const [first, second] = await Promise.all([
    registry.run('session-1#call-1', 'fp-abc', task),
    registry.run('session-1#call-1', 'fp-abc', task)
  ]);

  assert.equal(runs, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.value, 'image');
});

test('a settled identity is served from the cache instead of running again', async () => {
  const registry = createCallRegistry();
  let runs = 0;

  const first = await registry.run('session-1#call-1', 'fp-abc', async () => {
    runs += 1;
    return { path: 'a.png' };
  });
  const second = await registry.run('session-1#call-1', 'fp-abc', async () => {
    runs += 1;
    return { path: 'b.png' };
  });

  assert.equal(runs, 1);
  assert.deepEqual(first, { value: { path: 'a.png' }, reused: false });
  assert.deepEqual(second, { value: { path: 'a.png' }, reused: true });
});

test('the same identity with a different fingerprint is refused while the first run is in flight', async () => {
  const registry = createCallRegistry();
  const gate = deferred();
  let conflictingRuns = 0;

  const first = registry.run('session-1#call-1', 'fp-abc', async () => {
    await gate.promise;
    return 'first';
  });
  const error = await rejectionOf(registry.run('session-1#call-1', 'fp-xyz', async () => {
    conflictingRuns += 1;
    return 'second';
  }));

  assert.equal(error.code, 'call_conflict');
  assert.match(error.message, /不同/);
  assert.equal(conflictingRuns, 0);

  gate.resolve();
  // 冲突不能打断也别污染第一次执行。
  assert.deepEqual(await first, { value: 'first', reused: false });
  assert.equal(registry.size(), 1);
});

test('the same identity with a different fingerprint is refused after the result is cached', async () => {
  const registry = createCallRegistry();
  let runs = 0;

  await registry.run('session-1#call-1', 'fp-abc', async () => 'first');
  const error = await rejectionOf(registry.run('session-1#call-1', 'fp-xyz', async () => {
    runs += 1;
    return 'second';
  }));

  assert.equal(error.code, 'call_conflict');
  assert.match(error.message, /不同/);
  assert.equal(runs, 0);
  // 冲突之后原来的结果仍然可用，没有被替换成新请求的内容。
  assert.deepEqual(
    await registry.run('session-1#call-1', 'fp-abc', async () => 'other'),
    { value: 'first', reused: true }
  );
});

test('a different identity never shares a result', async () => {
  const registry = createCallRegistry();

  const one = await registry.run('session-1#call-1', 'fp-abc', async () => 'a');
  const two = await registry.run('session-1#call-2', 'fp-abc', async () => 'b');

  assert.deepEqual(one, { value: 'a', reused: false });
  assert.deepEqual(two, { value: 'b', reused: false });
  assert.equal(registry.size(), 2);
});

test('a failed task frees the identity for a retry and every waiter gets the same error', async () => {
  const registry = createCallRegistry();
  const gate = deferred();
  const boom = new Error('上游 500');

  const owner = registry.run('session-1#call-1', 'fp-abc', async () => {
    await gate.promise;
    throw boom;
  });
  const sharer = registry.run('session-1#call-1', 'fp-abc', async () => {
    await gate.promise;
    throw boom;
  });
  gate.reject(boom);

  const [one, two] = await Promise.all([rejectionOf(owner), rejectionOf(sharer)]);
  assert.equal(one, boom);
  assert.equal(two, boom);
  // 失败不缓存：占位必须清掉，否则这个 key 之后永远只能拿到同一个错误。
  assert.equal(registry.size(), 0);

  const retry = await registry.run('session-1#call-1', 'fp-abc', async () => 'recovered');
  assert.deepEqual(retry, { value: 'recovered', reused: false });
});

test('a task that throws synchronously is a rejection, not a synchronous throw', async () => {
  // run() 永不同步抛：上层只需要 try/await 一种接法，入口不会在参数校验之外突然炸掉。
  const registry = createCallRegistry();
  const boom = new Error('请求参数非法');

  const error = await rejectionOf(registry.run('session-1#call-1', 'fp-abc', () => {
    throw boom;
  }));

  assert.equal(error, boom);
  assert.equal(registry.size(), 0);
});

test('a cached result lives until the TTL deadline and is re-executed after it', async () => {
  const clock = fakeClock();
  const registry = createCallRegistry({ ttlMs: 1000, now: clock });
  let runs = 0;
  const task = async () => {
    runs += 1;
    return runs;
  };

  assert.deepEqual(await registry.run('session-1#call-1', 'fp-abc', task), { value: 1, reused: false });
  clock.advance(999);
  assert.deepEqual(await registry.run('session-1#call-1', 'fp-abc', task), { value: 1, reused: true });
  assert.equal(runs, 1);

  // 正好到 TTL 边界就算过期：结果不能比声明的窗口活得更久。
  clock.advance(1);
  assert.deepEqual(await registry.run('session-1#call-1', 'fp-abc', task), { value: 2, reused: false });
  assert.equal(runs, 2);
});

test('the default TTL is ten minutes', async () => {
  const clock = fakeClock();
  const registry = createCallRegistry({ now: clock });
  let runs = 0;
  const task = async () => {
    runs += 1;
    return 'image';
  };

  await registry.run('session-1#call-1', 'fp-abc', task);
  clock.advance(10 * 60 * 1000 - 1);
  assert.equal((await registry.run('session-1#call-1', 'fp-abc', task)).reused, true);
  clock.advance(1);
  assert.equal((await registry.run('session-1#call-1', 'fp-abc', task)).reused, false);
  assert.equal(runs, 2);
});

test('an in-flight identity is not expired by the clock', async () => {
  // 进行中的条目一旦允许过期，第二个请求就会被放进来跑第二遍 → 重复提交付费任务。
  const clock = fakeClock();
  const registry = createCallRegistry({ ttlMs: 1000, now: clock });
  const gate = deferred();
  let runs = 0;

  const owner = registry.run('session-1#call-1', 'fp-abc', async () => {
    runs += 1;
    await gate.promise;
    return 'image';
  });
  clock.advance(60_000);
  const sharer = registry.run('session-1#call-1', 'fp-abc', async () => {
    runs += 1;
    return 'other';
  });
  gate.resolve();

  const [first, second] = await Promise.all([owner, sharer]);
  assert.equal(runs, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
});

test('expired entries are swept by the next run instead of piling up', async () => {
  const clock = fakeClock();
  const registry = createCallRegistry({ ttlMs: 100, now: clock });

  await registry.run('session-1#call-1', 'fp-abc', async () => 'a');
  await registry.run('session-1#call-2', 'fp-abc', async () => 'b');
  assert.equal(registry.size(), 2);

  clock.advance(100);
  await registry.run('session-1#call-3', 'fp-abc', async () => 'c');
  // 过期条目会占着 maxEntries 的名额，把活条目挤掉：插入时顺手清掉。
  assert.equal(registry.size(), 1);
});

test('once an entry expires a different fingerprint may take over the identity', async () => {
  const clock = fakeClock();
  const registry = createCallRegistry({ ttlMs: 100, now: clock });

  assert.deepEqual(await registry.run('session-1#call-1', 'fp-abc', async () => 'old'), { value: 'old', reused: false });
  clock.advance(100);
  assert.deepEqual(await registry.run('session-1#call-1', 'fp-xyz', async () => 'new'), { value: 'new', reused: false });
});

test('the registry keeps at most maxEntries entries and evicts the oldest insert', async () => {
  const registry = createCallRegistry({ maxEntries: 2 });
  const runs = { a: 0, b: 0, c: 0 };
  const task = (name) => async () => {
    runs[name] += 1;
    return name;
  };

  await registry.run('a', 'fp-abc', task('a'));
  await registry.run('b', 'fp-abc', task('b'));
  assert.equal(registry.size(), 2);

  await registry.run('c', 'fp-abc', task('c'));
  assert.equal(registry.size(), 2);
  assert.deepEqual(await registry.run('b', 'fp-abc', task('b')), { value: 'b', reused: true });
  assert.deepEqual(await registry.run('c', 'fp-abc', task('c')), { value: 'c', reused: true });

  // a 是最先插入的，已经被挤掉：同 key 再调用要重新执行，不能拿到旧结果。
  assert.deepEqual(await registry.run('a', 'fp-abc', task('a')), { value: 'a', reused: false });
  assert.equal(runs.a, 2);
  assert.equal(runs.b, 1);
  assert.equal(registry.size(), 2);
});

test('clear drops every entry and size tracks the live registry', async () => {
  const registry = createCallRegistry();
  let runs = 0;
  const task = async () => {
    runs += 1;
    return 'image';
  };

  assert.equal(registry.size(), 0);
  await registry.run('session-1#call-1', 'fp-abc', task);
  await registry.run('session-1#call-2', 'fp-abc', task);
  assert.equal(registry.size(), 2);

  registry.clear();
  assert.equal(registry.size(), 0);
  assert.deepEqual(await registry.run('session-1#call-1', 'fp-abc', task), { value: 'image', reused: false });
  assert.equal(runs, 3);
});

test('a call identity must be a non-empty string', async () => {
  const registry = createCallRegistry();
  const task = async () => 'image';

  for (const key of ['', null, undefined, 42, {}, ['session-1#call-1']]) {
    const error = await rejectionOf(registry.run(key, 'fp-abc', task));
    assert.ok(error instanceof TypeError, `key=${String(key)} 应当被拒绝`);
    assert.equal(error.code, 'invalid_call_identity');
  }
  for (const fingerprint of ['', null, undefined, 0, {}]) {
    const error = await rejectionOf(registry.run('session-1#call-1', fingerprint, task));
    assert.ok(error instanceof TypeError, `fingerprint=${String(fingerprint)} 应当被拒绝`);
    assert.equal(error.code, 'invalid_call_identity');
  }
  // 非法输入不该在表里留下任何占位。
  assert.equal(registry.size(), 0);
});

test('a call without a task is refused instead of being cached', async () => {
  const registry = createCallRegistry();

  const error = await rejectionOf(registry.run('session-1#call-1', 'fp-abc'));

  assert.ok(error instanceof TypeError);
  assert.equal(error.code, 'invalid_task');
  assert.equal(registry.size(), 0);
});

test('a task returning undefined is still a cache hit', async () => {
  // 命中靠状态判断而不是真值判断：否则 undefined 结果每次都会被当成没有缓存。
  const registry = createCallRegistry();
  let runs = 0;
  const task = async () => {
    runs += 1;
    return undefined;
  };

  const first = await registry.run('session-1#call-1', 'fp-abc', task);
  const second = await registry.run('session-1#call-1', 'fp-abc', task);

  assert.deepEqual(first, { value: undefined, reused: false });
  assert.deepEqual(second, { value: undefined, reused: true });
  assert.equal(runs, 1);
});

test('registries do not share state', async () => {
  const one = createCallRegistry();
  const two = createCallRegistry();

  await one.run('session-1#call-1', 'fp-abc', async () => 'a');

  assert.equal(two.size(), 0);
  assert.deepEqual(await two.run('session-1#call-1', 'fp-abc', async () => 'b'), { value: 'b', reused: false });
});

test('options that would make the registry meaningless are refused', () => {
  assert.throws(() => createCallRegistry({ maxEntries: 0 }), TypeError);
  assert.throws(() => createCallRegistry({ maxEntries: 1.5 }), TypeError);
  assert.throws(() => createCallRegistry({ ttlMs: -1 }), TypeError);
  assert.throws(() => createCallRegistry({ ttlMs: Number.NaN }), TypeError);
  assert.throws(() => createCallRegistry({ now: 'clock' }), TypeError);
});
