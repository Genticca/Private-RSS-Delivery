import type { DeliveryBindingRepository, DeliveryJobRepository, ItemDeliveryRepository, ItemRecord, SourceRecord, TemplateRepository } from '../db/index.js';
import { updateOperation } from '../domain/delivery/policy.js';

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
    if (item.deliveryStatus === 'historical') return;
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
