import { describe, expect, it, vi } from 'vitest';
import { harness, BASE, WEBHOOK_B } from '../../mocks/runtime.js';
import { DispatchTranslationService } from '../../../src/server/translator/translator.js';
import { TranslationProviderError, type TranslationInput, type TranslationResult } from '../../../src/server/translator/types.js';
import { addSecondsIso } from '../../../src/server/db/time.js';
import { requiredTranslationFields } from '../../../src/server/domain/translation/policy.js';

function fakeTranslator() {
  return { translate: vi.fn(async (input: TranslationInput): Promise<TranslationResult> => ({
    title: '번역 ' + input.title, summary: '번역 ' + input.summary, translated: true
  })) };
}

describe('shared translation cache and frozen delivery payload', () => {
  it('delivers fallback-key translations and reuses the frozen payload on a Discord retry', async () => {
    const provider = { generate: vi.fn()
      .mockRejectedValueOnce(new TranslationProviderError('primary quota', 429))
      .mockResolvedValueOnce({ text: '{"title":"대체 키 번역 제목","summary":"대체 키 번역 본문"}' }) };
    const h = await harness({ translate: true }, {
      env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'dispatch-primary', FALLBACK_MODEL_API_KEY: 'dispatch-fallback' },
      translationProvider: provider
    });
    await h.baseline(); await h.poll([{ id: 'one', title: 'Article', summary: 'Body' }]);
    h.post.mockResolvedValueOnce({ statusCode: 429, retryAfterMs: 1000 });
    await h.run(); await h.run(addSecondsIso(BASE, 2));
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(provider.generate.mock.calls.map(([request]) => request.apiKey)).toEqual(['dispatch-primary', 'dispatch-fallback']);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls.every(([request]) => request.payload.embeds?.[0]?.title === '대체 키 번역 제목')).toBe(true);
    expect(h.jobs()[0].state).toBe('succeeded');
    expect(h.r.eventLog.list({ kind: 'translation' }).map(({ status, detail }) => ({ status, detail }))).toContainEqual({ status: 'success', detail: 'fallback:success' });
  });

  it('reuses a successful translation for the same item and another item with identical input', async () => {
    const h = await harness({ translate: true }); await h.baseline();
    await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }, { id: 'two', title: 'Title', summary: 'Body' }]);
    const translator = fakeTranslator();
    const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    await service.translateItemForDispatch(h.item('two'), h.source(), BASE);
    expect(translator.translate).toHaveBeenCalledTimes(1);
    expect(h.r.eventLog.countByStatus('translation').cache_hit).toBe(4);
  });

  it('reuses title cache and requests only a changed summary', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'First body' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    await h.poll([{ id: 'one', title: 'Title', summary: 'Second body' }]);
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    expect(translator.translate.mock.calls[1][0]).toMatchObject({ title: '', summary: 'Second body' });
    expect(h.item().contentRevision).toBe(1);
  });

  it('coalesces concurrent identical field inputs into one request', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }, { id: 'two', title: 'Title', summary: 'Body' }]);
    let release!: (value: TranslationResult) => void;
    const translator = { translate: vi.fn(() => new Promise<TranslationResult>((resolve) => { release = resolve; })) };
    const service = new DispatchTranslationService({ repositories: h.r, translator });
    const first = service.translateItemForDispatch(h.item(), h.source(), BASE);
    const second = service.translateItemForDispatch(h.item('two'), h.source(), BASE);
    release({ title: '제목', summary: '본문', translated: true });
    await Promise.all([first, second]); expect(translator.translate).toHaveBeenCalledTimes(1);
  });

  it('requests title only for the minimal preset', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Long body' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE, { templateBody: h.r.templates.findByName('minimal')!.body });
    expect(translator.translate.mock.calls[0][0]).toMatchObject({ title: 'Title', summary: '' });
  });

  it('conservatively translates both fields for dynamic template references', async () => {
    const h = await harness();
    expect(requiredTranslationFields('{{lookup item field}}', h.source()).sort()).toEqual(['summary', 'title']);
    expect(requiredTranslationFields('{{#with item}}{{title}}{{/with}}', h.source()).sort()).toEqual(['summary', 'title']);
  });

  it('detects bracket notation and nested access through template AST path parts', async () => {
    const h = await harness();
    expect(requiredTranslationFields('{{json item.[summary]}}', h.source())).toEqual(['summary']);
    expect(requiredTranslationFields('{{item.summary.length}}', h.source())).toEqual(['summary']);
  });

  it('clears reserved single-flight work when cache bookkeeping fails before model execution', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: '한국어 본문' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    const originalAppend = h.r.eventLog.append.bind(h.r.eventLog);
    h.r.eventLog.append = () => { throw new Error('cache bookkeeping failed'); };
    await expect(service.translateItemForDispatch(h.item(), h.source(), BASE)).rejects.toThrow('cache bookkeeping failed');
    h.r.eventLog.append = originalAppend;
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    expect(translator.translate).toHaveBeenCalledTimes(1);
  });

  it('includes an automatically generated forum title even when the template uses only the link', async () => {
    const h = await harness({ appliedTags: ['555'] });
    expect(requiredTranslationFields('{"content": {{json item.link}} }', h.source())).toEqual(['title']);
  });

  it('separates failed cooldown from successful cache and allows a later successful translation', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]);
    const translator = fakeTranslator();
    translator.translate.mockResolvedValueOnce({ title: 'Title', summary: 'Body', translated: false });
    const service = new DispatchTranslationService({ repositories: h.r, translator });
    expect((await service.translateItemForDispatch(h.item(), h.source(), BASE)).translatedTitle).toBe('Title');
    await service.translateItemForDispatch(h.item(), h.source(), addSecondsIso(BASE, 60));
    expect(translator.translate).toHaveBeenCalledTimes(1);
    expect(h.r.eventLog.countByStatus('translation').skipped).toBe(2);
    const later = await service.translateItemForDispatch(h.item(), h.source(), addSecondsIso(BASE, 301));
    expect(translator.translate).toHaveBeenCalledTimes(2);
    expect(later.translatedTitle).toBe('번역 Title');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('handles empty and clearly Korean input locally', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: '장애가 해결되었습니다', summary: '' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    expect(translator.translate).not.toHaveBeenCalled(); expect(h.r.eventLog.countByStatus('translation').skipped).toBe(2);
  });

  it('translates ordinary text that overlaps an Object prototype property', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'constructor', summary: 'Body' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    const result = await service.translateItemForDispatch(h.item(), h.source(), BASE);
    expect(translator.translate).toHaveBeenCalledTimes(1); expect(result.translatedTitle).toBe('번역 constructor');
  });

  it('uses distinct cache keys for different normalization contexts', async () => {
    const h = await harness({ translate: true }); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    await service.translateItemForDispatch(h.item(), { ...h.source(), profileSetting: 'incident-io' }, BASE);
    expect(translator.translate).toHaveBeenCalledTimes(2);
  });

  it('does not call translation when source translation is disabled', async () => {
    const h = await harness({ translate: false }); await h.baseline(); await h.poll([{ id: 'one' }]);
    const translator = fakeTranslator(); const service = new DispatchTranslationService({ repositories: h.r, translator });
    await service.translateItemForDispatch(h.item(), h.source(), BASE);
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it('shares translation across destination jobs and renders translated forum titles', async () => {
    const provider = { generate: vi.fn(async () => ({ text: '{"title":"번역 제목","summary":"번역 본문"}' })) };
    const h = await harness({ translate: true, appliedTags: ['555'] }, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test-key' }, translationProvider: provider });
    const b = await h.container.services.groups.create({ name: 'B', webhookUrl: WEBHOOK_B });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, b.id] }); await h.baseline();
    await h.poll([{ id: 'one' }]); await h.run();
    expect(provider.generate).toHaveBeenCalledTimes(1); expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls.every(([request]) => request.payload.thread_name === '번역 제목')).toBe(true);
  });

  it('pins original fallback payload across Discord rate-limit retry without pretending translation succeeded', async () => {
    const provider = { generate: vi.fn(async () => ({ text: 'invalid JSON' })) };
    const h = await harness({ translate: true }, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test-key' }, translationProvider: provider });
    await h.baseline(); await h.poll([{ id: 'one', title: 'Article' }]);
    h.post.mockResolvedValueOnce({ statusCode: 429, retryAfterMs: 1000 });
    await h.run(); await h.run(addSecondsIso(BASE, 301));
    expect(provider.generate).toHaveBeenCalledTimes(1); expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls.every(([request]) => request.payload.embeds?.[0]?.title === 'Article')).toBe(true);
    expect(h.r.eventLog.countByStatus('translation')).toEqual({ failed: 1 });
  });

  it('does not translate a cancelled connection job', async () => {
    const provider = { generate: vi.fn(async () => ({ text: '{"title":"번역","summary":""}' })) };
    const h = await harness({ translate: true }, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test-key' }, translationProvider: provider });
    await h.baseline(); await h.poll([{ id: 'one' }]);
    await h.container.services.groups.update(h.group.id, { clearWebhook: true }); await h.run();
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('does not persist credentials echoed in a provider exception', async () => {
    const secret = 'fixture-credential-do-not-store';
    const h = await harness({ translate: true }, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: secret },
      translationProvider: { generate: async () => { throw new Error('request failed key=' + secret); } } });
    await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    const usage = h.container.db.prepare('SELECT detail FROM event_log').all();
    expect(usage).toContainEqual({ detail: 'provider-error' });
    expect(JSON.stringify(usage)).not.toContain(secret);
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
