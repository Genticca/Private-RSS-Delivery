import type { SourceId } from '../contracts/api.js';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import { applySourceWebhookOptions } from '../dispatcher/payload-options.js';
import {
  resolveDestinationsForSource,
  type DeliveryDestination
} from '../dispatcher/resolve-destinations.js';
import { buildPresetRenderContext, PresetRenderError, renderDiscordPayload } from '../dispatcher/render.js';
import { DiscordPayloadValidationError, validateDiscordPayload } from '../dispatcher/validate.js';
import { postDiscordWebhook, type WebhookPostFunction } from '../dispatcher/discord-client.js';
import type { SourceRecord } from '../db/index.js';
import { SecurityError } from '../security/index.js';
import type { SourceRepository, GroupRepository, SourceGroupRepository, TemplateRepository } from '../db/index.js';
import { notFound, validationError } from './errors.js';
import type { PreviewService } from './preview.service.js';

const TEST_TIMEOUT_MS = 10_000;
const TEST_MARKER = '🧪 [테스트 전송] ';
const CONTENT_MAX = 2000;
const MIN_TEST_INTERVAL_MS = 5_000;

export interface TestSendServiceOptions {
  repositories: {
    sources: Pick<SourceRepository, 'getById'>;
    groups: Pick<GroupRepository, 'getById'>;
    sourceGroups: Pick<SourceGroupRepository, 'listGroupIdsForSource'>;
    templates: Pick<TemplateRepository, 'getById' | 'findByName'>;
  };
  preview: PreviewService;
  /** 테스트에서 주입 가능 (기본 postDiscordWebhook). */
  postWebhook?: WebhookPostFunction;
  now?: () => number;
}

export interface TestSendResult {
  ok: true;
  statusCode: number;
}

/**
 * 관리자가 디스코드 웹훅이 실제로 동작하는지 확인하기 위한 1회성 테스트 전송.
 * 실제 전송 경로(렌더→옵션→검증→POST)를 재사용하되 **딜리버리 로그·아이템 상태는 일절 건드리지 않는다**.
 */
export class TestSendService {
  private readonly lastTestAt = new Map<string, number>();

  constructor(private readonly options: TestSendServiceOptions) { }

  async testSource(id: SourceId): Promise<TestSendResult> {
    const source = this.options.repositories.sources.getById(id);
    if (!source) throw notFound('소스를 찾을 수 없습니다.');

    const destinations = this.resolveDestinations(source);
    if (destinations.length === 0) {
      throw validationError('웹훅이 설정되지 않았습니다. 소스 목적지를 먼저 설정하세요.');
    }

    const destination = destinations[0]!;
    const payload = this.buildPayload(this.resolveTemplateBody(source.templateId), source, destination);
    return this.send(`source:${id}:destination:${destination.destinationKey}`, destination, payload);
  }

  private resolveDestinations(source: SourceRecord): DeliveryDestination[] {
    try {
      return resolveDestinationsForSource(source, this.options.repositories);
    } catch (error) {
      if (error instanceof SecurityError) {
        throw validationError(`목적지 웹훅이 차단되었습니다: ${error.message}`);
      }
      throw error;
    }
  }

  private resolveTemplateBody(templateId: number | null): string {
    const templates = this.options.repositories.templates;
    const template = templateId !== null ? templates.getById(templateId) ?? templates.findByName('minimal') : templates.findByName('minimal');
    if (!template) throw validationError('전송에 사용할 템플릿을 찾을 수 없습니다.');
    return template.body;
  }

  /** 실제 dispatcher와 같은 렌더/옵션 경로를 사용하되 번역은 적용하지 않는다. */
  private buildPayload(templateBody: string, source: SourceRecord, destination: DeliveryDestination): DiscordWebhookPayload {
    try {
      const item = this.options.preview.sampleItem(source.id);
      const rendered = renderDiscordPayload(templateBody, buildPresetRenderContext(item, source, { useTranslationCache: false }));
      const marked: DiscordWebhookPayload = {
        ...rendered,
        content: TEST_MARKER + (rendered.content ?? '')
      };
      const withOptions = applySourceWebhookOptions(marked, source, item.title);
      return validateDiscordPayload({
        ...withOptions,
        content: (withOptions.content ?? '').slice(0, CONTENT_MAX)
      });
    } catch (error) {
      if (error instanceof DiscordPayloadValidationError) {
        throw validationError(`테스트 메시지를 만들 수 없습니다: ${error.issues.map((issue) => issue.message).join('; ')}`);
      }
      if (error instanceof PresetRenderError) {
        throw validationError(`테스트 메시지를 만들 수 없습니다: ${error.message}`);
      }
      throw error;
    }
  }

  private async send(rateKey: string, destination: DeliveryDestination, payload: DiscordWebhookPayload): Promise<TestSendResult> {
    // 전송 시점에 destination 의 발신 이름/아바타를 덮어쓴다(실제 전송과 동일).
    const finalPayload: DiscordWebhookPayload = {
      ...payload,
      username: destination.webhookName ?? payload.username,
      avatar_url: destination.webhookAvatarUrl ?? payload.avatar_url
    };

    const post = this.options.postWebhook ?? postDiscordWebhook;
    let statusCode: number;
    let error: string | undefined;
    // postDiscordWebhook 이 저장된 URL 을 다시 SSRF 검증한 뒤 SSRF-safe agent 로 POST 한다.
    this.enforceRate(rateKey);
    try {
      const response = await post({
        destination,
        payload: finalPayload,
        timeoutMs: TEST_TIMEOUT_MS,
        captureMessageId: false
      });
      statusCode = response.statusCode;
      error = response.error;
    } catch (cause) {
      throw validationError(`테스트 전송에 실패했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (statusCode >= 200 && statusCode < 300) {
      return { ok: true, statusCode };
    }
    throw validationError(`테스트 전송이 거부되었습니다 (HTTP ${statusCode}).${error ? ` ${error.slice(0, 200)}` : ''}`);
  }

  private enforceRate(key: string): void {
    const now = this.options.now?.() ?? Date.now();
    const last = this.lastTestAt.get(key);
    if (last !== undefined && now - last < MIN_TEST_INTERVAL_MS) {
      throw validationError('테스트는 잠시 후 다시 시도하세요.');
    }
    this.lastTestAt.set(key, now);
  }
}
