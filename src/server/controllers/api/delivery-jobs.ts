import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../container.js';
import type { IdParam } from '../../core/http.js';
import { parseIdParam } from '../../core/input.js';
import { requestBody } from '../../core/http.js';
import { isHtmxRequest } from '../../core/http.js';
import { redirectMutation } from '../../core/http.js';

/** 보류되거나 결과 확인이 필요한 발송 작업을 조회하고 관리자의 검토 결정을 전달한다. */
export async function registerDeliveryJobRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/delivery-jobs', async (request) => services.deliveryManagement.list(request.query));
  app.post<{
    Params: IdParam
  }>('/api/delivery-jobs/:id/review', async (request, reply) => {
    const review = () => services.deliveryManagement.review(parseIdParam(request.params.id), requestBody(request));
    // 현재 상태에서 허용되는 결정인지는 서비스가 검증한다. 여기서는 응답 형식만 선택한다.
    // 관리 화면은 검토 후 목록으로 이동하고, 일반 요청은 갱신된 작업을 JSON으로 받는다.
    if (isHtmxRequest(request)) return redirectMutation(reply, review, '/delivery-jobs');
    return review();
  });
}
