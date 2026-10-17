import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch, Response } from 'undici';
import { fetchFeed, type DnsLookup } from '../../../src/server/security/index.js';

const servers: Server[] = [];
const lookup: DnsLookup = (_hostname, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]);
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

async function localFeed(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}/feed`;
}

describe('bounded feed HTTP responses', () => {
  it('aborts a real body stream that never finishes after headers arrive', async () => {
    const url = await localFeed((response) => { response.writeHead(200, { 'content-type': 'application/xml' }); response.write('<rss>'); });
    const started = Date.now();
    await expect(fetchFeed({ feedUrl: 'https://example.com/feed', fetchOptions: { timeoutMs: 100 } }, {
      lookup, fetchImpl: (_input, init) => undiciFetch(url, { ...init, dispatcher: undefined })
    })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('counts bytes in a chunked response and aborts once the limit is exceeded', async () => {
    const url = await localFeed((response) => { response.writeHead(200, { 'content-type': 'application/xml' }); response.write('x'.repeat(4096)); response.end(); });
    await expect(fetchFeed({ feedUrl: 'https://example.com/feed' }, {
      lookup, maxBytes: 1024, fetchImpl: (_input, init) => undiciFetch(url, { ...init, dispatcher: undefined })
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('rejects oversized content-length without waiting for the body', async () => {
    await expect(fetchFeed({ feedUrl: 'https://example.com/feed' }, {
      lookup, maxBytes: 1024, fetchImpl: async () => new Response('small', { headers: { 'content-length': '1000000' } })
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('does not retry certificate failures with a weaker TLS profile', async () => {
    let calls = 0;
    await expect(fetchFeed({ feedUrl: 'https://example.com/feed' }, { lookup, fetchImpl: async () => {
      calls++; throw new Error('CERT_HAS_EXPIRED certificate expired');
    } })).rejects.toMatchObject({ code: 'fetch_failed' });
    expect(calls).toBe(1);
  });

  it('returns a verified permanent redirect target without changing the feed identity', async () => {
    let calls = 0;
    const result = await fetchFeed({ feedUrl: 'https://example.com/original' }, { lookup, fetchImpl: async () =>
      calls++ === 0 ? new Response(null, { status: 301, headers: { location: 'https://example.com/final' } }) : new Response('<rss/>') });
    expect(result).toMatchObject({ url: 'https://example.com/original', permanentUrl: 'https://example.com/final' });
  });

  it('rechecks an automatic TLS pin after a day and removes it on success', async () => {
    const result = await fetchFeed({ feedUrl: 'https://example.com/feed', fetchOptions: { tlsMaxVersion: 'TLSv1.2', tlsPinnedAt: '2026-10-14T00:00:00.000Z' } },
      { lookup, now: () => '2026-10-16T00:00:00.000Z', fetchImpl: async () => new Response('<rss/>') });
    expect(result.persistedFetchOptions).toEqual({});
  });
});
