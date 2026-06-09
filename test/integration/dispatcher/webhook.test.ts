import { afterEach, describe, expect, it } from 'vitest';
import { createDestinationKey } from '../../../src/server/dispatcher/resolve-destinations.js';
import {
  WebhookDispatcher,
  type WebhookEditRequest,
  type WebhookPostRequest,
  type WebhookPostResponse
} from '../../../src/server/dispatcher/webhook.js';
import { canonicalWebhookUrl } from '../../../src/server/security/webhook-guard.js';
import { addSecondsIso } from '../../../src/server/db/time.js';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';
import type { CreateSourceInput } from '../../../src/server/db/source.repository.js';

const containers: Container[] = [];
const base = '2026-05-29T00:00:00.000Z';

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('WebhookDispatcher', () => {
  it('posts a due item once, records success, and marks it delivered', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container);

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 1, nextAttemptAt: null }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.username).toBe('Source Bot');
    expect(calls[0]?.payload.embeds?.[0]?.title).toBe('Article');
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'delivered', nextAttemptAt: null });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toMatchObject([
      { status: 'success', httpStatus: 204, attemptNo: 1, contentHash: 'hash-1' }
    ]);
  });

  it('skips due items without destinations and delivers them after a group webhook is attached', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const template = requireMinimalTemplate(container);
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/feed.xml', templateId: template.id });
    const item = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'atom-no-dest',
      title: 'No destination',
      summary: 'Summary',
      contentHash: 'hash-no-dest',
      nextAttemptAt: base,
      createdAt: base
    });

    const skipped = await dispatcher.runDueDeliveries(base);

    expect(skipped).toEqual([{ itemId: item.id, outcome: 'skipped', attemptNo: 1 }]);
    expect(calls).toEqual([]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({
      deliveryStatus: 'pending',
      failureReason: null,
      nextAttemptAt: base
    });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toEqual([]);

    attachDeliveryGroup(container, source.id, 'https://discord.com/api/webhooks/123/no-destination-recovered');
    const delivered = await dispatcher.runDueDeliveries(base);

    expect(delivered).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 1, nextAttemptAt: null }]);
    expect(calls).toHaveLength(1);
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toMatchObject([
      { status: 'success', attemptNo: 1, destinationKey: expect.any(String), contentHash: 'hash-no-dest' }
    ]);
  });

  it('uses retry-after/backoff for transient failures and stops on the fifth failed attempt', async () => {
    const container = openContainer();
    const dispatcher = createDispatcher(container, async () => ({ statusCode: 429, retryAfterMs: 180_000, error: 'rate limited' }));
    const { item } = createPendingItem(container);

    const first = await dispatcher.runDueDeliveries(base);
    expect(first).toEqual([{ itemId: item.id, outcome: 'retrying', attemptNo: 1, nextAttemptAt: addSecondsIso(base, 180) }]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ attemptCount: 1, nextAttemptAt: addSecondsIso(base, 180) });

    const fifthAttemptItem = container.repositories.items.insert({
      sourceId: item.sourceId,
      atomId: 'atom-fifth',
      title: 'Fifth',
      summary: 'Summary',
      contentHash: 'hash-fifth',
      attemptCount: 4,
      nextAttemptAt: base,
      createdAt: base
    });

    const final = await dispatcher.runDueDeliveries(base);
    expect(final).toEqual([{ itemId: fifthAttemptItem.id, outcome: 'failed', attemptNo: 5, failureReason: 'max_retries', nextAttemptAt: null }]);
    expect(container.repositories.items.getById(fifthAttemptItem.id)).toMatchObject({
      deliveryStatus: 'failed',
      attemptCount: 5,
      failureReason: 'max_retries',
      nextAttemptAt: null
    });
  });

  it('records terminal webhook rejection and fails the item once all destinations are settled', async () => {
    const container = openContainer();
    const dispatcher = createDispatcher(container, async () => ({ statusCode: 404, error: 'unknown webhook' }));
    const { item } = createPendingItem(container);

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'failed', attemptNo: 1, failureReason: 'webhook_rejected', nextAttemptAt: null }]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'failed', failureReason: 'webhook_rejected' });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toMatchObject([
      { status: 'failed', httpStatus: 404, failureReason: 'webhook_rejected' }
    ]);
  });

  it('retries only unresolved destinations after partial success', async () => {
    const container = openContainer();
    const firstCalls: string[] = [];
    const { item, retryUrl, successUrl } = createGroupedPendingItem(container);
    const firstDispatcher = createDispatcher(container, async (request) => {
      firstCalls.push(request.destination.webhookUrl);
      return request.destination.webhookUrl === successUrl ? { statusCode: 204 } : { statusCode: 500, error: 'server error' };
    });

    const first = await firstDispatcher.runDueDeliveries(base);

    expect(first).toEqual([{ itemId: item.id, outcome: 'retrying', attemptNo: 1, nextAttemptAt: addSecondsIso(base, 60) }]);
    expect(firstCalls.sort()).toEqual([retryUrl, successUrl].sort());

    const secondCalls: string[] = [];
    const secondDispatcher = createDispatcher(container, async (request) => {
      secondCalls.push(request.destination.webhookUrl);
      return { statusCode: 204 };
    });

    const second = await secondDispatcher.runDueDeliveries(addSecondsIso(base, 60));

    expect(second).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 2, nextAttemptAt: null }]);
    expect(secondCalls).toEqual([retryUrl]);
    expect(container.repositories.deliveryLogs.list({ itemId: item.id }).map((log) => log.status)).toEqual([
      'success',
      'skipped',
      'failed',
      'success'
    ]);
  });

  it('keeps terminal destination failures resolved while retrying transient destinations', async () => {
    const container = openContainer();
    const { item, retryUrl, successUrl: terminalUrl } = createGroupedPendingItem(container);
    const firstDispatcher = createDispatcher(container, async (request) =>
      request.destination.webhookUrl === terminalUrl ? { statusCode: 404, error: 'gone' } : { statusCode: 500, error: 'server error' }
    );

    const first = await firstDispatcher.runDueDeliveries(base);

    expect(first).toEqual([{ itemId: item.id, outcome: 'retrying', attemptNo: 1, nextAttemptAt: addSecondsIso(base, 60) }]);

    const secondCalls: string[] = [];
    const secondDispatcher = createDispatcher(container, async (request) => {
      secondCalls.push(request.destination.webhookUrl);
      return { statusCode: 204 };
    });

    const second = await secondDispatcher.runDueDeliveries(addSecondsIso(base, 60));

    expect(second).toEqual([{ itemId: item.id, outcome: 'failed', attemptNo: 2, failureReason: 'webhook_rejected', nextAttemptAt: null }]);
    expect(secondCalls).toEqual([retryUrl]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'failed', failureReason: 'webhook_rejected' });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id }).map((log) => log.status)).toEqual(['success', 'failed', 'failed']);
  });

  it('does not append a new log for a destination already terminal-failed for the same content hash', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container);
    container.repositories.deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'failed',
      destinationKey: destinationKeyForWebhook(),
      contentHash: item.contentHash,
      failureReason: 'webhook_rejected',
      createdAt: base
    });

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'failed', attemptNo: 1, failureReason: 'webhook_rejected', nextAttemptAt: null }]);
    expect(calls).toEqual([]);
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toHaveLength(1);
  });

  it('fails validation errors without posting or scheduling retry', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const template = requireMinimalTemplate(container);
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/feed.xml',
      templateId: template.id,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id, 'https://discord.com/api/webhooks/123/token');
    const item = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'atom-validate',
      title: 'x'.repeat(257),
      link: 'https://example.com/article',
      summary: 'Summary',
      contentHash: 'hash-validate',
      nextAttemptAt: base,
      createdAt: base
    });

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'failed', attemptNo: 1, failureReason: 'validate', nextAttemptAt: null }]);
    expect(calls).toEqual([]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'failed', failureReason: 'validate' });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toMatchObject([
      { status: 'failed', attemptNo: 1, failureReason: 'validate', destinationKey: null, contentHash: 'hash-validate' }
    ]);
  });

  it('skips destinations already successful for the same content hash using a legacy destination key', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const legacyUrl = 'https://discord.com/api/webhooks/123/tokenabc';
    const { item } = createPendingItem(container, {}, {}, ['https://discord.com/api/webhooks/123/TokenABC/']);
    container.repositories.deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'success',
      destinationKey: destinationKeyForWebhook(legacyUrl),
      contentHash: item.contentHash,
      createdAt: base
    });

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 1, nextAttemptAt: null }]);
    expect(calls).toEqual([]);
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })[0]).toMatchObject({ status: 'skipped' });
  });

  it('does not skip a previous success when content_hash changed', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container, { contentHash: 'hash-new' });
    container.repositories.deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'success',
      destinationKey: destinationKeyForWebhook(),
      contentHash: 'hash-old',
      createdAt: base
    });

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(1);
    expect(container.repositories.deliveryLogs.list({ itemId: item.id }).map((log) => log.status)).toEqual(['success', 'success']);
  });

  it('reposts on the next run if the post succeeded but the DB commit failed', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container);
    const append = container.repositories.deliveryLogs.append.bind(container.repositories.deliveryLogs);
    let failCommit = true;
    container.repositories.deliveryLogs.append = (input) => {
      if (failCommit) {
        failCommit = false;
        throw new Error('commit failed');
      }
      return append(input);
    };

    await expect(dispatcher.runDueDeliveries(base)).rejects.toThrow('commit failed');
    expect(calls).toHaveLength(1);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'pending', attemptCount: 0 });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toEqual([]);

    const second = await dispatcher.runDueDeliveries(base);

    expect(second).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 1, nextAttemptAt: null }]);
    expect(calls).toHaveLength(2);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'delivered' });
  });


  it('injects silent flags, mentions, and forum thread fields into the outgoing payload', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(
      container,
      {},
      {
        silent: true,
        mentionRoleIds: ['111', '222'],
        mentionUserIds: ['333'],
        mentionEveryone: true,
        threadId: '444',
        threadName: 'Status Updates',
        appliedTags: ['555']
      }
    );

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.destination.threadId).toBe('444');
    expect(calls[0]?.captureMessageId).toBe(false);
    expect(calls[0]?.payload).toMatchObject({
      flags: 4096,
      content: '@everyone <@&111> <@&222> <@333>',
      allowed_mentions: { parse: ['everyone'], roles: ['111', '222'], users: ['333'] },
      thread_name: 'Status Updates',
      applied_tags: ['555']
    });
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'delivered' });
  });

  it('applies source mention options uniformly to every selected group destination', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    createPendingItem(
      container,
      {},
      {
        mentionEveryone: true,
        mentionHere: true,
        mentionRoleIds: ['111'],
        mentionUserIds: ['222']
      },
      ['https://discord.com/api/webhooks/123/first', 'https://discord.com/api/webhooks/124/second']
    );

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.payload.content).toBe('@everyone @here <@&111> <@222>');
      expect(call.payload.allowed_mentions).toEqual({ parse: ['everyone'], roles: ['111'], users: ['222'] });
    }
  });

  it('prepends @here and enables the everyone parse token when mentionHere is set', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container, {}, { mentionHere: true });

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(1);
    const payload = calls[0]?.payload;
    expect(payload?.content?.startsWith('@here')).toBe(true);
    expect(payload?.allowed_mentions).toMatchObject({ parse: ['everyone'] });
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'delivered' });
  });

  it('auto-generates a forum thread_name from the item title when the admin leaves it blank', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    // 포럼 대상(appliedTags 지정)인데 threadName/threadId 미지정 → 항목 제목으로 자동 생성되어야 한다.
    createPendingItem(container, {}, { appliedTags: ['555'] });

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      thread_name: 'Article',
      applied_tags: ['555']
    });
  });

  it('truncates an auto-generated forum thread_name to 100 characters', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    createPendingItem(container, { title: 'x'.repeat(150) }, { appliedTags: ['555'] });

    await dispatcher.runDueDeliveries(base);

    expect(calls[0]?.payload.thread_name).toBe('x'.repeat(100));
  });

  it('does not inject a thread_name into non-forum destinations', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    // 텍스트 채널(appliedTags 없음, threadName 없음): thread_name이 붙으면 안 된다.
    createPendingItem(container, {}, {});

    await dispatcher.runDueDeliveries(base);

    expect(calls[0]?.payload.thread_name).toBeUndefined();
  });

  it('does not auto-generate a thread_name when targeting an existing thread', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    createPendingItem(container, {}, { threadId: '444', appliedTags: ['555'] });

    await dispatcher.runDueDeliveries(base);

    expect(calls[0]?.destination.threadId).toBe('444');
    expect(calls[0]?.payload.thread_name).toBeUndefined();
  });

  it('captures Discord message ids only when edit-in-place is enabled', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 200, messageId: '9001' };
    });
    const { item } = createPendingItem(container, {}, { editInPlace: true });

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 1, nextAttemptAt: null }]);
    expect(calls[0]?.captureMessageId).toBe(true);
    expect(container.repositories.deliveryLogs.findLatestMessageId(item.id, destinationKeyForWebhook())).toBe('9001');
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })[0]).toMatchObject({ status: 'success', discordMessageId: '9001' });
  });

  it('edits a previous Discord message when content changes and edit-in-place is enabled using a legacy destination key', async () => {
    const container = openContainer();
    const postCalls: WebhookPostRequest[] = [];
    const editCalls: WebhookEditRequest[] = [];
    const dispatcher = createDispatcher(
      container,
      async (request) => {
        postCalls.push(request);
        return { statusCode: 204 };
      },
      async (request) => {
        editCalls.push(request);
        return { statusCode: 200 };
      }
    );
    const legacyUrl = 'https://discord.com/api/webhooks/123/tokenabc';
    const { item } = createPendingItem(
      container,
      { contentHash: 'hash-new' },
      { editInPlace: true },
      ['https://discord.com/api/webhooks/123/TokenABC/']
    );
    container.repositories.deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'success',
      destinationKey: destinationKeyForWebhook(legacyUrl),
      contentHash: 'hash-old',
      discordMessageId: '9001',
      createdAt: base
    });

    await dispatcher.runDueDeliveries(base);

    expect(postCalls).toEqual([]);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toMatchObject({ messageId: '9001' });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })[0]).toMatchObject({
      status: 'success',
      contentHash: 'hash-new',
      discordMessageId: '9001'
    });
  });

  it('falls back to a fresh POST and stores the new message id when Discord edit returns 404', async () => {
    const container = openContainer();
    const postCalls: WebhookPostRequest[] = [];
    const editCalls: WebhookEditRequest[] = [];
    const dispatcher = createDispatcher(
      container,
      async (request) => {
        postCalls.push(request);
        return { statusCode: 200, messageId: '9002' };
      },
      async (request) => {
        editCalls.push(request);
        return { statusCode: 404, error: 'unknown message' };
      }
    );
    const { item } = createPendingItem(container, { contentHash: 'hash-new' }, { editInPlace: true });
    container.repositories.deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'success',
      destinationKey: destinationKeyForWebhook(),
      contentHash: 'hash-old',
      discordMessageId: '9001',
      createdAt: base
    });

    await dispatcher.runDueDeliveries(base);

    expect(editCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.captureMessageId).toBe(true);
    expect(container.repositories.deliveryLogs.findLatestMessageId(item.id, destinationKeyForWebhook())).toBe('9002');
  });

  it('leaves disabled source pending items out of the due scan', async () => {
    const container = openContainer();
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item, source } = createPendingItem(container);
    container.repositories.sources.setEnabled(source.id, false, base);

    expect(await dispatcher.runDueDeliveries(base)).toEqual([]);
    expect(calls).toEqual([]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'pending' });
  });
});

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}

function createDispatcher(
  container: Container,
  postWebhook: (request: WebhookPostRequest) => Promise<WebhookPostResponse> = async () => ({ statusCode: 204 }),
  editWebhook?: (request: WebhookEditRequest) => Promise<WebhookPostResponse>
) {
  return new WebhookDispatcher({ db: container.db, repositories: container.repositories, postWebhook, editWebhook });
}

function requireMinimalTemplate(container: Container) {
  const template = container.repositories.templates.findByName('minimal');
  if (!template) throw new Error('minimal preset missing');
  return template;
}

function createPendingItem(
  container: Container,
  itemPatch: { contentHash?: string; title?: string } = {},
  sourcePatch: Partial<CreateSourceInput> = {},
  groupWebhookUrls: readonly string[] = ['https://discord.com/api/webhooks/123/token']
) {
  const template = requireMinimalTemplate(container);
  const source = container.repositories.sources.create({
    feedUrl: 'https://example.com/feed.xml',
    name: 'Example Feed',
    templateId: template.id,
    webhookName: 'Source Bot',
    createdAt: base,
    ...sourcePatch
  });
  attachDeliveryGroups(container, source.id, groupWebhookUrls);
  const item = container.repositories.items.insert({
    sourceId: source.id,
    atomId: `atom-${Math.random()}`,
    title: itemPatch.title ?? 'Article',
    link: 'https://example.com/article',
    summary: 'Summary',
    contentHash: itemPatch.contentHash ?? 'hash-1',
    nextAttemptAt: base,
    createdAt: base
  });
  return { source, item };
}

function attachDeliveryGroup(container: Container, sourceId: string, webhookUrl: string): void {
  attachDeliveryGroups(container, sourceId, [webhookUrl]);
}

function attachDeliveryGroups(container: Container, sourceId: string, webhookUrls: readonly string[]): void {
  const groupIds = webhookUrls.map((webhookUrl, index) =>
    container.repositories.groups.create({ name: `Delivery Group ${sourceId}-${index}`, webhookUrl, createdAt: base }).id
  );
  container.repositories.sourceGroups.setGroups(sourceId, groupIds);
}

function createGroupedPendingItem(container: Container) {
  const template = requireMinimalTemplate(container);
  const successUrl = 'https://discord.com/api/webhooks/111/success';
  const retryUrl = 'https://discord.com/api/webhooks/222/retry';
  const successGroup = container.repositories.groups.create({ name: 'Success Group', webhookUrl: successUrl, createdAt: base });
  const retryGroup = container.repositories.groups.create({ name: 'Retry Group', webhookUrl: retryUrl, createdAt: base });
  const source = container.repositories.sources.create({
    feedUrl: 'https://example.com/grouped.xml',
    name: 'Grouped Feed',
    templateId: template.id,
    createdAt: base
  });
  container.repositories.sourceGroups.setGroups(source.id, [successGroup.id, retryGroup.id]);
  const item = container.repositories.items.insert({
    sourceId: source.id,
    atomId: 'atom-grouped',
    title: 'Grouped Article',
    link: 'https://example.com/grouped',
    summary: 'Summary',
    contentHash: 'hash-grouped',
    nextAttemptAt: base,
    createdAt: base
  });
  return { source, item, successUrl, retryUrl };
}

function destinationKeyForWebhook(url = 'https://discord.com/api/webhooks/123/token'): string {
  return createDestinationKey(canonicalWebhookUrl(url));
}
