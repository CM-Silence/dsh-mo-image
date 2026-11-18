import {
  prepareGenerate, prepareEdit, prepareAsync, preparePhaseAsync, adapterSupportsKind, operationFieldsFor, sizeHintText
} from './adapters.js';
import { baseUrlOf } from './adapter-kit.js';
import { taskSpecOf } from './output-profiles.js';
import { executeImageRequest, followTask } from './image-request.js';

export { attachFailure, followTask, setImageExecutionLogger, stableStringify, TOTAL_BUDGET_MS } from './image-request.js';

function requestOptions(kind, adapter, provider, input, hooks) {
  return {
    ...hooks, sizeHint: () => sizeHintText(provider, input.model, adapter),
    bindings: () => operationFieldsFor(adapter, provider, input.model, kind)
  };
}

export async function callAsyncImage(kind, adapter, provider, input, signal, hooks = {}) {
  if (hooks.resume) {
    const { jobId, submission, taskId, pollTarget, fitted, note } = hooks.resume;
    const submitUrl = hooks.resume.submitUrl || baseUrlOf(provider);
    return followTask(kind, adapter, provider, submission, submitUrl, {
      spec: hooks.resume.taskSpec || taskSpecOf(adapter), taskId, pollTargets: hooks.resume.pollTargets || [pollTarget]
    }, fitted, input.model, signal, undefined, { ...hooks, resume: { id: jobId }, note });
  }
  const phase = typeof adapter.async === 'object' ? adapter.async : null;
  return executeImageRequest(kind, adapter, provider, input,
    (drops, _field, hopSignal) => phase
      ? preparePhaseAsync(adapter, provider, input, hopSignal, drops)
      : prepareAsync(adapter, provider, input, drops), signal, requestOptions(kind, adapter, provider, input, hooks));
}

export async function callImageApi(kind, adapter, provider, input, signal, hooks) {
  if (kind === 'edit' && adapter?.async && typeof adapter.async === 'object' && !adapter.async.edit) {
    throw new Error('该模型（' + adapter.label + '）暂不支持参考图编辑');
  }
  if (!adapterSupportsKind(adapter, kind)) {
    throw new Error('该模型不支持' + (kind === 'edit' ? '图生图' : '文生图')
      + '（' + String(input.model || adapter.label) + '）。请到设置 → 生图模型换一个支持它的模型。');
  }
  if (adapter.async) return callAsyncImage(kind, adapter, provider, input, signal, hooks);
  if (typeof adapter.execute === 'function') {
    const result = await adapter.execute(kind, provider, input, signal, hooks);
    return { fitted: input.fitted, ...result };
  }
  return executeImageRequest(kind, adapter, provider, input,
    (drops, field) => kind === 'edit'
      ? prepareEdit(adapter, provider, input, drops, field)
      : prepareGenerate(adapter, provider, input, drops), signal, requestOptions(kind, adapter, provider, input, hooks));
}
