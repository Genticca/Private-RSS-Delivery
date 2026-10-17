import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import type { SourceRecord } from '../db/source.repository.js';

export const SUPPRESS_NOTIFICATIONS_FLAG = 4096;

/** Discord thread_name 최대 길이(초과 시 페이로드 검증에서 거부됨). */
const MAX_THREAD_NAME_LENGTH = 100;

/** 포럼 신규 스레드인데 제목 후보가 모두 비었을 때 쓰는 최소 보장값. */
const DEFAULT_FORUM_THREAD_NAME = '새 게시물';

interface MentionOptions {
  mentionEveryone: boolean;
  mentionHere: boolean;
  mentionRoleIds: readonly string[];
  mentionUserIds: readonly string[];
}

export function applySourceWebhookOptions(
  payload: DiscordWebhookPayload,
  source: SourceRecord,
  fallbackThreadName?: string | null
): DiscordWebhookPayload {
  const next: DiscordWebhookPayload = { ...payload };

  if (source.silent) {
    next.flags = (next.flags ?? 0) | SUPPRESS_NOTIFICATIONS_FLAG;
  }

  const threadId = source.threadId;
  const appliedTags = source.appliedTags;

  // 포럼/미디어 채널에 신규 스레드로 발행할 때 thread_name이 없으면 Discord가 400으로 거부한다.
  // 관리자가 스레드 제목을 비워 두면 항목 제목으로 자동 생성한다(기존 thread_id 대상은 제외).
  const explicitThreadName = clampThreadName(source.threadName);
  const threadName =
    explicitThreadName ??
    (!threadId && appliedTags.length > 0
      ? clampThreadName(fallbackThreadName) ?? DEFAULT_FORUM_THREAD_NAME
      : null);
  if (threadName) {
    next.thread_name = threadName;
  }

  if (appliedTags.length > 0) {
    next.applied_tags = [...appliedTags];
  }

  const mentionOptions: MentionOptions = {
    mentionEveryone: source.mentionEveryone,
    mentionHere: source.mentionHere,
    mentionRoleIds: source.mentionRoleIds,
    mentionUserIds: source.mentionUserIds
  };
  const mentionPrefix = buildMentionPrefix(mentionOptions);
  if (mentionPrefix) {
    next.content = [mentionPrefix, next.content].filter((part): part is string => Boolean(part)).join(' ');
  }

  next.allowed_mentions = {
    ...next.allowed_mentions,
    parse: mentionOptions.mentionEveryone || mentionOptions.mentionHere ? ['everyone'] : [],
    roles: [...mentionOptions.mentionRoleIds],
    users: [...mentionOptions.mentionUserIds]
  };

  return next;
}

/** 공백 정리 후 비어 있으면 null, 100자를 넘으면 잘라낸 thread_name 후보를 돌려준다. */
function clampThreadName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_THREAD_NAME_LENGTH ? trimmed.slice(0, MAX_THREAD_NAME_LENGTH) : trimmed;
}

function buildMentionPrefix(options: MentionOptions): string {
  const parts = [
    options.mentionEveryone ? '@everyone' : null,
    options.mentionHere ? '@here' : null,
    ...options.mentionRoleIds.map((id) => `<@&${id}>`),
    ...options.mentionUserIds.map((id) => `<@${id}>`)
  ].filter((part): part is string => part !== null);
  return parts.join(' ');
}
