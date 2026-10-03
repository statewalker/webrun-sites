/**
 * Hardcoded extension → Content-Type map. Covers the common static-site
 * bundle: HTML, CSS, JS, JSON, fonts, images, video/audio.
 *
 * The map is intentionally small — if you need more, compose a custom
 * `getMimeType` function and pass it to `serveFiles`.
 */
const MIME_TYPES: Record<string, string> = {
  // Text / markup
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  // Video / audio
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  // Misc
  pdf: "application/pdf",
  wasm: "application/wasm",
  zip: "application/zip",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Return the Content-Type for a path based on its extension. Paths without
 * an extension (or with an unknown one) get `application/octet-stream`.
 */
export function getMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return DEFAULT_MIME_TYPE;
  const ext = path.substring(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? DEFAULT_MIME_TYPE;
}
