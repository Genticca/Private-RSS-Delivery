import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import {
  flash,
  isHtmxRequest,
  mutationReply,
  redirectMutation,
  requestBody,
  sourceRow,
  type IdParam
} from './helpers.js';

/** 피드 소스 관리와 수동 수집·테스트 발송 요청을 해당 서비스에 연결한다. */
export async function registerSourceRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/sources', async () => services.sources.list());

  app.get<{
    Params: IdParam
  }>('/api/sources/:id', async (request) => services.sources.get(request.params.id));

  app.post('/api/sources', async (request, reply) => {
    // htmx 폼은 저장 후 목록으로 이동하고, 그 외 요청에는 갱신된 소스 행 HTML을 반환한다.
    if (isHtmxRequest(request)) {
      await redirectMutation(reply, () => services.sources.create(requestBody(request)), '/sources');
      return;
    }
    await mutationReply(reply, () => services.sources.create(requestBody(request)), sourceRow);
  });

  app.patch<{
    Params: IdParam
  }>('/api/sources/:id', async (request, reply) => {
    // 수정도 생성과 같은 응답 규칙을 사용한다. 입력 검증과 연결 갱신은 서비스에서 처리한다.
    if (isHtmxRequest(request)) {
      await redirectMutation(reply, () => services.sources.update(request.params.id, requestBody(request)), '/sources');
      return;
    }
    await mutationReply(reply, () => services.sources.update(request.params.id, requestBody(request)), sourceRow);
  });

  app.delete<{
    Params: IdParam
  }>('/api/sources/:id', async (request, reply) => {
    services.sources.remove(request.params.id);
    reply.status(204).send();
  });

  app.patch<{
    Params: IdParam
  }>('/api/sources/:id/enabled', async (request, reply) =>
    mutationReply(reply, () => services.sources.setEnabled(request.params.id, requestBody(request)), sourceRow)
  );

  // 수동 수집도 예약 수집과 같은 워커를 사용해 동일 소스의 중복 실행을 방지한다.
  app.post<{
    Params: IdParam
  }>('/api/sources/:id/poll', async (request, reply) =>
    mutationReply(reply, () => services.scheduler.triggerPoll(request.params.id), () => flash('폴링을 요청했습니다.'))
  );

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
    mutationReply(reply, () => services.sources.retryFailed(request.params.id), (count) => flash(`재시도 대기열에 추가했습니다: ${String(count)}건`))
  );

  app.get<{
    Params: IdParam
  }>('/api/sources/:id/sample-item', async (request) => services.preview.sampleItem(request.params.id));
}
