import type Database from 'better-sqlite3';

export class SourceGroupRepository {
  constructor(private readonly db: Database.Database) {}

  listGroupIdsForSource(sourceId: string): number[] {
    return this.db
      .prepare('SELECT group_id FROM source_groups WHERE source_id = ? ORDER BY group_id')
      .all(sourceId)
      .map((row) => (row as { group_id: number }).group_id);
  }

  listGroupIdsBySourceIds(sourceIds: readonly string[]): Map<string, number[]> {
    const output = new Map<string, number[]>();
    if (sourceIds.length === 0) return output;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT source_id, group_id FROM source_groups WHERE source_id IN (${placeholders}) ORDER BY source_id, group_id`)
      .all(...sourceIds) as Array<{ source_id: string; group_id: number }>;
    for (const row of rows) {
      const current = output.get(row.source_id);
      if (current) current.push(row.group_id);
      else output.set(row.source_id, [row.group_id]);
    }
    return output;
  }

  listSourceIdsForGroup(groupId: number): string[] {
    return this.db
      .prepare('SELECT source_id FROM source_groups WHERE group_id = ? ORDER BY source_id')
      .all(groupId)
      .map((row) => (row as { source_id: string }).source_id);
  }

  setGroups(sourceId: string, groupIds: readonly number[]): void {
    const uniqueGroupIds = [...new Set(groupIds)];
    const deleteStmt = this.db.prepare('DELETE FROM source_groups WHERE source_id = ?');
    const insertStmt = this.db.prepare('INSERT INTO source_groups (source_id, group_id) VALUES (?, ?)');
    this.db.transaction(() => {
      deleteStmt.run(sourceId);
      for (const groupId of uniqueGroupIds) {
        insertStmt.run(sourceId, groupId);
      }
    })();
  }

  add(sourceId: string, groupId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO source_groups (source_id, group_id) VALUES (?, ?)').run(sourceId, groupId);
  }

  remove(sourceId: string, groupId: number): boolean {
    return this.db.prepare('DELETE FROM source_groups WHERE source_id = ? AND group_id = ?').run(sourceId, groupId).changes > 0;
  }
}
