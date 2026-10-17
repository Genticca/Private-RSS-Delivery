import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createContainer, type Container } from '../../../src/server/runtime/container.js';
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
  it('uses primary provider success and records usage with prompt log truncation', async () => {
    const container = openContainer();
    container.repositories.modelConfig.updateRole('primary', { promptLogMaxBytes: 80, updatedAt: base });
    const gemini = new FakeProvider([{ text: '{"title":"번역 제목","summary":"번역 요약"}', inputTokens: 11, outputTokens: 7 }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      providers: { gemini },
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary '.repeat(10) });

    expect(result).toEqual({ title: '번역 제목', summary: '번역 요약', translated: true });
    expect(gemini.calls).toHaveLength(1);
    expect(container.repositories.modelUsage.list()).toMatchObject([
      { role: 'primary', provider: 'gemini', model: 'gemini-3.1-flash-lite', inputTokens: 11, outputTokens: 7, error: null }
    ]);
    const promptLog = rawPromptLogs(container.db)[0]?.prompt_log;
    expect(promptLog).toBeTruthy();
    expect(Buffer.byteLength(promptLog ?? '', 'utf8')).toBeLessThanOrEqual(80);
    expect(promptLog?.endsWith('…')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(container.repositories.modelUsage.list()[0], 'promptLog')).toBe(false);
  });

  it('returns original text after an invalid key error', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([new TranslationProviderError('invalid key', 401)]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'bad-key' },
      providers: { gemini },
      now: () => base
    });

    const result = await translator.translate({ title: 'Title', summary: 'Summary' });

    expect(result).toEqual({ title: 'Title', summary: 'Summary', translated: false });
    expect(gemini.calls).toHaveLength(1);
    expect(container.repositories.modelUsage.list().map((usage) => ({ role: usage.role, error: usage.error }))).toEqual([
      { role: 'primary', error: 'invalid-key' }
    ]);
  });

  it('returns original text when the provider returns length-truncated output', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([{ text: '{"title":"partial"', finishReason: 'MAX_TOKENS' }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      providers: { gemini },
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(container.repositories.modelUsage.list().map((usage) => ({ role: usage.role, error: usage.error }))).toEqual([
      { role: 'primary', error: 'length' }
    ]);
  });

  it('returns original text when the provider returns unparsable JSON', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([{ text: 'not-json' }]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      providers: { gemini },
      now: () => base
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(container.repositories.modelUsage.list().map((usage) => ({ role: usage.role, error: usage.error }))).toEqual([
      { role: 'primary', error: 'parse' }
    ]);
  });

  it('aborts and returns original text when the provider times out', async () => {
    const container = openContainer();
    const gemini = new HangingProvider();
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: { PRIMARY_MODEL_API_KEY: 'primary-key' },
      providers: { gemini },
      now: () => base,
      providerTimeoutMs: 5
    });

    const result = await translator.translate({ title: 'Original title', summary: 'Original summary' });

    expect(result).toEqual({ title: 'Original title', summary: 'Original summary', translated: false });
    expect(gemini.calls).toHaveLength(1);
    expect(gemini.calls[0]?.signal?.aborted).toBe(true);
    expect(container.repositories.modelUsage.list().map((usage) => ({ role: usage.role, error: usage.error }))).toEqual([
      { role: 'primary', error: 'timeout' }
    ]);
  });

  it('logs a missing key without calling the provider', async () => {
    const container = openContainer();
    const gemini = new FakeProvider([]);
    const translator = new ModelTranslator({
      repositories: container.repositories,
      env: {},
      providers: { gemini },
      now: () => base
    });

    const result = await translator.translate({ title: 'Title', summary: 'Summary' });

    expect(result).toEqual({ title: 'Title', summary: 'Summary', translated: false });
    expect(gemini.calls).toEqual([]);
    expect(container.repositories.modelUsage.list().map((usage) => ({ role: usage.role, error: usage.error }))).toEqual([
      { role: 'primary', error: 'missing-key' }
    ]);
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

function rawPromptLogs(db: Database.Database): Array<{ prompt_log: string | null }> {
  return db.prepare('SELECT prompt_log FROM model_usage ORDER BY id DESC').all() as Array<{ prompt_log: string | null }>;
}
