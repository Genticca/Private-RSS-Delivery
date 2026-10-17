import { afterEach, vi } from 'vitest';
import { createContainer, type Container, type CreateContainerOptions } from '../../src/server/container.js';
import type { CreateSourceRequest } from '../../src/server/sources/service.js';
import type { WebhookPostRequest, WebhookPostResponse, WebhookEditRequest } from '../../src/server/delivery/discord.js';
import type { FeedFetchSource, FetchFeedOptions, FeedFetchResult } from '../../src/server/net/fetch.js';

export const BASE = '2026-10-16T00:00:00.000Z';

export const WEBHOOK_A = 'https://discord.com/api/webhooks/111/test-a';

export const WEBHOOK_B = 'https://discord.com/api/webhooks/222/test-b';

const containers: Container[] = [];

afterEach(async () => { for (const container of containers.splice(0)) await container.close(); });

export interface FeedItem { id: string; title?: string; summary?: string; publishedAt?: string; }

export function rss(items: readonly FeedItem[]): string {
  return `<rss version="2.0"><channel><title>Test feed</title>${items.map((item) => `<item><guid>${item.id}</guid><title>${item.title ?? item.id}</title><link>https://example.com/${item.id}</link><description>${item.summary ?? 'Summary'}</description>${item.publishedAt ? `<pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
}

export async function harness(sourcePatch: CreateSourceRequest | Partial<CreateSourceRequest> = {}, options: CreateContainerOptions = {}) {
  let body = rss([]);
  let messageNo = 1000;
  const post = vi.fn(async (_request: WebhookPostRequest): Promise<WebhookPostResponse> => ({ statusCode: 200, messageId: String(++messageNo), channelId: '3000' }));
  const edit = vi.fn(async (request: WebhookEditRequest): Promise<WebhookPostResponse> => ({ statusCode: 200, messageId: request.messageId }));
  const fetcher = vi.fn(async (_source: FeedFetchSource, _options?: FetchFeedOptions): Promise<FeedFetchResult> => ({ kind: 'ok' as const, body, statusCode: 200, url: 'https://example.com/feed',
    etag: '"feed"', lastModified: null, contentType: 'application/xml', charset: 'utf-8' }));
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' }, urlVerifiers: { verifyFeedUrl: async () => undefined, verifyWebhookUrl: async () => undefined },
    feedFetcher: fetcher, postWebhook: post, editWebhook: edit, ...options });
  containers.push(container);
  const group = await container.services.groups.create({ name: 'A', webhookUrl: WEBHOOK_A });
  const created = await container.services.sources.create({ feedUrl: 'https://example.com/feed', groupIds: [group.id], editInPlace: true, ...sourcePatch });
  container.repositories.sources.update(created.id, { deliveryCutoffAt: BASE });
  const source = () => container.repositories.sources.getById(created.id)!;
  const poll = async (items: readonly FeedItem[], now = BASE) => { body = rss(items); return container.workers.poller.triggerPoll(created.id, now); };
  const pollBody = async (value: string, now = BASE) => { body = value; return container.workers.poller.triggerPoll(created.id, now); };
  const run = (now = BASE) => container.workers.dispatcher.runDueDeliveries(now);
  const item = (id = 'one') => container.repositories.items.findByAtomId(created.id, id)!;
  const jobs = () => container.repositories.deliveryJobs.list({ sourceId: created.id, limit: 10000 });
  const baseline = () => poll([]);
  return { container, r: container.repositories, source, group, post, edit, fetcher, poll, pollBody, run, item, jobs, baseline };
}
