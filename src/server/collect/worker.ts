/**
 * 수집 예약·수동 실행. 틱 중복과 소스별 중복을 각각 막으며 두 실행 경로를 같은 작업 추적으로 관리한다.
 */
import type { SourceRepository, SourceRecord } from '../sources/repository.js';
import { TaskTracker, mapConcurrent } from '../core/worker.js';
import { nowIso } from '../core/db.js';
import { emptyResult, type PollService, type PollSourceResult } from './service.js';

export interface PollWorkerOptions {
  sources: Pick<SourceRepository, 'findDuePoll' | 'getById'>;
  service: Pick<PollService, 'poll'>;
  now?: () => string;
  tickIntervalMs?: number;
  dueLimit?: number;
  concurrency?: number;
  onError?: (error: unknown) => void;
}

/** 전체 틱과 소스별 진행 작업을 각각 추적한다. 수동 요청도 같은 중복·종료 가드를 사용한다. */
export class PollWorker {
  private readonly tracker = new TaskTracker();
  private readonly active = new Map<string, Promise<PollSourceResult>>();
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<PollSourceResult[]> | null = null;
  constructor(private readonly options: PollWorkerOptions) { }
  get stopped(): boolean {
    return this.tracker.stopped;
  }

  /** 중복 시작과 종료 후 재시작을 막고 예약 실행을 등록한다. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.runDuePolls().catch((error: unknown) => this.reportError(error));
    }, this.options.tickIntervalMs ?? 30_000);
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

  /** 이미 실행 중인 틱이 있으면 새 due 조회를 시작하지 않는다. 결과 순서는 선택된 소스 순서를 유지한다. */
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

  /** 수동 요청은 즉시 같은 소스별 실행 경로로 들어가 처리 완료 결과를 반환한다. */
  triggerPoll(sourceId: string, now = this.now()): Promise<PollSourceResult> {
    const source = this.options.sources.getById(sourceId);
    if (!source) return Promise.reject(new Error(`Source not found: ${sourceId}`));
    return this.pollSource(source, now);
  }

  /** 같은 소스가 이미 진행 중이거나 종료 중이면 건너뛰고 새 요청을 시작하지 않는다. */
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

  /** 오류 보고 콜백의 실패가 다음 예약 실행까지 중단시키지 않도록 격리한다. */
  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // 오류 보고 콜백의 실패가 타이머의 미처리 거부로 이어지지 않도록 격리한다.
    }
  }
}
