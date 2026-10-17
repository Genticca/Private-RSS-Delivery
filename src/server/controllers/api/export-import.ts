import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { importSummary, mutationReply, redirectMutation, requestBody } from './helpers.js';
import { parseImportMode } from '../../services/export-import.service.js';
import { validationError } from '../../services/errors.js';

/** 설정 내보내기와 가져오기 미리보기·적용을 제공한다. 문서 검증과 DB 변경은 서비스에 맡긴다. */
export async function registerExportImportRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/api/export', async (_request, reply) => {
    const document = services.exportImport.export();
    const date = document.exportedAt.slice(0, 10).replace(/-/g, '');
    // 브라우저가 JSON을 날짜가 포함된 파일명으로 내려받게 한다.
    reply.header('content-disposition', `attachment; filename="rss-bridge-export-${date}.json"`);
    return document;
  });

  // 미리보기는 DB를 변경하지 않고 예상 결과와 차단 사유를 HTML로 보여준다.
  app.post('/api/import/dry-run', async (request, reply) =>
    mutationReply(reply, () => {
      const body = requestBody(request) as {
        file?: unknown;
        content?: unknown;
        mode?: string
      };
      const mode = parseImportMode(body.mode);
      return services.exportImport.dryRun(importPayload(body), mode).then((plan) => ({ plan, mode }));
    }, (result) => {
      const preview = result as {
        plan: {
          [key: string]: unknown
        };
        mode: string
      };
      return importSummary(preview.plan, preview.mode);
    })
  );

  // 적용 요청에서도 문서를 다시 검증한 뒤 저장한다. 성공하면 소스 목록으로 이동한다.
  app.post('/api/import', async (request, reply) => {
    const body = requestBody(request) as {
      file?: unknown;
      content?: unknown;
      mode?: string
    };
    await redirectMutation(reply, () => services.exportImport.commit(importPayload(body), parseImportMode(body.mode)), '/sources');
  });
}


const IMPORT_PAYLOAD_LIMIT_BYTES = 1_048_576;

function importPayload(body: {
  file?: unknown;
  content?: unknown
}): string {
  // 업로드 파일을 우선 사용하며, multipart 이외의 요청은 content 필드로도 받을 수 있다.
  const payload = fieldToString(body.file ?? body.content ?? '');
  if (Buffer.byteLength(payload, 'utf8') > IMPORT_PAYLOAD_LIMIT_BYTES) {
    throw validationError('Import payload exceeds the upload limit.');
  }
  return payload;
}

function fieldToString(value: unknown): string {
  // multipart 플러그인 설정에 따른 바이너리·필드 래퍼를 같은 UTF-8 문자열로 변환한다.
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return fieldToString((value as {
      value?: unknown
    }).value);
  }
  return String(value);
}
