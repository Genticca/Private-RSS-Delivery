import { describe, expect, it } from 'vitest';
import { buildPresetRenderContext, formatKstTimestamp, renderDiscordPayload, renderTemplate } from '../../../src/server/dispatcher/render.js';
import type { ItemRecord, SourceRecord } from '../../../src/server/db/index.js';

describe('dispatcher render', () => {
  it('escapes JSON string values without Handlebars HTML escaping', () => {
    const context = contextFrom({ summary: 'Quote " and newline\n plus <tag> & entity' });
    const rendered = renderTemplate('{"content":{{json item.summary}}}', context);
    expect(JSON.parse(rendered)).toEqual({ content: 'Quote " and newline\n plus <tag> & entity' });
    expect(rendered).not.toContain('&quot;');
  });

  it('builds a render context from stored item/source rows', () => {
    const item = itemRecord({
      title: 'Original title',
      summary: 'Original summary',
      translatedTitle: 'Translated title',
      translatedSummary: 'Translated summary',
      publishedAt: '2026-05-29T00:00:00.000Z',
      incidentStage: 'Investigating'
    });
    const source = sourceRecord({ name: null, detectedProfile: 'incident-io' });

    const context = buildPresetRenderContext(item, source);

    expect(context.item.title).toBe('Translated title');
    expect(context.item.summary).toBe('Translated summary');
    expect(context.item.publishedAtFormatted).toBe('2026-05-29 09:00 (KST)');
    expect(context.source.name).toBe('https://example.com/feed.xml');
    expect(context.source.profile).toBe('incident-io');
  });

  it('renders and validates Discord payloads', () => {
    const context = contextFrom({ title: 'Service restored', incidentStage: 'Resolved' });
    const payload = renderDiscordPayload('{"embeds":[{"title":{{json item.title}},"description":{{json (truncate item.summary 10)}},"color":{{stageColor item.incidentStage}}}]}', context);

    expect(payload.embeds?.[0]?.title).toBe('Service restored');
    expect(payload.embeds?.[0]?.description).toBe('Clean...');
    expect(payload.embeds?.[0]?.color).toBe(5763719);
  });

  it('maps known incident stages to Korean labels and passes unknown stages through', () => {
    const resolved = renderTemplate('{"stage":{{stageLabel item.incidentStage}}}', contextFrom({ incidentStage: 'Resolved' }));
    expect(JSON.parse(resolved)).toEqual({ stage: '해결됨' });

    const investigating = renderTemplate('{"stage":{{stageLabel item.incidentStage}}}', contextFrom({ incidentStage: 'Investigating' }));
    expect(JSON.parse(investigating)).toEqual({ stage: '조사 중' });

    // 매핑에 없는 현지화 원문(예: 'Incidente')은 그대로 통과한다.
    const localized = renderTemplate('{"stage":{{stageLabel item.incidentStage}}}', contextFrom({ incidentStage: 'Incidente' }));
    expect(JSON.parse(localized)).toEqual({ stage: 'Incidente' });
  });


  it('can ignore stale translation cache when the source translate toggle is off', () => {
    const context = buildPresetRenderContext(
      itemRecord({ title: 'Original title', summary: 'Original summary', translatedTitle: 'Cached title', translatedSummary: 'Cached summary' }),
      sourceRecord(),
      { useTranslationCache: false }
    );

    expect(context.item.title).toBe('Original title');
    expect(context.item.summary).toBe('Original summary');
  });

  it('formats KST timestamps deterministically', () => {
    expect(formatKstTimestamp('2026-12-31T15:30:00.000Z')).toBe('2027-01-01 00:30 (KST)');
    expect(formatKstTimestamp('not-a-date')).toBeUndefined();
  });
});

function contextFrom(itemPatch: Partial<ItemRecord> = {}) {
  return buildPresetRenderContext(itemRecord(itemPatch), sourceRecord());
}

function itemRecord(patch: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: 1,
    sourceId: 'source-1',
    atomId: 'atom-1',
    title: 'Title',
    link: 'https://example.com/item',
    summary: 'Clean summary for rendering',
    contentHash: 'hash',
    incidentStage: null,
    publishedAt: '2026-05-29T00:00:00.000Z',
    updatedAt: null,
    deliveredAt: null,
    nextAttemptAt: null,
    createdAt: '2026-05-29T00:00:00.000Z',
    author: null,
    commentsUrl: null,
    image: null,
    deliveryStatus: 'pending',
    attemptCount: 0,
    failedAt: null,
    failureReason: null,
    translatedTitle: null,
    translatedSummary: null,
    translatedAt: null,
    ...patch
  };
}

function sourceRecord(patch: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'source-1',
    feedUrl: 'https://example.com/feed.xml',
    name: 'Example Feed',
    enabled: true,
    profileSetting: 'auto',
    detectedProfile: 'generic',
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
    createdAt: '2026-05-29T00:00:00.000Z',
    ...patch
  };
}
