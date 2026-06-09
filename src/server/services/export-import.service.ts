import type Database from 'better-sqlite3';
import { verifyFeedUrlSafe, verifyWebhookUrlSafe } from '../security/index.js';
import type { FetchOptions } from '../security/types.js';
import { nowIso } from '../db/time.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { validationError } from './errors.js';
import { normalizeSourceCreate } from './source.service.js';
import { requiredString, validateFetchOptions, validateOptionalWebhookUrl } from './validation.js';

export interface ExportDocumentV1 {
  kind: 'rss-discord-bridge/export';
  version: 1;
  exportedAt: string;
  groups: ExportGroup[];
  sources: ExportSource[];
}

export interface ExportGroup {
  name: string;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  /** @deprecated Import-only legacy group webhook. Export never writes this field. */
  legacyWebhookUrl?: string | null;
}

export interface ExportSource {
  feedUrl: string;
  name?: string | null;
  enabled: boolean;
  profile: string;
  pollIntervalSeconds: number;
  translate: boolean;
  silent?: boolean;
  mentionRoleIds?: string[];
  mentionUserIds?: string[];
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  threadId?: string | null;
  threadName?: string | null;
  appliedTags?: string[];
  editInPlace?: boolean;
  /** @deprecated Import-only legacy source webhook. Export never writes this field. */
  legacyWebhookUrl?: string | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  templateRef?: string | null;
  fetchOptions?: FetchOptions;
  groupRefs: string[];
}

export interface ImportBlockedSource {
  feedUrl: string;
  kind: 'feed' | 'webhook';
  reason: string;
}

export interface ImportPlan {
  addedGroups: number;
  updatedGroups: number;
  skippedGroups: number;
  addedSources: number;
  updatedSources: number;
  skippedSources: number;
  blockedSources: number;
  unresolvedTemplates: number;
  unresolvedGroups: number;
  webhookReentryRequired: number;
  blockedFeedUrls: ImportBlockedSource[];
  warnings: string[];
}

export interface ExportImportServiceOptions {
  db: Database.Database;
  repositories: RepositoryRegistry;
  now?: () => string;
  verifyFeedUrl?: (value: string) => Promise<unknown>;
  verifyWebhookUrl?: (value: string) => Promise<unknown>;
}

type ImportGroupWithLegacyWebhook = ExportGroup & { webhookUrl?: unknown };
type ImportSourceWithLegacyWebhook = ExportSource & { webhookUrl?: unknown };

export class ExportImportService {
  constructor(private readonly options: ExportImportServiceOptions) {}

  export(): ExportDocumentV1 {
    const groups = this.options.repositories.groups.list();
    const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
    return {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: this.now(),
      groups: groups.map((group) => ({
        name: group.name,
        webhookName: group.webhookName,
        webhookAvatarUrl: group.webhookAvatarUrl
      })),
      sources: this.options.repositories.sources.list().map((source) => {
        const template = source.templateId ? this.options.repositories.templates.getById(source.templateId) : null;
        return {
          feedUrl: source.feedUrl,
          name: source.name,
          enabled: source.enabled,
          profile: source.profileSetting,
          pollIntervalSeconds: source.pollIntervalSeconds,
          translate: source.translate,
          silent: source.silent,
          mentionRoleIds: [...source.mentionRoleIds],
          mentionUserIds: [...source.mentionUserIds],
          mentionEveryone: source.mentionEveryone,
          mentionHere: source.mentionHere,
          threadId: source.threadId,
          threadName: source.threadName,
          appliedTags: [...source.appliedTags],
          editInPlace: source.editInPlace,
          webhookName: source.webhookName,
          webhookAvatarUrl: source.webhookAvatarUrl,
          templateRef: template?.name ?? null,
          fetchOptions: sanitizeFetchOptions(source.fetchOptions),
          groupRefs: this.options.repositories.sourceGroups
            .listGroupIdsForSource(source.id)
            .map((groupId) => groupNameById.get(groupId))
            .filter((name): name is string => name !== undefined)
        };
      })
    };
  }

  async dryRun(payload: string, mode: ImportMode = 'skip'): Promise<ImportPlan> {
    const { document, blockedFeedUrls } = await this.prepareImport(payload);
    return this.plan(document, mode, blockedFeedUrls);
  }

  async commit(payload: string, mode: ImportMode = 'skip'): Promise<ImportPlan> {
    const { document, blockedFeedUrls } = await this.prepareImport(payload);
    const plan = this.plan(document, mode, blockedFeedUrls);
    const timestamp = this.now();
    this.options.db.transaction(() => {
      for (const group of document.groups) {
        const existing = this.options.repositories.groups.findByNameNocase(group.name);
        if (existing && mode === 'overwrite') {
          this.options.repositories.groups.update(existing.id, {
            name: group.name,
            webhookUrl: group.legacyWebhookUrl ?? undefined,
            webhookName: group.webhookName ?? null,
            webhookAvatarUrl: group.webhookAvatarUrl ?? null,
            updatedAt: timestamp
          });
        } else if (!existing) {
          this.options.repositories.groups.create({
            name: group.name,
            webhookUrl: group.legacyWebhookUrl ?? null,
            webhookName: group.webhookName ?? null,
            webhookAvatarUrl: group.webhookAvatarUrl ?? null,
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
      }

      for (const source of document.sources) {
        const templateId = source.templateRef ? this.options.repositories.templates.findByName(source.templateRef)?.id ?? null : null;
        const groupIds = this.groupIdsForImportSource(source);
        const existing = this.options.repositories.sources.findByFeedUrl(source.feedUrl);
        if (existing && mode === 'skip') continue;
        if (existing && mode === 'overwrite') {
          this.options.repositories.sources.update(existing.id, {
            name: source.name ?? null,
            enabled: source.enabled,
            profileSetting: source.profile as never,
            pollIntervalSeconds: source.pollIntervalSeconds,
            translate: source.translate,
            templateId,
            webhookName: source.webhookName ?? null,
            webhookAvatarUrl: source.webhookAvatarUrl ?? null,
            fetchOptions: source.fetchOptions ?? {},
            silent: source.silent ?? false,
            mentionRoleIds: source.mentionRoleIds ?? [],
            mentionUserIds: source.mentionUserIds ?? [],
            mentionEveryone: source.mentionEveryone ?? false,
            mentionHere: source.mentionHere ?? false,
            threadId: source.threadId ?? null,
            threadName: source.threadName ?? null,
            appliedTags: source.appliedTags ?? [],
            editInPlace: source.editInPlace ?? false
          });
          this.options.repositories.sourceGroups.setGroups(existing.id, groupIds);
          continue;
        }
        const created = this.options.repositories.sources.create({
          feedUrl: source.feedUrl,
          name: source.name ?? null,
          enabled: source.enabled,
          profileSetting: source.profile as never,
          pollIntervalSeconds: source.pollIntervalSeconds,
          translate: source.translate,
          templateId,
          webhookUrl: null,
          webhookName: source.webhookName ?? null,
          webhookAvatarUrl: source.webhookAvatarUrl ?? null,
          fetchOptions: source.fetchOptions ?? {},
          silent: source.silent ?? false,
          mentionRoleIds: source.mentionRoleIds ?? [],
          mentionUserIds: source.mentionUserIds ?? [],
          mentionEveryone: source.mentionEveryone ?? false,
          mentionHere: source.mentionHere ?? false,
          threadId: source.threadId ?? null,
          threadName: source.threadName ?? null,
          appliedTags: source.appliedTags ?? [],
          editInPlace: source.editInPlace ?? false,
          deliveryCutoffAt: timestamp,
          initialized: false,
          nextPollAt: null,
          createdAt: timestamp
        });
        this.options.repositories.sourceGroups.setGroups(created.id, groupIds);
      }
    })();
    return plan;
  }

  private async prepareImport(payload: string): Promise<{ document: ExportDocumentV1; blockedFeedUrls: ImportBlockedSource[] }> {
    const document = parseDocument(payload);
    validateDocument(document);
    const blockedGroupWebhooks = await this.normalizeAndVerifyGroupWebhooks(document.groups);
    const blockedFeedUrls: ImportBlockedSource[] = [];
    const sources: ExportSource[] = [];
    for (const source of document.sources) {
      try {
        await (this.options.verifyFeedUrl ?? verifyFeedUrlSafe)(source.feedUrl);
      } catch (error) {
        blockedFeedUrls.push({ feedUrl: source.feedUrl, kind: 'feed', reason: importBlockReason(error) });
        continue;
      }

      const blockedGroup = this.firstBlockedGroupForSource(source, blockedGroupWebhooks);
      if (blockedGroup) {
        blockedFeedUrls.push({ feedUrl: source.feedUrl, kind: 'webhook', reason: webhookBlockReason(blockedGroup.reason) });
        continue;
      }

      sources.push(source);
    }
    return { document: { ...document, sources }, blockedFeedUrls };
  }

  private async normalizeAndVerifyGroupWebhooks(groups: readonly ExportGroup[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    for (const group of groups) {
      if (!group.legacyWebhookUrl) continue;
      try {
        group.legacyWebhookUrl = validateOptionalWebhookUrl(group.legacyWebhookUrl) ?? null;
        if (group.legacyWebhookUrl) await (this.options.verifyWebhookUrl ?? verifyWebhookUrlSafe)(group.legacyWebhookUrl);
      } catch (error) {
        group.legacyWebhookUrl = null;
        blocked.set(group.name.toLowerCase(), importBlockReason(error));
      }
    }
    return blocked;
  }

  private firstBlockedGroupForSource(source: ExportSource, blockedGroups: ReadonlyMap<string, string>): { name: string; reason: string } | null {
    for (const groupRef of source.groupRefs) {
      const reason = blockedGroups.get(groupRef.toLowerCase());
      if (reason) return { name: groupRef, reason };
    }
    return null;
  }

  private groupIdsForImportSource(source: ExportSource): number[] {
    return source.groupRefs
      .map((name) => this.options.repositories.groups.findByNameNocase(name)?.id)
      .filter((id): id is number => id !== undefined);
  }

  private plan(document: ExportDocumentV1, mode: ImportMode, blockedFeedUrls: ImportBlockedSource[]): ImportPlan {
    const warnings: string[] = [];
    const plan: ImportPlan = {
      addedGroups: 0,
      updatedGroups: 0,
      skippedGroups: 0,
      addedSources: 0,
      updatedSources: 0,
      skippedSources: 0,
      blockedSources: blockedFeedUrls.length,
      unresolvedTemplates: 0,
      unresolvedGroups: 0,
      webhookReentryRequired: 0,
      blockedFeedUrls,
      warnings
    };
    for (const blocked of blockedFeedUrls) {
      const target = blocked.kind === 'webhook' ? '웹훅' : '피드';
      warnings.push(`${target} SSRF 검증에 실패해 제외합니다: ${blocked.feedUrl} (${blocked.reason})`);
    }

    for (const group of document.groups) {
      const existing = this.options.repositories.groups.findByNameNocase(group.name);
      if (!existing) {
        plan.addedGroups += 1;
        if (!group.legacyWebhookUrl) {
          plan.webhookReentryRequired += 1;
          warnings.push(`신규 그룹은 webhook 재입력이 필요합니다: ${group.name}`);
        }
      } else if (mode === 'overwrite') plan.updatedGroups += 1;
      else plan.skippedGroups += 1;
    }

    for (const source of document.sources) {
      const existing = this.options.repositories.sources.findByFeedUrl(source.feedUrl);
      if (!source.templateRef || !this.options.repositories.templates.findByName(source.templateRef)) {
        if (source.templateRef) {
          plan.unresolvedTemplates += 1;
          warnings.push(`템플릿을 찾을 수 없어 NULL로 가져옵니다: ${source.templateRef}`);
        }
      }
      for (const groupRef of source.groupRefs) {
        if (!document.groups.some((group) => group.name.toLowerCase() === groupRef.toLowerCase()) && !this.options.repositories.groups.findByNameNocase(groupRef)) {
          plan.unresolvedGroups += 1;
          warnings.push(`그룹을 찾을 수 없어 멤버십에서 제외합니다: ${groupRef}`);
        }
      }
      if (!existing) {
        plan.addedSources += 1;
      } else if (mode === 'overwrite') {
        plan.updatedSources += 1;
      } else {
        plan.skippedSources += 1;
      }
    }
    return plan;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

export type ImportMode = 'skip' | 'overwrite';

export function parseImportMode(value: unknown): ImportMode {
  if (value === undefined || value === null || value === '' || value === 'skip') return 'skip';
  if (value === 'overwrite') return 'overwrite';
  throw validationError('import mode 값이 올바르지 않습니다.', { mode: 'skip 또는 overwrite만 허용됩니다.' });
}

function parseDocument(payload: string): ExportDocumentV1 {
  try {
    const document = JSON.parse(payload) as ExportDocumentV1;
    if (document.kind !== 'rss-discord-bridge/export' || document.version !== 1) {
      throw validationError('지원하지 않는 import 파일입니다.');
    }
    return document;
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw validationError('import JSON을 읽을 수 없습니다.');
  }
}

function validateDocument(document: ExportDocumentV1): void {
  if (!Array.isArray(document.groups) || !Array.isArray(document.sources)) {
    throw validationError('import 파일 구조가 올바르지 않습니다.');
  }
  const groupNames = new Set<string>();
  for (const group of document.groups) {
    group.name = requiredString(group.name, 'groups.name', 200);
    const key = group.name.toLowerCase();
    if (groupNames.has(key)) throw validationError('import 파일 안에 중복 그룹 이름이 있습니다.', { groups: group.name });
    groupNames.add(key);
    group.webhookName = group.webhookName ?? null;
    group.webhookAvatarUrl = group.webhookAvatarUrl ?? null;
    group.legacyWebhookUrl = validateOptionalString((group as ImportGroupWithLegacyWebhook).webhookUrl ?? group.legacyWebhookUrl, 'groups.webhookUrl', 2048);
  }
  const feedUrls = new Set<string>();
  for (const source of document.sources) {
    const normalized = normalizeSourceCreate({
      feedUrl: source.feedUrl,
      name: source.name,
      profile: source.profile,
      pollIntervalSeconds: source.pollIntervalSeconds,
      translate: source.translate,
      silent: source.silent,
      mentionRoleIds: source.mentionRoleIds,
      mentionUserIds: source.mentionUserIds,
      mentionEveryone: source.mentionEveryone,
      mentionHere: source.mentionHere,
      threadId: source.threadId,
      threadName: source.threadName,
      appliedTags: source.appliedTags,
      editInPlace: source.editInPlace,
      webhookName: source.webhookName,
      webhookAvatarUrl: source.webhookAvatarUrl,
      fetchOptions: validateFetchOptions(source.fetchOptions),
      groupIds: []
    });
    source.feedUrl = normalized.feedUrl;
    source.name = normalized.name ?? null;
    source.enabled = requiredBoolean(source.enabled, 'sources.enabled');
    source.profile = normalized.profile ?? 'auto';
    source.pollIntervalSeconds = normalized.pollIntervalSeconds ?? 300;
    source.translate = normalized.translate ?? false;
    source.silent = normalized.silent ?? false;
    source.mentionRoleIds = normalized.mentionRoleIds ?? [];
    source.mentionUserIds = normalized.mentionUserIds ?? [];
    source.mentionEveryone = normalized.mentionEveryone ?? false;
    source.mentionHere = normalized.mentionHere ?? false;
    source.threadId = normalized.threadId ?? null;
    source.threadName = normalized.threadName ?? null;
    source.appliedTags = normalized.appliedTags ?? [];
    source.editInPlace = normalized.editInPlace ?? false;
    const importSource = source as ImportSourceWithLegacyWebhook;
    source.legacyWebhookUrl = validateOptionalString(importSource.webhookUrl ?? source.legacyWebhookUrl, 'sources.webhookUrl', 2048);
    source.webhookName = normalized.webhookName ?? null;
    source.webhookAvatarUrl = normalized.webhookAvatarUrl ?? null;
    source.templateRef = validateOptionalString(source.templateRef, 'sources.templateRef', 200);
    source.fetchOptions = sanitizeFetchOptions(normalized.fetchOptions ?? {});
    source.groupRefs = validateGroupRefs(source.groupRefs);
    const key = source.feedUrl.toLowerCase();
    if (feedUrls.has(key)) throw validationError('import 파일 안에 중복 RSS URL이 있습니다.', { feedUrl: source.feedUrl });
    feedUrls.add(key);
  }
}


function validateOptionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw validationError('import 파일 구조가 올바르지 않습니다.', { [field]: '문자열이어야 합니다.' });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw validationError('import 파일 구조가 올바르지 않습니다.', { [field]: `${maxLength}자 이하여야 합니다.` });
  }
  return trimmed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  throw validationError('import 파일 구조가 올바르지 않습니다.', { [field]: 'boolean 값이 필요합니다.' });
}

function validateGroupRefs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw validationError('import 파일 구조가 올바르지 않습니다.', { groupRefs: '문자열 배열이어야 합니다.' });
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw validationError('import 파일 구조가 올바르지 않습니다.', { groupRefs: '문자열 배열이어야 합니다.' });
    }
    const name = item.trim();
    if (!name) {
      throw validationError('import 파일 구조가 올바르지 않습니다.', { groupRefs: '빈 그룹 이름은 허용되지 않습니다.' });
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(name);
  }
  return refs;
}


function importBlockReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'feed URL 검증 실패';
}

function webhookBlockReason(error: unknown): string {
  return `웹훅 차단: ${importBlockReason(error)}`;
}

function sanitizeFetchOptions(input: FetchOptions): FetchOptions {
  const output: FetchOptions = {};
  if (input.charset) output.charset = input.charset;
  if (input.userAgent) output.userAgent = input.userAgent;
  if (input.tlsMaxVersion) output.tlsMaxVersion = input.tlsMaxVersion;
  if (input.timeoutMs) output.timeoutMs = input.timeoutMs;
  return output;
}
