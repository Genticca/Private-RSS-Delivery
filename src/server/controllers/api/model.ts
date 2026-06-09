import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { expandDottedBody, modelRow, mutationReply, queryInt, requestBody } from './helpers.js';

export async function registerModelRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/model/config', async () => services.model.getConfig());
  app.patch('/api/model/config', async (request, reply) =>
    mutationReply(reply, () => services.model.updateConfig(expandDottedBody(requestBody(request))), modelRow)
  );
  app.get('/api/model/status', async () => services.model.getStatus());
  app.get('/api/model/usage', async (request) => {
    const query = request.query as { before?: string; limit?: string };
    return services.model.listUsage({ before: queryInt(query.before), limit: queryInt(query.limit) });
  });
}
