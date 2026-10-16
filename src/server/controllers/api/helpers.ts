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

export function modelRow(): string {
  return flash('모델 설정을 저장했습니다.');
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

export function importSummary(plan: { [key: string]: unknown }, mode = 'skip'): string {
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

export function redirectNoContent(reply: FastifyReply, location: string): void {
  reply.header('HX-Redirect', location).status(204).send();
}

export async function redirectMutation(reply: FastifyReply, action: () => unknown | Promise<unknown>, location: string): Promise<void> {
  try {
    await action();
    redirectNoContent(reply, location);
  } catch (error) {
    if (error instanceof AppError) {
      reply.status(error.statusCode).type('text/html').send(errorPartial(error));
      return;
    }
    throw error;
  }
}

export async function mutationReply(reply: FastifyReply, action: () => unknown | Promise<unknown>, render: (value: unknown) => string): Promise<void> {
  try {
    const result = await action();
    reply.type('text/html').send(render(result));
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


export function expandDottedBody(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const valueForKey = Array.isArray(rawValue) ? rawValue.at(-1) : rawValue;
    const parts = key.split('.').filter(Boolean);
    if (parts.length <= 1) {
      output[key] = valueForKey;
      continue;
    }
    let cursor = output;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = valueForKey;
  }
  return output;
}

export function isHtmxRequest(request: FastifyRequest): boolean {
  return String(request.headers['hx-request'] ?? '').toLowerCase() === 'true';
}


const partialCache = new Map<string, Handlebars.TemplateDelegate>();

function renderPartial(name: string, context: unknown): string {
  let template = partialCache.get(name);
  if (!template) {
    const file = fileURLToPath(new URL(`../../../resources/templates/partials/${name}.hbs`, import.meta.url));
    template = Handlebars.compile(readFileSync(file, 'utf8'));
    partialCache.set(name, template);
  }
  return template(context);
}

function errorPartial(error: AppError): string {
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
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
}
