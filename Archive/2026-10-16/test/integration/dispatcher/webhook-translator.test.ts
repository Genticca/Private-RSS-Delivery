import { afterEach, describe, expect, it } from 'vitest';
import { WebhookDispatcher, type WebhookPostRequest, type WebhookPostResponse } from '../../../src/server/dispatcher/webhook.js';
import { DispatchTranslationService } from '../../../src/server/translator/translator.js';
import type { TranslationInput, TranslationResult } from '../../../src/server/translator/types.js';
import { addSecondsIso } from '../../../src/server/db/time.js';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';

const containers: Container[] = [];
const base = '2026-05-29T00:00:00.000Z';

afterEach(async () => {
  for (const container of containers.splice(0)) {
    await container.close();
  }
});

describe('WebhookDispatcher translation cache integration', () => {
  it('translates once before render, saves cache, and reuses it on retry', async () => {
    const container = openContainer();
    const translator = new FakeTranslator([{ title: '번역 제목', summary: '번역 요약', translated: true }]);
    const translationService = new DispatchTranslationService({ repositories: container.repositories, translator, now: () => base });
    const calls: WebhookPostRequest[] = [];
    let firstPost = true;
    const dispatcher = createDispatcher(container, translationService, async (request) => {
      calls.push(request);
      if (firstPost) {
        firstPost = false;
        return { statusCode: 500, error: 'server error' };
      }
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container, { translate: true });

    const first = await dispatcher.runDueDeliveries(base);
    const second = await dispatcher.runDueDeliveries(addSecondsIso(base, 60));

    expect(first).toEqual([{ itemId: item.id, outcome: 'retrying', attemptNo: 1, nextAttemptAt: addSecondsIso(base, 60) }]);
    expect(second).toEqual([{ itemId: item.id, outcome: 'delivered', attemptNo: 2, nextAttemptAt: null }]);
    expect(translator.calls).toEqual([{ title: 'Article', summary: 'Summary' }]);
    expect(calls.map((call) => call.payload.embeds?.[0]?.title)).toEqual(['번역 제목', '번역 제목']);
    expect(container.repositories.items.getById(item.id)).toMatchObject({
      translatedTitle: '번역 제목',
      translatedSummary: '번역 요약',
      translatedAt: base
    });
  });

  it('does not call translator and ignores stale cache when translate is off', async () => {
    const container = openContainer();
    const translator = new FakeTranslator([]);
    const translationService = new DispatchTranslationService({ repositories: container.repositories, translator, now: () => base });
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, translationService, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container, { translate: false });
    container.repositories.items.saveTranslation(item.id, 'Cached title', 'Cached summary', base);

    await dispatcher.runDueDeliveries(base);

    expect(translator.calls).toEqual([]);
    expect(calls[0]?.payload.embeds?.[0]?.title).toBe('Article');
  });

  it('does not translate no-destination items', async () => {
    const container = openContainer();
    const translator = new FakeTranslator([{ title: '번역 제목', summary: '번역 요약', translated: true }]);
    const translationService = new DispatchTranslationService({ repositories: container.repositories, translator, now: () => base });
    const dispatcher = createDispatcher(container, translationService);
    const template = container.repositories.templates.findByName('minimal');
    if (!template) throw new Error('minimal preset missing');
    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/no-destination.xml',
      templateId: template.id,
      translate: true,
      createdAt: base
    });
    const item = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'atom-no-destination-translate',
      title: 'Article',
      link: 'https://example.com/article',
      summary: 'Summary',
      contentHash: 'hash-no-destination-translate',
      nextAttemptAt: base,
      createdAt: base
    });

    const result = await dispatcher.runDueDeliveries(base);

    expect(result).toEqual([{ itemId: item.id, outcome: 'skipped', attemptNo: 1 }]);
    expect(translator.calls).toEqual([]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ deliveryStatus: 'pending', translatedTitle: null });
    expect(container.repositories.deliveryLogs.list({ itemId: item.id })).toEqual([]);
  });

  it('caches original text after translator failure so retries do not call the model again', async () => {
    const container = openContainer();
    const translator = new FakeTranslator([{ title: 'Article', summary: 'Summary', translated: false }]);
    const translationService = new DispatchTranslationService({ repositories: container.repositories, translator, now: () => base });
    let firstPost = true;
    const dispatcher = createDispatcher(container, translationService, async () => {
      if (firstPost) {
        firstPost = false;
        return { statusCode: 500, error: 'server error' };
      }
      return { statusCode: 204 };
    });
    const { item } = createPendingItem(container, { translate: true });

    await dispatcher.runDueDeliveries(base);
    await dispatcher.runDueDeliveries(addSecondsIso(base, 60));

    expect(translator.calls).toEqual([{ title: 'Article', summary: 'Summary' }]);
    expect(container.repositories.items.getById(item.id)).toMatchObject({ translatedTitle: 'Article', translatedSummary: 'Summary' });
  });

  it('auto-generates the forum thread_name from the translated title when translation is on', async () => {
    const container = openContainer();
    const translator = new FakeTranslator([{ title: '번역 제목', summary: '번역 요약', translated: true }]);
    const translationService = new DispatchTranslationService({ repositories: container.repositories, translator, now: () => base });
    const calls: WebhookPostRequest[] = [];
    const dispatcher = createDispatcher(container, translationService, async (request) => {
      calls.push(request);
      return { statusCode: 204 };
    });
    // 포럼 대상(appliedTags) + 번역 ON + threadName 미지정 → thread_name 이 원문이 아닌 번역 제목이어야 한다.
    createPendingItem(container, { translate: true, appliedTags: ['555'] });

    await dispatcher.runDueDeliveries(base);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.thread_name).toBe('번역 제목');
    expect(calls[0]?.payload.embeds?.[0]?.title).toBe('번역 제목');
  });
});

class FakeTranslator {
  readonly calls: TranslationInput[] = [];

  constructor(private readonly responses: TranslationResult[]) {}

  async translate(input: TranslationInput): Promise<TranslationResult> {
    this.calls.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error('translator queue exhausted');
    return response;
  }
}

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}

function createDispatcher(
  container: Container,
  translationService: DispatchTranslationService,
  postWebhook: (request: WebhookPostRequest) => Promise<WebhookPostResponse> = async () => ({ statusCode: 204 })
): WebhookDispatcher {
  return new WebhookDispatcher({ db: container.db, repositories: container.repositories, translationService, postWebhook });
}

function createPendingItem(container: Container, sourcePatch: { translate: boolean; appliedTags?: string[] }) {
  const template = container.repositories.templates.findByName('minimal');
  if (!template) throw new Error('minimal preset missing');
  const source = container.repositories.sources.create({
    feedUrl: 'https://example.com/feed.xml',
    name: 'Example Feed',
    templateId: template.id,
    translate: sourcePatch.translate,
    appliedTags: sourcePatch.appliedTags ?? [],
    createdAt: base
  });
  const group = container.repositories.groups.create({
    name: `Translation Group ${source.id}`,
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    createdAt: base
  });
  container.repositories.sourceGroups.setGroups(source.id, [group.id]);
  const item = container.repositories.items.insert({
    sourceId: source.id,
    atomId: `atom-${Math.random()}`,
    title: 'Article',
    link: 'https://example.com/article',
    summary: 'Summary',
    contentHash: 'hash-translation',
    nextAttemptAt: base,
    createdAt: base
  });
  return { source, item };
}
