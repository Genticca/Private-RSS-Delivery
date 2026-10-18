/**
 * 발송 저장소. 연결 세대·작업 소유권·원본 메시지 영수증·목적지 대기 시간을 관리한다.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ItemRecord } from '../feed/repository.js';
import type { SourceRecord } from '../sources/repository.js';
import type { DiscordWebhookPayload } from '../templates/render.js';

export interface DeliveryBindingRecord {
  id: number;
  sourceId: string;
  destinationKey: string;
  bucketKey: string;
  label: string;
  createdAt: string;
  endedAt: string | null;
  baselineItemId: number | null;
  baselineAt: string | null;
}

const BINDING_COLUMNS = `id, source_id AS sourceId, destination_key AS destinationKey, bucket_key AS bucketKey,
  label, created_at AS createdAt, ended_at AS endedAt,
  baseline_item_id AS baselineItemId, baseline_at AS baselineAt`;

/** 동일 목적지여도 종료된 연결과 새 연결을 별도 세대로 보존한다. 초기 수집 기준은 연결별로 갖는다. */
export class DeliveryBindingRepository {
  constructor(private readonly db: Database.Database) { }

  getById(id: number): DeliveryBindingRecord | null {
    return this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM delivery_bindings WHERE id = ?`).get(id) as DeliveryBindingRecord ?? null;
  }

  listActive(sourceId: string): DeliveryBindingRecord[] {
    return this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM delivery_bindings
      WHERE source_id = ? AND ended_at IS NULL ORDER BY id`).all(sourceId) as DeliveryBindingRecord[];
  }

  create(sourceId: string, destinationKey: string, bucketKey: string, now: string, label = ''): DeliveryBindingRecord {
    const result = this.db.prepare(`
      INSERT INTO delivery_bindings(source_id, destination_key, bucket_key, created_at, label)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sourceId,
      destinationKey,
      bucketKey,
      now,
      label
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** 연결을 종료하고 미발송 작업을 취소한다. 기존 영수증은 새 연결로 승계하지 않는다. */
  end(id: number, now: string): void {
    // 연결 이력은 삭제하지 않는다. 종료 시점과 대기 작업 취소를 기록해 이전 발송의 계보를 보존한다.
    this.db.prepare('UPDATE delivery_bindings SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now, id);
    this.db.prepare(`
      UPDATE delivery_jobs SET state = 'cancelled', error = 'Connection ended', completed_at = ?, claim_token = NULL
      WHERE binding_id = ? AND state IN ('pending','held','failed')
    `).run(
      now,
      id
    );
  }

  /** 아직 기준이 없는 연결에만 첫 수집의 최대 항목 ID와 완료 시각을 고정한다. */
  completeBaseline(id: number, itemId: number, now: string): void {
    this.db.prepare(`UPDATE delivery_bindings SET baseline_item_id = ?, baseline_at = ?
      WHERE id = ? AND baseline_at IS NULL AND ended_at IS NULL`).run(
      itemId,
      now,
      id
    );
  }
}

export interface DeliveryJobRecord {
  id: number;
  itemId: number;
  bindingId: number;
  operation: DeliveryOperation;
  revision: number;
  state: DeliveryJobState;
  /** 계획 시점의 항목 내용이다. 현재 items 행이 바뀌어도 준비할 메시지의 기준을 유지한다. */
  itemSnapshot: string;
  sourceSnapshot: string;
  templateBody: string;
  /** 최초 준비 후 고정한 전송 JSON이다. 재시도에서 번역·렌더 결과를 새로 만들지 않는다. */
  payload: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  /** 이 작업을 획득한 실행의 토큰이다. 저장 시 일치 여부로 오래된 실행의 결과를 차단한다. */
  claimToken: string | null;
  /** 외부 HTTP를 시작한 시각이다. 중단된 POST를 안전하게 다시 보낼 수 있는지 판별한다. */
  requestStartedAt: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

const JOB_COLUMNS = `j.id, j.item_id AS itemId, j.binding_id AS bindingId, j.operation, j.revision, j.state,
  j.item_snapshot AS itemSnapshot, j.source_snapshot AS sourceSnapshot, j.template_body AS templateBody,
  j.payload, j.attempt_count AS attemptCount, j.next_attempt_at AS nextAttemptAt,
  j.claim_token AS claimToken, j.request_started_at AS requestStartedAt, j.error,
  j.created_at AS createdAt, j.completed_at AS completedAt`;

/** 발송 계획·작업 획득 토큰·HTTP 시작 시각을 저장해 중복 실행과 불명확한 재발송을 구분한다. */
export class DeliveryJobRepository {
  pruneCooldowns(now: string): void {
    this.db.prepare('DELETE FROM destination_cooldowns WHERE until_at < ?').run(now);
  }

  pruneCompletedSnapshots(before: string): void {
    this.db.prepare(`UPDATE delivery_jobs SET item_snapshot = '{}', source_snapshot = '{}', payload = NULL, template_body = ''
          WHERE state IN ('succeeded','cancelled') AND completed_at < ?`).run(before);
  }

  constructor(private readonly db: Database.Database) { }

  getById(id: number): DeliveryJobRecord | null {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM delivery_jobs j WHERE j.id = ?`).get(id) as DeliveryJobRecord ?? null;
  }

  list(options: {
    sourceId?: string;
    itemId?: number;
    state?: DeliveryJobState;
    before?: number;
    limit?: number
  } = {}): DeliveryJobRecord[] {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM delivery_jobs j JOIN items i ON i.id = j.item_id
      WHERE (@sourceId IS NULL OR i.source_id = @sourceId) AND (@itemId IS NULL OR j.item_id = @itemId)
        AND (@state IS NULL OR j.state = @state) AND (@before IS NULL OR j.id < @before) ORDER BY j.id DESC LIMIT @limit`).all({
      sourceId: options.sourceId ?? null,
      itemId: options.itemId ?? null,
      state: options.state ?? null,
      before: options.before ?? null,
      limit: options.limit ?? 100
    }) as DeliveryJobRecord[];
  }

  /** 계획 시점의 항목·소스·템플릿을 고정한다. 미발송 최초 작업은 갱신하고 이전 수정 작업은 취소한다. */
  plan(
    item: ItemRecord,
    source: SourceRecord,
    bindingId: number,
    operation: DeliveryOperation,
    templateBody: string,
    now: string,
    held = false
  ): void {
    if (operation !== 'initial_post') {
      // 수정 작업은 가장 최신 버전만 남기되, 아직 보내지 않은 최초 발송 작업은 아래에서 갱신한다.
      this.db.prepare(`
        UPDATE delivery_jobs SET state = 'cancelled', error = 'Superseded revision', completed_at = ?
        WHERE item_id = ? AND binding_id = ? AND revision < ? AND operation != 'initial_post' AND state = 'pending'
      `).run(
        now,
        item.id,
        bindingId,
        item.contentRevision
      );
    }
    this.db.prepare(`INSERT OR IGNORE INTO delivery_jobs(item_id, binding_id, operation, revision, state, item_snapshot, source_snapshot, template_body, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, bindingId, operation, item.contentRevision, held ? 'held' : 'pending',
      JSON.stringify(item), sourceSnapshot(source), templateBody, now, now
    );
    if (operation === 'initial_post') {
      this.db.prepare(`UPDATE delivery_jobs SET revision = ?, item_snapshot = ?, source_snapshot = ?, template_body = ?, payload = NULL
        WHERE item_id = ? AND binding_id = ? AND operation = 'initial_post' AND revision < ? AND state IN ('pending','held')`)
        .run(
          item.contentRevision,
          JSON.stringify(item),
          sourceSnapshot(source),
          templateBody,
          item.id,
          bindingId,
          item.contentRevision
        );
    }
  }

  /** 목적지·전역 대기와 연결 상태를 반영한 작업을 항목 시각·버전 순서로 가져온다. */
  findDue(now: string, limit = 50): DeliveryJobRecord[] {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM delivery_jobs j
      JOIN items i ON i.id = j.item_id JOIN sources s ON s.id = i.source_id
      JOIN delivery_bindings b ON b.id = j.binding_id
      LEFT JOIN destination_cooldowns c ON c.bucket_key = b.bucket_key
      WHERE j.state = 'pending' AND j.next_attempt_at <= ? AND s.enabled = 1 AND b.ended_at IS NULL
        AND (c.until_at IS NULL OR c.until_at <= ?)
        AND NOT EXISTS(SELECT 1 FROM destination_cooldowns g WHERE g.bucket_key = '__discord_global__' AND g.until_at > ?)
      ORDER BY COALESCE(
        json_extract(j.item_snapshot, '$.publishedAt'), json_extract(j.item_snapshot, '$.updatedAt'), j.created_at
      ), j.item_id, j.revision, j.id LIMIT ?`).all(
      now,
      now,
      now,
      limit
    ) as DeliveryJobRecord[];
  }

  /** pending 한 건을 원자적으로 획득한다. 같은 항목·연결의 다른 실행이 진행 중이면 획득하지 않는다. */
  claim(id: number): DeliveryJobRecord | null {
    // 획득 토큰으로 소유권을 확인해 다른 실행이 같은 작업의 결과를 덮어쓰지 못하게 한다.
    const token = randomUUID();
    const result = this.db.prepare(`UPDATE delivery_jobs SET state = 'running', claim_token = ? WHERE id = ? AND state = 'pending'
      AND NOT EXISTS(SELECT 1 FROM delivery_jobs other WHERE other.item_id = delivery_jobs.item_id
        AND other.binding_id = delivery_jobs.binding_id AND other.state = 'running')`).run(
      token,
      id
    );
    return result.changes ? this.getById(id) : null;
  }

  /** 현재 획득 토큰의 작업만 payload를 고정해 HTTP 재시도에서도 같은 메시지를 사용하게 한다. */
  savePayload(job: DeliveryJobRecord, payload: DiscordWebhookPayload): boolean {
    return this.db.prepare("UPDATE delivery_jobs SET payload = ? WHERE id = ? AND claim_token = ? AND state = 'running'")
      .run(
        JSON.stringify(payload),
        job.id,
        job.claimToken
      ).changes > 0;
  }

  /** 외부 요청 전에 시작 시각을 저장한다. 중단 후 POST 결과 불명을 판단하는 근거다. */
  markRequestStarted(job: DeliveryJobRecord, now: string): boolean {
    return this.db.prepare("UPDATE delivery_jobs SET request_started_at = ? WHERE id = ? AND claim_token = ? AND state = 'running'")
      .run(
        now,
        job.id,
        job.claimToken
      ).changes > 0;
  }

  /** 획득 토큰과 running 상태가 일치할 때만 결과를 저장한다. 소유권을 잃은 실행은 갱신하지 못한다. */
  finish(
    job: DeliveryJobRecord,
    state: DeliveryJobState,
    now: string,
    error: string | null = null,
    nextAttemptAt: string | null = null,
    attemptCount = job.attemptCount
  ): boolean {
    return this.db.prepare(`UPDATE delivery_jobs SET state = ?, error = ?, next_attempt_at = ?, attempt_count = ?,
      completed_at = ?, claim_token = NULL, request_started_at = CASE WHEN ? = 'pending' THEN NULL ELSE request_started_at END
      WHERE id = ? AND claim_token = ? AND state = 'running'`).run(
      state, error, nextAttemptAt, attemptCount, state === 'pending' ? null : now,
      state, job.id, job.claimToken
    ).changes > 0;
  }

  /** HTTP를 시작하지 않은 최초 작업만 최신 항목 스냅샷으로 되돌려 다시 준비한다. */
  refreshInitial(job: DeliveryJobRecord, item: ItemRecord, source: SourceRecord): void {
    this.db.prepare(`UPDATE delivery_jobs SET state = 'pending', revision = ?, item_snapshot = ?, source_snapshot = ?, payload = NULL,
      claim_token = NULL, request_started_at = NULL WHERE id = ? AND claim_token = ? AND state = 'running' AND request_started_at IS NULL`)
      .run(
        item.contentRevision,
        JSON.stringify(item),
        sourceSnapshot(source),
        job.id,
        job.claimToken
      );
  }

  /** 미전송·PATCH 작업은 다시 대기시키고 이미 시작한 POST는 관리자 확인이 필요한 unknown으로 복구한다. */
  recoverInterrupted(now: string): number {
    // POST를 시작한 작업은 이미 발송됐을 수 있다. 자동 재전송 대신 확인 대기로 복구한다.
    return this.db.prepare(`UPDATE delivery_jobs SET state = CASE
        WHEN operation != 'edit' AND request_started_at IS NOT NULL THEN 'unknown' ELSE 'pending' END,
      error = 'Interrupted worker recovered', claim_token = NULL, next_attempt_at = ?, request_started_at = NULL
      WHERE state = 'running'`).run(now).changes;
  }

  /** 공유 목적지의 대기 시간을 짧게 덮어쓰지 않도록 기존 값과 새 값 중 늦은 시각을 유지한다. */
  cooldown(bucketKey: string, untilAt: string): void {
    this.db.prepare(`INSERT INTO destination_cooldowns(bucket_key, until_at) VALUES (?, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`).run(
      bucketKey,
      untilAt
    );
  }

  cooldownUntil(bucketKey: string): string | null {
    return (this.db.prepare('SELECT until_at FROM destination_cooldowns WHERE bucket_key = ?').get(bucketKey) as {
      until_at: string
    } | undefined)?.until_at ?? null;
  }

  /** 활성 연결의 failed 작업만 대기열로 되돌린다. 결과 불명·수정 불가 작업의 강제 재전송은 아니다. */
  retryFailed(sourceId: string, now: string): number {
    return this.db.prepare(`UPDATE delivery_jobs SET state = 'pending', attempt_count = 0, next_attempt_at = ?, error = NULL, completed_at = NULL
      WHERE state = 'failed' AND binding_id IN (SELECT id FROM delivery_bindings WHERE source_id = ? AND ended_at IS NULL)`).run(
      now,
      sourceId
    ).changes;
  }

  /** 아직 활성 연결에 속한 held 작업에만 발송 또는 과거 처리 결정을 반영한다. */
  reviewHeld(id: number, decision: 'send' | 'historical', now: string): boolean {
    const shouldSend = decision === 'send';
    return this.db.prepare(`UPDATE delivery_jobs SET state = ?, next_attempt_at = ?, completed_at = ?, error = ?
      WHERE id = ? AND state = 'held' AND binding_id IN (SELECT id FROM delivery_bindings WHERE ended_at IS NULL)`)
      .run(shouldSend ? 'pending' : 'cancelled', shouldSend ? now : null, shouldSend ? null : now,
        shouldSend ? null : 'Marked historical by administrator', id).changes > 0;
  }
}

/** 발송에 필요한 소스 설정을 고정하되 수집용 헤더·요청 옵션은 작업 스냅샷에 보관하지 않는다. */
function sourceSnapshot(source: SourceRecord): string {
  return JSON.stringify({ ...source, fetchOptions: {} });
}

export interface ItemDeliveryRecord {
  itemId: number;
  bindingId: number;
  messageId: string | null;
  channelId: string | null;
  threadId: string | null;
  /** 원본 Discord 메시지에 반영된 내용 버전이다. 늦게 온 이전 버전 응답은 이를 낮추지 못한다. */
  appliedRevision: number;
  firstDeliveredAt: string;
}

const ITEM_DELIVERY_COLUMNS = `item_id AS itemId, binding_id AS bindingId, message_id AS messageId,
  channel_id AS channelId, thread_id AS threadId, applied_revision AS appliedRevision,
  first_delivered_at AS firstDeliveredAt`;

/** 항목과 연결 세대별 원본 Discord 메시지 정보를 보관해 이후 수정 대상을 찾는다. */
export class ItemDeliveryRepository {
  constructor(private readonly db: Database.Database) { }

  get(itemId: number, bindingId: number): ItemDeliveryRecord | null {
    return this.db.prepare(`SELECT ${ITEM_DELIVERY_COLUMNS} FROM item_deliveries WHERE item_id = ? AND binding_id = ?`).get(
      itemId,
      bindingId
    ) as ItemDeliveryRecord ?? null;
  }

  listForItem(itemId: number): ItemDeliveryRecord[] {
    return this.db.prepare(`SELECT ${ITEM_DELIVERY_COLUMNS} FROM item_deliveries WHERE item_id = ?`).all(itemId) as ItemDeliveryRecord[];
  }

  save(record: ItemDeliveryRecord): void {
    // 늦게 도착한 이전 버전의 응답이 최신 버전을 덮어쓰지 않게 한다.
    // 응답에서 빠진 채널·스레드 ID와 최초 발송 시각은 기존 값을 유지한다.
    this.db.prepare(`INSERT INTO item_deliveries(item_id, binding_id, message_id, channel_id, thread_id, applied_revision, first_delivered_at)
      VALUES (@itemId, @bindingId, @messageId, @channelId, @threadId, @appliedRevision, @firstDeliveredAt)
      ON CONFLICT(item_id, binding_id) DO UPDATE SET message_id = excluded.message_id,
        channel_id = COALESCE(excluded.channel_id, item_deliveries.channel_id),
        thread_id = COALESCE(excluded.thread_id, item_deliveries.thread_id), applied_revision = excluded.applied_revision
      WHERE excluded.applied_revision >= item_deliveries.applied_revision`).run(record);
  }
}

export type DeliveryOperation = 'initial_post' | 'edit' | 'update_post';

export type DeliveryJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held' | 'unknown' | 'uneditable';
