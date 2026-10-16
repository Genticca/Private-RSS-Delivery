import type Database from 'better-sqlite3';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import type { DeliveryBindingRepository, DeliveryJobRecord, DeliveryJobRepository, DeliveryLogRepository, GroupRepository, ItemDeliveryRepository, ItemRecord, ItemRepository, SourceGroupRepository, SourceRecord, SourceRepository } from '../db/index.js';
import type { DeliveryFailureReason } from '../db/delivery-log.repository.js';
import { nowIso } from '../db/time.js';
import { retryAt, type DeliveryJobState } from '../domain/delivery/policy.js';
import { applySourceWebhookOptions } from '../dispatcher/payload-options.js';
import { buildPresetRenderContext, PresetRenderError, renderDiscordPayload } from '../dispatcher/render.js';
import { resolveDestinationsForSource } from '../dispatcher/resolve-destinations.js';
import { DiscordPayloadValidationError, validateDiscordPayload } from '../dispatcher/validate.js';
import { SecurityError } from '../security/errors.js';
import { editDiscordWebhookMessage, postDiscordWebhook, type WebhookEditFunction, type WebhookPostFunction, type WebhookPostResponse } from '../dispatcher/discord-client.js';
import type { DispatchTranslationService } from '../translator/translator.js';
import type { DeliveryPlanService } from './delivery-plan.service.js';

export interface DeliveryRepositories {
  items: ItemRepository; sources: SourceRepository; groups: GroupRepository; sourceGroups: SourceGroupRepository;
  deliveryBindings: DeliveryBindingRepository; deliveryJobs: DeliveryJobRepository; itemDeliveries: ItemDeliveryRepository; deliveryLogs: DeliveryLogRepository;
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
export interface DeliveryRunResult { itemId: number; jobId: number; outcome: DeliveryRunOutcome; attemptNo: number | null; failureReason?: string; nextAttemptAt?: string | null; }

export class DeliveryService {
  constructor(private readonly options: DeliveryServiceOptions) {}

  async processJob(id: number, now = nowIso(), isStopping: () => boolean = () => false): Promise<DeliveryRunResult | null> {
    const { repositories: r } = this.options;
    const job = r.deliveryJobs.claim(id);
    if (!job) return null;
    let sent = false;
    try {
      let context = this.context(job);
      if (!context) return this.finish(job, 'cancelled', now, 'Connection ended or source disabled');
      if (isStopping()) return this.finish(job, 'pending', now, null, now);
      const readyAt = [r.deliveryJobs.cooldownUntil(context.binding.bucketKey), r.deliveryJobs.cooldownUntil('__discord_global__')]
        .filter((value): value is string => value !== null).sort().at(-1);
      if (readyAt && readyAt > now) return this.finish(job, 'pending', now, 'Destination cooldown', readyAt);
      if (context.item.contentRevision !== job.revision) return this.superseded(job, context.item, context.source, now);
      const receipt = r.itemDeliveries.get(job.itemId, job.bindingId!);
      if (job.operation !== 'initial_post' && !receipt) return this.finish(job, 'uneditable', now, 'No original delivery receipt');
      if (receipt && receipt.appliedRevision >= job.revision) return this.finish(job, 'succeeded', now);
      if (job.operation === 'edit' && !receipt?.messageId) return this.finish(job, 'uneditable', now, 'Message ID is unknown');

      let payload: DiscordWebhookPayload;
      if (job.payload !== null) payload = JSON.parse(job.payload) as DiscordWebhookPayload;
      else {
        const source = JSON.parse(job.sourceSnapshot) as SourceRecord;
        const original = JSON.parse(job.itemSnapshot) as ItemRecord;
        const item = source.translate && this.options.translationService
          ? await this.options.translationService.translateItemForDispatch(original, source, now, { templateBody: job.templateBody, jobId: job.id })
          : original;
        const rendered = renderDiscordPayload(job.templateBody, buildPresetRenderContext(item, source, { useTranslationCache: source.translate }));
        payload = validateDiscordPayload({
          ...applySourceWebhookOptions(rendered, source, source.translate ? item.translatedTitle ?? item.title : item.title),
          username: context.destination.webhookName ?? rendered.username,
          avatar_url: context.destination.webhookAvatarUrl ?? rendered.avatar_url
        });
        if (job.operation === 'edit') { delete payload.thread_name; delete payload.applied_tags; }
        if (!r.deliveryJobs.savePayload(job, payload)) return null;
      }
      context = this.context(job);
      if (!context) return this.finish(job, 'cancelled', now, 'Connection ended during preparation');
      if (context.item.contentRevision !== job.revision) return this.superseded(job, context.item, context.source, now);
      if (isStopping()) return this.finish(job, 'pending', now, null, now);
      const cooldown = r.deliveryJobs.cooldownUntil(context.binding.bucketKey);
      const globalCooldown = r.deliveryJobs.cooldownUntil('__discord_global__');
      const until = [cooldown, globalCooldown].filter((value): value is string => value !== null).sort().at(-1);
      if (until && until > now) return this.finish(job, 'pending', now, 'Destination cooldown', until);
      if (!r.deliveryJobs.markRequestStarted(job, now)) return null;
      sent = true;
      const destination = { ...context.destination, threadId: receipt?.threadId ?? context.destination.threadId };
      const request = { destination, payload, timeoutMs: this.options.requestTimeoutMs ?? 10_000 };
      const response = job.operation === 'edit'
        ? await (this.options.editWebhook ?? editDiscordWebhookMessage)({ ...request, messageId: receipt!.messageId! })
        : await (this.options.postWebhook ?? postDiscordWebhook)({ ...request, captureMessageId: true });
      return this.commitResponse(job, payload, response, now);
    } catch (error) {
      if (error instanceof SecurityError) return this.finish(job, 'failed', now, 'guard_blocked');
      if (!sent && error instanceof DiscordPayloadValidationError) return this.finish(job, 'failed', now, 'validate');
      if (!sent && error instanceof PresetRenderError) return this.finish(job, 'failed', now, 'render');
      const reason = sent ? 'Network request failed or response unavailable' : 'Translation/render preparation failed';
      if (sent && job.operation !== 'edit') return this.finish(job, 'unknown', now, reason);
      if (sent) return this.retry(job, now, reason);
      return this.finish(job, 'failed', now, reason);
    }
  }

  private context(job: DeliveryJobRecord) {
    const r = this.options.repositories;
    const binding = job.bindingId === null ? null : r.deliveryBindings.getById(job.bindingId);
    const item = r.items.getById(job.itemId);
    const source = item ? r.sources.getById(item.sourceId) : null;
    if (!binding || binding.endedAt !== null || !item || !source?.enabled) return null;
    const destination = resolveDestinationsForSource(source, r).find((value) => value.destinationKey === binding.destinationKey);
    return destination ? { binding, item, source, destination } : null;
  }

  private superseded(job: DeliveryJobRecord, item: ItemRecord, source: SourceRecord, now: string): DeliveryRunResult {
    if (job.operation === 'initial_post') {
      this.options.repositories.deliveryJobs.refreshInitial(job, item, source);
      return { itemId: job.itemId, jobId: job.id, outcome: 'retrying', attemptNo: job.attemptCount, nextAttemptAt: now };
    }
    const result = this.finish(job, 'cancelled', now, 'Superseded revision');
    this.options.planner.planUpdate(item, source, now);
    return result;
  }

  private commitResponse(job: DeliveryJobRecord, payload: DiscordWebhookPayload, response: WebhookPostResponse, now: string): DeliveryRunResult {
    const r = this.options.repositories;
    const binding = r.deliveryBindings.getById(job.bindingId!);
    if (binding && response.cooldownMs) r.deliveryJobs.cooldown(binding.bucketKey, new Date(Date.parse(now) + response.cooldownMs).toISOString());
    if (response.statusCode === 429) {
      const until = new Date(Date.parse(now) + Math.max(1000, response.retryAfterMs ?? 1000)).toISOString();
      if (binding) r.deliveryJobs.cooldown(binding.bucketKey, until);
      if (response.globalRateLimit) r.deliveryJobs.cooldown('__discord_global__', until);
      return this.finish(job, 'pending', now, 'rate_limited', until, job.attemptCount, 429);
    }
    if (response.statusCode >= 500) return job.operation === 'edit' ? this.retry(job, now, 'network') : this.finish(job, 'unknown', now, 'POST server result is unknown');
    if (response.statusCode === 404 && job.operation === 'edit') return this.finish(job, 'uneditable', now, 'Message no longer exists', null, job.attemptCount, 404);
    if (response.statusCode < 200 || response.statusCode >= 300) return this.finish(job, 'failed', now, 'webhook_rejected', null, job.attemptCount, response.statusCode);
    const prior = r.itemDeliveries.get(job.itemId, job.bindingId!);
    const messageId = response.messageId ?? (job.operation === 'edit' ? prior?.messageId : null);
    if (!messageId) return this.finish(job, 'unknown', now, 'POST succeeded but message ID is unavailable');
    return this.options.db.transaction(() => {
      if (!r.deliveryJobs.finish(job, 'succeeded', now)) return this.result(job, 'skipped');
      r.itemDeliveries.save({ itemId: job.itemId, bindingId: job.bindingId!, messageId,
        channelId: response.channelId ?? prior?.channelId ?? null, threadId: response.threadId ?? prior?.threadId ?? null,
        appliedRevision: job.revision, firstDeliveredAt: prior?.firstDeliveredAt ?? now });
      r.deliveryLogs.append({ itemId: job.itemId, attemptNo: job.attemptCount + 1, status: 'success', httpStatus: response.statusCode,
        renderedBytes: Buffer.byteLength(JSON.stringify(payload)), destinationKey: binding?.destinationKey ?? null,
        contentHash: (JSON.parse(job.itemSnapshot) as ItemRecord).contentHash, discordMessageId: messageId, createdAt: now });
      const latest = r.items.getById(job.itemId);
      const source = latest ? r.sources.getById(latest.sourceId) : null;
      if (latest && source && latest.contentRevision > job.revision) this.options.planner.planUpdate(latest, source, now);
      r.deliveryJobs.syncItemState(job.itemId, now);
      return this.result(job, 'delivered');
    })();
  }

  private retry(job: DeliveryJobRecord, now: string, error: string): DeliveryRunResult {
    const failures = job.attemptCount + 1;
    return failures >= 5 ? this.finish(job, 'failed', now, 'max_retries', null, failures)
      : this.finish(job, 'pending', now, error, retryAt(now, failures), failures);
  }

  private finish(job: DeliveryJobRecord, state: DeliveryJobState, now: string, error: string | null = null, next: string | null = null, attempts = job.attemptCount, httpStatus: number | null = null): DeliveryRunResult {
    const r = this.options.repositories;
    return this.options.db.transaction(() => {
      const saved = r.deliveryJobs.finish(job, state, now, error, next, attempts);
      if (saved && (['failed', 'unknown', 'uneditable'].includes(state) || error === 'rate_limited')) {
        const binding = job.bindingId ? r.deliveryBindings.getById(job.bindingId) : null;
        r.deliveryLogs.append({ itemId: job.itemId, attemptNo: attempts + 1, status: 'failed', destinationKey: binding?.destinationKey ?? null,
          failureReason: (state === 'unknown' ? 'unknown' : ['render', 'validate', 'guard_blocked', 'rate_limited', 'max_retries'].includes(error ?? '') ? error : 'webhook_rejected') as DeliveryFailureReason,
          httpStatus,
          error, createdAt: now });
      }
      if (saved) r.deliveryJobs.syncItemState(job.itemId, now);
      const outcome: DeliveryRunOutcome = !saved ? 'skipped' : state === 'succeeded' ? 'delivered' : state === 'pending' ? 'retrying' : state === 'cancelled' ? 'skipped' : state as DeliveryRunOutcome;
      return { ...this.result(job, outcome), failureReason: error ?? undefined, nextAttemptAt: next };
    })();
  }

  private result(job: DeliveryJobRecord, outcome: DeliveryRunOutcome): DeliveryRunResult {
    return { itemId: job.itemId, jobId: job.id, outcome, attemptNo: job.attemptCount + 1 };
  }
}
