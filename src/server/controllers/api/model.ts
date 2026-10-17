import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { isHtmxRequest, modelDiagnostics, mutationReply, requestBody, translationDiagnostic } from './helpers.js';

/** 번역 모델 상태·진단 HTTP 라우트다. 모델과 키는 환경 변수로만 바꾼다. */
export async function registerModelRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/model/diagnostics', async () => services.model.getDiagnostics());
  app.post('/api/model/diagnose', async (request, reply) => {
    const diagnose = () => services.model.diagnose(requestBody(request));
    // htmx에는 진단 HTML과 상태 갱신 조각을 함께, 일반 요청에는 진단 결과 JSON을 반환한다.
    if (isHtmxRequest(request)) return mutationReply(reply, diagnose,
      (result) => translationDiagnostic(result) + modelDiagnostics(services.model.getDiagnostics()));
    return diagnose();
  });
}
