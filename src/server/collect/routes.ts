import type { FastifyInstance } from 'fastify';
import type { SourceRepository } from '../sources/repository.js';
import type { PollWorker } from './worker.js';
import { notFound } from '../core/errors.js';
import { mutationReply, flash, type IdParam } from '../core/http.js';

/** 수동 수집도 예약 수집과 같은 워커에 전달한다. */
export async function registerCollectRoutes(app: FastifyInstance, deps: {
  sources: Pick<SourceRepository, 'getById'>;
  poller: Pick<PollWorker, 'triggerPoll'>;
}): Promise<void> {
  app.post<{ Params: IdParam }>('/api/sources/:id/poll', async (request, reply) =>
    mutationReply(reply, () => {
      const id = request.params.id;
      if (!deps.sources.getById(id)) throw notFound('소스를 찾을 수 없습니다.');
      return deps.poller.triggerPoll(id);
    }, () => flash('폴링을 요청했습니다.'))
  );
}
