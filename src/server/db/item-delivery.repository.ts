import type Database from 'better-sqlite3';

export interface ItemDeliveryRecord {
  itemId: number;
  bindingId: number;
  messageId: string | null;
  channelId: string | null;
  threadId: string | null;
  appliedRevision: number;
  firstDeliveredAt: string;
}

const COLUMNS = 'item_id AS itemId, binding_id AS bindingId, message_id AS messageId, channel_id AS channelId, thread_id AS threadId, applied_revision AS appliedRevision, first_delivered_at AS firstDeliveredAt';

export class ItemDeliveryRepository {
  constructor(private readonly db: Database.Database) {}

  get(itemId: number, bindingId: number): ItemDeliveryRecord | null {
    return this.db.prepare(`SELECT ${COLUMNS} FROM item_deliveries WHERE item_id = ? AND binding_id = ?`).get(itemId, bindingId) as ItemDeliveryRecord ?? null;
  }

  listForItem(itemId: number): ItemDeliveryRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM item_deliveries WHERE item_id = ?`).all(itemId) as ItemDeliveryRecord[];
  }

  save(record: ItemDeliveryRecord): void {
    this.db.prepare(`INSERT INTO item_deliveries(item_id, binding_id, message_id, channel_id, thread_id, applied_revision, first_delivered_at)
      VALUES (@itemId, @bindingId, @messageId, @channelId, @threadId, @appliedRevision, @firstDeliveredAt)
      ON CONFLICT(item_id, binding_id) DO UPDATE SET message_id = excluded.message_id,
        channel_id = COALESCE(excluded.channel_id, item_deliveries.channel_id),
        thread_id = COALESCE(excluded.thread_id, item_deliveries.thread_id), applied_revision = excluded.applied_revision
      WHERE excluded.applied_revision >= item_deliveries.applied_revision`).run(record);
  }
}
