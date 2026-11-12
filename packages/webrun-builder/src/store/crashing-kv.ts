import type { KV, KvWrite } from "./kv.js";

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

  async commit(writes: ReadonlyArray<KvWrite>): Promise<boolean[]> {
    this.commits++;
    // The process is dead from the failing commit on: nothing more is applied.
    if (this.commits >= this.failAt) throw new CrashError(`crash at commit ${this.failAt}`);
    return this.inner.commit(writes);
  }
}
