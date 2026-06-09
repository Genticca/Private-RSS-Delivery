import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { requestBody } from './helpers.js';

export async function registerPreviewRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.post('/api/preview', async (request) => services.preview.preview(requestBody(request)));
}
