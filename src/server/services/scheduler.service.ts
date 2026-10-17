import type { SourceRepository } from '../db/source.repository.js';
import type { PollWorker } from '../workers/poll-worker.js';
import type { PollSourceResult } from './poll.service.js';
import { notFound } from './errors.js';

export interface SchedulerServiceOptions {
  repositories: {
    sources: Pick<SourceRepository, 'getById'>;
  };
  poller: Pick<PollWorker, 'triggerPoll'>;
}

/** 수동 수집 요청을 예약 수집과 같은 워커에 전달해 중복 실행·종료 규칙을 공유한다. */
export class SchedulerService {
  constructor(private readonly options: SchedulerServiceOptions) { }

  async triggerPoll(sourceId: string): Promise<PollSourceResult> {
    if (!this.options.repositories.sources.getById(sourceId)) throw notFound('소스를 찾을 수 없습니다.');
    return this.options.poller.triggerPoll(sourceId);
  }
}
