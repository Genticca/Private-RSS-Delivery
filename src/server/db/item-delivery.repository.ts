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

const COLUMNS = `item_id AS itemId, binding_id AS bindingId, message_id AS messageId,
  channel_id AS channelId, thread_id AS threadId, applied_revision AS appliedRevision,
  first_delivered_at AS firstDeliveredAt`;

/** 항목과 연결 세대별 원본 Discord 메시지 정보를 보관해 이후 수정 대상을 찾는다. */
export class ItemDeliveryRepository {
  constructor(private readonly db: Database.Database) { }

  get(itemId: number, bindingId: number): ItemDeliveryRecord | null {
    return this.db.prepare(`SELECT ${COLUMNS} FROM item_deliveries WHERE item_id = ? AND binding_id = ?`).get(itemId, bindingId) as ItemDeliveryRecord ?? null;
  }

  listForItem(itemId: number): ItemDeliveryRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM item_deliveries WHERE item_id = ?`).all(itemId) as ItemDeliveryRecord[];
  }

  save(record: ItemDeliveryRecord): void {
    // 늦게 도착한 이전 버전의 응답이 최신 버전을 덮어쓰지 않게 한다.
    // 응답에서 빠진 채널·스레드 ID와 최초 발송 시각은 기존 값을 유지한다.
    this.db.prepare(`INSERT INTO item_deliveries(item_id, binding_id, message_id, channel_id, thread_id, applied_revision, first_delivered_at)
      VALUES (@itemId, @bindingId, @messageId, @channelId, @threadId, @appliedRevision, @firstDeliveredAt)
      ON CONFLICT(item_id, binding_id) DO UPDATE SET message_id = excluded.message_id,
        channel_id = COALESCE(excluded.channel_id, item_deliveries.channel_id),
        thread_id = COALESCE(excluded.thread_id, item_deliveries.thread_id), applied_revision = excluded.applied_revision
      WHERE excluded.applied_revision >= item_deliveries.applied_revision`).run(record);
  }
}
