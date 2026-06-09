import type { PreviewError, PreviewRequest, PreviewResponse, SampleItemResponse } from '../contracts/api.js';
import type { ItemRecord } from '../db/item.repository.js';
import { nowIso } from '../db/time.js';
import { parseFeed } from '../domain/envelope/index.js';
import { detectProfile, effectiveProfile, normalize } from '../domain/normalize/index.js';
import type { NormalizedItem } from '../domain/normalize/types.js';
import { applySourceWebhookOptions } from '../dispatcher/payload-options.js';
import { buildPresetRenderContext, PresetRenderError, renderDiscordPayload } from '../dispatcher/render.js';
import { DiscordPayloadValidationError, validateDiscordPayload } from '../dispatcher/validate.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { fetchFeed, type FetchFeedOptions, type FeedFetchResult } from '../security/index.js';
import { notFound, validationError } from './errors.js';
import { optionalString, requireObject } from './validation.js';

export interface PreviewServiceOptions {
  repositories: RepositoryRegistry;
  fetchFeed?: (source: Parameters<typeof fetchFeed>[0], options?: FetchFeedOptions) => Promise<FeedFetchResult>;
  fetchOptions?: FetchFeedOptions;
  now?: () => string;
}

export class PreviewService {
  constructor(private readonly options: PreviewServiceOptions) {}

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

  private async fetchLiveItem(sourceId: string): Promise<{ item?: NormalizedItem; error: string }> {
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
      webhookUrl: null,
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
