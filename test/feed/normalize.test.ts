import { describe, it, expect } from 'vitest';
import { parseFeed, type FeedEnvelope } from '../../src/server/feed/parse.js';
import {
  normalize,
  computeGenericContentHash,
  normalizeGeneric,
  detectProfile,
  effectiveProfile
} from '../../src/server/feed/normalize.js';
import { readFeedFixture } from '../mocks/fixtures.js';

describe('normalize Stage 2', () => {
  it('normalizes generic HTML into clean text and strips title markup without leaking raw fields', () => {
    const env = {
      atomId: 'rss-1',
      title: '<b>Alert &amp; News</b>',
      link: 'https://example.com/items/1',
      publishedAt: '2026-05-29T00:00:00.000Z',
      updatedAt: '2026-05-29T00:05:00.000Z',
      author: 'Example',
      commentsUrl: 'https://example.com/items/1#comments',
      image: 'https://example.com/items/1.png',
      rawBody: '<p>Hello&nbsp;<strong>world</strong></p><ul><li>One</li><li>Two</li></ul><br/>Tail &amp; end',
      categories: ['ignored']
    } satisfies FeedEnvelope;

    const item = normalize('generic', env);

    expect(item).toMatchObject({
      atomId: 'rss-1',
      title: 'Alert & News',
      link: 'https://example.com/items/1',
      publishedAt: '2026-05-29T00:00:00.000Z',
      updatedAt: '2026-05-29T00:05:00.000Z',
      author: 'Example',
      commentsUrl: 'https://example.com/items/1#comments',
      image: 'https://example.com/items/1.png',
      summary: 'Hello world\n· One\n· Two\nTail & end'
    });
    expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item.contentHash).toBe(
      computeGenericContentHash({
        title: 'Alert & News',
        link: 'https://example.com/items/1'
      })
    );
    expect('rawBody' in item).toBe(false);
    expect('categories' in item).toBe(false);
    expect(item.incidentStage).toBeUndefined();
  });

  it('keeps generic contentHash deterministic and independent from dates', () => {
    const base = {
      atomId: 'rss-2',
      title: 'Same title',
      link: 'https://example.com/same',
      rawBody: '<p>Same body</p>',
      categories: []
    } satisfies FeedEnvelope;

    const first = normalize('generic', { ...base, publishedAt: '2026-01-01T00:00:00.000Z' });
    const second = normalize('generic', { ...base, updatedAt: '2026-12-31T00:00:00.000Z' });

    expect(first.contentHash).toBe(second.contentHash);
    expect(normalize('generic', base).contentHash).toBe(normalize('generic', base).contentHash);
  });

  it('keeps generic contentHash independent from summary churn', () => {
    const first = normalize('generic', {
      atomId: 'summary-1',
      title: 'Same title',
      link: 'https://example.com/same',
      rawBody: '<p>First body</p>',
      categories: []
    });
    const second = normalize('generic', {
      atomId: 'summary-1',
      title: 'Same title',
      link: 'https://example.com/same',
      rawBody: '<p>Changed body</p>',
      categories: []
    });

    expect(first.summary).not.toBe(second.summary);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('changes generic contentHash when title or link changes', () => {
    const base = {
      atomId: 'identity-1',
      title: 'Same title',
      link: 'https://example.com/same',
      rawBody: '<p>Same body</p>',
      categories: []
    } satisfies FeedEnvelope;

    expect(normalize('generic', base).contentHash).not.toBe(
      normalize('generic', { ...base, title: 'Changed title' }).contentHash
    );
    expect(normalize('generic', base).contentHash).not.toBe(
      normalize('generic', { ...base, link: 'https://example.com/changed' }).contentHash
    );
  });

  it('truncates very large generic summaries deterministically at a word boundary', () => {
    const repeated = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ');
    const item = normalize('generic', {
      atomId: 'long',
      title: 'Long',
      link: 'https://example.com/long',
      rawBody: `<p>${repeated}</p>`,
      categories: []
    });

    expect(item.summary.length).toBeLessThanOrEqual(4000);
    expect(item.summary.endsWith('…')).toBe(true);
    expect(item.summary).not.toContain('<p>');
  });

  it('normalizes CISA and CVE fixtures with generic floor only', async () => {
    const cisa = normalize('generic', parseFeed(await readFeedFixture('CISA.xml'))[0]!);
    expect(cisa.title).toBe('Eppendorf BioFlo 320');
    expect(cisa.summary).toContain('Summary');
    expect(cisa.summary).toContain('Privacy & Use policy');
    expect(cisa.summary).not.toMatch(/<[^>]+>/);
    expect(cisa.incidentStage).toBeUndefined();

    const cve = normalize('generic', parseFeed(await readFeedFixture('CVEFeed.xml'))[0]!);
    expect(cve.title).toContain('CVE-');
    expect(cve.summary).toContain('CVE ID');
    expect(cve.summary).not.toMatch(/<[^>]+>/);
    expect('severity' in cve).toBe(false);
    expect('cvss' in cve).toBe(false);
  });

  it('extracts incident-io current status and hashes only stage plus current summary', async () => {
    const openai = parseFeed(await readFeedFixture('OpenAI.atom'))[0]!;
    const item = normalize('incident-io', openai);
    const withDifferentPrefix = normalize('incident-io', {
      ...openai,
      rawBody: `<p>ignored prefix</p>${openai.rawBody}`
    });

    expect(item.incidentStage).toBe('Monitoring');
    expect(item.summary).toContain('We have received additional reports');
    expect(item.summary).toContain('· Embeddings');
    expect(item.summary).not.toContain('Status: Monitoring');
    expect(item.contentHash).toBe(withDifferentPrefix.contentHash);
    expect('rawBody' in item).toBe(false);
  });

  it('keeps incident.io component-order changes out of the summary and content hash', () => {
    const first = normalize('incident-io', incidentEnvelope(['Responses', 'Files', 'Images']));
    const second = normalize('incident-io', incidentEnvelope(['Images', 'Responses', 'Files']));

    expect(first.summary).toBe('We are monitoring recovery.\nAffected components\n· Files (Degraded performance)\n· Images (Degraded performance)\n· Responses (Degraded performance)');
    expect(second.summary).toBe(first.summary);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it.each([
    ['component addition', ['Files', 'Images', 'Responses']],
    ['component removal', ['Files']],
    ['component status change', ['Files', 'Images (Operational)']]
  ] as const)('still detects an incident.io %s', (_label, components) => {
    const first = normalize('incident-io', incidentEnvelope(['Files', 'Images']));
    const changed = normalize('incident-io', incidentEnvelope(components));

    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it('preserves narrative and other list ordering around incident.io components', () => {
    const first = normalize('incident-io', {
      ...incidentEnvelope(['Images', 'Files']),
      rawBody: '<b>Status: Monitoring</b><p>Follow these steps.</p><ol><li>Restart the service</li><li>Check recovery</li></ol>'
        + '<b>Affected components</b><ul><li>Images (Degraded performance)</li><li>Files (Degraded performance)</li></ul><p>Next update soon.</p>'
    });
    const changed = normalize('incident-io', {
      ...incidentEnvelope(['Images', 'Files']),
      rawBody: '<b>Status: Monitoring</b><p>Follow these steps.</p><ol><li>Check recovery</li><li>Restart the service</li></ol>'
        + '<b>Affected components</b><ul><li>Files (Degraded performance)</li><li>Images (Degraded performance)</li></ul><p>Next update soon.</p>'
    });

    expect(first.summary).toContain('· Restart the service\n· Check recovery');
    expect(changed.summary).toContain('· Check recovery\n· Restart the service');
    expect(first.summary.endsWith('Next update soon.')).toBe(true);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it('orders incident.io components before truncating a long summary', () => {
    const components = Array.from({ length: 180 }, (_, index) => `Component ${String(index).padStart(3, '0')}`);
    const first = normalize('incident-io', incidentEnvelope(components));
    const reversed = normalize('incident-io', incidentEnvelope([...components].reverse()));

    expect(first.summary.length).toBeLessThanOrEqual(4000);
    expect(first.summary.endsWith('…')).toBe(true);
    expect(reversed.summary).toBe(first.summary);
    expect(reversed.contentHash).toBe(first.contentHash);
  });

  it('preserves component-list presentation for generic feeds', () => {
    const item = normalize('generic', incidentEnvelope(['Images', 'Files']));

    expect(item.summary).toContain('· Images (Degraded performance)\n· Files (Degraded performance)');
  });

  it('extracts only the latest Atlassian Statuspage paragraph and ignores older cumulative history', async () => {
    const claude = parseFeed(await readFeedFixture('Claude.atom'))[0]!;
    const item = normalize('atlassian-statuspage', claude);
    const withOlderHistoryAppended = normalize('atlassian-statuspage', {
      ...claude,
      rawBody: `${claude.rawBody}<p><strong>Investigating</strong> - Old appended history.</p>`
    });
    const withLatestSegmentChanged = normalize('atlassian-statuspage', {
      ...claude,
      rawBody: claude.rawBody.replace('This incident has been resolved.', 'This incident has been resolved after mitigation.')
    });

    expect(item.incidentStage).toBe('Resolved');
    expect(item.summary).toContain('May 27, 09:41 UTC');
    expect(item.summary).toContain('Resolved - This incident has been resolved.');
    expect(item.summary).not.toContain('A fix has been implemented');
    expect(item.contentHash).toBe(withOlderHistoryAppended.contentHash);
    expect(item.contentHash).not.toBe(withLatestSegmentChanged.contentHash);
  });

  it('falls back to generic when an incident profile cannot extract its marker', () => {
    const env = {
      atomId: 'fallback',
      title: 'Fallback',
      link: 'https://example.com/fallback',
      rawBody: '<p>No incident marker here.</p>',
      categories: []
    } satisfies FeedEnvelope;

    expect(normalize('incident-io', env)).toEqual(normalizeGeneric(env));
    expect(normalize('atlassian-statuspage', env)).toEqual(normalizeGeneric(env));
  });

  it('detects feed profiles and resolves persisted source profile settings into concrete profiles', async () => {
    const openaiXml = await readFeedFixture('OpenAI.atom');
    const claudeXml = await readFeedFixture('Claude.atom');
    const cisaXml = await readFeedFixture('CISA.xml');

    expect(detectProfile(openaiXml, parseFeed(openaiXml))).toBe('incident-io');
    expect(detectProfile(claudeXml, parseFeed(claudeXml))).toBe('atlassian-statuspage');
    expect(detectProfile(cisaXml, parseFeed(cisaXml))).toBe('generic');
    expect(effectiveProfile('auto', 'incident-io')).toBe('incident-io');
    expect(effectiveProfile('auto', null)).toBe('generic');
    expect(effectiveProfile('generic', 'incident-io')).toBe('generic');
  });
});

function incidentEnvelope(components: readonly string[]): FeedEnvelope {
  return {
    atomId: 'incident-one',
    title: 'File Download errors',
    link: 'https://example.com/incidents/one',
    rawBody: '<b>Status: Monitoring</b><p>We are monitoring recovery.</p><b>Affected components</b><ul>'
      + components.map((name) => `<li>${name.includes('(') ? name : `${name} (Degraded performance)`}</li>`).join('')
      + '</ul>',
    categories: []
  };
}
