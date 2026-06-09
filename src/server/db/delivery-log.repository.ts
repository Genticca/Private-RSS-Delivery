import type Database from 'better-sqlite3';
import type { DeliveryStatus } from '../contracts/api.js';
import { subtractDaysIso, nowIso } from './time.js';
import { nullable } from './sqlite.js';

export type DeliveryFailureReason =
  | 'render'
  | 'validate'
  | 'no_destination'
  | 'webhook_rejected'
  | 'guard_blocked'
  | 'network'
  | 'rate_limited'
  | 'max_retries'
  | 'unknown';

export interface DeliveryLogRecord {
  id: number;
  itemId: number;
  attemptNo: number;
  status: DeliveryStatus;
  httpStatus: number | null;
  error: string | null;
  renderedBytes: number | null;
  createdAt: string;
  destinationKey: string | null;
  contentHash: string | null;
  failureReason: string | null;
  discordMessageId: string | null;
}

export interface AppendDeliveryLogInput {
  itemId: number;
  attemptNo: number;
  status: DeliveryStatus;
  httpStatus?: number | null;
  error?: string | null;
  renderedBytes?: number | null;
  createdAt?: string;
  destinationKey?: string | null;
  contentHash?: string | null;
  failureReason?: string | null;
  discordMessageId?: string | null;
}

export interface ListDeliveryLogsOptions {
  itemId?: number;
  limit?: number;
  before?: number;
}

interface DeliveryLogRow {
  id: number;
  item_id: number;
  attempt_no: number;
  status: DeliveryStatus;
  http_status: number | null;
  error: string | null;
  rendered_bytes: number | null;
  created_at: string;
  destination_key: string | null;
  content_hash: string | null;
  failure_reason: string | null;
  discord_message_id: string | null;
}

const DELIVERY_LOG_COLUMNS = `
  id, item_id, attempt_no, status, http_status, error, rendered_bytes, created_at,
  destination_key, content_hash, failure_reason, discord_message_id
`;
const TERMINAL_FAILURE_REASONS = new Set(['webhook_rejected', 'guard_blocked']);

export class DeliveryLogRepository {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendDeliveryLogInput): DeliveryLogRecord {
    const createdAt = input.createdAt ?? nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO delivery_log (
           item_id, attempt_no, status, http_status, error, rendered_bytes, created_at,
           destination_key, content_hash, failure_reason, discord_message_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.itemId,
        input.attemptNo,
        input.status,
        nullable(input.httpStatus),
        nullable(input.error),
        nullable(input.renderedBytes),
        createdAt,
        nullable(input.destinationKey),
        nullable(input.contentHash),
        nullable(input.failureReason),
        nullable(input.discordMessageId)
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  getById(id: number): DeliveryLogRecord | null {
    const row = this.db
      .prepare(`SELECT ${DELIVERY_LOG_COLUMNS} FROM delivery_log WHERE id = ?`)
      .get(id) as DeliveryLogRow | undefined;
    return row ? mapDeliveryLogRow(row) : null;
  }

  list(options: ListDeliveryLogsOptions = {}): DeliveryLogRecord[] {
    const limit = options.limit ?? 100;
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.itemId !== undefined) {
      clauses.push('item_id = ?');
      values.push(options.itemId);
    }
    if (options.before !== undefined) {
      clauses.push('id < ?');
      values.push(options.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    return (this.db
      .prepare(`SELECT ${DELIVERY_LOG_COLUMNS} FROM delivery_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values) as DeliveryLogRow[]).map(mapDeliveryLogRow);
  }

  listAfterId(afterId: number, limit = 100): DeliveryLogRecord[] {
    return (this.db
      .prepare(`SELECT ${DELIVERY_LOG_COLUMNS} FROM delivery_log WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as DeliveryLogRow[]).map(mapDeliveryLogRow);
  }

  findResolved(itemId: number, destinationKey: string, contentHash: string): DeliveryLogRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${DELIVERY_LOG_COLUMNS}
         FROM delivery_log
         WHERE item_id = ?
           AND destination_key = ?
           AND content_hash = ?
           AND (
             status = 'success'
             OR (status = 'failed' AND failure_reason IN ('webhook_rejected', 'guard_blocked'))
           )
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(itemId, destinationKey, contentHash) as DeliveryLogRow | undefined;
    return row ? mapDeliveryLogRow(row) : null;
  }

  findLatestMessageId(itemId: number, destinationKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT discord_message_id
         FROM delivery_log
         WHERE item_id = ?
           AND destination_key = ?
           AND discord_message_id IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(itemId, destinationKey) as { discord_message_id: string } | undefined;
    return row?.discord_message_id ?? null;
  }

  isTerminalFailure(reason: string | null): boolean {
    return reason !== null && TERMINAL_FAILURE_REASONS.has(reason);
  }

  pruneOlderThan(days: number, baseIso = nowIso()): number {
    const cutoff = subtractDaysIso(baseIso, days);
    return this.db.prepare('DELETE FROM delivery_log WHERE created_at < ?').run(cutoff).changes;
  }

  private requireById(id: number): DeliveryLogRecord {
    const log = this.getById(id);
    if (!log) throw new Error(`Delivery log not found: ${id}`);
    return log;
  }
}

function mapDeliveryLogRow(row: DeliveryLogRow): DeliveryLogRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    attemptNo: row.attempt_no,
    status: row.status,
    httpStatus: row.http_status,
    error: row.error,
    renderedBytes: row.rendered_bytes,
    createdAt: row.created_at,
    destinationKey: row.destination_key,
    contentHash: row.content_hash,
    failureReason: row.failure_reason,
    discordMessageId: row.discord_message_id
  };
}
