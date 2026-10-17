import { describe, it, expect } from 'vitest';
import { FEED_FIXTURE_NAMES, readFeedFixture } from '../mocks/fixtures.js';
import { parseFeed } from '../../src/server/feed/parse.js';

const EXPECTED_FIXTURE_COUNTS = {
  'CISA.xml': 30,
  'Claude.atom': 25,
  'CVEFeed.xml': 25,
  'GeekNews.xml': 50,
  'OpenAI.atom': 91,
  'TheHackersNews.xml': 50
} as const;

describe('parseFeed', () => {
  it('parses every feed fixture into non-empty Stage 1 envelopes with stable ids', async () => {
    for (const fixtureName of FEED_FIXTURE_NAMES) {
      const envelopes = parseFeed(await readFeedFixture(fixtureName));
      expect(envelopes.length, fixtureName).toBe(EXPECTED_FIXTURE_COUNTS[fixtureName]);
      expect(new Set(envelopes.map((item) => item.atomId)).size, fixtureName).toBe(envelopes.length);
      for (const envelope of envelopes) {
        expect(envelope.atomId.trim(), fixtureName).not.toBe('');
        expect(envelope.title, fixtureName).toEqual(expect.any(String));
        expect(envelope.link, fixtureName).toEqual(expect.any(String));
        expect(envelope.rawBody, fixtureName).toEqual(expect.any(String));
        expect(envelope.categories, fixtureName).toEqual(expect.any(Array));
      }
    }
  });

  it('maps Atom status feeds while preserving raw HTML for Stage 2', async () => {
    const openai = parseFeed(await readFeedFixture('OpenAI.atom'))[0];
    expect(openai).toMatchObject({
      atomId: 'https://status.openai.com//incidents/01KSMYEEWP0BZYANSMAXWJ3K59',
      title: 'Elevated Latency and Errors on API',
      link: 'https://status.openai.com//incidents/01KSMYEEWP0BZYANSMAXWJ3K59',
      updatedAt: '2026-05-27T17:54:42.447Z',
      publishedAt: '2026-05-27T17:54:42.447Z'
    });
    expect(openai.rawBody).toContain('<b>Status: Monitoring</b>');
    expect(openai.rawBody).toContain('<ul>');

    const claude = parseFeed(await readFeedFixture('Claude.atom'))[0];
    expect(claude).toMatchObject({
      atomId: 'tag:status.claude.com,2005:Incident/30330163',
      title: 'Elevated errors on Claude Opus 4.7',
      link: 'https://status.claude.com/incidents/rtr7z82cqmp9',
      author: 'Claude',
      publishedAt: '2026-05-27T09:41:14.000Z',
      updatedAt: '2026-05-27T09:41:14.000Z'
    });
    expect(claude.rawBody).toContain('<strong>Resolved</strong>');
  });

  it('maps RSS feeds with decoded HTML body, author, and media fields', async () => {
    const cisa = parseFeed(await readFeedFixture('CISA.xml'))[0];
    expect(cisa).toMatchObject({
      atomId: '/node/24928',
      title: 'Eppendorf BioFlo 320',
      link: 'https://www.cisa.gov/news-events/ics-medical-advisories/icsma-26-146-01',
      author: 'CISA',
      publishedAt: '2026-05-26T12:00:00.000Z',
      updatedAt: '2026-05-26T12:00:00.000Z'
    });
    expect(cisa.rawBody).toContain('<table class="tablesaw tablesaw-stack"');
    expect(cisa.rawBody).toContain('Privacy &amp; Use policy');

    const hackerNews = parseFeed(await readFeedFixture('TheHackersNews.xml'))[0];
    expect(hackerNews).toMatchObject({
      atomId: 'https://thehackernews.com/2026/05/grandoreiro-malware-and-btmob-rat.html',
      link: 'https://thehackernews.com/2026/05/grandoreiro-malware-and-btmob-rat.html',
      author: 'info@thehackernews.com (The Hacker News)'
    });
    expect(hackerNews.image).toContain('/s1600/android-malware.jpg');
  });

  it('carries Atom categories and author metadata without inspecting HTML body', async () => {
    const geekNews = parseFeed(await readFeedFixture('GeekNews.xml'))[0];
    expect(geekNews).toMatchObject({
      atomId: 'https://news.hada.io/topic?id=29931',
      link: 'https://news.hada.io/topic?id=29931',
      author: 'gwpark93',
      publishedAt: '2026-05-27T13:48:58.000Z',
      updatedAt: '2026-05-27T13:48:58.000Z'
    });
    expect(geekNews.title).toContain('&#039;한장&#039;');
    expect(geekNews.rawBody).toContain('<p>안녕하세요.');
  });

  it('uses RSS guid as identity, falls back to link, skips unidentifiable rows, and keeps first duplicate', () => {
    const envelopes = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <item>
            <title><![CDATA[<b>First</b>]]></title>
            <link>https://example.com/first</link>
            <guid isPermaLink="false">stable-id</guid>
            <description>description body</description>
            <content>content body</content>
            <content:encoded><![CDATA[<p>encoded body</p>]]></content:encoded>
          </item>
          <item>
            <title>Duplicate</title>
            <link>https://example.com/duplicate</link>
            <guid>stable-id</guid>
            <description>duplicate body</description>
          </item>
          <item>
            <title>Link fallback</title>
            <link>https://example.com/fallback</link>
            <description>fallback body</description>
          </item>
          <item>
            <title>No id</title>
            <description>skip me</description>
          </item>
        </channel>
      </rss>`);

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      atomId: 'stable-id',
      title: '<b>First</b>',
      link: 'https://example.com/first',
      rawBody: '<p>encoded body</p>'
    });
    expect(envelopes[1]).toMatchObject({
      atomId: 'https://example.com/fallback',
      title: 'Link fallback',
      rawBody: 'fallback body'
    });
  });

  it('decodes XML entities once without collapsing double-escaped HTML entities', () => {
    const envelope = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <guid>entity-once</guid>
            <title>A &amp;amp; B</title>
            <link>https://example.com/entity-once</link>
            <description>&amp;lt;p&amp;gt;Double escaped &amp;amp;amp; safe&amp;lt;/p&amp;gt;</description>
          </item>
          <item>
            <guid>entity-html</guid>
            <title>HTML body</title>
            <link>https://example.com/entity-html</link>
            <description>&lt;p&gt;Single escaped &amp;amp; decoded&lt;/p&gt;</description>
          </item>
        </channel>
      </rss>`);

    expect(envelope[0]).toMatchObject({
      title: 'A &amp; B',
      rawBody: '&lt;p&gt;Double escaped &amp;amp; safe&lt;/p&gt;'
    });
    expect(envelope[1]?.rawBody).toBe('<p>Single escaped &amp; decoded</p>');
  });

  it('carries comments, categories, and image metadata without parsing HTML content', () => {
    const rss = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:media="http://search.yahoo.com/mrss/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:slash="http://purl.org/rss/1.0/modules/slash/">
        <channel>
          <item>
            <title>RSS metadata</title>
            <link>https://example.com/rss</link>
            <comments>https://example.com/rss/comments</comments>
            <category>security</category>
            <category>security</category>
            <dc:subject>advisory</dc:subject>
            <slash:comments>7</slash:comments>
            <media:thumbnail url="https://example.com/rss.png"/>
            <description><![CDATA[<p>body</p>]]></description>
          </item>
        </channel>
      </rss>`)[0];

    expect(rss).toMatchObject({
      atomId: 'https://example.com/rss',
      commentsUrl: 'https://example.com/rss/comments',
      image: 'https://example.com/rss.png',
      categories: ['security', 'advisory']
    });

    const atom = parseFeed(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
        <entry>
          <id>tag:example.com,2026:atom</id>
          <title>Atom metadata</title>
          <link rel="self" href="https://example.com/atom.xml"/>
          <link rel="alternate" href="https://example.com/atom"/>
          <link rel="replies" href="https://example.com/atom/replies"/>
          <category term="ops"/>
          <category term="ops"/>
          <category term="incident"/>
          <media:content url="https://example.com/atom.png"/>
          <content><![CDATA[<p>atom body</p>]]></content>
        </entry>
      </feed>`)[0];

    expect(atom).toMatchObject({
      atomId: 'tag:example.com,2026:atom',
      link: 'https://example.com/atom',
      commentsUrl: 'https://example.com/atom/replies',
      image: 'https://example.com/atom.png',
      categories: ['ops', 'incident']
    });
  });

  it('requires Atom entry id and rejects unsupported roots', () => {
    expect(
      parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>No id</title>
          <link href="https://example.com/no-id"/>
          <content>skip me</content>
        </entry>
      </feed>`)
    ).toEqual([]);

    expect(() => parseFeed('<not-feed />')).toThrow('Unsupported feed root');
    expect(() => parseFeed('<rss><channel><item></channel></rss>')).toThrow('Invalid feed XML');
  });
});
