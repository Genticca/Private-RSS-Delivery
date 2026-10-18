/**
 * 발송 계획 정책. 초기 발송과 내용 갱신을 구분하고 원본 발송 이력이 있는 연결에만 수정 작업을 만든다.
 */
import type { SourceRecord } from '../sources/repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import type { ItemRecord } from '../feed/repository.js';
import type {
  DeliveryOperation,
  DeliveryBindingRepository,
  DeliveryJobRepository,
  ItemDeliveryRepository
} from './repository.js';

/** 소스의 메시지 수정 설정에 따라 PATCH 작업과 별도 갱신 POST를 고른다. */
export function updateOperation(source: Pick<SourceRecord, 'editInPlace'>): DeliveryOperation {
  return source.editInPlace ? 'edit' : 'update_post';
}

/** 신규 건수 또는 전체 대비 비율이 임계값에 도달하면 대량 발송을 관리자 검토로 보류한다. */
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

/** 실패 횟수에 따른 지수 대기와 외부 Retry-After 중 긴 시간을 적용한다. */
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

/** 새 항목·갱신 항목을 현재 연결과 원본 발송 이력에 맞춰 작업으로 계획한다. */
export class DeliveryPlanService {
  constructor(private readonly repositories: DeliveryPlanRepositories) { }

  /** 연결의 초기 수집 기준이 확정됐고 항목 ID가 그 기준 이후일 때만 최초 발송을 계획한다. */
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

  /** historical 항목은 재발송하지 않는다. 아직 첫 발송 전이면 최초 작업을 갱신하고 발송 이력이 있으면 갱신 작업을 만든다. */
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
