import { afterEach, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';
import { resolveModelName } from '../../../src/server/translator/keys.js';
import { ModelTranslator } from '../../../src/server/translator/translator.js';
import { TranslationProviderError, type TranslationProvider, type TranslationProviderRequest, type TranslationProviderResponse } from '../../../src/server/translator/types.js';

const containers: Container[] = [];
const base = '2026-05-29T00:00:00.000Z';

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('ModelTranslator', () => {
  it('translates with the configured Gemini model and records the request', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([{ text: '{"title":"번역 제목","summary":"번역 요약"}', inputTokens: 11, outputTokens: 7 }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      model: 'gemini-test-model',
      provider: gemini,
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: '번역 제목', summary: '번역 요약', translated: true });
    expect(gemini.calls).toHaveLength(1);
    expect(gemini.calls[0]).toMatchObject({ apiKey: 'primary-key', model: 'gemini-test-model' });
    expect(translationEvents(container)).toEqual([{ status: 'success', detail: null }]);
  });

  it('returns original text after an invalid key error', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([new TranslationProviderError('invalid key', 401)]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'bad-key' },
      provider: gemini,
      now: () => base
    });

    const result = await translator.translate({ title: 'Title', summary: 'Summary' });

    expect(result).toEqual({ title: 'Title', summary: 'Summary', translated: false });
    expect(gemini.calls).toHaveLength(1);
    expect(translationEvents(container)).toEqual([{ status: 'failed', detail: 'invalid-key' }]);
    expect(container.services.model.getDiagnostics()).toMatchObject({ lastRequestAt: base, lastRequestResult: 'invalid-key' });
  });

  it('returns original text when the provider returns length-truncated output', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([{ text: '{"title":"partial"', finishReason: 'MAX_TOKENS' }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      provider: gemini,
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(translationEvents(container)).toEqual([{ status: 'failed', detail: 'length' }]);
  });

  it('returns original text when the provider returns unparsable JSON', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([{ text: 'not-json' }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      provider: gemini,
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(translationEvents(container)).toEqual([{ status: 'failed', detail: 'parse' }]);
  });

  it('aborts and returns original text when the provider times out', async () => {
    const container = openContainer();
    const gemini = new HangingProvider();
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      provider: gemini,
      now: () => base,
      providerTimeoutMs: 5
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(gemini.calls).toHaveLength(1);
    expect(gemini.calls[0]?.signal?.aborted).toBe(true);
    expect(translationEvents(container)).toEqual([{ status: 'failed', detail: 'timeout' }]);
  });

  it('records a missing key as skipped without calling the provider', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: {},
      provider: gemini,
      now: () => base
    });

    const result = await translator.translate({ title: 'Title', summary: 'Summary' });

    expect(result).toEqual({ title: 'Title', summary: 'Summary', translated: false });
    expect(gemini.calls).toEqual([]);
    expect(translationEvents(container)).toEqual([{ status: 'skipped', detail: 'missing-key' }]);
    expect(container.services.model.getDiagnostics().status).toBe('missing-key');
  });

  it('reads the model name from GEMINI_MODEL and rejects non-Gemini names', () => {
    expect(resolveModelName({})).toBe('gemini-3.1-flash-lite');
    expect(resolveModelName({ GEMINI_MODEL: ' gemini-2.5-pro ' })).toBe('gemini-2.5-pro');
    expect(() => resolveModelName({ GEMINI_MODEL: 'nvidia/llama' })).toThrow('GEMINI_MODEL');
    expect(() => createContainer({ env: { DATABASE_PATH: ':memory:', GEMINI_MODEL: 'gpt-4o' } })).toThrow('GEMINI_MODEL');
  });
});

class HangingProvider implements TranslationProvider {
  readonly calls: TranslationProviderRequest[] = [];

  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    this.calls.push(request);
    return new Promise(() => undefined);
  }
}

class FakeProvider implements TranslationProvider {
  readonly calls: TranslationProviderRequest[] = [];

  constructor(private readonly responses: Array<TranslationProviderResponse | Error>) {}

  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('provider queue exhausted');
    if (response instanceof Error) throw response;
    return response;
  }
}

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}

function translationEvents(container: Container): Array<{ status: string; detail: string | null }> {
  return container.repositories.eventLog.list({ kind: 'translation' }).map(({ status, detail }) => ({ status, detail }));
}
