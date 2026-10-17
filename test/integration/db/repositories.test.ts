import { afterEach, describe, expect, it } from 'vitest';
import { addSecondsIso } from '../../../src/server/db/time.js';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';

let containers: Container[] = [];

afterEach(async () => {
  for (const container of containers.splice(0)) {
    await container.close();
  }
});

describe('repository foundation', () => {
  it('wires group/source/template repositories and DB-authoritative poll state', () => {
    const container = openContainer();
    const { groups, sourceGroups, sources, templates } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';

    const group = groups.create({ name: 'Security Advisories', createdAt: base });
    expect(group.webhookUrl).toBeNull();
    expect(groups.findByNameNocase('security advisories')?.id).toBe(group.id);

    const template = templates.upsertBuiltin('default', 'Default', '{"content":"{{item.title}}"}', base);
    expect(template.isBuiltin).toBe(true);

    const source = sources.create({
      feedUrl: 'https://example.com/all.xml',
      name: 'Example Feed',
      templateId: template.id,
      pollIntervalSeconds: 60,
      fetchOptions: { charset: 'utf-8', timeoutMs: 5000 },
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      threadId: '444',
      threadName: 'Security Thread',
      appliedTags: ['555'],
      editInPlace: true,
      createdAt: base
    });
    sourceGroups.setGroups(source.id, [group.id, group.id]);

    expect(sourceGroups.listGroupIdsForSource(source.id)).toEqual([group.id]);
    expect(sourceGroups.listSourceIdsForGroup(group.id)).toEqual([source.id]);
    expect(sources.findByFeedUrl('https://example.com/all.xml')).toMatchObject({
      id: source.id,
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      threadId: '444',
      threadName: 'Security Thread',
      appliedTags: ['555'],
      editInPlace: true
    });
    expect(sources.findDuePoll(base).map((record) => record.id)).toContain(source.id);

    const claimed = sources.claimPollStarted(source.id, base);
    expect(claimed.lastPolledAt).toBe(base);

    const completed = sources.markPolled(source.id, base, {
      initialized: true,
      etag: 'etag-1',
      lastModified: 'Fri, 29 May 2026 00:00:00 GMT',
      detectedProfile: 'generic'
    });
    expect(completed.nextPollAt).toBe(addSecondsIso(base, 60));
    expect(sources.findDuePoll(base)).toEqual([]);
    expect(sources.findDuePoll(addSecondsIso(base, 60)).map((record) => record.id)).toEqual([source.id]);

    sources.setEnabled(source.id, false, base);
    expect(sources.findDuePoll(addSecondsIso(base, 60))).toEqual([]);
  });

  it('persists item delivery state, rendered fields, and translation cache transitions', () => {
    const container = openContainer();
    const { items, sources } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';
    const source = sources.create({ feedUrl: 'https://example.com/feed.xml', createdAt: base });

    expect(() =>
      items.insert({ sourceId: source.id, atomId: 'missing-hash', title: 'Missing hash', contentHash: '' })
    ).toThrow('items.content_hash must not be empty.');

    const item = items.insert({
      sourceId: source.id,
      atomId: 'atom-1',
      title: 'Title',
      link: 'https://example.com/item',
      summary: 'Summary',
      contentHash: 'hash-1',
      author: 'CISA',
      commentsUrl: 'https://example.com/comments',
      image: 'https://example.com/image.png',
      nextAttemptAt: base,
      createdAt: base
    });

    expect(items.findByAtomId(source.id, 'atom-1')?.id).toBe(item.id);
    expect(items.findDueDeliveries(base).map((record) => record.id)).toEqual([item.id]);
    expect(items.saveTranslation(item.id, '제목', '요약', base).translatedTitle).toBe('제목');

    const delivered = items.markDelivered(item.id, addSecondsIso(base, 1));
    expect(delivered.deliveryStatus).toBe('delivered');
    expect(delivered.nextAttemptAt).toBeNull();
    expect(items.findDueDeliveries(addSecondsIso(base, 2))).toEqual([]);

    const updated = items.updateContentHash(item.id, {
      title: 'Title changed',
      link: 'https://example.com/item',
      summary: 'Summary changed',
      contentHash: 'hash-2'
    });
    expect(updated).toMatchObject({
      contentHash: 'hash-2',
      translatedTitle: null,
      translatedSummary: null,
      translatedAt: null
    });

    const requeued = items.requeueForDelivery(item.id, addSecondsIso(base, 3));
    expect(requeued.deliveryStatus).toBe('pending');
    expect(requeued.deliveredAt).toBeNull();
    expect(requeued.attemptCount).toBe(0);
    expect(requeued.translatedTitle).toBeNull();
    expect(items.incrementAttempt(item.id)).toBe(1);

    const failed = items.markFailed(item.id, 'network', addSecondsIso(base, 4));
    expect(failed.deliveryStatus).toBe('failed');
    expect(failed.failureReason).toBe('network');
    expect(failed.nextAttemptAt).toBeNull();

    const failedStale = items.insert({
      sourceId: source.id,
      atomId: 'failed-stale',
      title: 'Failed stale',
      contentHash: 'hash-stale',
      deliveryStatus: 'failed',
      deliveredAt: base,
      failedAt: base,
      failureReason: 'network',
      createdAt: base
    });
    const retryAt = addSecondsIso(base, 5);
    expect(items.requeueFailedBySource(source.id, retryAt)).toBe(2);
    expect(items.getById(item.id)).toMatchObject({ deliveryStatus: 'pending', deliveredAt: null, nextAttemptAt: retryAt });
    expect(items.getById(failedStale.id)).toMatchObject({ deliveryStatus: 'pending', deliveredAt: null, nextAttemptAt: retryAt });
    items.markDelivered(item.id, addSecondsIso(base, 6));
    items.markDelivered(failedStale.id, addSecondsIso(base, 6));

    const historical = items.insert({
      sourceId: source.id,
      atomId: 'baseline',
      title: 'Baseline',
      contentHash: 'hash-3',
      deliveryStatus: 'pending',
      nextAttemptAt: base
    });
    expect(items.markHistorical(historical.id).deliveryStatus).toBe('historical');
    expect(items.findDueDeliveries(addSecondsIso(base, 10))).toEqual([]);
  });

  it('records delivery/fetch/model logs with id cursors and retention pruning', () => {
    const container = openContainer();
    const { deliveryLogs, fetchLogs, items, modelConfig, modelUsage, sources } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';
    const old = '2025-01-01T00:00:00.000Z';
    const source = sources.create({ feedUrl: 'https://example.com/logs.xml', createdAt: base });
    const item = items.insert({ sourceId: source.id, atomId: 'atom-log', contentHash: 'hash-log', createdAt: base });

    const success = deliveryLogs.append({
      itemId: item.id,
      attemptNo: 1,
      status: 'success',
      httpStatus: 204,
      renderedBytes: 512,
      destinationKey: 'dest-1',
      contentHash: 'hash-log',
      discordMessageId: '9001',
      createdAt: base
    });
    deliveryLogs.append({
      itemId: item.id,
      attemptNo: 2,
      status: 'failed',
      failureReason: 'webhook_rejected',
      destinationKey: 'dest-2',
      contentHash: 'hash-log',
      createdAt: addSecondsIso(base, 1)
    });
    deliveryLogs.append({ itemId: item.id, attemptNo: 1, status: 'failed', createdAt: old });

    expect(deliveryLogs.findResolved(item.id, 'dest-1', 'hash-log')?.id).toBe(success.id);
    expect(deliveryLogs.findLatestMessageId(item.id, 'dest-1')).toBe('9001');
    expect(deliveryLogs.findResolved(item.id, 'dest-2', 'hash-log')?.failureReason).toBe('webhook_rejected');
    expect(deliveryLogs.list({ before: success.id + 10, limit: 1 })).toHaveLength(1);
    expect(deliveryLogs.pruneOlderThan(30, base)).toBe(1);

    const fetchLog = fetchLogs.append({
      sourceId: source.id,
      outcome: '200',
      httpStatus: 200,
      itemsNew: 1,
      durationMs: 25,
      createdAt: base
    });
    fetchLogs.append({ sourceId: source.id, outcome: 'error', error: 'timeout', createdAt: old });
    expect(fetchLogs.list({ sourceId: source.id, before: fetchLog.id + 1 }).map((log) => log.id)).toContain(fetchLog.id);
    expect(fetchLogs.pruneOlderThan(30, base)).toBe(1);

    expect(modelConfig.getByRole('primary')).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      enabled: true,
      promptLogMaxBytes: 32768
    });
    const disabledPrimary = modelConfig.updateRole('primary', { enabled: false, updatedAt: base });
    expect(disabledPrimary.enabled).toBe(false);

    const usage = modelUsage.append({
      role: 'primary',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 30,
      promptLog: 'system prompt + user prompt',
      createdAt: base
    });
    modelUsage.append({
      role: 'primary',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      error: 'disabled',
      createdAt: old
    });
    const usageList = modelUsage.list({ before: usage.id + 1 });
    expect(usageList[0]).toMatchObject({ id: usage.id, inputTokens: 10, outputTokens: 20 });
    expect(Object.prototype.hasOwnProperty.call(usageList[0], 'promptLog')).toBe(false);
    expect(modelUsage.pruneOlderThan(30, base)).toBe(1);
  });
});

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}
