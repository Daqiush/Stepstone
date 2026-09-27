import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from './remote-dds-soak-state.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

export const DEPLOYMENT_MANIFEST_VERSION = 1;
export const WASM_PATH = 'workers/vendor/bridge-dds/dds-worker.wasm';
export function harnessPaths(root) {
  const sourceRoot = resolve(root, 'workers/src');
  if (!existsSync(sourceRoot)) throw new Error('Missing harness source directory: workers/src');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() && entry.name.endsWith('.mjs') ? [relative(root, path).replaceAll('\\', '/')] : [];
  });
  return walk(sourceRoot).sort();
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function asset(root, path, label) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Missing ${label} asset: ${path}`);
  const bytes = readFileSync(absolute);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function assertVerifiedDeployment(record) {
  if (!record || record.apiVerified !== true || typeof record.versionId !== 'string' || !record.versionId.trim()
      || typeof record.wranglerVersion !== 'string' || !record.wranglerVersion.trim()) throw new Error('A verified deployment record is required');
  return { versionId: record.versionId.trim(), apiVerified: true, wranglerVersion: record.wranglerVersion.trim() };
}
export async function verifyWorkersDeployment({ fetchImpl = fetch, accountId, scriptName, apiToken, expectedVersionId, wranglerVersion }) {
  if (!accountId || !scriptName || !apiToken || !expectedVersionId || !wranglerVersion) throw new Error('Workers API verification requires account, script, token, version, and Wrangler version');
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(scriptName)}/environments/production`, { headers: { authorization: `Bearer ${apiToken}` } });
  const payload = await response.json();
  if (!response.ok || payload?.result?.version !== expectedVersionId) throw new Error('Workers API did not verify the deployed version ID');
  return assertVerifiedDeployment({ versionId: expectedVersionId, apiVerified: true, wranglerVersion });
}
export async function deployAndVerifyWorkers({ execFile = execFileSync, fetchImpl = fetch, wrangler = 'wrangler', root = resolve(import.meta.dirname, '..'), accountId, scriptName, apiToken }) {
  const assets = { wasm: asset(root, WASM_PATH, 'Wasm'), harness: Object.fromEntries(harnessPaths(root).map((path) => [path, asset(root, path, 'harness')])) };
  const buildId = sha256(canonicalJson({ version: DEPLOYMENT_MANIFEST_VERSION, assets }));
  const deployed = JSON.parse(String(execFile(wrangler, ['deploy', '--json', '--config', resolve(root, 'workers/wrangler.jsonc'), '--var', `DDS_DEPLOYMENT_BUILD_ID:${buildId}`], { encoding: 'utf8', cwd: root })));
  const versionId = deployed?.version_id ?? deployed?.versionId;
  const wranglerVersion = String(execFile(wrangler, ['--version'], { encoding: 'utf8' })).trim();
  return verifyWorkersDeployment({ fetchImpl, accountId, scriptName, apiToken, expectedVersionId: versionId, wranglerVersion });
}
export function createDeploymentManifest({ root = resolve(import.meta.dirname, '..'), verifiedDeployment } = {}) {
  const deployment = assertVerifiedDeployment(verifiedDeployment);
  const assets = {
    wasm: asset(root, WASM_PATH, 'Wasm'),
    harness: Object.fromEntries(harnessPaths(root).map((path) => [path, asset(root, path, 'harness')])),
  };
  const fingerprint = { version: DEPLOYMENT_MANIFEST_VERSION, assets };
  return { ...fingerprint, workerVersionId: deployment.versionId, verifiedDeployment: deployment, buildId: sha256(canonicalJson(fingerprint)) };
}

export function assertDeploymentManifest(manifest, { root = resolve(import.meta.dirname, '..') } = {}) {
  if (!manifest || manifest.version !== DEPLOYMENT_MANIFEST_VERSION) throw new Error('Unsupported or missing deployment manifest version');
  if (typeof manifest.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.buildId)) throw new Error('Deployment manifest build ID is invalid');
  if (typeof manifest.workerVersionId !== 'string' || !manifest.workerVersionId) throw new Error('Deployment manifest Worker version ID is invalid');
  const current = createDeploymentManifest({ root, verifiedDeployment: manifest.verifiedDeployment });
  if (manifest.assets?.wasm?.sha256 !== current.assets.wasm.sha256) throw new Error('Wasm asset hash changed since deployment manifest was generated');
  for (const path of harnessPaths(root)) {
    if (manifest.assets?.harness?.[path]?.sha256 !== current.assets.harness[path].sha256) throw new Error(`Harness asset hash changed since deployment manifest was generated: ${path}`);
  }
  if (manifest.buildId !== current.buildId) throw new Error('Deployment manifest build ID does not bind the current assets');
  return current;
}

function option(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; }
async function runCli() {
  const out = option('--out', null);
  if (!out) throw new Error('--out is required');
  if (!process.argv.includes('--deploy-and-verify')) throw new Error('--deploy-and-verify is required; verified deployment JSON is not accepted');
  const manifest = createDeploymentManifest({ verifiedDeployment: await deployAndVerifyWorkers({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, scriptName: process.env.CLOUDFLARE_WORKER_NAME, apiToken: process.env.CLOUDFLARE_API_TOKEN }) });
  writeReportCheckpoint(resolve(process.cwd(), out), manifest);
  console.log(`Generated remote DDS deployment manifest: ${manifest.buildId}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
