import type { SqlDriver } from "@statewalker/webrun-files-sqlite";
import { emptyMetrics, type KV, type KvMetrics } from "./kv.js";

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

  async commit(writes: ReadonlyArray<{ key: string; value?: string }>): Promise<void> {
    await this.#init();
    this.metrics.commits++;
    const statements = writes.map(({ key, value }) => {
      if (value === undefined) {
        this.metrics.rowsDeleted++;
        return { sql: `DELETE FROM ${this.table} WHERE key = ?`, params: [key] };
      }
      this.metrics.rowsWritten++;
      this.metrics.bytesWritten += key.length + value.length;
      return {
        sql: `INSERT INTO ${this.table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        params: [key, value],
      };
    });
    if (statements.length > 0) await this.db.transaction(statements);
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
