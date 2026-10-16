import type Database from 'better-sqlite3';
import { resolveDestinationsForSource } from '../dispatcher/resolve-destinations.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import type { SourceRecord } from '../db/source.repository.js';
import type { CreateItemInput, ItemRecord, UpdateContentHashInput } from '../db/item.repository.js';
import { nowIso } from '../db/time.js';
import { parseFeed } from '../domain/envelope/index.js';
import { detectProfile, effectiveProfile, normalize } from '../domain/normalize/index.js';
import type { NormalizedItem, Profile } from '../domain/normalize/types.js';
import {
  SecurityError,
  fetchFeed,
  type FeedFetchResult,
  type FeedFetchSource,
  type FetchFeedOptions
} from '../security/index.js';
import { classifyExistingItem } from './change-detect.js';
import { shouldQueueNewItem } from './cutoff.js';

export interface DeliveryRunner {
  runDueDeliveries(now?: string): Promise<unknown>;
}

export interface PollerOptions {
  db: Database.Database;
  repositories: RepositoryRegistry;
  deliveryRunner?: DeliveryRunner;
  fetchFeed?: (source: FeedFetchSource, options?: FetchFeedOptions) => Promise<FeedFetchResult>;
  fetchOptions?: FetchFeedOptions;
  now?: () => string;
  tickIntervalMs?: number;
  dueLimit?: number;
  onError?: (error: unknown) => void;
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

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_DUE_LIMIT = 50;

export class Poller {
  private readonly inFlightSources = new Set<string>();
  private runningTick: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PollerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runDuePolls().catch((error: unknown) => this.reportError(error));
    }, this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runDuePolls(now = this.now()): Promise<PollSourceResult[]> {
    if (this.runningTick) return [];
    const tick = this.runDuePollsInternal(now);
    this.runningTick = tick.then(
      () => undefined,
      () => undefined
    );
    try {
      return await tick;
    } finally {
      this.runningTick = null;
    }
  }

  async triggerPoll(sourceId: string, now = this.now()): Promise<PollSourceResult> {
    const source = this.options.repositories.sources.getById(sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);
    return this.pollSource(source, now);
  }

  async pollSource(source: SourceRecord, now = this.now()): Promise<PollSourceResult> {
    if (this.inFlightSources.has(source.id)) {
      return emptyResult(source.id, 'skipped');
    }
    if (!this.hasDeliveryDestination(source)) {
      return emptyResult(source.id, 'skipped');
    }

    this.inFlightSources.add(source.id);
    const startedAt = now;
    const startedMs = Date.parse(startedAt);
    let claimed = source;

    try {
      claimed = this.options.repositories.sources.claimPollStarted(source.id, startedAt);
      const result = await this.fetchFeedForSource(claimed);
      const durationMs = durationSince(startedMs);

      if (result.kind === 'not-modified') {
        this.commitNotModified(claimed, result, startedAt, durationMs);
        return {
          ...emptyCounts(),
          sourceId: source.id,
          outcome: '304',
          httpStatus: 304
        };
      }

      const processed = this.processSuccessfulFetch(claimed, result, startedAt, durationMs);
      return processed;
    } catch (error) {
      const durationMs = durationSince(startedMs);
      const message = formatError(error);
      const httpStatus = httpStatusFromError(error);
      this.commitPollError(claimed, startedAt, durationMs, message, httpStatus);
      return {
        ...emptyCounts(),
        sourceId: source.id,
        outcome: 'error',
        httpStatus,
        error: message
      };
    } finally {
      this.inFlightSources.delete(source.id);
    }
  }

  private async runDuePollsInternal(now: string): Promise<PollSourceResult[]> {
    await this.options.deliveryRunner?.runDueDeliveries(now);
    const dueSources = this.options.repositories.sources.findDuePoll(now, this.options.dueLimit ?? DEFAULT_DUE_LIMIT);
    const results: PollSourceResult[] = [];
    for (const source of dueSources) {
      results.push(await this.pollSource(source, now));
    }
    await this.options.deliveryRunner?.runDueDeliveries(now);
    return results;
  }

  private hasDeliveryDestination(source: SourceRecord): boolean {
    try {
      return resolveDestinationsForSource(source, this.options.repositories).length > 0;
    } catch (error) {
      if (error instanceof SecurityError) return false;
      throw error;
    }
  }

  private async fetchFeedForSource(source: SourceRecord): Promise<FeedFetchResult> {
    const fetcher = this.options.fetchFeed ?? fetchFeed;
    return fetcher(
      {
        id: source.id,
        feedUrl: source.feedUrl,
        etag: source.etag,
        lastModified: source.lastModified,
        fetchOptions: source.fetchOptions
      },
      this.options.fetchOptions
    );
  }

  private commitNotModified(
    source: SourceRecord,
    result: Extract<FeedFetchResult, { kind: 'not-modified' }>,
    polledAt: string,
    durationMs: number
  ): void {
    this.transaction(() => {
      this.applyPersistedFetchOptions(source.id, result.persistedFetchOptions);
      this.options.repositories.sources.markPolled(source.id, polledAt, {
        etag: result.etag,
        lastModified: result.lastModified
      });
      this.options.repositories.fetchLogs.append({
        sourceId: source.id,
        outcome: '304',
        httpStatus: 304,
        durationMs,
        createdAt: polledAt
      });
    });
  }

  private processSuccessfulFetch(
    source: SourceRecord,
    result: Extract<FeedFetchResult, { kind: 'ok' }>,
    polledAt: string,
    durationMs: number
  ): PollSourceResult {
    const envelopes = parseFeed(result.body);
    const detectedProfile =
      source.detectedProfile === null && envelopes.length > 0 ? detectProfile(result.body, envelopes) : source.detectedProfile;
    const profile = effectiveProfile(source.profileSetting, detectedProfile);
    const normalizedItems = envelopes.map((envelope) => normalize(profile, envelope));
    const counts = emptyCounts();

    this.transaction(() => {
      this.applyPersistedFetchOptions(source.id, result.persistedFetchOptions);
      for (const item of normalizedItems) {
        this.upsertNormalizedItem(source, item, polledAt, counts);
      }
      this.options.repositories.sources.markPolled(source.id, polledAt, {
        etag: result.etag,
        lastModified: result.lastModified,
        detectedProfile: detectedProfile ?? undefined,
        initialized: true
      });
      this.options.repositories.fetchLogs.append({
        sourceId: source.id,
        outcome: '200',
        httpStatus: result.statusCode,
        ...counts,
        durationMs,
        createdAt: polledAt
      });
    });

    return {
      ...counts,
      sourceId: source.id,
      outcome: '200',
      httpStatus: result.statusCode,
      detectedProfile: detectedProfile ?? undefined
    };
  }

  private upsertNormalizedItem(source: SourceRecord, item: NormalizedItem, now: string, counts: PollCounts): ItemRecord {
    const existing = this.options.repositories.items.findByAtomId(source.id, item.atomId);
    if (!existing) {
      const shouldQueue = shouldQueueNewItem(source, item);
      const inserted = this.options.repositories.items.insert(createItemInput(source.id, item, now, shouldQueue));
      if (shouldQueue) {
        counts.itemsNew += 1;
      } else {
        counts.itemsHistorical += 1;
      }
      return inserted;
    }

    const decision = classifyExistingItem(existing, item);
    if (decision === 'skipped') {
      counts.itemsSkipped += 1;
      return existing;
    }

    const updated = this.options.repositories.items.updateContentHash(existing.id, updateContentInput(item));
    counts.itemsChanged += 1;
    if (decision === 'changed-requeue') {
      return this.options.repositories.items.requeueForDelivery(updated.id, now);
    }
    return updated;
  }

  private commitPollError(
    source: SourceRecord,
    polledAt: string,
    durationMs: number,
    error: string,
    httpStatus: number | null
  ): void {
    this.transaction(() => {
      this.options.repositories.sources.markPolled(source.id, polledAt);
      this.options.repositories.fetchLogs.append({
        sourceId: source.id,
        outcome: 'error',
        httpStatus,
        durationMs,
        error,
        createdAt: polledAt
      });
    });
  }

  private applyPersistedFetchOptions(sourceId: string, fetchOptions: FeedFetchResult['persistedFetchOptions']): void {
    if (!fetchOptions) return;
    this.options.repositories.sources.update(sourceId, { fetchOptions });
  }

  private transaction<T>(fn: () => T): T {
    return this.options.db.transaction(fn)();
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Do not let an injected error hook create another unhandled timer rejection.
    }
  }
}

function createItemInput(sourceId: string, item: NormalizedItem, now: string, shouldQueue: boolean): CreateItemInput {
  return {
    sourceId,
    atomId: item.atomId,
    title: item.title,
    link: item.link,
    summary: item.summary,
    contentHash: item.contentHash,
    incidentStage: item.incidentStage,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    author: item.author,
    commentsUrl: item.commentsUrl,
    image: item.image,
    deliveryStatus: shouldQueue ? 'pending' : 'historical',
    nextAttemptAt: shouldQueue ? now : null,
    createdAt: now
  };
}

function updateContentInput(item: NormalizedItem): UpdateContentHashInput {
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

function emptyResult(sourceId: string, outcome: PollOutcome): PollSourceResult {
  return {
    ...emptyCounts(),
    sourceId,
    outcome,
    httpStatus: null
  };
}

function emptyCounts(): PollCounts {
  return {
    itemsNew: 0,
    itemsHistorical: 0,
    itemsChanged: 0,
    itemsSkipped: 0
  };
}

function durationSince(startedMs: number): number {
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Date.now() - startedMs);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStatusFromError(error: unknown): number | null {
  if (!(error instanceof SecurityError)) return null;
  const statusCode = error.details.statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : null;
}
