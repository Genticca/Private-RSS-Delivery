import { describe, expect, it } from 'vitest';
import { harness, BASE } from '../../mocks/runtime.js';
import type { WebhookPostResponse } from '../../../src/server/dispatcher/discord-client.js';

describe('worker drain and SQLite lifetime', () => {
  it('waits for an in-flight Discord response and commits before closing SQLite', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    let release!: (value: WebhookPostResponse) => void;
    h.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sending = h.run(); await new Promise((resolve) => setImmediate(resolve));
    let closed = false; const closing = h.container.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(h.container.db.open).toBe(true);
    release({ statusCode: 200, messageId: '123' });
    await sending; await closing; expect(h.container.db.open).toBe(false);
  });

  it('keeps the database open after a drain timeout and permits shutdown retry', async () => {
    const h = await harness({}, { runtimeOptions: { shutdownTimeoutMs: 20 } }); await h.baseline(); await h.poll([{ id: 'one' }]);
    let release!: (value: WebhookPostResponse) => void;
    h.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sending = h.run(); await new Promise((resolve) => setImmediate(resolve));
    await expect(h.container.close()).rejects.toThrow('database remains open');
    expect(h.container.db.open).toBe(true);
    release({ statusCode: 200, messageId: '123' }); await sending;
    expect(h.jobs()[0].state).toBe('succeeded'); await h.container.close();
    expect(h.container.db.open).toBe(false);
  });

  it('tracks manual polls and blocks new requests after shutdown starts', async () => {
    const h = await harness(); let release!: () => void;
    h.fetcher.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; });
      return { kind: 'ok', body: '<rss><channel></channel></rss>', statusCode: 200, url: h.source().feedUrl,
        etag: null, lastModified: null, contentType: 'application/xml', charset: 'utf-8' }; });
    const polling = h.poll([]); await new Promise((resolve) => setImmediate(resolve));
    const closing = h.container.close();
    expect((await h.container.workers.poller.triggerPoll(h.source().id, BASE)).outcome).toBe('skipped');
    expect(h.container.db.open).toBe(true); release(); await polling; await closing;
    expect(h.container.db.open).toBe(false);
  });
});
