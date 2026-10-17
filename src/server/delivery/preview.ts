import type { SourceId } from '../sources/service.js';
import type { DiscordWebhookPayload } from '../templates/render.js';
import type { NormalizedItem } from '../feed/parse.js';
import type { SourceRepository } from '../sources/repository.js';
import type { ItemRepository } from '../feed/repository.js';
import { fetchFeed } from '../net/fetch.js';
import type { FetchFeedOptions } from '../net/fetch.js';
import type { FeedFetchResult } from '../net/fetch.js';
import { notFound } from '../core/errors.js';
import { renderDiscordPayload } from '../templates/render.js';
import { buildPresetRenderContext } from '../templates/render.js';
import { validateDiscordPayload } from '../templates/payload.js';
import { applySourceWebhookOptions } from '../templates/payload.js';
import { parseFeed } from '../feed/parse.js';
import { detectProfile } from '../feed/normalize.js';
import { effectiveProfile } from '../feed/normalize.js';
import { normalize } from '../feed/normalize.js';
import { nowIso } from '../core/db.js';
import { requireObject } from '../core/input.js';
import { validationError } from '../core/errors.js';
import { optionalString } from '../core/input.js';
import { DiscordPayloadValidationError } from '../templates/payload.js';
import { PresetRenderError } from '../templates/render.js';
import type { ItemRecord } from '../feed/repository.js';
import type { GroupRepository } from '../groups/repository.js';
import type { SourceGroupRepository } from '../sources/repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import type { WebhookPostFunction } from './discord.js';
import type { SourceRecord } from '../sources/repository.js';
import type { DeliveryDestination } from './bindings.js';
import { resolveDestinationsForSource } from './bindings.js';
import { SecurityError } from '../core/errors.js';
import { postDiscordWebhook } from './discord.js';

export type PreviewMode = 'sample' | 'live';

export interface PreviewRequest {
  templateBody: string;
  sourceId?: SourceId;
  mode: PreviewMode;
}

export type PreviewErrorStage = 'fetch' | 'render' | 'validate';

export interface PreviewError {
  stage: PreviewErrorStage;
  message: string;
  path?: string;
}

export type PreviewResponse =
  | {
    ok: true;
    payload: DiscordWebhookPayload
  }
  | {
    ok: false;
    errors: PreviewError[]
  };

export type SampleItemResponse = NormalizedItem;

export interface PreviewServiceOptions {
  repositories: {
    sources: Pick<SourceRepository, 'getById'>;
    items: Pick<ItemRepository, 'latestForSource'>;
  };
  fetchFeed?: (source: Parameters<typeof fetchFeed>[0], options?: FetchFeedOptions) => Promise<FeedFetchResult>;
  fetchOptions?: FetchFeedOptions;
  now?: () => string;
}

/** 항목을 골라 템플릿 결과를 검증한다. 실제 Discord 발송과 항목 저장은 수행하지 않는다. */
export class PreviewService {
  constructor(private readonly options: PreviewServiceOptions) { }

  async preview(value: unknown): Promise<PreviewResponse> {
    const input = normalizePreviewRequest(value);
    const source = input.sourceId ? this.options.repositories.sources.getById(input.sourceId) : null;
    if (input.sourceId && !source) throw notFound('소스를 찾을 수 없습니다.');
    const renderSource = source ?? this.syntheticSource();

    let item: NormalizedItem;
    if (input.mode === 'live') {
      if (!source) return { ok: false, errors: [{ stage: 'fetch', message: 'live 미리보기에는 sourceId가 필요합니다.' }] };
      const live = await this.fetchLiveItem(source.id);
      if (!live.item) return { ok: false, errors: [{ stage: 'fetch', message: live.error }] };
      item = live.item;
    } else {
      // 저장된 항목이 없거나 소스를 선택하지 않았으면 편집 확인용 샘플을 사용한다.
      item = source ? this.sampleItem(source.id) : syntheticItem(this.now());
    }

    try {
      const rendered = renderDiscordPayload(input.templateBody, buildPresetRenderContext(item, renderSource, { useTranslationCache: false }));
      return {
        ok: true,
        payload: validateDiscordPayload(applySourceWebhookOptions(rendered, renderSource, item.title))
      };
    } catch (error) {
      return { ok: false, errors: previewErrors(error) };
    }
  }

  sampleItem(sourceId: string): SampleItemResponse {
    if (!this.options.repositories.sources.getById(sourceId)) throw notFound('소스를 찾을 수 없습니다.');
    const latest = this.options.repositories.items.latestForSource(sourceId);
    return latest ? itemRecordToNormalizedItem(latest) : syntheticItem(this.now());
  }

  private async fetchLiveItem(sourceId: string): Promise<{
    item?: NormalizedItem;
    error: string
  }> {
    const source = this.options.repositories.sources.getById(sourceId);
    if (!source) throw notFound('소스를 찾을 수 없습니다.');
    const fetcher = this.options.fetchFeed ?? fetchFeed;
    try {
      const result = await fetcher(
        {
          id: source.id,
          feedUrl: source.feedUrl,
          etag: source.etag,
          lastModified: source.lastModified,
          fetchOptions: source.fetchOptions
        },
        this.options.fetchOptions
      );
      // live 모드의 304는 새 샘플이 없다는 뜻이다. 일반 샘플로 조용히 바꾸지 않고 화면에 알린다.
      if (result.kind === 'not-modified') return { error: '피드가 변경되지 않아 미리보기할 새 항목이 없습니다.' };
      const envelopes = parseFeed(result.body);
      if (envelopes.length === 0) return { error: '피드에서 미리보기 가능한 항목을 찾지 못했습니다.' };
      const detectedProfile = source.detectedProfile ?? detectProfile(result.body, envelopes);
      const profile = effectiveProfile(source.profileSetting, detectedProfile);
      return { item: normalize(profile, envelopes[0]!), error: '' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'live 피드 미리보기에 실패했습니다.' };
    }
  }

  private syntheticSource() {
    return {
      id: 'sample',
      configRevision: 1,
      consecutiveFailures: 0,
      feedUrl: 'https://example.com/feed.xml',
      name: 'Sample Source',
      enabled: true,
      profileSetting: 'generic' as const,
      detectedProfile: null,
      initialized: true,
      deliveryCutoffAt: null,
      etag: null,
      lastModified: null,
      lastPolledAt: null,
      nextPollAt: null,
      templateId: null,
      webhookName: null,
      webhookAvatarUrl: null,
      pollIntervalSeconds: 300,
      fetchOptions: {},
      translate: false,
      silent: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      mentionEveryone: false,
      mentionHere: false,
      threadId: null,
      threadName: null,
      appliedTags: [],
      editInPlace: false,
      createdAt: this.now()
    };
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function normalizePreviewRequest(value: unknown): PreviewRequest {
  const body = requireObject(value);
  const mode = String(body.mode ?? 'sample');
  if (mode !== 'sample' && mode !== 'live') throw validationError('mode 값이 올바르지 않습니다.', { mode: 'sample 또는 live만 허용됩니다.' });
  return {
    mode,
    templateBody: optionalString(body.templateBody, 'templateBody', 20000) ?? '',
    sourceId: optionalString(body.sourceId, 'sourceId', 200) ?? undefined
  };
}

function previewErrors(error: unknown): PreviewError[] {
  if (error instanceof DiscordPayloadValidationError) {
    return error.issues.map((issue) => ({ stage: 'validate', message: issue.message, path: issue.path }));
  }
  if (error instanceof PresetRenderError) {
    return [{ stage: 'render', message: error.message }];
  }
  if (error instanceof SyntaxError) {
    return [{ stage: 'render', message: error.message }];
  }
  return [{ stage: 'render', message: error instanceof Error ? error.message : String(error) }];
}

function itemRecordToNormalizedItem(item: ItemRecord): NormalizedItem {
  return {
    atomId: item.atomId,
    title: item.title ?? '',
    link: item.link,
    publishedAt: item.publishedAt ?? undefined,
    updatedAt: item.updatedAt ?? undefined,
    author: item.author ?? undefined,
    commentsUrl: item.commentsUrl ?? undefined,
    image: item.image ?? undefined,
    summary: item.summary ?? '',
    incidentStage: item.incidentStage ?? undefined,
    contentHash: item.contentHash
  };
}

function syntheticItem(now: string): NormalizedItem {
  return {
    atomId: 'sample-item',
    title: 'Sample RSS item',
    link: 'https://example.com/item',
    publishedAt: now,
    updatedAt: now,
    author: 'rss-discord-bridge',
    summary: 'This is a sample item used for Discord payload preview.',
    contentHash: 'sample-content-hash'
  };
}

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
