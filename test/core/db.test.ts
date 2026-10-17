import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/core/db.js';
import { createContainer } from '../../src/server/container.js';

const tempDirs: string[] = [];

const PROJECT_MIGRATIONS = ['0001_init'];

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

      expect(tableNames(db).filter((name) => !name.startsWith('sqlite_'))).toEqual([
        'delivery_bindings',
        'delivery_jobs',
        'destination_cooldowns',
        'event_log',
        'groups',
        'item_deliveries',
        'items',
        'schema_migrations',
        'source_groups',
        'sources',
        'templates',
        'translation_cache'
      ]);
      expect(columnNames(db, 'sources')).not.toContain('webhook_url');
      expect(columnNames(db, 'sources')).toEqual(
        expect.arrayContaining([
          'template_id',
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
      // 항목은 내용과 버전만 가진다. 발송 상태는 delivery_jobs·item_deliveries에만 있다.
      expect(columnNames(db, 'items')).toEqual([
        'id', 'source_id', 'atom_id', 'title', 'summary', 'link', 'author', 'comments_url', 'image', 'incident_stage',
        'published_at', 'updated_at', 'content_hash', 'content_revision', 'historical', 'content_pruned', 'last_seen_at', 'created_at'
      ]);
      expect(columnNames(db, 'event_log')).toEqual([
        'id', 'created_at', 'kind', 'status', 'source_id', 'item_id', 'job_id', 'http_status', 'duration_ms', 'item_count', 'detail'
      ]);
      expect(columnInfo(db, 'delivery_jobs', 'binding_id')?.notnull).toBe(1);
      expect(columnInfo(db, 'groups', 'webhook_url')?.notnull).toBe(0);
      expect(foreignKeyTargets(db, 'source_groups')).toEqual(expect.arrayContaining(['sources', 'groups']));
      expect(foreignKeyTargets(db, 'event_log')).toEqual(['sources']);
      expect(indexNames(db, 'sources')).toEqual(expect.arrayContaining(['idx_sources_enabled_next_poll', 'idx_sources_feed_url_unique']));
      expect(indexNames(db, 'event_log')).toEqual(expect.arrayContaining(['idx_event_log_kind', 'idx_event_log_source']));
      expect(indexNames(db, 'delivery_jobs')).not.toContain('idx_legacy_unknown');
      expect(readMigrationTimestamps(db).every((row) => row.applied_at.includes('T') && row.applied_at.endsWith('Z'))).toBe(true);
      expect(() => db.prepare("INSERT INTO event_log(created_at, kind, status) VALUES ('x', 'fetch', 'success')").run()).toThrow(/CHECK/);
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

  it('refuses a database that recorded versions no longer in the migrations directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE first (id INTEGER PRIMARY KEY);');

    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES ('0001_init', '2026-06-01T00:00:00.000Z'), ('0002_templates', '2026-06-01T00:00:00.000Z');`);
      expect(() => runMigrations(db, { migrationsDir: dir })).toThrow(/0002_templates/);
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
        'deliveryBindings',
        'deliveryJobs',
        'eventLog',
        'groups',
        'itemDeliveries',
        'items',
        'sourceGroups',
        'sources',
        'templates',
        'translationCache'
      ]);
      expect(Object.keys(container.services).sort()).toEqual([
        'delivery',
        'deliveryBindings',
        'deliveryManagement',
        'deliveryPlan',
        'exportImport',
        'groups',
        'logs',
        'model',
        'poll',
        'preview',
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

function readMigrationTimestamps(db: Database.Database): Array<{ applied_at: string }> {
  return db.prepare('SELECT applied_at FROM schema_migrations ORDER BY version').all() as Array<{ applied_at: string }>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
