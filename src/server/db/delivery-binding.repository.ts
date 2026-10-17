import type Database from 'better-sqlite3';
import { DeliveryJobRepository } from './delivery-job.repository.js';

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

const COLUMNS = `id, source_id AS sourceId, destination_key AS destinationKey, bucket_key AS bucketKey,
  label, created_at AS createdAt, ended_at AS endedAt,
  baseline_item_id AS baselineItemId, baseline_at AS baselineAt`;

export class DeliveryBindingRepository {
  constructor(private readonly db: Database.Database) { }

  getById(id: number): DeliveryBindingRecord | null {
    return this.db.prepare(`SELECT ${COLUMNS} FROM delivery_bindings WHERE id = ?`).get(id) as DeliveryBindingRecord ?? null;
  }

  listActive(sourceId: string): DeliveryBindingRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM delivery_bindings
      WHERE source_id = ? AND ended_at IS NULL ORDER BY id`).all(sourceId) as DeliveryBindingRecord[];
  }

  create(sourceId: string, destinationKey: string, bucketKey: string, now: string, label = ''): DeliveryBindingRecord {
    const result = this.db.prepare(`
      INSERT INTO delivery_bindings(source_id, destination_key, bucket_key, created_at, label)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceId, destinationKey, bucketKey, now, label);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  end(id: number, now: string): void {
    // 연결 이력은 삭제하지 않는다. 종료 시점과 대기 작업 취소를 기록해 이전 발송의 계보를 보존한다.
    this.db.prepare('UPDATE delivery_bindings SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now, id);
    this.db.prepare(`
      UPDATE delivery_jobs SET state = 'cancelled', error = 'Connection ended', completed_at = ?, claim_token = NULL
      WHERE binding_id = ? AND state IN ('pending','held','failed')
    `).run(now, id);
    const items = this.db.prepare('SELECT DISTINCT item_id FROM delivery_jobs WHERE binding_id = ?').all(id) as Array<{
      item_id: number
    }>;
    const jobs = new DeliveryJobRepository(this.db);
    for (const item of items) {
      jobs.syncItemState(item.item_id, now);
    }
  }

  completeBaseline(id: number, itemId: number, now: string): void {
    this.db.prepare(`UPDATE delivery_bindings SET baseline_item_id = ?, baseline_at = ?
      WHERE id = ? AND baseline_at IS NULL AND ended_at IS NULL`).run(itemId, now, id);
  }
}
