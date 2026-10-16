import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/server/runtime/migrator.js';

describe('legacy delivery data migration', () => {
  it('quarantines ambiguous work, preserves historical/completed rows and archives provable message IDs without activating old recipients', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rss-legacy-test-'));
    const migrations = fileURLToPath(new URL('../../../src/resources/migrations', import.meta.url));
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    try {
      for (const file of readdirSync(migrations).filter((file) => file.endsWith('.sql') && file < '0021')) copyFileSync(join(migrations, file), join(directory, file));
      runMigrations(db, { migrationsDir: directory });
      db.prepare("INSERT INTO sources(id, feed_url, created_at) VALUES ('legacy','https://example.com/feed','2026-01-01T00:00:00.000Z')").run();
      for (const status of ['historical', 'delivered', 'pending', 'failed']) db.prepare('INSERT INTO items(source_id, atom_id, content_hash, delivery_status) VALUES (?, ?, ?, ?)').run('legacy', status, 'hash', status);
      const item = db.prepare("SELECT id FROM items WHERE atom_id = 'delivered'").get() as { id: number };
      db.prepare("INSERT INTO delivery_log(item_id, attempt_no, status, destination_key, content_hash, discord_message_id, created_at) VALUES (?, 1, 'success','legacy-key','hash','123','2026-01-01T00:00:00.000Z')").run(item.id);
      expect(runMigrations(db)).toEqual(['0021_delivery_jobs', '0022_translation_cache', '0023_source_fetch_revision']);
      expect(runMigrations(db)).toEqual([]);
      expect(db.prepare('SELECT state FROM delivery_jobs').all()).toEqual([{ state: 'legacy_unknown' }, { state: 'legacy_unknown' }]);
      expect(db.prepare('SELECT atom_id, delivery_status FROM items ORDER BY id').all()).toEqual([
        { atom_id: 'historical', delivery_status: 'historical' }, { atom_id: 'delivered', delivery_status: 'delivered' },
        { atom_id: 'pending', delivery_status: 'failed' }, { atom_id: 'failed', delivery_status: 'failed' }
      ]);
      expect(db.prepare('SELECT message_id FROM item_deliveries').all()).toEqual([{ message_id: '123' }]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_bindings WHERE ended_at IS NULL').get()).toEqual({ count: 0 });
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
