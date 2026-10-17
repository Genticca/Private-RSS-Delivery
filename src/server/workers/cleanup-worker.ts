import type Database from 'better-sqlite3';
import type { CleanupRepositories } from '../services/cleanup.service.js';
import { TaskTracker } from '../core/worker.js';
import type { CleanupRunResult } from '../services/cleanup.service.js';
import { CleanupService } from '../services/cleanup.service.js';
import { nowIso } from '../core/db.js';

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
