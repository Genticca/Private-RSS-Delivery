import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { importSummary, mutationReply, redirectMutation, requestBody } from './helpers.js';
import { parseImportMode } from '../../services/export-import.service.js';
import { validationError } from '../../services/errors.js';

export async function registerExportImportRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/export', async (_request, reply) => {
    const document = services.exportImport.export();
    const date = document.exportedAt.slice(0, 10).replace(/-/g, '');
    reply.header('content-disposition', `attachment; filename="rss-bridge-export-${date}.json"`);
    return document;
  });

  app.post('/api/import/dry-run', async (request, reply) =>
    mutationReply(reply, () => {
      const body = requestBody(request) as { file?: unknown; content?: unknown; mode?: string };
      const mode = parseImportMode(body.mode);
      return services.exportImport.dryRun(importPayload(body), mode).then((plan) => ({ plan, mode }));
    }, (result) => {
      const preview = result as { plan: { [key: string]: unknown }; mode: string };
      return importSummary(preview.plan, preview.mode);
    })
  );

  app.post('/api/import', async (request, reply) => {
    const body = requestBody(request) as { file?: unknown; content?: unknown; mode?: string };
    await redirectMutation(reply, () => services.exportImport.commit(importPayload(body), parseImportMode(body.mode)), '/sources');
  });
}


const IMPORT_PAYLOAD_LIMIT_BYTES = 1_048_576;

function importPayload(body: { file?: unknown; content?: unknown }): string {
  const payload = fieldToString(body.file ?? body.content ?? '');
  if (Buffer.byteLength(payload, 'utf8') > IMPORT_PAYLOAD_LIMIT_BYTES) {
    throw validationError('Import payload exceeds the upload limit.');
  }
  return payload;
}

function fieldToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return fieldToString((value as { value?: unknown }).value);
  }
  return String(value);
}
