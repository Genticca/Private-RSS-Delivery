import type { EventLogRepository } from '../logs/repository.js';
import type { TranslationCacheRepository } from '../translation/cache.js';
import type { ItemRepository } from '../feed/repository.js';
import type { DeliveryJobRepository } from '../delivery/repository.js';
import type Database from 'better-sqlite3';
import { subtractDaysIso } from '../core/db.js';
import { TaskTracker } from '../core/worker.js';
import { nowIso } from '../core/db.js';

export interface CleanupRunResult {
  events: number;
}

export interface CleanupRepositories {
  eventLog: Pick<EventLogRepository, 'pruneOlderThan'>;
  translationCache: Pick<TranslationCacheRepository, 'pruneFailed'>;
  items: Pick<ItemRepository, 'pruneContent'>;
  deliveryJobs: Pick<DeliveryJobRepository, 'pruneCompletedSnapshots' | 'pruneCooldowns'>;
}

// 실패 캐시와 완료 작업의 내용은 로그 보존 기간과 별개로 90일간 보존한다.
const CACHE_AND_SNAPSHOT_RETENTION_DAYS = 90;

export class CleanupService {
  constructor(private readonly db: Database.Database, private readonly repositories: CleanupRepositories) { }

  run(now: string, logRetentionDays: number, itemRetentionDays?: number): CleanupRunResult {
    return this.db.transaction(() => {
      const result = { events: this.repositories.eventLog.pruneOlderThan(logRetentionDays, now) };
      if (itemRetentionDays !== undefined) {
        // 항목 식별자와 발송 이력은 유지하고 오래된 본문만 비운다.
        // 미해결 발송 작업이 참조하는 항목은 이후 처리에 필요하므로 보존한다.
        this.repositories.translationCache.pruneFailed(subtractDaysIso(now, CACHE_AND_SNAPSHOT_RETENTION_DAYS));
        this.repositories.items.pruneContent(subtractDaysIso(now, itemRetentionDays));
        this.repositories.deliveryJobs.pruneCompletedSnapshots(subtractDaysIso(now, CACHE_AND_SNAPSHOT_RETENTION_DAYS));
        this.repositories.deliveryJobs.pruneCooldowns(now);
      }
      return result;
    })();
  }
}

export interface CleanupWorkerOptions {
  db: Database.Database;
  repositories: CleanupRepositories;
  itemContentRetentionDays?: number;
  logRetentionDays?: number;
  now?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

const DEFAULT_LOG_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tracker = new TaskTracker();

  constructor(private readonly options: CleanupWorkerOptions) { }

  start(): void {
    if (this.timer || this.tracker.stopped) return;
    this.runOnce().catch((error: unknown) => this.reportError(error));
    this.scheduleNext();
  }

  stop(): void {
    this.tracker.stop();
    if (!this.timer) return;
    (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  drain(): Promise<void> {
    return this.tracker.drain();
  }

  async runOnce(baseIso = this.now()): Promise<CleanupRunResult> {
    if (this.running || this.tracker.stopped) return { events: 0 };
    this.running = true;
    try {
      return await this.tracker.track(async () => {
        if (this.tracker.stopped) return { events: 0 };
        const service = new CleanupService(this.options.db, this.options.repositories);
        return service.run(baseIso, this.logRetentionDays(), this.options.itemContentRetentionDays);
      });
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    if (this.tracker.stopped) return;
    const delay = delayUntilNextKstMidnight(this.now());
    this.timer = (this.options.setTimer ?? setTimeout)(() => {
      this.timer = null;
      this.runOnce()
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }

  private logRetentionDays(): number {
    return this.options.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Do not let an injected error hook create another unhandled timer rejection.
    }
  }
}

export function delayUntilNextKstMidnight(baseIso: string): number {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return DAY_MS;
  // 실행 환경의 시간대와 무관하게 한국 시간 자정을 계산한다.
  const kstMs = base.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  const nextKstMidnight = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, nextKstMidnight - kstMs);
}
