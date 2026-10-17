import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../../../src/server/app.js';
import { createContainer, type Container } from '../../../../src/server/runtime/container.js';
import { createSseConnectionLimiter } from '../../../../src/server/controllers/api/logs.js';
import type { WebhookPostRequest } from '../../../../src/server/dispatcher/discord-client.js';
import { DeliveryWorker } from '../../../../src/server/workers/delivery-worker.js';
import { DeliveryService } from '../../../../src/server/services/delivery.service.js';

const apps: AppInstance[] = [];
const containers: Container[] = [];
const base = '2026-05-29T00:00:00.000Z';

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const container of containers.splice(0)) {
    await container.close();
  }
});

describe('API controllers', () => {
  it('creates sources without exposing raw webhook URLs and resets state when feedUrl changes', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({
      name: 'Security',
      webhookUrl: 'https://discord.com/api/webhooks/222/group-token',
      createdAt: base
    });
    const template = container.repositories.templates.findByName('minimal');
    expect(template).not.toBeNull();

    const create = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: {
        feedUrl: 'https://example.com/feed.xml',
        name: 'Example',
        profile: 'generic',
        pollIntervalSeconds: 60,
        translate: true,
        templateId: template?.id,
        groupIds: [group.id],
        silent: true,
        mentionRoleIds: ['111', '222'],
        mentionUserIds: '333,444',
        mentionEveryone: true,
        threadId: '555',
        threadName: 'Incident Updates',
        appliedTags: ['666'],
        editInPlace: true
      }
    });
    expect(create.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(list.statusCode).toBe(200);
    const sources = list.json();
    expect(sources).toHaveLength(1);
    expect(JSON.stringify(sources)).not.toContain('source-token');
    expect(sources[0]).toMatchObject({
      feedUrl: 'https://example.com/feed.xml',
      name: 'Example',
      groupIds: [group.id],
      translate: true,
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333', '444'],
      mentionEveryone: true,
      threadId: '555',
      threadName: 'Incident Updates',
      appliedTags: ['666'],
      editInPlace: true
    });

    const sourceId = sources[0].id as string;
    expect(container.repositories.sources.getById(sourceId)?.webhookUrl).toBeNull();
    container.repositories.sources.update(sourceId, {
      initialized: true,
      detectedProfile: 'generic',
      etag: '"old-etag"',
      lastModified: 'Fri, 29 May 2026 00:00:00 GMT',
      lastPolledAt: base,
      nextPollAt: base
    });
    const item = container.repositories.items.insert({
      sourceId,
      atomId: 'atom-1',
      title: 'Before',
      contentHash: 'hash-before',
      deliveryStatus: 'delivered',
      deliveredAt: base,
      createdAt: base
    });
    expect(container.repositories.items.getById(item.id)).not.toBeNull();

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/sources/${sourceId}`,
      payload: {
        feedUrl: 'https://example.com/changed.xml'
      }
    });
    expect(update.statusCode).toBe(200);
    expect(container.repositories.items.getById(item.id)).toBeNull();
    const updated = container.repositories.sources.getById(sourceId);
    expect(updated).toMatchObject({
      feedUrl: 'https://example.com/changed.xml',
      initialized: false,
      detectedProfile: null,
      etag: null,
      lastModified: null,
      lastPolledAt: null,
      nextPollAt: null
    });
    expect(updated?.deliveryCutoffAt).not.toBeNull();
    expect(updated?.webhookUrl).toBeNull();
  });

  it('validates CRUD conflicts and returns typed errors for JSON routes', async () => {
    const { app } = await openApp();

    const invalid = await app.inject({ method: 'POST', url: '/api/sources', payload: { feedUrl: 'http://127.0.0.1/feed.xml' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('form-error');
    expect(invalid.body).toContain('validation_error');

    const first = await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Ops' } });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'ops' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toContain('form-error');

    const groupTest = await app.inject({ method: 'POST', url: '/api/groups/1/test' });
    expect(groupTest.statusCode).toBe(404);

    const missing = await app.inject({ method: 'GET', url: '/api/templates/9999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const badAvatar = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { feedUrl: 'https://example.com/bad-avatar.xml', webhookAvatarUrl: 'javascript:alert(1)' }
    });
    expect(badAvatar.statusCode).toBe(400);
    expect(badAvatar.body).toContain('webhookAvatarUrl');
    expect(badAvatar.body).toContain('invalid_url');
  });

  it('maps feed URL database uniqueness races to conflict responses', async () => {
    const { app, container } = await openApp();
    container.repositories.sources.create({ feedUrl: 'https://example.com/db-unique.xml', createdAt: base });
    const group = container.repositories.groups.create({ name: 'Race Channel', createdAt: base });
    const sources = container.repositories.sources;
    const originalFindByFeedUrl = sources.findByFeedUrl.bind(sources);
    sources.findByFeedUrl = () => null;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sources',
        payload: { feedUrl: 'https://example.com/db-unique.xml', groupIds: [group.id] }
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain('form-error');
      expect(response.body).toContain('conflict');
    } finally {
      sources.findByFeedUrl = originalFindByFeedUrl;
    }
  });

  it('delivers through selected groups', async () => {
    const { app, container } = await openApp();
    const template = container.repositories.templates.findByName('minimal');
    expect(template).not.toBeNull();
    const group = container.repositories.groups.create({
      name: 'Selected Channel',
      webhookUrl: 'https://discord.com/api/webhooks/222/group-token',
      webhookName: 'Group Bot',
      createdAt: base
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: {
        feedUrl: 'https://example.com/group-channel.xml',
        templateId: template?.id,
        webhookName: 'Source Bot',
        groupIds: [group.id]
      }
    });
    expect(response.statusCode).toBe(200);
    const source = container.repositories.sources.findByFeedUrl('https://example.com/group-channel.xml');
    expect(source).not.toBeNull();
    expect(source?.webhookUrl).toBeNull();

    const calls: WebhookPostRequest[] = [];
    const dispatcher = new DeliveryWorker({
      jobs: container.repositories.deliveryJobs,
      bindings: container.repositories.deliveryBindings,
      service: new DeliveryService({ db: container.db, repositories: container.repositories, planner: container.services.deliveryPlan,
      postWebhook: async (request) => {
        calls.push(request);
        return { statusCode: 200, messageId: '123' };
      }
      })
    });
    container.services.deliveryBindings.completeBaselines(source!.id, base);
    const item = container.repositories.items.insert({
      sourceId: source!.id,
      atomId: 'atom-group-channel',
      title: 'Group Channel',
      summary: 'Summary',
      contentHash: 'hash-group-channel',
      nextAttemptAt: base,
      createdAt: base
    });

    container.services.deliveryPlan.planNew(item, source!, base);
    expect(await dispatcher.runDueDeliveries(base)).toMatchObject([{ itemId: item.id, outcome: 'delivered', attemptNo: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.destination.webhookUrl).toBe('https://discord.com/api/webhooks/222/group-token');
    expect(calls[0]?.payload.username).toBe('Source Bot');
  });

  it('stores fetch option request headers but excludes them from export files', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({ name: 'Headers Channel', createdAt: base });
    const create = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: {
        feedUrl: 'https://example.com/headers.xml',
        groupIds: [group.id],
        fetchOptions: {
          userAgent: 'custom-agent/1.0',
          headers: { 'X-Feed-Token': 'secret-token' },
          timeoutMs: 5000
        }
      }
    });
    expect(create.statusCode).toBe(200);

    const source = container.repositories.sources.findByFeedUrl('https://example.com/headers.xml');
    expect(source?.fetchOptions).toMatchObject({
      userAgent: 'custom-agent/1.0',
      headers: { 'x-feed-token': 'secret-token' },
      timeoutMs: 5000
    });

    const exported = await app.inject({ method: 'GET', url: '/api/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('secret-token');
    expect(exported.json().sources[0].fetchOptions).toMatchObject({ userAgent: 'custom-agent/1.0', timeoutMs: 5000 });
    expect(exported.json().sources[0].fetchOptions.headers).toBeUndefined();
  });

  it('accepts browser-style multipart import uploads and enforces an upload cap', async () => {
    const { app } = await openApp();
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [],
      sources: [
        { feedUrl: 'https://example.com/multipart.xml', enabled: true, profile: 'generic', pollIntervalSeconds: 300, translate: false, groupRefs: [] }
      ]
    };
    const upload = multipartPayload(JSON.stringify(document), { mode: 'skip' });
    const dryRun = await app.inject({
      method: 'POST',
      url: '/api/import/dry-run',
      headers: { 'content-type': upload.contentType },
      payload: upload.body
    });

    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.body).toContain('가져오기 미리보기');
    expect(dryRun.body).toContain('웹훅 재입력 필요');
    expect(dryRun.body).toContain('hx-post="/api/import"');
    expect(dryRun.body).toContain('hx-encoding="multipart/form-data"');
    expect(dryRun.body).toContain('파일 다시 첨부하여 가져오기');
    expect(dryRun.body).toContain('name="mode" value="skip"');
    expect(dryRun.body).toContain('방식을 바꾸려면 미리보기를 다시 실행하세요.');
    expect(dryRun.body).not.toContain('name="content" hidden');

    const commitPayload = multipartPayload(JSON.stringify(document), { mode: 'skip' });
    const committed = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: { 'content-type': commitPayload.contentType, 'hx-request': 'true' },
      payload: commitPayload.body
    });
    expect(committed.statusCode).toBe(204);
    expect(committed.headers['hx-redirect']).toBe('/sources');

    const huge = multipartPayload('x'.repeat(1_100_000));
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/import/dry-run',
      headers: { 'content-type': huge.contentType },
      payload: huge.body
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('validation_error');
  });

  it('previews and commits imports while skipping SSRF-blocked feed rows', async () => {
    const verifyFeedUrl = async (value: string) => {
      if (value.includes('blocked.example')) throw new Error('blocked by test verifier');
    };
    const { app, container } = await openApp({ verifyFeedUrl });
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [{ name: 'Fresh Group' }],
      sources: [
        {
          feedUrl: 'https://example.com/import-good.xml',
          name: 'Good Import',
          enabled: true,
          profile: 'generic',
          pollIntervalSeconds: 300,
          translate: false,
          templateRef: 'missing-template',
          groupRefs: ['Fresh Group']
        },
        {
          feedUrl: 'https://blocked.example/import-bad.xml',
          name: 'Blocked Import',
          enabled: true,
          profile: 'generic',
          pollIntervalSeconds: 300,
          translate: false,
          groupRefs: []
        }
      ]
    };

    const dryRun = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.body).toContain('차단된 소스');
    expect(dryRun.body).toContain('https://blocked.example/import-bad.xml');
    expect(dryRun.body).toContain('연결 실패한 템플릿');
    expect(dryRun.body).toContain('웹훅 재입력 필요');
    expect(dryRun.body).toContain('파일 다시 첨부하여 가져오기');

    const committed = await app.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(committed.statusCode).toBe(204);
    expect(container.repositories.sources.findByFeedUrl('https://example.com/import-good.xml')).not.toBeNull();
    expect(container.repositories.sources.findByFeedUrl('https://blocked.example/import-bad.xml')).toBeNull();
    expect(container.repositories.groups.findByNameNocase('Fresh Group')).not.toBeNull();
  });

  it('rejects duplicate feed URLs inside an import file as validation errors', async () => {
    const { app } = await openApp();
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [],
      sources: [
        { feedUrl: 'https://example.com/dup.xml', enabled: true, profile: 'generic', pollIntervalSeconds: 300, translate: false, groupRefs: [] },
        { feedUrl: 'https://example.com/dup.xml', enabled: true, profile: 'generic', pollIntervalSeconds: 300, translate: false, groupRefs: [] }
      ]
    };

    const response = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(document) } });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('validation_error');
  });

  it('returns htmx HTML validation fragments for invalid import commits', async () => {
    const { app } = await openApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/import',
      payload: { content: '{not-json}', mode: 'skip' },
      headers: { 'hx-request': 'true' }
    });

    expect(response.statusCode).toBe(400);
    expect(String(response.headers['content-type'])).toContain('text/html');
    expect(response.body).toContain('form-error');
    expect(response.body).toContain('validation_error');
  });

  it('validates required import source fields and groupRefs strictly', async () => {
    const { app } = await openApp();
    const missingEnabled = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [],
      sources: [{ feedUrl: 'https://example.com/missing-enabled.xml', profile: 'generic', pollIntervalSeconds: 300, translate: false, groupRefs: [] }]
    };

    const missing = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(missingEnabled) } });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('sources.enabled');

    const badGroupRef = { ...missingEnabled, sources: [{ ...missingEnabled.sources[0], enabled: true, groupRefs: [''] }] };
    const badRef = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(badGroupRef) } });
    expect(badRef.statusCode).toBe(400);
    expect(badRef.body).toContain('groupRefs');

    const nonArrayGroupRefs = { ...missingEnabled, sources: [{ ...missingEnabled.sources[0], enabled: true, groupRefs: 'Fresh Group' }] };
    const badRefsType = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(nonArrayGroupRefs) } });
    expect(badRefsType.statusCode).toBe(400);
    expect(badRefsType.body).toContain('groupRefs');

    const badTemplateRef = { ...missingEnabled, sources: [{ ...missingEnabled.sources[0], enabled: true, groupRefs: [], templateRef: 123 }] };
    const badTemplate = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(badTemplateRef) } });
    expect(badTemplate.statusCode).toBe(400);
    expect(badTemplate.body).toContain('sources.templateRef');

    const validImportSource = { ...missingEnabled.sources[0], enabled: true, groupRefs: [] };
    const badMentionIds = { ...missingEnabled, sources: [{ ...validImportSource, mentionRoleIds: ['not-a-role'] }] };
    const badMention = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(badMentionIds) } });
    expect(badMention.statusCode).toBe(400);
    expect(badMention.body).toContain('mentionRoleIds');

    const badAppliedTags = { ...missingEnabled, sources: [{ ...validImportSource, appliedTags: ['1', '2', '3', '4', '5', '6'] }] };
    const badTags = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(badAppliedTags) } });
    expect(badTags.statusCode).toBe(400);
    expect(badTags.body).toContain('appliedTags');

    const badAppliedTagId = { ...missingEnabled, sources: [{ ...validImportSource, appliedTags: ['not-a-tag'] }] };
    const badTagId = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(badAppliedTagId) } });
    expect(badTagId.statusCode).toBe(400);
    expect(badTagId.body).toContain('appliedTags');

    const badMode = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify({ ...missingEnabled, sources: [validImportSource] }), mode: 'merge' } });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.body).toContain('mode');
  });

  it('rejects sources saved without at least one selected group', async () => {
    const { app, container } = await openApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { feedUrl: 'https://example.com/no-groups.xml', groupIds: [] }
    });
    expect(create.statusCode).toBe(400);
    expect(create.body).toContain('groupIds');

    const group = container.repositories.groups.create({ name: 'Required', createdAt: base });
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/clear-groups.xml', createdAt: base });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);
    expect(container.repositories.sourceGroups.listGroupIdsForSource(source.id)).toEqual([group.id]);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'groupIds='
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('groupIds');
    expect(container.repositories.sourceGroups.listGroupIdsForSource(source.id)).toEqual([group.id]);
  });

  it('rejects malformed groupIds instead of silently dropping them', async () => {
    const { app, container } = await openApp();
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/bad-groups.xml', createdAt: base });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'groupIds=abc'
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('validation_error');
  });

  it('validates model provider compatibility and ignores targetLang writes', async () => {
    const { app, container } = await openApp();

    const ignoredTarget = await app.inject({
      method: 'PATCH',
      url: '/api/model/config',
      payload: { primary: { provider: 'gemini', model: 'gemini-3.1-flash-lite', targetLang: 'en' }, targetLang: 'en' }
    });
    expect(ignoredTarget.statusCode).toBe(200);
    expect(container.repositories.modelConfig.getByRole('primary')?.targetLang).toBe('ko');

    const mismatch = await app.inject({
      method: 'PATCH',
      url: '/api/model/config',
      payload: { primary: { provider: 'gemini', model: 'qwen3-coder-480b-a35b-instruct' } }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain('provider와 model 조합');
  });

  it('returns model usage/log pagination and excludes prompt logs from usage responses', async () => {
    const { app, container } = await openApp();
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/log.xml', createdAt: base });
    const item = container.repositories.items.insert({ sourceId: source.id, atomId: 'atom-log', contentHash: 'hash-log', createdAt: base });
    container.repositories.deliveryLogs.append({ itemId: item.id, attemptNo: 1, status: 'success', destinationKey: 'dest', contentHash: 'hash-log', createdAt: base });
    container.repositories.fetchLogs.append({ sourceId: source.id, outcome: '200', httpStatus: 200, itemsNew: 1, createdAt: base });
    container.repositories.modelUsage.append({
      role: 'primary',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      promptLog: 'input/output should stay server-side',
      createdAt: base
    });

    const delivery = await app.inject({ method: 'GET', url: '/api/logs?type=delivery&limit=1' });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json()).toMatchObject({ items: [{ status: 'success', itemId: item.id }] });

    const fetch = await app.inject({ method: 'GET', url: '/api/logs?type=fetch&limit=1' });
    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({ items: [{ outcome: '200', sourceId: source.id }] });

    const usage = await app.inject({ method: 'GET', url: '/api/model/usage?limit=1' });
    expect(usage.statusCode).toBe(200);
    expect(JSON.stringify(usage.json())).not.toContain('promptLog');
    expect(JSON.stringify(usage.json())).not.toContain('input/output should stay server-side');
  });


  it('rejects invalid log types and caps SSE connection accounting', async () => {
    const { app } = await openApp();
    const invalid = await app.inject({ method: 'GET', url: '/api/logs?type=bad' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('validation_error');

    const limiter = createSseConnectionLimiter(2);
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(limiter.tryAcquire()).toBeNull();
    first?.();
    expect(limiter.active()).toBe(1);
    second?.();
    expect(limiter.active()).toBe(0);
  });

  it('renders preview from sample data without calling translator and reports validation errors as ok:false', async () => {
    const { app, container } = await openApp();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: {
        mode: 'sample',
        templateBody: '{"embeds":[{"title":{{json item.title}},"description":{{json item.summary}}}]}'
      }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });
    expect(ok.json().payload.embeds[0].title).toBe('Sample RSS item');

    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/preview.xml',
      silent: true,
      mentionRoleIds: ['111'],
      threadName: 'Preview Thread',
      appliedTags: ['222'],
      createdAt: base
    });
    const sourcePreview = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: {
        mode: 'sample',
        sourceId: source.id,
        templateBody: '{"embeds":[{"title":{{json item.title}}}]}'
      }
    });
    expect(sourcePreview.statusCode).toBe(200);
    expect(sourcePreview.json().payload).toMatchObject({
      flags: 4096,
      content: '<@&111>',
      allowed_mentions: { parse: [], roles: ['111'], users: [] },
      thread_name: 'Preview Thread',
      applied_tags: ['222']
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: {
        mode: 'sample',
        templateBody: '{"embeds":[{"title":' + JSON.stringify('x'.repeat(257)) + '}]}'
      }
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ ok: false, errors: [{ stage: 'validate' }] });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: { mode: 'sample', templateBody: '{"embeds":[{"title":{{json item.title}}' }
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toMatchObject({ ok: false, errors: [{ stage: 'render' }] });
  });

  it('exports and imports sources/groups without webhook secrets and keeps new imports historical-safe', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({
      name: 'Exported',
      webhookUrl: 'https://discord.com/api/webhooks/999/export-token',
      webhookName: 'Group Bot',
      createdAt: base
    });
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/export.xml',
      name: 'Exported Source',
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      mentionHere: true,
      threadId: '444',
      threadName: 'Export Thread',
      appliedTags: ['555', '666'],
      editInPlace: true,
      createdAt: base
    });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);

    const exported = await app.inject({ method: 'GET', url: '/api/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('rss-bridge-export-');
    const text = exported.body;
    expect(text).not.toContain('export-token');
    const document = exported.json();
    expect(document.groups[0]).not.toHaveProperty('webhookUrl');
    expect(document.sources[0]).not.toHaveProperty('webhookUrl');
    expect(document.sources[0].groupRefs).toEqual(['Exported']);
    expect(document.sources[0]).toMatchObject({
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      mentionHere: true,
      threadId: '444',
      threadName: 'Export Thread',
      appliedTags: ['555', '666'],
      editInPlace: true
    });

    const { app: targetApp, container: targetContainer } = await openApp();
    const dryRun = await targetApp.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.body).toContain('import-summary');

    const committed = await targetApp.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(committed.statusCode).toBe(204);
    expect(committed.headers['hx-redirect']).toBe('/sources');
    const imported = targetContainer.repositories.sources.findByFeedUrl('https://example.com/export.xml');
    expect(imported).toMatchObject({
      initialized: false,
      webhookUrl: null,
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      mentionHere: true,
      threadId: '444',
      threadName: 'Export Thread',
      appliedTags: ['555', '666'],
      editInPlace: true
    });
    expect(imported?.deliveryCutoffAt).not.toBeNull();

    expect(imported).not.toBeNull();
    targetContainer.repositories.sources.update(imported!.id, {
      silent: false,
      mentionRoleIds: ['999'],
      mentionUserIds: ['999'],
      mentionEveryone: false,
      mentionHere: false,
      threadId: null,
      threadName: null,
      appliedTags: [],
      editInPlace: false
    });
    const overwritten = await targetApp.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'overwrite' } });
    expect(overwritten.statusCode).toBe(204);
    const overwrittenSource = targetContainer.repositories.sources.findByFeedUrl('https://example.com/export.xml');
    expect(overwrittenSource).toMatchObject({
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      mentionHere: true,
      threadId: '444',
      threadName: 'Export Thread',
      appliedTags: ['555', '666'],
      editInPlace: true
    });
  });

  it('imports group webhooks into groups and links sources through source_groups', async () => {
    const { app, container } = await openApp();
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [
        {
          name: 'Legacy Ops',
          webhookUrl: 'https://discord.com/api/webhooks/777/group-token',
          webhookName: 'Group Bot',
          webhookAvatarUrl: 'https://cdn.example.com/group.png'
        }
      ],
      sources: [
        {
          feedUrl: 'https://example.com/group-webhook-import.xml',
          name: 'Group Webhook Source',
          enabled: true,
          profile: 'auto',
          pollIntervalSeconds: 300,
          translate: false,
          webhookUrl: 'https://discord.com/api/webhooks/888/ignored-source-token',
          webhookName: 'Source Bot',
          groupRefs: ['Legacy Ops']
        }
      ]
    };

    const dryRun = await app.inject({ method: 'POST', url: '/api/import/dry-run', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.body).not.toContain('legacy/group webhook을 목적지로 가져옵니다');

    const committed = await app.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(committed.statusCode).toBe(204);
    const imported = container.repositories.sources.findByFeedUrl('https://example.com/group-webhook-import.xml');
    expect(imported).toMatchObject({ webhookUrl: null, webhookName: 'Source Bot' });
    const importedGroup = container.repositories.groups.findByNameNocase('Legacy Ops');
    expect(importedGroup).toMatchObject({
      webhookUrl: 'https://discord.com/api/webhooks/777/group-token',
      webhookName: 'Group Bot',
      webhookAvatarUrl: 'https://cdn.example.com/group.png'
    });
    expect(container.repositories.sourceGroups.listGroupIdsForSource(imported!.id)).toEqual([importedGroup!.id]);
  });

  it('updates imported group webhooks on overwrite without creating per-source destinations', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({ name: 'Overwrite Channel', createdAt: base });
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/import-overwrite-channel.xml', createdAt: base });
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [
        {
          name: 'Overwrite Channel',
          webhookUrl: 'https://discord.com/api/webhooks/889/imported-group-token',
          webhookName: 'Imported Group Bot'
        }
      ],
      sources: [
        {
          feedUrl: source.feedUrl,
          name: 'Overwrite Source',
          enabled: true,
          profile: 'generic',
          pollIntervalSeconds: 300,
          translate: false,
          groupRefs: ['Overwrite Channel']
        }
      ]
    };

    const committed = await app.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'overwrite' } });
    expect(committed.statusCode).toBe(204);
    expect(container.repositories.groups.getById(group.id)).toMatchObject({
      webhookUrl: 'https://discord.com/api/webhooks/889/imported-group-token',
      webhookName: 'Imported Group Bot'
    });
    expect(container.repositories.sourceGroups.listGroupIdsForSource(source.id)).toEqual([group.id]);
  });

  it('keeps malformed group webhooks isolated to sources that reference that group', async () => {
    const { app, container } = await openApp();
    const existing = container.repositories.groups.create({
      name: 'Existing Channel',
      webhookUrl: 'https://discord.com/api/webhooks/891/group-token',
      webhookName: 'Existing Group Bot',
      createdAt: base
    });
    const document = {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: base,
      groups: [{ name: 'Bad Channel', webhookUrl: 'https://example.com/not-discord' }],
      sources: [
        {
          feedUrl: 'https://example.com/import-existing-channel.xml',
          name: 'Existing Channel Import',
          enabled: true,
          profile: 'generic',
          pollIntervalSeconds: 300,
          translate: false,
          groupRefs: [existing.name]
        },
        {
          feedUrl: 'https://example.com/import-bad-group-webhook.xml',
          name: 'Bad Group Webhook Import',
          enabled: true,
          profile: 'generic',
          pollIntervalSeconds: 300,
          translate: false,
          groupRefs: ['Bad Channel']
        }
      ]
    };

    const plan = await container.services.exportImport.dryRun(JSON.stringify(document), 'skip');
    expect(plan.blockedSources).toBe(1);
    expect(plan.blockedFeedUrls).toEqual([
      expect.objectContaining({ feedUrl: 'https://example.com/import-bad-group-webhook.xml', kind: 'webhook' })
    ]);
    expect(plan.addedSources).toBe(1);

    const committed = await app.inject({ method: 'POST', url: '/api/import', payload: { content: JSON.stringify(document), mode: 'skip' } });
    expect(committed.statusCode).toBe(204);
    const imported = container.repositories.sources.findByFeedUrl('https://example.com/import-existing-channel.xml');
    expect(imported).not.toBeNull();
    expect(container.repositories.sources.findByFeedUrl('https://example.com/import-bad-group-webhook.xml')).toBeNull();
    expect(container.repositories.sourceGroups.listGroupIdsForSource(imported!.id)).toEqual([existing.id]);
    expect(container.repositories.groups.findByNameNocase('Bad Channel')).toMatchObject({ webhookUrl: null });
  });


  it('exposes assigned group names alongside group ids on the source DTO', async () => {
    const { app, container } = await openApp();
    const group = container.repositories.groups.create({ name: 'Ops', createdAt: base });
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/group-names.xml', createdAt: base });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);

    const byId = await app.inject({ method: 'GET', url: `/api/sources/${source.id}` });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ id: source.id, groupIds: [group.id], groupNames: ['Ops'] });

    const list = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: source.id, groupIds: [group.id], groupNames: ['Ops'] }]);
  });

  it('labels fetch logs with the source name and falls back to null when unnamed', async () => {
    const { app, container } = await openApp();
    const named = container.repositories.sources.create({ feedUrl: 'https://example.com/named-log.xml', name: 'Named Source', createdAt: base });
    container.repositories.fetchLogs.append({ sourceId: named.id, outcome: '200', httpStatus: 200, itemsNew: 1, createdAt: base });

    const namedLogs = await app.inject({ method: 'GET', url: '/api/logs?type=fetch' });
    expect(namedLogs.statusCode).toBe(200);
    expect(namedLogs.json()).toMatchObject({ items: [{ sourceId: named.id, sourceName: 'Named Source' }] });

    const unnamed = container.repositories.sources.create({ feedUrl: 'https://example.com/unnamed-log.xml', name: null, createdAt: base });
    container.repositories.fetchLogs.append({ sourceId: unnamed.id, outcome: '200', httpStatus: 200, itemsNew: 1, createdAt: base });

    const allLogs = await app.inject({ method: 'GET', url: '/api/logs?type=fetch' });
    expect(allLogs.statusCode).toBe(200);
    const items = allLogs.json().items as Array<{ sourceId: string; sourceName: string | null }>;
    expect(items.find((entry) => entry.sourceId === named.id)).toMatchObject({ sourceName: 'Named Source' });
    expect(items.find((entry) => entry.sourceId === unnamed.id)).toMatchObject({ sourceName: null });
  });
});

function multipartPayload(fileContent: string, fields: Record<string, string> = {}): { contentType: string; body: string } {
  const boundary = `----rss-bridge-${Math.random().toString(16).slice(2)}`;
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value);
  }
  chunks.push(
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="rss-bridge-export.json"',
    'Content-Type: application/json',
    '',
    fileContent,
    `--${boundary}--`,
    ''
  );
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: chunks.join('\r\n') };
}

async function openApp(options: { verifyFeedUrl?: (value: string) => Promise<unknown> } = {}): Promise<{ app: AppInstance; container: Container }> {
  const container = createContainer({
    env: { DATABASE_PATH: ':memory:' },
    urlVerifiers: {
      verifyFeedUrl: options.verifyFeedUrl ?? (async () => undefined),
      verifyWebhookUrl: async () => undefined
    }
  });
  containers.push(container);
  const app = createApp({ container, logger: false });
  apps.push(app);
  await app.ready();
  return { app, container };
}
