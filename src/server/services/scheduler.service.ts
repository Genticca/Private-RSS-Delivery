import type { PollSourceResult } from './poll.service.js';
import type { PollWorker } from '../workers/poll-worker.js';
import type { SourceRepository } from '../db/index.js';
import { notFound } from './errors.js';

export interface SchedulerServiceOptions {
  repositories: {
    sources: Pick<SourceRepository, 'getById'>;
  };
  poller: Pick<PollWorker, 'triggerPoll'>;
}

export class SchedulerService {
  constructor(private readonly options: SchedulerServiceOptions) {}

  async triggerPoll(sourceId: string): Promise<PollSourceResult> {
    if (!this.options.repositories.sources.getById(sourceId)) throw notFound('소스를 찾을 수 없습니다.');
    return this.options.poller.triggerPoll(sourceId);
  }
}
