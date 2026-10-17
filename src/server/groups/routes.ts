import type { FastifyInstance } from 'fastify';
import { mutationReply, requestBody, renderPartial, type IdParam } from '../core/http.js';
import { parseIdParam } from '../core/input.js';
import type { GroupService } from './service.js';

/** Discord 발송 그룹의 조회·변경 라우트다. 웹훅 검증과 소스 연결 조정은 서비스가 담당한다. */
export async function registerGroupRoutes(app: FastifyInstance, services: { groups: GroupService }): Promise<void> {
  app.get('/api/groups', async () => services.groups.list());

  // 생성·수정은 목록에서 교체할 그룹 행 HTML을 반환하고, 입력 오류도 HTML로 표시한다.
  app.post('/api/groups', async (request, reply) =>
    mutationReply(reply, () => services.groups.create(requestBody(request)), groupRow)
  );

  app.patch<{
    Params: IdParam
  }>('/api/groups/:id', async (request, reply) =>
    mutationReply(reply, () => services.groups.update(parseIdParam(request.params.id), requestBody(request)), groupRow)
  );

  app.delete<{
    Params: IdParam
  }>('/api/groups/:id', async (request, reply) => {
    // 그룹 ID는 숫자 키다. URL의 문자열을 검증한 뒤 서비스에 넘기고 삭제 성공은 204로 응답한다.
    services.groups.remove(parseIdParam(request.params.id));
    reply.status(204).send();
  });
}

export function groupRow(value: unknown): string {
  return renderPartial('group-row', value);
}
