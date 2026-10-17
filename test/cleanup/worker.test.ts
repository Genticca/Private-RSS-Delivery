import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createContainer, type Container } from '../../src/server/container.js';
import { delayUntilNextKstMidnight, CleanupWorker } from '../../src/server/cleanup/worker.js';

const containers: Container[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('CleanupWorker', () => {
  it('computes the next KST midnight delay independently of host timezone', () => {
    expect(delayUntilNextKstMidnight('2026-05-29T14:59:59.000Z')).toBe(1000);
    expect(delayUntilNextKstMidnight('2026-05-29T15:00:00.000Z')).toBe(24 * 60 * 60 * 1000);
  });

  it('prunes events older than 30 days and retains events at the cutoff and newer', async () => {
    const container = openContainer();
    const old = '2026-04-28T00:00:00.000Z';
    const cutoff = '2026-04-29T00:00:00.000Z';
    const recent = '2026-04-30T00:00:00.000Z';
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/feed.xml', createdAt: base });
    const item = container.repositories.items.insert({ sourceId: source.id, atomId: 'atom-1', contentHash: 'hash-1', createdAt: base });
    for (const createdAt of [old, cutoff, recent]) {
      container.repositories.eventLog.append({ kind: 'delivery', status: 'failed', itemId: item.id, createdAt });
      container.repositories.eventLog.append({ kind: 'fetch', status: 'error', sourceId: source.id, createdAt });
      container.repositories.eventLog.append({ kind: 'translation', status: 'success', createdAt });
    }

    const worker = new CleanupWorker({ db: container.db, repositories: container.repositories });
    await expect(worker.runOnce(base)).resolves.toEqual({ events: 3 });
    expect(container.repositories.eventLog.list().map((event) => event.createdAt)).toEqual([
      recent, recent, recent, cutoff, cutoff, cutoff
    ]);
  });

  it('clears scheduled timers on stop', () => {
    const db = new Database(':memory:');
    try {
      let cleared = 0;
      const fakeTimer = { unref() {} } as NodeJS.Timeout;
      const worker = new CleanupWorker({
        db,
        repositories: {
          eventLog: { pruneOlderThan: () => 0 }
        } as never,
        setTimer: (() => fakeTimer) as never,
        clearTimer: (() => { cleared += 1; }) as never
      });
      worker.start();
      worker.stop();
      expect(cleared).toBe(1);
    } finally {
      db.close();
    }
  });

  it('reports cleanup errors and keeps the next schedule after a failed scheduled run', async () => {
    const db = new Database(':memory:');
    try {
      const failure = new Error('cleanup failed');
      const errors: unknown[] = [];
      const scheduled: Array<() => void> = [];
      const fakeTimer = { unref() {} } as NodeJS.Timeout;
      const worker = new CleanupWorker({
        db,
        repositories: {
          eventLog: {
            pruneOlderThan: () => {
              throw failure;
            }
          }
        } as never,
        now: () => '2026-05-29T00:00:00.000Z',
        setTimer: ((callback: () => void) => {
          scheduled.push(callback);
          return fakeTimer;
        }) as never,
        onError: (error) => {
          errors.push(error);
        }
      });

      worker.start();
      await flushAsyncHandlers();
      expect(errors).toEqual([failure]);
      expect(scheduled).toHaveLength(1);

      const scheduledRun = scheduled.shift();
      expect(scheduledRun).toBeDefined();
      scheduledRun!();
      await flushAsyncHandlers();

      expect(errors).toEqual([failure, failure]);
      expect(scheduled).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function openContainer(): Container {
  const container = createContainer({
    env: { DATABASE_PATH: ':memory:' },
    urlVerifiers: {
      verifyFeedUrl: async () => undefined,
      verifyWebhookUrl: async () => undefined
    }
  });
  containers.push(container);
  return container;
}
