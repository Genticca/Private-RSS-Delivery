// Diagnostic only. All model responses and SDK HTTP requests are mocked.
// Run from rss-discord-bridge: node Docs/Report/2026-10-16-translation-usage-repro.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const sourceRoot = new URL('../../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const result = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
      });
      return { format: 'module', source: result.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { DispatchTranslationService, ModelTranslator } = await import('../../src/server/translator/translator.ts');
const { GeminiTranslationProvider } = await import('../../src/server/translator/providers/gemini.ts');
const { computeGenericContentHash, computeIncidentContentHash } = await import('../../src/server/domain/normalize/content-hash.ts');
const { buildPresetRenderContext, renderDiscordPayload } = await import('../../src/server/dispatcher/render.ts');
const now = '2026-10-16T00:00:00.000Z';
const source = { id: 'diagnostic-source', name: 'Diagnostic', feedUrl: 'https://example.com/feed', profileSetting: 'generic', detectedProfile: null, translate: true };
const scenarios = [];

function item(id) {
  return {
    id, sourceId: source.id, title: 'Same English title', summary: 'Long English body. '.repeat(80), link: 'https://example.com/article',
    publishedAt: now, updatedAt: null, createdAt: now, deliveryStatus: 'pending', contentHash: 'diagnostic-hash',
    translatedTitle: null, translatedSummary: null, translatedAt: null
  };
}

function serviceContext(translate) {
  const rows = new Map([[1, item(1)], [2, item(2)]]);
  const calls = [];
  const service = new DispatchTranslationService({
    now: () => now,
    repositories: {
      items: {
        saveTranslation(id, title, summary, translatedAt) {
          const row = { ...rows.get(id), translatedTitle: title, translatedSummary: summary, translatedAt };
          rows.set(id, row);
          return row;
        }
      }
    },
    translator: {
      async translate(input) {
        calls.push(input);
        return translate ? translate(input) : { title: '번역 제목', summary: '번역 본문', translated: true };
      }
    }
  });
  return { rows, calls, service };
}

{
  const ctx = serviceContext();
  await ctx.service.translateItemForDispatch(ctx.rows.get(1), source);
  await ctx.service.translateItemForDispatch(ctx.rows.get(1), source);
  assert.equal(ctx.calls.length, 1);
  await ctx.service.translateItemForDispatch(ctx.rows.get(2), source);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls[0], ctx.calls[1]);
  scenarios.push({ scenario: 'per-item-cache-not-shared-by-identical-input', sameItemRepeatedCalls: 1, twoIdenticalItemsCalls: 2 });
}

{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = serviceContext(async () => {
    await gate;
    return { title: '번역 제목', summary: '번역 본문', translated: true };
  });
  const staleSnapshot = ctx.rows.get(1);
  const first = ctx.service.translateItemForDispatch(staleSnapshot, source);
  const second = ctx.service.translateItemForDispatch(staleSnapshot, source);
  assert.equal(ctx.calls.length, 2);
  release();
  await Promise.all([first, second]);
  scenarios.push({ scenario: 'concurrent-cache-misses-have-no-shared-promise', simultaneousCallsForSameInput: 2, note: 'service-level risk if destination jobs run concurrently' });
}

{
  const ctx = serviceContext((input) => ({ ...input, translated: false }));
  await ctx.service.translateItemForDispatch(ctx.rows.get(1), source);
  await ctx.service.translateItemForDispatch(ctx.rows.get(1), source);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.rows.get(1).translatedAt, now);
  assert.equal(ctx.rows.get(1).translatedTitle, ctx.rows.get(1).title);
  scenarios.push({ scenario: 'failure-original-is-permanently-cached-as-completed', calls: 1, successfulTranslation: false, translatedAtSet: true });
}

{
  const ctx = serviceContext();
  const translated = await ctx.service.translateItemForDispatch(ctx.rows.get(1), source);
  const template = readFileSync(new URL('../../src/resources/presets/minimal.hbs', import.meta.url), 'utf8');
  const payload = renderDiscordPayload(template, buildPresetRenderContext(translated, source));
  assert.ok(ctx.calls[0].summary.length > 1000);
  assert.equal(payload.embeds[0].description, undefined);
  scenarios.push({ scenario: 'minimal-preset-translates-undisplayed-summary', summaryCharsSentToTranslator: ctx.calls[0].summary.length, summaryDisplayed: false });
}

{
  const genericA = { title: 'Title', link: 'https://example.com/a', summary: 'Summary A' };
  const genericB = { ...genericA, summary: 'Summary B' };
  const incidentA = { title: 'Title A', stage: 'Investigating', summary: 'Same body' };
  const incidentB = { ...incidentA, title: 'Title B' };
  assert.equal(computeGenericContentHash(genericA), computeGenericContentHash(genericB));
  assert.equal(computeIncidentContentHash(incidentA), computeIncidentContentHash(incidentB));
  scenarios.push({ scenario: 'delivery-content-hash-does-not-cover-all-translation-input', genericSummaryExcluded: true, incidentTitleExcluded: true });
}

{
  const realFetch = globalThis.fetch;
  let releasePrimary;
  const gate = new Promise((resolve) => { releasePrimary = resolve; });
  const sdkRequests = [];
  let fallbackCalls = 0;
  const usage = [];
  const configs = {
    primary: { role: 'primary', provider: 'gemini', model: 'gemini-3.1-flash-lite', enabled: true, targetLang: 'ko', promptLogMaxBytes: 0 },
    fallback: { role: 'fallback', provider: 'nvidia-nim', model: 'diagnostic-fallback', enabled: true, targetLang: 'ko', promptLogMaxBytes: 0 }
  };
  globalThis.fetch = async (_url, options) => {
    sdkRequests.push({ signal: options?.signal });
    await gate;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"늦은 제목","summary":"늦은 본문"}' }] }, finishReason: 'STOP' }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const translator = new ModelTranslator({
      repositories: { modelConfig: { getByRole: (role) => configs[role] }, modelUsage: { append: (row) => { usage.push(row); } } },
      env: { PRIMARY_MODEL_API_KEY: 'diagnostic-not-real', FALLBACK_MODEL_API_KEY: 'diagnostic-not-real' },
      providers: {
        gemini: new GeminiTranslationProvider(),
        'nvidia-nim': { generate: async () => { fallbackCalls += 1; return { text: '{"title":"보조 제목","summary":"보조 본문"}' }; } }
      },
      providerTimeoutMs: 100,
      now: () => now
    });
    const result = await translator.translate({ title: 'Original title', summary: 'Original body' });
    assert.equal(result.title, '보조 제목');
    assert.equal(fallbackCalls, 1);
    assert.equal(sdkRequests.length, 1);
    assert.equal(sdkRequests[0].signal, undefined);
    assert.equal(usage[0].error, 'timeout');
    scenarios.push({ scenario: 'gemini-timeout-signal-not-forwarded-to-sdk', primaryHttpStillPendingAtFallback: true, sdkSignalPresent: false, fallbackCalls: 1 });
  } finally {
    releasePrimary();
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.fetch = realFetch;
  }
}

console.log(JSON.stringify({ source: 'src/server', realNetworkCalls: 0, scenarios }, null, 2));
