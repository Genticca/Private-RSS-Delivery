import type { DeliveryBindingRepository, DeliveryJobRecord, DeliveryJobRepository, ItemRecord } from '../db/index.js';
import { nowIso } from '../db/time.js';
import type { DeliveryRunResult, DeliveryService } from '../services/delivery.service.js';
import { mapConcurrent, TaskTracker } from './task-tracker.js';

export interface DeliveryWorkerOptions {
  jobs: DeliveryJobRepository;
  bindings: DeliveryBindingRepository;
  service: Pick<DeliveryService, 'processJob'>;
  now?: () => string;
  tickIntervalMs?: number;
  dueLimit?: number;
  concurrency?: number;
  onError?: (error: unknown) => void;
}

export class DeliveryWorker {
  private readonly tracker = new TaskTracker();
  private readonly buckets = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(private readonly options: DeliveryWorkerOptions) { }

  start(): void {
    if (this.timer || this.tracker.stopped) return;
    this.timer = setInterval(() => {
      void this.runDueDeliveries().catch((error: unknown) => this.reportError(error));
    }, this.options.tickIntervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    this.tracker.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  drain(): Promise<void> {
    return this.tracker.drain();
  }

  async runDueDeliveries(now = this.now()): Promise<DeliveryRunResult[]> {
    if (this.tracker.stopped || this.ticking) return [];
    this.ticking = true;
    try {
      return await this.tracker.track(async () => {
        const jobs = this.options.jobs.findDue(now, this.options.dueLimit ?? 50);
        // 같은 웹훅은 순서대로 발송하고, 서로 다른 웹훅만 병렬 처리한다.
        const jobsByBucket = this.groupJobsByBucket(jobs);
        const batches = await mapConcurrent(
          [...jobsByBucket],
          this.options.concurrency ?? 2,
          ([bucket, batch]) => this.processBucket(bucket, batch, now)
        );
        return batches.flat();
      });
    } finally {
      this.ticking = false;
    }
  }

  private groupJobsByBucket(jobs: readonly DeliveryJobRecord[]): Map<string, DeliveryJobRecord[]> {
    const jobsByBucket = new Map<string, DeliveryJobRecord[]>();
    for (const job of jobs) {
      const binding = this.options.bindings.getById(job.bindingId);
      if (!binding) continue;
      const bucketJobs = jobsByBucket.get(binding.bucketKey) ?? [];
      bucketJobs.push(job);
      jobsByBucket.set(binding.bucketKey, bucketJobs);
    }
    return jobsByBucket;
  }

  private async processBucket(bucket: string, jobs: readonly DeliveryJobRecord[], now: string): Promise<DeliveryRunResult[]> {
    if (this.buckets.has(bucket)) return [];
    this.buckets.add(bucket);
    const results: DeliveryRunResult[] = [];
    try {
      for (const job of jobs) {
        // 종료 요청 이후에는 이미 시작한 요청만 마치고 다음 발송은 시작하지 않는다.
        if (this.tracker.stopped) break;
        const result = await this.options.service.processJob(job.id, now, () => this.tracker.stopped);
        if (result) results.push(result);
      }
    } finally {
      this.buckets.delete(bucket);
    }
    return results;
  }

  /** 이미 계획된 작업만 실행한다. 과거 항목에 현재 발송 대상을 새로 연결하지 않는다. */
  async processItem(item: ItemRecord, now = this.now()): Promise<DeliveryRunResult> {
    const job = this.options.jobs.findDue(now, 100_000).find((entry) => entry.itemId === item.id);
    if (!job || this.tracker.stopped) return {
      itemId: item.id,
      jobId: 0,
      outcome: 'skipped',
      attemptNo: null
    };
    return await this.tracker.track(() => this.options.service.processJob(job.id, now, () => this.tracker.stopped))
      ?? {
      itemId: item.id,
      jobId: job.id,
      outcome: 'skipped',
      attemptNo: null
    };
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // 오류 보고 실패가 다음 예약 실행에 영향을 주지 않도록 한다.
    }
  }
}
