/**
 * The storage port every prototype keeps its durable state in: an ordered
 * key-value store with prefix scans and atomic multi-key commits. It is the
 * smallest shape that maps onto SQLite (one table, `WITHOUT ROWID`), IndexedDB,
 * LMDB, a Durable Object's storage, or a JSON file — so the counts it records
 * translate into real persistence costs.
 *
 * Reads are not transactional with commits: an engine reads, then commits a
 * fixed list of writes (as D1 `batch()` allows).
 */
export interface KV {
  get(key: string): Promise<string | undefined>;
  /** Rows whose key starts with `prefix`, ascending; `after` is exclusive. */
  scan(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<[string, string]>;
  /** Apply all writes atomically. `value: undefined` deletes. */
  commit(writes: ReadonlyArray<{ key: string; value?: string }>): Promise<void>;
}

export interface KvMetrics {
  gets: number;
  scans: number;
  rowsScanned: number;
  commits: number;
  rowsWritten: number;
  rowsDeleted: number;
  bytesWritten: number;
}

export function emptyMetrics(): KvMetrics {
  return {
    gets: 0,
    scans: 0,
    rowsScanned: 0,
    commits: 0,
    rowsWritten: 0,
    rowsDeleted: 0,
    bytesWritten: 0,
  };
}

/**
 * In-memory ordered KV with I/O counters — the same implementation the real
 * engine ships, so prototypes and the engine are measured on equal footing.
 */
export { MemKV } from "@statewalker/webrun-builder";

export class CrashError extends Error {
  override name = "CrashError";
}

/**
 * Wraps a KV and throws `CrashError` instead of applying the `failAt`-th commit
 * (1-based) — simulating a process killed right before that commit. Every
 * commit before it is applied; nothing after it is attempted by the caller
 * because the error propagates out of `run()`.
 */
export class CrashingKV implements KV {
  commits = 0;
  constructor(
    private readonly inner: KV,
    private readonly failAt: number,
  ) {}

  get(key: string): Promise<string | undefined> {
    return this.inner.get(key);
  }

  scan(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<[string, string]> {
    return this.inner.scan(prefix, opts);
  }

  async commit(writes: ReadonlyArray<{ key: string; value?: string }>): Promise<void> {
    this.commits++;
    // The process is dead from the failing commit on: nothing more is applied.
    if (this.commits >= this.failAt) throw new CrashError(`crash at commit ${this.failAt}`);
    await this.inner.commit(writes);
  }
}
