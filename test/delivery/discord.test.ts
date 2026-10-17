import { vi, describe, it, expect } from 'vitest';
import { Response, type RequestInit } from 'undici';
import { postDiscordWebhook, editDiscordWebhookMessage } from '../../src/server/delivery/discord.js';
import { canonicalWebhookUrl } from '../../src/server/net/webhook-url.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('undici', async (importOriginal) => ({ ...await importOriginal<typeof import('undici')>(), fetch: mocks.fetch }));

const destination = { webhookUrl: 'https://discordapp.com/api/webhooks/123/CaseToken?thread_id=999', webhookName: null, webhookAvatarUrl: null, destinationKey: 'key', threadId: null };

describe('Discord HTTP adapter', () => {
  it('uses wait=true, canonical host and case-preserved token, with source-owned thread settings', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('{"id":"123","channel_id":"777"}', { status: 200 }));
    const result = await postDiscordWebhook({ destination, payload: { content: 'test', thread_name: 'Forum' }, timeoutMs: 1000 });
    const [url] = mocks.fetch.mock.calls.at(-1)!;
    expect(String(url)).toBe('https://discord.com/api/webhooks/123/CaseToken?wait=true');
    expect(result).toMatchObject({ messageId: '123', channelId: '777', threadId: '777' });
    expect(canonicalWebhookUrl(destination.webhookUrl)).toBe('https://discord.com/api/webhooks/123/CaseToken');
  });

  it('PATCHes the saved thread and strips creation-only fields', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('{"id":"123"}', { status: 200 }));
    await editDiscordWebhookMessage({ destination: { ...destination, threadId: '456' }, messageId: '123', payload: { content: 'test', thread_name: 'Forum', applied_tags: ['555'] }, timeoutMs: 1000 });
    const [url, init] = mocks.fetch.mock.calls.at(-1)! as [URL, RequestInit];
    expect(String(url)).toBe('https://discord.com/api/webhooks/123/CaseToken/messages/123?thread_id=456');
    expect(JSON.parse(String(init.body))).toEqual({ content: 'test' });
  });

  it('extracts rate-limit cooldown and global scope', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('{"retry_after":2,"global":true}', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' } }));
    expect(await postDiscordWebhook({ destination, payload: { content: 'test' }, timeoutMs: 1000 })).toMatchObject({ retryAfterMs: 2000, cooldownMs: 3000, globalRateLimit: true });
  });
});
