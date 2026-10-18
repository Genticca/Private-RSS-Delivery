/**
 * 보존 기간 정리. 부팅 직후와 KST 자정에 소유 저장소의 정리 메서드를 같은 트랜잭션으로 실행한다.
 * 빈 공간이 많으면 정리 뒤 VACUUM으로 파일을 줄인다.
 */
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import type { EventLogRepository } from '../logs/repository.js';
import type { TranslationCacheRepository } from '../translation/cache.js';
import type { ItemRepository } from '../feed/repository.js';
import type { DeliveryJobRepository } from '../delivery/repository.js';
import { subtractDaysIso, nowIso } from '../core/db.js';
import { TaskTracker } from '../core/worker.js';

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

/** 각 저장소의 보존 정책을 정해진 순서로 실행한다. 부분 정리가 남지 않도록 트랜잭션을 공유한다. */
export class CleanupService {
  constructor(private readonly db: Database.Database, private readonly repositories: CleanupRepositories) { }

  /** 로그를 먼저 정리하고 항목 보존 옵션이 있으면 실패 캐시·본문·완료 스냅샷·만료 대기를 정리한다. */
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

export interface CompactionThresholds {
  minFreeRatio: number;
  minFreeBytes: number;
}

export interface CompactionResult {
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
}

// 큰 삭제 뒤에만 파일을 줄인다. 평소의 하루치 빈 공간은 다음 데이터가 다시 쓴다.
const DEFAULT_COMPACTION: CompactionThresholds = { minFreeRatio: 0.25, minFreeBytes: 8 * 1024 * 1024 };

/** 빈 페이지가 기준을 넘을 때만 VACUUM으로 파일을 줄이고, WAL도 비운다. 실행하지 않으면 null. */
export function compactIfFragmented(db: Database.Database, thresholds: CompactionThresholds): CompactionResult | null {
  if (db.memory || db.inTransaction) return null;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const freePages = db.pragma('freelist_count', { simple: true }) as number;
  if (pageCount === 0) return null;
  if (freePages / pageCount < thresholds.minFreeRatio || freePages * pageSize < thresholds.minFreeBytes) return null;
  const started = performance.now();
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const afterPages = db.pragma('page_count', { simple: true }) as number;
  return {
    beforeBytes: pageCount * pageSize,
    afterBytes: afterPages * pageSize,
    durationMs: Math.round(performance.now() - started)
  };
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
  compaction?: CompactionThresholds;
  onCompacted?: (result: CompactionResult) => void;
}

const DEFAULT_LOG_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tracker = new TaskTracker();

  constructor(private readonly options: CleanupWorkerOptions) { }

  /** 중복 시작과 종료 후 재시작을 막고 예약 실행을 등록한다. */
  start(): void {
    if (this.timer || this.tracker.stopped) return;
    this.runOnce().catch((error: unknown) => this.reportError(error));
    this.scheduleNext();
  }

  /** 예약 타이머와 새 작업 접수를 중단한다. 이미 시작한 작업은 drain에서 기다린다. */
  stop(): void {
    this.tracker.stop();
    if (!this.timer) return;
    (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  /** 현재 추적 중인 작업이 끝날 때까지 기다려 DB가 처리 도중 닫히지 않게 한다. */
  drain(): Promise<void> {
    return this.tracker.drain();
  }

  /** 예약 실행과 수동 호출이 겹쳐도 정리를 한 번만 실행하며 종료 대기 목록에도 등록한다. */
  async runOnce(baseIso = this.now()): Promise<CleanupRunResult> {
    if (this.running || this.tracker.stopped) return { events: 0 };
    this.running = true;
    try {
      return await this.tracker.track(async () => {
        if (this.tracker.stopped) return { events: 0 };
        const service = new CleanupService(this.options.db, this.options.repositories);
        const result = service.run(baseIso, this.logRetentionDays(), this.options.itemContentRetentionDays);
        if (!this.tracker.stopped) this.compact();
        return result;
      });
    } finally {
      this.running = false;
    }
  }

  /** 정리 결과와 별개로 파일 축소를 시도한다. 실패는 보고만 하고 다음 정리 때 다시 판단한다. */
  private compact(): void {
    try {
      const result = compactIfFragmented(this.options.db, this.options.compaction ?? DEFAULT_COMPACTION);
      if (result) this.options.onCompacted?.(result);
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 고정 24시간 반복 대신 현재 시각에서 다음 KST 자정까지의 지연을 다시 계산한다. */
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

  /** 오류 보고 콜백의 실패가 다음 예약 실행까지 중단시키지 않도록 격리한다. */
  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Do not let an injected error hook create another unhandled timer rejection.
    }
  }
}

/** UTC와 KST의 고정 시차를 이용해 호스트 시간대와 무관한 다음 자정 시각을 계산한다. */
export function delayUntilNextKstMidnight(baseIso: string): number {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return DAY_MS;
  // 실행 환경의 시간대와 무관하게 한국 시간 자정을 계산한다.
  const kstMs = base.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  const nextKstMidnight = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, nextKstMidnight - kstMs);
}
