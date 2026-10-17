import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import type { DeliveryJobState, DeliveryOperation } from '../domain/delivery/policy.js';
import type { ItemRecord } from './item.repository.js';
import type { SourceRecord } from './source.repository.js';

export interface DeliveryJobRecord {
  id: number;
  itemId: number;
  bindingId: number | null;
  operation: DeliveryOperation;
  revision: number;
  state: DeliveryJobState;
  itemSnapshot: string;
  sourceSnapshot: string;
  templateBody: string;
  payload: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  claimToken: string | null;
  requestStartedAt: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

const COLUMNS = `j.id, j.item_id AS itemId, j.binding_id AS bindingId, j.operation, j.revision, j.state,
  j.item_snapshot AS itemSnapshot, j.source_snapshot AS sourceSnapshot, j.template_body AS templateBody,
  j.payload, j.attempt_count AS attemptCount, j.next_attempt_at AS nextAttemptAt,
  j.claim_token AS claimToken, j.request_started_at AS requestStartedAt, j.error,
  j.created_at AS createdAt, j.completed_at AS completedAt`;

export class DeliveryJobRepository {
  constructor(private readonly db: Database.Database) { }

  getById(id: number): DeliveryJobRecord | null {
    return this.db.prepare(`SELECT ${COLUMNS} FROM delivery_jobs j WHERE j.id = ?`).get(id) as DeliveryJobRecord ?? null;
  }

  list(options: {
    sourceId?: string;
    itemId?: number;
    state?: DeliveryJobState;
    before?: number;
    limit?: number
  } = {}): DeliveryJobRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM delivery_jobs j JOIN items i ON i.id = j.item_id
      WHERE (@sourceId IS NULL OR i.source_id = @sourceId) AND (@itemId IS NULL OR j.item_id = @itemId)
        AND (@state IS NULL OR j.state = @state) AND (@before IS NULL OR j.id < @before) ORDER BY j.id DESC LIMIT @limit`).all({
      sourceId: options.sourceId ?? null,
      itemId: options.itemId ?? null,
      state: options.state ?? null,
      before: options.before ?? null,
      limit: options.limit ?? 100
    }) as DeliveryJobRecord[];
  }

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
      `).run(now, item.id, bindingId, item.contentRevision);
    }
    this.db.prepare(`INSERT OR IGNORE INTO delivery_jobs(item_id, binding_id, operation, revision, state, item_snapshot, source_snapshot, template_body, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, bindingId, operation, item.contentRevision, held ? 'held' : 'pending',
      JSON.stringify(item), sourceSnapshot(source), templateBody, now, now
    );
    if (operation === 'initial_post') {
      this.db.prepare(`UPDATE delivery_jobs SET revision = ?, item_snapshot = ?, source_snapshot = ?, template_body = ?, payload = NULL
        WHERE item_id = ? AND binding_id = ? AND operation = 'initial_post' AND revision < ? AND state IN ('pending','held')`)
        .run(item.contentRevision, JSON.stringify(item), sourceSnapshot(source), templateBody, item.id, bindingId, item.contentRevision);
    }
  }

  findDue(now: string, limit = 50): DeliveryJobRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM delivery_jobs j
      JOIN items i ON i.id = j.item_id JOIN sources s ON s.id = i.source_id
      JOIN delivery_bindings b ON b.id = j.binding_id
      LEFT JOIN destination_cooldowns c ON c.bucket_key = b.bucket_key
      WHERE j.state = 'pending' AND j.next_attempt_at <= ? AND s.enabled = 1 AND b.ended_at IS NULL
        AND (c.until_at IS NULL OR c.until_at <= ?)
        AND NOT EXISTS(SELECT 1 FROM destination_cooldowns g WHERE g.bucket_key = '__discord_global__' AND g.until_at > ?)
      ORDER BY COALESCE(
        json_extract(j.item_snapshot, '$.publishedAt'), json_extract(j.item_snapshot, '$.updatedAt'), j.created_at
      ), j.item_id, j.revision, j.id LIMIT ?`).all(now, now, now, limit) as DeliveryJobRecord[];
  }

  claim(id: number): DeliveryJobRecord | null {
    // 획득 토큰으로 소유권을 확인해 다른 실행이 같은 작업의 결과를 덮어쓰지 못하게 한다.
    const token = randomUUID();
    const result = this.db.prepare(`UPDATE delivery_jobs SET state = 'running', claim_token = ? WHERE id = ? AND state = 'pending'
      AND NOT EXISTS(SELECT 1 FROM delivery_jobs other WHERE other.item_id = delivery_jobs.item_id
        AND other.binding_id = delivery_jobs.binding_id AND other.state = 'running')`).run(token, id);
    return result.changes ? this.getById(id) : null;
  }

  savePayload(job: DeliveryJobRecord, payload: DiscordWebhookPayload): boolean {
    return this.db.prepare("UPDATE delivery_jobs SET payload = ? WHERE id = ? AND claim_token = ? AND state = 'running'")
      .run(JSON.stringify(payload), job.id, job.claimToken).changes > 0;
  }

  markRequestStarted(job: DeliveryJobRecord, now: string): boolean {
    return this.db.prepare("UPDATE delivery_jobs SET request_started_at = ? WHERE id = ? AND claim_token = ? AND state = 'running'")
      .run(now, job.id, job.claimToken).changes > 0;
  }

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

  refreshInitial(job: DeliveryJobRecord, item: ItemRecord, source: SourceRecord): void {
    this.db.prepare(`UPDATE delivery_jobs SET state = 'pending', revision = ?, item_snapshot = ?, source_snapshot = ?, payload = NULL,
      claim_token = NULL, request_started_at = NULL WHERE id = ? AND claim_token = ? AND state = 'running' AND request_started_at IS NULL`)
      .run(item.contentRevision, JSON.stringify(item), sourceSnapshot(source), job.id, job.claimToken);
  }

  recoverInterrupted(now: string): number {
    // POST를 시작한 작업은 이미 발송됐을 수 있다. 자동 재전송 대신 확인 대기로 복구한다.
    return this.db.prepare(`UPDATE delivery_jobs SET state = CASE
        WHEN operation != 'edit' AND request_started_at IS NOT NULL THEN 'unknown' ELSE 'pending' END,
      error = 'Interrupted worker recovered', claim_token = NULL, next_attempt_at = ?, request_started_at = NULL
      WHERE state = 'running'`).run(now).changes;
  }

  cooldown(bucketKey: string, untilAt: string): void {
    this.db.prepare(`INSERT INTO destination_cooldowns(bucket_key, until_at) VALUES (?, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`).run(bucketKey, untilAt);
  }

  cooldownUntil(bucketKey: string): string | null {
    return (this.db.prepare('SELECT until_at FROM destination_cooldowns WHERE bucket_key = ?').get(bucketKey) as {
      until_at: string
    } | undefined)?.until_at ?? null;
  }

  retryFailed(sourceId: string, now: string): number {
    return this.db.transaction(() => {
      const items = this.db.prepare(`SELECT DISTINCT item_id FROM delivery_jobs WHERE state = 'failed'
        AND binding_id IN (SELECT id FROM delivery_bindings WHERE source_id = ? AND ended_at IS NULL)`).all(sourceId) as Array<{
        item_id: number
      }>;
      const count = this.db.prepare(`UPDATE delivery_jobs SET state = 'pending', attempt_count = 0, next_attempt_at = ?, error = NULL, completed_at = NULL
        WHERE state = 'failed' AND binding_id IN (SELECT id FROM delivery_bindings WHERE source_id = ? AND ended_at IS NULL)`).run(now, sourceId).changes;
      for (const item of items) this.syncItemState(item.item_id, now);
      return count;
    })();
  }

  syncItemState(itemId: number, now: string): void {
    const jobs = this.list({ itemId, limit: 100_000 });
    if (jobs.length === 0) return;
    const pendingJobs = jobs.filter((job) => job.state === 'pending' || job.state === 'running');
    const hasHeldJob = jobs.some((job) => job.state === 'held');
    const failedJob = jobs.find((job) => ['failed', 'unknown', 'legacy_unknown', 'uneditable'].includes(job.state));
    const hasSucceededJob = jobs.some((job) => job.state === 'succeeded');

    // 항목은 여러 목적지의 작업을 묶어 표시한다. 미완료 → 실패 → 성공 순으로 우선한다.
    let state: ItemRecord['deliveryStatus'] = 'historical';
    if (pendingJobs.length > 0 || hasHeldJob) state = 'pending';
    else if (failedJob) state = 'failed';
    else if (hasSucceededJob) state = 'delivered';

    const nextAttemptAt = pendingJobs.map((job) => job.nextAttemptAt).filter(Boolean).sort()[0] ?? null;
    const attemptCount = Math.max(0, ...jobs.map((job) => job.attemptCount));
    this.db.prepare(`UPDATE items SET delivery_status = ?, next_attempt_at = ?, failure_reason = ?,
      failed_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      attempt_count = ? WHERE id = ?`).run(
      state, nextAttemptAt, failedJob?.error ?? null, state === 'failed' ? now : null,
      state, now, attemptCount, itemId
    );
  }

  reviewHeld(id: number, decision: 'send' | 'historical', now: string): boolean {
    const job = this.getById(id);
    if (!job || job.state !== 'held') return false;
    const shouldSend = decision === 'send';
    const result = this.db.prepare(`UPDATE delivery_jobs SET state = ?, next_attempt_at = ?, completed_at = ?, error = ?
      WHERE id = ? AND state = 'held' AND binding_id IN (SELECT id FROM delivery_bindings WHERE ended_at IS NULL)`)
      .run(shouldSend ? 'pending' : 'cancelled', shouldSend ? now : null, shouldSend ? null : now,
        shouldSend ? null : 'Marked historical by administrator', id);
    this.syncItemState(job.itemId, now);
    return result.changes > 0;
  }
}

function sourceSnapshot(source: SourceRecord): string {
  return JSON.stringify({ ...source, webhookUrl: null, fetchOptions: {} });
}
