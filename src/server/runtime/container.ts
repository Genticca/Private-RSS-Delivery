import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { loadConfig, type AppConfig } from '../config.js';
import {
  DeliveryLogRepository,
  FetchLogRepository,
  GroupRepository,
  ItemRepository,
  ModelConfigRepository,
  ModelUsageRepository,
  SourceGroupRepository,
  SourceRepository,
  TemplateRepository
} from '../db/index.js';
import { seedBuiltinPresets } from '../dispatcher/presets.js';
import { WebhookDispatcher } from '../dispatcher/webhook.js';
import { Poller } from '../scheduler/index.js';
import { closeSsrSafeAgents } from '../security/index.js';
import { CleanupWorker } from '../workers/index.js';
import {
  ExportImportService,
  GroupService,
  LogService,
  ModelService,
  PreviewService,
  SchedulerService,
  SourceService,
  TemplateService,
  TestSendService
} from '../services/index.js';
import { DispatchTranslationService, ModelTranslator } from '../translator/index.js';
import { runMigrations } from './migrator.js';

export interface RepositoryRegistry {
  sources: SourceRepository;
  sourceGroups: SourceGroupRepository;
  groups: GroupRepository;
  templates: TemplateRepository;
  items: ItemRepository;
  deliveryLogs: DeliveryLogRepository;
  fetchLogs: FetchLogRepository;
  modelConfig: ModelConfigRepository;
  modelUsage: ModelUsageRepository;
}

export interface WorkerRegistry {
  cleanup: CleanupWorker;
  dispatcher: WebhookDispatcher;
  poller: Poller;
}

export interface ServiceRegistry {
  sources: SourceService;
  groups: GroupService;
  templates: TemplateService;
  preview: PreviewService;
  model: ModelService;
  logs: LogService;
  scheduler: SchedulerService;
  exportImport: ExportImportService;
  testSend: TestSendService;
}

export interface ContainerModules {
  repositories: RepositoryRegistry;
  services: ServiceRegistry;
  workers: WorkerRegistry;
}

// DI 컨테이너: 부팅 시 한 번 조립해 app/worker 가 공유한다.
export interface Container extends ContainerModules {
  config: AppConfig;
  db: Database.Database;
  close(): Promise<void>;
}

export interface UrlVerifierOptions {
  verifyFeedUrl?: (value: string) => Promise<unknown>;
  verifyWebhookUrl?: (value: string) => Promise<unknown>;
}

export interface WorkerErrorContext {
  worker: 'cleanup' | 'poller';
}

export interface CreateContainerOptions {
  env?: NodeJS.ProcessEnv;
  config?: AppConfig;
  db?: Database.Database;
  runMigrations?: boolean;
  urlVerifiers?: UrlVerifierOptions;
  onWorkerError?: (error: unknown, context: WorkerErrorContext) => void;
}

export function createContainer(options: CreateContainerOptions = {}): Container {
  const config = options.config ?? loadConfig(options.env);
  const db = options.db ?? openDatabase(config.databasePath);

  configureDatabase(db);

  if (options.runMigrations !== false) {
    runMigrations(db);
  }

  const repositories: RepositoryRegistry = {
    sources: new SourceRepository(db),
    sourceGroups: new SourceGroupRepository(db),
    groups: new GroupRepository(db),
    templates: new TemplateRepository(db),
    items: new ItemRepository(db),
    deliveryLogs: new DeliveryLogRepository(db),
    fetchLogs: new FetchLogRepository(db),
    modelConfig: new ModelConfigRepository(db),
    modelUsage: new ModelUsageRepository(db)
  };

  seedBuiltinPresets(repositories.templates);

  const translator = new ModelTranslator({ repositories, env: options.env });
  const translationService = new DispatchTranslationService({ repositories, translator });
  const dispatcher = new WebhookDispatcher({ db, repositories, translationService });
  const reportWorkerError = createWorkerErrorReporter(options.onWorkerError);

  const workers: WorkerRegistry = {
    cleanup: new CleanupWorker({
      db,
      repositories,
      onError: (error) => reportWorkerError(error, { worker: 'cleanup' })
    }),
    dispatcher,
    poller: new Poller({
      db,
      repositories,
      deliveryRunner: dispatcher,
      onError: (error) => reportWorkerError(error, { worker: 'poller' })
    })
  };

  const preview = new PreviewService({ repositories });

  const services: ServiceRegistry = {
    sources: new SourceService({
      db,
      repositories,
      verifyFeedUrl: options.urlVerifiers?.verifyFeedUrl
    }),
    groups: new GroupService({ db, repositories, verifyWebhookUrl: options.urlVerifiers?.verifyWebhookUrl }),
    templates: new TemplateService({ repositories }),
    preview,
    model: new ModelService({ repositories, env: options.env }),
    logs: new LogService({ repositories }),
    scheduler: new SchedulerService({ repositories, poller: workers.poller }),
    exportImport: new ExportImportService({
      db,
      repositories,
      verifyFeedUrl: options.urlVerifiers?.verifyFeedUrl,
      verifyWebhookUrl: options.urlVerifiers?.verifyWebhookUrl
    }),
    testSend: new TestSendService({ repositories, preview })
  };

  const modules: ContainerModules = {
    repositories,
    services,
    workers
  };

  let closed = false;

  return {
    config,
    db,
    ...modules,
    async close() {
      if (closed) return;
      closed = true;
      workers.poller.stop();
      workers.cleanup.stop();
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort checkpoint during shutdown
      }
      db.close();
      await closeSsrSafeAgents();
    }
  };
}

function createWorkerErrorReporter(
  reporter: ((error: unknown, context: WorkerErrorContext) => void) | undefined
): (error: unknown, context: WorkerErrorContext) => void {
  return (error, context) => {
    if (reporter) {
      reporter(error, context);
      return;
    }
    console.error(`Background worker failed: ${context.worker}`, error);
  };
}

function openDatabase(databasePath: string): Database.Database {
  ensureDatabaseDirectory(databasePath);
  return new Database(databasePath);
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:' || databasePath.startsWith('file:')) return;
  mkdirSync(dirname(databasePath), { recursive: true });
}

function configureDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL'); // data/ 에 -wal/-shm 동반 파일 생성
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}
