/**
 * 수집 소스 CRUD 라우트. htmx 폼의 이동·오류 처리와 일반 변경 요청의 행 응답을 구분한다.
 */
import type { FastifyInstance } from 'fastify';
import {
  isHtmxRequest,
  redirectMutation,
  requestBody,
  mutationReply,
  flash,
  renderPartial,
  type IdParam
} from '../core/http.js';
import type { SourceService } from './service.js';

/** 피드 소스 관리와 수동 수집·테스트 발송 요청을 해당 서비스에 연결한다. */
export async function registerSourceRoutes(app: FastifyInstance, services: { sources: SourceService }): Promise<void> {
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
}

export function sourceRow(value: unknown): string {
  return renderPartial('source-row', value);
}
