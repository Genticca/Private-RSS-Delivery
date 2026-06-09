import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import multipartPlugin from '@fastify/multipart';
import rateLimitPlugin from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import viewPlugin from '@fastify/view';
import Handlebars from 'handlebars';
import { registerApiRoutes } from './controllers/api/index.js';
import { registerWebRoutes } from './controllers/web.js';
import { registerAdminOrigin } from './middleware/index.js';
import { SecurityError } from './security/index.js';
import { AppError } from './services/errors.js';
import { createContainer, type Container } from './runtime/container.js';

export type AppInstance = FastifyInstance & { container: Container };

export interface CreateAppOptions {
  container?: Container;
  logger?: boolean;
}

export function createApp(options: CreateAppOptions = {}): AppInstance {
  const app = Fastify({ logger: options.logger ?? true }) as unknown as AppInstance;
  const container =
    options.container ??
    createContainer({
      onWorkerError: (error, context) => {
        app.log.error({ err: error, worker: context.worker }, 'background worker failed');
      }
    });
  const ownsContainer = options.container === undefined;
  app.decorate('container', container);

  registerBodyParsers(app);
  registerErrorHandlers(app);
  app.register(async (instance) => {
    await registerAdminOrigin(instance, { port: container.config.port });
    await registerRateLimit(instance);
    await registerMultipart(instance);
    await registerViewAndStatic(instance);
    await registerApiRoutes(instance, container.services);
    await registerWebRoutes(instance, container.services);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/ready', async () => {
    container.db.prepare('SELECT 1').get();
    return { status: 'ready' };
  });

  app.addHook('onClose', async () => {
    if (ownsContainer) await container.close();
  });

  return app;
}

async function main(): Promise<void> {
  const app = createApp();

  await app.listen({ port: app.container.config.port, host: app.container.config.host });

  // 워커는 listen 성공 이후 시작한다.
  app.container.workers.cleanup.start();
  app.container.workers.poller.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.container.workers.poller.stop();
    app.container.workers.cleanup.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const IMPORT_UPLOAD_LIMIT_BYTES = 1_048_576;

const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ALLOW_LIST = ['/assets/', '/api/logs/stream', '/healthz', '/ready'] as const;

async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimitPlugin, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    allowList: (request) => RATE_LIMIT_ALLOW_LIST.some((prefix) => request.url.startsWith(prefix)),
    errorResponseBuilder: () => new AppError(429, 'rate_limited', 'Too many requests.')
  });
}

async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(multipartPlugin, {
    attachFieldsToBody: 'keyValues',
    limits: { fileSize: IMPORT_UPLOAD_LIMIT_BYTES, files: 1, fields: 4, parts: 5 }
  });
}

async function registerViewAndStatic(app: FastifyInstance): Promise<void> {
  const templatesRoot = fileURLToPath(new URL('../resources/templates', import.meta.url));
  const assetsRoot = fileURLToPath(new URL('../resources/templates/assets', import.meta.url));
  registerHandlebarsPartials(templatesRoot);
  await app.register(staticPlugin, { root: assetsRoot, prefix: '/assets/' });
  await app.register(viewPlugin, {
    engine: { handlebars: Handlebars },
    root: templatesRoot,
    layout: 'layouts/main.hbs'
  });
}

function registerHandlebarsPartials(templatesRoot: string): void {
  const partialsRoot = join(templatesRoot, 'partials');
  if (!existsSync(partialsRoot)) return;
  for (const file of readdirSync(partialsRoot)) {
    if (extname(file) !== '.hbs') continue;
    Handlebars.registerPartial(basename(file, '.hbs'), readFileSync(join(partialsRoot, file), 'utf8'));
  }
}

function registerBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    const params = new URLSearchParams(String(body));
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
      const current = result[key];
      if (current === undefined) result[key] = value;
      else if (Array.isArray(current)) current.push(value);
      else result[key] = [current, value];
    }
    done(null, result);
  });
}

function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: '요청한 경로를 찾을 수 없습니다.' } });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, fields: error.fields } });
      return;
    }
    if (error instanceof SecurityError) {
      const code = error.code === 'webhook_not_allowed' ? 'webhook_not_allowed' : error.code === 'ssrf_blocked' ? 'ssrf_blocked' : 'validation_error';
      const status = code === 'validation_error' ? 400 : 400;
      reply.status(status).send({ error: { code, message: error.message } });
      return;
    }
    if (isMultipartError(error)) {
      reply.status(error.statusCode ?? 400).send({ error: { code: 'validation_error', message: error.message } });
      return;
    }
    app.log.error({ err: error }, 'request failed');
    reply.status(500).send({ error: { code: 'internal_error', message: '서버 오류가 발생했습니다.' } });
  });
}


function isMultipartError(error: unknown): error is Error & { code?: string; statusCode?: number } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string' && String((error as { code?: string }).code).startsWith('FST_');
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
