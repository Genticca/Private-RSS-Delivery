import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createContainer, type Container } from '../../src/server/container.js';
import {
  delayUntilNextKstMidnight,
  CleanupWorker,
  compactIfFragmented,
  type CompactionResult
} from '../../src/server/cleanup/worker.js';

const containers: Container[] = [];
const temporaryDirectories: string[] = [];
const CLEANUP_BASE = '2026-05-29T00:00:00.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  for (const container of containers.splice(0)) {
    await container.close();
  }
  // Windows에서는 DB·WAL 핸들을 먼저 닫아야 임시 폴더를 지울 수 있다.
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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

  it('compacts a fragmented file database after cleanup commits and truncates its WAL', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn<(result: CompactionResult) => void>();
    const worker = new CleanupWorker({
      db: container.db,
      repositories: container.repositories,
      compaction: { minFreeRatio: 0.25, minFreeBytes: 1024 },
      onCompacted
    });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });

    expect(onCompacted).toHaveBeenCalledTimes(1);
    const result = onCompacted.mock.calls[0][0];
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(container.db.pragma('freelist_count', { simple: true })).toBe(0);
    expect(statSync(container.db.name).size).toBe(result.afterBytes);
    expect(statSync(`${container.db.name}-wal`).size).toBe(0);
  });

  it('preserves cleanup results without compacting below the free-byte threshold', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn();
    const worker = new CleanupWorker({
      db: container.db,
      repositories: container.repositories,
      compaction: { minFreeRatio: 0.25, minFreeBytes: Number.MAX_SAFE_INTEGER },
      onCompacted
    });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });

    expect(onCompacted).not.toHaveBeenCalled();
    expect(container.db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
  });

  it('requires the free-page ratio as well as the free-byte threshold', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn();
    const worker = new CleanupWorker({
      db: container.db,
      repositories: container.repositories,
      compaction: { minFreeRatio: 1, minFreeBytes: 1024 },
      onCompacted
    });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });
    expect(onCompacted).not.toHaveBeenCalled();
    expect(container.db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
  });

  it('keeps a few MiB of free space for reuse with the default 8MiB threshold', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn();
    const worker = new CleanupWorker({ db: container.db, repositories: container.repositories, onCompacted });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });

    const freePages = container.db.pragma('freelist_count', { simple: true }) as number;
    const pageSize = container.db.pragma('page_size', { simple: true }) as number;
    expect(freePages * pageSize).toBeGreaterThan(1024);
    expect(freePages * pageSize).toBeLessThan(8 * 1024 * 1024);
    expect(onCompacted).not.toHaveBeenCalled();
  });

  it('reports compaction failures without losing cleanup results and retries on the next run', async () => {
    const container = openFragmentedContainer();
    const failure = new Error('simulated disk-full error');
    const onError = vi.fn();
    const onCompacted = vi.fn();
    const originalExec = container.db.exec.bind(container.db);
    const exec = vi.spyOn(container.db, 'exec').mockImplementation((sql) => {
      if (sql === 'VACUUM') throw failure;
      return originalExec(sql);
    });
    const worker = new CleanupWorker({
      db: container.db,
      repositories: container.repositories,
      compaction: { minFreeRatio: 0.25, minFreeBytes: 1024 },
      onError,
      onCompacted
    });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onCompacted).not.toHaveBeenCalled();
    expect(container.db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);

    exec.mockRestore();
    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 0 });
    expect(onCompacted).toHaveBeenCalledTimes(1);
    expect(container.db.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('does not clean up or compact after stopping', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn();
    const worker = new CleanupWorker({
      db: container.db,
      repositories: container.repositories,
      compaction: { minFreeRatio: 0.25, minFreeBytes: 1024 },
      onCompacted
    });
    worker.stop();

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 0 });
    expect(container.db.prepare('SELECT COUNT(*) AS count FROM event_log').get()).toEqual({ count: 3000 });
    expect(onCompacted).not.toHaveBeenCalled();
  });

  it('skips compaction if stopping begins during cleanup', async () => {
    const container = openFragmentedContainer();
    const onCompacted = vi.fn();
    const worker = new CleanupWorker({
      db: container.db,
      repositories: {
        ...container.repositories,
        eventLog: {
          pruneOlderThan: (days, now) => {
            const removed = container.repositories.eventLog.pruneOlderThan(days, now);
            worker.stop();
            return removed;
          }
        }
      },
      compaction: { minFreeRatio: 0.25, minFreeBytes: 1024 },
      onCompacted
    });

    await expect(worker.runOnce(CLEANUP_BASE)).resolves.toEqual({ events: 3000 });
    expect(onCompacted).not.toHaveBeenCalled();
    expect(container.db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
  });
});

describe('compactIfFragmented', () => {
  it('skips memory databases before issuing SQL', () => {
    const container = openContainer();
    const pragma = vi.spyOn(container.db, 'pragma');

    expect(compactIfFragmented(container.db, { minFreeRatio: 0, minFreeBytes: 0 })).toBeNull();
    expect(pragma).not.toHaveBeenCalled();
  });

  it('skips an open transaction even when the file has enough free space', () => {
    const container = openFragmentedContainer();
    container.repositories.eventLog.pruneOlderThan(30, CLEANUP_BASE);
    const pragma = vi.spyOn(container.db, 'pragma');

    container.db.transaction(() => {
      expect(container.db.inTransaction).toBe(true);
      expect(compactIfFragmented(container.db, { minFreeRatio: 0.25, minFreeBytes: 1024 })).toBeNull();
    })();
    expect(pragma).not.toHaveBeenCalled();
  });

  it('skips an empty file database with no pages', () => {
    const db = new Database(join(createTemporaryDirectory(), 'empty.sqlite'));
    try {
      expect(db.pragma('page_count', { simple: true })).toBe(0);
      const exec = vi.spyOn(db, 'exec');

      expect(compactIfFragmented(db, { minFreeRatio: 0, minFreeBytes: 0 })).toBeNull();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function openContainer(databasePath = ':memory:'): Container {
  const container = createContainer({
    env: { DATABASE_PATH: databasePath },
    urlVerifiers: {
      verifyFeedUrl: async () => undefined,
      verifyWebhookUrl: async () => undefined
    }
  });
  containers.push(container);
  return container;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rss-cleanup-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** 오래된 로그를 한 트랜잭션으로 넣어 정리 후 빈 페이지가 생기는 파일 DB를 준비한다. */
function openFragmentedContainer(): Container {
  const container = openContainer(join(createTemporaryDirectory(), 'cleanup.sqlite'));
  container.db.transaction(() => {
    for (let index = 0; index < 3000; index += 1) {
      container.repositories.eventLog.append({
        kind: 'translation',
        status: 'success',
        detail: 'x'.repeat(1000),
        createdAt: '2026-04-28T00:00:00.000Z'
      });
    }
  })();
  return container;
}
