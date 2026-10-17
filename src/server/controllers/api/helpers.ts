import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../services/errors.js';

export interface IdParam {
  id: string;
}

export function queryInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value));
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function sourceRow(value: unknown): string {
  return renderPartial('source-row', value);
}

export function groupRow(value: unknown): string {
  return renderPartial('group-row', value);
}

export function templateRow(value: unknown): string {
  return renderPartial('template-row', value);
}

export function translationDiagnostic(value: unknown): string {
  return renderPartial('translation-diagnostic', value);
}

export function modelDiagnostics(value: object): string {
  return renderPartial('model-diagnostics', { ...value, oob: true });
}

export function flash(message: string): string {
  return renderPartial('flash', { message });
}

export function importSummary(plan: {
  [key: string]: unknown
}, mode = 'skip'): string {
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.map((warning) => String(warning)) : [];
  const blockedFeedUrls = Array.isArray(plan.blockedFeedUrls) ? plan.blockedFeedUrls : [];
  return renderPartial('import-preview', {
    ...plan,
    warnings,
    blockedFeedUrls,
    hasWarnings: warnings.length > 0,
    hasBlockedFeedUrls: blockedFeedUrls.length > 0,
    mode,
    modeSkip: mode !== 'overwrite',
    modeOverwrite: mode === 'overwrite'
  });
}

/** htmx가 응답 헤더를 읽어 전체 페이지를 이동하도록 한다. 응답 본문은 비운다. */
export function redirectNoContent(reply: FastifyReply, location: string): void {
  reply.header('HX-Redirect', location).status(204).send();
}

export async function redirectMutation(reply: FastifyReply, action: () => unknown | Promise<unknown>, location: string): Promise<void> {
  await handleHtmlMutation(reply, async () => {
    await action();
    redirectNoContent(reply, location);
  });
}

/** 변경 작업을 마친 뒤 결과를 HTML 조각으로 렌더링하는 공통 응답 경로다. */
export async function mutationReply(reply: FastifyReply, action: () => unknown | Promise<unknown>, render: (value: unknown) => string): Promise<void> {
  await handleHtmlMutation(reply, async () => {
    const result = await action();
    reply.type('text/html').send(render(result));
  });
}

/** htmx 폼의 예상된 입력 오류는 HTML로 응답하고, 예기치 않은 오류는 전역 처리기에 맡긴다. */
async function handleHtmlMutation(reply: FastifyReply, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError) {
      reply.status(error.statusCode).type('text/html').send(errorPartial(error));
      return;
    }
    throw error;
  }
}

export function requestBody(request: FastifyRequest): unknown {
  return request.body ?? {};
}


export function isHtmxRequest(request: FastifyRequest): boolean {
  return String(request.headers['hx-request'] ?? '').toLowerCase() === 'true';
}


const partialCache = new Map<string, Handlebars.TemplateDelegate>();

function renderPartial(name: string, context: unknown): string {
  // 같은 부분 템플릿을 요청마다 다시 읽고 컴파일하지 않도록 최초 결과를 재사용한다.
  let template = partialCache.get(name);
  if (!template) {
    const file = fileURLToPath(new URL(`../../../resources/templates/partials/${name}.hbs`, import.meta.url));
    template = Handlebars.compile(readFileSync(file, 'utf8'));
    partialCache.set(name, template);
  }
  return template(context);
}

function errorPartial(error: AppError): string {
  // 템플릿을 거치지 않고 만드는 HTML이므로 오류 메시지와 필드명도 이스케이프한다.
  const fields = error.fields ? fieldList(error.fields) : '';
  return `<div class="form-error" data-error-code="${escapeHtml(error.code)}"><p>${escapeHtml(error.message)}</p>${fields}</div>`;
}

function fieldList(fields: Record<string, string>): string {
  const rows = Object.entries(fields).map(([field, message]) =>
    `<li><strong>${escapeHtml(field)}</strong>: ${escapeHtml(String(message))}</li>`
  );
  return `<ul class="field-errors">${rows.join('')}</ul>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char] ?? char));
}
