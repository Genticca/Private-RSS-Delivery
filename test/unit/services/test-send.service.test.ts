import { afterEach, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';
import type { WebhookPostRequest } from '../../../src/server/dispatcher/discord-client.js';
import { TestSendService } from '../../../src/server/services/test-send.service.js';

const containers: Container[] = [];
const base = '2026-05-29T00:00:00.000Z';

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('TestSendService', () => {
  it('uses the resolved group destination and applies source webhook options', async () => {
    const container = openContainer();
    const source = container.repositories.sources.create({
      id: 'source-group-options',
      feedUrl: 'https://example.com/options.xml',
      webhookName: 'Source Bot',
      silent: true,
      mentionEveryone: true,
      mentionRoleIds: ['111'],
      threadId: '444',
      createdAt: base
    });
    attachGroup(container, source.id, 'https://discord.com/api/webhooks/123/group-token', {
      webhookName: 'Group Bot'
    });
    const requests: WebhookPostRequest[] = [];
    const service = new TestSendService({
      repositories: container.repositories,
      preview: container.services.preview,
      postWebhook: async (request) => {
        requests.push(request);
        return { statusCode: 204 };
      }
    });

    await expect(service.testSource(source.id)).resolves.toEqual({ ok: true, statusCode: 204 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.destination).toMatchObject({ webhookUrl: 'https://discord.com/api/webhooks/123/group-token', threadId: '444' });
    expect(requests[0]?.payload).toMatchObject({
      username: 'Source Bot',
      flags: 4096,
      allowed_mentions: { parse: ['everyone'], roles: ['111'], users: [] }
    });
    expect(requests[0]?.payload.content).toBe('@everyone <@&111> 🧪 [테스트 전송] ');
  });

  it('keeps the final marked and mentioned content within the Discord limit', async () => {
    const container = openContainer();
    const template = container.repositories.templates.create({
      name: 'long-test-send-content',
      label: 'Long test-send content',
      body: JSON.stringify({ content: 'x'.repeat(1990) }),
      createdAt: base
    });
    const source = container.repositories.sources.create({
      id: 'source-long-content',
      feedUrl: 'https://example.com/long.xml',
      templateId: template.id,
      mentionRoleIds: ['333'],
      createdAt: base
    });
    attachGroup(container, source.id, 'https://discord.com/api/webhooks/123/long-token');
    const requests: WebhookPostRequest[] = [];
    const service = new TestSendService({
      repositories: container.repositories,
      preview: container.services.preview,
      postWebhook: async (request) => {
        requests.push(request);
        return { statusCode: 204 };
      }
    });

    await expect(service.testSource(source.id)).resolves.toEqual({ ok: true, statusCode: 204 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload.content?.length).toBe(2000);
    expect(requests[0]?.payload.content).toMatch(/^<@&333> 🧪 \[테스트 전송\] /);
  });

  it('maps unsafe stored group URLs to validation errors for test sends', async () => {
    const container = openContainer();
    const source = container.repositories.sources.create({
      id: 'source-unsafe-group',
      feedUrl: 'https://example.com/unsafe.xml',
      createdAt: base
    });
    attachGroup(container, source.id, 'https://example.com/not-discord');
    let posts = 0;
    const service = new TestSendService({
      repositories: container.repositories,
      preview: container.services.preview,
      postWebhook: async () => {
        posts += 1;
        return { statusCode: 204 };
      }
    });

    await expect(service.testSource(source.id)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('목적지 웹훅이 차단되었습니다')
    });
    expect(posts).toBe(0);
  });

  it('does not consume the cooldown when validation fails before the Discord POST', async () => {
    const container = openContainer();
    const sourceId = 'source-validation-cooldown';
    let now = 1_000;
    let posts = 0;
    const service = new TestSendService({
      repositories: container.repositories,
      preview: container.services.preview,
      now: () => now,
      postWebhook: async () => {
        posts += 1;
        return { statusCode: 204 };
      }
    });

    container.repositories.sources.create({
      id: sourceId,
      feedUrl: 'https://example.com/feed.xml',
      createdAt: base
    });

    await expect(service.testSource(sourceId)).rejects.toMatchObject({ code: 'validation_error' });
    attachGroup(container, sourceId, 'https://discord.com/api/webhooks/123/test-token');

    await expect(service.testSource(sourceId)).resolves.toEqual({ ok: true, statusCode: 204 });
    expect(posts).toBe(1);

    now += 1;
    await expect(service.testSource(sourceId)).rejects.toMatchObject({
      code: 'validation_error',
      message: '테스트는 잠시 후 다시 시도하세요.'
    });
    expect(posts).toBe(1);
  });
});

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}

function attachGroup(
  container: Container,
  sourceId: string,
  webhookUrl: string,
  patch: { webhookName?: string | null; webhookAvatarUrl?: string | null } = {}
): void {
  const group = container.repositories.groups.create({
    name: `Test Group ${sourceId}-${Math.random()}`,
    webhookUrl,
    webhookName: patch.webhookName ?? null,
    webhookAvatarUrl: patch.webhookAvatarUrl ?? null,
    createdAt: base
  });
  container.repositories.sourceGroups.setGroups(sourceId, [group.id]);
}
