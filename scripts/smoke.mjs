import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(projectRoot, 'dist/server/app.js');
const port = await getFreePort();
const databasePath = join(tmpdir(), `rss-discord-bridge-smoke-${process.pid}.sqlite`);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_PATH: databasePath }
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  await waitForReady(`${baseUrl}/healthz`);
  await expectJson('/healthz', { status: 'ok' });
  await expectJson('/ready', { status: 'ready' });
  await expectAsset('/assets/js/htmx.min.js');
  await expectAsset('/assets/js/codemirror.js');
  await expectModelPatch();
  await expectSourceValidationFragment();
  await expectImportDryRunAndCommit();
  await expectSseHeadersAndPing();
  console.log(`smoke ok: ${baseUrl}`);
} finally {
  child.kill('SIGINT');
  await waitForExit(child);
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

async function expectJson(path, expected) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  const json = await response.json();
  assert(JSON.stringify(json) === JSON.stringify(expected), `${path} returned ${JSON.stringify(json)}`);
}

async function expectAsset(path) {
  const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
  assert(response.status === 200, `${path} returned ${response.status}`);
  assert((response.headers.get('content-type') || '').includes('application/javascript'), `${path} MIME was ${response.headers.get('content-type')}`);
}

async function expectModelPatch() {
  const response = await fetch(`${baseUrl}/api/model/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
    body: new URLSearchParams({
      'primary.provider': 'gemini',
      'primary.model': 'gemini-smoke',
      'primary.enabled': 'false',
      promptLogMaxBytes: '2048'
    })
  });
  const text = await response.text();
  assert(response.status === 200, `model PATCH returned ${response.status}: ${text}`);
  assert(text.includes('hx-swap-oob="true"'), 'model PATCH did not return OOB flash');
}

async function expectSourceValidationFragment() {
  const response = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
    body: new URLSearchParams({ feedUrl: 'https://example.com/smoke-invalid.xml', groupIds: '999' })
  });
  const text = await response.text();
  assert(response.status === 400, `source validation returned ${response.status}: ${text}`);
  assert((response.headers.get('content-type') || '').includes('text/html'), 'source validation was not text/html');
  assert(text.includes('form-error'), 'source validation did not return form-error');
}

async function expectImportDryRunAndCommit() {
  const document = JSON.stringify({ kind: 'rss-discord-bridge/export', version: 1, exportedAt: '2026-05-30T00:00:00.000Z', groups: [], sources: [] });
  const dryRun = await postImport('/api/import/dry-run', document);
  const preview = await dryRun.text();
  assert(dryRun.status === 200, `import dry-run returned ${dryRun.status}: ${preview}`);
  assert(preview.includes('hx-encoding="multipart/form-data"'), 'import preview did not include multipart commit form');

  const commit = await postImport('/api/import', document);
  const text = await commit.text();
  assert(commit.status === 204, `import commit returned ${commit.status}: ${text}`);
  assert(commit.headers.get('hx-redirect') === '/sources', `import commit HX-Redirect was ${commit.headers.get('hx-redirect')}`);
}

async function postImport(path, document) {
  const form = new FormData();
  form.append('file', new Blob([document], { type: 'application/json' }), 'rss-bridge-export.json');
  form.append('mode', 'skip');
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'hx-request': 'true' }, body: form });
}

async function expectSseHeadersAndPing() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 17_000);
  try {
    const response = await fetch(`${baseUrl}/api/logs/stream`, { signal: controller.signal });
    assert(response.status === 200, `SSE returned ${response.status}`);
    assert((response.headers.get('content-type') || '').includes('text/event-stream'), `SSE MIME was ${response.headers.get('content-type')}`);
    const reader = response.body?.getReader();
    assert(reader, 'SSE body reader missing');
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': ping')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert(text.includes(': ping'), 'SSE ping was not observed');
    await reader.cancel().catch(() => undefined);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(200);
  }
  throw new Error(`server did not become ready\n${logs}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('could not allocate port'));
      else server.close(() => resolve(address.port));
    });
  });
}

async function waitForExit(process) {
  if (process.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => process.once('exit', resolve)),
    sleep(5000).then(() => process.kill('SIGKILL'))
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
