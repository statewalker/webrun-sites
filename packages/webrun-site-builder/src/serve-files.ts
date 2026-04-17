import type { FilesApi, ReadOptions } from "@statewalker/webrun-files";
import { getMimeType } from "./mime.js";

export interface ServeFilesOptions {
  /** Custom extension → Content-Type resolver. Defaults to {@link getMimeType}. */
  getMimeType?: (path: string) => string;
  /** File served when the target path resolves to a directory. Defaults to `"index.html"`. */
  directoryIndex?: string;
}

/**
 * Build a `(Request, path) ⇒ Response` function that serves `path` from
 * `filesApi`. Handles `GET` / `HEAD`, sets `Content-Type` / `Content-Length`,
 * honours `Range: bytes=<start>-<end>` for partial content, and falls back
 * to a directory index when a path resolves to a folder.
 */
export function newServeFiles(
  filesApi: FilesApi,
  { getMimeType: resolveMime = getMimeType, directoryIndex = "index.html" }: ServeFilesOptions = {},
): (request: Request, path: string) => Promise<Response> {
  return async (request: Request, path: string): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const resolved = await resolvePath(filesApi, path, directoryIndex);
    if (!resolved) return new Response("Not Found", { status: 404 });
    const { path: filePath, size } = resolved;

    const range = parseRangeHeader(request.headers.get("Range"), size);
    const contentType = resolveMime(filePath);

    if (range === "invalid") {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...(size !== undefined ? { "Content-Range": `bytes */${size}` } : {}),
        },
      });
    }

    const headers: Record<string, string> = { "Content-Type": contentType };
    let status = 200;
    let readOpts: ReadOptions | undefined;

    if (range) {
      status = 206;
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size ?? "*"}`;
      headers["Content-Length"] = String(range.end - range.start + 1);
      readOpts = { start: range.start, length: range.end - range.start + 1 };
    } else if (size !== undefined) {
      headers["Content-Length"] = String(size);
    }
    if (size !== undefined) headers["Accept-Ranges"] = "bytes";

    if (method === "HEAD") return new Response(null, { status, headers });

    const body = asReadableStream(filesApi.read(filePath, readOpts));
    return new Response(body, { status, headers });
  };
}

async function resolvePath(
  filesApi: FilesApi,
  path: string,
  directoryIndex: string,
): Promise<{ path: string; size: number | undefined } | null> {
  const stats = await filesApi.stats(path);
  if (!stats) return null;
  if (stats.kind === "file") return { path, size: stats.size };
  // Directory → fall back to index file.
  const indexPath = path.endsWith("/") ? `${path}${directoryIndex}` : `${path}/${directoryIndex}`;
  const indexStats = await filesApi.stats(indexPath);
  if (indexStats?.kind === "file") return { path: indexPath, size: indexStats.size };
  return null;
}

/**
 * Parse a `Range: bytes=<start>-<end>` header. Returns:
 * - `null` when the header is absent or the size is unknown (no range support);
 * - `"invalid"` when the header is malformed or out of bounds;
 * - `{ start, end }` for a valid single-range request.
 *
 * Only single ranges are supported — multi-range (`bytes=0-100,200-300`) is
 * treated as invalid. Covers the 99% case (video/audio seeking).
 */
function parseRangeHeader(
  header: string | null,
  size: number | undefined,
): { start: number; end: number } | "invalid" | null {
  if (!header || size === undefined) return null;
  if (!header.startsWith("bytes=")) return "invalid";
  const spec = header.substring("bytes=".length).trim();
  if (spec.includes(",")) return "invalid";
  const dash = spec.indexOf("-");
  if (dash < 0) return "invalid";
  const startRaw = spec.substring(0, dash);
  const endRaw = spec.substring(dash + 1);
  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix range: "-500" = last 500 bytes.
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    if (!Number.isFinite(start) || start < 0) return "invalid";
    if (endRaw === "") end = size - 1;
    else {
      end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(end)) return "invalid";
    }
  }
  if (start > end || start >= size) return "invalid";
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Adapt `AsyncIterable<Uint8Array>` → `ReadableStream<Uint8Array>` so it
 * can be used as the body of a `Response`.
 */
function asReadableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
