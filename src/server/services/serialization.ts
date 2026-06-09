import type {
  DeliveryLogDto,
  FetchLogDto,
  GroupDto,
  ModelConfigEntryDto,
  ModelUsageDto,
  SourceDto,
  TemplateDto
} from '../contracts/api.js';
import type { DeliveryLogRecord } from '../db/delivery-log.repository.js';
import type { FetchLogRecord } from '../db/fetch-log.repository.js';
import type { GroupRecord } from '../db/group.repository.js';
import type { ModelConfigRecord } from '../db/model-config.repository.js';
import type { ModelUsageRecord } from '../db/model-usage.repository.js';
import type { SourceRecord } from '../db/source.repository.js';
import type { TemplateRecord } from '../db/template.repository.js';

export function toSourceDto(source: SourceRecord, groupIds: number[], groupNames: string[], lastOutcome: FetchLogDto['outcome'] | null): SourceDto {
  return {
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

export function toGroupDto(group: GroupRecord): GroupDto {
  return {
    id: group.id,
    name: group.name,
    webhookName: group.webhookName,
    webhookAvatarUrl: group.webhookAvatarUrl,
    hasWebhook: group.webhookUrl !== null,
    maskedWebhookUrl: maskWebhookUrl(group.webhookUrl),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt
  };
}

export function toTemplateDto(template: TemplateRecord): TemplateDto {
  return {
    id: template.id,
    name: template.name,
    label: template.label,
    body: template.body,
    isBuiltin: template.isBuiltin,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

export function toModelConfigEntryDto(record: ModelConfigRecord): ModelConfigEntryDto {
  return {
    role: record.role,
    provider: record.provider,
    model: record.model,
    enabled: record.enabled,
    targetLang: record.targetLang,
    promptLogMaxBytes: record.promptLogMaxBytes
  };
}

export function toModelUsageDto(record: ModelUsageRecord): ModelUsageDto {
  return {
    id: record.id,
    role: record.role,
    provider: record.provider,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    latencyMs: record.latencyMs,
    error: record.error,
    createdAt: record.createdAt
  };
}

export function toDeliveryLogDto(record: DeliveryLogRecord): DeliveryLogDto {
  return {
    id: record.id,
    itemId: record.itemId,
    attemptNo: record.attemptNo,
    status: record.status,
    httpStatus: record.httpStatus,
    error: record.error,
    renderedBytes: record.renderedBytes,
    destinationKey: record.destinationKey,
    contentHash: record.contentHash,
    failureReason: record.failureReason,
    discordMessageId: record.discordMessageId,
    createdAt: record.createdAt
  };
}

export function toFetchLogDto(record: FetchLogRecord, sourceName: string | null): FetchLogDto {
  return {
    id: record.id,
    sourceId: record.sourceId,
    sourceName,
    outcome: record.outcome,
    httpStatus: record.httpStatus,
    itemsNew: record.itemsNew,
    itemsHistorical: record.itemsHistorical,
    itemsChanged: record.itemsChanged,
    itemsSkipped: record.itemsSkipped,
    durationMs: record.durationMs,
    error: record.error,
    createdAt: record.createdAt
  };
}

export function maskWebhookUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    const token = parts.at(-1) ?? '';
    const suffix = token.slice(-4);
    parts[parts.length - 1] = suffix ? `...${suffix}` : '...';
    url.pathname = `/${parts.join('/')}`;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '...';
  }
}
