import type { DeliveryBindingRepository, DeliveryJobRepository, ItemRecord } from '../db/index.js';
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
  constructor(private readonly options: DeliveryWorkerOptions) {}

  start(): void {
    if (this.timer || this.tracker.stopped) return;
    this.timer = setInterval(() => {
      void this.runDueDeliveries().catch((error: unknown) => { try { this.options.onError?.(error); } catch { /* isolated reporter */ } });
    }, this.options.tickIntervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void { this.tracker.stop(); if (this.timer) clearInterval(this.timer); this.timer = null; }
  drain(): Promise<void> { return this.tracker.drain(); }

  async runDueDeliveries(now = this.now()): Promise<DeliveryRunResult[]> {
    if (this.tracker.stopped || this.ticking) return [];
    this.ticking = true;
    try {
      return await this.tracker.track(async () => {
        const jobs = this.options.jobs.findDue(now, this.options.dueLimit ?? 50);
        const grouped = new Map<string, typeof jobs>();
        for (const job of jobs) {
          const binding = job.bindingId === null ? null : this.options.bindings.getById(job.bindingId);
          if (!binding) continue;
          const list = grouped.get(binding.bucketKey) ?? [];
          list.push(job); grouped.set(binding.bucketKey, list);
        }
        const batches = await mapConcurrent([...grouped], this.options.concurrency ?? 2, async ([bucket, batch]) => {
          if (this.buckets.has(bucket)) return [];
          this.buckets.add(bucket);
          const results: DeliveryRunResult[] = [];
          try {
            for (const job of batch) {
              if (this.tracker.stopped) break;
              const result = await this.options.service.processJob(job.id, now, () => this.tracker.stopped);
              if (result) results.push(result);
            }
          } finally { this.buckets.delete(bucket); }
          return results;
        });
        return batches.flat();
      });
    } finally { this.ticking = false; }
  }

  /** Executes existing jobs only; bare pending items never acquire current destinations here. */
  async processItem(item: ItemRecord, now = this.now()): Promise<DeliveryRunResult> {
    const job = this.options.jobs.findDue(now, 100_000).find((entry) => entry.itemId === item.id);
    if (!job || this.tracker.stopped) return { itemId: item.id, jobId: 0, outcome: 'skipped', attemptNo: null };
    return await this.tracker.track(() => this.options.service.processJob(job.id, now, () => this.tracker.stopped))
      ?? { itemId: item.id, jobId: job.id, outcome: 'skipped', attemptNo: null };
  }

  private now(): string { return this.options.now?.() ?? nowIso(); }
}
