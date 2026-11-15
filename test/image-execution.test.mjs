import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachFailure, callImageApi, setImageExecutionLogger, stableStringify
} from '../lib/image-execution.js';

/* E：执行器拆出后的错误契约与可注入日志。 */

test('attachFailure adds structured fields without changing the message', () => {
  const cause = new Error('socket closed');
  const error = attachFailure(new Error('submit failed'), {
    code: 'submission_unknown', phase: 'submit', submissionState: 'unknown',
    retryAfterMs: 1200, status: 503, jobId: 'job-1', cause: cause
  });

  assert.equal(error.message, 'submit failed');
  assert.equal(error.code, 'submission_unknown');
  assert.equal(error.phase, 'submit');
  assert.equal(error.submissionState, 'unknown');
  assert.equal(error.retryAfterMs, 1200);
  assert.equal(error.status, 503);
  assert.equal(error.jobId, 'job-1');
  assert.equal(error.cause, cause);
});

test('stableStringify sorts object keys but keeps array order', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
});

test('setImageExecutionLogger accepts a function and resetting to null', () => {
  assert.doesNotThrow(() => setImageExecutionLogger((message) => { void message; }));
  assert.doesNotThrow(() => setImageExecutionLogger(null));
});

test('callImageApi rejects an adapter that does not support the requested kind', async () => {
  const adapter = { id: 'fake', endpoints: { generate: '/generate' } };
  await assert.rejects(
    () => callImageApi('edit', adapter, { id: 'p', baseUrl: 'https://api.test' }, { model: 'm' }),
    /不支持图生图/
  );
});
