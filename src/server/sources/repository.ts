import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SourceProfile, Profile } from '../feed/parse.js';
import type { FetchOptions } from '../net/fetch.js';
import {
  nowIso,
  nullable,
  toSqliteBoolean,
  stringifyJsonObject,
  stringifyJsonStringArray,
  addSecondsIso,
  fromSqliteBoolean,
  parseJsonObject,
  parseJsonStringArray
} from '../core/db.js';

export class SourceGroupRepository {
  constructor(private readonly db: Database.Database) { }

  listGroupIdsForSource(sourceId: string): number[] {
    return this.db
      .prepare('SELECT group_id FROM source_groups WHERE source_id = ? ORDER BY group_id')
      .all(sourceId)
      .map((row) => (row as {
        group_id: number
      }).group_id);
  }

  listGroupIdsBySourceIds(sourceIds: readonly string[]): Map<string, number[]> {
    // SQL의 IN 절은 빈 배열에서 생성하지 않는다. 호출자는 빈 Map을 그대로 사용할 수 있다.
    const output = new Map<string, number[]>();
    if (sourceIds.length === 0) return output;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT source_id, group_id FROM source_groups WHERE source_id IN (${placeholders}) ORDER BY source_id, group_id`)
      .all(...sourceIds) as Array<{
        source_id: string;
        group_id: number
      }>;
    for (const row of rows) {
      const current = output.get(row.source_id);
      if (current) current.push(row.group_id);
      else output.set(row.source_id, [row.group_id]);
    }
    return output;
  }

  listSourceIdsForGroup(groupId: number): string[] {
    return this.db
      .prepare('SELECT source_id FROM source_groups WHERE group_id = ? ORDER BY source_id')
      .all(groupId)
      .map((row) => (row as {
        source_id: string
      }).source_id);
  }

  setGroups(sourceId: string, groupIds: readonly number[]): void {
    // 전체 교체를 한 트랜잭션으로 묶어 삭제만 반영된 중간 상태가 남지 않게 한다.
    const uniqueGroupIds = [...new Set(groupIds)];
    const deleteStmt = this.db.prepare('DELETE FROM source_groups WHERE source_id = ?');
    const insertStmt = this.db.prepare('INSERT INTO source_groups (source_id, group_id) VALUES (?, ?)');
    this.db.transaction(() => {
      deleteStmt.run(sourceId);
      for (const groupId of uniqueGroupIds) {
        insertStmt.run(sourceId, groupId);
      }
    })();
  }

  add(sourceId: string, groupId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO source_groups (source_id, group_id) VALUES (?, ?)').run(sourceId, groupId);
  }

  remove(sourceId: string, groupId: number): boolean {
    return this.db.prepare('DELETE FROM source_groups WHERE source_id = ? AND group_id = ?').run(sourceId, groupId).changes > 0;
  }
}

export interface SourceRecord {
  configRevision: number;
  consecutiveFailures: number;
  id: string;
  feedUrl: string;
  name: string | null;
  enabled: boolean;
  profileSetting: SourceProfile;
  detectedProfile: Profile | null;
  initialized: boolean;
  deliveryCutoffAt: string | null;
  etag: string | null;
  lastModified: string | null;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  templateId: number | null;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  pollIntervalSeconds: number;
  fetchOptions: FetchOptions;
  translate: boolean;
  silent: boolean;
  mentionRoleIds: string[];
  mentionUserIds: string[];
  mentionEveryone: boolean;
  mentionHere: boolean;
  threadId: string | null;
  threadName: string | null;
  appliedTags: string[];
  editInPlace: boolean;
  createdAt: string;
}

export interface CreateSourceInput {
  id?: string;
  feedUrl: string;
  name?: string | null;
  enabled?: boolean;
  profileSetting?: SourceProfile;
  detectedProfile?: Profile | null;
  initialized?: boolean;
  deliveryCutoffAt?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  lastPolledAt?: string | null;
  nextPollAt?: string | null;
  templateId?: number | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  pollIntervalSeconds?: number;
  fetchOptions?: FetchOptions;
  translate?: boolean;
  silent?: boolean;
  mentionRoleIds?: string[];
  mentionUserIds?: string[];
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  threadId?: string | null;
  threadName?: string | null;
  appliedTags?: string[];
  editInPlace?: boolean;
  createdAt?: string;
}

export interface UpdateSourceInput {
  feedUrl?: string;
  name?: string | null;
  enabled?: boolean;
  profileSetting?: SourceProfile;
  detectedProfile?: Profile | null;
  initialized?: boolean;
  deliveryCutoffAt?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  lastPolledAt?: string | null;
  nextPollAt?: string | null;
  templateId?: number | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  pollIntervalSeconds?: number;
  fetchOptions?: FetchOptions;
  translate?: boolean;
  silent?: boolean;
  mentionRoleIds?: string[];
  mentionUserIds?: string[];
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  threadId?: string | null;
  threadName?: string | null;
  appliedTags?: string[];
  editInPlace?: boolean;
}

interface SourceRow {
  config_revision: number;
  consecutive_failures: number;
  id: string;
  feed_url: string;
  name: string | null;
  enabled: number;
  profile: SourceProfile;
  detected_profile: Profile | null;
  initialized: number;
  delivery_cutoff_at: string | null;
  etag: string | null;
  last_modified: string | null;
  last_polled_at: string | null;
  next_poll_at: string | null;
  template_id: number | null;
  webhook_name: string | null;
  webhook_avatar_url: string | null;
  poll_interval_seconds: number;
  fetch_options: string | null;
  translate: number;
  silent: number;
  mention_role_ids: string | null;
  mention_user_ids: string | null;
  mention_everyone: number;
  mention_here: number;
  thread_id: string | null;
  thread_name: string | null;
  applied_tags: string | null;
  edit_in_place: number;
  created_at: string;
}

const SOURCE_COLUMNS = `
  config_revision, consecutive_failures,
  id, feed_url, name, enabled, profile, detected_profile, initialized,
  delivery_cutoff_at, etag, last_modified, last_polled_at, next_poll_at,
  template_id, webhook_name, webhook_avatar_url,
  poll_interval_seconds, fetch_options, translate, silent, mention_role_ids,
  mention_user_ids, mention_everyone, mention_here, thread_id, thread_name, applied_tags,
  edit_in_place, created_at
`;

export class SourceRepository {
  constructor(private readonly db: Database.Database) { }

  list(): SourceRecord[] {
    return (this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY created_at DESC, id`).all() as SourceRow[]).map(
      mapSourceRow
    );
  }

  getById(id: string): SourceRecord | null {
    const row = this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(id) as SourceRow | undefined;
    return row ? mapSourceRow(row) : null;
  }

  findByFeedUrl(feedUrl: string): SourceRecord | null {
    const row = this.db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE feed_url = ? ORDER BY created_at DESC, id LIMIT 1`)
      .get(feedUrl) as SourceRow | undefined;
    return row ? mapSourceRow(row) : null;
  }

  findDuePoll(now: string, limit = 50): SourceRecord[] {
    return (this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS}
         FROM sources
         WHERE enabled = 1
           AND (next_poll_at IS NULL OR next_poll_at <= ?)
         ORDER BY next_poll_at IS NOT NULL, next_poll_at, created_at, id
         LIMIT ?`
      )
      .all(now, limit) as SourceRow[]).map(mapSourceRow);
  }

  create(input: CreateSourceInput): SourceRecord {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO sources (
           id, feed_url, name, enabled, profile, detected_profile, initialized,
           delivery_cutoff_at, etag, last_modified, last_polled_at, next_poll_at,
           template_id, webhook_name, webhook_avatar_url,
           poll_interval_seconds, fetch_options, translate, silent, mention_role_ids,
           mention_user_ids, mention_everyone, mention_here, thread_id, thread_name, applied_tags,
           edit_in_place, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.feedUrl,
        nullable(input.name),
        toSqliteBoolean(input.enabled ?? true),
        input.profileSetting ?? 'auto',
        nullable(input.detectedProfile),
        toSqliteBoolean(input.initialized ?? false),
        nullable(input.deliveryCutoffAt),
        nullable(input.etag),
        nullable(input.lastModified),
        nullable(input.lastPolledAt),
        nullable(input.nextPollAt),
        nullable(input.templateId),
        nullable(input.webhookName),
        nullable(input.webhookAvatarUrl),
        input.pollIntervalSeconds ?? 300,
        stringifyJsonObject(input.fetchOptions ?? {}),
        toSqliteBoolean(input.translate ?? false),
        toSqliteBoolean(input.silent ?? false),
        stringifyJsonStringArray(input.mentionRoleIds ?? []),
        stringifyJsonStringArray(input.mentionUserIds ?? []),
        toSqliteBoolean(input.mentionEveryone ?? false),
        toSqliteBoolean(input.mentionHere ?? false),
        nullable(input.threadId),
        nullable(input.threadName),
        stringifyJsonStringArray(input.appliedTags ?? []),
        toSqliteBoolean(input.editInPlace ?? false),
        createdAt
      );
    return this.requireById(id);
  }

  update(id: string, input: UpdateSourceInput): SourceRecord {
    // undefined 필드는 유지하고 null은 그대로 저장한다. 부분 수정의 의미를 보존한다.
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (input.feedUrl !== undefined) add('feed_url', input.feedUrl);
    if (input.name !== undefined) add('name', input.name);
    if (input.enabled !== undefined) add('enabled', toSqliteBoolean(input.enabled));
    if (input.profileSetting !== undefined) add('profile', input.profileSetting);
    if (input.detectedProfile !== undefined) add('detected_profile', input.detectedProfile);
    if (input.initialized !== undefined) add('initialized', toSqliteBoolean(input.initialized));
    if (input.deliveryCutoffAt !== undefined) add('delivery_cutoff_at', input.deliveryCutoffAt);
    if (input.etag !== undefined) add('etag', input.etag);
    if (input.lastModified !== undefined) add('last_modified', input.lastModified);
    if (input.lastPolledAt !== undefined) add('last_polled_at', input.lastPolledAt);
    if (input.nextPollAt !== undefined) add('next_poll_at', input.nextPollAt);
    if (input.templateId !== undefined) add('template_id', input.templateId);
    if (input.webhookName !== undefined) add('webhook_name', input.webhookName);
    if (input.webhookAvatarUrl !== undefined) add('webhook_avatar_url', input.webhookAvatarUrl);
    if (input.pollIntervalSeconds !== undefined) add('poll_interval_seconds', input.pollIntervalSeconds);
    if (input.fetchOptions !== undefined) add('fetch_options', stringifyJsonObject(input.fetchOptions));
    if (input.translate !== undefined) add('translate', toSqliteBoolean(input.translate));
    if (input.silent !== undefined) add('silent', toSqliteBoolean(input.silent));
    if (input.mentionRoleIds !== undefined) add('mention_role_ids', stringifyJsonStringArray(input.mentionRoleIds));
    if (input.mentionUserIds !== undefined) add('mention_user_ids', stringifyJsonStringArray(input.mentionUserIds));
    if (input.mentionEveryone !== undefined) add('mention_everyone', toSqliteBoolean(input.mentionEveryone));
    if (input.mentionHere !== undefined) add('mention_here', toSqliteBoolean(input.mentionHere));
    if (input.threadId !== undefined) add('thread_id', input.threadId);
    if (input.threadName !== undefined) add('thread_name', input.threadName);
    if (input.appliedTags !== undefined) add('applied_tags', stringifyJsonStringArray(input.appliedTags));
    if (input.editInPlace !== undefined) add('edit_in_place', toSqliteBoolean(input.editInPlace));

    if (assignments.length === 0) return this.requireById(id);

    values.push(id);
    const result = this.db.prepare(`UPDATE sources SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) throw new Error(`Source not found: ${id}`);
    return this.requireById(id);
  }

  claimPollStarted(id: string, startedAt = nowIso()): SourceRecord {
    return this.update(id, { lastPolledAt: startedAt });
  }

  markPolled(
    id: string,
    polledAt = nowIso(),
    patch: Pick<UpdateSourceInput, 'etag' | 'lastModified' | 'detectedProfile' | 'initialized'> = {}
  ): SourceRecord {
    const current = this.requireById(id);
    return this.update(id, {
      ...patch,
      lastPolledAt: polledAt,
      nextPollAt: addSecondsIso(polledAt, current.pollIntervalSeconds)
    });
  }

  setEnabled(id: string, enabled: boolean, changedAt = nowIso()): SourceRecord {
    // 재활성화 시 이전 비활성 기간의 항목이 재발송되지 않도록 기준 시각도 갱신한다.
    return this.update(id, enabled ? { enabled, deliveryCutoffAt: changedAt, nextPollAt: null } : { enabled });
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sources WHERE id = ?').run(id).changes > 0;
  }

  persistDetectedProfile(id: string, detectedProfile: Profile): SourceRecord {
    return this.update(id, { detectedProfile });
  }

  setProfileSetting(id: string, profileSetting: SourceProfile): SourceRecord {
    return this.update(id, { profileSetting });
  }

  private requireById(id: string): SourceRecord {
    const source = this.getById(id);
    if (!source) throw new Error(`Source not found: ${id}`);
    return source;
  }
}

function mapSourceRow(row: SourceRow): SourceRecord {
  return {
    configRevision: row.config_revision,
    consecutiveFailures: row.consecutive_failures,
    id: row.id,
    feedUrl: row.feed_url,
    name: row.name,
    enabled: fromSqliteBoolean(row.enabled),
    profileSetting: row.profile,
    detectedProfile: row.detected_profile,
    initialized: fromSqliteBoolean(row.initialized),
    deliveryCutoffAt: row.delivery_cutoff_at,
    etag: row.etag,
    lastModified: row.last_modified,
    lastPolledAt: row.last_polled_at,
    nextPollAt: row.next_poll_at,
    templateId: row.template_id,
    webhookName: row.webhook_name,
    webhookAvatarUrl: row.webhook_avatar_url,
    pollIntervalSeconds: row.poll_interval_seconds,
    fetchOptions: parseJsonObject<FetchOptions>(row.fetch_options, {}, 'sources.fetch_options'),
    translate: fromSqliteBoolean(row.translate),
    silent: fromSqliteBoolean(row.silent),
    mentionRoleIds: parseJsonStringArray(row.mention_role_ids, [], 'sources.mention_role_ids'),
    mentionUserIds: parseJsonStringArray(row.mention_user_ids, [], 'sources.mention_user_ids'),
    mentionEveryone: fromSqliteBoolean(row.mention_everyone),
    mentionHere: fromSqliteBoolean(row.mention_here),
    threadId: row.thread_id,
    threadName: row.thread_name,
    appliedTags: parseJsonStringArray(row.applied_tags, [], 'sources.applied_tags'),
    editInPlace: fromSqliteBoolean(row.edit_in_place),
    createdAt: row.created_at
  };
}
