/**
 * 발송 예약 실행. 같은 웹훅은 순서대로, 다른 웹훅은 제한된 수만 병렬로 처리하며 종료 시 진행 작업을 기다린다.
 */
import { TaskTracker, mapConcurrent } from '../core/worker.js';
import { nowIso } from '../core/db.js';
import type { DeliveryJobRepository, DeliveryBindingRepository, DeliveryJobRecord } from './repository.js';
import type { DeliveryService, DeliveryRunResult } from './service.js';

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

/** 틱·목적지별 동시 실행을 제어한다. 개별 발송 결과 판단은 DeliveryService가 담당한다. */
export class DeliveryWorker {
  private readonly tracker = new TaskTracker();
  private readonly buckets = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(private readonly options: DeliveryWorkerOptions) { }

  /** 중복 시작과 종료 후 재시작을 막고 예약 실행을 등록한다. */
  start(): void {
    if (this.timer || this.tracker.stopped) return;
    this.timer = setInterval(() => {
      void this.runDueDeliveries().catch((error: unknown) => this.reportError(error));
    }, this.options.tickIntervalMs ?? 1000);
    this.timer.unref();
  }

  /** 예약 타이머와 새 작업 접수를 중단한다. 이미 시작한 작업은 drain에서 기다린다. */
  stop(): void {
    this.tracker.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 현재 추적 중인 작업이 끝날 때까지 기다려 DB가 처리 도중 닫히지 않게 한다. */
  drain(): Promise<void> {
    return this.tracker.drain();
  }

  /** due 작업을 웹훅별로 묶어 병렬 슬롯을 배정한다. 같은 웹훅 내부 순서는 유지한다. */
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

  /** 스레드가 달라도 같은 웹훅이면 같은 제한 버킷으로 묶는다. */
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

  /** 버킷을 선점한 동안 순차 발송한다. 종료 요청이 오면 이미 시작한 요청만 마친다. */
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

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  /** 오류 보고 콜백의 실패가 다음 예약 실행까지 중단시키지 않도록 격리한다. */
  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // 오류 보고 실패가 다음 예약 실행에 영향을 주지 않도록 한다.
    }
  }
}
