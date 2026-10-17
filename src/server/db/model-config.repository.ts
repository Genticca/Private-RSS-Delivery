import type Database from 'better-sqlite3';
import type { ModelProvider, ModelRole } from '../contracts/api.js';
import { fromSqliteBoolean, toSqliteBoolean } from './sqlite.js';
import { nowIso } from './time.js';

export interface ModelConfigRecord {
  id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  enabled: boolean;
  targetLang: string;
  promptLogMaxBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateModelConfigInput {
  provider?: ModelProvider;
  model?: string;
  enabled?: boolean;
  targetLang?: string;
  promptLogMaxBytes?: number;
  updatedAt?: string;
}

interface ModelConfigRow {
  id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  enabled: number;
  target_lang: string;
  prompt_log_max_bytes: number;
  created_at: string;
  updated_at: string;
}

const MODEL_CONFIG_COLUMNS = `
  id, role, provider, model, enabled, target_lang, prompt_log_max_bytes, created_at, updated_at
`;

/** 번역 모델(Gemini) 설정을 저장한다. 행은 primary 하나다. API 키는 DB에 저장하지 않는다. */
export class ModelConfigRepository {
  constructor(private readonly db: Database.Database) { }

  list(): ModelConfigRecord[] {
    return (this.db.prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_config ORDER BY role`).all() as ModelConfigRow[]).map(
      mapModelConfigRow
    );
  }

  getByRole(role: ModelRole): ModelConfigRecord | null {
    const row = this.db
      .prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_config WHERE role = ?`)
      .get(role) as ModelConfigRow | undefined;
    return row ? mapModelConfigRow(row) : null;
  }

  updateRole(role: ModelRole, input: UpdateModelConfigInput): ModelConfigRecord {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (input.provider !== undefined) add('provider', input.provider);
    if (input.model !== undefined) add('model', input.model);
    if (input.enabled !== undefined) add('enabled', toSqliteBoolean(input.enabled));
    if (input.targetLang !== undefined) add('target_lang', input.targetLang);
    if (input.promptLogMaxBytes !== undefined) add('prompt_log_max_bytes', input.promptLogMaxBytes);
    add('updated_at', input.updatedAt ?? nowIso());

    values.push(role);
    const result = this.db.prepare(`UPDATE model_config SET ${assignments.join(', ')} WHERE role = ?`).run(...values);
    if (result.changes === 0) throw new Error(`Model config not found: ${role}`);
    return this.requireByRole(role);
  }

  private requireByRole(role: ModelRole): ModelConfigRecord {
    const record = this.getByRole(role);
    if (!record) throw new Error(`Model config not found: ${role}`);
    return record;
  }
}

function mapModelConfigRow(row: ModelConfigRow): ModelConfigRecord {
  return {
    id: row.id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    enabled: fromSqliteBoolean(row.enabled),
    targetLang: row.target_lang,
    promptLogMaxBytes: row.prompt_log_max_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
