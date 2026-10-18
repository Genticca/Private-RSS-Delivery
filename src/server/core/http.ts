/**
 * HTTP 경계의 공통 도우미. htmx 응답·필드 오류 HTML과 Host·Origin 검증을 한곳에서 처리한다.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import Handlebars from 'handlebars';
import { AppError } from './errors.js';

export interface IdParam {
  id: string;
}

/** 숫자로 해석할 수 없는 쿼리는 undefined로 넘겨 서비스의 기본 조회 범위를 사용한다. */
export function queryInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value));
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** 서버와 htmx 변경 응답이 공유하는 안내 조각을 렌더링한다. */
export function flash(message: string): string {
  return renderPartial('flash', { message });
}

/** htmx가 응답 헤더를 읽어 전체 페이지를 이동하도록 한다. 응답 본문은 비운다. */
export function redirectNoContent(reply: FastifyReply, location: string): void {
  reply.header('HX-Redirect', location).status(204).send();
}

export async function redirectMutation(
  reply: FastifyReply,
  action: () => unknown | Promise<unknown>,
  location: string
): Promise<void> {
  await handleHtmlMutation(reply, async () => {
    await action();
    redirectNoContent(reply, location);
  });
}

/** 변경 작업을 마친 뒤 결과를 HTML 조각으로 렌더링하는 공통 응답 경로다. */
export async function mutationReply(
  reply: FastifyReply,
  action: () => unknown | Promise<unknown>,
  render: (value: unknown) => string
): Promise<void> {
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

/** 본문이 없는 요청도 같은 서비스 입력 경계로 전달할 수 있게 한다. */
export function requestBody(request: FastifyRequest): unknown {
  return request.body ?? {};
}

/** 변경 응답이 JSON인지 화면 이동·조각 갱신인지 결정할 때 사용하는 요청 표시다. */
export function isHtmxRequest(request: FastifyRequest): boolean {
  return String(request.headers['hx-request'] ?? '').toLowerCase() === 'true';
}

const partialCache = new Map<string, Handlebars.TemplateDelegate>();

/** 파일 기반 화면 조각을 캐시해 반복 변경 요청마다 템플릿을 다시 읽지 않는다. */
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

/** 동적으로 만든 필드 오류 HTML에 입력값이 태그로 삽입되지 않도록 이스케이프한다. */
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

/** Host와 브라우저 Origin을 함께 검사해 loopback 관리 화면의 외부 호출을 제한한다. */
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

/** 로컬 이름과 설정 포트가 허용된 조합인지 확인한다. */
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

/** 브라우저 요청의 Origin·Referer를 검사하되 헤더가 없는 비브라우저 호출의 기존 규칙도 유지한다. */
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
