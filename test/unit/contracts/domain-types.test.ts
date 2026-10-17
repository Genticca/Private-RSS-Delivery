import { describe } from 'vitest';
import { it } from 'vitest';
import type { FeedEnvelope } from '../../../src/server/feed/parse.js';
import { expect } from 'vitest';
import type { NormalizedItem } from '../../../src/server/feed/parse.js';
import { PROFILES } from '../../../src/server/feed/parse.js';
import { SOURCE_PROFILE_OPTIONS } from '../../../src/server/feed/parse.js';
import type { FetchOptions } from '../../../src/server/net/fetch.js';
import { TLS_MAX_VERSIONS } from '../../../src/server/net/fetch.js';

describe('Turn 0 domain contracts', () => {
  it('keeps FeedEnvelope as the Stage 1 raw HTML carrier', () => {
    const envelope = {
      atomId: 'tag:status.example.com,2005:Incident/1',
      title: 'Example Incident',
      link: 'https://status.example.com/incidents/1',
      publishedAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:05:00.000Z',
      author: 'Example',
      commentsUrl: 'https://status.example.com/incidents/1#comments',
      image: 'https://status.example.com/incidents/1.png',
      rawBody: '<p><strong>Investigating</strong> - Details</p>',
      categories: ['status']
    } satisfies FeedEnvelope;

    expect(envelope.rawBody).toContain('<strong>');
    expect(envelope.categories).toEqual(['status']);
  });

  it('keeps NormalizedItem free of raw HTML fields', () => {
    const item = {
      atomId: 'tag:status.example.com,2005:Incident/1',
      title: 'Example Incident',
      link: 'https://status.example.com/incidents/1',
      publishedAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:05:00.000Z',
      author: 'Example',
      commentsUrl: 'https://status.example.com/incidents/1#comments',
      image: 'https://status.example.com/incidents/1.png',
      summary: 'Investigating - Details',
      incidentStage: 'Investigating',
      contentHash: 'sha256-placeholder'
    } satisfies NormalizedItem;

    expect('rawBody' in item).toBe(false);
    expect(item.summary).not.toContain('<strong>');
  });

  it('separates persisted source profile options from concrete normalizer profiles', () => {
    expect(PROFILES).toEqual(['generic', 'incident-io', 'atlassian-statuspage']);
    expect(SOURCE_PROFILE_OPTIONS).toEqual(['auto', 'generic', 'incident-io', 'atlassian-statuspage']);
  });

  it('captures fetch options without storing API keys in the contract', () => {
    const options = {
      charset: 'euc-kr',
      userAgent: 'rss-discord-bridge-test/1.0',
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      timeoutMs: 10_000,
      tlsMaxVersion: 'TLSv1.2'
    } satisfies FetchOptions;

    expect(options.tlsMaxVersion).toBe('TLSv1.2');
    expect(TLS_MAX_VERSIONS).toEqual(['TLSv1.2', 'TLSv1.3']);
    expect(Object.keys(options)).not.toContain('apiKey');
  });
});
