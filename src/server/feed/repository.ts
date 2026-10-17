import type Database from 'better-sqlite3';
import { nullable, requireNonEmpty, toSqliteBoolean, nowIso, fromSqliteBoolean } from '../core/db.js';

/** 수집한 항목의 내용과 버전이다. 발송 상태는 delivery_jobs·item_deliveries에만 있다. */
export interface ItemRecord {
  id: number;
  sourceId: string;
  atomId: string;
  title: string | null;
  link: string;
  summary: string | null;
  contentHash: string;
  incidentStage: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  author: string | null;
  commentsUrl: string | null;
  image: string | null;
  contentRevision: number;
  historical: boolean;
  contentPruned: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface CreateItemInput {
  sourceId: string;
  atomId: string;
  title?: string | null;
  link?: string | null;
  summary?: string | null;
  contentHash: string;
  incidentStage?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  author?: string | null;
  commentsUrl?: string | null;
  image?: string | null;
  historical?: boolean;
  createdAt?: string;
}

export interface UpdateContentHashInput {
  title?: string | null;
  link?: string | null;
  summary?: string | null;
  contentHash: string;
  incidentStage?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  author?: string | null;
  commentsUrl?: string | null;
  image?: string | null;
}

interface ItemRow {
  id: number;
  source_id: string;
  atom_id: string;
  title: string | null;
  link: string;
  summary: string | null;
  content_hash: string;
  incident_stage: string | null;
  published_at: string | null;
  updated_at: string | null;
  author: string | null;
  comments_url: string | null;
  image: string | null;
  content_revision: number;
  historical: number;
  content_pruned: number;
  last_seen_at: string | null;
  created_at: string;
}

const ITEM_COLUMNS = `
  id, source_id, atom_id, title, link, summary, content_hash, incident_stage,
  published_at, updated_at, author, comments_url, image,
  content_revision, historical, content_pruned, last_seen_at, created_at
`;

export class ItemRepository {
  pruneContent(before: string): void {
    this.db.prepare(`UPDATE items SET summary = NULL, image = NULL, content_pruned = 1
          WHERE content_pruned = 0 AND last_seen_at < ?
          AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.item_id = items.id
            AND j.state IN ('pending','running','held','unknown','failed','uneditable'))`)
          .run(before);
  }

  constructor(private readonly db: Database.Database) { }

  getById(id: number): ItemRecord | null {
    const row = this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return row ? mapItemRow(row) : null;
  }

  findByAtomId(sourceId: string, atomId: string): ItemRecord | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE source_id = ? AND atom_id = ?`)
      .get(sourceId, atomId) as ItemRow | undefined;
    return row ? mapItemRow(row) : null;
  }

  insert(input: CreateItemInput): ItemRecord {
    const result = this.db
      .prepare(
        `INSERT INTO items (
           source_id, atom_id, title, link, summary, content_hash, incident_stage,
           published_at, updated_at, author, comments_url, image, historical, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sourceId,
        input.atomId,
        nullable(input.title),
        input.link ?? '',
        nullable(input.summary),
        requireNonEmpty(input.contentHash, 'items.content_hash'),
        nullable(input.incidentStage),
        nullable(input.publishedAt),
        nullable(input.updatedAt),
        nullable(input.author),
        nullable(input.commentsUrl),
        nullable(input.image),
        toSqliteBoolean(input.historical ?? false),
        input.createdAt ?? nowIso()
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  updateContentHash(id: number, input: UpdateContentHashInput): ItemRecord {
    // 내용 해시가 달라진 경우만 revision을 올린다. 본문 복원은 발송할 새 버전이 아니다.
    const result = this.db
      .prepare(
        `UPDATE items
         SET title = ?, link = ?, summary = ?, content_hash = ?, incident_stage = ?,
             published_at = ?, updated_at = ?, author = ?, comments_url = ?, image = ?,
             content_revision = content_revision + CASE WHEN content_hash != ? THEN 1 ELSE 0 END,
             content_pruned = 0
         WHERE id = ?`
      )
      .run(
        nullable(input.title),
        input.link ?? '',
        nullable(input.summary),
        requireNonEmpty(input.contentHash, 'items.content_hash'),
        nullable(input.incidentStage),
        nullable(input.publishedAt),
        nullable(input.updatedAt),
        nullable(input.author),
        nullable(input.commentsUrl),
        nullable(input.image),
        input.contentHash,
        id
      );
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  deleteBySourceId(sourceId: string): number {
    return this.db.prepare('DELETE FROM items WHERE source_id = ?').run(sourceId).changes;
  }

  latestForSource(sourceId: string): ItemRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM items
         WHERE source_id = ?
         ORDER BY COALESCE(published_at, updated_at, created_at) DESC, id DESC
         LIMIT 1`
      )
      .get(sourceId) as ItemRow | undefined;
    return row ? mapItemRow(row) : null;
  }

  private requireById(id: number): ItemRecord {
    const item = this.getById(id);
    if (!item) throw new Error(`Item not found: ${id}`);
    return item;
  }
}

function mapItemRow(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    atomId: row.atom_id,
    title: row.title,
    link: row.link,
    summary: row.summary,
    contentHash: row.content_hash,
    incidentStage: row.incident_stage,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    author: row.author,
    commentsUrl: row.comments_url,
    image: row.image,
    contentRevision: row.content_revision,
    historical: fromSqliteBoolean(row.historical),
    contentPruned: fromSqliteBoolean(row.content_pruned),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at
  };
}
