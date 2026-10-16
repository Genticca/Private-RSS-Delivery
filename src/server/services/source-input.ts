import type { CreateSourceRequest, UpdateSourceRequest } from '../contracts/api.js';
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
