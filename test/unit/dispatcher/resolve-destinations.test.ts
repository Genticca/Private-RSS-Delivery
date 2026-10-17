import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { mapGroupDestination } from '../../../src/server/delivery/bindings.js';
import { resolveDestinationsForSource } from '../../../src/server/delivery/bindings.js';
import type { GroupRecord } from '../../../src/server/groups/repository.js';
import { canonicalWebhookUrl } from '../../../src/server/net/webhook-url.js';
import { createHash } from 'node:crypto';
import type { SourceRecord } from '../../../src/server/sources/repository.js';

const BASE_TIME = '2026-05-29T00:00:00.000Z';

describe('dispatcher destination resolution', () => {
  it('maps selected groups into delivery destinations with byte-identical keys', () => {
    const source = sourceRecord({ threadId: '444' });
    const group = groupRecord(10, {
      webhookUrl: 'https://discord.com/api/webhooks/123/TokenABC/',
      webhookName: 'Group Bot',
      webhookAvatarUrl: 'https://example.com/group.png'
    });

    expect(mapGroupDestination(source, group)).toEqual({
      webhookUrl: 'https://discord.com/api/webhooks/123/TokenABC/',
      webhookName: 'Group Bot',
      webhookAvatarUrl: 'https://example.com/group.png',
      destinationKey: keyFor(group.webhookUrl!, '444'),
      threadId: '444'
    });
  });

  it('fans out to selected groups, skips groups without webhooks, and keeps group id order', () => {
    const source = sourceRecord();
    const groups = [
      groupRecord(30, { webhookUrl: 'https://discord.com/api/webhooks/300/third' }),
      groupRecord(10, { webhookUrl: 'https://discord.com/api/webhooks/100/first' }),
      groupRecord(20, { webhookUrl: null })
    ];

    const destinations = resolveDestinationsForSource(source, repositoriesFor([10, 20, 30], groups));

    expect(destinations.map((destination) => destination.webhookUrl)).toEqual([
      'https://discord.com/api/webhooks/100/first',
      'https://discord.com/api/webhooks/300/third'
    ]);
  });

  it('uses source display overrides and falls back to group display fields', () => {
    const group = groupRecord(10, {
      webhookUrl: 'https://discord.com/api/webhooks/100/group-token',
      webhookName: 'Group Bot',
      webhookAvatarUrl: 'https://example.com/group.png'
    });

    expect(resolveDestinationsForSource(sourceRecord({ webhookName: ' Source Bot ', webhookAvatarUrl: 'https://example.com/source.png' }), repositoriesFor([10], [group]))[0]).toMatchObject({
      webhookName: ' Source Bot ',
      webhookAvatarUrl: 'https://example.com/source.png'
    });
    expect(resolveDestinationsForSource(sourceRecord({ webhookName: '   ', webhookAvatarUrl: null }), repositoriesFor([10], [group]))[0]).toMatchObject({
      webhookName: 'Group Bot',
      webhookAvatarUrl: 'https://example.com/group.png'
    });
  });

  it('deduplicates canonical URL and source thread identity while keeping the first group', () => {
    const source = sourceRecord({ threadId: '999' });
    const groups = [
      groupRecord(10, { webhookUrl: 'https://discord.com/api/webhooks/123/TokenABC/', webhookName: 'First' }),
      groupRecord(11, { webhookUrl: 'https://DISCORD.com/api/webhooks/123/TokenABC', webhookName: 'Duplicate' }),
      groupRecord(12, { webhookUrl: 'https://discord.com/api/webhooks/124/tokenabc', webhookName: 'Other' })
    ];

    const destinations = resolveDestinationsForSource(source, repositoriesFor([10, 11, 12], groups));

    expect(destinations.map((destination) => destination.webhookName)).toEqual(['First', 'Other']);
    expect(destinations.map((destination) => destination.destinationKey)).toEqual([
      keyFor('https://discord.com/api/webhooks/123/TokenABC/', '999'),
      keyFor('https://discord.com/api/webhooks/124/tokenabc', '999')
    ]);
  });

  it('preserves canonical group identity together with source thread identity', () => {
    const source = sourceRecord({ threadId: '1234567890' });
    const groupUrl = 'https://discord.com/api/webhooks/400/GroupToken/';
    const d23CopiedSourceDestinationUrl = groupUrl;

    const [destination] = resolveDestinationsForSource(
      source,
      repositoriesFor([40], [groupRecord(40, { webhookUrl: groupUrl })])
    );

    expect(destination?.destinationKey).toBe(keyFor(d23CopiedSourceDestinationUrl, source.threadId));
  });
});

function repositoriesFor(groupIds: readonly number[], groups: readonly GroupRecord[]) {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return {
    sourceGroups: {
      listGroupIdsForSource: () => [...groupIds]
    },
    groups: {
      getById: (id: number) => groupById.get(id) ?? null
    }
  };
}

function keyFor(url: string, threadId?: string | null): string {
  const canonical = canonicalWebhookUrl(url);
  return createHash('sha256').update(threadId ? `${canonical}
${threadId}` : canonical).digest('hex');
}

function sourceRecord(patch: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'source-1',
    configRevision: 1,
    consecutiveFailures: 0,
    feedUrl: 'https://example.com/feed.xml',
    name: 'Example Feed',
    enabled: true,
    profileSetting: 'auto',
    detectedProfile: 'generic',
    initialized: true,
    deliveryCutoffAt: null,
    etag: null,
    lastModified: null,
    lastPolledAt: null,
    nextPollAt: null,
    templateId: null,
    webhookName: null,
    webhookAvatarUrl: null,
    pollIntervalSeconds: 300,
    fetchOptions: {},
    translate: false,
    silent: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    mentionEveryone: false,
    mentionHere: false,
    threadId: null,
    threadName: null,
    appliedTags: [],
    editInPlace: false,
    createdAt: BASE_TIME,
    ...patch
  };
}

function groupRecord(id: number, patch: Partial<GroupRecord> = {}): GroupRecord {
  return {
    id,
    name: `Group ${id}`,
    webhookUrl: null,
    webhookName: null,
    webhookAvatarUrl: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...patch
  };
}
