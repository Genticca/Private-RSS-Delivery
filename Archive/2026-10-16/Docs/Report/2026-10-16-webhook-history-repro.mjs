// Diagnostic only: current source, in-memory SQLite, synthetic feeds, mocked POST/PATCH.
// Run from rss-discord-bridge: node Docs/Report/2026-10-16-webhook-history-repro.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Load source without modifying dependencies or using the stale dist directory.
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
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
      });
      return { format: 'module', source: result.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { createContainer } = await import('../../src/server/runtime/container.ts');
const { Poller } = await import('../../src/server/scheduler/poller.ts');
const { WebhookDispatcher } = await import('../../src/server/dispatcher/webhook.ts');
const { SourceService } = await import('../../src/server/services/source.service.ts');
const { GroupService } = await import('../../src/server/services/group.service.ts');

// The installed better-sqlite3 binary cannot load on this Windows environment.
// This adapter executes real migrations and repository SQL with Node's SQLite.
function memoryDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  let transactionId = 0;
  return {
    exec: (sql) => sqlite.exec(sql),
    prepare: (sql) => sqlite.prepare(sql),
    pragma: (sql) => sqlite.prepare('PRAGMA ' + sql).all(),
    close: () => sqlite.close(),
    transaction(fn) {
      return (...args) => {
        const savepoint = 'diagnostic_' + transactionId++;
        sqlite.exec('SAVEPOINT ' + savepoint);
        try {
          const result = fn(...args);
          sqlite.exec('RELEASE ' + savepoint);
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK TO ' + savepoint);
          sqlite.exec('RELEASE ' + savepoint);
          throw error;
        }
      };
    }
  };
}

const t0 = '2026-10-01T00:00:00.000Z';
const t1 = '2026-10-02T00:00:00.000Z';
const attachedAt = '2026-10-15T00:00:00.000Z';
const polledAt = '2026-10-16T00:00:00.000Z';
const alpha = 'https://discord.com/api/webhooks/123/diagnostic-alpha';
const beta = 'https://discord.com/api/webhooks/456/diagnostic-beta';
const baseline = [{ id: 'baseline', title: 'Baseline', date: '2026-09-01T00:00:00.000Z' }];
const articles = Array.from({ length: 3 }, (_, index) => ({ id: 'article-' + index, title: 'Article ' + index, date: t1 }));
const updatedArticles = articles.map((article) => ({ ...article, title: article.title + ' updated' }));
const scenarios = [];

function feed(entries) {
  return '<rss version="2.0"><channel><title>Diagnostic</title>' + entries.map((entry) =>
    '<item><guid>' + entry.id + '</guid><title>' + entry.title + '</title>' +
    '<link>https://example.com/' + entry.id + '</link><description>Body</description>' +
    (entry.date ? '<pubDate>' + new Date(entry.date).toUTCString() + '</pubDate>' : '') + '</item>'
  ).join('') + '</channel></rss>';
}

async function context() {
  const container = createContainer({
    db: memoryDatabase(),
    config: { databasePath: ':memory:', host: '127.0.0.1', port: 8080, isProduction: false },
    env: {},
    urlVerifiers: { verifyFeedUrl: async () => {}, verifyWebhookUrl: async () => {} }
  });
  let clock = t0;
  const calls = [];
  const sources = new SourceService({ db: container.db, repositories: container.repositories, now: () => clock, verifyFeedUrl: async () => {} });
  const groups = new GroupService({ db: container.db, repositories: container.repositories, now: () => clock, verifyWebhookUrl: async () => {} });
  const group = await groups.create({ name: 'Alpha', webhookUrl: alpha });
  const source = await sources.create({ feedUrl: 'https://example.com/diagnostic.xml', groupIds: [group.id], editInPlace: true });
  const dispatcher = new WebhookDispatcher({
    db: container.db,
    repositories: container.repositories,
    postWebhook: async (request) => {
      const messageId = String(10000 + calls.length);
      calls.push({ method: 'POST', target: request.destination.webhookUrl === alpha ? 'A' : 'B' });
      return { statusCode: 200, messageId };
    },
    editWebhook: async (request) => {
      calls.push({ method: 'PATCH', target: request.destination.webhookUrl === alpha ? 'A' : 'B' });
      return { statusCode: 200, messageId: request.messageId };
    }
  });
  const poll = async (entries, now) => {
    const poller = new Poller({
      db: container.db,
      repositories: container.repositories,
      fetchFeed: async () => ({ kind: 'ok', statusCode: 200, url: 'https://example.com/diagnostic.xml', body: feed(entries), etag: null, lastModified: null, contentType: 'application/xml', charset: 'utf-8' })
    });
    const result = await poller.triggerPoll(source.id, now);
    assert.equal(result.outcome, '200');
    return result;
  };
  return { container, sources, groups, group, source, calls, dispatcher, poll, clock: (value) => { clock = value; } };
}

async function run(name, fn) {
  const ctx = await context();
  try {
    const details = await fn(ctx);
    scenarios.push({ scenario: name, ...details });
  } finally {
    await ctx.container.close();
  }
}

async function seedDelivered(ctx) {
  await ctx.poll(baseline, t0);
  await ctx.poll([...baseline, ...articles], t1);
  await ctx.dispatcher.runDueDeliveries(t1);
  assert.equal(ctx.calls.length, 3);
  assert.ok(ctx.calls.every((call) => call.method === 'POST' && call.target === 'A'));
  ctx.calls.length = 0;
  ctx.clock(attachedAt);
}

await run('brand-new-source-first-poll', async (ctx) => {
  const result = await ctx.poll([...baseline, ...articles], t0);
  await ctx.dispatcher.runDueDeliveries(t0);
  assert.equal(result.itemsHistorical, 4);
  assert.equal(ctx.calls.length, 0);
  return { historical: result.itemsHistorical, posts: 0 };
});

await run('replace-webhook-unchanged-content', async (ctx) => {
  await seedDelivered(ctx);
  await ctx.groups.update(ctx.group.id, { webhookUrl: beta });
  await ctx.dispatcher.runDueDeliveries(attachedAt);
  await ctx.poll([...baseline, ...articles], polledAt);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.equal(ctx.calls.length, 0);
  return { posts: 0 };
});

await run('replace-webhook-changed-delivered-content', async (ctx) => {
  await seedDelivered(ctx);
  await ctx.groups.update(ctx.group.id, { webhookUrl: beta });
  const result = await ctx.poll([...baseline, ...updatedArticles], polledAt);
  assert.equal(result.itemsChanged, 3);
  assert.equal(ctx.container.repositories.items.findDueDeliveries(polledAt).length, 3);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.deepEqual(ctx.calls, Array.from({ length: 3 }, () => ({ method: 'POST', target: 'B' })));
  return { changed: result.itemsChanged, oldItemsPostedToB: 3, patches: 0, editInPlace: true };
});

await run('add-webhook-changed-delivered-content', async (ctx) => {
  await seedDelivered(ctx);
  const groupB = await ctx.groups.create({ name: 'Beta', webhookUrl: beta });
  await ctx.sources.update(ctx.source.id, { groupIds: [ctx.group.id, groupB.id] });
  await ctx.poll([...baseline, ...updatedArticles], polledAt);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.equal(ctx.calls.filter((call) => call.method === 'PATCH' && call.target === 'A').length, 3);
  assert.equal(ctx.calls.filter((call) => call.method === 'POST' && call.target === 'B').length, 3);
  return { oldItemsPatchedInA: 3, oldItemsPostedToB: 3 };
});

await run('replace-webhook-with-existing-pending-items', async (ctx) => {
  await ctx.poll(baseline, t0);
  await ctx.poll([...baseline, ...articles], t1);
  ctx.clock(attachedAt);
  await ctx.groups.update(ctx.group.id, { webhookUrl: beta });
  await ctx.dispatcher.runDueDeliveries(attachedAt);
  assert.deepEqual(ctx.calls, Array.from({ length: 3 }, () => ({ method: 'POST', target: 'B' })));
  return { oldPendingItemsPostedToB: 3, contentChangeRequired: false };
});

await run('replace-webhook-changed-historical-content', async (ctx) => {
  await ctx.poll([...baseline, ...articles], t0);
  ctx.clock(attachedAt);
  await ctx.groups.update(ctx.group.id, { webhookUrl: beta });
  await ctx.poll([...baseline, ...updatedArticles], polledAt);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.equal(ctx.calls.length, 0);
  return { posts: 0, historicalItemsPreserved: 4 };
});

await run('log-cleanup-loses-message-identity', async (ctx) => {
  await seedDelivered(ctx);
  assert.equal(ctx.container.repositories.deliveryLogs.pruneOlderThan(1, attachedAt), 3);
  await ctx.poll([...baseline, ...updatedArticles], polledAt);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.deepEqual(ctx.calls, Array.from({ length: 3 }, () => ({ method: 'POST', target: 'A' })));
  return { oldItemsPostedAgainToA: 3, patches: 0, editInPlace: true };
});

await run('content-reversion-skips-needed-patch', async (ctx) => {
  await seedDelivered(ctx);
  await ctx.poll([...baseline, ...updatedArticles], polledAt);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.deepEqual(ctx.calls, Array.from({ length: 3 }, () => ({ method: 'PATCH', target: 'A' })));
  ctx.calls.length = 0;
  const revertedAt = '2026-10-16T00:05:00.000Z';
  const result = await ctx.poll([...baseline, ...articles], revertedAt);
  assert.equal(result.itemsChanged, 3);
  await ctx.dispatcher.runDueDeliveries(revertedAt);
  assert.equal(ctx.calls.length, 0);
  return { revertedItems: 3, neededPatches: 3, actualPatches: 0 };
});

await run('reattach-with-unseen-undated-backlog', async (ctx) => {
  await seedDelivered(ctx);
  await ctx.groups.update(ctx.group.id, { clearWebhook: true });
  await ctx.groups.update(ctx.group.id, { webhookUrl: beta });
  const undatedBacklog = Array.from({ length: 3 }, (_, index) => ({ id: 'undated-backlog-' + index, title: 'Undated backlog ' + index }));
  const result = await ctx.poll([...baseline, ...articles, ...undatedBacklog], polledAt);
  assert.equal(result.itemsNew, 3);
  await ctx.dispatcher.runDueDeliveries(polledAt);
  assert.deepEqual(ctx.calls, Array.from({ length: 3 }, () => ({ method: 'POST', target: 'B' })));
  return { unseenUndatedItemsPostedToB: 3, firstSnapshotAfterReattach: true };
});

console.log(JSON.stringify({ source: 'src/server', sqlite: 'node:sqlite in-memory adapter', networkCalls: 0, scenarios }, null, 2));
