import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import Handlebars from 'handlebars';
import { AppError } from './errors.js';

export interface IdParam {
  id: string;
}

export function queryInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value));
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function flash(message: string): string {
  return renderPartial('flash', { message });
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

export function renderPartial(name: string, context: unknown): string {
  // 같은 부분 템플릿을 요청마다 다시 읽고 컴파일하지 않도록 최초 결과를 재사용한다.
  let template = partialCache.get(name);
  if (!template) {
    const file = fileURLToPath(new URL(`../../resources/templates/partials/${name}.hbs`, import.meta.url));
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

export interface AdminOriginOptions {
  port: number;
  allowedHosts?: string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function registerAdminOrigin(app: FastifyInstance, options: AdminOriginOptions): Promise<void> {
  const allowedHosts = new Set([
    `localhost:${options.port}`,
    `127.0.0.1:${options.port}`,
    `[::1]:${options.port}`,
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(options.allowedHosts ?? [])
  ]);

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/assets/')) return;
    if (!isAllowedHost(request.headers.host, allowedHosts)) {
      reject(reply, 'Host header is not allowed.');
      return;
    }
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    // 상태를 바꾸는 브라우저 요청은 Host 검사에 더해 Origin 또는 Referer도 확인한다.
    if (!hasAllowedBrowserOrigin(request, allowedHosts)) {
      reject(reply, 'Origin is not allowed.');
    }
  });
}

export function isAllowedHost(hostHeader: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return (
    allowedHosts.has(host) ||
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1:') ||
    host.startsWith('[::1]:')
  );
}

export function hasAllowedBrowserOrigin(request: FastifyRequest, allowedHosts: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  // 브라우저 출처 헤더가 없는 CLI 요청은 Host 검사를 통과했다면 허용한다.
  if (!origin && !referer) return true;
  if (typeof origin === 'string') return isAllowedUrlHost(origin, allowedHosts);
  if (typeof referer === 'string') return isAllowedUrlHost(referer, allowedHosts);
  return false;
}

function isAllowedUrlHost(value: string, allowedHosts: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    return allowedHosts.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

function reject(reply: FastifyReply, message: string): void {
  reply.status(403).send({ error: { code: 'forbidden', message } });
}
