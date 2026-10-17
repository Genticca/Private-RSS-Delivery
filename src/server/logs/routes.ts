import type { FastifyInstance } from 'fastify';
import { queryInt } from '../core/http.js';
import { validationError } from '../core/errors.js';
import type { LogService, LogType } from './service.js';

export interface LogRouteOptions {
  maxSseConnections?: number;
}

const DEFAULT_MAX_SSE_CONNECTIONS = 5;

const STREAM_POLL_INTERVAL_MS = 1000;

const HEARTBEAT_EVERY_TICKS = 15;

/** 로그 목록은 JSON으로 조회하고, 실시간 추가 로그는 SSE 연결을 유지하며 전달한다. */
export async function registerLogRoutes(app: FastifyInstance, services: { logs: LogService }, options: LogRouteOptions = {}): Promise<void> {
  const sseConnections = createSseConnectionLimiter(options.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS);
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => {
    // 장시간 유지되는 SSE 응답을 먼저 닫아 서버 종료가 연결 대기에 묶이지 않게 한다.
    for (const stream of streams) stream.end();
  });

  app.get('/api/logs', async (request) => {
    const query = request.query as {
      type?: string;
      before?: string;
      limit?: string
    };
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
    let last = cursor ?? 0;
    const writeEvent = (event: {
      event: string;
      id: number;
      data: unknown
    }): void => {
      last = Math.max(last, event.id);
      reply.raw.write(`event: ${event.event}\n`);
      reply.raw.write(`id: ${last}\n`);
      reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
    };
    // 재연결은 마지막 커서 다음부터, 첫 연결은 최근 로그부터 보여준다.
    const initialEvents = cursor !== null
      ? services.logs.after(last, 100)
      : services.logs.backfill(50);
    for (const event of initialEvents) {
      writeEvent(event);
    }
    let ticks = 0;
    const timer = setInterval(() => {
      for (const event of services.logs.after(last, 100)) writeEvent(event);
      // 새 로그가 없어도 주기적으로 데이터를 보내 유휴 연결이 끊어지지 않게 한다.
      if (++ticks % HEARTBEAT_EVERY_TICKS === 0) reply.raw.write(': ping\n\n');
    }, STREAM_POLL_INTERVAL_MS);
    timer.unref();
    request.raw.on('close', () => {
      clearInterval(timer);
      releaseOnce();
    });
  });
}

export function parseSseCursor(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
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
        // 요청과 응답 양쪽에서 close가 발생해도 연결 수는 한 번만 줄인다.
        if (released) return;
        released = true;
        activeConnections = Math.max(0, activeConnections - 1);
      };
    }
  };
}

function parseLogType(value: string | undefined): LogType {
  if (value === undefined || value === '' || value === 'delivery') return 'delivery';
  if (value === 'fetch' || value === 'translation') return value;
  throw validationError('type 값이 올바르지 않습니다.', { type: 'delivery, fetch, translation만 허용됩니다.' });
}
