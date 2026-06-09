import type Database from 'better-sqlite3';
import type { CreateSourceRequest, SourceDto, UpdateSourceRequest } from '../contracts/api.js';
import { nowIso } from '../db/time.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { verifyFeedUrlSafe } from '../security/index.js';
import { conflict, notFound, validationError } from './errors.js';
import { toSourceDto } from './serialization.js';
import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  parseDiscordId,
  parseDiscordIdList,
  parseDiscordTagIds,
  parseGroupIds,
  parseSourceProfile,
  requireObject,
  validateFeedUrl,
  validateFetchOptions,
  validateOptionalHttpUrl
} from './validation.js';

export interface SourceServiceOptions {
  db: Database.Database;
  repositories: RepositoryRegistry;
  now?: () => string;
  verifyFeedUrl?: (value: string) => Promise<unknown>;
}

export class SourceService {
  constructor(private readonly options: SourceServiceOptions) {}

  list(): SourceDto[] {
    const sources = this.options.repositories.sources.list();
    const sourceIds = sources.map((source) => source.id);
    const groupIdsBySource = this.options.repositories.sourceGroups.listGroupIdsBySourceIds(sourceIds);
    const groupNameById = this.options.repositories.groups.listNamesByIds(uniqueNumbers([...groupIdsBySource.values()].flat()));
    const latestOutcomeBySource = this.options.repositories.fetchLogs.listLatestOutcomeBySourceIds(sourceIds);
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
        webhookUrl: null,
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
      return created;
    }));
    return this.toDto(source.id);
  }

  async update(id: string, value: unknown): Promise<SourceDto> {
    const current = this.requireSource(id);
    const input = normalizeSourceUpdate(value);
    const nextFeedUrl = input.feedUrl ?? current.feedUrl;
    if (nextFeedUrl !== current.feedUrl) {
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
      if (nextFeedUrl !== current.feedUrl) {
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
        initialized: nextFeedUrl !== current.feedUrl ? false : undefined,
        detectedProfile: nextFeedUrl !== current.feedUrl ? null : undefined,
        deliveryCutoffAt: nextFeedUrl !== current.feedUrl ? timestamp : undefined,
        etag: nextFeedUrl !== current.feedUrl ? null : undefined,
        lastModified: nextFeedUrl !== current.feedUrl ? null : undefined,
        lastPolledAt: nextFeedUrl !== current.feedUrl ? null : undefined,
        nextPollAt: nextFeedUrl !== current.feedUrl ? null : undefined
      });
      if (input.groupIds !== undefined) {
        this.options.repositories.sourceGroups.setGroups(id, input.groupIds);
      }
    }));
    return this.toDto(id);
  }

  remove(id: string): void {
    this.requireSource(id);
    if (!this.options.repositories.sources.delete(id)) {
      throw notFound('소스를 찾을 수 없습니다.');
    }
  }

  setEnabled(id: string, value: unknown): SourceDto {
    const body = requireObject(value);
    const enabled = optionalBoolean(body.enabled);
    if (enabled === undefined) throw validationError('enabled 값이 필요합니다.', { enabled: '필수 값입니다.' });
    this.requireSource(id);
    const timestamp = this.now();
    this.transaction(() => {
      this.options.repositories.sources.setEnabled(id, enabled, timestamp);
      if (enabled) this.options.repositories.items.resetPendingAttemptsForSource(id, timestamp);
    });
    return this.toDto(id);
  }

  retryFailed(id: string): number {
    this.requireSource(id);
    return this.options.repositories.items.requeueFailedBySource(id, this.now());
  }

  private toDto(id: string): SourceDto {
    const source = this.requireSource(id);
    const groupIds = this.options.repositories.sourceGroups.listGroupIdsForSource(id);
    const groupNames = groupIds
      .map((groupId) => this.options.repositories.groups.getById(groupId)?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    const latestFetch = this.options.repositories.fetchLogs.list({ sourceId: id, limit: 1 })[0];
    return toSourceDto(source, groupIds, groupNames, latestFetch?.outcome ?? null);
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

export function normalizeSourceCreate(value: unknown): Required<Pick<CreateSourceRequest, 'feedUrl'>> & CreateSourceRequest {
  const body = requireObject(value);
  return {
    feedUrl: validateFeedUrl(body.feedUrl),
    name: optionalString(body.name, 'name', 200),
    profile: parseSourceProfile(body.profile),
    pollIntervalSeconds: optionalInteger(body.pollIntervalSeconds, 'pollIntervalSeconds', 60, 86400),
    translate: optionalBoolean(body.translate),
    templateId: optionalInteger(body.templateId, 'templateId', 1, Number.MAX_SAFE_INTEGER) ?? null,
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: validateOptionalHttpUrl(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048),
    fetchOptions: validateFetchOptions(body.fetchOptions),
    groupIds: parseGroupIds(body.groupIds),
    silent: optionalBoolean(body.silent),
    mentionRoleIds: parseDiscordIdList(body.mentionRoleIds, 'mentionRoleIds'),
    mentionUserIds: parseDiscordIdList(body.mentionUserIds, 'mentionUserIds'),
    mentionEveryone: optionalBoolean(body.mentionEveryone),
    mentionHere: optionalBoolean(body.mentionHere),
    threadId: parseDiscordId(body.threadId, 'threadId'),
    threadName: optionalString(body.threadName, 'threadName', 100),
    appliedTags: parseDiscordTagIds(body.appliedTags, 'appliedTags', 5),
    editInPlace: optionalBoolean(body.editInPlace)
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}

export function normalizeSourceUpdate(value: unknown): UpdateSourceRequest {
  const body = requireObject(value);
  return {
    feedUrl: body.feedUrl === undefined ? undefined : validateFeedUrl(body.feedUrl),
    name: optionalString(body.name, 'name', 200),
    profile: parseSourceProfile(body.profile),
    pollIntervalSeconds: optionalInteger(body.pollIntervalSeconds, 'pollIntervalSeconds', 60, 86400),
    translate: optionalBoolean(body.translate),
    templateId: body.templateId === null || body.templateId === '' ? null : optionalInteger(body.templateId, 'templateId', 1, Number.MAX_SAFE_INTEGER),
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: validateOptionalHttpUrl(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048),
    fetchOptions: validateFetchOptions(body.fetchOptions),
    groupIds: parseGroupIds(body.groupIds),
    silent: optionalBoolean(body.silent),
    mentionRoleIds: parseDiscordIdList(body.mentionRoleIds, 'mentionRoleIds'),
    mentionUserIds: parseDiscordIdList(body.mentionUserIds, 'mentionUserIds'),
    mentionEveryone: optionalBoolean(body.mentionEveryone),
    mentionHere: optionalBoolean(body.mentionHere),
    threadId: parseDiscordId(body.threadId, 'threadId'),
    threadName: optionalString(body.threadName, 'threadName', 100),
    appliedTags: parseDiscordTagIds(body.appliedTags, 'appliedTags', 5),
    editInPlace: optionalBoolean(body.editInPlace)
  };
}
