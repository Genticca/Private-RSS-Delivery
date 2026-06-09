import type { PollSourceResult, Poller } from '../scheduler/index.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { notFound } from './errors.js';

export interface SchedulerServiceOptions {
  repositories: RepositoryRegistry;
  poller: Poller;
}

export class SchedulerService {
  constructor(private readonly options: SchedulerServiceOptions) {}

  async triggerPoll(sourceId: string): Promise<PollSourceResult> {
    if (!this.options.repositories.sources.getById(sourceId)) throw notFound('소스를 찾을 수 없습니다.');
    return this.options.poller.triggerPoll(sourceId);
  }
}
