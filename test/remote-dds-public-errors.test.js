const assert = require('node:assert/strict');
const test = require('node:test');

const PUBLIC_CODES = [
  'REQUIRED_CONFIG_MISSING',
  'IDENTITY_INVALID',
  'API_AUTH_OR_PERMISSION',
  'TEMPORARY_WORKER_COLLISION',
  'API_RESPONSE_INVALID',
  'API_EXACT_SCRIPT_RESPONSE_INVALID',
  'API_WORKERS_LIST_RESPONSE_INVALID',
  'API_SCRIPTS_SEARCH_RESPONSE_INVALID',
  'API_REQUEST_FAILED',
  'CLI_INPUT_INVALID',
  'LOCAL_IO_FAILED',
  'UNKNOWN',
];

const mod = () => import('../scripts/remote-dds-public-errors.mjs');
const expectedLine = (code) => `Remote DDS deployment failed [${code}].`;

test('every public diagnostic code has one exact closed failure line', async () => {
  const { RemoteDdsDiagnosticError, diagnostic, publicDiagnosticCode, renderRemoteDdsFailure } = await mod();

  for (const code of PUBLIC_CODES) {
    const error = diagnostic(code, new Error(`internal cause for ${code}`));
    assert.ok(error instanceof RemoteDdsDiagnosticError);
    assert.equal(publicDiagnosticCode(error), code);
    assert.equal(renderRemoteDdsFailure(error), expectedLine(code));
  }
});

test('the designated error class creates branded diagnostics with an internal cause', async () => {
  const { RemoteDdsDiagnosticError, publicDiagnosticCode, renderRemoteDdsFailure } = await mod();
  const cause = new Error('internal-only-cause-marker');
  const error = new RemoteDdsDiagnosticError('LOCAL_IO_FAILED', cause);

  assert.equal(error.cause, cause);
  assert.equal(publicDiagnosticCode(error), 'LOCAL_IO_FAILED');
  assert.equal(renderRemoteDdsFailure(error), expectedLine('LOCAL_IO_FAILED'));
});

test('diagnostic rejects every code outside the exact allowlist', async () => {
  const { RemoteDdsDiagnosticError, diagnostic } = await mod();
  const rejected = [
    'API_REQUEST_FAILED\nTOKEN=leaked',
    'api_request_failed',
    ' API_REQUEST_FAILED',
    'API_REQUEST_FAILED ',
    'TOSTRING',
    '__proto__',
    '',
    null,
    undefined,
    1,
  ];

  for (const code of rejected) {
    assert.throws(() => diagnostic(code), /diagnostic code/i);
    assert.throws(() => new RemoteDdsDiagnosticError(code), /diagnostic code/i);
  }
});

test('forged and newline-bearing error codes always collapse to UNKNOWN', async () => {
  const { RemoteDdsDiagnosticError, publicDiagnosticCode, renderRemoteDdsFailure } = await mod();
  const forgedPrototype = Object.create(RemoteDdsDiagnosticError.prototype);
  Object.defineProperty(forgedPrototype, 'code', { value: 'API_AUTH_OR_PERMISSION' });
  const values = [
    { code: 'API_REQUEST_FAILED' },
    { code: 'API_REQUEST_FAILED\nTOKEN=forged-token' },
    forgedPrototype,
    new Error('ordinary error'),
    'API_REQUEST_FAILED',
    null,
    undefined,
  ];

  for (const value of values) {
    assert.equal(publicDiagnosticCode(value), 'UNKNOWN');
    assert.equal(renderRemoteDdsFailure(value), expectedLine('UNKNOWN'));
  }
});

test('rendering never emits internal token, account, Worker, URL, response, cause, or stack markers', async () => {
  const { diagnostic, renderRemoteDdsFailure } = await mod();
  const markers = [
    'token-secret-7fd1',
    'account-id-2ea9',
    'Worker-name-private-41c0',
    'https://private.example.invalid/deploy',
    'response-body-private-53bb',
    'cause-message-private-80ad',
    'stack-frame-private-96ef',
  ];
  const cause = new Error(markers[5]);
  cause.stack = markers[6];
  cause.token = markers[0];
  cause.account = markers[1];
  cause.worker = markers[2];
  cause.url = markers[3];
  cause.response = markers[4];
  const error = diagnostic('API_REQUEST_FAILED', cause);
  error.token = markers[0];
  error.account = markers[1];
  error.worker = markers[2];
  error.url = markers[3];
  error.response = markers[4];

  const output = renderRemoteDdsFailure(error);
  assert.equal(output, expectedLine('API_REQUEST_FAILED'));
  for (const marker of markers) assert.equal(output.includes(marker), false, marker);
});
