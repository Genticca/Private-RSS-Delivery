/**
 * 배포 산출물 검증. 임시 DB·포트로 서버를 시작하고 HTTP 계약 확인 후 서버와 파일을 정리한다.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(projectRoot, 'dist/server/main.js');
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
  await expectModelDiagnostics();
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

/** 상태 점검 엔드포인트가 약속된 JSON을 반환하는지 비교한다. */
async function expectJson(path, expected) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  const json = await response.json();
  assert(JSON.stringify(json) === JSON.stringify(expected), `${path} returned ${JSON.stringify(json)}`);
}

/** 빌드에 포함된 브라우저 자산의 상태 코드와 JavaScript MIME을 확인한다. */
async function expectAsset(path) {
  const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
  assert(response.status === 200, `${path} returned ${response.status}`);
  assert(
    (response.headers.get('content-type') || '').includes('application/javascript'),
    `${path} MIME was ${response.headers.get('content-type')}`
  );
}

/** 실제 공급자 호출 없이 모델 상태 조회의 응답 계약을 확인한다. */
async function expectModelDiagnostics() {
  // 모델 설정은 환경 변수로만 바꾼다(D28). 관리 API는 상태 조회만 제공한다.
  const response = await fetch(`${baseUrl}/api/model/diagnostics`);
  const text = await response.text();
  assert(response.status === 200, `model diagnostics returned ${response.status}: ${text}`);
  const body = JSON.parse(text);
  assert(typeof body.model === 'string' && body.model.startsWith('gemini-'), `unexpected model: ${text}`);
  assert(['ready', 'missing-key', 'invalid-key'].includes(body.status), `unexpected model status: ${text}`);
}

/** 잘못된 소스 입력이 JSON 대신 폼 오류 HTML을 반환하는 경로를 확인한다. */
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

/** 빈 문서로 multipart 미리보기·적용·화면 이동 계약을 검증한다. */
async function expectImportDryRunAndCommit() {
  const document = JSON.stringify({
    kind: 'rss-discord-bridge/export',
    version: 1,
    exportedAt: '2026-05-30T00:00:00.000Z',
    groups: [],
    sources: []
  });
  const dryRun = await postImport('/api/import/dry-run', document);
  const preview = await dryRun.text();
  assert(dryRun.status === 200, `import dry-run returned ${dryRun.status}: ${preview}`);
  assert(preview.includes('hx-encoding="multipart/form-data"'), 'import preview did not include multipart commit form');

  const commit = await postImport('/api/import', document);
  const text = await commit.text();
  assert(commit.status === 204, `import commit returned ${commit.status}: ${text}`);
  assert(commit.headers.get('hx-redirect') === '/sources', `import commit HX-Redirect was ${commit.headers.get('hx-redirect')}`);
}

/** 브라우저 업로드와 같은 multipart 형식으로 테스트 문서를 전달한다. */
async function postImport(path, document) {
  const form = new FormData();
  form.append('file', new Blob([document], { type: 'application/json' }), 'rss-bridge-export.json');
  form.append('mode', 'skip');
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'hx-request': 'true' }, body: form });
}

/** SSE 헤더와 유휴 heartbeat를 확인한 뒤 연결을 닫는다. */
async function expectSseHeadersAndPing() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 17_000);
  try {
    const response = await fetch(`${baseUrl}/api/logs/stream`, { signal: controller.signal });
    assert(response.status === 200, `SSE returned ${response.status}`);
    assert(
      (response.headers.get('content-type') || '').includes('text/event-stream'),
      `SSE MIME was ${response.headers.get('content-type')}`
    );
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

/** 기동 완료까지 짧게 재시도하고 준비되지 않으면 실패로 종료한다. */
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

/** OS가 고른 빈 포트로 검사 서버를 띄워 사용 중인 개발 포트와 충돌하지 않게 한다. */
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

/** 검사 성공·실패와 관계없이 자식 서버가 종료됐는지 확인한다. */
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
