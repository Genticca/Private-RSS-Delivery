import type Database from 'better-sqlite3';
import { nowIso } from './time.js';
import { nullable, requireNonEmpty } from './sqlite.js';

export type ItemDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'historical';

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
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  author: string | null;
  commentsUrl: string | null;
  image: string | null;
  deliveryStatus: ItemDeliveryStatus;
  attemptCount: number;
  failedAt: string | null;
  failureReason: string | null;
  translatedTitle: string | null;
  translatedSummary: string | null;
  translatedAt: string | null;
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
  deliveredAt?: string | null;
  nextAttemptAt?: string | null;
  createdAt?: string;
  author?: string | null;
  commentsUrl?: string | null;
  image?: string | null;
  deliveryStatus?: ItemDeliveryStatus;
  attemptCount?: number;
  failedAt?: string | null;
  failureReason?: string | null;
  translatedTitle?: string | null;
  translatedSummary?: string | null;
  translatedAt?: string | null;
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
  content_hash: string | null;
  incident_stage: string | null;
  published_at: string | null;
  updated_at: string | null;
  delivered_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  author: string | null;
  comments_url: string | null;
  image: string | null;
  delivery_status: ItemDeliveryStatus;
  attempt_count: number;
  failed_at: string | null;
  failure_reason: string | null;
  translated_title: string | null;
  translated_summary: string | null;
  translated_at: string | null;
}

const ITEM_COLUMN_NAMES = [
  'id',
  'source_id',
  'atom_id',
  'title',
  'link',
  'summary',
  'content_hash',
  'incident_stage',
  'published_at',
  'updated_at',
  'delivered_at',
  'next_attempt_at',
  'created_at',
  'author',
  'comments_url',
  'image',
  'delivery_status',
  'attempt_count',
  'failed_at',
  'failure_reason',
  'translated_title',
  'translated_summary',
  'translated_at'
] as const;

const ITEM_COLUMNS = ITEM_COLUMN_NAMES.join(', ');
const QUALIFIED_ITEM_COLUMNS = ITEM_COLUMN_NAMES.map((column) => `items.${column}`).join(', ');

export class ItemRepository {
  constructor(private readonly db: Database.Database) {}

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

  findDueDeliveries(now: string, limit = 50): ItemRecord[] {
    return (this.db
      .prepare(
        `SELECT ${QUALIFIED_ITEM_COLUMNS}
         FROM items
         JOIN sources ON sources.id = items.source_id
         WHERE items.delivery_status = 'pending'
           AND items.next_attempt_at IS NOT NULL
           AND items.next_attempt_at <= ?
           AND sources.enabled = 1
         ORDER BY items.next_attempt_at, items.id
         LIMIT ?`
      )
      .all(now, limit) as ItemRow[]).map(mapItemRow);
  }

  insert(input: CreateItemInput): ItemRecord {
    const createdAt = input.createdAt ?? nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO items (
           source_id, atom_id, title, link, summary, content_hash, incident_stage,
           published_at, updated_at, delivered_at, next_attempt_at, created_at,
           author, comments_url, image, delivery_status, attempt_count, failed_at,
           failure_reason, translated_title, translated_summary, translated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        nullable(input.deliveredAt),
        nullable(input.nextAttemptAt),
        createdAt,
        nullable(input.author),
        nullable(input.commentsUrl),
        nullable(input.image),
        input.deliveryStatus ?? 'pending',
        input.attemptCount ?? 0,
        nullable(input.failedAt),
        nullable(input.failureReason),
        nullable(input.translatedTitle),
        nullable(input.translatedSummary),
        nullable(input.translatedAt)
      );
    return this.requireById(Number(result.lastInsertRowid));
  }

  updateContentHash(id: number, input: UpdateContentHashInput): ItemRecord {
    const result = this.db
      .prepare(
        `UPDATE items
         SET title = ?, link = ?, summary = ?, content_hash = ?, incident_stage = ?,
             published_at = ?, updated_at = ?, author = ?, comments_url = ?, image = ?,
             translated_title = NULL, translated_summary = NULL, translated_at = NULL
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
        id
      );
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  markDelivered(id: number, deliveredAt = nowIso()): ItemRecord {
    return this.updateDeliveryState(id, 'delivered', {
      deliveredAt,
      nextAttemptAt: null,
      failedAt: null,
      failureReason: null
    });
  }

  markHistorical(id: number): ItemRecord {
    return this.updateDeliveryState(id, 'historical', { nextAttemptAt: null });
  }

  markFailed(id: number, reason: string, failedAt = nowIso()): ItemRecord {
    return this.updateDeliveryState(id, 'failed', {
      failedAt,
      failureReason: requireNonEmpty(reason, 'items.failure_reason'),
      nextAttemptAt: null
    });
  }

  setNextAttempt(id: number, nextAttemptAt: string): ItemRecord {
    const result = this.db.prepare('UPDATE items SET next_attempt_at = ? WHERE id = ?').run(nextAttemptAt, id);
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  incrementAttempt(id: number): number {
    const result = this.db.prepare('UPDATE items SET attempt_count = attempt_count + 1 WHERE id = ?').run(id);
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id).attemptCount;
  }

  requeueForDelivery(id: number, nextAttemptAt = nowIso()): ItemRecord {
    const result = this.db
      .prepare(
        `UPDATE items
         SET delivery_status = 'pending', attempt_count = 0, next_attempt_at = ?,
             delivered_at = NULL, failed_at = NULL, failure_reason = NULL,
             translated_title = NULL, translated_summary = NULL, translated_at = NULL
         WHERE id = ?`
      )
      .run(nextAttemptAt, id);
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  requeueFailedBySource(sourceId: string, nextAttemptAt = nowIso()): number {
    return this.db
      .prepare(
        `UPDATE items
         SET delivery_status = 'pending', attempt_count = 0, next_attempt_at = ?,
             delivered_at = NULL, failed_at = NULL, failure_reason = NULL,
             translated_title = NULL, translated_summary = NULL, translated_at = NULL
         WHERE source_id = ? AND delivery_status = 'failed'`
      )
      .run(nextAttemptAt, sourceId).changes;
  }

  resetPendingAttemptsForSource(sourceId: string, nextAttemptAt = nowIso()): number {
    return this.db
      .prepare(
        `UPDATE items
         SET next_attempt_at = ?
         WHERE source_id = ? AND delivery_status = 'pending'`
      )
      .run(nextAttemptAt, sourceId).changes;
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

  saveTranslation(id: number, title: string | null, summary: string | null, translatedAt = nowIso()): ItemRecord {
    const result = this.db
      .prepare(
        `UPDATE items
         SET translated_title = ?, translated_summary = ?, translated_at = ?
         WHERE id = ?`
      )
      .run(nullable(title), nullable(summary), translatedAt, id);
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  private updateDeliveryState(
    id: number,
    deliveryStatus: ItemDeliveryStatus,
    patch: {
      deliveredAt?: string | null;
      nextAttemptAt?: string | null;
      failedAt?: string | null;
      failureReason?: string | null;
    }
  ): ItemRecord {
    const result = this.db
      .prepare(
        `UPDATE items
         SET delivery_status = ?,
             delivered_at = COALESCE(?, delivered_at),
             next_attempt_at = ?,
             failed_at = ?,
             failure_reason = ?
         WHERE id = ?`
      )
      .run(
        deliveryStatus,
        nullable(patch.deliveredAt),
        patch.nextAttemptAt ?? null,
        patch.failedAt ?? null,
        patch.failureReason ?? null,
        id
      );
    if (result.changes === 0) throw new Error(`Item not found: ${id}`);
    return this.requireById(id);
  }

  private requireById(id: number): ItemRecord {
    const item = this.getById(id);
    if (!item) throw new Error(`Item not found: ${id}`);
    return item;
  }
}

function mapItemRow(row: ItemRow): ItemRecord {
  if (row.content_hash === null || row.content_hash.trim() === '') {
    throw new Error(`items.content_hash must not be empty for item ${row.id}.`);
  }
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
    deliveredAt: row.delivered_at,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    author: row.author,
    commentsUrl: row.comments_url,
    image: row.image,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    translatedTitle: row.translated_title,
    translatedSummary: row.translated_summary,
    translatedAt: row.translated_at
  };
}
