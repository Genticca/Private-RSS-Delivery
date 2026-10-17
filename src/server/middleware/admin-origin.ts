import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
