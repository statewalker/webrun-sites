/**
 * The storage port the engine keeps all its state in: an ordered key-value
 * store with prefix scans and atomic multi-key commits. It is the
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

/** In-memory ordered KV (a blocked sorted key list + a map), with I/O counters. */
export class MemKV implements KV {
  readonly metrics: KvMetrics = emptyMetrics();
  private readonly values = new Map<string, string>();
  private readonly keys = new SortedKeys();

  async get(key: string): Promise<string | undefined> {
    this.metrics.gets++;
    return this.values.get(key);
  }

  async *scan(
    prefix: string,
    opts?: { after?: string; limit?: number },
  ): AsyncIterable<[string, string]> {
    this.metrics.scans++;
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    const after = opts?.after !== undefined && opts.after >= prefix ? opts.after : undefined;
    // Each step looks up the successor of the last key afresh, so commits made
    // by the caller while iterating are tolerated.
    let key = after === undefined ? this.keys.ceiling(prefix) : this.keys.higher(after);
    let n = 0;
    while (key !== undefined && n < limit && key.startsWith(prefix)) {
      const value = this.values.get(key);
      if (value !== undefined) {
        n++;
        this.metrics.rowsScanned++;
        yield [key, value];
      }
      key = this.keys.higher(key);
    }
  }

  async commit(writes: ReadonlyArray<{ key: string; value?: string }>): Promise<void> {
    this.metrics.commits++;
    for (const { key, value } of writes) {
      if (value === undefined) {
        if (this.values.delete(key)) this.keys.delete(key);
        this.metrics.rowsDeleted++;
      } else {
        if (!this.values.has(key)) this.keys.insert(key);
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

  /** All rows in key order (for snapshots and state-size measurements). */
  dump(): [string, string][] {
    return [...this.keys].map((k) => [k, this.values.get(k) as string]);
  }

  resetMetrics(): void {
    Object.assign(this.metrics, emptyMetrics());
  }
}

/**
 * A sorted set of strings kept as a list of sorted blocks (at most `2 * B`
 * keys each), so an insert or delete moves O(B) entries instead of O(n), and
 * lookups are two binary searches.
 */
class SortedKeys {
  private static readonly B = 256;
  private blocks: string[][] = [];
  /** The last (largest) key of each block. */
  private maxes: string[] = [];

  /** Smallest key >= `key`. */
  ceiling(key: string): string | undefined {
    const b = lowerBound(this.maxes, key);
    const block = this.blocks[b];
    return block ? block[lowerBound(block, key)] : undefined;
  }

  /** Smallest key > `key`. */
  higher(key: string): string | undefined {
    let b = lowerBound(this.maxes, key);
    let block = this.blocks[b];
    if (!block) return undefined;
    let i = lowerBound(block, key);
    if (block[i] === key) i++;
    if (i >= block.length) {
      b++;
      block = this.blocks[b];
      i = 0;
    }
    return block?.[i];
  }

  insert(key: string): void {
    if (this.blocks.length === 0) {
      this.blocks.push([key]);
      this.maxes.push(key);
      return;
    }
    let b = lowerBound(this.maxes, key);
    if (b === this.blocks.length) b--;
    const block = this.blocks[b] as string[];
    block.splice(lowerBound(block, key), 0, key);
    this.maxes[b] = block[block.length - 1] as string;
    if (block.length > 2 * SortedKeys.B) {
      const tail = block.splice(SortedKeys.B);
      this.blocks.splice(b + 1, 0, tail);
      this.maxes.splice(b, 1, block[block.length - 1] as string, tail[tail.length - 1] as string);
    }
  }

  delete(key: string): void {
    const b = lowerBound(this.maxes, key);
    const block = this.blocks[b];
    if (!block) return;
    const i = lowerBound(block, key);
    if (block[i] !== key) return;
    block.splice(i, 1);
    if (block.length === 0) {
      this.blocks.splice(b, 1);
      this.maxes.splice(b, 1);
    } else {
      this.maxes[b] = block[block.length - 1] as string;
    }
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const block of this.blocks) yield* block;
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
