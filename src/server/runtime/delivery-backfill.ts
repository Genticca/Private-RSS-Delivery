import type Database from 'better-sqlite3';

/** Legacy membership has no creation timestamp, so its connection generation is not provable. */
export function backfillLegacyReceipts(db: Database.Database): void {
  const rows = db.prepare(`SELECT l.item_id, i.source_id, l.destination_key, l.discord_message_id, l.content_hash,
      i.content_hash AS current_hash, l.created_at
    FROM delivery_log l JOIN items i ON i.id = l.item_id
    WHERE l.status = 'success' AND l.destination_key IS NOT NULL AND l.discord_message_id IS NOT NULL
      AND l.id = (SELECT MAX(x.id) FROM delivery_log x WHERE x.item_id = l.item_id
        AND x.destination_key = l.destination_key AND x.status = 'success' AND x.discord_message_id IS NOT NULL)`)
    .all() as Array<{ item_id: number; source_id: string; destination_key: string; discord_message_id: string; content_hash: string; current_hash: string; created_at: string }>;
  const bindings = new Map<string, number>();
  const now = new Date().toISOString();
  for (const row of rows) {
    const key = row.source_id + ':' + row.destination_key;
    let bindingId = bindings.get(key);
    if (bindingId === undefined) {
      bindingId = Number(db.prepare(`INSERT INTO delivery_bindings(source_id, destination_key, bucket_key, created_at, ended_at, baseline_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(row.source_id, row.destination_key, row.destination_key, row.created_at, now, now).lastInsertRowid);
      bindings.set(key, bindingId);
    }
    db.prepare(`INSERT INTO item_deliveries(item_id, binding_id, message_id, applied_revision, first_delivered_at) VALUES (?, ?, ?, ?, ?)`)
      .run(row.item_id, bindingId, row.discord_message_id, row.content_hash === row.current_hash ? 1 : 0, row.created_at);
  }
}
