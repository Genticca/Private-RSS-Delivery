import type { SourceRecord } from '../sources/repository.js';
import type { DeliveryOperation } from './repository.js';
import type { DeliveryBindingRepository } from './repository.js';
import type { DeliveryJobRepository } from './repository.js';
import type { ItemDeliveryRepository } from './repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import type { ItemRecord } from '../feed/repository.js';

export function updateOperation(source: Pick<SourceRecord, 'editInPlace'>): DeliveryOperation {
  return source.editInPlace ? 'edit' : 'update_post';
}

export function shouldHoldNewItems(newCount: number, totalCount: number, limits: {
  holdCount: number;
  holdMinItems: number;
  holdRatio: number
}): boolean {
  const exceedsCountLimit = newCount >= limits.holdCount;
  const hasEnoughItems = newCount >= limits.holdMinItems;
  const newItemRatio = newCount / Math.max(1, totalCount);

  // 소수의 업데이트만으로 비율이 높아져 보류되지 않도록 최소 건수도 확인한다.
  return exceedsCountLimit || (hasEnoughItems && newItemRatio >= limits.holdRatio);
}

export function retryAt(now: string, failures: number, retryAfterMs?: number): string {
  const failureExponent = Math.max(0, failures - 1);
  const backoffMs = Math.min(480_000, 60_000 * 2 ** failureExponent);
  // 자체 재시도 간격보다 서버의 Retry-After가 길면 서버가 지정한 시간을 따른다.
  const delayMs = Math.max(retryAfterMs ?? 0, backoffMs);
  return new Date(Date.parse(now) + delayMs).toISOString();
}

export interface DeliveryPlanRepositories {
  deliveryBindings: DeliveryBindingRepository;
  deliveryJobs: DeliveryJobRepository;
  itemDeliveries: ItemDeliveryRepository;
  templates: TemplateRepository;
}

export class DeliveryPlanService {
  constructor(private readonly repositories: DeliveryPlanRepositories) { }

  planNew(item: ItemRecord, source: SourceRecord, now: string, held = false): void {
    const templateBody = this.resolveTemplateBody(source);
    for (const binding of this.repositories.deliveryBindings.listActive(source.id)) {
      // 연결의 첫 수집에서 기준점이 확정된 뒤, 그 기준점 이후의 항목만 보낸다.
      if (binding.baselineItemId === null || binding.baselineAt === null) continue;
      if (item.id > binding.baselineItemId) {
        this.repositories.deliveryJobs.plan(item, source, binding.id, 'initial_post', templateBody, now, held);
      }
    }
  }

  planUpdate(item: ItemRecord, source: SourceRecord, now: string): void {
    if (item.historical) return;
    const templateBody = this.resolveTemplateBody(source);
    for (const binding of this.repositories.deliveryBindings.listActive(source.id)) {
      const receipt = this.repositories.itemDeliveries.get(item.id, binding.id);
      if (receipt && receipt.appliedRevision < item.contentRevision) {
        this.repositories.deliveryJobs.plan(item, source, binding.id, updateOperation(source), templateBody, now);
      } else if (!receipt) {
        // 기존 최초 발송 작업만 갱신한다. 과거 항목에 발송 대상을 새로 만들지 않는다.
        const initial = this.repositories.deliveryJobs.list({ itemId: item.id, limit: 100_000 })
          .find((job) => job.bindingId === binding.id && job.operation === 'initial_post');
        if (initial) {
          this.repositories.deliveryJobs.plan(item, source, binding.id, 'initial_post', templateBody, now, initial.state === 'held');
        }
      }
    }
  }

  private resolveTemplateBody(source: SourceRecord): string {
    const templates = this.repositories.templates;
    const template = source.templateId === null
      ? templates.findByName('minimal')
      : templates.getById(source.templateId);
    return template?.body ?? '';
  }
}
