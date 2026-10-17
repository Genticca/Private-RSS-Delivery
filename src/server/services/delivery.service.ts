import type { ItemRepository } from '../feed/repository.js';
import type { SourceRepository } from '../sources/repository.js';
import type { GroupRepository } from '../groups/repository.js';
import type { SourceGroupRepository } from '../sources/repository.js';
import type { DeliveryBindingRepository } from '../db/delivery-binding.repository.js';
import type { DeliveryJobRepository } from '../db/delivery-job.repository.js';
import type { ItemDeliveryRepository } from '../db/item-delivery.repository.js';
import type { EventLogRepository } from '../logs/repository.js';
import type Database from 'better-sqlite3';
import type { DeliveryPlanService } from './delivery-plan.service.js';
import type { DispatchTranslationService } from '../translator/translator.js';
import type { WebhookPostFunction } from '../dispatcher/discord-client.js';
import type { WebhookEditFunction } from '../dispatcher/discord-client.js';
import { nowIso } from '../core/db.js';
import type { DiscordWebhookPayload } from '../templates/render.js';
import type { SourceRecord } from '../sources/repository.js';
import type { ItemRecord } from '../feed/repository.js';
import type { TranslatedItem } from '../templates/render.js';
import { renderDiscordPayload } from '../templates/render.js';
import { buildPresetRenderContext } from '../templates/render.js';
import { validateDiscordPayload } from '../templates/payload.js';
import { applySourceWebhookOptions } from '../templates/payload.js';
import { editDiscordWebhookMessage } from '../dispatcher/discord-client.js';
import { postDiscordWebhook } from '../dispatcher/discord-client.js';
import { SecurityError } from '../core/errors.js';
import { DiscordPayloadValidationError } from '../templates/payload.js';
import { PresetRenderError } from '../templates/render.js';
import type { DeliveryJobRecord } from '../db/delivery-job.repository.js';
import { resolveDestinationsForSource } from '../dispatcher/resolve-destinations.js';
import type { WebhookPostResponse } from '../dispatcher/discord-client.js';
import { retryAt } from '../domain/delivery/policy.js';
import type { DeliveryJobState } from '../domain/delivery/policy.js';

export interface DeliveryRepositories {
  items: ItemRepository;
  sources: SourceRepository;
  groups: GroupRepository;
  sourceGroups: SourceGroupRepository;
  deliveryBindings: DeliveryBindingRepository;
  deliveryJobs: DeliveryJobRepository;
  itemDeliveries: ItemDeliveryRepository;
  eventLog: EventLogRepository;
}

export interface DeliveryServiceOptions {
  db: Database.Database;
  repositories: DeliveryRepositories;
  planner: DeliveryPlanService;
  translationService?: Pick<DispatchTranslationService, 'translateItemForDispatch'>;
  postWebhook?: WebhookPostFunction;
  editWebhook?: WebhookEditFunction;
  requestTimeoutMs?: number;
}

export type DeliveryRunOutcome = 'delivered' | 'failed' | 'retrying' | 'skipped' | 'unknown' | 'uneditable';

export interface DeliveryRunResult {
  itemId: number;
  jobId: number;
  outcome: DeliveryRunOutcome;
  attemptNo: number | null;
  failureReason?: string;
  nextAttemptAt?: string | null;
}

export class DeliveryService {
  constructor(private readonly options: DeliveryServiceOptions) { }

  async processJob(id: number, now = nowIso(), isStopping: () => boolean = () => false): Promise<DeliveryRunResult | null> {
    const { repositories } = this.options;
    // 1. 작업 소유권을 얻고 연결·버전·발송 이력이 여전히 유효한지 확인한다.
    const job = repositories.deliveryJobs.claim(id);
    if (!job) return null;
    // 요청을 시작한 뒤에는 실패하더라도 Discord에 메시지가 생성됐을 수 있다.
    let requestStarted = false;
    try {
      let context = this.resolveActiveContext(job);
      if (!context) return this.finish(job, 'cancelled', now, 'Connection ended or source disabled');
      if (isStopping()) return this.finish(job, 'pending', now, null, now);
      const readyAt = this.latestCooldownUntil(context.binding.bucketKey);
      if (readyAt && readyAt > now) return this.finish(job, 'pending', now, 'Destination cooldown', readyAt);
      if (context.item.contentRevision !== job.revision) return this.superseded(job, context.item, context.source, now);
      const receipt = repositories.itemDeliveries.get(job.itemId, job.bindingId);
      if (job.operation !== 'initial_post' && !receipt) return this.finish(job, 'uneditable', now, 'No original delivery receipt');
      if (receipt && receipt.appliedRevision >= job.revision) return this.finish(job, 'succeeded', now);
      if (job.operation === 'edit' && !receipt?.messageId) return this.finish(job, 'uneditable', now, 'Message ID is unknown');

      // 2. 저장된 payload를 재사용하거나, 계획 시점의 스냅샷으로 번역·렌더링한다.
      let payload: DiscordWebhookPayload;
      if (job.payload !== null) payload = JSON.parse(job.payload) as DiscordWebhookPayload;
      else {
        const source = JSON.parse(job.sourceSnapshot) as SourceRecord;
        const original = JSON.parse(job.itemSnapshot) as ItemRecord;
        const item: TranslatedItem = source.translate && this.options.translationService
          ? await this.options.translationService.translateItemForDispatch(original, source, now, { templateBody: job.templateBody, jobId: job.id })
          : original;
        const rendered = renderDiscordPayload(job.templateBody, buildPresetRenderContext(item, source, { useTranslationCache: source.translate }));
        payload = validateDiscordPayload({
          ...applySourceWebhookOptions(rendered, source, source.translate ? item.translatedTitle ?? item.title : item.title),
          username: context.destination.webhookName ?? rendered.username,
          avatar_url: context.destination.webhookAvatarUrl ?? rendered.avatar_url
        });
        if (job.operation === 'edit') {
          delete payload.thread_name;
          delete payload.applied_tags;
        }
        if (!repositories.deliveryJobs.savePayload(job, payload)) return null;
      }
      // 번역 중 연결이나 항목이 바뀔 수 있으므로 실제 전송 직전에 다시 확인한다.
      context = this.resolveActiveContext(job);
      if (!context) return this.finish(job, 'cancelled', now, 'Connection ended during preparation');
      if (context.item.contentRevision !== job.revision) return this.superseded(job, context.item, context.source, now);
      if (isStopping()) return this.finish(job, 'pending', now, null, now);
      const until = this.latestCooldownUntil(context.binding.bucketKey);
      if (until && until > now) return this.finish(job, 'pending', now, 'Destination cooldown', until);
      // 3. 요청 시작을 먼저 기록한 뒤 전송한다. 중단 후 복구 시 POST 중복 발송을 막는 기준이다.
      if (!repositories.deliveryJobs.markRequestStarted(job, now)) return null;
      requestStarted = true;
      const destination = { ...context.destination, threadId: receipt?.threadId ?? context.destination.threadId };
      const request = { destination, payload, timeoutMs: this.options.requestTimeoutMs ?? 10_000 };
      const response = job.operation === 'edit'
        ? await (this.options.editWebhook ?? editDiscordWebhookMessage)({ ...request, messageId: receipt!.messageId! })
        : await (this.options.postWebhook ?? postDiscordWebhook)({ ...request, captureMessageId: true });
      return this.commitResponse(job, response, now);
    } catch (error) {
      if (error instanceof SecurityError) return this.finish(job, 'failed', now, 'guard_blocked');
      if (!requestStarted && error instanceof DiscordPayloadValidationError) return this.finish(job, 'failed', now, 'validate');
      if (!requestStarted && error instanceof PresetRenderError) return this.finish(job, 'failed', now, 'render');
      const reason = requestStarted ? 'Network request failed or response unavailable' : 'Translation/render preparation failed';
      // POST 결과가 불명확할 때 자동 재시도하면 중복 공지가 생길 수 있다.
      // 기존 메시지를 수정하는 PATCH만 자동 재시도한다.
      if (requestStarted && job.operation !== 'edit') return this.finish(job, 'unknown', now, reason);
      if (requestStarted) return this.retry(job, now, reason);
      return this.finish(job, 'failed', now, reason);
    }
  }

  private latestCooldownUntil(bucketKey: string): string | undefined {
    const jobs = this.options.repositories.deliveryJobs;
    const destinationCooldown = jobs.cooldownUntil(bucketKey);
    const globalCooldown = jobs.cooldownUntil('__discord_global__');
    return [destinationCooldown, globalCooldown]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1);
  }

  private resolveActiveContext(job: DeliveryJobRecord) {
    const repositories = this.options.repositories;
    const binding = repositories.deliveryBindings.getById(job.bindingId);
    const item = repositories.items.getById(job.itemId);
    const source = item ? repositories.sources.getById(item.sourceId) : null;
    if (!binding || binding.endedAt !== null || !item || !source?.enabled) return null;
    const destination = resolveDestinationsForSource(source, repositories).find((value) => value.destinationKey === binding.destinationKey);
    return destination ? {
      binding,
      item,
      source,
      destination
    } : null;
  }

  private superseded(job: DeliveryJobRecord, item: ItemRecord, source: SourceRecord, now: string): DeliveryRunResult {
    if (job.operation === 'initial_post') {
      this.options.repositories.deliveryJobs.refreshInitial(job, item, source);
      return {
        itemId: job.itemId,
        jobId: job.id,
        outcome: 'retrying',
        attemptNo: job.attemptCount,
        nextAttemptAt: now
      };
    }
    const result = this.finish(job, 'cancelled', now, 'Superseded revision');
    this.options.planner.planUpdate(item, source, now);
    return result;
  }

  private commitResponse(job: DeliveryJobRecord, response: WebhookPostResponse, now: string): DeliveryRunResult {
    const repositories = this.options.repositories;
    const binding = repositories.deliveryBindings.getById(job.bindingId);
    if (binding && response.cooldownMs) repositories.deliveryJobs.cooldown(binding.bucketKey, new Date(Date.parse(now) + response.cooldownMs).toISOString());
    if (response.statusCode === 429) {
      const until = new Date(Date.parse(now) + Math.max(1000, response.retryAfterMs ?? 1000)).toISOString();
      if (binding) repositories.deliveryJobs.cooldown(binding.bucketKey, until);
      if (response.globalRateLimit) repositories.deliveryJobs.cooldown('__discord_global__', until);
      return this.finish(job, 'pending', now, 'rate_limited', until, job.attemptCount, 429);
    }
    if (response.statusCode >= 500) {
      if (job.operation === 'edit') return this.retry(job, now, 'network');
      return this.finish(job, 'unknown', now, 'POST server result is unknown');
    }
    if (response.statusCode === 404 && job.operation === 'edit') return this.finish(job, 'uneditable', now, 'Message no longer exists', null, job.attemptCount, 404);
    if (response.statusCode < 200 || response.statusCode >= 300) return this.finish(job, 'failed', now, 'webhook_rejected', null, job.attemptCount, response.statusCode);
    const prior = repositories.itemDeliveries.get(job.itemId, job.bindingId);
    const messageId = response.messageId ?? (job.operation === 'edit' ? prior?.messageId : null);
    if (!messageId) return this.finish(job, 'unknown', now, 'POST succeeded but message ID is unavailable');
    return this.options.db.transaction(() => {
      if (!repositories.deliveryJobs.finish(job, 'succeeded', now)) return this.result(job, 'skipped');
      repositories.itemDeliveries.save({
        itemId: job.itemId,
        bindingId: job.bindingId,
        messageId,
        channelId: response.channelId ?? prior?.channelId ?? null,
        threadId: response.threadId ?? prior?.threadId ?? null,
        appliedRevision: job.revision,
        firstDeliveredAt: prior?.firstDeliveredAt ?? now
      });
      repositories.eventLog.append({
        kind: 'delivery',
        status: 'success',
        itemId: job.itemId,
        jobId: job.id,
        httpStatus: response.statusCode,
        detail: deliveryLabel(job, binding?.label),
        createdAt: now
      });
      const latest = repositories.items.getById(job.itemId);
      const source = latest ? repositories.sources.getById(latest.sourceId) : null;
      if (latest && source && latest.contentRevision > job.revision) this.options.planner.planUpdate(latest, source, now);
      return this.result(job, 'delivered');
    })();
  }

  private retry(job: DeliveryJobRecord, now: string, error: string): DeliveryRunResult {
    const failures = job.attemptCount + 1;
    return failures >= 5 ? this.finish(job, 'failed', now, 'max_retries', null, failures)
      : this.finish(job, 'pending', now, error, retryAt(now, failures), failures);
  }

  private finish(
    job: DeliveryJobRecord,
    state: DeliveryJobState,
    now: string,
    error: string | null = null,
    next: string | null = null,
    attempts = job.attemptCount,
    httpStatus: number | null = null
  ): DeliveryRunResult {
    const repositories = this.options.repositories;
    return this.options.db.transaction(() => {
      const saved = repositories.deliveryJobs.finish(job, state, now, error, next, attempts);
      if (saved && (['failed', 'unknown', 'uneditable'].includes(state) || error === 'rate_limited')) {
        // 오류 값이 곧 사유 코드다(render·validate·guard_blocked·rate_limited·max_retries·webhook_rejected 등).
        // 관리자 검토가 필요한 상태는 앞에 붙여 구분한다.
        const binding = repositories.deliveryBindings.getById(job.bindingId);
        const prefix = state === 'unknown' || state === 'uneditable' ? `${state}: ` : '';
        repositories.eventLog.append({
          kind: 'delivery',
          status: 'failed',
          itemId: job.itemId,
          jobId: job.id,
          httpStatus,
          detail: `${prefix}${error ?? state} (${deliveryLabel(job, binding?.label)})`,
          createdAt: now
        });
      }
      const outcome = runOutcome(state, saved);
      return { ...this.result(job, outcome), failureReason: error ?? undefined, nextAttemptAt: next };
    })();
  }

  private result(job: DeliveryJobRecord, outcome: DeliveryRunOutcome): DeliveryRunResult {
    return {
      itemId: job.itemId,
      jobId: job.id,
      outcome,
      attemptNo: job.attemptCount + 1
    };
  }
}

const OPERATION_LABELS: Record<DeliveryJobRecord['operation'], string> = {
  initial_post: '발송',
  edit: '수정',
  update_post: '변경 발송'
};

function deliveryLabel(job: DeliveryJobRecord, destination: string | undefined): string {
  return `${OPERATION_LABELS[job.operation]} → ${destination || '연결 없음'}`;
}

function runOutcome(state: DeliveryJobState, saved: boolean): DeliveryRunOutcome {
  // 소유권을 잃어 저장하지 못한 실행은 발송 결과를 확정한 것으로 처리하지 않는다.
  if (!saved || state === 'cancelled') return 'skipped';
  if (state === 'succeeded') return 'delivered';
  if (state === 'pending') return 'retrying';
  return state as DeliveryRunOutcome;
}
