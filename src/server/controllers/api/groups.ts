import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { groupRow, mutationReply, requestBody, type IdParam } from './helpers.js';
import { parseIdParam } from '../../services/validation.js';

export async function registerGroupRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/groups', async () => services.groups.list());

  app.post('/api/groups', async (request, reply) =>
    mutationReply(reply, () => services.groups.create(requestBody(request)), groupRow)
  );

  app.patch<{ Params: IdParam }>('/api/groups/:id', async (request, reply) =>
    mutationReply(reply, () => services.groups.update(parseIdParam(request.params.id), requestBody(request)), groupRow)
  );

  app.delete<{ Params: IdParam }>('/api/groups/:id', async (request, reply) => {
    services.groups.remove(parseIdParam(request.params.id));
    reply.status(204).send();
  });
}
