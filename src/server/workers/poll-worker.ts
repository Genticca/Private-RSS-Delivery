import type { SourceRecord, SourceRepository } from '../db/index.js';
import { nowIso } from '../db/time.js';
import type { PollService, PollSourceResult } from '../services/poll.service.js';
import { emptyResult } from '../services/poll.service.js';
import { mapConcurrent, TaskTracker } from './task-tracker.js';

export interface PollWorkerOptions {
  sources: Pick<SourceRepository, 'findDuePoll' | 'getById'>;
  service: Pick<PollService, 'poll'>;
  now?: () => string;
  tickIntervalMs?: number;
  dueLimit?: number;
  concurrency?: number;
  onError?: (error: unknown) => void;
}

export class PollWorker {
  private readonly tracker = new TaskTracker();
  private readonly active = new Map<string, Promise<PollSourceResult>>();
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<PollSourceResult[]> | null = null;
  constructor(private readonly options: PollWorkerOptions) {}
  get stopped(): boolean { return this.tracker.stopped; }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.runDuePolls().catch((error: unknown) => { try { this.options.onError?.(error); } catch { /* isolated reporter */ } });
    }, this.options.tickIntervalMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    this.tracker.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  drain(): Promise<void> { return this.tracker.drain(); }

  runDuePolls(now = this.now()): Promise<PollSourceResult[]> {
    if (this.stopped || this.tick) return Promise.resolve([]);
    this.tick = this.tracker.track(() => mapConcurrent(this.options.sources.findDuePoll(now, this.options.dueLimit ?? 50), this.options.concurrency ?? 2,
      (source) => this.stopped ? Promise.resolve(emptyResult(source.id)) : this.pollSource(source, now)));
    void this.tick.then(() => { this.tick = null; }, () => { this.tick = null; });
    return this.tick;
  }

  triggerPoll(sourceId: string, now = this.now()): Promise<PollSourceResult> {
    const source = this.options.sources.getById(sourceId);
    if (!source) return Promise.reject(new Error(`Source not found: ${sourceId}`));
    return this.pollSource(source, now);
  }

  pollSource(source: SourceRecord, now = this.now()): Promise<PollSourceResult> {
    if (this.stopped || this.active.has(source.id)) return Promise.resolve(emptyResult(source.id));
    const task = this.tracker.track(() => this.stopped ? Promise.resolve(emptyResult(source.id)) : this.options.service.poll(source.id, now));
    this.active.set(source.id, task);
    void task.then(() => this.active.delete(source.id), () => this.active.delete(source.id));
    return task;
  }

  private now(): string { return this.options.now?.() ?? nowIso(); }
}
