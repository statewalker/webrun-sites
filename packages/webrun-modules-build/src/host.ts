import type { FilesApi } from "@statewalker/webrun-files";
import type { PreprocessContext } from "@statewalker/webrun-modules";

/**
 * What the build cells work with: the two FilesApis (raw project sources vs.
 * the emitted-artifact cache) and the shared `PreprocessContext` they drive the
 * module core through.
 */
export interface WebrunBuildHost {
  project: FilesApi;
  cache: FilesApi;
  ctx: PreprocessContext;
  /** Ids the `ctx.skipTransform` gate freshly (re)emitted during the current
   *  `walkFrom` — cleared before each walk, read after to drive the static CSS
   *  emit forms only for nodes that actually changed (avoids re-wrapping). */
  emitted: Set<string>;
}
