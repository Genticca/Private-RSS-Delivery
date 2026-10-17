import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createContainer } from '../dist/server/runtime/container.js';

// Deterministic local fixtures only. This does not call real feed/model/Discord APIs.
const count = 25;
const baseline = '2026-10-16T00:00:00.000Z';
const next = '2026-10-16T00:05:01.000Z';
let phase = 0;
let modelCalls = 0;
let posts = 0;
const oldItems = Array.from({ length: 20 }, (_, i) => `<item><guid>old-${i}</guid><title>Old ${i}</title><link>https://example.com/old-${i}</link><description>${'Body '.repeat(100)}</description></item>`).join('');
const freshItem = '<item><guid>new</guid><title>Shared new title</title><link>https://example.com/new</link><description>Shared new body</description></item>';
const container = createContainer({
  env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'benchmark-fixture-key' },
  urlVerifiers: { verifyFeedUrl: async () => undefined, verifyWebhookUrl: async () => undefined },
  feedFetcher: async () => ({ kind: 'ok', statusCode: 200, url: 'https://example.com/feed',
    body: `<rss><channel>${oldItems}${phase ? freshItem : ''}</channel></rss>`, etag: null, lastModified: null, contentType: 'application/xml', charset: 'utf-8' }),
  translationProviders: { gemini: { generate: async () => { modelCalls++; return { text: '{"title":"공유 번역 제목","summary":""}' }; } } },
  postWebhook: async () => { posts++; await new Promise((resolve) => setTimeout(resolve, 1)); return { statusCode: 200, messageId: String(1000 + posts) }; }
});
const delay = monitorEventLoopDelay({ resolution: 10 });
try {
  const group = await container.services.groups.create({ name: 'Benchmark fixture', webhookUrl: 'https://discord.com/api/webhooks/123/benchmark-only' });
  for (let i = 0; i < count; i++) {
    const source = await container.services.sources.create({ feedUrl: `https://example.com/feed-${i}`, groupIds: [group.id], translate: true });
    container.repositories.sources.update(source.id, { deliveryCutoffAt: baseline });
  }
  const cpu = process.cpuUsage();
  const started = performance.now();
  delay.enable();
  await container.workers.poller.runDuePolls(baseline);
  const baselineDone = performance.now();
  phase = 1;
  await container.workers.poller.runDuePolls(next);
  const planningDone = performance.now();
  await container.workers.dispatcher.runDueDeliveries(next);
  const ended = performance.now();
  delay.disable();
  assert.equal(posts, count);
  assert.equal(modelCalls, 1);
  assert.equal(container.repositories.deliveryJobs.list({ state: 'pending' }).length, 0);
  const usage = process.cpuUsage(cpu);
  console.log(JSON.stringify({ fixture: { sources: count, historicalItems: count * 20, newPosts: posts, modelCalls },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    milliseconds: { baseline: +(baselineDone - started).toFixed(2), plan: +(planningDone - baselineDone).toFixed(2), deliver: +(ended - planningDone).toFixed(2), total: +(ended - started).toFixed(2), cpu: +((usage.user + usage.system) / 1000).toFixed(2) },
    memoryMiB: { rss: +(process.memoryUsage().rss / 1048576).toFixed(2), heap: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) },
    eventLoopDelayMs: { mean: Number.isFinite(delay.mean) ? +(delay.mean / 1e6).toFixed(2) : null, maximum: +(delay.max / 1e6).toFixed(2) }
  }, null, 2));
} finally { delay.disable(); await container.close(); }
