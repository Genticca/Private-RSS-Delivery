import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { loadConfig, type AppConfig } from '../config.js';
import {
  DeliveryBindingRepository,
  DeliveryJobRepository,
  ItemDeliveryRepository,
  EventLogRepository,
  GroupRepository,
  ItemRepository,
  SourceGroupRepository,
  SourceRepository,
  TemplateRepository,
  TranslationCacheRepository
} from '../db/index.js';
import { seedBuiltinPresets } from '../dispatcher/presets.js';
import type { WebhookEditFunction, WebhookPostFunction } from '../dispatcher/discord-client.js';
import { closeSsrSafeAgents, type FeedFetchResult, type FeedFetchSource, type FetchFeedOptions } from '../security/index.js';
import { CleanupWorker } from '../workers/cleanup-worker.js';
import { PollWorker } from '../workers/poll-worker.js';
import { DeliveryWorker } from '../workers/delivery-worker.js';
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
import { DeliveryBindingService } from '../services/delivery-binding.service.js';
import { DeliveryPlanService } from '../services/delivery-plan.service.js';
import { DeliveryService } from '../services/delivery.service.js';
import { DeliveryManagementService } from '../services/delivery-management.service.js';
import { TranslationCacheService } from '../translator/translation-cache.service.js';
import { PollService } from '../services/poll.service.js';
import { DispatchTranslationService, ModelTranslator, resolveModelName } from '../translator/index.js';
import type { TranslationProvider } from '../translator/types.js';
import { runMigrations } from './migrator.js';
import { loadEnvironment } from './environment.js';
import { loadRuntimeOptions, type RuntimeOptions } from './options.js';
import { stopAndDrain } from './lifecycle.js';

export interface RepositoryRegistry {
  sources: SourceRepository;
  sourceGroups: SourceGroupRepository;
  groups: GroupRepository;
  templates: TemplateRepository;
  items: ItemRepository;
  eventLog: EventLogRepository;
  deliveryBindings: DeliveryBindingRepository;
  itemDeliveries: ItemDeliveryRepository;
  deliveryJobs: DeliveryJobRepository;
  translationCache: TranslationCacheRepository;
}
export interface WorkerRegistry {
  cleanup: CleanupWorker;
  dispatcher: DeliveryWorker;
  poller: PollWorker;
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
  deliveryBindings: DeliveryBindingService;
  deliveryPlan: DeliveryPlanService;
  delivery: DeliveryService;
  poll: PollService;
  deliveryManagement: DeliveryManagementService;
}
export interface ContainerModules {
  repositories: RepositoryRegistry;
  services: ServiceRegistry;
  workers: WorkerRegistry;
}
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
  worker: 'cleanup' | 'poller' | 'dispatcher';
}
export interface CreateContainerOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  config?: AppConfig;
  runtimeOptions?: Partial<RuntimeOptions>;
  db?: Database.Database;
  runMigrations?: boolean;
  urlVerifiers?: UrlVerifierOptions;
  onWorkerError?: (error: unknown, context: WorkerErrorContext) => void;
  feedFetcher?: (source: FeedFetchSource, options?: FetchFeedOptions) => Promise<FeedFetchResult>;
  postWebhook?: WebhookPostFunction;
  editWebhook?: WebhookEditFunction;
  translationProvider?: TranslationProvider;
}

export function createContainer(options: CreateContainerOptions = {}): Container {
  // 조립 순서: 환경 설정 → DB 준비 → 저장소 → 업무 서비스 → 주기 실행 워커.
  const env = loadEnvironment(options.env, { envFilePath: options.envFilePath });
  const config = options.config ?? loadConfig(env);
  const limits = { ...loadRuntimeOptions(env), ...options.runtimeOptions };
  const model = resolveModelName(env);
  const db = options.db ?? openDatabase(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (options.runMigrations !== false) runMigrations(db);
  const repositories: RepositoryRegistry = {
    sources: new SourceRepository(db),
    sourceGroups: new SourceGroupRepository(db),
    groups: new GroupRepository(db),
    templates: new TemplateRepository(db),
    items: new ItemRepository(db),
    eventLog: new EventLogRepository(db),
    deliveryBindings: new DeliveryBindingRepository(db),
    itemDeliveries: new ItemDeliveryRepository(db),
    deliveryJobs: new DeliveryJobRepository(db),
    translationCache: new TranslationCacheRepository(db)
  };
  seedBuiltinPresets(repositories.templates);
  const bindings = new DeliveryBindingService({ db, repositories });
  const planner = new DeliveryPlanService(repositories);
  bindings.reconcileAll(new Date().toISOString());
  // 이전 프로세스가 중단한 작업을 복구한다.
  repositories.deliveryJobs.recoverInterrupted(new Date().toISOString());
  const translator = new ModelTranslator({ repositories, env, model, provider: options.translationProvider });
  const translation = new DispatchTranslationService({ repositories, translator });
  const delivery = new DeliveryService({
    db,
    repositories,
    planner,
    translationService: translation,
    postWebhook: options.postWebhook,
    editWebhook: options.editWebhook
  });
  const report = (error: unknown, worker: WorkerErrorContext['worker']) => {
    if (options.onWorkerError) options.onWorkerError(error, { worker });
    else console.error('Background worker failed:', worker, error);
  };
  let poller: PollWorker;
  const poll = new PollService({
    db,
    repositories,
    bindings,
    planner,
    fetchFeed: options.feedFetcher,
    fetchOptions: { maxBytes: limits.feedMaxBytes },
    holdCount: limits.holdCount,
    holdMinItems: limits.holdMinItems,
    holdRatio: limits.holdRatio,
    isStopping: () => poller?.stopped ?? false
  });
  poller = new PollWorker({
    sources: repositories.sources,
    service: poll,
    concurrency: limits.pollConcurrency,
    onError: (error) => report(error, 'poller')
  });
  const workers: WorkerRegistry = {
    poller,
    dispatcher: new DeliveryWorker({
      jobs: repositories.deliveryJobs,
      bindings: repositories.deliveryBindings,
      service: delivery,
      concurrency: limits.deliveryConcurrency,
      onError: (error) => report(error, 'dispatcher')
    }),
    cleanup: new CleanupWorker({
      db,
      repositories,
      itemContentRetentionDays: limits.itemContentRetentionDays,
      onError: (error) => report(error, 'cleanup')
    })
  };
  const preview = new PreviewService({ repositories });
  const services: ServiceRegistry = {
    sources: new SourceService({
      db,
      repositories,
      bindings,
      verifyFeedUrl: options.urlVerifiers?.verifyFeedUrl
    }),
    groups: new GroupService({
      db,
      repositories,
      bindings,
      verifyWebhookUrl: options.urlVerifiers?.verifyWebhookUrl
    }),
    templates: new TemplateService({ repositories }),
    preview,
    model: new ModelService({ repositories, env, model, translation: new TranslationCacheService({ repositories, translator }) }),
    logs: new LogService({ repositories }),
    scheduler: new SchedulerService({ repositories, poller }),
    exportImport: new ExportImportService({
      db,
      repositories,
      bindings,
      verifyFeedUrl: options.urlVerifiers?.verifyFeedUrl,
      verifyWebhookUrl: options.urlVerifiers?.verifyWebhookUrl
    }),
    testSend: new TestSendService({ repositories, preview }),
    deliveryBindings: bindings,
    deliveryPlan: planner,
    delivery,
    poll,
    deliveryManagement: new DeliveryManagementService(db, repositories, planner)
  };
  let closePromise: Promise<void> | null = null;
  let closed = false;
  return {
    config,
    db,
    repositories,
    services,
    workers,
    close() {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // 워커가 DB를 더 이상 사용하지 않는 것을 확인한 뒤 연결을 닫는다.
        await stopAndDrain([workers.poller, workers.dispatcher, workers.cleanup], limits.shutdownTimeoutMs);
        await closeSsrSafeAgents();
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch { /* best effort checkpoint */ }
        db.close();
        closed = true;
      })();
      void closePromise.catch(() => {
        closePromise = null;
      });
      return closePromise;
    }
  };
}

function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ':memory:' && !databasePath.startsWith('file:')) mkdirSync(dirname(databasePath), { recursive: true });
  return new Database(databasePath);
}
