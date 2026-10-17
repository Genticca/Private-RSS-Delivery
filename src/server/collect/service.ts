import type Database from 'better-sqlite3';
import type { SourceRecord, SourceRepository, SourceGroupRepository } from '../sources/repository.js';
import { parseFeed, type NormalizedItem, type Profile } from '../feed/parse.js';
import type { ItemRepository } from '../feed/repository.js';
import type { EventLogRepository } from '../logs/repository.js';
import type { GroupRepository } from '../groups/repository.js';
import type { DeliveryBindingRepository } from '../delivery/repository.js';
import { resolveDestinationsForSource, type DeliveryBindingService } from '../delivery/bindings.js';
import { shouldHoldNewItems, type DeliveryPlanService } from '../delivery/plan.js';
import { fetchFeed, type FeedFetchSource, type FetchFeedOptions, type FeedFetchResult } from '../net/fetch.js';
import { nowIso } from '../core/db.js';
import { SecurityError } from '../core/errors.js';
import { detectProfile, effectiveProfile, normalize } from '../feed/normalize.js';

export function shouldQueueNewItem(source: SourceRecord, item: NormalizedItem): boolean {
  // 첫 수집은 과거 항목의 기준점만 만든다. 기존 공지가 한꺼번에 발송되는 것을 막는다.
  if (!source.initialized) return false;
  // 발행 시각이 없으면 과거 항목인지 판별할 수 없으므로 초기화 이후에는 발송한다.
  if (!item.publishedAt) return true;
  if (!source.deliveryCutoffAt) return true;
  return item.publishedAt >= source.deliveryCutoffAt;
}

export interface PollCounts {
  itemsNew: number;
  itemsHistorical: number;
  itemsChanged: number;
  itemsSkipped: number;
}

export type PollOutcome = '200' | '304' | 'error' | 'skipped';

export interface PollSourceResult extends PollCounts {
  sourceId: string;
  outcome: PollOutcome;
  httpStatus: number | null;
  error?: string;
  detectedProfile?: Profile;
}

export interface PollServiceOptions {
  db: Database.Database;
  repositories: {
    sources: SourceRepository;
    items: ItemRepository;
    eventLog: EventLogRepository;
    groups: GroupRepository;
    sourceGroups: SourceGroupRepository;
    deliveryBindings: DeliveryBindingRepository
  };
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
  constructor(private readonly options: PollServiceOptions) { }

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
    // 새 연결은 전체 피드로 기준점을 만들어야 하므로 조건부 GET을 사용하지 않는다.
    const needsBaseline = repositories.deliveryBindings.listActive(sourceId).some((binding) => binding.baselineAt === null);
    const started = Date.now();
    try {
      const result = await (this.options.fetchFeed ?? fetchFeed)({
        id: sourceId,
        feedUrl: source.feedUrl,
        fetchOptions: source.fetchOptions,
        etag: needsBaseline ? null : source.etag,
        lastModified: needsBaseline ? null : source.lastModified
      }, this.options.fetchOptions);
      return db.transaction(() => {
        const current = repositories.sources.getById(sourceId);
        // 네트워크 응답을 기다리는 동안 설정이 바뀌면 이전 설정으로 받은 결과를 버린다.
        if (!current || current.configRevision !== original.configRevision || !current.enabled) return emptyResult(sourceId);
        if (result.persistedFetchOptions) repositories.sources.update(sourceId, { fetchOptions: result.persistedFetchOptions });
        if (result.permanentUrl && result.permanentUrl !== current.feedUrl && !repositories.sources.findByFeedUrl(result.permanentUrl)) {
          repositories.sources.update(sourceId, { feedUrl: result.permanentUrl });
        }
        if (result.kind === 'not-modified') {
          repositories.sources.markPolled(sourceId, polledAt, { etag: result.etag, lastModified: result.lastModified });
          db.prepare('UPDATE sources SET consecutive_failures = 0 WHERE id = ?').run(sourceId);
          repositories.eventLog.append({
            kind: 'fetch',
            status: 'not_modified',
            sourceId,
            httpStatus: 304,
            durationMs: Date.now() - started,
            createdAt: polledAt
          });
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
        repositories.eventLog.append({
          kind: 'fetch',
          status: 'error',
          sourceId,
          httpStatus: status,
          durationMs: Date.now() - started,
          detail: message,
          createdAt: polledAt
        });
        return {
          ...emptyResult(sourceId),
          outcome: 'error' as const,
          httpStatus: status,
          error: message
        };
      })();
    }
  }

  private commitSnapshot(source: SourceRecord, result: Extract<FeedFetchResult, {
    kind: 'ok'
  }>, now: string, durationMs: number): PollSourceResult {
    const { db, repositories, planner, bindings } = this.options;
    const envelopes = parseFeed(result.body);
    const detectedProfile = source.detectedProfile ?? (envelopes.length ? detectProfile(result.body, envelopes) : null);
    const profile = effectiveProfile(source.profileSetting, detectedProfile);
    const items = envelopes.map((envelope) => normalize(profile, envelope));
    const counts: PollCounts = {
      itemsNew: 0,
      itemsHistorical: 0,
      itemsChanged: 0,
      itemsSkipped: 0
    };
    const hasReadyBinding = repositories.deliveryBindings.listActive(source.id).some((binding) => binding.baselineAt !== null);
    const canQueueItem = (item: NormalizedItem): boolean =>
      source.initialized && hasReadyBinding && shouldQueueNewItem(source, item);
    const candidates = items.filter((item) =>
      !repositories.items.findByAtomId(source.id, item.atomId) && canQueueItem(item));
    // 대량 유입은 자동 발송하지 않고 관리자가 검토할 수 있도록 보류한다.
    const held = shouldHoldNewItems(candidates.length, items.length, {
      holdCount: this.options.holdCount ?? 50, holdMinItems: this.options.holdMinItems ?? 10, holdRatio: this.options.holdRatio ?? 0.8
    });
    for (const item of items) {
      const existing = repositories.items.findByAtomId(source.id, item.atomId);
      const fields = contentFields(item);
      if (!existing) {
        const queue = canQueueItem(item);
        const inserted = repositories.items.insert({
          ...fields,
          sourceId: source.id,
          atomId: item.atomId,
          historical: !queue,
          createdAt: now
        });
        if (queue) {
          counts.itemsNew++;
          planner.planNew(inserted, source, now, held);
        } else {
          counts.itemsHistorical++;
        }
        db.prepare('UPDATE items SET last_seen_at = ? WHERE id = ?').run(now, inserted.id);
      } else {
        const changed = existing.contentHash !== item.contentHash;
        const displayChanged = Object.entries(fields).some(([key, value]) => (existing[key as keyof typeof fields] ?? null) !== (value ?? null));
        const needsContentRefresh = changed || displayChanged || existing.contentPruned;
        const updated = needsContentRefresh
          ? repositories.items.updateContentHash(existing.id, fields)
          : existing;
        db.prepare('UPDATE items SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
        // 표시 필드 복원만으로는 재발송하지 않는다. 내용 해시가 달라진 경우만 계획한다.
        if (changed) {
          counts.itemsChanged++;
          planner.planUpdate(updated, source, now);
        } else {
          counts.itemsSkipped++;
        }
      }
    }
    // 현재 스냅샷을 모두 저장한 뒤 기준점을 확정해 이번 과거 항목이 발송되지 않게 한다.
    bindings.completeBaselines(source.id, now);
    repositories.sources.markPolled(source.id, now, {
      initialized: true,
      etag: result.etag,
      lastModified: result.lastModified,
      detectedProfile: detectedProfile ?? undefined
    });
    db.prepare('UPDATE sources SET consecutive_failures = 0 WHERE id = ?').run(source.id);
    repositories.eventLog.append({
      kind: 'fetch',
      status: 'ok',
      sourceId: source.id,
      httpStatus: result.statusCode,
      durationMs,
      itemCount: counts.itemsNew,
      detail: `변경 ${counts.itemsChanged}건 · 과거 ${counts.itemsHistorical}건`,
      createdAt: now
    });
    return {
      sourceId: source.id,
      outcome: '200',
      httpStatus: result.statusCode,
      ...counts,
      detectedProfile: detectedProfile ?? undefined
    };
  }
}

function contentFields(item: NormalizedItem) {
  return {
    title: item.title,
    link: item.link,
    summary: item.summary,
    contentHash: item.contentHash,
    incidentStage: item.incidentStage,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    author: item.author,
    commentsUrl: item.commentsUrl,
    image: item.image
  };
}

export function emptyResult(sourceId: string): PollSourceResult {
  return {
    sourceId,
    outcome: 'skipped',
    httpStatus: null,
    itemsNew: 0,
    itemsHistorical: 0,
    itemsChanged: 0,
    itemsSkipped: 0
  };
}
