import { describe } from 'vitest';
import { it } from 'vitest';
import { harness } from '../../mocks/runtime.js';
import { readFeedFixture } from '../../mocks/fixtures.js';
import { expect } from 'vitest';
import { addSecondsIso } from '../../../src/server/core/db.js';
import { BASE } from '../../mocks/runtime.js';
import { rss } from '../../mocks/runtime.js';
import { WEBHOOK_B } from '../../mocks/runtime.js';
import { PollWorker } from '../../../src/server/workers/poll-worker.js';
import { vi } from 'vitest';

describe('polling and delivery planning', () => {
  it('keeps the real status feed baseline historical and detects its profile', async () => {
    const h = await harness();
    const result = await h.pollBody(await readFeedFixture('OpenAI.atom'));
    expect(result).toMatchObject({ outcome: '200', itemsNew: 0, itemsHistorical: 91, detectedProfile: 'incident-io' });
    expect(h.jobs()).toEqual([]); expect(h.source().initialized).toBe(true);
  });

  it('queues only new post-cutoff and undated items after a completed baseline', async () => {
    const h = await harness(); await h.baseline();
    await h.poll([{ id: 'old', publishedAt: '2026-01-01T00:00:00.000Z' }, { id: 'one', publishedAt: addSecondsIso(BASE, 1) }, { id: 'undated' }]);
    expect(h.item('old').historical).toBe(true);
    expect(h.item('one').historical).toBe(false);
    expect(h.jobs()).toHaveLength(2);
  });

  it('updates same-hash generic summaries without creating a new delivery revision or job', async () => {
    const h = await harness(); await h.baseline();
    await h.poll([{ id: 'one', title: 'Title', summary: 'First' }]); await h.run();
    await h.poll([{ id: 'one', title: 'Title', summary: 'Second' }]);
    expect(h.item()).toMatchObject({ summary: 'Second', contentRevision: 1 });
    expect(h.jobs()).toHaveLength(1); expect(h.jobs()[0].state).toBe('succeeded');
  });

  it('keeps changed historical items historical', async () => {
    const h = await harness(); await h.poll([{ id: 'one', title: 'First' }]);
    await h.poll([{ id: 'one', title: 'Changed' }]);
    expect(h.item()).toMatchObject({ historical: true, contentRevision: 2 }); expect(h.jobs()).toEqual([]);
  });

  it('persists a permanent redirect while preserving source identity and existing receipts', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    const sourceId = h.source().id;
    h.fetcher.mockResolvedValueOnce({ kind: 'ok', body: rss([{ id: 'one', title: 'Updated' }]), statusCode: 200,
      url: h.source().feedUrl, permanentUrl: 'https://example.com/canonical-feed', etag: null, lastModified: null, contentType: 'application/xml', charset: 'utf-8' });
    await h.poll([]); await h.run();
    expect(h.source()).toMatchObject({ id: sourceId, initialized: true, feedUrl: 'https://example.com/canonical-feed' });
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).toHaveBeenCalledTimes(1);
  });

  it('does not create jobs when an item without any delivery job changes', async () => {
    const h = await harness(); await h.baseline();
    h.r.items.insert({ sourceId: h.source().id, atomId: 'one', title: 'Old', contentHash: 'stored-without-job' });
    await h.poll([{ id: 'one', title: 'Changed old' }]); await h.run();
    expect(h.jobs()).toEqual([]); expect(h.post).not.toHaveBeenCalled();
  });

  it('forces an unconditional first request for each new binding and keeps 304 baseline incomplete', async () => {
    const h = await harness(); await h.baseline();
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_B });
    h.fetcher.mockResolvedValueOnce({ kind: 'not-modified', statusCode: 304, url: h.source().feedUrl, etag: '"feed"', lastModified: null });
    await h.poll([]);
    expect(h.fetcher.mock.calls.at(-1)?.[0]).toMatchObject({ etag: null, lastModified: null });
    expect(h.r.deliveryBindings.listActive(h.source().id)[0].baselineAt).toBeNull();
    await h.poll([{ id: 'one' }]);
    expect(h.r.deliveryBindings.listActive(h.source().id)[0].baselineAt).not.toBeNull();
    expect(h.jobs()).toEqual([]);
  });

  it('discards old feed output if feedUrl changes while the fetch is running', async () => {
    const h = await harness(); await h.baseline();
    let release!: (value: Awaited<ReturnType<typeof h.fetcher>>) => void;
    h.fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const running = h.poll([{ id: 'old-url-new' }]);
    await new Promise((resolve) => setImmediate(resolve));
    await h.container.services.sources.update(h.source().id, { feedUrl: 'https://example.com/new-feed' });
    release({ kind: 'ok', body: rss([{ id: 'old-url-new' }]), statusCode: 200, url: 'https://example.com/feed',
      etag: null, lastModified: null, contentType: 'application/xml', charset: 'utf-8' });
    expect((await running).outcome).toBe('skipped');
    expect(h.r.items.findByAtomId(h.source().id, 'old-url-new')).toBeNull();
    expect(h.source().initialized).toBe(false);
    await h.poll([{ id: 'new-url-old' }]); expect(h.jobs()).toEqual([]);
  });

  it('holds a suspicious new snapshot until an administrator chooses send or historical', async () => {
    const h = await harness(); await h.baseline();
    await h.poll(Array.from({ length: 10 }, (_, i) => ({ id: 'new-' + i }))); await h.run();
    expect(h.jobs().every((j) => j.state === 'held')).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
    const [send, historical] = h.jobs();
    expect(h.r.deliveryJobs.reviewHeld(send.id, 'send', BASE)).toBe(true);
    expect(h.r.deliveryJobs.reviewHeld(historical.id, 'historical', BASE)).toBe(true);
    await h.run(); expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.r.deliveryJobs.getById(historical.id)?.state).toBe('cancelled');
  });

  it('discards a response when fetch settings change during an active request', async () => {
    const h = await harness(); await h.baseline();
    let release!: (value: Awaited<ReturnType<typeof h.fetcher>>) => void;
    h.fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const polling = h.poll([{ id: 'stale' }]); await new Promise((resolve) => setImmediate(resolve));
    await h.container.services.sources.update(h.source().id, { fetchOptions: { userAgent: 'new-agent' } });
    release({ kind: 'ok', body: rss([{ id: 'stale' }]), statusCode: 200, url: h.source().feedUrl, etag: null,
      lastModified: null, contentType: 'application/xml', charset: 'utf-8' });
    expect((await polling).outcome).toBe('skipped'); expect(h.r.items.findByAtomId(h.source().id, 'stale')).toBeNull();
  });

  it('never holds the initial baseline, even for a large feed', async () => {
    const h = await harness(); await h.poll(Array.from({ length: 60 }, (_, i) => ({ id: 'old-' + i })));
    expect(h.jobs()).toEqual([]); expect(h.source().initialized).toBe(true);
  });

  it('advances destination-less sources so they cannot starve due polling slots', async () => {
    const h = await harness(); await h.container.services.groups.update(h.group.id, { clearWebhook: true });
    expect((await h.poll([])).outcome).toBe('skipped');
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.source().nextPollAt).toBe(addSecondsIso(BASE, 300));
  });

  it('backs off consecutive failures and clears the counter after recovery', async () => {
    const h = await harness();
    h.fetcher.mockRejectedValueOnce(new Error('feed unavailable')); await h.poll([]);
    expect(h.source()).toMatchObject({ consecutiveFailures: 1, initialized: false });
    h.fetcher.mockRejectedValueOnce(new Error('feed unavailable')); await h.poll([], addSecondsIso(BASE, 300));
    expect(h.source()).toMatchObject({ consecutiveFailures: 2, nextPollAt: addSecondsIso(BASE, 900) });
    await h.baseline(); expect(h.source().consecutiveFailures).toBe(0);
  });

  it('cancels old work on disable and establishes a fresh baseline on re-enable', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.container.services.sources.setEnabled(h.source().id, { enabled: false });
    h.container.services.sources.setEnabled(h.source().id, { enabled: true });
    await h.run(); expect(h.post).not.toHaveBeenCalled();
    await h.poll([{ id: 'one', title: 'Old changed' }, { id: 'before-baseline' }]); await h.run();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('skips re-entrant manual polling and drains the accepted operation', async () => {
    const h = await harness(); let release!: () => void;
    const worker = new PollWorker({ sources: h.r.sources, service: { poll: async (sourceId) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { sourceId, outcome: '200', httpStatus: 200, itemsNew: 0, itemsHistorical: 0, itemsChanged: 0, itemsSkipped: 0 };
    } } });
    const first = worker.triggerPoll(h.source().id); await new Promise((resolve) => setImmediate(resolve));
    expect((await worker.triggerPoll(h.source().id)).outcome).toBe('skipped');
    worker.stop(); let drained = false; const draining = worker.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(); await first; await draining; expect(drained).toBe(true);
  });

  it('limits concurrent fetches while delivery runs independently', async () => {
    const h = await harness(); let active = 0; let maximum = 0;
    const worker = new PollWorker({ sources: { getById: h.r.sources.getById.bind(h.r.sources), findDuePoll: () => Array.from({ length: 4 }, (_, i) => ({ ...h.source(), id: 'source-' + i })) },
      concurrency: 2, service: { poll: async (sourceId) => {
        active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setImmediate(resolve)); active--;
        return { sourceId, outcome: '200', httpStatus: 200, itemsNew: 0, itemsHistorical: 0, itemsChanged: 0, itemsSkipped: 0 };
      } } });
    expect(await worker.runDuePolls()).toHaveLength(4); expect(maximum).toBe(2);
    worker.stop(); await worker.drain();
  });

  it('reports scheduled errors without an unhandled rejection', async () => {
    const h = await harness(); const error = new Error('poll failed'); const onError = vi.fn();
    const worker = new PollWorker({ sources: { getById: h.r.sources.getById.bind(h.r.sources), findDuePoll: () => [h.source()] },
      tickIntervalMs: 5, service: { poll: async () => { throw error; } }, onError });
    worker.start(); await new Promise((resolve) => setTimeout(resolve, 30)); worker.stop(); await worker.drain();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
