import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, describe, it } from 'vitest';
import { runMigrations } from '../../src/server/core/db.js';

// Docs/DB-스키마.md must describe exactly the schema the migrations produce.
const DOC_PATH = fileURLToPath(new URL('../../Docs/DB-스키마.md', import.meta.url));

interface SchemaObject {
  type: 'table' | 'index' | 'trigger';
  name: string;
}

function migratedSchema() {
  const db = new Database(':memory:');
  runMigrations(db);
  const objects = db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger')
         AND name NOT LIKE 'sqlite_%'`
    )
    .all() as SchemaObject[];
  const columns = new Map<string, string[]>();
  for (const table of objects.filter((object) => object.type === 'table')) {
    const rows = db.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>;
    columns.set(table.name, rows.map((row) => row.name).sort());
  }
  db.close();
  return { objects, columns };
}

function documentedTables(doc: string): Map<string, string[]> {
  const start = doc.indexOf('\n## 3.');
  const end = doc.indexOf('\n## 4.');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const part = doc.slice(start, end);
  const tables = new Map<string, string[]>();
  const sections = part.split(/^### `([^`]+)`\s*$/m);
  for (let index = 1; index < sections.length; index += 2) {
    const body = sections[index + 1] ?? '';
    const names = [...body.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    tables.set(sections[index], names.sort());
  }
  return tables;
}

describe('Docs/DB-스키마.md', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const { objects, columns } = migratedSchema();
  const documented = documentedTables(doc);

  it('documents every table and no removed table', () => {
    expect([...documented.keys()].sort()).toEqual([...columns.keys()].sort());
  });

  it('documents exactly the columns of each table', () => {
    for (const [table, actual] of columns) {
      expect(documented.get(table), `columns of ${table}`).toEqual(actual);
    }
  });

  it('mentions every index and trigger by name', () => {
    const missing = objects
      .filter((object) => object.type !== 'table')
      .filter((object) => !doc.includes('`' + object.name + '`'))
      .map((object) => `${object.type} ${object.name}`);
    expect(missing).toEqual([]);
  });
});
