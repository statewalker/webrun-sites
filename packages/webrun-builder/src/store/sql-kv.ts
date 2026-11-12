import { emptyMetrics, type KV, type KvMetrics, type KvWrite } from "./kv.js";

/**
 * The SQL port this store needs — structurally the `SqlDriver` of
 * `@statewalker/webrun-files-sqlite` (node:sqlite, Durable Object storage, D1),
 * declared here so the engine carries no dependency on it.
 */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
  run(sql: string, ...params: unknown[]): void | Promise<void>;
  transaction(statements: { sql: string; params?: unknown[] }[]): number[] | Promise<number[]>;
}

/**
 * The KV port over the `SqlDriver` of `@statewalker/webrun-files-sqlite`
 * (node:sqlite, Durable Object storage, D1): one `WITHOUT ROWID` table. Prefix
 * scans are range scans on the primary key, read in pages; a commit is one
 * driver transaction. Counts the same metrics as `MemKV`.
 */
export class SqlKV implements KV {
  readonly metrics: KvMetrics = emptyMetrics();
  #ready?: Promise<void>;

  constructor(
    private readonly db: SqlDriver,
    private readonly table = "kv",
    private readonly pageSize = 256,
  ) {}

  #init(): Promise<void> {
    this.#ready ??= Promise.resolve(
      this.db.run(
        `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
      ),
    );
    return this.#ready;
  }

  async get(key: string): Promise<string | undefined> {
    await this.#init();
    this.metrics.gets++;
    const [row] = await this.db.all<{ value: string }>(
      `SELECT value FROM ${this.table} WHERE key = ?`,
      key,
    );
    return row?.value;
  }

  async *scan(
    prefix: string,
    opts?: { after?: string; limit?: number },
  ): AsyncIterable<[string, string]> {
    await this.#init();
    this.metrics.scans++;
    const end = nextPrefix(prefix);
    let remaining = opts?.limit ?? Number.POSITIVE_INFINITY;
    let after = opts?.after !== undefined && opts.after >= prefix ? opts.after : undefined;
    while (remaining > 0) {
      const n = Math.min(this.pageSize, remaining);
      const rows = await this.db.all<{ key: string; value: string }>(
        after === undefined
          ? `SELECT key, value FROM ${this.table} WHERE key >= ? AND key < ? ORDER BY key LIMIT ?`
          : `SELECT key, value FROM ${this.table} WHERE key > ? AND key < ? ORDER BY key LIMIT ?`,
        after ?? prefix,
        end,
        n,
      );
      for (const r of rows) {
        this.metrics.rowsScanned++;
        yield [r.key, r.value];
      }
      if (rows.length < n) return;
      remaining -= rows.length;
      after = (rows.at(-1) as { key: string }).key;
    }
  }

  async commit(writes: ReadonlyArray<KvWrite>): Promise<boolean[]> {
    await this.#init();
    this.metrics.commits++;
    const t = this.table;
    const statements = writes.map(({ key, value, ifValue, guard }) => {
      // The guard is one more condition on the same statement.
      const g = guard ? ` AND EXISTS (SELECT 1 FROM ${t} WHERE key = ? AND value = ?)` : "";
      const gp = guard ? [guard.key, guard.value] : [];
      if (value === undefined) {
        this.metrics.rowsDeleted++;
        if (ifValue === null) {
          // "Delete if absent": a no-op that applies iff the key is absent (and the guard holds).
          const notGuard = guard
            ? ` OR NOT EXISTS (SELECT 1 FROM ${t} WHERE key = ? AND value = ?)`
            : "";
          return {
            sql: `UPDATE ${t} SET value = value WHERE key = ?${notGuard}`,
            params: [key, ...gp],
          };
        }
        if (ifValue === undefined) {
          return { sql: `DELETE FROM ${t} WHERE key = ?${g}`, params: [key, ...gp] };
        }
        return {
          sql: `DELETE FROM ${t} WHERE key = ? AND value = ?${g}`,
          params: [key, ifValue, ...gp],
        };
      }
      this.metrics.rowsWritten++;
      this.metrics.bytesWritten += key.length + value.length;
      if (ifValue === undefined) {
        return guard
          ? {
              sql: `INSERT INTO ${t} (key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${t} WHERE key = ? AND value = ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
              params: [key, value, ...gp],
            }
          : {
              sql: `INSERT INTO ${t} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
              params: [key, value],
            };
      }
      if (ifValue === null) {
        return guard
          ? {
              sql: `INSERT INTO ${t} (key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${t} WHERE key = ? AND value = ?) ON CONFLICT (key) DO NOTHING`,
              params: [key, value, ...gp],
            }
          : {
              sql: `INSERT INTO ${t} (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
              params: [key, value],
            };
      }
      return {
        sql: `UPDATE ${t} SET value = ? WHERE key = ? AND value = ?${g}`,
        params: [value, key, ifValue, ...gp],
      };
    });
    if (statements.length === 0) return [];
    const counts = await this.db.transaction(statements);
    return writes.map((w, i) => {
      const n = counts[i] ?? 0;
      if (w.value === undefined && w.ifValue === null) return n === 0;
      return w.ifValue === undefined && !w.guard ? true : n > 0;
    });
  }

  resetMetrics(): void {
    Object.assign(this.metrics, emptyMetrics());
  }
}

/** The smallest string greater than every string starting with `prefix`. */
function nextPrefix(prefix: string): string {
  if (prefix === "") return "\u{10FFFF}";
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}
