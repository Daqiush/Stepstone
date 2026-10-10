export const MANAGEMENT_API_TIMEOUT_MS = 30_000;
export const ENDPOINT_PROBE_TIMEOUT_MS = 15_000;

const MAX_SUPPORTED_TIMEOUT_MS = 2_147_483_647;
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ERR_OPERATION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function deadlineSignal({ signal, timeoutMs } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (timeoutMs > MAX_SUPPORTED_TIMEOUT_MS) {
    throw new RangeError('timeoutMs exceeds the supported timeout range');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  return AbortSignal.any(signal === undefined ? [deadline] : [signal, deadline]);
}

export function isTimeoutError(error) {
  const seen = new Set();
  for (let current = error; current !== null && (typeof current === 'object' || typeof current === 'function'); current = current.cause) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current.name === 'TimeoutError' || TIMEOUT_CODES.has(current.code)) return true;
  }
  return false;
}
