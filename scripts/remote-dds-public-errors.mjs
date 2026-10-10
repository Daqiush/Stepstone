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
  WRANGLER_DEPLOY_FAILED: 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].',
  DEPLOYED_OWNERSHIP_UNVERIFIED: 'Remote DDS deployment failed [DEPLOYED_OWNERSHIP_UNVERIFIED].',
  SECRET_UPLOAD_FAILED: 'Remote DDS deployment failed [SECRET_UPLOAD_FAILED].',
  POST_SECRET_OWNERSHIP_UNVERIFIED: 'Remote DDS deployment failed [POST_SECRET_OWNERSHIP_UNVERIFIED].',
  SUBDOMAIN_LOOKUP_FAILED: 'Remote DDS deployment failed [SUBDOMAIN_LOOKUP_FAILED].',
  IMMUTABLE_VERSION_UNVERIFIED: 'Remote DDS deployment failed [IMMUTABLE_VERSION_UNVERIFIED].',
  ENDPOINT_VERIFICATION_FAILED: 'Remote DDS deployment failed [ENDPOINT_VERIFICATION_FAILED].',
  ROLLBACK_DISCOVERY_FAILED: 'Remote DDS deployment failed [ROLLBACK_DISCOVERY_FAILED].',
  ROLLBACK_CLEANUP_FAILED: 'Remote DDS deployment failed [ROLLBACK_CLEANUP_FAILED].',
  TEMP_DIRECTORY_CLEANUP_FAILED: 'Remote DDS deployment failed [TEMP_DIRECTORY_CLEANUP_FAILED].',
  PREFLIGHT_TIMEOUT: 'Remote DDS deployment failed [PREFLIGHT_TIMEOUT].',
  WRANGLER_DEPLOY_TIMEOUT: 'Remote DDS deployment failed [WRANGLER_DEPLOY_TIMEOUT].',
  DEPLOYED_OWNERSHIP_TIMEOUT: 'Remote DDS deployment failed [DEPLOYED_OWNERSHIP_TIMEOUT].',
  SECRET_UPLOAD_TIMEOUT: 'Remote DDS deployment failed [SECRET_UPLOAD_TIMEOUT].',
  POST_SECRET_OWNERSHIP_TIMEOUT: 'Remote DDS deployment failed [POST_SECRET_OWNERSHIP_TIMEOUT].',
  SUBDOMAIN_LOOKUP_TIMEOUT: 'Remote DDS deployment failed [SUBDOMAIN_LOOKUP_TIMEOUT].',
  IMMUTABLE_VERSION_TIMEOUT: 'Remote DDS deployment failed [IMMUTABLE_VERSION_TIMEOUT].',
  ENDPOINT_VERIFICATION_TIMEOUT: 'Remote DDS deployment failed [ENDPOINT_VERIFICATION_TIMEOUT].',
  ROLLBACK_DISCOVERY_TIMEOUT: 'Remote DDS deployment failed [ROLLBACK_DISCOVERY_TIMEOUT].',
  ROLLBACK_CLEANUP_TIMEOUT: 'Remote DDS deployment failed [ROLLBACK_CLEANUP_TIMEOUT].',
  CLEANUP_IDENTITY_INVALID: 'Remote DDS deployment failed [CLEANUP_IDENTITY_INVALID].',
  CLEANUP_OWNERSHIP_UNVERIFIED: 'Remote DDS deployment failed [CLEANUP_OWNERSHIP_UNVERIFIED].',
  CLEANUP_ENDPOINT_UNVERIFIED: 'Remote DDS deployment failed [CLEANUP_ENDPOINT_UNVERIFIED].',
  CLEANUP_SUBDOMAIN_DISABLE_FAILED: 'Remote DDS deployment failed [CLEANUP_SUBDOMAIN_DISABLE_FAILED].',
  CLEANUP_DELETE_FAILED: 'Remote DDS deployment failed [CLEANUP_DELETE_FAILED].',
  CLEANUP_ABSENCE_UNVERIFIED: 'Remote DDS deployment failed [CLEANUP_ABSENCE_UNVERIFIED].',
  CLEANUP_RESULT_WRITE_FAILED: 'Remote DDS deployment failed [CLEANUP_RESULT_WRITE_FAILED].',
  CLEANUP_OWNERSHIP_READ_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_OWNERSHIP_READ_TIMEOUT].',
  CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT].',
  CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT].',
  CLEANUP_ENDPOINT_PROBE_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_ENDPOINT_PROBE_TIMEOUT].',
  CLEANUP_REVERIFY_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_REVERIFY_TIMEOUT].',
  CLEANUP_DELETE_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_DELETE_TIMEOUT].',
  CLEANUP_FINAL_ABSENCE_TIMEOUT: 'Remote DDS deployment failed [CLEANUP_FINAL_ABSENCE_TIMEOUT].',
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

export function renderRemoteDdsRollbackFailure(error) {
  return `Remote DDS rollback also failed [${publicDiagnosticCode(error)}].`;
}

export function renderRemoteDdsCleanupFailure(error) {
  return `Remote DDS cleanup failed [${publicDiagnosticCode(error)}].`;
}
