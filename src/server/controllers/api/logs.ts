import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../../runtime/container.js';
import { validationError } from '../../services/errors.js';
import type { LogType } from '../../services/log.service.js';
import { queryInt } from './helpers.js';

export interface LogRouteOptions {
  maxSseConnections?: number;
}

const DEFAULT_MAX_SSE_CONNECTIONS = 5;

export async function registerLogRoutes(app: FastifyInstance, services: ServiceRegistry, options: LogRouteOptions = {}): Promise<void> {
  const sseConnections = createSseConnectionLimiter(options.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS);
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });

  app.get('/api/logs', async (request) => {
    const query = request.query as { type?: string; before?: string; limit?: string };
    return services.logs.list(parseLogType(query.type), {
      before: queryInt(query.before),
      limit: queryInt(query.limit)
    });
  });

  app.get('/api/logs/stream', async (request, reply) => {
    const release = sseConnections.tryAcquire();
    if (!release) {
      return reply.status(503).send({ error: { code: 'stream_limit_exceeded', message: 'Too many log stream connections.' } });
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    request.raw.on('close', releaseOnce);
    reply.raw.on('close', releaseOnce);
    streams.add(reply.raw);
    reply.raw.on('close', () => streams.delete(reply.raw));
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    reply.raw.flushHeaders();
    const cursor = parseSseCursor(request.headers['last-event-id']);
    let deliveryLast = cursor?.delivery ?? 0;
    let fetchLast = cursor?.fetch ?? 0;
    const writeEvent = (event: { event: string; id: number; data: unknown }): void => {
      if (event.event === 'delivery') deliveryLast = Math.max(deliveryLast, event.id);
      if (event.event === 'fetch') fetchLast = Math.max(fetchLast, event.id);
      reply.raw.write(`event: ${event.event}\n`);
      reply.raw.write(`id: ${deliveryLast}:${fetchLast}\n`);
      reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
    };
    for (const event of cursor ? services.logs.after(deliveryLast, fetchLast, 100) : services.logs.backfill(50)) writeEvent(event);
    let ticks = 0;
    const timer = setInterval(() => {
      for (const event of services.logs.after(deliveryLast, fetchLast, 100)) writeEvent(event);
      if (++ticks % 15 === 0) reply.raw.write(': ping\n\n');
    }, 1000);
    timer.unref();
    request.raw.on('close', () => {
      clearInterval(timer);
      releaseOnce();
    });
  });
}

export function parseSseCursor(value: string | string[] | undefined): { delivery: number; fetch: number } | null {
  if (typeof value !== 'string' || !/^\d+:\d+$/.test(value)) return null;
  const [delivery, fetch] = value.split(':').map(Number);
  return Number.isSafeInteger(delivery) && Number.isSafeInteger(fetch) ? { delivery, fetch } : null;
}


export interface SseConnectionLimiter {
  active(): number;
  tryAcquire(): (() => void) | null;
}

export function createSseConnectionLimiter(maxConnections: number): SseConnectionLimiter {
  let activeConnections = 0;
  return {
    active: () => activeConnections,
    tryAcquire() {
      if (activeConnections >= maxConnections) return null;
      activeConnections += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeConnections = Math.max(0, activeConnections - 1);
      };
    }
  };
}

function parseLogType(value: string | undefined): LogType {
  if (value === undefined || value === '' || value === 'delivery') return 'delivery';
  if (value === 'fetch') return 'fetch';
  throw validationError('type 값이 올바르지 않습니다.', { type: 'delivery 또는 fetch만 허용됩니다.' });
}
