import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { flash, isHtmxRequest, mutationReply, redirectMutation, requestBody, sourceRow, type IdParam } from './helpers.js';

export async function registerSourceRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/sources', async () => services.sources.list());

  app.get<{ Params: IdParam }>('/api/sources/:id', async (request) => services.sources.get(request.params.id));

  app.post('/api/sources', async (request, reply) => {
    if (isHtmxRequest(request)) {
      await redirectMutation(reply, () => services.sources.create(requestBody(request)), '/sources');
      return;
    }
    await mutationReply(reply, () => services.sources.create(requestBody(request)), sourceRow);
  });

  app.patch<{ Params: IdParam }>('/api/sources/:id', async (request, reply) => {
    if (isHtmxRequest(request)) {
      await redirectMutation(reply, () => services.sources.update(request.params.id, requestBody(request)), '/sources');
      return;
    }
    await mutationReply(reply, () => services.sources.update(request.params.id, requestBody(request)), sourceRow);
  });

  app.delete<{ Params: IdParam }>('/api/sources/:id', async (request, reply) => {
    services.sources.remove(request.params.id);
    reply.status(204).send();
  });

  app.patch<{ Params: IdParam }>('/api/sources/:id/enabled', async (request, reply) =>
    mutationReply(reply, () => services.sources.setEnabled(request.params.id, requestBody(request)), sourceRow)
  );

  app.post<{ Params: IdParam }>('/api/sources/:id/poll', async (request, reply) =>
    mutationReply(reply, () => services.scheduler.triggerPoll(request.params.id), () => flash('폴링을 요청했습니다.'))
  );

  app.post<{ Params: IdParam }>('/api/sources/:id/test', async (request, reply) =>
    mutationReply(reply, () => services.testSend.testSource(request.params.id), () => flash('테스트 메시지를 전송했습니다.'))
  );

  app.post<{ Params: IdParam }>('/api/sources/:id/retry-failed', async (request, reply) =>
    mutationReply(reply, () => services.sources.retryFailed(request.params.id), (count) => flash(`재시도 대기열에 추가했습니다: ${String(count)}건`))
  );

  app.get<{ Params: IdParam }>('/api/sources/:id/sample-item', async (request) => services.preview.sampleItem(request.params.id));
}
