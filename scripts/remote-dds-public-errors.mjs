const FAILURE_LINES = Object.freeze({
  REQUIRED_CONFIG_MISSING: 'Remote DDS deployment failed [REQUIRED_CONFIG_MISSING].',
  IDENTITY_INVALID: 'Remote DDS deployment failed [IDENTITY_INVALID].',
  API_AUTH_OR_PERMISSION: 'Remote DDS deployment failed [API_AUTH_OR_PERMISSION].',
  TEMPORARY_WORKER_COLLISION: 'Remote DDS deployment failed [TEMPORARY_WORKER_COLLISION].',
  API_RESPONSE_INVALID: 'Remote DDS deployment failed [API_RESPONSE_INVALID].',
  API_EXACT_SCRIPT_RESPONSE_INVALID: 'Remote DDS deployment failed [API_EXACT_SCRIPT_RESPONSE_INVALID].',
  API_WORKERS_LIST_RESPONSE_INVALID: 'Remote DDS deployment failed [API_WORKERS_LIST_RESPONSE_INVALID].',
  API_SCRIPTS_SEARCH_RESPONSE_INVALID: 'Remote DDS deployment failed [API_SCRIPTS_SEARCH_RESPONSE_INVALID].',
  API_REQUEST_FAILED: 'Remote DDS deployment failed [API_REQUEST_FAILED].',
  CLI_INPUT_INVALID: 'Remote DDS deployment failed [CLI_INPUT_INVALID].',
  LOCAL_IO_FAILED: 'Remote DDS deployment failed [LOCAL_IO_FAILED].',
  UNKNOWN: 'Remote DDS deployment failed [UNKNOWN].',
});

const ALLOWED_CODES = new Set(Object.keys(FAILURE_LINES));
const BRANDED_ERRORS = new WeakSet();

function assertDiagnosticCode(code) {
  if (typeof code !== 'string' || !ALLOWED_CODES.has(code)) {
    throw new TypeError('Unsupported Remote DDS diagnostic code');
  }
}

export class RemoteDdsDiagnosticError extends Error {
  constructor(code, cause) {
    assertDiagnosticCode(code);
    super(`Remote DDS diagnostic [${code}]`, { cause });
    this.name = 'RemoteDdsDiagnosticError';
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    BRANDED_ERRORS.add(this);
  }
}

export function diagnostic(code, cause) {
  return new RemoteDdsDiagnosticError(code, cause);
}

export function publicDiagnosticCode(error) {
  if (!BRANDED_ERRORS.has(error) || !ALLOWED_CODES.has(error.code)) return 'UNKNOWN';
  return error.code;
}

export function renderRemoteDdsFailure(error) {
  return FAILURE_LINES[publicDiagnosticCode(error)];
}
