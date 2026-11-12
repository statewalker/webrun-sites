import { type FileInfo, type FilesApi, joinPath, tryReadText } from "@statewalker/webrun-files";
import { canonicalJson } from "./canonical-json.js";
import type { BuildEngine } from "./engine.js";
import { makeProjectIgnore } from "./project-ignore.js";
import type { Json } from "./types.js";

/** The default source collection written by `scanSources`. */
export const SOURCES_COLLECTION = "sources";

export interface ScanSourcesOptions {
  files: FilesApi;
  /** Project root, relative to `files`. Row keys are paths relative to it. */
  root: string;
  /** Source collection to write (default `"sources"`). */
  collection?: string;
  /** Extra exclusion, OR-ed with `.projectignore` at the root. */
  ignore?: (uri: string) => boolean;
  /**
   * The row value for a file — what "changed" means. Default
   * `{ mtime, size }`; return a content hash to ignore touches.
   */
  fingerprint?: (info: FileInfo, uri: string) => Json | Promise<Json>;
  /**
   * Write at most this many new or changed files per scan (in path order); the rest are
   * reported as `deferred` and picked up by the next scan. Removals are always applied.
   * Scanning in batches (scan, run, repeat while `deferred > 0`) lets a large corpus flow
   * through the whole pipeline batch by batch, so downstream results appear early.
   */
  limit?: number;
}

export interface ScanResult {
  seen: number;
  changed: number;
  removed: number;
  /** Changed files left for a later scan (`limit`). */
  deferred: number;
}

/**
 * Mirror a file tree into a source collection: one row per file, keyed by its
 * project-relative path, valued by its fingerprint. Unchanged fingerprints
 * write nothing (the engine's early cut-off), so the source rows themselves are
 * the scanner's memory. Files that disappeared — or became ignored — are
 * removed, which retracts everything derived from them on the next `run()`.
 *
 * Skips every path with a dot-segment (`.git`, the engine's own state folder,
 * …) and anything matched by a gitignore-style `.projectignore` at the root.
 */
export async function scanSources(
  engine: BuildEngine,
  opts: ScanSourcesOptions,
): Promise<ScanResult> {
  const collection = opts.collection ?? SOURCES_COLLECTION;
  const base = opts.root.replace(/^\/+|\/+$/g, "");
  const projectIgnore = makeProjectIgnore(
    await tryReadText(opts.files, joinPath(opts.root, ".projectignore")),
  );
  const ignored = (uri: string) =>
    uri.split("/").some((seg) => seg.startsWith(".")) ||
    projectIgnore(uri) ||
    (opts.ignore?.(uri) ?? false);
  const fingerprint =
    opts.fingerprint ??
    ((info: FileInfo) => ({
      mtime: (info as { lastModified?: number }).lastModified ?? 0,
      size: (info as { size?: number }).size ?? 0,
    }));

  const seen = new Set<string>();
  const found: { uri: string; info: FileInfo }[] = [];
  for await (const info of opts.files.list(opts.root, { recursive: true })) {
    if (info.kind !== "file") continue;
    const uri = relative(info.path, base);
    if (uri === undefined || ignored(uri)) continue;
    seen.add(uri);
    found.push({ uri, info });
  }
  found.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let changed = 0;
  let deferred = 0;
  for (const { uri, info } of found) {
    const value = await fingerprint(info, uri);
    if (changed >= limit) {
      // Counted, not written: only files whose row would change.
      const stored = await engine.get(collection, uri);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(value)) deferred++;
      continue;
    }
    if (await engine.put(collection, uri, value)) changed++;
  }
  let removed = 0;
  for (const uri of await engine.keys(collection)) {
    if (!seen.has(uri) && (await engine.remove(collection, uri))) removed++;
  }
  return { seen: seen.size, changed, removed, deferred };
}

function relative(path: string, base: string): string | undefined {
  const p = path.replace(/^\/+/, "");
  if (base === "") return p;
  if (!p.startsWith(`${base}/`)) return undefined;
  return p.slice(base.length + 1);
}
