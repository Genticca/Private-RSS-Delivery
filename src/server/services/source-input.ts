import type { CreateSourceRequest } from '../contracts/api.js';
import { requireObject } from '../core/input.js';
import { validateFeedUrl } from './validation.js';
import { optionalString } from '../core/input.js';
import { parseSourceProfile } from './validation.js';
import { optionalInteger } from '../core/input.js';
import { optionalBoolean } from '../core/input.js';
import { validateOptionalHttpUrl } from './validation.js';
import { validateFetchOptions } from './validation.js';
import { parseGroupIds } from './validation.js';
import { parseDiscordIdList } from '../core/input.js';
import { parseDiscordId } from '../core/input.js';
import { parseDiscordTagIds } from '../core/input.js';
import type { UpdateSourceRequest } from '../contracts/api.js';

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
  // undefined는 기존 값 유지, null은 명시적 비우기다. 부분 수정에서 두 값을 구분한다.
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
