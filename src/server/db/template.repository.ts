import type Database from 'better-sqlite3';
import { nowIso } from '../core/db.js';
import { toSqliteBoolean } from '../core/db.js';
import { fromSqliteBoolean } from '../core/db.js';

export interface TemplateRecord {
  id: number;
  name: string;
  label: string;
  body: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateInput {
  name: string;
  label: string;
  body: string;
  isBuiltin?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateTemplateInput {
  label?: string;
  body?: string;
  updatedAt?: string;
}

interface TemplateRow {
  id: number;
  name: string;
  label: string;
  body: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_COLUMNS = 'id, name, label, body, is_builtin, created_at, updated_at';

/** Discord 프리셋 본문을 저장한다. 내장 프리셋은 이름을 기준으로 재등록한다. */
export class TemplateRepository {
  constructor(private readonly db: Database.Database) { }

  list(): TemplateRecord[] {
    return (this.db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY is_builtin DESC, name`).all() as TemplateRow[]).map(
      mapTemplateRow
    );
  }

  getById(id: number): TemplateRecord | null {
    const row = this.db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = ?`).get(id) as TemplateRow | undefined;
    return row ? mapTemplateRow(row) : null;
  }

  findByName(name: string): TemplateRecord | null {
    const row = this.db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE name = ?`).get(name) as TemplateRow | undefined;
    return row ? mapTemplateRow(row) : null;
  }

  create(input: CreateTemplateInput): TemplateRecord {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const result = this.db
      .prepare(
        `INSERT INTO templates (name, label, body, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.name, input.label, input.body, toSqliteBoolean(input.isBuiltin ?? false), createdAt, updatedAt);
    return this.requireById(Number(result.lastInsertRowid));
  }

  update(id: number, input: UpdateTemplateInput): TemplateRecord {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.label !== undefined) {
      assignments.push('label = ?');
      values.push(input.label);
    }
    if (input.body !== undefined) {
      assignments.push('body = ?');
      values.push(input.body);
    }
    assignments.push('updated_at = ?');
    values.push(input.updatedAt ?? nowIso(), id);
    const result = this.db.prepare(`UPDATE templates SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) throw new Error(`Template not found: ${id}`);
    return this.requireById(id);
  }

  upsertBuiltin(name: string, label: string, body: string, updatedAt = nowIso()): TemplateRecord {
    // 같은 이름의 ID를 유지해 소스가 참조 중인 내장 프리셋을 갱신한다.
    this.db
      .prepare(
        `INSERT INTO templates (name, label, body, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           label = excluded.label,
           body = excluded.body,
           is_builtin = 1,
           updated_at = excluded.updated_at`
      )
      .run(name, label, body, updatedAt, updatedAt);
    const template = this.findByName(name);
    if (!template) throw new Error(`Template upsert failed: ${name}`);
    return template;
  }

  delete(id: number): boolean {
    // 서비스의 검증과 별개로 저장소에서도 내장 프리셋 삭제를 막는다.
    return this.db.prepare('DELETE FROM templates WHERE id = ? AND is_builtin = 0').run(id).changes > 0;
  }

  private requireById(id: number): TemplateRecord {
    const template = this.getById(id);
    if (!template) throw new Error(`Template not found: ${id}`);
    return template;
  }
}

function mapTemplateRow(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    body: row.body,
    isBuiltin: fromSqliteBoolean(row.is_builtin),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
