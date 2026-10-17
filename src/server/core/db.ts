import { fileURLToPath } from 'node:url';
import type DatabaseType from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function toSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value: number): boolean {
  return value === 1;
}

export function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function parseJsonObject<T extends object>(value: string | null, fallback: T, fieldName: string): T {
  // 값이 없는 경우만 기본값을 사용한다. 손상된 JSON은 필드명을 포함한 오류로 드러낸다.
  if (value === null || value.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('JSON value is not an object.');
    }
    return parsed as T;
  } catch (error) {
    throw new Error(`${fieldName} contains invalid JSON.`, { cause: error });
  }
}

export function stringifyJsonObject(value: object): string {
  return JSON.stringify(value);
}

export function parseJsonStringArray(value: string | null, fallback: string[], fieldName: string): string[] {
  if (value === null || value.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('JSON value is not a string array.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} contains invalid JSON.`, { cause: error });
  }
}

export function stringifyJsonStringArray(value: readonly string[]): string {
  return JSON.stringify(value);
}

export function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  return trimmed;
}

/** DB 시각은 UTC ISO 문자열로 통일한다. KST 표시는 렌더 계층에서 변환한다. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(baseIso: string, seconds: number): string {
  const base = Date.parse(baseIso);
  if (!Number.isFinite(base)) {
    throw new Error('baseIso must be a valid ISO timestamp.');
  }
  return new Date(base + seconds * 1000).toISOString();
}

export function subtractDaysIso(baseIso: string, days: number): string {
  const base = Date.parse(baseIso);
  if (!Number.isFinite(base)) {
    throw new Error('baseIso must be a valid ISO timestamp.');
  }
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}

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
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as {
      version: string
    }).version)
  );

  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 0001_, 0002_ … 파일명 순 = 적용 순서

  // 2026-10-17 마이그레이션 통합 이전 DB는 파일에 없는 버전 기록을 갖는다. 일부만 맞는 스키마로 기동하지 않게 막는다.
  const known = new Set(files.map((file) => file.replace(/\.sql$/, '')));
  const unknown = [...applied].filter((version) => !known.has(version)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `DB에 현재 마이그레이션 파일에 없는 버전 기록이 있습니다(${unknown.join(', ')}). ` +
      '마이그레이션 통합 이전에 만든 DB이므로 새 DB로 시작해야 합니다.'
    );
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const appliedNow: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(version, migrationTimestamp());
    })();
    appliedNow.push(version);
  }

  return appliedNow;
}

function migrationTimestamp(): string {
  return new Date().toISOString();
}
