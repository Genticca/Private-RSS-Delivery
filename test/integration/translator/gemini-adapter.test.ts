import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: mocks.generate }; } }));
import { GeminiTranslationProvider } from '../../../src/server/translator/providers/gemini.js';

describe('Gemini SDK adapter contract', () => {
  it('forwards the model, cancellation and required JSON fields to the SDK', async () => {
    const controller = new AbortController();
    mocks.generate.mockResolvedValueOnce({ text: '{"title":"제목","summary":"본문"}', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 }, candidates: [{ finishReason: 'STOP' }] });
    const result = await new GeminiTranslationProvider().generate({ apiKey: 'test-key', model: 'gemini-3.1-flash-lite', prompt: 'test', maxOutputTokens: 1200, signal: controller.signal });
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ model: 'gemini-3.1-flash-lite' });
    expect(mocks.generate.mock.calls[0][0].config).toMatchObject({ abortSignal: controller.signal, responseJsonSchema: { required: ['title', 'summary'] } });
    expect(result).toMatchObject({ inputTokens: 12, outputTokens: 8, finishReason: 'STOP' });
  });
});
