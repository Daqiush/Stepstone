import { canonicalHarnessRequest } from './remote-test-canonical.mjs';

const MAX_REQUEST_BYTES = 32 * 1024;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_HASH = /^[0-9a-f]{64}$/;
const SHARD = /^(?:[0-9]|10)$/;

function opaqueNotFound() {
  return { mode: 'deny', response: new Response(null, { status: 404 }) };
}

function decode32ByteBase64url(value) {
  if (typeof value !== 'string' || !BASE64URL_32_BYTES.test(value)) return null;
  try {
    const binary = atob(`${value}=`);
    if (binary.length !== 32) return null;
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function remoteIdentity(headers) {
  const runId = headers.get('x-dds-run-id');
  const operationId = headers.get('x-dds-operation-id');
  const requestHash = headers.get('x-dds-request-hash');
  const shard = headers.get('x-dds-shard');
  if (!RUN_ID.test(runId || '') || !OPERATION_ID.test(operationId || '')
    || !REQUEST_HASH.test(requestHash || '') || !SHARD.test(shard || '')) return null;
  return { runId, operationId, requestHash, shard };
}

async function canonicalRequestHash(path, body) {
  const canonical = new TextEncoder().encode(canonicalHarnessRequest(path, new TextDecoder().decode(body)));
  const digest = await crypto.subtle.digest('SHA-256', canonical);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bufferRequestBody(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function authorizeHarnessRequest(request, env) {
  const remoteEnabled = env.DDS_REMOTE_TEST === 'true';
  if (env.DDS_LOCAL_TEST === 'true' && !remoteEnabled) return { mode: 'local' };

  if (!remoteEnabled) return opaqueNotFound();
  const submittedKey = decode32ByteBase64url(request.headers.get('x-dds-test-key'));
  const configuredKey = decode32ByteBase64url(env.DDS_REMOTE_TEST_KEY);
  const identity = remoteIdentity(request.headers);
  if (!equalBytes(submittedKey, configuredKey) || !identity) return opaqueNotFound();

  if (request.method !== 'POST') {
    return { mode: 'deny', response: new Response(null, { status: 405, headers: { allow: 'POST' } }) };
  }
  const body = await bufferRequestBody(request);
  if (!body) return { mode: 'deny', response: new Response(null, { status: 413 }) };
  if (await canonicalRequestHash(new URL(request.url).pathname, body) !== identity.requestHash) return opaqueNotFound();
  return { mode: 'remote', body, identity };
}
