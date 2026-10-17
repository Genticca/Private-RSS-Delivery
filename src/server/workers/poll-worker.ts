import type { SourceRepository } from '../db/source.repository.js';
import type { PollService } from '../services/poll.service.js';
import { TaskTracker } from './task-tracker.js';
import type { PollSourceResult } from '../services/poll.service.js';
import { mapConcurrent } from './task-tracker.js';
import { emptyResult } from '../services/poll.service.js';
import type { SourceRecord } from '../db/source.repository.js';
import { nowIso } from '../db/time.js';

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
  constructor(private readonly options: PollWorkerOptions) { }
  get stopped(): boolean {
    return this.tracker.stopped;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.runDuePolls().catch((error: unknown) => this.reportError(error));
    }, this.options.tickIntervalMs ?? 30_000);
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

  runDuePolls(now = this.now()): Promise<PollSourceResult[]> {
    if (this.stopped || this.tick) return Promise.resolve([]);
    // 한 주기가 끝나기 전에 다음 주기가 같은 소스를 다시 선택하지 않도록 한다.
    this.tick = this.tracker.track(() => {
      const dueSources = this.options.sources.findDuePoll(now, this.options.dueLimit ?? 50);
      return mapConcurrent(dueSources, this.options.concurrency ?? 2, (source) => {
        if (this.stopped) return Promise.resolve(emptyResult(source.id));
        return this.pollSource(source, now);
      });
    });
    void this.tick.then(() => {
      this.tick = null;
    }, () => {
      this.tick = null;
    });
    return this.tick;
  }

  triggerPoll(sourceId: string, now = this.now()): Promise<PollSourceResult> {
    const source = this.options.sources.getById(sourceId);
    if (!source) return Promise.reject(new Error(`Source not found: ${sourceId}`));
    return this.pollSource(source, now);
  }

  pollSource(source: SourceRecord, now = this.now()): Promise<PollSourceResult> {
    // 수동 수집과 예약 수집이 겹쳐도 같은 소스는 한 번만 처리한다.
    if (this.stopped || this.active.has(source.id)) return Promise.resolve(emptyResult(source.id));
    const task = this.tracker.track(() => {
      if (this.stopped) return Promise.resolve(emptyResult(source.id));
      return this.options.service.poll(source.id, now);
    });
    this.active.set(source.id, task);
    void task.then(() => this.active.delete(source.id), () => this.active.delete(source.id));
    return task;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // 오류 보고 콜백의 실패가 타이머의 미처리 거부로 이어지지 않도록 격리한다.
    }
  }
}
