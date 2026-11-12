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

/** In-memory ordered KV (sorted key array + map), with I/O counters. */
export class MemKV implements KV {
  readonly metrics: KvMetrics = emptyMetrics();
  private readonly values = new Map<string, string>();
  private readonly keys: string[] = [];

  async get(key: string): Promise<string | undefined> {
    this.metrics.gets++;
    return this.values.get(key);
  }

  async *scan(
    prefix: string,
    opts?: { after?: string; limit?: number },
  ): AsyncIterable<[string, string]> {
    this.metrics.scans++;
    const from = opts?.after !== undefined && opts.after >= prefix ? opts.after : prefix;
    let i = lowerBound(this.keys, from);
    if (opts?.after !== undefined && this.keys[i] === opts.after) i++;
    let n = 0;
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    // Snapshot the slice lazily: callers may commit while iterating.
    while (i < this.keys.length && n < limit) {
      const key = this.keys[i] as string;
      if (!key.startsWith(prefix)) break;
      const value = this.values.get(key);
      i++;
      if (value === undefined) continue;
      n++;
      this.metrics.rowsScanned++;
      yield [key, value];
      // Re-anchor after a yield: the caller may have committed meanwhile.
      if (this.keys[i - 1] !== key) {
        i = lowerBound(this.keys, key);
        if (this.keys[i] === key) i++;
      }
    }
  }

  async commit(writes: ReadonlyArray<{ key: string; value?: string }>): Promise<void> {
    this.metrics.commits++;
    for (const { key, value } of writes) {
      if (value === undefined) {
        if (this.values.delete(key)) {
          this.keys.splice(lowerBound(this.keys, key), 1);
        }
        this.metrics.rowsDeleted++;
      } else {
        if (!this.values.has(key)) this.keys.splice(lowerBound(this.keys, key), 0, key);
        this.values.set(key, value);
        this.metrics.rowsWritten++;
        this.metrics.bytesWritten += key.length + value.length;
      }
    }
  }

  /** Number of stored rows. */
  get size(): number {
    return this.values.size;
  }

  /** All rows (for debugging and state-size measurements). */
  dump(): [string, string][] {
    return this.keys.map((k) => [k, this.values.get(k) as string]);
  }

  resetMetrics(): void {
    Object.assign(this.metrics, emptyMetrics());
  }
}

function lowerBound(arr: readonly string[], key: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as string) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
