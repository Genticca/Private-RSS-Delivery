/**
 * 의존성 조립 루트. 설정·DB·저장소·서비스·워커를 연결하고 공유 자원의 종료 순서를 관리한다.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SourceRepository, SourceGroupRepository } from './sources/repository.js';
import { GroupRepository } from './groups/repository.js';
import { TemplateRepository, seedBuiltinPresets } from './templates/repository.js';
import { ItemRepository } from './feed/repository.js';
import { EventLogRepository } from './logs/repository.js';
import { DeliveryBindingRepository, ItemDeliveryRepository, DeliveryJobRepository } from './delivery/repository.js';
import { TranslationCacheRepository, TranslationCacheService } from './translation/cache.js';
import { CleanupWorker } from './cleanup/worker.js';
import { DeliveryWorker } from './delivery/worker.js';
import { PollWorker } from './collect/worker.js';
import { SourceService } from './sources/service.js';
import { GroupService } from './groups/service.js';
import { TemplateService } from './templates/service.js';
import { PreviewService, TestSendService } from './delivery/preview.js';
import { ModelService } from './translation/service.js';
import { LogService } from './logs/service.js';
import { ExportImportService } from './transfer/service.js';
import { DeliveryBindingService } from './delivery/bindings.js';
import { DeliveryPlanService } from './delivery/plan.js';
import { DeliveryService } from './delivery/service.js';
import { PollService } from './collect/service.js';
import { DeliveryManagementService } from './delivery/review.js';
import { loadEnvironment, loadConfig, loadRuntimeOptions, type AppConfig, type RuntimeOptions } from './core/config.js';
import { closeSsrSafeAgents, type FeedFetchSource, type FetchFeedOptions, type FeedFetchResult } from './net/fetch.js';
import type { WebhookPostFunction, WebhookEditFunction } from './delivery/discord.js';
import { ModelTranslator, DispatchTranslationService, type TranslationProvider } from './translation/translator.js';
import { resolveModelName } from './translation/gemini.js';
import { runMigrations } from './core/db.js';
import { stopAndDrain } from './core/worker.js';

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

/** 한 번 병합한 환경을 모든 구성 요소에 전달하고, 상위 기능의 동작은 콜백으로 주입한다. */
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
  // 낮은 tier의 서비스가 발송 계층을 직접 import하지 않도록 연결 갱신 동작을 콜백으로 넘긴다.
  const services: ServiceRegistry = {
    sources: new SourceService({
      db,
      repositories,
      reconcileDestinations: (id, now, reset) => bindings.reconcile(id, now, reset),
      verifyFeedUrl: options.urlVerifiers?.verifyFeedUrl
    }),
    groups: new GroupService({
      db,
      repositories,
      reconcileAllDestinations: (now) => bindings.reconcileAll(now),
      verifyWebhookUrl: options.urlVerifiers?.verifyWebhookUrl
    }),
    templates: new TemplateService({ repositories }),
    preview,
    model: new ModelService({
      repositories,
      env,
      model,
      translator,
      translation: new TranslationCacheService({ repositories, translator })
    }),
    logs: new LogService({ repositories }),
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
      // HTTP 종료와 프로세스 신호가 겹쳐도 같은 종료 작업을 함께 기다린다.
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
      // drain 실패 시 DB를 열어 둔 채 종료를 다시 시도할 수 있도록 실패한 Promise만 해제한다.
      void closePromise.catch(() => {
        closePromise = null;
      });
      return closePromise;
    }
  };
}

/** 파일형 SQLite의 상위 디렉터리를 준비하고 연결한다. 메모리 DB에는 디렉터리를 만들지 않는다. */
function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ':memory:' && !databasePath.startsWith('file:')) mkdirSync(dirname(databasePath), { recursive: true });
  return new Database(databasePath);
}
