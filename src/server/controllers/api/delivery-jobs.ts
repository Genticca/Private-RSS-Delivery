import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { parseIdParam } from '../../services/validation.js';
import { isHtmxRequest, redirectMutation, requestBody, type IdParam } from './helpers.js';

export async function registerDeliveryJobRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/delivery-jobs', async (request) => services.deliveryManagement.list(request.query));
  app.post<{ Params: IdParam }>('/api/delivery-jobs/:id/review', async (request, reply) => {
    const review = () => services.deliveryManagement.review(parseIdParam(request.params.id), requestBody(request));
    if (isHtmxRequest(request)) return redirectMutation(reply, review, '/delivery-jobs');
    return review();
  });
}
