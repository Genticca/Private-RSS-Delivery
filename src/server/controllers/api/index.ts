import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { registerExportImportRoutes } from './export-import.js';
import { registerGroupRoutes } from './groups.js';
import { registerLogRoutes } from './logs.js';
import { registerModelRoutes } from './model.js';
import { registerPreviewRoutes } from './preview.js';
import { registerSourceRoutes } from './sources.js';
import { registerTemplateRoutes } from './templates.js';

export async function registerApiRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  await registerSourceRoutes(app, services);
  await registerGroupRoutes(app, services);
  await registerTemplateRoutes(app, services);
  await registerPreviewRoutes(app, services);
  await registerModelRoutes(app, services);
  await registerLogRoutes(app, services);
  await registerExportImportRoutes(app, services);
}
