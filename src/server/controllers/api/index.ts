import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { registerExportImportRoutes } from './export-import.js';
import { registerGroupRoutes } from './groups.js';
import { registerLogRoutes } from './logs.js';
import { registerModelRoutes } from './model.js';
import { registerPreviewRoutes } from './preview.js';
import { registerSourceRoutes } from './sources.js';
import { registerTemplateRoutes } from './templates.js';
import { registerDeliveryJobRoutes } from './delivery-jobs.js';

/** 기능별 관리 라우트를 등록한다. HTTP 입력·응답을 연결하고 업무 규칙은 서비스에 맡긴다. */
export async function registerApiRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  // /api 아래에서도 조회는 JSON, 관리 화면의 변경 요청은 HTML 조각이나 리다이렉트를 사용한다.
  await registerSourceRoutes(app, services);
  await registerGroupRoutes(app, services);
  await registerTemplateRoutes(app, services);
  await registerPreviewRoutes(app, services);
  await registerModelRoutes(app, services);
  await registerLogRoutes(app, services);
  await registerExportImportRoutes(app, services);
  await registerDeliveryJobRoutes(app, services);
}
