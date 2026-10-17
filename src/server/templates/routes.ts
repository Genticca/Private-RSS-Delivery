import type { FastifyInstance } from 'fastify';
import { mutationReply, requestBody, flash, renderPartial, type IdParam } from '../core/http.js';
import { parseIdParam } from '../core/input.js';
import type { TemplateService } from './service.js';

/** Discord 메시지 템플릿을 조회하고 편집한다. 템플릿 검증과 저장 정책은 서비스가 담당한다. */
export async function registerTemplateRoutes(app: FastifyInstance, services: { templates: TemplateService }): Promise<void> {
  app.get('/api/templates', async () => services.templates.list());

  app.get<{
    Params: IdParam
  }>('/api/templates/:id', async (request) => services.templates.get(parseIdParam(request.params.id)));

  // 조회는 JSON으로, 생성·수정은 관리 화면에서 사용할 HTML 조각으로 응답한다.
  app.post('/api/templates', async (request, reply) =>
    mutationReply(reply, () => services.templates.create(requestBody(request)), templateRow)
  );

  app.patch<{
    Params: IdParam
  }>('/api/templates/:id', async (request, reply) =>
    mutationReply(
      reply,
      () => services.templates.update(parseIdParam(request.params.id), requestBody(request)),
      // 저장 안내와 갱신된 행을 함께 반환해 화면이 두 영역을 반영할 수 있게 한다.
      (template) => `${flash('템플릿을 저장했습니다.')}${templateRow(template)}`
    )
  );

  app.delete<{
    Params: IdParam
  }>('/api/templates/:id', async (request, reply) => {
    services.templates.remove(parseIdParam(request.params.id));
    reply.status(204).send();
  });
}

export function templateRow(value: unknown): string {
  return renderPartial('template-row', value);
}
