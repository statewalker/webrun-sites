import type { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "@statewalker/webrun-builder";

/**
 * A `SqlDriver` over `node:sqlite`, for tests and benchmarks. It replaces the
 * `NodeSqlDriver` that `@statewalker/webrun-files-sqlite` exported before 0.13.
 * `transaction` runs the statements in one `BEGIN`/`COMMIT` and returns each
 * statement's number of changed rows; any failure rolls the whole batch back.
 */
export class NodeSqlDriver implements SqlDriver {
  constructor(private readonly db: DatabaseSync) {}

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  transaction(statements: { sql: string; params?: unknown[] }[]): number[] {
    this.db.exec("BEGIN");
    try {
      const counts = statements.map(({ sql, params = [] }) =>
        Number(this.db.prepare(sql).run(...(params as never[])).changes),
      );
      this.db.exec("COMMIT");
      return counts;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
