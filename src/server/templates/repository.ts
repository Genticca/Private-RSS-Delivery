/**
 * 템플릿 저장소와 내장 프리셋 시드. 파일 프리셋을 읽는 경로는 빌드 결과에서도 유지되어야 한다.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { nowIso, toSqliteBoolean, fromSqliteBoolean } from '../core/db.js';

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
      .run(
        input.name,
        input.label,
        input.body,
        toSqliteBoolean(input.isBuiltin ?? false),
        createdAt,
        updatedAt
      );
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

  /** 내장 프리셋을 이름으로 찾아 시드해 부팅을 반복해도 중복 행이 생기지 않게 한다. */
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
      .run(
        name,
        label,
        body,
        updatedAt,
        updatedAt
      );
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

export interface BuiltinPresetDefinition {
  name: string;
  label: string;
}

export interface SeedBuiltinPresetOptions {
  presetsDir?: string;
  updatedAt?: string;
}

export const BUILTIN_PRESETS: readonly BuiltinPresetDefinition[] = [
  // incident-active 단일 프리셋이 stageColor 로 진행중(빨강)·해결(초록)을 모두 칠하므로
  // 과거의 incident-resolved 는 통합 제거됨(0013_merge_incident_presets).
  { name: 'incident-active', label: '장애' },
  { name: 'news-article', label: '뉴스 기사' },
  { name: 'link-discussion', label: '링크·토론' },
  { name: 'minimal', label: '심플' }
] as const;

const DEFAULT_PRESETS_DIR = fileURLToPath(new URL('../../resources/presets/', import.meta.url));

/** 패키지와 함께 배포된 프리셋 파일을 읽어 DB의 내장 템플릿으로 반영한다. */
export function seedBuiltinPresets(templates: TemplateRepository, options: SeedBuiltinPresetOptions = {}): TemplateRecord[] {
  const presetsDir = options.presetsDir ?? DEFAULT_PRESETS_DIR;
  return BUILTIN_PRESETS.map((preset) =>
    templates.upsertBuiltin(preset.name, preset.label, readPresetBody(presetsDir, preset.name), options.updatedAt)
  );
}

/** 파일 끝의 불필요한 공백만 제거하고 프리셋 본문 자체의 의미는 보존한다. */
function readPresetBody(presetsDir: string, name: string): string {
  return readFileSync(join(presetsDir, `${name}.hbs`), 'utf8').trimEnd();
}
