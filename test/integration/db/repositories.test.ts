import type { Container } from '../../../src/server/container.js';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { addSecondsIso } from '../../../src/server/core/db.js';
import { createContainer } from '../../../src/server/container.js';

let containers: Container[] = [];

afterEach(async () => {
  for (const container of containers.splice(0)) {
    await container.close();
  }
});

describe('repository foundation', () => {
  it('wires group/source/template repositories and DB-authoritative poll state', () => {
    const container = openContainer();
    const { groups, sourceGroups, sources, templates } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';

    const group = groups.create({ name: 'Security Advisories', createdAt: base });
    expect(group.webhookUrl).toBeNull();
    expect(groups.findByNameNocase('security advisories')?.id).toBe(group.id);

    const template = templates.upsertBuiltin('default', 'Default', '{"content":"{{item.title}}"}', base);
    expect(template.isBuiltin).toBe(true);

    const source = sources.create({
      feedUrl: 'https://example.com/all.xml',
      name: 'Example Feed',
      templateId: template.id,
      pollIntervalSeconds: 60,
      fetchOptions: { charset: 'utf-8', timeoutMs: 5000 },
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      threadId: '444',
      threadName: 'Security Thread',
      appliedTags: ['555'],
      editInPlace: true,
      createdAt: base
    });
    sourceGroups.setGroups(source.id, [group.id, group.id]);

    expect(sourceGroups.listGroupIdsForSource(source.id)).toEqual([group.id]);
    expect(sourceGroups.listSourceIdsForGroup(group.id)).toEqual([source.id]);
    expect(sources.findByFeedUrl('https://example.com/all.xml')).toMatchObject({
      id: source.id,
      silent: true,
      mentionRoleIds: ['111', '222'],
      mentionUserIds: ['333'],
      mentionEveryone: true,
      threadId: '444',
      threadName: 'Security Thread',
      appliedTags: ['555'],
      editInPlace: true
    });
    expect(sources.findDuePoll(base).map((record) => record.id)).toContain(source.id);

    const claimed = sources.claimPollStarted(source.id, base);
    expect(claimed.lastPolledAt).toBe(base);

    const completed = sources.markPolled(source.id, base, {
      initialized: true,
      etag: 'etag-1',
      lastModified: 'Fri, 29 May 2026 00:00:00 GMT',
      detectedProfile: 'generic'
    });
    expect(completed.nextPollAt).toBe(addSecondsIso(base, 60));
    expect(sources.findDuePoll(base)).toEqual([]);
    expect(sources.findDuePoll(addSecondsIso(base, 60)).map((record) => record.id)).toEqual([source.id]);

    sources.setEnabled(source.id, false, base);
    expect(sources.findDuePoll(addSecondsIso(base, 60))).toEqual([]);
  });

  it('stores item content and versions without delivery or translation state', () => {
    const container = openContainer();
    const { items, sources } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';
    const source = sources.create({ feedUrl: 'https://example.com/feed.xml', createdAt: base });

    expect(() =>
      items.insert({ sourceId: source.id, atomId: 'missing-hash', title: 'Missing hash', contentHash: '' })
    ).toThrow('items.content_hash must not be empty.');

    const item = items.insert({
      sourceId: source.id,
      atomId: 'atom-1',
      title: 'Title',
      link: 'https://example.com/item',
      summary: 'Summary',
      contentHash: 'hash-1',
      author: 'CISA',
      commentsUrl: 'https://example.com/comments',
      image: 'https://example.com/image.png',
      createdAt: base
    });
    expect(item).toMatchObject({ historical: false, contentRevision: 1, contentPruned: false });
    expect(items.findByAtomId(source.id, 'atom-1')?.id).toBe(item.id);
    expect(Object.keys(item)).not.toContain('deliveryStatus');
    expect(Object.keys(item)).not.toContain('translatedTitle');

    // 표시 필드만 바뀌면 revision을 유지하고, 내용 해시가 바뀔 때만 올린다.
    expect(items.updateContentHash(item.id, { title: 'Title', summary: 'Summary changed', contentHash: 'hash-1' }).contentRevision).toBe(1);
    const updated = items.updateContentHash(item.id, { title: 'Title changed', link: 'https://example.com/item', summary: 'Summary changed', contentHash: 'hash-2' });
    expect(updated).toMatchObject({ contentHash: 'hash-2', contentRevision: 2, title: 'Title changed' });

    const historical = items.insert({ sourceId: source.id, atomId: 'baseline', title: 'Baseline', contentHash: 'hash-3', historical: true });
    expect(historical.historical).toBe(true);
    expect(items.latestForSource(source.id)?.id).toBe(historical.id);
    expect(items.deleteBySourceId(source.id)).toBe(2);
  });

  it('records fetch, delivery and translation events with id cursors and retention pruning', () => {
    const container = openContainer();
    const { eventLog, items, sources } = container.repositories;
    const base = '2026-05-29T00:00:00.000Z';
    const old = '2025-01-01T00:00:00.000Z';
    const source = sources.create({ feedUrl: 'https://example.com/logs.xml', createdAt: base });
    const other = sources.create({ feedUrl: 'https://example.com/other.xml', createdAt: base });
    const item = items.insert({ sourceId: source.id, atomId: 'atom-log', contentHash: 'hash-log', createdAt: base });

    const fetched = eventLog.append({ kind: 'fetch', status: 'ok', sourceId: source.id, httpStatus: 200, durationMs: 25, itemCount: 1, createdAt: base });
    eventLog.append({ kind: 'fetch', status: 'error', sourceId: other.id, detail: 'timeout', createdAt: base });
    const delivered = eventLog.append({ kind: 'delivery', status: 'success', itemId: item.id, jobId: 7, httpStatus: 204, createdAt: base });
    eventLog.append({ kind: 'translation', status: 'failed', detail: 'x'.repeat(2000), createdAt: base });
    eventLog.append({ kind: 'fetch', status: 'not_modified', sourceId: source.id, httpStatus: 304, createdAt: old });

    // 소스를 생략하면 항목의 소스를 기록한다.
    expect(eventLog.list({ kind: 'delivery' })[0]).toMatchObject({ id: delivered, sourceId: source.id, itemId: item.id, jobId: 7 });
    expect(eventLog.list({ kind: 'translation' })[0].detail).toHaveLength(1000);
    expect(eventLog.list({ kind: 'fetch', before: fetched + 1 }).map((event) => event.id)).toEqual([fetched]);
    expect(eventLog.listAfterId(fetched).map((event) => event.kind)).toEqual(['fetch', 'delivery', 'translation', 'fetch']);
    // 가장 최근 수집 결과는 id 기준이다(시각이 과거여도 나중에 기록된 결과).
    expect(Object.fromEntries(eventLog.latestFetchStatusBySourceIds([source.id, other.id]))).toEqual({ [source.id]: 'not_modified', [other.id]: 'error' });
    expect(eventLog.latestTranslationRequest()?.status).toBe('failed');
    expect(eventLog.countByStatus('fetch')).toEqual({ ok: 1, error: 1, not_modified: 1 });
    expect(() => eventLog.append({ kind: 'fetch', status: 'success' })).toThrow();
    expect(eventLog.pruneOlderThan(30, base)).toBe(1);

    sources.delete(source.id);
    expect(eventLog.list().map((event) => event.sourceId)).toEqual([null, other.id]);
  });
});

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}
