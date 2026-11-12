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
   * Write at most this many new or changed files per scan (a positive integer). The scan
   * stops looking at the first change beyond the limit and reports `more: true`; removals
   * are always applied. Scanning in batches — scan, run, repeat with `after: result.cursor`
   * while `more` — lets a large corpus flow through the whole pipeline batch by batch, so
   * downstream results appear early.
   */
  limit?: number;
  /**
   * Resume after this path (the previous result's `cursor`): files after it are considered
   * first, then the scan wraps around to the start. Rotating the start this way keeps a file
   * that changes on every scan from taking the batch again and again.
   */
  after?: string;
}

export interface ScanResult {
  seen: number;
  changed: number;
  removed: number;
  /** With `limit`: more changed files remain for a later scan. */
  more: boolean;
  /** With `limit`: the last path written — pass it as `after` to the next scan. */
  cursor?: string;
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
  if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit >= 1)) {
    throw new RangeError(`scanSources: limit must be a positive integer, got ${opts.limit}`);
  }
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
  // Rotate: the files after `after` first, then from the start.
  const after = opts.after;
  const order =
    after === undefined
      ? found
      : [...found.filter((f) => f.uri > after), ...found.filter((f) => f.uri <= after)];
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let changed = 0;
  let more = false;
  let cursor: string | undefined;
  for (const { uri, info } of order) {
    const value = await fingerprint(info, uri);
    if (changed >= limit) {
      // Over the limit: stop at the first file whose row would change.
      const stored = await engine.get(collection, uri);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(value)) {
        more = true;
        break;
      }
      continue;
    }
    if (await engine.put(collection, uri, value)) {
      changed++;
      cursor = uri;
    }
  }
  let removed = 0;
  for (const uri of await engine.keys(collection)) {
    if (!seen.has(uri) && (await engine.remove(collection, uri))) removed++;
  }
  const withCursor = opts.limit !== undefined && cursor !== undefined;
  return { seen: seen.size, changed, removed, more, ...(withCursor ? { cursor } : {}) };
}

function relative(path: string, base: string): string | undefined {
  const p = path.replace(/^\/+/, "");
  if (base === "") return p;
  if (!p.startsWith(`${base}/`)) return undefined;
  return p.slice(base.length + 1);
}
