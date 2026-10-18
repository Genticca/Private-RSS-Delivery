/**
 * HTTP 조립. 플러그인·보안·뷰·기능 라우트를 등록하고 공통 오류를 HTTP 응답으로 변환한다.
 */
import { fileURLToPath } from 'node:url';
import { join, extname, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimitPlugin from '@fastify/rate-limit';
import multipartPlugin from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import viewPlugin from '@fastify/view';
import Handlebars from 'handlebars';
import { registerSourceRoutes } from './sources/routes.js';
import { registerGroupRoutes } from './groups/routes.js';
import { registerTemplateRoutes } from './templates/routes.js';
import { registerPreviewRoutes, registerDeliveryJobRoutes, registerSourceDeliveryRoutes } from './delivery/routes.js';
import { registerModelRoutes } from './translation/routes.js';
import { registerLogRoutes } from './logs/routes.js';
import { registerExportImportRoutes } from './transfer/routes.js';
import { createContainer, type Container } from './container.js';
import { registerAdminOrigin } from './core/http.js';
import { registerCollectRoutes } from './collect/routes.js';
import { registerWebRoutes } from './web/pages.js';
import { AppError, SecurityError } from './core/errors.js';

export type AppInstance = FastifyInstance & {
  container: Container
};

export interface CreateAppOptions {
  container?: Container;
  logger?: boolean;
}

/** 주입받은 컨테이너의 소유권은 호출자에게 둔다. 직접 생성한 컨테이너만 앱 종료 때 함께 닫는다. */
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
  // 외부에서 주입한 컨테이너의 수명은 호출자가 관리한다.
  app.decorate('container', container);

  registerBodyParsers(app);
  registerErrorHandlers(app);
  app.register(async (instance) => {
    await registerAdminOrigin(instance, { port: container.config.port });
    await registerRateLimit(instance);
    await registerMultipart(instance);
    await registerViewAndStatic(instance);
    const services = container.services;
    await registerSourceRoutes(instance, { sources: services.sources });
    await registerSourceDeliveryRoutes(
      instance,
      {
        deliveryManagement: services.deliveryManagement,
        testSend: services.testSend,
        preview: services.preview
      }
    );
    await registerGroupRoutes(instance, { groups: services.groups });
    await registerTemplateRoutes(instance, { templates: services.templates });
    await registerPreviewRoutes(instance, { preview: services.preview });
    await registerModelRoutes(instance, { model: services.model });
    await registerLogRoutes(instance, { logs: services.logs });
    await registerExportImportRoutes(instance, { exportImport: services.exportImport });
    await registerDeliveryJobRoutes(instance, { deliveryManagement: services.deliveryManagement });
    await registerCollectRoutes(instance, { sources: container.repositories.sources, poller: container.workers.poller });
    await registerWebRoutes(instance, {
      sources: services.sources, groups: services.groups, templates: services.templates,
      model: services.model, logs: services.logs, deliveryManagement: services.deliveryManagement
    });
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

const IMPORT_UPLOAD_LIMIT_BYTES = 1_048_576;

const RATE_LIMIT_MAX = 120;

const RATE_LIMIT_WINDOW_MS = 60_000;

const RATE_LIMIT_ALLOW_LIST = ['/assets/', '/api/logs/stream', '/healthz', '/ready'] as const;

/** 상태 점검·정적 자산·SSE를 제외한 관리 요청에 공통 호출 제한을 적용한다. */
async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimitPlugin, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    allowList: (request) => RATE_LIMIT_ALLOW_LIST.some((prefix) => request.url.startsWith(prefix)),
    errorResponseBuilder: () => new AppError(429, 'rate_limited', 'Too many requests.')
  });
}

/** Import 파일 하나와 소수의 옵션 필드만 허용해 업로드 크기와 파트 수를 제한한다. */
async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(multipartPlugin, {
    attachFieldsToBody: 'keyValues',
    limits: {
      fileSize: IMPORT_UPLOAD_LIMIT_BYTES,
      files: 1,
      fields: 4,
      parts: 5
    }
  });
}

/** 실행 파일 위치를 기준으로 뷰와 정적 자산을 찾아 작업 디렉터리 차이의 영향을 피한다. */
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

/** 같은 Handlebars 엔진에 화면 조각을 등록해 페이지와 변경 응답이 공통 조각을 사용하게 한다. */
function registerHandlebarsPartials(templatesRoot: string): void {
  const partialsRoot = join(templatesRoot, 'partials');
  if (!existsSync(partialsRoot)) return;
  for (const file of readdirSync(partialsRoot)) {
    if (extname(file) !== '.hbs') continue;
    Handlebars.registerPartial(basename(file, '.hbs'), readFileSync(join(partialsRoot, file), 'utf8'));
  }
}

/** 반복된 폼 필드는 배열로 보존한다. 그룹·태그처럼 여러 값을 받는 입력을 잃지 않기 위해서다. */
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

/** 예상 오류는 지정된 상태 코드로 반환하고, 예상하지 못한 오류의 상세 내용은 서버 로그에만 남긴다. */
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
      const code = error.code === 'webhook_not_allowed' || error.code === 'ssrf_blocked'
        ? error.code
        : 'validation_error';
      reply.status(400).send({ error: { code, message: error.message } });
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

function isMultipartError(error: unknown): error is Error & {
  code?: string;
  statusCode?: number
} {
  return error instanceof Error && typeof (error as {
    code?: unknown
  }).code === 'string' && String((error as {
    code?: string
  }).code).startsWith('FST_');
}
