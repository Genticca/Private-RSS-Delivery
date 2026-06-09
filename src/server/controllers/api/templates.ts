import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { flash, mutationReply, requestBody, templateRow, type IdParam } from './helpers.js';
import { parseIdParam } from '../../services/validation.js';

export async function registerTemplateRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/templates', async () => services.templates.list());

  app.get<{ Params: IdParam }>('/api/templates/:id', async (request) => services.templates.get(parseIdParam(request.params.id)));

  app.post('/api/templates', async (request, reply) =>
    mutationReply(reply, () => services.templates.create(requestBody(request)), templateRow)
  );

  app.patch<{ Params: IdParam }>('/api/templates/:id', async (request, reply) =>
    mutationReply(
      reply,
      () => services.templates.update(parseIdParam(request.params.id), requestBody(request)),
      (template) => `${flash('템플릿을 저장했습니다.')}${templateRow(template)}`
    )
  );

  app.delete<{ Params: IdParam }>('/api/templates/:id', async (request, reply) => {
    services.templates.remove(parseIdParam(request.params.id));
    reply.status(204).send();
  });
}
