import Ajv from 'ajv';
import type { ErrorObject } from 'ajv';
import type { DiscordEmbed, DiscordWebhookPayload } from '../contracts/render-context.js';

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
