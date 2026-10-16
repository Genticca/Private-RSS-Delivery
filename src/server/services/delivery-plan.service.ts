import type { DeliveryBindingRepository, DeliveryJobRepository, ItemDeliveryRepository, ItemRecord, SourceRecord, TemplateRepository } from '../db/index.js';
import { updateOperation } from '../domain/delivery/policy.js';

export interface DeliveryPlanRepositories {
  deliveryBindings: DeliveryBindingRepository;
  deliveryJobs: DeliveryJobRepository;
  itemDeliveries: ItemDeliveryRepository;
  templates: TemplateRepository;
}

export class DeliveryPlanService {
  constructor(private readonly repositories: DeliveryPlanRepositories) {}

  planNew(item: ItemRecord, source: SourceRecord, now: string, held = false): void {
    const templateBody = this.template(source);
    for (const binding of this.repositories.deliveryBindings.listActive(source.id)) {
      if (binding.baselineItemId !== null && binding.baselineAt !== null && item.id > binding.baselineItemId) {
        this.repositories.deliveryJobs.plan(item, source, binding.id, 'initial_post', templateBody, now, held);
      }
    }
  }

  planUpdate(item: ItemRecord, source: SourceRecord, now: string): void {
    if (item.deliveryStatus === 'historical') return;
    const templateBody = this.template(source);
    for (const binding of this.repositories.deliveryBindings.listActive(source.id)) {
      const receipt = this.repositories.itemDeliveries.get(item.id, binding.id);
      if (receipt && receipt.appliedRevision < item.contentRevision) {
        this.repositories.deliveryJobs.plan(item, source, binding.id, updateOperation(source), templateBody, now);
      } else if (!receipt) {
        // Refresh an already planned initial job; never invent a recipient for an old item.
        const initial = this.repositories.deliveryJobs.list({ itemId: item.id, limit: 100_000 })
          .find((job) => job.bindingId === binding.id && job.operation === 'initial_post');
        if (initial) this.repositories.deliveryJobs.plan(item, source, binding.id, 'initial_post', templateBody, now, initial.state === 'held');
      }
    }
  }

  private template(source: SourceRecord): string {
    return (source.templateId === null ? this.repositories.templates.findByName('minimal') : this.repositories.templates.getById(source.templateId))?.body ?? '';
  }
}
