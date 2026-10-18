/**
 * 설정 이전 문서의 계약·검증. 외부 JSON을 내부 입력으로 정규화하고 내보내면 안 되는 요청 헤더를 걸러낸다.
 */
import type { FetchOptions } from '../net/fetch.js';
import { validationError } from '../core/errors.js';
import { requiredString } from '../core/input.js';
import { normalizeSourceCreate, validateFetchOptions } from '../sources/input.js';

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
  /** @deprecated 이전 문서 가져오기 전용이다. 내보내기에는 웹훅 원문을 포함하지 않는다. */
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

type ImportGroupWithLegacyWebhook = ExportGroup & {
  webhookUrl?: unknown
};

export type ImportMode = 'skip' | 'overwrite';

export function parseImportMode(value: unknown): ImportMode {
  if (value === undefined || value === null || value === '' || value === 'skip') return 'skip';
  if (value === 'overwrite') return 'overwrite';
  throw validationError('import mode 값이 올바르지 않습니다.', { mode: 'skip 또는 overwrite만 허용됩니다.' });
}

/** 지원하는 문서 kind·version을 먼저 확인해 임의 JSON을 설정 문서로 해석하지 않게 한다. */
export function parseDocument(payload: string): ExportDocumentV1 {
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

/** 그룹·소스 필드와 중복 이름·URL을 검증하고 내부 서비스가 읽을 형태로 정규화한다. */
export function validateDocument(document: ExportDocumentV1): void {
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
    group.legacyWebhookUrl = validateOptionalString(
      (group as ImportGroupWithLegacyWebhook).webhookUrl ?? group.legacyWebhookUrl,
      'groups.webhookUrl',
      2048
    );
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

/** 이전 파일에 인증·쿠키 같은 민감 헤더를 실어 보내지 않도록 내보내기용 옵션을 제한한다. */
export function sanitizeFetchOptions(input: FetchOptions): FetchOptions {
  const output: FetchOptions = {};
  if (input.charset) output.charset = input.charset;
  if (input.userAgent) output.userAgent = input.userAgent;
  if (input.tlsMaxVersion && !input.tlsPinnedAt) output.tlsMaxVersion = input.tlsMaxVersion;
  if (input.timeoutMs) output.timeoutMs = input.timeoutMs;
  return output;
}
