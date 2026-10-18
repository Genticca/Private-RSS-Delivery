/**
 * 템플릿 미리보기와 테스트 전송. 미리보기는 외부 발송 없이 렌더링하고 테스트 전송에는 별도 간격 제한을 적용한다.
 */
import type { SourceId } from '../sources/service.js';
import {
  renderDiscordPayload,
  buildPresetRenderContext,
  PresetRenderError,
  type DiscordWebhookPayload
} from '../templates/render.js';
import { parseFeed, type NormalizedItem } from '../feed/parse.js';
import type { SourceRepository, SourceGroupRepository, SourceRecord } from '../sources/repository.js';
import type { ItemRepository, ItemRecord } from '../feed/repository.js';
import { fetchFeed, type FetchFeedOptions, type FeedFetchResult } from '../net/fetch.js';
import { notFound, validationError, SecurityError } from '../core/errors.js';
import {
  validateDiscordPayload,
  applySourceWebhookOptions,
  DiscordPayloadValidationError
} from '../templates/payload.js';
import { detectProfile, effectiveProfile, normalize } from '../feed/normalize.js';
import { nowIso } from '../core/db.js';
import { requireObject, optionalString } from '../core/input.js';
import type { GroupRepository } from '../groups/repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import { postDiscordWebhook, type WebhookPostFunction } from './discord.js';
import { resolveDestinationsForSource, type DeliveryDestination } from './bindings.js';

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

  /** 샘플 또는 실제 피드를 공통 렌더러로 처리하고 오류를 fetch·render·validate 단계로 구분한다. */
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

  /** 저장 항목이 있으면 사용하고 없으면 결정된 샘플 항목으로 편집기 초기 상태를 제공한다. */
  sampleItem(sourceId: string): SampleItemResponse {
    if (!this.options.repositories.sources.getById(sourceId)) throw notFound('소스를 찾을 수 없습니다.');
    const latest = this.options.repositories.items.latestForSource(sourceId);
    return latest ? itemRecordToNormalizedItem(latest) : syntheticItem(this.now());
  }

  /** 서버를 통해 실제 피드를 읽고 정규화한다. 미리보기에서는 번역·발송 작업을 만들지 않는다. */
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

/** 보안·렌더·payload 예외를 편집기가 표시할 단계별 오류 목록으로 바꾼다. */
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

/** 실제 저장 항목이 없을 때도 프리셋을 확인할 수 있는 샘플을 만든다. */
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

  /** 테스트 표시를 붙인 실제 Discord 메시지를 보낸다. 입력·payload 검증 뒤에 발송 간격을 소비한다. */
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

  /** 소스·목적지별로 테스트 발송 간격을 제한해 실수로 연속 전송하는 것을 막는다. */
  private enforceRate(key: string): void {
    const now = this.options.now?.() ?? Date.now();
    const last = this.lastTestAt.get(key);
    if (last !== undefined && now - last < MIN_TEST_INTERVAL_MS) {
      throw validationError('테스트는 잠시 후 다시 시도하세요.');
    }
    this.lastTestAt.set(key, now);
  }
}
