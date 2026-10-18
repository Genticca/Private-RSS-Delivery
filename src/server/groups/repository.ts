/**
 * 발신 그룹 저장소. 웹훅 원문은 이 내부 레코드에만 보관하고 공개 DTO에서는 제외한다.
 */
import type Database from 'better-sqlite3';
import { nowIso, nullable } from '../core/db.js';

export interface GroupRecord {
  id: number;
  name: string;
  webhookUrl: string | null;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupInput {
  name: string;
  webhookUrl?: string | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateGroupInput {
  name?: string;
  webhookUrl?: string | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  updatedAt?: string;
}

interface GroupRow {
  id: number;
  name: string;
  webhook_url: string | null;
  webhook_name: string | null;
  webhook_avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

const GROUP_COLUMNS = 'id, name, webhook_url, webhook_name, webhook_avatar_url, created_at, updated_at';

/** 발송 그룹과 웹훅 설정의 저장소다. 이름 검색은 대소문자를 구분하지 않는다. */
export class GroupRepository {
  constructor(private readonly db: Database.Database) { }

  list(): GroupRecord[] {
    return (this.db.prepare(`SELECT ${GROUP_COLUMNS} FROM "groups" ORDER BY name COLLATE NOCASE`).all() as GroupRow[]).map(
      mapGroupRow
    );
  }

  getById(id: number): GroupRecord | null {
    const row = this.db.prepare(`SELECT ${GROUP_COLUMNS} FROM "groups" WHERE id = ?`).get(id) as GroupRow | undefined;
    return row ? mapGroupRow(row) : null;
  }

  listNamesByIds(ids: readonly number[]): Map<number, string> {
    const output = new Map<number, string>();
    if (ids.length === 0) return output;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id, name FROM "groups" WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{
        id: number;
        name: string
      }>;
    for (const row of rows) {
      output.set(row.id, row.name);
    }
    return output;
  }

  findByNameNocase(name: string): GroupRecord | null {
    const row = this.db
      .prepare(`SELECT ${GROUP_COLUMNS} FROM "groups" WHERE name = ? COLLATE NOCASE`)
      .get(name) as GroupRow | undefined;
    return row ? mapGroupRow(row) : null;
  }

  create(input: CreateGroupInput): GroupRecord {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const result = this.db
      .prepare(
        `INSERT INTO "groups" (name, webhook_url, webhook_name, webhook_avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        nullable(input.webhookUrl),
        nullable(input.webhookName),
        nullable(input.webhookAvatarUrl),
        createdAt,
        updatedAt
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  update(id: number, input: UpdateGroupInput): GroupRecord {
    // 누락된 필드는 유지한다. null을 받은 웹훅 필드만 명시적으로 비운다.
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (input.name !== undefined) add('name', input.name);
    if (input.webhookUrl !== undefined) add('webhook_url', input.webhookUrl);
    if (input.webhookName !== undefined) add('webhook_name', input.webhookName);
    if (input.webhookAvatarUrl !== undefined) add('webhook_avatar_url', input.webhookAvatarUrl);
    add('updated_at', input.updatedAt ?? nowIso());

    values.push(id);
    const result = this.db.prepare(`UPDATE "groups" SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) throw new Error(`Group not found: ${id}`);
    return this.requireById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM "groups" WHERE id = ?').run(id).changes > 0;
  }

  private requireById(id: number): GroupRecord {
    const group = this.getById(id);
    if (!group) throw new Error(`Group not found: ${id}`);
    return group;
  }
}

function mapGroupRow(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhook_url,
    webhookName: row.webhook_name,
    webhookAvatarUrl: row.webhook_avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
