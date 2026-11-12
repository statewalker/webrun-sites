import { type FilesApi, joinPath } from "@statewalker/webrun-files";
import { tryReadJson, writeJsonAtomic } from "../json-io.js";
import { seqKey } from "../keys.js";
import { conditionHolds, type KV, type KvMetrics, type KvWrite, MemKV } from "./kv.js";

type Write = { key: string; value?: string };

interface Snapshot {
  /** The last log segment folded into this snapshot. */
  seq: number;
  rows: [string, string][];
}

/**
 * The KV port persisted under a folder of any `FilesApi` (memory, Node, browser
 * storage) — no database needed. Rows live in memory; each commit is written
 * as one small log segment (`log/<seq>.json`, atomic temp-file + rename)
 * before it is applied, and every `compactEvery` segments the state is folded
 * into `snapshot.json` and the folded segments are removed. Opening replays the
 * snapshot plus the remaining segments, so a crash loses nothing that was
 * committed.
 *
 * One writer per folder: two processes appending segments would interleave.
 */
export class FilesKV implements KV {
  private seq: number;
  private segments: number[];
  private lock: Promise<void> = Promise.resolve();

  private constructor(
    private readonly files: FilesApi,
    private readonly dir: string,
    private readonly mem: MemKV,
    seq: number,
    segments: number[],
    private readonly compactEvery: number,
  ) {
    this.seq = seq;
    this.segments = segments;
  }

  static async open(
    files: FilesApi,
    dir: string,
    opts?: { compactEvery?: number },
  ): Promise<FilesKV> {
    const mem = new MemKV();
    const snap = await tryReadJson<Snapshot>(files, joinPath(dir, "snapshot.json"));
    let seq = snap?.seq ?? 0;
    if (snap) await mem.commit(snap.rows.map(([key, value]) => ({ key, value })));
    const logDir = joinPath(dir, "log");
    const found: number[] = [];
    if (await files.exists(logDir)) {
      for await (const info of files.list(logDir)) {
        const m = /^([0-9a-z]{11})\.json$/.exec(info.name);
        if (info.kind === "file" && m) found.push(Number.parseInt(m[1] as string, 36));
      }
    }
    found.sort((a, b) => a - b);
    const segments: number[] = [];
    for (const n of found) {
      if (n <= seq) {
        // Folded into the snapshot already (a crash interrupted the clean-up).
        segments.push(n);
        continue;
      }
      const writes = await tryReadJson<Write[]>(files, joinPath(logDir, `${seqKey(n)}.json`));
      if (!writes) break;
      await mem.commit(writes);
      seq = n;
      segments.push(n);
    }
    mem.resetMetrics();
    return new FilesKV(files, dir, mem, seq, segments, opts?.compactEvery ?? 256);
  }

  get metrics(): KvMetrics {
    return this.mem.metrics;
  }

  get(key: string): Promise<string | undefined> {
    return this.mem.get(key);
  }

  scan(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<[string, string]> {
    return this.mem.scan(prefix, opts);
  }

  async commit(writes: ReadonlyArray<KvWrite>): Promise<boolean[]> {
    // Serialised, so conditions are evaluated against the state they apply to.
    const result = this.lock.then(async () => {
      const applied: boolean[] = [];
      const effective: Write[] = [];
      for (const w of writes) {
        const ok = conditionHolds(w, this.mem.peek(w.key));
        applied.push(ok);
        if (ok)
          effective.push(w.value === undefined ? { key: w.key } : { key: w.key, value: w.value });
      }
      if (effective.length === 0) return applied;
      const n = this.seq + 1;
      await writeJsonAtomic(this.files, joinPath(this.dir, "log", `${seqKey(n)}.json`), effective);
      await this.mem.commit(effective);
      this.seq = n;
      this.segments.push(n);
      if (this.segments.length >= this.compactEvery) await this.compact();
      return applied;
    });
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Fold the log into `snapshot.json` and remove the folded segments. */
  async compact(): Promise<void> {
    const snap: Snapshot = { seq: this.seq, rows: this.mem.dump() };
    await writeJsonAtomic(this.files, joinPath(this.dir, "snapshot.json"), snap);
    for (const n of this.segments) {
      if (n > snap.seq) continue;
      await this.files.remove(joinPath(this.dir, "log", `${seqKey(n)}.json`));
    }
    this.segments = this.segments.filter((n) => n > snap.seq);
  }
}
