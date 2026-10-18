/**
 * Discord payload 규칙. 소스의 멘션·스레드 옵션을 적용하고 필드·본문 길이 제한을 검사한다.
 */
import Ajv, { type ErrorObject } from 'ajv';
import type { DiscordWebhookPayload, DiscordEmbed } from './render.js';

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

/** 원본 payload를 복사한 뒤 소스의 조용한 발송·멘션·포럼 옵션을 적용한다. */
export function applySourceWebhookOptions(
  payload: DiscordWebhookPayload,
  source: MessageOptions,
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

/** 허용된 멘션 설정에 맞춰 본문 앞 멘션 문자열을 조립한다. */
function buildMentionPrefix(options: MentionOptions): string {
  const parts = [
    options.mentionEveryone ? '@everyone' : null,
    options.mentionHere ? '@here' : null,
    ...options.mentionRoleIds.map((id) => `<@&${id}>`),
    ...options.mentionUserIds.map((id) => `<@${id}>`)
  ].filter((part): part is string => part !== null);
  return parts.join(' ');
}

export interface DiscordPayloadValidationIssue {
  path: string;
  message: string;
}

export class DiscordPayloadValidationError extends Error {
  constructor(readonly issues: DiscordPayloadValidationIssue[]) {
    super(formatValidationMessage(issues));
    this.name = 'DiscordPayloadValidationError';
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });

const payloadSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    content: { type: 'string', maxLength: 2000 },
    username: { type: 'string', maxLength: 80 },
    avatar_url: { type: 'string' },
    flags: { type: 'integer', minimum: 0 },
    thread_name: { type: 'string', maxLength: 100 },
    applied_tags: { type: 'array', maxItems: 5, items: { type: 'string' } },
    embeds: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          title: { type: 'string', maxLength: 256 },
          description: { type: 'string', maxLength: 4096 },
          url: { type: 'string' },
          color: { type: 'integer', minimum: 0, maximum: 16777215 },
          timestamp: { type: 'string' },
          fields: {
            type: 'array',
            maxItems: 25,
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['name', 'value'],
              properties: {
                name: { type: 'string', maxLength: 256 },
                value: { type: 'string', maxLength: 1024 },
                inline: { type: 'boolean' }
              }
            }
          },
          footer: {
            type: 'object',
            additionalProperties: true,
            required: ['text'],
            properties: {
              text: { type: 'string', maxLength: 2048 },
              icon_url: { type: 'string' }
            }
          },
          author: {
            type: 'object',
            additionalProperties: true,
            required: ['name'],
            properties: {
              name: { type: 'string', maxLength: 256 },
              url: { type: 'string' },
              icon_url: { type: 'string' }
            }
          },
          thumbnail: {
            type: 'object',
            additionalProperties: true,
            required: ['url'],
            properties: { url: { type: 'string' } }
          },
          image: {
            type: 'object',
            additionalProperties: true,
            required: ['url'],
            properties: { url: { type: 'string' } }
          }
        }
      }
    },
    allowed_mentions: { type: 'object', additionalProperties: true }
  }
} as const;

const validatePayloadShape = ajv.compile(payloadSchema);

const MAX_EMBED_TEXT_LENGTH = 6000;

/** AJV 구조 검사와 Discord의 본문·embed 길이 검사를 함께 수행한다. */
export function validateDiscordPayload(payload: unknown): DiscordWebhookPayload {
  const issues: DiscordPayloadValidationIssue[] = [];
  if (!validatePayloadShape(payload)) {
    issues.push(...formatAjvErrors(validatePayloadShape.errors ?? []));
  }
  if (payload && typeof payload === 'object') {
    // 개별 필드의 길이 제한과 별도로 모든 embed의 텍스트 합계도 검사한다.
    const total = getEmbedTextLength(payload as DiscordWebhookPayload);
    if (total > MAX_EMBED_TEXT_LENGTH) {
      issues.push({ path: '/embeds', message: `embed text total must be <= 6000 characters (got ${total}).` });
    }
  }
  if (issues.length > 0) {
    throw new DiscordPayloadValidationError(issues);
  }
  return payload as DiscordWebhookPayload;
}

/** embed별 길이를 합산해 메시지 전체의 텍스트 제한을 검사할 수 있게 한다. */
function getEmbedTextLength(payload: DiscordWebhookPayload): number {
  return (payload.embeds ?? []).reduce((total, embed) => total + getSingleEmbedTextLength(embed), 0);
}

function getSingleEmbedTextLength(embed: DiscordEmbed): number {
  let total = 0;
  total += textLength(embed.title);
  total += textLength(embed.description);
  total += textLength(embed.footer?.text);
  total += textLength(embed.author?.name);
  for (const field of embed.fields ?? []) {
    total += textLength(field.name);
    total += textLength(field.value);
  }
  return total;
}

function textLength(value: string | undefined): number {
  return value?.length ?? 0;
}

/** 검증 라이브러리의 내부 표현을 관리 화면이 표시할 필드 경로·문구로 바꾼다. */
function formatAjvErrors(errors: ErrorObject[]): DiscordPayloadValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? 'Invalid Discord payload.'
  }));
}

function formatValidationMessage(issues: readonly DiscordPayloadValidationIssue[]): string {
  if (issues.length === 0) return 'Invalid Discord payload.';
  return `Invalid Discord payload: ${issues[0].path} ${issues[0].message}`;
}

export interface MessageOptions {
  silent: boolean;
  threadId: string | null;
  threadName: string | null;
  appliedTags: readonly string[];
  mentionEveryone: boolean;
  mentionHere: boolean;
  mentionRoleIds: readonly string[];
  mentionUserIds: readonly string[];
}
