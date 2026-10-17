import type { Container } from '../../../src/server/container.js';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { ModelTranslator } from '../../../src/server/translator/translator.js';
import { expect } from 'vitest';
import { TranslationProviderError } from '../../../src/server/translator/types.js';
import { resolveModelName } from '../../../src/server/translator/keys.js';
import { createContainer } from '../../../src/server/container.js';
import type { TranslationProviderRequest } from '../../../src/server/translator/types.js';
import type { TranslationProvider } from '../../../src/server/translator/types.js';
import { resolveModelCredentials } from '../../../src/server/translator/keys.js';
import type { TranslationProviderResponse } from '../../../src/server/translator/types.js';

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

  it.each([
    [429, 'rate limit', 'rate-limited'],
    [401, 'invalid key', 'invalid-key'],
    [403, 'permission denied', 'invalid-key'],
    [400, 'API_KEY_INVALID: API key not valid', 'invalid-key'],
    [408, 'JSON request timeout', 'timeout'],
    [503, 'unavailable', 'provider-error']
  ])('switches to the fallback key after HTTP %s', async (status, message, failure) => {
    const container = openContainer();
    const provider = new FakeProvider([
      new TranslationProviderError(message, status),
      { text: '{"title":"대체 번역","summary":"대체 본문"}' }
    ]);
    const translator = new ModelTranslator({
      repositories: container.repositories, env: keyEnv, model: 'gemini-test-model', provider, now: () => base
    });
    expect(await translator.translate({ title: 'Title', summary: 'Body' })).toEqual({
      title: '대체 번역', summary: '대체 본문', translated: true
    });
    expect(provider.calls.map(({ apiKey }) => apiKey)).toEqual(['primary-secret', 'fallback-secret']);
    expect(provider.calls[1]).toMatchObject({ model: 'gemini-test-model', prompt: provider.calls[0].prompt });
    expect(translationEvents(container).reverse()).toEqual([
      { status: 'failed', detail: failure }, { status: 'success', detail: 'fallback:success' }
    ]);
    expect(translator.getKeyStatus()).toMatchObject({ activeKey: 'fallback', primary: { state: 'cooldown' }, fallback: { state: 'ready' } });
  });

  it('keeps using fallback during cooldown and probes the primary key again after five minutes', async () => {
    const container = openContainer();
    let now = base;
    const success = { text: '{"title":"번역","summary":"본문"}' };
    const provider = new FakeProvider([new TranslationProviderError('limit', 429), success, success, success]);
    const translator = new ModelTranslator({ repositories: container.repositories, env: keyEnv, provider, now: () => now });
    await translator.translate({ title: 'First', summary: 'Body' });
    now = '2026-05-29T00:04:59.000Z';
    await translator.translate({ title: 'Second', summary: 'Body' });
    now = '2026-05-29T00:05:00.000Z';
    expect(translator.getKeyStatus().activeKey).toBe('primary');
    await translator.translate({ title: 'Third', summary: 'Body' });
    expect(provider.calls.map(({ apiKey }) => apiKey)).toEqual(['primary-secret', 'fallback-secret', 'fallback-secret', 'primary-secret']);
  });

  it('switches on network failure and never persists credentials echoed in errors', async () => {
    const container = openContainer();
    const provider = new FakeProvider([
      new Error('network failed primary-secret'),
      new TranslationProviderError('quota exceeded fallback-secret', 429)
    ]);
    const translator = new ModelTranslator({ repositories: container.repositories, env: keyEnv, provider, now: () => base });
    const input = { title: 'Title', summary: 'Body' };
    expect(await translator.translate(input)).toEqual({ ...input, translated: false });
    expect(await translator.translate({ title: 'Other input', summary: 'Body' })).toMatchObject({ translated: false });
    expect(provider.calls).toHaveLength(2);
    expect(translationEvents(container)[0]).toEqual({ status: 'skipped', detail: 'keys-cooldown' });
    expect(translator.getKeyStatus()).toMatchObject({ activeKey: null, primary: { state: 'cooldown' }, fallback: { state: 'cooldown' } });
    const publicData = JSON.stringify({ logs: container.repositories.eventLog.list(), keys: translator.getKeyStatus() });
    for (const secret of Object.values(keyEnv)) expect(publicData).not.toContain(secret);
  });

  it('aborts a timed-out primary request and uses a fresh signal for fallback', async () => {
    const container = openContainer();
    const calls: TranslationProviderRequest[] = [];
    const provider: TranslationProvider = {
      generate: async (request) => {
        calls.push(request);
        if (request.apiKey === 'primary-secret') return new Promise(() => undefined);
        return { text: '{"title":"번역","summary":"본문"}' };
      }
    };
    const translator = new ModelTranslator({ repositories: container.repositories, env: keyEnv, provider, providerTimeoutMs: 5, now: () => base });
    expect(await translator.translate({ title: 'Title', summary: 'Body' })).toMatchObject({ translated: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
  });

  it.each([400, 404])('does not switch keys for a non-credential HTTP %s request error', async (status) => {
    const container = openContainer();
    const provider = new FakeProvider([new TranslationProviderError('bad model or request', status)]);
    const translator = new ModelTranslator({ repositories: container.repositories, env: keyEnv, provider, now: () => base });
    expect(await translator.translate({ title: 'Title', summary: 'Body' })).toMatchObject({ translated: false });
    expect(provider.calls).toHaveLength(1);
    expect(translator.getKeyStatus().primary.state).toBe('ready');
  });

  it.each([
    { text: 'invalid JSON' },
    { text: '{"title":"partial"', finishReason: 'MAX_TOKENS' }
  ])('does not switch keys or disable a key for unusable generated output', async (response) => {
    const container = openContainer();
    const provider = new FakeProvider([response]);
    const translator = new ModelTranslator({ repositories: container.repositories, env: keyEnv, provider, now: () => base });
    expect(await translator.translate({ title: 'Title', summary: 'Body' })).toMatchObject({ translated: false });
    expect(provider.calls).toHaveLength(1);
    expect(translator.getKeyStatus().primary.state).toBe('ready');
  });

  it('uses fallback alone and deduplicates identical keys', async () => {
    expect(resolveModelCredentials({ PRIMARY_MODEL_API_KEY: ' same ', FALLBACK_MODEL_API_KEY: 'same' })).toEqual([{ slot: 'primary', apiKey: 'same' }]);
    expect(resolveModelCredentials({ PRIMARY_MODEL_API_KEY: ' ', FALLBACK_MODEL_API_KEY: ' fallback-secret ' })).toEqual([{ slot: 'fallback', apiKey: 'fallback-secret' }]);
    const container = openContainer();
    const provider = new FakeProvider([{ text: '{"title":"번역","summary":"본문"}' }]);
    const translator = new ModelTranslator({ repositories: container.repositories, env: { FALLBACK_MODEL_API_KEY: 'fallback-secret' }, provider });
    expect(await translator.translate({ title: 'Title', summary: 'Body' })).toMatchObject({ translated: true });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].apiKey).toBe('fallback-secret');
    expect(translator.getKeyStatus()).toMatchObject({ activeKey: 'fallback', primary: { state: 'missing' } });
  });

  it('caches fallback success and reports cooldown without exposing either key', async () => {
    const provider = new FakeProvider([
      new TranslationProviderError('primary-secret', 429),
      { text: '{"title":"번역 제목","summary":"번역 본문"}' }
    ]);
    const container = createContainer({ env: { DATABASE_PATH: ':memory:', ...keyEnv }, translationProvider: provider });
    containers.push(container);
    const input = { title: 'Title', summary: 'Body' };
    expect(await container.services.model.diagnose(input)).toMatchObject({ translated: true, title: '번역 제목' });
    expect(await container.services.model.diagnose(input)).toMatchObject({ translated: true, title: '번역 제목' });
    expect(provider.calls).toHaveLength(2);
    const diagnostics = container.services.model.getDiagnostics();
    expect(diagnostics).toMatchObject({
      status: 'ready', lastRequestResult: 'fallback:success',
      keys: { activeKey: 'fallback', primary: { state: 'cooldown' }, fallback: { state: 'ready' } },
      counts: { failed: 1, success: 1, cache_hit: 2 }
    });
    const serialized = JSON.stringify({ diagnostics, config: container.config, logs: container.repositories.eventLog.list() });
    for (const secret of Object.values(keyEnv)) expect(serialized).not.toContain(secret);
  });

  it('reports all-key cooldown after both API requests fail', async () => {
    const provider = new FakeProvider([new TranslationProviderError('limit', 429), new TranslationProviderError('limit', 429)]);
    const container = createContainer({ env: { DATABASE_PATH: ':memory:', ...keyEnv }, translationProvider: provider });
    containers.push(container);
    expect(await container.services.model.diagnose({ title: 'Title', summary: 'Body' })).toMatchObject({ translated: false });
    expect(container.services.model.getDiagnostics()).toMatchObject({ status: 'cooldown', keys: { activeKey: null } });
  });
});

const keyEnv = { PRIMARY_MODEL_API_KEY: 'primary-secret', FALLBACK_MODEL_API_KEY: 'fallback-secret' };

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
