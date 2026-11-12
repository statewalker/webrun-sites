import type { FilesApi } from "@statewalker/webrun-files";
import { BuildEngine } from "./engine.js";
import { FilesKV } from "./store/files-kv.js";
import { type KV, MemKV } from "./store/kv.js";
import { type SqlDriver, SqlKV } from "./store/sql-kv.js";
import type { BuildEngineOptions } from "./types.js";

/**
 * Where a build engine keeps its state. Pick per deployment; the engine and
 * the builders do not change.
 *
 * - `memory` — nothing survives the process (tests, one-shot builds).
 * - `files`  — any `FilesApi` (Node, browser storage, memory): `snapshot.json`
 *   plus a log of small commit segments under `path`.
 * - `sql`    — one `WITHOUT ROWID` table through a `SqlDriver` (node:sqlite,
 *   Durable Objects, D1).
 * - `custom` — any implementation of the `KV` port.
 */
export type PersistenceConfig =
  | { kind: "memory" }
  | { kind: "files"; files: FilesApi; path: string; compactEvery?: number }
  | { kind: "sql"; driver: SqlDriver; table?: string }
  | { kind: "custom"; store: KV };

/** Open the store a persistence configuration describes. */
export async function openStore(config: PersistenceConfig): Promise<KV> {
  switch (config.kind) {
    case "memory":
      return new MemKV();
    case "files":
      return FilesKV.open(config.files, config.path, { compactEvery: config.compactEvery });
    case "sql":
      return new SqlKV(config.driver, config.table);
    case "custom":
      return config.store;
    default:
      throw new Error(`Unknown persistence kind "${(config as { kind?: unknown }).kind}"`);
  }
}

export type CreateBuildEngineOptions = Omit<BuildEngineOptions, "store"> & {
  /** Default `{ kind: "memory" }`. */
  persistence?: PersistenceConfig;
};

/** Open the configured store and create an engine over it. */
export async function createBuildEngine(opts: CreateBuildEngineOptions): Promise<BuildEngine> {
  const { persistence = { kind: "memory" }, ...rest } = opts;
  return new BuildEngine({ ...rest, store: await openStore(persistence) });
}
