import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { expandDottedBody, modelDiagnostics, modelRow, mutationReply, queryInt, requestBody, translationDiagnostic } from './helpers.js';
import { isHtmxRequest } from './helpers.js';

export async function registerModelRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/model/config', async () => services.model.getConfig());
  app.patch('/api/model/config', async (request, reply) =>
    mutationReply(reply, () => services.model.updateConfig(expandDottedBody(requestBody(request))), modelRow)
  );
  app.get('/api/model/status', async () => services.model.getStatus());
  app.get('/api/model/diagnostics', async () => services.model.getDiagnostics());
  app.post('/api/model/diagnose', async (request, reply) => {
    const diagnose = () => services.model.diagnose(requestBody(request));
    if (isHtmxRequest(request)) return mutationReply(reply, diagnose,
      (result) => translationDiagnostic(result) + modelDiagnostics(services.model.getDiagnostics()));
    return diagnose();
  });
  app.get('/api/model/usage', async (request) => {
    const query = request.query as { before?: string; limit?: string };
    return services.model.listUsage({ before: queryInt(query.before), limit: queryInt(query.limit) });
  });
}
