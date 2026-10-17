import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../../../src/server/app.js';
import { createContainer, type Container } from '../../../../src/server/runtime/container.js';

const apps: AppInstance[] = [];
const containers: Container[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('web routes and inbound middleware', () => {
  it('renders page routes with server view models and serves static assets', async () => {
    const { app, container } = await openApp();
    container.repositories.sources.create({ feedUrl: 'https://example.com/feed.xml', name: 'Example' });

    const dashboard = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost:8080' } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Dashboard');
    expect(dashboard.body).toContain('Example');

    const sources = await app.inject({ method: 'GET', url: '/sources', headers: { host: 'localhost:8080' } });
    expect(sources.statusCode).toBe(200);
    expect(sources.body).toContain('Sources');
    expect(sources.body).toContain('https://example.com/feed.xml');

    const css = await app.inject({ method: 'GET', url: '/assets/css/app.css', headers: { host: 'evil.example' } });
    expect(css.statusCode).toBe(200);
    expect(css.body).toContain('color-scheme: light');

    const js = await app.inject({ method: 'GET', url: '/assets/js/app.js', headers: { host: 'evil.example' } });
    expect(js.statusCode).toBe(200);
    expect(String(js.headers['content-type'])).toContain('javascript');
    expect(String(js.headers['content-type'])).not.toContain('application/octet-stream');
  });


  it('renders the frontend contract selectors for all management pages', async () => {
    const { app, container } = await openApp();
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/feed.xml',
      name: 'Example'
    });
    container.repositories.groups.create({ name: 'Ops', webhookName: 'Ops Bot' });
    const template = container.repositories.templates.findByName('minimal');
    expect(template).not.toBeNull();

    const expectations: Array<[string, string[]]> = [
      ['/', ['data-page="dashboard"', 'id="dashboard-counts"', 'id="dashboard-sources"']],
      ['/sources', ['data-page="sources"', 'id="import-preview"', 'id="source-table"', 'href="/api/export"']],
      [`/sources/${source.id}`, ['data-page="source-form"', 'data-selected-groups']],
      ['/groups', ['data-page="groups"', 'id="group-table"', 'data-edit-group=', 'data-group-form', 'name="clearWebhook"']],
      ['/templates', ['data-page="templates"', 'id="template-table"', 'name="cloneFrom"', 'Duplicate']],
      [`/templates/${template?.id}`, ['data-page="template-editor"', 'id="template-form"', 'hx-patch="/api/templates/', '기본 제공 템플릿은 읽기 전용', 'id="template-body"', 'id="preview"', 'data-insert-var="item.title"']],
      ['/logs', ['data-page="logs"', 'id="log-stream" data-sse="/api/logs/stream"', 'data-log-type="translation"']],
      ['/model', ['data-page="model"', 'id="model-diagnostics"', 'hx-post="/api/model/diagnose"', 'gemini-3.1-flash-lite', 'PRIMARY_MODEL_API_KEY 환경 변수를 설정해야 Gemini 번역을 사용할 수 있습니다.']]
    ];

    for (const [url, needles] of expectations) {
      const response = await app.inject({ method: 'GET', url, headers: { host: 'localhost:8080' } });
      expect(response.statusCode, url).toBe(200);
      for (const needle of needles) {
        expect(response.body, `${url} includes ${needle}`).toContain(needle);
      }
    }
  });

  it('pre-checks the assigned group checkboxes when editing a source', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({ name: 'Ops', webhookName: 'Ops Bot' });
    const other = container.repositories.groups.create({ name: 'Marketing', webhookName: 'Mkt Bot' });
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/grouped.xml', name: 'Grouped' });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);

    const response = await app.inject({ method: 'GET', url: `/sources/${source.id}`, headers: { host: 'localhost:8080' } });

    expect(response.statusCode).toBe(200);
    // 소속 그룹은 서버에서 checked로 렌더되고, 미소속 그룹은 그대로 둔다.
    expect(response.body).toContain(`value="${group.id}" checked`);
    expect(response.body).not.toContain(`value="${other.id}" checked`);
    expect(response.body).toContain(`data-selected-groups="${group.id}"`);
  });

  it('serves frontend behavior assets required by the server-rendered UI', async () => {
    const { app } = await openApp();
    const assets: Array<[string, string]> = [
      ['/assets/js/htmx.min.js', 'htmx:beforeSwap'],
      ['/assets/js/codemirror.js', 'CodeMirror.registerHelper("lint", "json"'],
      ['/assets/js/app.js', 'htmx:beforeSwap'],
      ['/assets/css/codemirror.css', 'CodeMirror-lint-markers']
    ];

    for (const [url, needle] of assets) {
      const response = await app.inject({ method: 'GET', url, headers: { host: 'localhost:8080' } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body).toContain(needle);
    }
  });

  it('keeps htmx mutation partials compatible with page targets', async () => {
    const { app, container } = await openApp();
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/partial.xml', name: 'Partial' });

    const toggle = await app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}/enabled`,
      payload: { enabled: false },
      headers: { host: 'localhost:8080' }
    });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.body).toContain(`id="source-${source.id}"`);
    expect(toggle.body).toContain('hx-target="closest tr" hx-swap="delete"');

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Ops', webhookName: 'Ops Bot', webhookAvatarUrl: 'https://example.com/avatar.png' },
      headers: { host: 'localhost:8080' }
    });
    expect(group.statusCode).toBe(200);
    expect(group.body).toContain('data-edit-group=');
    expect(group.body).not.toContain('<input');
    expect(group.body).toContain('avatar-preview');

    const createdTemplate = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: 'custom-one', label: 'Custom One', body: '{"content":"ok"}' },
      headers: { host: 'localhost:8080' }
    });
    expect(createdTemplate.statusCode).toBe(200);
    expect(createdTemplate.body).toContain('id="template-');
    expect(createdTemplate.body).toContain('hx-delete="/api/templates/');
    expect(createdTemplate.body).toContain('name="cloneFrom"');
  });

  it('supports real htmx source/model form posts and inline validation fragments', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({ name: 'Htmx Channel', createdAt: '2026-05-29T00:00:00.000Z' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: `feedUrl=https%3A%2F%2Fexample.com%2Fhtmx.xml&name=Htmx&groupIds=${group.id}`,
      headers: { host: 'localhost:8080', 'hx-request': 'true', 'content-type': 'application/x-www-form-urlencoded' }
    });
    expect(create.statusCode).toBe(204);
    expect(create.headers['hx-redirect']).toBe('/sources');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: 'feedUrl=https%3A%2F%2Fexample.com%2Fbad.xml&groupIds=999',
      headers: { host: 'localhost:8080', 'hx-request': 'true', 'content-type': 'application/x-www-form-urlencoded' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(String(invalid.headers['content-type'])).toContain('text/html');
    expect(invalid.body).toContain('form-error');

    const diagnose = await app.inject({
      method: 'POST',
      url: '/api/model/diagnose',
      payload: 'title=Hello&summary=World',
      headers: { host: 'localhost:8080', 'hx-request': 'true', 'content-type': 'application/x-www-form-urlencoded' }
    });
    expect(diagnose.statusCode).toBe(200);
    expect(diagnose.body).toContain('번역 실패 또는 비활성');
    expect(diagnose.body).toContain('id="model-diagnostics"');
    expect(container.repositories.eventLog.list({ kind: 'translation' })[0]).toMatchObject({ status: 'skipped', detail: 'missing-key' });
  });

  it('serves liveness/readiness probes outside the admin UI guard', async () => {
    const { app } = await openApp();

    const health = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example' } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/ready', headers: { host: 'evil.example' } });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('rejects non-loopback Host and cross-origin mutating browser requests', async () => {
    const { app } = await openApp();

    const badHost = await app.inject({ method: 'GET', url: '/sources', headers: { host: 'evil.example' } });
    expect(badHost.statusCode).toBe(403);

    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { host: 'localhost:8080', origin: 'http://evil.example' },
      payload: { name: 'Ops' }
    });
    expect(badOrigin.statusCode).toBe(403);

    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { host: 'localhost:8080', origin: 'http://localhost:8080' },
      payload: { name: 'Ops' }
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it('applies a simple per-client rate limit without counting static assets', async () => {
    const { app } = await openApp();
    for (let index = 0; index < 20; index += 1) {
      const asset = await app.inject({ method: 'GET', url: '/assets/js/app.js', headers: { host: 'localhost:8080' } });
      expect(asset.statusCode).toBe(200);
    }
    let status = 0;
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/groups', headers: { host: 'localhost:8080' } });
      status = response.statusCode;
    }
    expect(status).toBe(200);

    const limited = await app.inject({ method: 'GET', url: '/api/groups', headers: { host: 'localhost:8080' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests.' } });
  });

  it('does not expose the deprecated source-options endpoint', async () => {
    const { app } = await openApp();

    const response = await app.inject({ method: 'GET', url: '/api/source-options', headers: { host: 'localhost:8080' } });
    expect(response.statusCode).toBe(404);
  });
});

async function openApp(): Promise<{ app: AppInstance; container: Container }> {
  const container = createContainer({
    env: { DATABASE_PATH: ':memory:', PORT: '8080' },
    urlVerifiers: {
      verifyFeedUrl: async () => undefined,
      verifyWebhookUrl: async () => undefined
    }
  });
  containers.push(container);
  const app = createApp({ container, logger: false });
  apps.push(app);
  await app.ready();
  return { app, container };
}
