import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import {
  expandDottedBody,
  modelDiagnostics,
  modelRow,
  mutationReply,
  queryInt,
  requestBody,
  translationDiagnostic
} from './helpers.js';
import { isHtmxRequest } from './helpers.js';

/** 번역 모델 설정·상태·진단·사용량을 관리하는 HTTP 라우트다. */
export async function registerModelRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/model/config', async () => services.model.getConfig());
  // 폼의 primary.model 같은 점 표기 필드를 중첩 객체로 복원한 뒤 서비스에서 검증한다.
  app.patch('/api/model/config', async (request, reply) =>
    mutationReply(reply, () => services.model.updateConfig(expandDottedBody(requestBody(request))), modelRow)
  );
  app.get('/api/model/status', async () => services.model.getStatus());
  app.get('/api/model/diagnostics', async () => services.model.getDiagnostics());
  app.post('/api/model/diagnose', async (request, reply) => {
    const diagnose = () => services.model.diagnose(requestBody(request));
    // htmx에는 진단 HTML과 상태 갱신 조각을 함께, 일반 요청에는 진단 결과 JSON을 반환한다.
    if (isHtmxRequest(request)) return mutationReply(reply, diagnose,
      (result) => translationDiagnostic(result) + modelDiagnostics(services.model.getDiagnostics()));
    return diagnose();
  });
  app.get('/api/model/usage', async (request) => {
    // 쿼리 문자열을 정수로 읽는다. 조회 건수 제한은 서비스에서 적용한다.
    const query = request.query as {
      before?: string;
      limit?: string
    };
    return services.model.listUsage({ before: queryInt(query.before), limit: queryInt(query.limit) });
  });
}
