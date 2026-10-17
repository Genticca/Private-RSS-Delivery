import type Database from 'better-sqlite3';
import type { SourceRepository } from '../db/source.repository.js';
import type { GroupRepository } from '../db/group.repository.js';
import type { SourceGroupRepository } from '../db/source-group.repository.js';
import type { DeliveryBindingRepository } from '../db/delivery-binding.repository.js';
import { resolveDestinationsForSource } from '../dispatcher/resolve-destinations.js';
import { mapGroupDestination } from '../dispatcher/resolve-destinations.js';
import { createDestinationKey } from '../dispatcher/resolve-destinations.js';
import { canonicalWebhookUrl } from '../net/webhook-url.js';

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
