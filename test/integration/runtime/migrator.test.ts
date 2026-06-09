import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../../src/server/runtime/container.js';
import { runMigrations } from '../../../src/server/runtime/migrator.js';

const tempDirs: string[] = [];
const PROJECT_MIGRATIONS = [
  '0001_init',
  '0002_templates',
  '0003_delivery_log',
  '0004_fetch_log',
  '0005_model',
  '0006_groups',
  '0007_sources_poll_state',
  '0008_delivery_state',
  '0009_reseed_model',
  '0010_iso_timestamp_backfill',
  '0011_webhook_features',
  '0012_mention_here',
  '0013_merge_incident_presets',
  '0014_generic_content_hash_title_link',
  '0015_source_destinations',
  '0016_sources_feed_url_unique',
  '0017_source_destinations_canonical_unique',
  '0018_runtime_timestamp_iso_z_backfill',
  '0019_drop_source_destinations',
  '0020_scrub_source_webhook_url'
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runMigrations', () => {
  it('applies project migrations once and leaves the schema reusable', () => {
    const db = new Database(':memory:');
    try {
      const firstRun = runMigrations(db);
      const secondRun = runMigrations(db);

      expect(firstRun).toEqual(PROJECT_MIGRATIONS);
      expect(secondRun).toEqual([]);
      expect(readMigrationVersions(db)).toEqual(firstRun);

      expect(tableNames(db)).toEqual(
        expect.arrayContaining([
          'delivery_log',
          'fetch_log',
          'groups',
          'items',
          'model_config',
          'model_usage',
          'source_groups',
          'sources',
          'templates'
        ])
      );
      expect(columnNames(db, 'sources')).toEqual(
        expect.arrayContaining([
          'template_id',
          'webhook_url',
          'webhook_name',
          'webhook_avatar_url',
          'poll_interval_seconds',
          'fetch_options',
          'translate',
          'last_polled_at',
          'next_poll_at',
          'silent',
          'mention_role_ids',
          'mention_user_ids',
          'mention_everyone',
          'mention_here',
          'thread_id',
          'thread_name',
          'applied_tags',
          'edit_in_place'
        ])
      );
      expect(columnNames(db, 'items')).toEqual(
        expect.arrayContaining([
          'atom_id',
          'link',
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
        ])
      );
      expect(columnNames(db, 'delivery_log')).toEqual(
        expect.arrayContaining(['destination_key', 'content_hash', 'failure_reason', 'discord_message_id'])
      );
      expect(tableNames(db)).not.toContain('source_destinations');
      expect(columnInfo(db, 'groups', 'webhook_url')?.notnull).toBe(0);
      expect(foreignKeyTargets(db, 'source_groups')).toEqual(expect.arrayContaining(['sources', 'groups']));
      expect(indexNames(db, 'sources')).toEqual(expect.arrayContaining(['idx_sources_enabled_next_poll', 'idx_sources_feed_url_unique']));
      expect(indexNames(db, 'items')).toEqual(expect.arrayContaining(['idx_items_pending_next_attempt']));
      expect(indexNames(db, 'delivery_log')).toEqual(expect.arrayContaining(['idx_delivery_log_resolution', 'idx_delivery_log_message']));
      expect(indexNames(db, 'sources')).not.toContain('idx_sources_enabled_poll');
      expect(readModelConfigTimestamps(db).every((row) => row.created_at.includes('T') && row.created_at.endsWith('Z') && row.updated_at.includes('T') && row.updated_at.endsWith('Z'))).toBe(true);
      expect(readMigrationTimestamps(db).every((row) => row.applied_at.includes('T') && row.applied_at.endsWith('Z'))).toBe(true);
      expect(readModelConfigDefaults(db)).toEqual([
        {
          role: 'fallback',
          provider: 'nvidia-nim',
          model: 'qwen3-coder-480b-a35b-instruct',
          enabled: 0,
          target_lang: 'ko',
          prompt_log_max_bytes: 32768
        },
        {
          role: 'primary',
          provider: 'gemini',
          model: 'gemini-3.1-flash-lite',
          enabled: 1,
          target_lang: 'ko',
          prompt_log_max_bytes: 32768
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('uses filename sort order for custom migration directories', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0002_second.sql'), 'CREATE TABLE second (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '0001_first.sql'), 'CREATE TABLE first (id INTEGER PRIMARY KEY);');

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual(['0001_first', '0002_second']);
      expect(runMigrations(db, { migrationsDir: dir })).toEqual([]);
      expect(readMigrationVersions(db)).toEqual(['0001_first', '0002_second']);
    } finally {
      db.close();
    }
  });

  it('backfills legacy item delivery state without making old rows pending', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_items.sql'), `
      CREATE TABLE sources (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES sources(id),
        atom_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        content_hash TEXT,
        incident_stage TEXT,
        published_at TEXT,
        updated_at TEXT,
        delivered_at TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-05-29T00:00:00.000Z'
      );
      CREATE TABLE delivery_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id),
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        error TEXT,
        rendered_bytes INTEGER,
        created_at TEXT NOT NULL DEFAULT '2026-05-29T00:00:00.000Z'
      );
      INSERT INTO sources (id) VALUES ('s1');
      INSERT INTO items (source_id, atom_id, content_hash, delivered_at) VALUES ('s1', 'delivered', 'h1', '2026-05-29T00:00:00.000Z');
      INSERT INTO items (source_id, atom_id, content_hash) VALUES ('s1', 'baseline', 'h2');
    `);
    writeFileSync(join(dir, '0008_delivery_state.sql'), readProjectMigration('0008_delivery_state.sql')); 

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual(['0001_items', '0008_delivery_state']);
      expect(
        db.prepare('SELECT atom_id, delivery_status FROM items ORDER BY atom_id').all()
      ).toEqual([
        { atom_id: 'baseline', delivery_status: 'historical' },
        { atom_id: 'delivered', delivery_status: 'delivered' }
      ]);
    } finally {
      db.close();
    }
  });

  it('repoints sources off the removed incident-resolved preset and drops it', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_setup.sql'), `
      CREATE TABLE templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_builtin INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL
      );
      INSERT INTO templates (name) VALUES ('incident-active'), ('incident-resolved'), ('minimal');
      INSERT INTO sources (template_id) VALUES
        ((SELECT id FROM templates WHERE name = 'incident-resolved')),
        ((SELECT id FROM templates WHERE name = 'incident-active'));
    `);
    writeFileSync(join(dir, '0013_merge_incident_presets.sql'), readProjectMigration('0013_merge_incident_presets.sql'));

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual(['0001_setup', '0013_merge_incident_presets']);
      // incident-resolved 빌트인 행은 제거된다.
      expect(db.prepare("SELECT id FROM templates WHERE name = 'incident-resolved'").get()).toBeUndefined();
      // 그 프리셋을 쓰던 소스는 SET NULL 로 떨어지지 않고 incident-active 로 repoint 된다.
      const activeId = (db.prepare("SELECT id FROM templates WHERE name = 'incident-active'").get() as { id: number }).id;
      expect(db.prepare('SELECT template_id FROM sources ORDER BY id').all()).toEqual([
        { template_id: activeId },
        { template_id: activeId }
      ]);
      // 이미 적용된 마이그레이션은 재실행되지 않는다(idempotent).
      expect(runMigrations(db, { migrationsDir: dir })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('backfills only generic item content hashes without changing delivery state', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_setup.sql'), `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL DEFAULT 'auto',
        detected_profile TEXT
      );
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES sources(id),
        atom_id TEXT NOT NULL,
        title TEXT,
        link TEXT NOT NULL DEFAULT '',
        summary TEXT,
        content_hash TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        next_attempt_at TEXT
      );
      INSERT INTO sources (id, profile, detected_profile) VALUES
        ('generic-manual', 'generic', 'incident-io'),
        ('generic-auto', 'auto', NULL),
        ('incident-auto', 'auto', 'incident-io');
      INSERT INTO items (source_id, atom_id, title, link, summary, content_hash, delivery_status, next_attempt_at) VALUES
        ('generic-manual', 'manual', 'Title', 'https://example.com/manual', 'Old body', 'old-manual', 'delivered', NULL),
        ('generic-auto', 'auto', 'Auto Title', 'https://example.com/auto', 'Old body', 'old-auto', 'pending', '2026-06-04T00:00:00.000Z'),
        ('incident-auto', 'incident', 'Incident', 'https://example.com/incident', 'Incident body', 'old-incident', 'delivered', NULL);
    `);
    writeFileSync(join(dir, '0014_generic_content_hash_title_link.sql'), readProjectMigration('0014_generic_content_hash_title_link.sql'));

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual(['0001_setup', '0014_generic_content_hash_title_link']);
      expect(runMigrations(db, { migrationsDir: dir })).toEqual([]);

      expect(db.prepare('SELECT atom_id, content_hash, delivery_status, next_attempt_at FROM items ORDER BY atom_id').all()).toEqual([
        {
          atom_id: 'auto',
          content_hash: 'b7bb771beb2a45ff9fdb821b783ba5c0fcf3f563d979f261a8da2199830740fe',
          delivery_status: 'pending',
          next_attempt_at: '2026-06-04T00:00:00.000Z'
        },
        {
          atom_id: 'incident',
          content_hash: 'old-incident',
          delivery_status: 'delivered',
          next_attempt_at: null
        },
        {
          atom_id: 'manual',
          content_hash: '2317fe2fa0590e86e753d64b8a27da152fdf6720381430c7a3f475e06a323534',
          delivery_status: 'delivered',
          next_attempt_at: null
        }
      ]);
    } finally {
      db.close();
    }
  });


  it('deduplicates feed URLs before adding a unique source index', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_sources.sql'), `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        feed_url TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO sources (id, feed_url, created_at) VALUES
        ('old', 'https://example.com/feed.xml', '2026-06-05T00:00:00.000Z'),
        ('new', 'https://example.com/feed.xml', '2026-06-05T00:00:01.000Z'),
        ('tie-a', 'https://example.com/tie.xml', '2026-06-05T00:00:02.000Z'),
        ('tie-z', 'https://example.com/tie.xml', '2026-06-05T00:00:02.000Z'),
        ('other', 'https://example.com/other.xml', '2026-06-05T00:00:00.000Z');
    `);
    writeFileSync(join(dir, '0016_sources_feed_url_unique.sql'), readProjectMigration('0016_sources_feed_url_unique.sql'));

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual(['0001_sources', '0016_sources_feed_url_unique']);
      expect(db.prepare('SELECT id, feed_url FROM sources ORDER BY id').all()).toEqual([
        { id: 'new', feed_url: 'https://example.com/feed.xml' },
        { id: 'other', feed_url: 'https://example.com/other.xml' },
        { id: 'tie-a', feed_url: 'https://example.com/tie.xml' }
      ]);
      expect(uniqueIndexNames(db, 'sources')).toContain('idx_sources_feed_url_unique');
      expect(() =>
        db.prepare("INSERT INTO sources (id, feed_url, created_at) VALUES ('dup', 'https://example.com/feed.xml', '2026-06-05T00:00:02.000Z')").run()
      ).toThrow(/UNIQUE/);

      const snapshot = db.prepare('SELECT id, feed_url FROM sources ORDER BY id').all();
      db.exec(readProjectMigration('0016_sources_feed_url_unique.sql'));
      expect(db.prepare('SELECT id, feed_url FROM sources ORDER BY id').all()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('deduplicates canonical source destinations before adding a thread-safe expression index', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_source_destinations.sql'), `
      CREATE TABLE source_destinations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        webhook_url TEXT NOT NULL,
        thread_id TEXT
      );
      INSERT INTO source_destinations (source_id, position, webhook_url, thread_id) VALUES
        ('s1', 2, 'https://discord.com/api/webhooks/123/token', NULL),
        ('s1', 1, 'https://DISCORD.com/api/webhooks/123/TOKEN/', NULL),
        ('s1', 3, 'https://discord.com/api/webhooks/123/token', '999'),
        ('s2', 0, 'https://discord.com/api/webhooks/123/token', NULL);
    `);
    writeFileSync(join(dir, '0017_source_destinations_canonical_unique.sql'), readProjectMigration('0017_source_destinations_canonical_unique.sql'));

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual([
        '0001_source_destinations',
        '0017_source_destinations_canonical_unique'
      ]);
      expect(columnNames(db, 'source_destinations')).not.toContain('destination_key');
      expect(uniqueIndexNames(db, 'source_destinations')).toContain('idx_source_destinations_unique_canonical_thread');
      expect(db.prepare('SELECT source_id, webhook_url, thread_id FROM source_destinations ORDER BY source_id, thread_id IS NOT NULL, thread_id, id').all()).toEqual([
        { source_id: 's1', webhook_url: 'https://DISCORD.com/api/webhooks/123/TOKEN/', thread_id: null },
        { source_id: 's1', webhook_url: 'https://discord.com/api/webhooks/123/token', thread_id: '999' },
        { source_id: 's2', webhook_url: 'https://discord.com/api/webhooks/123/token', thread_id: null }
      ]);
      expect(() =>
        db.prepare("INSERT INTO source_destinations (source_id, webhook_url, thread_id) VALUES ('s1', 'https://discord.com/api/webhooks/123/token/', NULL)").run()
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.prepare("INSERT INTO source_destinations (source_id, webhook_url, thread_id) VALUES ('s1', 'https://discord.com/api/webhooks/123/token/', '123')").run()
      ).not.toThrow();

      const snapshot = db.prepare('SELECT source_id, webhook_url, thread_id FROM source_destinations ORDER BY id').all();
      db.exec(readProjectMigration('0017_source_destinations_canonical_unique.sql'));
      expect(db.prepare('SELECT source_id, webhook_url, thread_id FROM source_destinations ORDER BY id').all()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('drops source_destinations table and indexes idempotently', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE source_destinations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          webhook_url TEXT NOT NULL,
          thread_id TEXT
        );
        CREATE INDEX idx_source_destinations_source_position ON source_destinations(source_id, position);
        CREATE UNIQUE INDEX idx_source_destinations_unique_raw ON source_destinations(source_id, webhook_url, thread_id);
        CREATE UNIQUE INDEX idx_source_destinations_unique_canonical_thread ON source_destinations(source_id, lower(webhook_url), COALESCE(thread_id, ''));
      `);

      db.exec(readProjectMigration('0019_drop_source_destinations.sql'));
      expect(tableNames(db)).not.toContain('source_destinations');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_source_destinations_%'").all()).toEqual([]);

      db.exec(readProjectMigration('0019_drop_source_destinations.sql'));
      expect(tableNames(db)).not.toContain('source_destinations');
    } finally {
      db.close();
    }
  });

  it('scrubs legacy per-source webhook URLs idempotently', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE sources (
          id TEXT PRIMARY KEY,
          webhook_url TEXT
        );
        CREATE TABLE groups (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          webhook_url TEXT
        );
        INSERT INTO sources (id, webhook_url) VALUES
          ('with-secret', 'https://discord.com/api/webhooks/123/source-token'),
          ('already-null', NULL);
        INSERT INTO groups (id, name, webhook_url) VALUES
          (1, 'Channel', 'https://discord.com/api/webhooks/222/group-token');
      `);

      db.exec(readProjectMigration('0020_scrub_source_webhook_url.sql'));
      expect(db.prepare('SELECT id, webhook_url FROM sources ORDER BY id').all()).toEqual([
        { id: 'already-null', webhook_url: null },
        { id: 'with-secret', webhook_url: null }
      ]);
      expect(db.prepare('SELECT webhook_url FROM groups WHERE id = 1').get()).toEqual({ webhook_url: 'https://discord.com/api/webhooks/222/group-token' });

      db.exec(readProjectMigration('0020_scrub_source_webhook_url.sql'));
      expect(db.prepare('SELECT COUNT(*) AS count FROM sources WHERE webhook_url IS NOT NULL').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('backfills runtime timestamps to ISO-Z without changing existing ISO-Z values or nulls', () => {
    const dir = makeTempDir();
    const migrationsBeforeRuntimeBackfill = PROJECT_MIGRATIONS.slice(0, PROJECT_MIGRATIONS.indexOf('0018_runtime_timestamp_iso_z_backfill'));
    for (const version of migrationsBeforeRuntimeBackfill) {
      writeFileSync(join(dir, `${version}.sql`), readProjectMigration(`${version}.sql`));
    }
    writeFileSync(join(dir, '0017_zz_seed_runtime_timestamps.sql'), `
      INSERT INTO "groups" (name, created_at, updated_at) VALUES ('Legacy Timestamps', '2026-06-05 01:02:03', '2026-06-05 01:02:04');
      INSERT INTO sources (
        id, feed_url, created_at, delivery_cutoff_at, last_polled_at, next_poll_at
      ) VALUES (
        'legacy-ts', 'https://example.com/legacy-ts.xml', '2026-06-05 01:02:03', '2026-06-05 01:02:04', '2026-06-05 01:02:05', '2026-06-05 01:02:06'
      );
      INSERT INTO items (
        source_id, atom_id, content_hash, published_at, updated_at, delivered_at, next_attempt_at, failed_at, translated_at, created_at
      ) VALUES (
        'legacy-ts', 'atom-ts', 'hash-ts', '2026-06-05 01:02:07', '2026-06-05T01:02:08.000Z', '2026-06-05 01:02:09', NULL, '2026-06-05 01:02:10', NULL, '2026-06-05 01:02:11'
      );
      INSERT INTO delivery_log (item_id, attempt_no, status, created_at) VALUES (1, 1, 'success', '2026-06-05 01:02:12');
      INSERT INTO fetch_log (source_id, outcome, created_at) VALUES ('legacy-ts', '200', '2026-06-05 01:02:13');
      INSERT INTO templates (name, label, body, is_builtin, created_at, updated_at)
      VALUES ('timestamp-template', 'Timestamp Template', '{}', 0, '2026-06-05 01:02:14', '2026-06-05T01:02:15.000Z');
    `);
    writeFileSync(join(dir, '0018_runtime_timestamp_iso_z_backfill.sql'), readProjectMigration('0018_runtime_timestamp_iso_z_backfill.sql'));

    const db = new Database(':memory:');
    try {
      expect(runMigrations(db, { migrationsDir: dir })).toEqual([
        ...migrationsBeforeRuntimeBackfill,
        '0017_zz_seed_runtime_timestamps',
        '0018_runtime_timestamp_iso_z_backfill'
      ]);
      const snapshot = readRuntimeTimestampSnapshot(db);
      expect(snapshot.source).toEqual({
        created_at: '2026-06-05T01:02:03.000Z',
        delivery_cutoff_at: '2026-06-05T01:02:04.000Z',
        last_polled_at: '2026-06-05T01:02:05.000Z',
        next_poll_at: '2026-06-05T01:02:06.000Z'
      });
      expect(snapshot.item).toEqual({
        published_at: '2026-06-05T01:02:07.000Z',
        updated_at: '2026-06-05T01:02:08.000Z',
        delivered_at: '2026-06-05T01:02:09.000Z',
        next_attempt_at: null,
        failed_at: '2026-06-05T01:02:10.000Z',
        translated_at: null,
        created_at: '2026-06-05T01:02:11.000Z'
      });
      expect(snapshot.deliveryLog).toEqual({ created_at: '2026-06-05T01:02:12.000Z' });
      expect(snapshot.fetchLog).toEqual({ created_at: '2026-06-05T01:02:13.000Z' });
      expect(snapshot.template).toEqual({ created_at: '2026-06-05T01:02:14.000Z', updated_at: '2026-06-05T01:02:15.000Z' });
      expect(snapshot.group).toEqual({ created_at: '2026-06-05T01:02:03.000Z', updated_at: '2026-06-05T01:02:04.000Z' });

      db.exec(readProjectMigration('0018_runtime_timestamp_iso_z_backfill.sql'));
      expect(readRuntimeTimestampSnapshot(db)).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

});

describe('createContainer', () => {
  it('creates parent directories, configures SQLite, wires repositories, and closes idempotently', async () => {
    const dir = makeTempDir();
    const databasePath = join(dir, 'nested', 'rss.sqlite');
    const container = createContainer({
      env: {
        DATABASE_PATH: databasePath
      }
    });

    try {
      expect(Object.keys(container.repositories).sort()).toEqual([
        'deliveryLogs',
        'fetchLogs',
        'groups',
        'items',
        'modelConfig',
        'modelUsage',
        'sourceGroups',
        'sources',
        'templates'
      ]);
      expect(Object.keys(container.services).sort()).toEqual([
        'exportImport',
        'groups',
        'logs',
        'model',
        'preview',
        'scheduler',
        'sources',
        'templates',
        'testSend'
      ]);
      expect(Object.keys(container.workers).sort()).toEqual(['cleanup', 'dispatcher', 'poller']);
      expect(container.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(readMigrationVersions(container.db)).toHaveLength(PROJECT_MIGRATIONS.length);
    } finally {
      await container.close();
      await container.close();
    }
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rss-discord-bridge-'));
  tempDirs.push(dir);
  return dir;
}

function readMigrationVersions(db: Database.Database): string[] {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => (row as { version: string }).version);
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnInfo(db: Database.Database, tableName: string, columnName: string): { name: string; notnull: number } | null {
  const row = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .find((candidate) => (candidate as { name: string }).name === columnName) as { name: string; notnull: number } | undefined;
  return row ?? null;
}

function foreignKeyTargets(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => (row as { table: string }).table);
}

function indexNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function uniqueIndexNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all()
    .filter((row) => (row as { unique: number }).unique === 1)
    .map((row) => (row as { name: string }).name);
}

function readModelConfigTimestamps(db: Database.Database): Array<{ created_at: string; updated_at: string }> {
  return db.prepare('SELECT created_at, updated_at FROM model_config ORDER BY role').all() as Array<{ created_at: string; updated_at: string }>;
}

function readMigrationTimestamps(db: Database.Database): Array<{ applied_at: string }> {
  return db.prepare('SELECT applied_at FROM schema_migrations ORDER BY version').all() as Array<{ applied_at: string }>;
}

function readModelConfigDefaults(
  db: Database.Database
): Array<{
  role: string;
  provider: string;
  model: string;
  enabled: number;
  target_lang: string;
  prompt_log_max_bytes: number;
}> {
  return db
    .prepare(
      `SELECT role, provider, model, enabled, target_lang, prompt_log_max_bytes
       FROM model_config
       ORDER BY role`
    )
    .all() as Array<{
    role: string;
    provider: string;
    model: string;
    enabled: number;
    target_lang: string;
    prompt_log_max_bytes: number;
  }>;
}

function readRuntimeTimestampSnapshot(db: Database.Database): {
  source: Record<string, string | null>;
  item: Record<string, string | null>;
  deliveryLog: Record<string, string>;
  fetchLog: Record<string, string>;
  template: Record<string, string>;
  group: Record<string, string>;
} {
  return {
    source: db
      .prepare('SELECT created_at, delivery_cutoff_at, last_polled_at, next_poll_at FROM sources WHERE id = ?')
      .get('legacy-ts') as Record<string, string | null>,
    item: db
      .prepare('SELECT published_at, updated_at, delivered_at, next_attempt_at, failed_at, translated_at, created_at FROM items WHERE atom_id = ?')
      .get('atom-ts') as Record<string, string | null>,
    deliveryLog: db.prepare('SELECT created_at FROM delivery_log WHERE item_id = 1').get() as Record<string, string>,
    fetchLog: db.prepare("SELECT created_at FROM fetch_log WHERE source_id = 'legacy-ts'").get() as Record<string, string>,
    template: db.prepare("SELECT created_at, updated_at FROM templates WHERE name = 'timestamp-template'").get() as Record<string, string>,
    group: db.prepare("SELECT created_at, updated_at FROM \"groups\" WHERE name = 'Legacy Timestamps'").get() as Record<string, string>
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readProjectMigration(fileName: string): string {
  return readFileSync(join(process.cwd(), 'src/resources/migrations', fileName), 'utf8');
}
