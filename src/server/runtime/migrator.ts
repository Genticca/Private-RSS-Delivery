import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type DatabaseType from 'better-sqlite3';
import { sha256Hex } from '../domain/normalize/content-hash.js';

// D3/D9: resources/migrations 의 .sql 을 순번대로 적용 (copy 스텝으로 dist/resources/migrations 에 안착).
// import.meta.url 상대 resolve → dev(src/resources) / prod(dist/resources) 모두 동작.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../resources/migrations', import.meta.url));

export interface Migration {
  version: string;
  file: string;
}

export interface RunMigrationsOptions {
  migrationsDir?: string;
}

/** 미적용 마이그레이션만 파일명 순서대로 트랜잭션 안에서 실행한다. */
export function runMigrations(db: DatabaseType.Database, options: RunMigrationsOptions = {}): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: string }).version)
  );

  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 0001_, 0002_ … 파일명 순 = 적용 순서

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const appliedNow: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      runPostMigrationBackfill(db, version);
      record.run(version, migrationTimestamp());
    })();
    appliedNow.push(version);
  }

  return appliedNow;
}

function runPostMigrationBackfill(db: DatabaseType.Database, version: string): void {
  if (version === '0014_generic_content_hash_title_link') {
    backfillGenericContentHashes(db);
  }
}

function backfillGenericContentHashes(db: DatabaseType.Database): void {
  const rows = db
    .prepare(
      `SELECT items.id, COALESCE(items.title, '') AS title, COALESCE(items.link, '') AS link, items.content_hash
       FROM items
       JOIN sources ON sources.id = items.source_id
       WHERE CASE
         WHEN sources.profile = 'auto' THEN COALESCE(sources.detected_profile, 'generic')
         ELSE sources.profile
       END = 'generic'`
    )
    .all() as Array<{ id: number; title: string; link: string; content_hash: string | null }>;

  if (rows.length === 0) return;

  const update = db.prepare('UPDATE items SET content_hash = ? WHERE id = ?');
  for (const row of rows) {
    const nextHash = sha256Hex(`${row.title}\n${row.link}`);
    if (row.content_hash !== nextHash) {
      update.run(nextHash, row.id);
    }
  }
}

function migrationTimestamp(): string {
  return new Date().toISOString();
}
