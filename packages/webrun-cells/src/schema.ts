import type { SqlStatement } from "@statewalker/webrun-files-sqlite";

/** Idempotent: safe to run on every open. */
export const SCHEMA: SqlStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_rows (
      signal TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (signal, key)) WITHOUT ROWID`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_pending (
      cell TEXT NOT NULL, signal TEXT NOT NULL, key TEXT NOT NULL,
      seq INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until INTEGER,
      PRIMARY KEY (cell, signal, key)) WITHOUT ROWID`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_provenance (
      cell TEXT NOT NULL, in_signal TEXT NOT NULL, in_key TEXT NOT NULL,
      out_signal TEXT NOT NULL, out_key TEXT NOT NULL,
      PRIMARY KEY (cell, in_signal, in_key, out_signal, out_key)) WITHOUT ROWID`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS cells_provenance_out ON cells_provenance (out_signal, out_key)" },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_dead_letter (
      cell TEXT NOT NULL, signal TEXT NOT NULL, key TEXT NOT NULL,
      attempts INTEGER NOT NULL, error TEXT NOT NULL,
      PRIMARY KEY (cell, signal, key)) WITHOUT ROWID`,
  },
  { sql: "CREATE TABLE IF NOT EXISTS cells_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID" },
  { sql: "INSERT OR IGNORE INTO cells_meta (name, value) VALUES ('seq', 0)" },
];
