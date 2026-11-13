/**
 * 结构化错误：宿主保留原来的中文 message 给工具和日志，同时给本地设置接口
 * 附加一组稳定的 code/params，让浏览器按当前语言翻译。
 *
 * 只给“用户能在设置页看到”的接口用；工具调用的报错文案保持不变。
 */
export const SERVER_ERROR_CODES = [
  'network.failed',
  'network.timeout',
  'network.routeInvalid',
  'upstream.http',
  'upstream.httpNoDetail',
  'upstream.invalidJson',
  'upstream.invalidResponse',
  'upstream.tooLarge',
  'provider.notFound',
  'provider.missingBaseUrl',
  'provider.missingKey',
  'provider.missingKeyWithRef',
  'models.unsupported',
  'models.notFound',
  'adapter.unknownProtocol',
  'adapter.notFound',
  'config.credentialsUnavailable',
  'config.credentialSaveFailed',
  'config.legacyKeyMigrationFailed',
  'config.writeFailed',
  'request.methodNotAllowed',
  'request.bodyTooLarge',
  'request.invalidJson'
];

/** 网络失败的提示分类；客户端用 serverError.network.hint.<kind> 翻译。 */
export const NETWORK_HINT_CODES = ['timeout', 'dns', 'connection', 'tls'];

/**
 * Attach a stable localization key to an error without changing its message.
 * @param {unknown} error original error or message.
 * @param {string} code stable key segment, e.g. `network.failed`.
 * @param {Record<string, unknown>} [params] interpolation values.
 * @returns {Error}
 */
export function localizedError(error, code, params) {
  const target = error instanceof Error ? error : new Error(String(error));
  target.localized = {
    code: String(code || ''),
    params: params && typeof params === 'object' ? params : {}
  };
  return target;
}

/**
 * Build the JSON body the settings routes send back: the original message stays
 * available for logs and older clients; code/params let the UI translate.
 * @param {unknown} error thrown value.
 * @returns {{ ok: false, error: string, code?: string, params?: Record<string, unknown> }}
 */
export function errorBody(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const body = { ok: false, error: message };
  const localized = error && error.localized;
  if (localized && typeof localized.code === 'string' && localized.code) {
    body.code = localized.code;
    if (localized.params && typeof localized.params === 'object') body.params = localized.params;
  }
  return body;
}
