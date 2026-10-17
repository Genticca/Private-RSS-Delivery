import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../../src/server/runtime/container.js';
import { runMigrations } from '../../../src/server/runtime/migrator.js';

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
        'deliveryLogs',
        'fetchLogs',
        'groups',
        'itemDeliveries',
        'items',
        'modelConfig',
        'modelUsage',
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
