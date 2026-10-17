import type { DnsLookup } from '../../../src/server/security/ip.js';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { assertSafeFeedUrl } from '../../../src/server/security/ip.js';
import { SecurityError } from '../../../src/server/security/errors.js';
import { verifyFeedUrlSafe } from '../../../src/server/security/ip.js';
import { createSsrSafeLookup } from '../../../src/server/security/ip.js';
import { assertSafeWebhookUrl } from '../../../src/server/security/webhook-guard.js';
import { canonicalWebhookUrl } from '../../../src/server/security/webhook-guard.js';
import { assertSafeWebhookMessageUrl } from '../../../src/server/security/webhook-guard.js';
import { verifyWebhookUrlSafe } from '../../../src/server/security/webhook-guard.js';
import { getSsrSafeAgent } from '../../../src/server/security/agent-cache.js';
import { closeSsrSafeAgents } from '../../../src/server/security/agent-cache.js';
import type { RequestInit } from 'undici';
import type { FetchImplementation } from '../../../src/server/security/ssrf-fetch.js';
import type { RequestInfo } from 'undici';
import { Response } from 'undici';
import { fetchFeed } from '../../../src/server/security/ssrf-fetch.js';
import { Buffer } from 'node:buffer';

const publicLookup: DnsLookup = (_hostname, _options, callback) => {
  callback(null, [{ address: '93.184.216.34', family: 4 }]);
};

describe('security outbound URL guards', () => {
  it('allows only http(s) feed URLs without credentials and blocks restricted literal IPs', () => {
    expect(assertSafeFeedUrl('https://example.com/feed.xml').hostname).toBe('example.com');
    expect(() => assertSafeFeedUrl('ftp://example.com/feed.xml')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('https://user:pass@example.com/feed.xml')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('http://127.0.0.1/feed.xml')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('http://169.254.169.254/latest/meta-data')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('http://[::1]/feed.xml')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('http://[64:ff9b::a9fe:a9fe]/feed.xml')).toThrow(SecurityError);
    expect(() => assertSafeFeedUrl('http://[::ffff:127.0.0.1]/feed.xml')).toThrow(SecurityError);
  });

  it('blocks DNS results that include private or metadata addresses', async () => {
    const mixedLookup: DnsLookup = (_hostname, _options, callback) => {
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.10', family: 4 }
      ]);
    };

    await expect(verifyFeedUrlSafe('https://example.com/feed.xml', { lookup: mixedLookup })).rejects.toMatchObject({
      code: 'ssrf_blocked'
    });
    await expect(verifyFeedUrlSafe('https://example.com/feed.xml', { lookup: publicLookup })).resolves.toBeInstanceOf(URL);
  });

  it('provides an undici-compatible SSRF-safe lookup callback', async () => {
    const lookup = createSsrSafeLookup({ lookup: publicLookup });
    const result = await new Promise<{ address?: string; family?: number }>((resolve, reject) => {
      lookup('example.com', {}, (error, address, family) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ address: String(address), family });
      });
    });

    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('validates Discord webhook URL shape and canonicalizes destination keys without exposing credentials', async () => {
    expect(assertSafeWebhookUrl('https://discord.com/api/webhooks/123/token').hostname).toBe('discord.com');
    expect(assertSafeWebhookUrl('https://discordapp.com/api/webhooks/123/token/').hostname).toBe('discordapp.com');
    expect(canonicalWebhookUrl('https://DISCORD.com/api/webhooks/ABC/Token/')).toBe(
      'https://discord.com/api/webhooks/ABC/Token'
    );
    expect(() => assertSafeWebhookUrl('http://discord.com/api/webhooks/123/token')).toThrow(SecurityError);
    expect(() => assertSafeWebhookUrl('https://discord.com.evil.test/api/webhooks/123/token')).toThrow(SecurityError);
    expect(() => assertSafeWebhookUrl('https://evil:pass@discord.com/api/webhooks/123/token')).toThrow(SecurityError);
    expect(() => assertSafeWebhookUrl('https://discord.com/not-webhooks/123/token')).toThrow(SecurityError);
    expect(assertSafeWebhookMessageUrl('https://discord.com/api/webhooks/123/token/messages/987654321').pathname).toBe(
      '/api/webhooks/123/token/messages/987654321'
    );
    expect(() => assertSafeWebhookMessageUrl('https://discord.com/api/webhooks/123/token/messages/not-a-number')).toThrow(SecurityError);
    expect(() => assertSafeWebhookMessageUrl('https://discord.com/api/webhooks/123/token/messages/987654321/extra')).toThrow(SecurityError);
    await expect(verifyWebhookUrlSafe('https://discord.com/api/webhooks/123/token', { lookup: publicLookup })).resolves.toBeInstanceOf(URL);
  });

  it('caches SSRF-safe agents by TLS profile', async () => {
    const first = getSsrSafeAgent();
    const second = getSsrSafeAgent();
    const tls12 = getSsrSafeAgent({ tlsMaxVersion: 'TLSv1.2' });

    expect(first).toBe(second);
    expect(tls12).not.toBe(first);
    await closeSsrSafeAgents();
  });
});

describe('fetchFeed', () => {
  it('sends conditional GET headers and returns a not-modified result without reading a body', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: FetchImplementation = async (_input: RequestInfo, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, {
        status: 304,
        headers: {
          etag: '"next"',
          'last-modified': 'Fri, 29 May 2026 00:00:00 GMT'
        }
      });
    };

    const result = await fetchFeed(
      {
        feedUrl: 'https://example.com/feed.xml',
        etag: '"prev"',
        lastModified: 'Thu, 28 May 2026 00:00:00 GMT',
        fetchOptions: { userAgent: 'custom-agent/1.0', headers: { 'X-Test': 'yes' } }
      },
      { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
    );

    expect(result).toMatchObject({ kind: 'not-modified', statusCode: 304, etag: '"next"' });
    expect(calls[0]?.headers).toMatchObject({
      'user-agent': 'custom-agent/1.0',
      'x-test': 'yes',
      'if-none-match': '"prev"',
      'if-modified-since': 'Thu, 28 May 2026 00:00:00 GMT'
    });
  });

  it('decodes response body using manual charset before HTTP charset and XML declaration', async () => {
    const fetchImpl: FetchImplementation = async () =>
      new Response(Buffer.from([0x3c, 0x72, 0x73, 0x73, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x72, 0x73, 0x73, 0x3e]), {
        status: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' }
      });

    const result = await fetchFeed(
      {
        feedUrl: 'https://example.com/feed.xml',
        fetchOptions: { charset: 'iso-8859-1' }
      },
      { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.charset).toBe('iso-8859-1');
      expect(result.body).toContain('café');
    }
  });

  it('falls back to XML declaration charset when HTTP does not specify one', async () => {
    const body = '<?xml version="1.0" encoding="utf-8"?><rss>안녕</rss>';
    const fetchImpl: FetchImplementation = async () =>
      new Response(Buffer.from(body, 'utf8'), {
        status: 200,
        headers: { 'content-type': 'application/xml' }
      });

    const result = await fetchFeed(
      { feedUrl: 'https://example.com/feed.xml' },
      { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.charset).toBe('utf-8');
      expect(result.body).toContain('안녕');
    }
  });

  it('follows a safe cross-host redirect and keeps the original feed URL as the result identity', async () => {
    const requested: string[] = [];
    const fetchImpl: FetchImplementation = async (input: RequestInfo) => {
      const url = String(input);
      requested.push(url);
      if (url === 'https://awesome-blogs.petabytes.org/feeds?group=company') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://awesomeblogs.jeho.page/feeds?group=company' }
        });
      }
      return new Response('<feed>moved here</feed>', {
        status: 200,
        headers: { 'content-type': 'application/atom+xml; charset=utf-8' }
      });
    };

    const result = await fetchFeed(
      { feedUrl: 'https://awesome-blogs.petabytes.org/feeds?group=company' },
      { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
    );

    expect(requested).toEqual([
      'https://awesome-blogs.petabytes.org/feeds?group=company',
      'https://awesomeblogs.jeho.page/feeds?group=company'
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.body).toContain('moved here');
      expect(result.url).toBe('https://awesome-blogs.petabytes.org/feeds?group=company');
    }
  });

  it('rejects a redirect whose target resolves to a private address', async () => {
    const blockedTargetLookup: DnsLookup = (hostname, _options, callback) => {
      if (hostname === 'internal.evil.test') {
        callback(null, [{ address: '10.0.0.1', family: 4 }]);
        return;
      }
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    };
    const fetchImpl: FetchImplementation = async (input: RequestInfo) => {
      if (String(input) === 'https://example.com/feed.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://internal.evil.test/feed.xml' }
        });
      }
      return new Response('<feed>should not be fetched</feed>', {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' }
      });
    };

    await expect(
      fetchFeed(
        { feedUrl: 'https://example.com/feed.xml' },
        { fetchImpl, lookup: blockedTargetLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: blockedTargetLookup }) }
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('throws redirect_blocked after exceeding the maximum redirect hops', async () => {
    let hop = 0;
    const fetchImpl: FetchImplementation = async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/hop-${hop}` }
      });
    };

    await expect(
      fetchFeed(
        { feedUrl: 'https://example.com/feed.xml' },
        { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
      )
    ).rejects.toMatchObject({ code: 'redirect_blocked' });
  });

  it('retries HTTP 403 once with TLSv1.2 and returns a persist patch on success', async () => {
    const tlsProfiles: Array<string | undefined> = [];
    const fetchImpl: FetchImplementation = async () => {
      if (tlsProfiles.length === 1) {
        return new Response('blocked', { status: 403 });
      }
      return new Response('<rss>ok</rss>', { status: 200, headers: { 'content-type': 'application/xml' } });
    };
    const persisted: unknown[] = [];

    const result = await fetchFeed(
      { id: 'source-1', feedUrl: 'https://example.com/feed.xml', fetchOptions: { userAgent: 'agent' } },
      {
        fetchImpl,
        lookup: publicLookup,
        dispatcherFactory: (tlsMaxVersion) => {
          tlsProfiles.push(tlsMaxVersion);
          return getSsrSafeAgent({ tlsMaxVersion, lookup: publicLookup });
        },
        persistFetchOptions: (_sourceId, fetchOptions) => {
          persisted.push(fetchOptions);
        }
      }
    );

    expect(tlsProfiles).toEqual([undefined, 'TLSv1.2']);
    expect(result).toMatchObject({
      kind: 'ok',
      usedTlsMaxVersion: 'TLSv1.2',
      persistedFetchOptions: { userAgent: 'agent', tlsMaxVersion: 'TLSv1.2' }
    });
    expect(persisted).toEqual([{ userAgent: 'agent', tlsMaxVersion: 'TLSv1.2', tlsPinnedAt: expect.any(String) }]);
  });

  it('does not retry non-403 HTTP errors', async () => {
    let calls = 0;
    const fetchImpl: FetchImplementation = async () => {
      calls += 1;
      return new Response('server error', { status: 500 });
    };

    await expect(
      fetchFeed(
        { feedUrl: 'https://example.com/feed.xml' },
        { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
      )
    ).rejects.toMatchObject({ code: 'http_error', details: { statusCode: 500 } });
    expect(calls).toBe(1);
  });

  it('maps aborted fetches to timeout errors', async () => {
    const fetchImpl: FetchImplementation = async () => {
      throw new Error('AbortError: operation aborted');
    };

    await expect(
      fetchFeed(
        { feedUrl: 'https://example.com/feed.xml' },
        { fetchImpl, lookup: publicLookup, dispatcherFactory: () => getSsrSafeAgent({ lookup: publicLookup }) }
      )
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
