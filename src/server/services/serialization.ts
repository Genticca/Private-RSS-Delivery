import type {
  EventLogDto,
  FetchEventStatus,
  GroupDto,
  SourceDto,
  TemplateDto
} from '../contracts/api.js';
import type { EventLogRecord } from '../db/event-log.repository.js';
import type { GroupRecord } from '../db/group.repository.js';
import type { SourceRecord } from '../db/source.repository.js';
import type { TemplateRecord } from '../db/template.repository.js';

export function toSourceDto(source: SourceRecord, groupIds: number[], groupNames: string[], lastOutcome: FetchEventStatus | null): SourceDto {
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

export function toGroupDto(group: GroupRecord): GroupDto {
  // 웹훅 토큰 원문 대신 설정 여부와 마스킹한 주소만 관리 화면에 전달한다.
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

export function toEventLogDto(record: EventLogRecord, sourceName: string | null): EventLogDto {
  return { ...record, sourceName };
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
