import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Container } from '../../../src/server/runtime/container.js';
import { createContainer } from '../../../src/server/runtime/container.js';
import { addSecondsIso } from '../../../src/server/db/time.js';
import type { FeedFetchResult, FeedFetchSource, FetchFeedOptions } from '../../../src/server/security/index.js';
import { Poller } from '../../../src/server/scheduler/poller.js';
import { readFeedFixture } from '../../mocks/fixtures.js';

let containers: Container[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const container of containers.splice(0)) {
    await container.close();
  }
});

describe('Poller', () => {
  it('stores the first successful status-page poll as historical baseline without due deliveries', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://status.openai.com/history.atom',
      deliveryCutoffAt: base,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const poller = createPoller(container, [ok(await readFeedFixture('OpenAI.atom'))]);

    const result = await poller.pollSource(source, base);

    expect(result).toMatchObject({
      outcome: '200',
      httpStatus: 200,
      itemsNew: 0,
      itemsHistorical: 91,
      itemsChanged: 0,
      itemsSkipped: 0,
      detectedProfile: 'incident-io'
    });
    const updatedSource = requireSource(container, source.id);
    expect(updatedSource.initialized).toBe(true);
    expect(updatedSource.detectedProfile).toBe('incident-io');
    expect(updatedSource.nextPollAt).toBe(addSecondsIso(base, 300));
    expect(container.repositories.items.findDueDeliveries(base)).toEqual([]);
    expect(container.repositories.fetchLogs.list({ sourceId: source.id })[0]).toMatchObject({
      outcome: '200',
      itemsNew: 0,
      itemsHistorical: 91
    });
  });

  it('queues only new post-cutoff or undated items after initialization', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/rss.xml',
      initialized: true,
      deliveryCutoffAt: base,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const poller = createPoller(container, [
      ok(rssFeed([rssItem('old', 'Old', 'Fri, 01 May 2026 00:00:00 GMT'), rssItem('new', 'New', 'Fri, 29 May 2026 00:01:00 GMT'), rssItem('nodate', 'No Date')]))
    ]);

    const result = await poller.pollSource(source, base);

    expect(result).toMatchObject({
      outcome: '200',
      itemsNew: 2,
      itemsHistorical: 1
    });
    expect(container.repositories.items.findByAtomId(source.id, 'old')?.deliveryStatus).toBe('historical');
    expect(container.repositories.items.findByAtomId(source.id, 'new')?.deliveryStatus).toBe('pending');
    expect(container.repositories.items.findByAtomId(source.id, 'nodate')?.deliveryStatus).toBe('pending');
    expect(container.repositories.items.findDueDeliveries(base).map((item) => item.atomId).sort()).toEqual(['new', 'nodate']);
  });

  it('updates changed existing items but requeues only delivered rows', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/rss.xml',
      initialized: true,
      deliveryCutoffAt: '2026-01-01T00:00:00.000Z',
      translate: true,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const delivered = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'delivered',
      title: 'Delivered',
      contentHash: 'old-delivered',
      deliveryStatus: 'delivered',
      deliveredAt: base,
      createdAt: base
    });
    container.repositories.items.saveTranslation(delivered.id, 'old title', 'old summary', base);
    const pending = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'pending',
      title: 'Pending',
      contentHash: 'old-pending',
      deliveryStatus: 'pending',
      nextAttemptAt: base,
      createdAt: base
    });
    container.repositories.items.saveTranslation(pending.id, 'pending old title', 'pending old summary', base);
    container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'historical',
      title: 'Historical',
      contentHash: 'old-historical',
      deliveryStatus: 'historical',
      createdAt: base
    });
    container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'failed',
      title: 'Failed',
      contentHash: 'old-failed',
      deliveryStatus: 'failed',
      failedAt: base,
      failureReason: 'max_retries',
      createdAt: base
    });
    const poller = createPoller(container, [
      ok(
        rssFeed([
          rssItem('delivered', 'Delivered changed', 'Fri, 29 May 2026 00:10:00 GMT', 'changed delivered body'),
          rssItem('pending', 'Pending changed', 'Fri, 29 May 2026 00:10:00 GMT', 'changed pending body'),
          rssItem('historical', 'Historical changed', 'Fri, 29 May 2026 00:10:00 GMT', 'changed historical body'),
          rssItem('failed', 'Failed changed', 'Fri, 29 May 2026 00:10:00 GMT', 'changed failed body')
        ])
      )
    ]);

    const result = await poller.pollSource(source, base);

    expect(result).toMatchObject({ itemsChanged: 4, itemsSkipped: 0 });
    const changedDelivered = container.repositories.items.findByAtomId(source.id, 'delivered');
    const changedPending = container.repositories.items.findByAtomId(source.id, 'pending');
    const changedHistorical = container.repositories.items.findByAtomId(source.id, 'historical');
    const changedFailed = container.repositories.items.findByAtomId(source.id, 'failed');
    expect(changedDelivered).toMatchObject({
      deliveryStatus: 'pending',
      attemptCount: 0,
      nextAttemptAt: base,
      translatedTitle: null,
      translatedSummary: null,
      translatedAt: null
    });
    expect(changedPending).toMatchObject({
      deliveryStatus: 'pending',
      nextAttemptAt: base,
      translatedTitle: null,
      translatedSummary: null,
      translatedAt: null
    });
    expect(changedHistorical).toMatchObject({ deliveryStatus: 'historical', nextAttemptAt: null });
    expect(changedFailed).toMatchObject({ deliveryStatus: 'failed', nextAttemptAt: null, failureReason: 'max_retries' });
    expect(container.repositories.items.findDueDeliveries(base).map((item) => item.atomId).sort()).toEqual(['delivered', 'pending']);
  });

  it('redetects an auto profile after the feed URL changes between generic and incident feeds', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/generic.xml',
      deliveryCutoffAt: base,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const firstPoller = createPoller(container, [ok(rssFeed([rssItem('generic-1', 'Generic', 'Fri, 29 May 2026 00:01:00 GMT')]))]);

    await firstPoller.pollSource(source, base);
    expect(requireSource(container, source.id).detectedProfile).toBe('generic');

    await container.services.sources.update(source.id, { feedUrl: 'https://status.openai.com/history.atom' });
    expect(requireSource(container, source.id).detectedProfile).toBeNull();

    const secondPoller = createPoller(container, [ok(await readFeedFixture('OpenAI.atom'))]);
    const result = await secondPoller.pollSource(requireSource(container, source.id), addSecondsIso(base, 1));

    expect(result.detectedProfile).toBe('incident-io');
    expect(requireSource(container, source.id).detectedProfile).toBe('incident-io');
  });

  it('handles 304 without parsing or changing profile/items', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/rss.xml',
      initialized: true,
      detectedProfile: 'generic',
      etag: '"old"',
      lastModified: 'Thu, 28 May 2026 00:00:00 GMT',
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const poller = createPoller(container, [notModified('"new"', 'Fri, 29 May 2026 00:00:00 GMT')]);

    const result = await poller.pollSource(source, base);

    expect(result).toMatchObject({ outcome: '304', httpStatus: 304 });
    const updatedSource = requireSource(container, source.id);
    expect(updatedSource.detectedProfile).toBe('generic');
    expect(updatedSource.etag).toBe('"new"');
    expect(updatedSource.lastModified).toBe('Fri, 29 May 2026 00:00:00 GMT');
    expect(container.repositories.items.findDueDeliveries(base)).toEqual([]);
    expect(container.repositories.fetchLogs.list({ sourceId: source.id })[0]).toMatchObject({
      outcome: '304',
      httpStatus: 304,
      itemsNew: 0,
      itemsHistorical: 0,
      itemsChanged: 0,
      itemsSkipped: 0
    });
  });

  it('records parse errors and still schedules the next poll', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/bad.xml',
      initialized: false,
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const poller = createPoller(container, [ok('<rss><channel><item></channel></rss>')]);

    const result = await poller.pollSource(source, base);

    expect(result.outcome).toBe('error');
    const updatedSource = requireSource(container, source.id);
    expect(updatedSource.initialized).toBe(false);
    expect(updatedSource.nextPollAt).toBe(addSecondsIso(base, 300));
    expect(container.repositories.fetchLogs.list({ sourceId: source.id })[0]).toMatchObject({
      outcome: 'error',
      error: 'Invalid feed XML.'
    });
  });

  it('skips polling before fetch when no selected group has a webhook', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/no-channel.xml',
      initialized: false,
      deliveryCutoffAt: base,
      createdAt: base
    });
    const group = container.repositories.groups.create({ name: 'Webhook Later', createdAt: base });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);
    const poller = new Poller({
      db: container.db,
      repositories: container.repositories,
      fetchFeed: async () => {
        throw new Error('fetch should not run without a destination');
      }
    });

    const result = await poller.pollSource(source, base);

    expect(result).toEqual({ ...emptyCountsForTest(), sourceId: source.id, outcome: 'skipped', httpStatus: null });
    expect(requireSource(container, source.id)).toMatchObject({
      initialized: false,
      deliveryCutoffAt: base,
      lastPolledAt: null,
      nextPollAt: null
    });
    expect(container.repositories.fetchLogs.list({ sourceId: source.id })).toEqual([]);
  });

  it('resumes polling after a group webhook is attached without queueing pre-cutoff items', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/resume.xml',
      initialized: true,
      deliveryCutoffAt: base,
      createdAt: base
    });
    const group = container.repositories.groups.create({ name: 'Resume Channel', createdAt: base });
    container.repositories.sourceGroups.setGroups(source.id, [group.id]);
    const skippedPoller = createPoller(container, [ok(rssFeed([rssItem('should-not-fetch', 'Should not fetch')]))]);

    expect(await skippedPoller.pollSource(source, base)).toMatchObject({ outcome: 'skipped' });
    expect(container.repositories.items.findByAtomId(source.id, 'should-not-fetch')).toBeNull();
    expect(requireSource(container, source.id).nextPollAt).toBeNull();

    container.repositories.groups.update(group.id, { webhookUrl: 'https://discord.com/api/webhooks/123/resume-token' });
    const resumedPoller = createPoller(container, [
      ok(rssFeed([
        rssItem('old', 'Old', 'Fri, 01 May 2026 00:00:00 GMT'),
        rssItem('new', 'New', 'Fri, 29 May 2026 00:01:00 GMT')
      ]))
    ]);

    const resumed = await resumedPoller.pollSource(requireSource(container, source.id), addSecondsIso(base, 1));

    expect(resumed).toMatchObject({ outcome: '200', itemsHistorical: 1, itemsNew: 1 });
    expect(container.repositories.items.findByAtomId(source.id, 'old')?.deliveryStatus).toBe('historical');
    expect(container.repositories.items.findByAtomId(source.id, 'new')?.deliveryStatus).toBe('pending');
    expect(container.repositories.items.findDueDeliveries(addSecondsIso(base, 1)).map((item) => item.atomId)).toEqual(['new']);
  });

  it('runs the delivery stage before and after each scheduler tick even when no feeds are due', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const deliveryRuns: string[] = [];
    const poller = new Poller({
      db: container.db,
      repositories: container.repositories,
      deliveryRunner: {
        runDueDeliveries: async (now) => {
          deliveryRuns.push(now ?? 'missing');
        }
      }
    });

    expect(await poller.runDuePolls(base)).toEqual([]);
    expect(deliveryRuns).toEqual([base, base]);
  });

  it('runs delivery before and after polling due sources', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/due.xml', initialized: true, createdAt: base });
    attachDeliveryGroup(container, source.id);
    const events: string[] = [];
    const poller = new Poller({
      db: container.db,
      repositories: container.repositories,
      fetchFeed: async () => {
        events.push('poll');
        return ok(rssFeed([]));
      },
      deliveryRunner: {
        runDueDeliveries: async () => {
          events.push('delivery');
        }
      }
    });

    await poller.runDuePolls(base);

    expect(events).toEqual(['delivery', 'poll', 'delivery']);
  });

  it('reports interval delivery errors without creating an unhandled rejection', async () => {
    vi.useFakeTimers();
    const container = openContainer();
    const deliveryError = new Error('delivery failed');
    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const poller = new Poller({
      db: container.db,
      repositories: container.repositories,
      deliveryRunner: {
        runDueDeliveries: async () => {
          throw deliveryError;
        }
      },
      tickIntervalMs: 1,
      onError: (error) => {
        errors.push(error);
      }
    });

    process.on('unhandledRejection', onUnhandled);
    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(1);
      poller.stop();
      await Promise.resolve();
    } finally {
      poller.stop();
      process.off('unhandledRejection', onUnhandled);
    }

    expect(errors).toEqual([deliveryError]);
    expect(unhandled).toEqual([]);
  });

  it('persists TLS auto-detection patches returned by fetchFeed', async () => {
    const container = openContainer();
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/rss.xml',
      initialized: true,
      fetchOptions: { userAgent: 'custom-agent' },
      createdAt: base
    });
    attachDeliveryGroup(container, source.id);
    const poller = createPoller(container, [
      {
        ...ok(rssFeed([rssItem('a', 'A', 'Fri, 29 May 2026 00:00:00 GMT')])),
        persistedFetchOptions: { userAgent: 'custom-agent', tlsMaxVersion: 'TLSv1.2' }
      }
    ]);

    await poller.pollSource(source, base);

    expect(requireSource(container, source.id).fetchOptions).toEqual({
      userAgent: 'custom-agent',
      tlsMaxVersion: 'TLSv1.2'
    });
  });
});

function attachDeliveryGroup(container: Container, sourceId: string, webhookUrl = 'https://discord.com/api/webhooks/123/poller-token'): void {
  const group = container.repositories.groups.create({ name: `Poller ${sourceId}`, webhookUrl });
  container.repositories.sourceGroups.setGroups(sourceId, [group.id]);
}

function emptyCountsForTest() {
  return {
    itemsNew: 0,
    itemsHistorical: 0,
    itemsChanged: 0,
    itemsSkipped: 0
  };
}

function requireSource(container: Container, sourceId: string) {
  const source = container.repositories.sources.getById(sourceId);
  if (!source) throw new Error(`Source missing in test: ${sourceId}`);
  return source;
}

function createPoller(container: Container, results: FeedFetchResult[]): Poller {
  const queue = [...results];
  return new Poller({
    db: container.db,
    repositories: container.repositories,
    fetchFeed: async (_source: FeedFetchSource, _options?: FetchFeedOptions) => {
      const next = queue.shift();
      if (!next) throw new Error('fetchFeed queue exhausted');
      return next;
    }
  });
}

function ok(body: string): Extract<FeedFetchResult, { kind: 'ok' }> {
  return {
    kind: 'ok',
    statusCode: 200,
    url: 'https://example.com/rss.xml',
    body,
    etag: '"etag"',
    lastModified: 'Fri, 29 May 2026 00:00:00 GMT',
    contentType: 'application/xml',
    charset: 'utf-8'
  };
}

function notModified(etag: string, lastModified: string): Extract<FeedFetchResult, { kind: 'not-modified' }> {
  return {
    kind: 'not-modified',
    statusCode: 304,
    url: 'https://example.com/rss.xml',
    etag,
    lastModified
  };
}

function rssFeed(items: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;
}

function rssItem(guid: string, title: string, pubDate?: string, body = `${title} body`): string {
  return `<item>
    <guid>${guid}</guid>
    <title>${title}</title>
    <link>https://example.com/${guid}</link>
    ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
    <description><![CDATA[<p>${body}</p>]]></description>
  </item>`;
}

function openContainer(): Container {
  const container = createContainer({
    env: { DATABASE_PATH: ':memory:' },
    urlVerifiers: { verifyFeedUrl: async () => undefined, verifyWebhookUrl: async () => undefined }
  });
  containers.push(container);
  return container;
}
