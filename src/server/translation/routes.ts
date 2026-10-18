/**
 * 번역 상태·진단 라우트. 모델·키 설정은 환경 변수에 두고 이 화면은 조회와 진단만 제공한다.
 */
import type { FastifyInstance } from 'fastify';
import { requestBody, isHtmxRequest, mutationReply, renderPartial } from '../core/http.js';
import type { ModelService } from './service.js';

/** 번역 모델 상태·진단 HTTP 라우트다. 모델과 키는 환경 변수로만 바꾼다. */
export async function registerModelRoutes(app: FastifyInstance, services: { model: ModelService }): Promise<void> {
  app.get('/api/model/diagnostics', async () => services.model.getDiagnostics());
  app.post('/api/model/diagnose', async (request, reply) => {
    const diagnose = () => services.model.diagnose(requestBody(request));
    // htmx에는 진단 HTML과 상태 갱신 조각을 함께, 일반 요청에는 진단 결과 JSON을 반환한다.
    if (isHtmxRequest(request))
      return mutationReply(reply, diagnose,
        (result) => translationDiagnostic(result) + modelDiagnostics(services.model.getDiagnostics()));
    return diagnose();
  });
}

export function translationDiagnostic(value: unknown): string {
  return renderPartial('translation-diagnostic', value);
}

export function modelDiagnostics(value: object): string {
  return renderPartial('model-diagnostics', { ...value, oob: true });
}
