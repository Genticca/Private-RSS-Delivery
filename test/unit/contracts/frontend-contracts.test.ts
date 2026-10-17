import { describe, expect, it } from 'vitest';
import { SOURCE_PROFILE_OPTIONS } from '../../../src/server/domain/normalize/types.js';
import {
  PRESET_HELPERS,
  PRESET_VARIABLES,
  type PresetRenderContext
} from '../../../src/server/contracts/render-context.js';
import type {
  DashboardViewModel,
  LogsViewModel,
  SourceFormViewModel,
  TemplateEditorViewModel
} from '../../../src/server/contracts/view-models.js';
import type {
  GroupDto,
  LogsResponse,
  ModelDiagnosticsResponse,
  PreviewError,
  SourceDto
} from '../../../src/server/contracts/api.js';

describe('Turn 0 frontend/backend contracts', () => {
  it('freezes preset render variables and helpers for Gemini templates', () => {
    expect(PRESET_VARIABLES).toEqual([
      'item.title',
      'item.link',
      'item.summary',
      'item.publishedAtFormatted',
      'item.author',
      'source.name',
      'item.incidentStage',
      'item.commentsUrl',
      'item.image',
      'source.feedUrl',
      'source.profile'
    ]);
    expect(PRESET_HELPERS).toEqual(['truncate', 'stageColor', 'stageLabel', 'eq', 'json']);
  });

  it('defines the server-side preset render context', () => {
    const context = {
      item: {
        atomId: 'https://example.com/feed/1',
        title: 'Article',
        link: 'https://example.com/article',
        summary: 'Clean summary',
        contentHash: 'hash',
        publishedAtFormatted: '2026-05-28 00:00 UTC',
        commentsUrl: 'https://example.com/comments',
        image: 'https://example.com/image.png'
      },
      source: {
        id: 'source-1',
        name: 'Example RSS',
        feedUrl: 'https://example.com/feed.xml',
        profile: 'generic'
      }
    } satisfies PresetRenderContext;

    expect(context.item.title).toBe('Article');
    expect(context.source.profile).toBe('generic');
  });

  it('keeps API DTOs free of raw webhook secrets and aligned with cursor envelopes', () => {
    const source = {
      id: 'source-1',
      feedUrl: 'https://example.com/feed.xml',
      name: 'Example RSS',
      enabled: true,
      profile: 'generic',
      detectedProfile: null,
      pollIntervalSeconds: 300,
      translate: false,
      templateId: null,
      webhookName: null,
      webhookAvatarUrl: null,
      groupIds: [],
      groupNames: [],
      silent: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      mentionEveryone: false,
      mentionHere: false,
      threadId: null,
      threadName: null,
      appliedTags: [],
      editInPlace: false,
      lastOutcome: 'ok'
    } satisfies SourceDto;

    const group = {
      id: 1,
      name: 'Security',
      webhookName: null,
      webhookAvatarUrl: null,
      hasWebhook: false,
      maskedWebhookUrl: null,
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:00:00.000Z'
    } satisfies GroupDto;

    const logs = {
      items: [
        {
          id: 10,
          createdAt: '2026-05-28T00:00:00.000Z',
          kind: 'delivery',
          status: 'success',
          sourceId: 'source-1',
          sourceName: 'Example RSS',
          itemId: 1,
          jobId: 3,
          httpStatus: 204,
          durationMs: null,
          itemCount: null,
          detail: '발송 → Security'
        }
      ],
      nextBefore: 10
    } satisfies LogsResponse;

    const model = {
      model: 'gemini-3.1-flash-lite',
      status: 'ready',
      lastRequestAt: null,
      lastRequestResult: '아직 호출하지 않음',
      counts: { success: 0, failed: 0, cache_hit: 0, skipped: 0 }
    } satisfies ModelDiagnosticsResponse;

    const previewError = { stage: 'validate', message: 'Invalid payload', path: '/embeds/0/title' } satisfies PreviewError;

    expect('webhookUrl' in source).toBe(false);
    expect('webhookUrl' in group).toBe(false);
    expect(logs.nextBefore).toBe(10);
    expect('apiKey' in model).toBe(false);
    expect(previewError.stage).toBe('validate');
  });

  it('keeps page view-model shapes aligned with backend-spec', () => {
    const dashboard = {
      sources: [{ id: 'source-1', name: 'Example RSS', enabled: true, lastOutcome: 'ok', profile: 'generic' }],
      counts: { sources: 1, enabled: 1, errors: 0 }
    } satisfies DashboardViewModel;

    const sourceForm = {
      source: null,
      groups: [],
      templates: [],
      profiles: SOURCE_PROFILE_OPTIONS
    } satisfies SourceFormViewModel;

    const templateEditor = {
      template: {
        id: 1,
        name: 'minimal',
        label: 'Minimal',
        body: '{ "embeds": [] }',
        isBuiltin: true,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z'
      },
      presetVars: PRESET_VARIABLES,
      sources: [{ id: 'source-1', name: 'Example RSS' }],
      needsCodeMirror: true
    } satisfies TemplateEditorViewModel;

    const logs = {} satisfies LogsViewModel;

    expect(dashboard.counts.errors).toBe(0);
    expect(dashboard.sources).toHaveLength(1);
    expect(logs).toEqual({});
    expect(sourceForm.profiles).toContain('auto');
    expect(templateEditor.presetVars).toContain('item.summary');
  });
});
