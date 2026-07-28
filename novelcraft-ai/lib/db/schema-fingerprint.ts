import 'server-only';

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

/**
 * Semantic structural fingerprint for SQLite user schema objects.
 *
 * Covers table columns (name/type/not-null/default/PK), CHECK/FK lists,
 * user indexes (uniqueness/partial/expression SQL), triggers, the
 * `_schema_version` marker shape, and `PRAGMA user_version`. Same-name forged
 * tables with different structure produce different digests. Table CREATE SQL
 * formatting differences (e.g. after `ALTER TABLE ADD COLUMN`) are ignored in
 * favor of PRAGMA-derived structure plus normalized CHECK clauses.
 */
export interface SchemaFingerprint {
  userVersion: number;
  digest: string;
  objectCount: number;
}

interface ColumnSpec {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
  pk: number;
  hidden: number;
}

interface ForeignKeySpec {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListSpec {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexXinfoSpec {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string | null;
  key: number;
}

interface TableListSpec {
  name: string;
  wr: number;
  strict: number;
}

function normalizeSql(sql: string | null): string {
  if (!sql) return '';
  return sql.replace(/\s+/g, ' ').trim();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Extract CHECK (...) clauses with balanced parentheses, then normalize/sort. */
function extractCheckClauses(createSql: string | null): string[] {
  if (!createSql) return [];
  const upper = createSql.toUpperCase();
  const checks: string[] = [];
  let from = 0;
  while (from < upper.length) {
    const idx = upper.indexOf('CHECK', from);
    if (idx < 0) break;
    let i = idx + 5;
    while (i < createSql.length && /\s/.test(createSql[i]!)) i++;
    if (createSql[i] !== '(') {
      from = idx + 5;
      continue;
    }
    let depth = 0;
    const start = i;
    for (; i < createSql.length; i++) {
      const ch = createSql[i]!;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          checks.push(normalizeSql(createSql.slice(start, i + 1)));
          from = i + 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return checks.sort((a, b) => a.localeCompare(b));
}

function tableStructuralSpec(db: Database.Database, table: string): unknown {
  // Sort by name so ALTER-added columns match a fresh CREATE with different
  // physical order while still comparing type/null/default/PK semantics.
  const columns = (db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as ColumnSpec[])
    .map(col => ({
      name: col.name,
      type: col.type,
      notnull: col.notnull,
      dflt_value: col.dflt_value,
      pk: col.pk,
      hidden: col.hidden,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Inline UNIQUE and composite PRIMARY KEY constraints live in SQLite-owned
  // autoindexes whose names/SQL are omitted from sqlite_schema. Fingerprint
  // their semantics (not generated names) so a same-column forged table cannot
  // pass by silently dropping a uniqueness contract.
  const implicitUniqueIndexes = (
    db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as IndexListSpec[]
  )
    .filter(index => index.origin === 'u' || index.origin === 'pk')
    .map(index => ({
      origin: index.origin,
      unique: index.unique,
      partial: index.partial,
      columns: (
        db.prepare(`PRAGMA index_xinfo(${quoteIdent(index.name)})`).all() as IndexXinfoSpec[]
      )
        .filter(column => column.key === 1)
        .map(column => ({
          seqno: column.seqno,
          cid: column.cid,
          name: column.name,
          desc: column.desc,
          coll: column.coll,
        }))
        .sort((a, b) => a.seqno - b.seqno),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as ForeignKeySpec[])
    .map(fk => ({
      table: fk.table,
      from: fk.from,
      to: fk.to,
      on_update: fk.on_update,
      on_delete: fk.on_delete,
      match: fk.match,
    }))
    .sort((a, b) => `${a.from}:${a.table}:${a.to}`.localeCompare(`${b.from}:${b.table}:${b.to}`));
  const createSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string | null } | undefined;
  const tableOptions = (
    db.prepare('PRAGMA table_list').all() as TableListSpec[]
  ).find(row => row.name === table);
  return {
    kind: 'table',
    name: table,
    columns,
    implicitUniqueIndexes,
    foreignKeys,
    checks: extractCheckClauses(createSql?.sql ?? null),
    withoutRowId: tableOptions?.wr ?? 0,
    strict: tableOptions?.strict ?? 0,
  };
}

function indexStructuralSpec(
  db: Database.Database,
  name: string,
  tblName: string,
  sql: string | null,
): unknown {
  const list = (db.prepare(`PRAGMA index_list(${quoteIdent(tblName)})`).all() as IndexListSpec[])
    .find(row => row.name === name);
  return {
    kind: 'index',
    name,
    tbl_name: tblName,
    unique: list?.unique ?? 0,
    partial: list?.partial ?? 0,
    origin: list?.origin ?? 'c',
    createSql: normalizeSql(sql),
  };
}

export function computeSchemaFingerprint(db: Database.Database): SchemaFingerprint {
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type ASC, name ASC`,
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;

  const structural = objects.map(obj => {
    if (obj.type === 'table') {
      return tableStructuralSpec(db, obj.name);
    }
    if (obj.type === 'index') {
      return indexStructuralSpec(db, obj.name, obj.tbl_name, obj.sql);
    }
    if (obj.type === 'trigger') {
      return {
        kind: 'trigger',
        name: obj.name,
        tbl_name: obj.tbl_name,
        createSql: normalizeSql(obj.sql),
      };
    }
    return {
      kind: obj.type,
      name: obj.name,
      tbl_name: obj.tbl_name,
      createSql: normalizeSql(obj.sql),
    };
  });

  const hasMarker = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_schema_version'",
    )
    .get() as { present: number } | undefined;
  const marker = hasMarker
    ? (db.prepare(
      'SELECT version, description FROM _schema_version ORDER BY version DESC',
    ).all() as Array<{
      version: number;
      description: string;
    }>)
    : null;

  const userVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
  const payload = JSON.stringify({
    userVersion,
    markerShape: marker === null
      ? null
      : {
        rowCount: marker.length,
        rows: marker.map(row => ({
          version: row.version,
          description: row.description,
        })),
      },
    objects: structural,
  });

  return {
    userVersion,
    digest: createHash('sha256').update(payload).digest('hex'),
    objectCount: objects.length,
  };
}

/** Evidence oracle: JSON.stringify of non-internal sqlite_schema rows (type/name/tbl_name/sql). */
export function computeSqliteSchemaSqlOracle(db: Database.Database): { digest: string; objectCount: number } {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type ASC, name ASC`,
  ).all();
  return {
    digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    objectCount: rows.length,
  };
}
