import type Database from 'better-sqlite3';
import type { DeliveryBindingRepository, FetchLogRepository, GroupRepository, ItemRepository, SourceGroupRepository, SourceRecord, SourceRepository } from '../db/index.js';
import { nowIso } from '../db/time.js';
import { parseFeed } from '../domain/envelope/index.js';
import { detectProfile, effectiveProfile, normalize } from '../domain/normalize/index.js';
import type { NormalizedItem, Profile } from '../domain/normalize/types.js';
import { shouldHoldNewItems } from '../domain/delivery/policy.js';
import { resolveDestinationsForSource } from '../dispatcher/resolve-destinations.js';
import { fetchFeed, SecurityError, type FeedFetchResult, type FeedFetchSource, type FetchFeedOptions } from '../security/index.js';
import { shouldQueueNewItem } from '../domain/delivery/cutoff.js';
import type { DeliveryBindingService } from './delivery-binding.service.js';
import type { DeliveryPlanService } from './delivery-plan.service.js';

export interface PollCounts { itemsNew: number; itemsHistorical: number; itemsChanged: number; itemsSkipped: number; }
export type PollOutcome = '200' | '304' | 'error' | 'skipped';
export interface PollSourceResult extends PollCounts { sourceId: string; outcome: PollOutcome; httpStatus: number | null; error?: string; detectedProfile?: Profile; }
export interface PollServiceOptions {
  db: Database.Database;
  repositories: { sources: SourceRepository; items: ItemRepository; fetchLogs: FetchLogRepository; groups: GroupRepository; sourceGroups: SourceGroupRepository; deliveryBindings: DeliveryBindingRepository };
  bindings: DeliveryBindingService;
  planner: DeliveryPlanService;
  fetchFeed?: (source: FeedFetchSource, options?: FetchFeedOptions) => Promise<FeedFetchResult>;
  fetchOptions?: FetchFeedOptions;
  holdCount?: number;
  holdRatio?: number;
  holdMinItems?: number;
  isStopping?: () => boolean;
}

export class PollService {
  constructor(private readonly options: PollServiceOptions) {}

  async poll(sourceId: string, polledAt = nowIso()): Promise<PollSourceResult> {
    const { db, repositories, bindings } = this.options;
    if (this.options.isStopping?.()) return emptyResult(sourceId);
    bindings.reconcile(sourceId, polledAt);
    let source = repositories.sources.getById(sourceId);
    if (!source || !source.enabled) return emptyResult(sourceId);
    if (resolveDestinationsForSource(source, repositories).length === 0) {
      repositories.sources.markPolled(sourceId, polledAt);
      return emptyResult(sourceId);
    }
    source = repositories.sources.claimPollStarted(sourceId, polledAt);
    const original = source;
    const needsBaseline = repositories.deliveryBindings.listActive(sourceId).some((binding) => binding.baselineAt === null);
    const started = Date.now();
    try {
      const result = await (this.options.fetchFeed ?? fetchFeed)({
        id: sourceId, feedUrl: source.feedUrl, fetchOptions: source.fetchOptions,
        etag: needsBaseline ? null : source.etag, lastModified: needsBaseline ? null : source.lastModified
      }, this.options.fetchOptions);
      return db.transaction(() => {
        const current = repositories.sources.getById(sourceId);
        if (!current || current.configRevision !== original.configRevision || !current.enabled) return emptyResult(sourceId);
        if (result.persistedFetchOptions) repositories.sources.update(sourceId, { fetchOptions: result.persistedFetchOptions });
        if (result.permanentUrl && result.permanentUrl !== current.feedUrl && !repositories.sources.findByFeedUrl(result.permanentUrl)) {
          repositories.sources.update(sourceId, { feedUrl: result.permanentUrl });
        }
        if (result.kind === 'not-modified') {
          repositories.sources.markPolled(sourceId, polledAt, { etag: result.etag, lastModified: result.lastModified });
          db.prepare('UPDATE sources SET consecutive_failures = 0 WHERE id = ?').run(sourceId);
          repositories.fetchLogs.append({ sourceId, outcome: '304', httpStatus: 304, durationMs: Date.now() - started, createdAt: polledAt });
          return { ...emptyResult(sourceId), outcome: '304' as const, httpStatus: 304 };
        }
        return this.commitSnapshot(current, result, polledAt, Date.now() - started);
      })();
    } catch (error) {
      return db.transaction(() => {
        const current = repositories.sources.getById(sourceId);
        if (!current || current.configRevision !== original.configRevision) return emptyResult(sourceId);
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof SecurityError && typeof error.details.statusCode === 'number' ? error.details.statusCode : null;
        const failures = current.consecutiveFailures + 1;
        const delay = Math.min(86_400_000, current.pollIntervalSeconds * 1000 * 2 ** Math.min(failures - 1, 8));
        db.prepare('UPDATE sources SET consecutive_failures = ?, last_polled_at = ?, next_poll_at = ? WHERE id = ?')
          .run(failures, polledAt, new Date(Date.parse(polledAt) + delay).toISOString(), sourceId);
        repositories.fetchLogs.append({ sourceId, outcome: 'error', httpStatus: status, durationMs: Date.now() - started, error: message, createdAt: polledAt });
        return { ...emptyResult(sourceId), outcome: 'error' as const, httpStatus: status, error: message };
      })();
    }
  }

  private commitSnapshot(source: SourceRecord, result: Extract<FeedFetchResult, { kind: 'ok' }>, now: string, durationMs: number): PollSourceResult {
    const { db, repositories, planner, bindings } = this.options;
    const envelopes = parseFeed(result.body);
    const detectedProfile = source.detectedProfile ?? (envelopes.length ? detectProfile(result.body, envelopes) : null);
    const profile = effectiveProfile(source.profileSetting, detectedProfile);
    const items = envelopes.map((envelope) => normalize(profile, envelope));
    const counts: PollCounts = { itemsNew: 0, itemsHistorical: 0, itemsChanged: 0, itemsSkipped: 0 };
    const hasReadyBinding = repositories.deliveryBindings.listActive(source.id).some((binding) => binding.baselineAt !== null);
    const candidates = items.filter((item) => !repositories.items.findByAtomId(source.id, item.atomId) && source.initialized && hasReadyBinding && shouldQueueNewItem(source, item));
    const held = shouldHoldNewItems(candidates.length, items.length, {
      holdCount: this.options.holdCount ?? 50, holdMinItems: this.options.holdMinItems ?? 10, holdRatio: this.options.holdRatio ?? 0.8
    });
    for (const item of items) {
      const existing = repositories.items.findByAtomId(source.id, item.atomId);
      const fields = contentFields(item);
      if (!existing) {
        const queue = source.initialized && hasReadyBinding && shouldQueueNewItem(source, item);
        const inserted = repositories.items.insert({ ...fields, sourceId: source.id, atomId: item.atomId,
          deliveryStatus: queue ? 'pending' : 'historical', nextAttemptAt: queue && !held ? now : null, createdAt: now });
        if (queue) { counts.itemsNew++; planner.planNew(inserted, source, now, held); }
        else counts.itemsHistorical++;
        db.prepare('UPDATE items SET last_seen_at = ? WHERE id = ?').run(now, inserted.id);
      } else {
        const changed = existing.contentHash !== item.contentHash;
        const displayChanged = Object.entries(fields).some(([key, value]) => (existing[key as keyof typeof fields] ?? null) !== (value ?? null));
        const updated = changed || displayChanged || existing.contentPruned ? repositories.items.updateContentHash(existing.id, fields) : existing;
        db.prepare('UPDATE items SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
        if (changed) { counts.itemsChanged++; planner.planUpdate(updated, source, now); }
        else counts.itemsSkipped++;
      }
    }
    bindings.completeBaselines(source.id, now);
    repositories.sources.markPolled(source.id, now, { initialized: true, etag: result.etag, lastModified: result.lastModified, detectedProfile: detectedProfile ?? undefined });
    db.prepare('UPDATE sources SET consecutive_failures = 0 WHERE id = ?').run(source.id);
    repositories.fetchLogs.append({ sourceId: source.id, outcome: '200', httpStatus: result.statusCode, ...counts, durationMs, createdAt: now });
    return { sourceId: source.id, outcome: '200', httpStatus: result.statusCode, ...counts, detectedProfile: detectedProfile ?? undefined };
  }
}

function contentFields(item: NormalizedItem) {
  return { title: item.title, link: item.link, summary: item.summary, contentHash: item.contentHash, incidentStage: item.incidentStage,
    publishedAt: item.publishedAt, updatedAt: item.updatedAt, author: item.author, commentsUrl: item.commentsUrl, image: item.image };
}

export function emptyResult(sourceId: string): PollSourceResult {
  return { sourceId, outcome: 'skipped', httpStatus: null, itemsNew: 0, itemsHistorical: 0, itemsChanged: 0, itemsSkipped: 0 };
}
