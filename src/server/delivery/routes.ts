import type { FastifyInstance } from 'fastify';
import { mutationReply, flash, requestBody, isHtmxRequest, redirectMutation, type IdParam } from '../core/http.js';
import { parseIdParam } from '../core/input.js';
import type { DeliveryManagementService } from './review.js';
import type { PreviewService, TestSendService } from './preview.js';

/** 보류되거나 결과 확인이 필요한 발송 작업을 조회하고 관리자의 검토 결정을 전달한다. */
export async function registerDeliveryJobRoutes(app: FastifyInstance, services: { deliveryManagement: DeliveryManagementService }): Promise<void> {
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

/** 템플릿을 렌더링해 payload 또는 단계별 오류를 JSON으로 반환한다. Discord 발송은 수행하지 않는다. */
export async function registerPreviewRoutes(app: FastifyInstance, services: { preview: PreviewService }): Promise<void> {
  // 샘플·실시간 피드 선택과 렌더링 검증은 PreviewService에서 처리한다.
  app.post('/api/preview', async (request) => services.preview.preview(requestBody(request)));
}

interface DeliveryRouteServices {
  deliveryManagement: DeliveryManagementService;
  preview: PreviewService;
  testSend: TestSendService;
}

export async function registerSourceDeliveryRoutes(app: FastifyInstance, services: DeliveryRouteServices): Promise<void> {


  // 미리보기와 달리 실제 Discord 메시지를 전송한다. 전송이 끝난 뒤 성공 안내를 반환한다.
  app.post<{
    Params: IdParam
  }>('/api/sources/:id/test', async (request, reply) =>
    mutationReply(reply, () => services.testSend.testSource(request.params.id), () => flash('테스트 메시지를 전송했습니다.'))
  );


  // 실패 작업을 대기열에 되돌리는 요청이다. 응답의 건수는 즉시 발송한 메시지 수가 아니다.
  app.post<{
    Params: IdParam
  }>('/api/sources/:id/retry-failed', async (request, reply) =>
    mutationReply(reply, () => services.deliveryManagement.retryFailed(request.params.id), (count) => flash(`재시도 대기열에 추가했습니다: ${String(count)}건`))
  );


  app.get<{
    Params: IdParam
  }>('/api/sources/:id/sample-item', async (request) => services.preview.sampleItem(request.params.id));
}
