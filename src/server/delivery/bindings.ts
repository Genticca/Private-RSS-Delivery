import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SourceGroupRepository, SourceRecord, SourceRepository } from '../sources/repository.js';
import type { GroupRepository, GroupRecord } from '../groups/repository.js';
import { assertSafeWebhookUrl, canonicalWebhookUrl } from '../net/webhook-url.js';
import { blankToNull } from '../core/input.js';
import type { DeliveryBindingRepository } from './repository.js';

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
    // 여러 그룹이 같은 웹훅·스레드를 가리켜도 메시지는 한 번만 발송한다.
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

export interface DeliveryBindingServiceOptions {
  db: Database.Database;
  repositories: {
    sources: SourceRepository;
    groups: GroupRepository;
    sourceGroups: SourceGroupRepository;
    deliveryBindings: DeliveryBindingRepository
  };
}

export class DeliveryBindingService {
  constructor(private readonly options: DeliveryBindingServiceOptions) { }

  reconcile(sourceId: string, now: string, reset = false): void {
    const { repositories, db } = this.options;
    db.transaction(() => {
      const source = repositories.sources.getById(sourceId);
      const destinations = source?.enabled ? resolveDestinationsForSource(source, repositories) : [];
      const desired = new Map(destinations.map((destination) => [destination.destinationKey, destination]));
      // 유지할 연결은 후보에서 지우고, 남은 목적지에 대해서만 새 연결을 만든다.
      for (const binding of repositories.deliveryBindings.listActive(sourceId)) {
        if (reset || !desired.has(binding.destinationKey)) repositories.deliveryBindings.end(binding.id, now);
        else desired.delete(binding.destinationKey);
      }
      for (const destination of desired.values()) {
        const group = source ? repositories.sourceGroups.listGroupIdsForSource(sourceId).map((id) => repositories.groups.getById(id))
          .find((value) => value?.webhookUrl && mapGroupDestination(source, value).destinationKey === destination.destinationKey) : null;
        const thread = this.threadLabel(source);
        repositories.deliveryBindings.create(sourceId, destination.destinationKey, createDestinationKey(canonicalWebhookUrl(destination.webhookUrl)), now, (group?.name ?? '연결') + thread);
      }
      // 새 연결은 ETag가 있더라도 전체 피드를 받아 과거 항목의 기준점을 만들어야 한다.
      if (source && repositories.deliveryBindings.listActive(sourceId).some((binding) => binding.baselineAt === null)) {
        repositories.sources.update(sourceId, { nextPollAt: null });
      }
    })();
  }

  reconcileAll(now: string): void {
    for (const source of this.options.repositories.sources.list()) {
      this.reconcile(source.id, now);
    }
  }

  private threadLabel(source: ReturnType<SourceRepository['getById']>): string {
    if (source?.threadId) return ` · 스레드 ${source.threadId}`;
    if (source?.threadName) return ` · ${source.threadName}`;
    if (source?.appliedTags.length) return ' · 포럼';
    return '';
  }

  completeBaselines(sourceId: string, now: string): void {
    const max = this.options.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM items WHERE source_id = ?').get(sourceId) as {
      id: number
    };
    for (const binding of this.options.repositories.deliveryBindings.listActive(sourceId)) {
      if (binding.baselineAt === null) this.options.repositories.deliveryBindings.completeBaseline(binding.id, max.id, now);
    }
  }
}
