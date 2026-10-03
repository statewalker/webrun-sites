import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesSource } from "./types.js";

/**
 * Accept a `FilesApi` or a plain `{path → content}` record. Records get
 * wrapped in a fresh `MemFilesApi`; FilesApi instances pass through.
 */
export async function resolveFilesSource(source: FilesSource): Promise<FilesApi> {
  if (isFilesApi(source)) return source;
  const files = new MemFilesApi();
  for (const [path, content] of Object.entries(source)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await files.write(path, [bytes]);
  }
  return files;
}

/**
 * Duck-type check: anything with callable `read` + `write` qualifies as a
 * `FilesApi`. A plain record has string/Uint8Array values, not functions,
 * so this cleanly distinguishes the two without relying on `instanceof`.
 */
function isFilesApi(source: FilesSource): source is FilesApi {
  if (source === null || typeof source !== "object") return false;
  const candidate = source as Partial<FilesApi>;
  return typeof candidate.read === "function" && typeof candidate.write === "function";
}
