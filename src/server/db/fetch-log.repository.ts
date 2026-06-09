import type Database from 'better-sqlite3';
import type { FetchOutcome } from '../contracts/api.js';
import { subtractDaysIso, nowIso } from './time.js';
import { nullable } from './sqlite.js';

export interface FetchLogRecord {
  id: number;
  sourceId: string;
  outcome: FetchOutcome;
  httpStatus: number | null;
  itemsNew: number;
  itemsHistorical: number;
  itemsChanged: number;
  itemsSkipped: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface AppendFetchLogInput {
  sourceId: string;
  outcome: FetchOutcome;
  httpStatus?: number | null;
  itemsNew?: number;
  itemsHistorical?: number;
  itemsChanged?: number;
  itemsSkipped?: number;
  durationMs?: number | null;
  error?: string | null;
  createdAt?: string;
}

export interface ListFetchLogsOptions {
  sourceId?: string;
  outcome?: FetchOutcome;
  limit?: number;
  before?: number;
}

interface FetchLogRow {
  id: number;
  source_id: string;
  outcome: FetchOutcome;
  http_status: number | null;
  items_new: number;
  items_historical: number;
  items_changed: number;
  items_skipped: number;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

const FETCH_LOG_COLUMNS = `
  id, source_id, outcome, http_status, items_new, items_historical,
  items_changed, items_skipped, duration_ms, error, created_at
`;

export class FetchLogRepository {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendFetchLogInput): FetchLogRecord {
    const createdAt = input.createdAt ?? nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO fetch_log (
           source_id, outcome, http_status, items_new, items_historical,
           items_changed, items_skipped, duration_ms, error, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sourceId,
        input.outcome,
        nullable(input.httpStatus),
        input.itemsNew ?? 0,
        input.itemsHistorical ?? 0,
        input.itemsChanged ?? 0,
        input.itemsSkipped ?? 0,
        nullable(input.durationMs),
        nullable(input.error),
        createdAt
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  getById(id: number): FetchLogRecord | null {
    const row = this.db.prepare(`SELECT ${FETCH_LOG_COLUMNS} FROM fetch_log WHERE id = ?`).get(id) as FetchLogRow | undefined;
    return row ? mapFetchLogRow(row) : null;
  }

  list(options: ListFetchLogsOptions = {}): FetchLogRecord[] {
    const limit = options.limit ?? 100;
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.sourceId !== undefined) {
      clauses.push('source_id = ?');
      values.push(options.sourceId);
    }
    if (options.outcome !== undefined) {
      clauses.push('outcome = ?');
      values.push(options.outcome);
    }
    if (options.before !== undefined) {
      clauses.push('id < ?');
      values.push(options.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    return (this.db
      .prepare(`SELECT ${FETCH_LOG_COLUMNS} FROM fetch_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values) as FetchLogRow[]).map(mapFetchLogRow);
  }

  listAfterId(afterId: number, limit = 100): FetchLogRecord[] {
    return (this.db
      .prepare(`SELECT ${FETCH_LOG_COLUMNS} FROM fetch_log WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as FetchLogRow[]).map(mapFetchLogRow);
  }

  listLatestOutcomeBySourceIds(sourceIds: readonly string[]): Map<string, FetchOutcome> {
    const output = new Map<string, FetchOutcome>();
    if (sourceIds.length === 0) return output;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT source_id, outcome
         FROM (
           SELECT source_id, outcome, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY id DESC) AS rank
           FROM fetch_log
           WHERE source_id IN (${placeholders})
         )
         WHERE rank = 1`
      )
      .all(...sourceIds) as Array<{ source_id: string; outcome: FetchOutcome }>;
    for (const row of rows) {
      output.set(row.source_id, row.outcome);
    }
    return output;
  }

  pruneOlderThan(days: number, baseIso = nowIso()): number {
    const cutoff = subtractDaysIso(baseIso, days);
    return this.db.prepare('DELETE FROM fetch_log WHERE created_at < ?').run(cutoff).changes;
  }

  private requireById(id: number): FetchLogRecord {
    const log = this.getById(id);
    if (!log) throw new Error(`Fetch log not found: ${id}`);
    return log;
  }
}

function mapFetchLogRow(row: FetchLogRow): FetchLogRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    outcome: row.outcome,
    httpStatus: row.http_status,
    itemsNew: row.items_new,
    itemsHistorical: row.items_historical,
    itemsChanged: row.items_changed,
    itemsSkipped: row.items_skipped,
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at
  };
}
