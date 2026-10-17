import type { DeliveryJobState } from '../domain/delivery/policy.js';
import type Database from 'better-sqlite3';
import type { DeliveryJobRepository } from '../db/delivery-job.repository.js';
import type { DeliveryBindingRepository } from '../db/delivery-binding.repository.js';
import type { ItemRepository } from '../feed/repository.js';
import type { SourceRepository } from '../db/source.repository.js';
import type { ItemDeliveryRepository } from '../db/item-delivery.repository.js';
import type { DeliveryPlanService } from './delivery-plan.service.js';
import { requireObject } from '../core/input.js';
import { optionalString } from '../core/input.js';
import { validationError } from '../core/errors.js';
import { optionalInteger } from '../core/input.js';
import { notFound } from '../core/errors.js';
import { nowIso } from '../core/db.js';
import { parseDiscordId } from '../core/input.js';

const DELIVERY_JOB_STATES: readonly DeliveryJobState[] = [
  'pending', 'running', 'succeeded', 'failed', 'cancelled',
  'held', 'unknown', 'uneditable'
];

const ARCHIVABLE_STATES: readonly DeliveryJobState[] = ['held', 'unknown', 'uneditable'];

const UNRESOLVED_STATES: readonly DeliveryJobState[] = ['unknown', 'uneditable'];

/** 자동 발송이 멈춘 작업에 관리자 결정을 반영한다. */
export class DeliveryManagementService {
  constructor(
    private readonly db: Database.Database,
    private readonly repositories: {
      deliveryJobs: DeliveryJobRepository;
      deliveryBindings: DeliveryBindingRepository;
      items: ItemRepository;
      sources: SourceRepository;
      itemDeliveries: ItemDeliveryRepository;
    },
    private readonly planner: DeliveryPlanService
  ) { }

  list(value: unknown = {}) {
    const query = requireObject(value);
    const sourceId = optionalString(query.sourceId, 'sourceId', 200) ?? undefined;
    const state = optionalString(query.state, 'state', 32) || undefined;
    if (state && !(DELIVERY_JOB_STATES as readonly string[]).includes(state)) {
      throw validationError('작업 상태 필터가 올바르지 않습니다.');
    }
    const before = optionalInteger(query.before, 'before', 1, Number.MAX_SAFE_INTEGER) ?? undefined;
    return this.repositories.deliveryJobs.list({
      sourceId,
      state: state as DeliveryJobState | undefined,
      before,
      limit: 200
    }).map((job) => this.get(job.id));
  }

  get(id: number) {
    const repositories = this.repositories;
    const job = repositories.deliveryJobs.getById(id);
    if (!job) throw notFound('발송 작업을 찾을 수 없습니다.');
    const item = repositories.items.getById(job.itemId);
    const source = item ? repositories.sources.getById(item.sourceId) : null;
    const binding = repositories.deliveryBindings.getById(job.bindingId);
    return {
      id: job.id,
      itemId: job.itemId,
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? source?.feedUrl ?? '',
      title: item?.title ?? '',
      destination: binding?.label || '이전 연결 (계보 미확인)',
      revision: job.revision,
      operation: job.operation,
      state: job.state,
      error: job.error,
      attemptCount: job.attemptCount,
      nextAttemptAt: job.nextAttemptAt,
      canSendHeld: job.state === 'held' && binding?.endedAt === null,
      canConfirm: job.state === 'unknown' && binding !== null,
      canArchive: ARCHIVABLE_STATES.includes(job.state)
    };
  }

  review(id: number, value: unknown) {
    const body = requireObject(value);
    const decision = optionalString(body.decision, 'decision', 32);
    const repositories = this.repositories;
    const now = nowIso();
    this.db.transaction(() => {
      const job = repositories.deliveryJobs.getById(id);
      if (!job) throw notFound('발송 작업을 찾을 수 없습니다.');
      if (job.state === 'held' && (decision === 'send' || decision === 'historical')) {
        if (!repositories.deliveryJobs.reviewHeld(id, decision, now)) throw validationError('종료된 연결에는 발송할 수 없습니다.');
      } else if (decision === 'historical' && UNRESOLVED_STATES.includes(job.state)) {
        this.db.prepare("UPDATE delivery_jobs SET state = 'cancelled', error = 'Archived after administrator review', completed_at = ? WHERE id = ?").run(now, id);
      } else if (decision === 'confirm_delivered' && job.state === 'unknown') {
        // 결과가 불명확한 POST는 다시 전송하지 않고, 관리자가 확인한 원본 메시지 ID를 등록한다.
        const messageId = parseDiscordId(body.messageId, 'messageId');
        if (!messageId) throw validationError('확인한 Discord 메시지 ID가 필요합니다.');
        const threadId = parseDiscordId(body.threadId, 'threadId') ?? null;
        const channelId = parseDiscordId(body.channelId, 'channelId') ?? null;
        repositories.itemDeliveries.save({
          itemId: job.itemId,
          bindingId: job.bindingId,
          messageId,
          threadId,
          channelId,
          appliedRevision: job.revision,
          firstDeliveredAt: job.requestStartedAt ?? now
        });
        this.db.prepare("UPDATE delivery_jobs SET state = 'succeeded', error = 'Delivery confirmed by administrator', completed_at = ? WHERE id = ?").run(now, id);
        const item = repositories.items.getById(job.itemId);
        const source = item ? repositories.sources.getById(item.sourceId) : null;
        if (item && source) this.planner.planUpdate(item, source, now);
      } else throw validationError('현재 작업 상태에서는 선택한 처리를 할 수 없습니다.');
    })();
    return this.get(id);
  }
}
