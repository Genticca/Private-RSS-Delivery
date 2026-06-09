import { createHash } from 'node:crypto';
import type { GroupRecord, GroupRepository, SourceGroupRepository, SourceRecord } from '../db/index.js';
import { assertSafeWebhookUrl, canonicalWebhookUrl } from '../security/webhook-guard.js';
import { blankToNull } from '../services/validation.js';

export interface DeliveryDestination {
  webhookUrl: string;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  destinationKey: string;
  threadId: string | null;
}

export interface DestinationRepositories {
  sourceGroups: Pick<SourceGroupRepository, 'listGroupIdsForSource'>;
  groups: Pick<GroupRepository, 'getById'>;
}

export function resolveDestinationsForSource(source: SourceRecord, repositories: DestinationRepositories): DeliveryDestination[] {
  const seen = new Set<string>();
  const destinations: DeliveryDestination[] = [];

  for (const groupId of repositories.sourceGroups.listGroupIdsForSource(source.id)) {
    const group = repositories.groups.getById(groupId);
    if (!group?.webhookUrl) continue;
    const identity = destinationIdentity(group.webhookUrl, source.threadId);
    if (seen.has(identity)) continue;
    seen.add(identity);
    destinations.push(mapGroupDestination(source, group, identity));
  }

  return destinations;
}

export function mapGroupDestination(source: SourceRecord, group: GroupRecord, identity?: string): DeliveryDestination {
  if (!group.webhookUrl) throw new Error('Group destination requires webhookUrl.');
  const resolvedIdentity = identity ?? destinationIdentity(group.webhookUrl, source.threadId);
  return {
    webhookUrl: assertSafeWebhookUrl(group.webhookUrl).toString(),
    webhookName: blankToNull(source.webhookName) ?? group.webhookName,
    webhookAvatarUrl: blankToNull(source.webhookAvatarUrl) ?? group.webhookAvatarUrl,
    destinationKey: createDestinationKey(resolvedIdentity),
    threadId: source.threadId
  };
}

export function createDestinationKey(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}

function destinationIdentity(webhookUrl: string, threadId: string | null): string {
  const canonicalUrl = canonicalWebhookUrl(webhookUrl);
  return threadId ? canonicalUrl + '\n' + threadId : canonicalUrl;
}
