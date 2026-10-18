/**
 * 수집 소스 관리. 소스·그룹 배정·연결 갱신을 묶고 피드 변경 시 과거 데이터의 혼용을 막는다.
 */
import type Database from 'better-sqlite3';
import type { SourceProfile, Profile } from '../feed/parse.js';
import type { TemplateId } from '../templates/service.js';
import type { GroupId } from '../groups/service.js';
import type { FetchEventStatus, EventLogRepository } from '../logs/repository.js';
import type { FetchOptions } from '../net/fetch.js';
import type { GroupRepository } from '../groups/repository.js';
import type { ItemRepository } from '../feed/repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import { conflict, notFound, validationError } from '../core/errors.js';
import { requireObject, optionalBoolean } from '../core/input.js';
import { verifyFeedUrlSafe } from '../net/address.js';
import { nowIso } from '../core/db.js';
import type { SourceRecord, SourceRepository, SourceGroupRepository } from './repository.js';
import { normalizeSourceCreate, normalizeSourceUpdate } from './input.js';

export type SourceId = string;

export interface SourceDto {
  consecutiveFailures?: number;
  id: SourceId;
  feedUrl: string;
  name: string | null;
  enabled: boolean;
  profile: SourceProfile;
  detectedProfile: Profile | null;
  pollIntervalSeconds: number;
  translate: boolean;
  templateId: TemplateId | null;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  groupIds: GroupId[];
  groupNames: string[];
  silent: boolean;
  mentionRoleIds: string[];
  mentionUserIds: string[];
  mentionEveryone: boolean;
  mentionHere: boolean;
  threadId: string | null;
  threadName: string | null;
  appliedTags: string[];
  editInPlace: boolean;
  lastOutcome?: FetchEventStatus | null;
}

export interface CreateSourceRequest {
  feedUrl: string;
  name?: string | null;
  profile?: SourceProfile;
  pollIntervalSeconds?: number;
  translate?: boolean;
  templateId?: TemplateId | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  fetchOptions?: FetchOptions;
  groupIds?: GroupId[];
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

export type UpdateSourceRequest = Partial<CreateSourceRequest>;

/** 저장소 레코드에 그룹 이름과 최근 수집 결과를 결합해 화면·API가 쓰는 공개 형태를 만든다. */
export function toSourceDto(
  source: SourceRecord,
  groupIds: number[],
  groupNames: string[],
  lastOutcome: FetchEventStatus | null
): SourceDto {
  return {
    consecutiveFailures: source.consecutiveFailures,
    id: source.id,
    feedUrl: source.feedUrl,
    name: source.name,
    enabled: source.enabled,
    profile: source.profileSetting,
    detectedProfile: source.detectedProfile,
    pollIntervalSeconds: source.pollIntervalSeconds,
    translate: source.translate,
    templateId: source.templateId,
    webhookName: source.webhookName,
    webhookAvatarUrl: source.webhookAvatarUrl,
    groupIds,
    groupNames,
    silent: source.silent,
    mentionRoleIds: source.mentionRoleIds,
    mentionUserIds: source.mentionUserIds,
    mentionEveryone: source.mentionEveryone,
    mentionHere: source.mentionHere,
    threadId: source.threadId,
    threadName: source.threadName,
    appliedTags: source.appliedTags,
    editInPlace: source.editInPlace,
    lastOutcome
  };
}

export interface SourceServiceOptions {
  db: Database.Database;
  repositories: {
    sources: Pick<SourceRepository, 'list' | 'findByFeedUrl' | 'create' | 'update' | 'delete' | 'setEnabled' | 'getById'>;
    sourceGroups: Pick<SourceGroupRepository, 'listGroupIdsBySourceIds' | 'setGroups' | 'listGroupIdsForSource'>;
    groups: Pick<GroupRepository, 'listNamesByIds' | 'getById'>;
    eventLog: Pick<EventLogRepository, 'latestFetchStatusBySourceIds'>;
    items: Pick<ItemRepository, 'deleteBySourceId'>;
    templates: Pick<TemplateRepository, 'getById'>;
  };
  now?: () => string;
  verifyFeedUrl?: (value: string) => Promise<unknown>;
  reconcileDestinations?: (sourceId: string, now: string, reset?: boolean) => void;
}

export class SourceService {
  constructor(private readonly options: SourceServiceOptions) { }

  list(): SourceDto[] {
    // 목록에 필요한 부가 정보는 일괄 조회해 소스마다 같은 쿼리를 반복하지 않는다.
    const sources = this.options.repositories.sources.list();
    const sourceIds = sources.map((source) => source.id);
    const groupIdsBySource = this.options.repositories.sourceGroups.listGroupIdsBySourceIds(sourceIds);
    const groupNameById = this.options.repositories.groups.listNamesByIds(uniqueNumbers([...groupIdsBySource.values()].flat()));
    const latestOutcomeBySource = this.options.repositories.eventLog.latestFetchStatusBySourceIds(sourceIds);
    return sources.map((source) => {
      const groupIds = groupIdsBySource.get(source.id) ?? [];
      const groupNames = groupIds
        .map((groupId) => groupNameById.get(groupId))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      return toSourceDto(source, groupIds, groupNames, latestOutcomeBySource.get(source.id) ?? null);
    });
  }

  get(id: string): SourceDto {
    this.requireSource(id);
    return this.toDto(id);
  }

  /** 소스와 필수 그룹 배정을 함께 저장하고 새 연결이 과거 항목을 발송하지 않도록 기준을 초기화한다. */
  async create(value: unknown): Promise<SourceDto> {
    const input = normalizeSourceCreate(value);
    const timestamp = this.now();
    if (this.options.repositories.sources.findByFeedUrl(input.feedUrl)) {
      throw conflict('이미 등록된 RSS URL입니다.', { feedUrl: '이미 등록되어 있습니다.' });
    }
    this.assertTemplate(input.templateId);
    this.assertRequiredGroups(input.groupIds);
    await this.verifyFeedUrl(input.feedUrl);
    const source = this.writeSource(() => this.transaction(() => {
      const created = this.options.repositories.sources.create({
        feedUrl: input.feedUrl,
        name: input.name ?? null,
        profileSetting: input.profile ?? 'auto',
        pollIntervalSeconds: input.pollIntervalSeconds ?? 300,
        translate: input.translate ?? false,
        templateId: input.templateId ?? null,
        webhookName: input.webhookName ?? null,
        webhookAvatarUrl: input.webhookAvatarUrl ?? null,
        fetchOptions: input.fetchOptions ?? {},
        silent: input.silent ?? false,
        mentionRoleIds: input.mentionRoleIds ?? [],
        mentionUserIds: input.mentionUserIds ?? [],
        mentionEveryone: input.mentionEveryone ?? false,
        mentionHere: input.mentionHere ?? false,
        threadId: input.threadId ?? null,
        threadName: input.threadName ?? null,
        appliedTags: input.appliedTags ?? [],
        editInPlace: input.editInPlace ?? false,
        deliveryCutoffAt: timestamp,
        initialized: false,
        nextPollAt: null,
        createdAt: timestamp
      });
      this.options.repositories.sourceGroups.setGroups(created.id, input.groupIds ?? []);
      this.options.reconcileDestinations?.(created.id, timestamp);
      return created;
    }));
    return this.toDto(source.id);
  }

  /** 피드 URL 변경은 다른 피드로 취급한다. 조건부 GET·감지 프로필·과거 항목과 연결 기준을 함께 갱신한다. */
  async update(id: string, value: unknown): Promise<SourceDto> {
    const current = this.requireSource(id);
    const input = normalizeSourceUpdate(value);
    const nextFeedUrl = input.feedUrl ?? current.feedUrl;
    const feedChanged = nextFeedUrl !== current.feedUrl;
    if (feedChanged) {
      const existing = this.options.repositories.sources.findByFeedUrl(nextFeedUrl);
      if (existing && existing.id !== id) {
        throw conflict('이미 등록된 RSS URL입니다.', { feedUrl: '이미 등록되어 있습니다.' });
      }
    }
    this.assertTemplate(input.templateId);
    const nextGroupIds = input.groupIds ?? this.options.repositories.sourceGroups.listGroupIdsForSource(id);
    this.assertRequiredGroups(nextGroupIds);
    if (input.feedUrl && input.feedUrl !== current.feedUrl) await this.verifyFeedUrl(input.feedUrl);
    const timestamp = this.now();
    this.writeSource(() => this.transaction(() => {
      // 피드 URL을 바꾸면 다른 피드로 취급해 항목과 초기 수집 기준을 함께 초기화한다.
      if (feedChanged) {
        this.options.repositories.items.deleteBySourceId(id);
      }
      this.options.repositories.sources.update(id, {
        feedUrl: input.feedUrl,
        name: input.name,
        profileSetting: input.profile,
        pollIntervalSeconds: input.pollIntervalSeconds,
        translate: input.translate,
        templateId: input.templateId,
        webhookName: input.webhookName,
        webhookAvatarUrl: input.webhookAvatarUrl,
        fetchOptions: input.fetchOptions,
        silent: input.silent,
        mentionRoleIds: input.mentionRoleIds,
        mentionUserIds: input.mentionUserIds,
        mentionEveryone: input.mentionEveryone,
        mentionHere: input.mentionHere,
        threadId: input.threadId,
        threadName: input.threadName,
        appliedTags: input.appliedTags,
        editInPlace: input.editInPlace,
        initialized: feedChanged ? false : undefined,
        detectedProfile: feedChanged ? null : undefined,
        deliveryCutoffAt: feedChanged ? timestamp : undefined,
        etag: feedChanged ? null : undefined,
        lastModified: feedChanged ? null : undefined,
        lastPolledAt: feedChanged ? null : undefined,
        nextPollAt: feedChanged ? null : undefined
      });
      if (input.groupIds !== undefined) {
        this.options.repositories.sourceGroups.setGroups(id, input.groupIds);
      }
      this.options.reconcileDestinations?.(id, timestamp, feedChanged);
    }));
    return this.toDto(id);
  }

  remove(id: string): void {
    this.requireSource(id);
    if (!this.options.repositories.sources.delete(id)) {
      throw notFound('소스를 찾을 수 없습니다.');
    }
  }

  /** 활성 상태와 발송 목적지 갱신을 한 트랜잭션에 묶는다. */
  setEnabled(id: string, value: unknown): SourceDto {
    const body = requireObject(value);
    const enabled = optionalBoolean(body.enabled);
    if (enabled === undefined) throw validationError('enabled 값이 필요합니다.', { enabled: '필수 값입니다.' });
    this.requireSource(id);
    const timestamp = this.now();
    this.transaction(() => {
      this.options.repositories.sources.setEnabled(id, enabled, timestamp);
      this.options.reconcileDestinations?.(id, timestamp);
    });
    return this.toDto(id);
  }

  private toDto(id: string): SourceDto {
    const source = this.requireSource(id);
    const groupIds = this.options.repositories.sourceGroups.listGroupIdsForSource(id);
    const groupNames = groupIds
      .map((groupId) => this.options.repositories.groups.getById(groupId)?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    const latestFetch = this.options.repositories.eventLog.latestFetchStatusBySourceIds([id]).get(id);
    return toSourceDto(source, groupIds, groupNames, latestFetch ?? null);
  }

  private requireSource(id: string) {
    const source = this.options.repositories.sources.getById(id);
    if (!source) throw notFound('소스를 찾을 수 없습니다.');
    return source;
  }

  private assertTemplate(templateId: number | null | undefined): void {
    if (templateId === undefined || templateId === null) return;
    if (!this.options.repositories.templates.getById(templateId)) {
      throw validationError('템플릿을 찾을 수 없습니다.', { templateId: '존재하지 않는 템플릿입니다.' });
    }
  }

  /** 저장 가능한 소스는 적어도 하나의 존재하는 발신 그룹을 가져야 한다. */
  private assertRequiredGroups(groupIds: number[] | undefined): void {
    if (!groupIds || groupIds.length === 0) {
      throw validationError('전송할 그룹을 최소 1개 선택해야 합니다.', { groupIds: '최소 1개 이상 선택하세요.' });
    }
    this.assertGroups(groupIds);
  }

  private assertGroups(groupIds: number[]): void {
    for (const groupId of groupIds) {
      if (!this.options.repositories.groups.getById(groupId)) {
        throw validationError('그룹을 찾을 수 없습니다.', { groupIds: `존재하지 않는 그룹입니다: ${groupId}` });
      }
    }
  }

  private async verifyFeedUrl(value: string): Promise<void> {
    await (this.options.verifyFeedUrl ?? verifyFeedUrlSafe)(value);
  }

  private transaction<T>(fn: () => T): T {
    return this.options.db.transaction(fn)();
  }

  /** 동시 등록으로 DB UNIQUE 제약에 걸린 경우에도 사용자에게 같은 중복 URL 오류를 보여준다. */
  private writeSource<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw conflict('이미 등록된 RSS URL입니다.', { feedUrl: '이미 등록되어 있습니다.' });
      }
      throw error;
    }
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && String((error as {
    code?: unknown
  }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}
