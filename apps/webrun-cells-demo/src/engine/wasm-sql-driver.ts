import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SqlDriver, SqlStatement } from "@statewalker/webrun-files-sqlite";

/** The subset of sqlite-wasm's `oo1.DB` this driver uses. */
export interface WasmDatabase {
  exec(opts: { sql: string; bind?: unknown[] }): unknown;
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  changes(): number;
}

const bind = (params: unknown[] | undefined) => (params && params.length > 0 ? params : undefined);

/** sqlite-wasm (`oo1.DB`): synchronous, so a transaction cannot interleave with other calls. */
export class WasmSqlDriver implements SqlDriver {
  readonly #db: WasmDatabase;

  constructor(db: WasmDatabase) {
    this.#db = db;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.selectObjects(sql, bind(params)) as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    this.#db.exec({ sql, bind: bind(params) });
  }

  transaction(statements: SqlStatement[]): number[] {
    this.#db.exec({ sql: "BEGIN" });
    try {
      const counts = statements.map((s) => {
        this.#db.exec({ sql: s.sql, bind: bind(s.params) });
        return this.#db.changes();
      });
      this.#db.exec({ sql: "COMMIT" });
      return counts;
    } catch (error) {
      this.#db.exec({ sql: "ROLLBACK" });
      throw error;
    }
  }
}

/** A fresh in-memory database. */
export async function openMemoryDb(): Promise<WasmSqlDriver> {
  const sqlite3 = await sqlite3InitModule();
  return new WasmSqlDriver(new sqlite3.oo1.DB(":memory:") as unknown as WasmDatabase);
}
