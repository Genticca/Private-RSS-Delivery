import type Database from 'better-sqlite3';
import type { ModelProvider, ModelRole } from '../contracts/api.js';
import { nullable } from './sqlite.js';
import { subtractDaysIso, nowIso } from './time.js';

export interface ModelUsageRecord {
  id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface AppendModelUsageInput {
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  promptLog?: string | null;
  createdAt?: string;
}

export interface ListModelUsageOptions {
  role?: ModelRole;
  provider?: ModelProvider;
  limit?: number;
  before?: number;
}

interface ModelUsageRow {
  id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

const MODEL_USAGE_COLUMNS = `
  id, role, provider, model, input_tokens, output_tokens, latency_ms, error, created_at
`;

export class ModelUsageRepository {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendModelUsageInput): ModelUsageRecord {
    const createdAt = input.createdAt ?? nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO model_usage (
           role, provider, model, input_tokens, output_tokens, latency_ms, error, prompt_log, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.role,
        input.provider,
        input.model,
        nullable(input.inputTokens),
        nullable(input.outputTokens),
        nullable(input.latencyMs),
        nullable(input.error),
        nullable(input.promptLog),
        createdAt
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  getById(id: number): ModelUsageRecord | null {
    const row = this.db
      .prepare(`SELECT ${MODEL_USAGE_COLUMNS} FROM model_usage WHERE id = ?`)
      .get(id) as ModelUsageRow | undefined;
    return row ? mapModelUsageRow(row) : null;
  }

  list(options: ListModelUsageOptions = {}): ModelUsageRecord[] {
    const limit = options.limit ?? 100;
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.role !== undefined) {
      clauses.push('role = ?');
      values.push(options.role);
    }
    if (options.provider !== undefined) {
      clauses.push('provider = ?');
      values.push(options.provider);
    }
    if (options.before !== undefined) {
      clauses.push('id < ?');
      values.push(options.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    return (this.db
      .prepare(`SELECT ${MODEL_USAGE_COLUMNS} FROM model_usage ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values) as ModelUsageRow[]).map(mapModelUsageRow);
  }

  pruneOlderThan(days: number, baseIso = nowIso()): number {
    const cutoff = subtractDaysIso(baseIso, days);
    return this.db.prepare('DELETE FROM model_usage WHERE created_at < ?').run(cutoff).changes;
  }

  private requireById(id: number): ModelUsageRecord {
    const record = this.getById(id);
    if (!record) throw new Error(`Model usage row not found: ${id}`);
    return record;
  }
}

function mapModelUsageRow(row: ModelUsageRow): ModelUsageRecord {
  return {
    id: row.id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    error: row.error,
    createdAt: row.created_at
  };
}
