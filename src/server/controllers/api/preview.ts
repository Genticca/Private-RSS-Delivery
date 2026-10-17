import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { requestBody } from './helpers.js';

/** 템플릿을 렌더링해 payload 또는 단계별 오류를 JSON으로 반환한다. Discord 발송은 수행하지 않는다. */
export async function registerPreviewRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  // 샘플·실시간 피드 선택과 렌더링 검증은 PreviewService에서 처리한다.
  app.post('/api/preview', async (request) => services.preview.preview(requestBody(request)));
}
