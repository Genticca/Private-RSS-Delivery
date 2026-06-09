import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CleanupWorker, delayUntilNextKstMidnight } from '../../../src/server/workers/index.js';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';

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

  it('prunes delivery/fetch/model usage in one worker run', async () => {
    const container = openContainer();
    const old = '2026-01-01T00:00:00.000Z';
    const base = '2026-05-29T00:00:00.000Z';
    const source = container.repositories.sources.create({ feedUrl: 'https://example.com/feed.xml', createdAt: base });
    const item = container.repositories.items.insert({ sourceId: source.id, atomId: 'atom-1', contentHash: 'hash-1', createdAt: base });
    container.repositories.deliveryLogs.append({ itemId: item.id, attemptNo: 1, status: 'failed', createdAt: old });
    container.repositories.fetchLogs.append({ sourceId: source.id, outcome: 'error', createdAt: old });
    container.repositories.modelUsage.append({ role: 'primary', provider: 'gemini', model: 'gemini-3.1-flash-lite', createdAt: old });

    const worker = new CleanupWorker({ db: container.db, repositories: container.repositories });
    await expect(worker.runOnce(base)).resolves.toEqual({ deliveryLogs: 1, fetchLogs: 1, modelUsage: 1 });
    expect(container.repositories.deliveryLogs.list()).toEqual([]);
    expect(container.repositories.fetchLogs.list()).toEqual([]);
    expect(container.repositories.modelUsage.list()).toEqual([]);
  });

  it('clears scheduled timers on stop', () => {
    const db = new Database(':memory:');
    try {
      let cleared = 0;
      const fakeTimer = { unref() {} } as NodeJS.Timeout;
      const worker = new CleanupWorker({
        db,
        repositories: {
          deliveryLogs: { pruneOlderThan: () => 0 },
          fetchLogs: { pruneOlderThan: () => 0 },
          modelUsage: { pruneOlderThan: () => 0 }
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
          deliveryLogs: {
            pruneOlderThan: () => {
              throw failure;
            }
          },
          fetchLogs: { pruneOlderThan: () => 0 },
          modelUsage: { pruneOlderThan: () => 0 }
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
