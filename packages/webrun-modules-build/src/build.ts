import { BuildEngine, FilesKV, SOURCES_COLLECTION, scanSources } from "@statewalker/webrun-builder";
import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";
import {
  type CssTransform,
  defaultGlobals,
  detectInputType,
  type EndpointResolver,
  type MissingFileHandler,
  type ModuleTarget,
  makeDefaultEndpointResolver,
  newDefaultCssTransform,
  newDefaultTransform,
  newDefaultTransformRegistry,
  newHostRegistry,
  normalizeDepsFolder,
  npmRegistrySource,
  type PreprocessContext,
  type Source,
  type Transform,
  type UrlPolicy,
} from "@statewalker/webrun-modules";
import { newTailwindTransform, tailwindCacheKey } from "@statewalker/webrun-tailwind";
import {
  PREPROCESS_BUILDER,
  SERVED_COLLECTION,
  toProjectId,
  walkEntry,
  webrunBuilders,
} from "./builders.js";
import type { WebrunBuildHost } from "./host.js";
import { makeExtMapPolicy } from "./url-policy.js";

/** Options for a batch project build. */
export interface ProjectBuildOptions {
  /** Raw project sources (`~/…`), scanned by the engine and read by the core. */
  project: FilesApi;
  /** Where emitted artifacts + the `/raw` cache + `/lock.json` are written. */
  cache: FilesApi;
  /** Build target (default `"browser"`). */
  target?: ModuleTarget;
  /** Package sources for external specifiers (default the npm registry source). */
  sources?: Source[];
  /** Override the JS/TS transform (default `newDefaultTransform()`); a test seam. */
  transform?: Transform;
  /** Override the CSS transform (default `newDefaultCssTransform()`); a test seam. */
  css?: CssTransform;
  /** Name of the per-module-root folder holding dependency proxies (default `"~deps"`). */
  depsFolder?: string;
  /** Escape hatch for a module file that does not exist: supply its source rather
   *  than fail the build (see `ModuleServerOptions.onMissingFile`). Absent by
   *  default, so a missing file fails the build, never emits an empty module. */
  onMissingFile?: MissingFileHandler;
}

/** A prepared batch build over a project. */
export interface ProjectBuild {
  /** Scan the project and run the pipeline to convergence; returns the emitted entry pointers. */
  build(): Promise<{ served: string[] }>;
  /**
   * Remove every file under a `~deps` folder of the cache (proxies and their
   * sidecars) that the entry points cannot reach. A separate operation, not part
   * of `build()`: the build adds and rewrites proxies but never removes one whose
   * last importer went away.
   *
   * `entries` are project-relative source paths (`src/main.ts`). Without them,
   * the public entry points of the project's `package.json` are used: `main`,
   * `module`, a string `browser`, and every string target of `exports` (patterns
   * with `*` are skipped). Throws, removing nothing, when there is no entry point
   * or one is not a project file. Walking the entries emits whatever they reach
   * that is out of date, as a build would. Returns the entries used and the
   * removed cache paths.
   */
  prune(options?: { entries?: string[] }): Promise<{ entries: string[]; removed: string[] }>;
}

/** The sidecars written beside an emitted artifact; pruned with it. */
const SIDECARS = [".shape.json", ".exports.json", ".hash"];

/** `./src/x.ts` → `src/x.ts`. */
function normalizeEntry(path: string): string {
  return path.replace(/^\.?\/+/, "");
}

/** The public entry points `package.json` declares, as project-relative paths. */
export function packageEntryPoints(manifest: Record<string, unknown>): string[] {
  const out = new Set<string>();
  // Type declarations are not modules: a `types` condition or a `.d.ts` target
  // is skipped, never walked.
  const add = (v: unknown) => {
    if (typeof v === "string" && !v.includes("*") && !/\.d\.[cm]?ts$/.test(v))
      out.add(normalizeEntry(v));
  };
  const walk = (v: unknown) => {
    if (typeof v === "string") add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [condition, target] of Object.entries(v)) if (condition !== "types") walk(target);
    }
  };
  add(manifest.main);
  add(manifest.module);
  add(manifest.browser); // an object `browser` is a substitution map, not an entry
  walk(manifest.exports);
  return [...out];
}

/** FNV-1a (32-bit) content hash — a dependency-free digest for the per-id source
 *  sidecar that gates re-emit. Collision risk is negligible for change detection. */
function hashSource(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Assemble the batch module builder: the shared `PreprocessContext` (ext-map policy,
 * explicit `HostRegistry`, in-flight dedupe, target-derived globals) + a
 * `BuildEngine` whose state lives in `project/.project/state` (a `FilesKV`) +
 * the preprocess builder. Each `build()` scans the project into the `sources`
 * collection and runs the engine; emitted artifacts go to `cache`.
 */
export function newProjectBuild(opts: ProjectBuildOptions): ProjectBuild {
  const { project, cache } = opts;
  // The scanner re-ingests `~`-prefixed emitted ids; if project and cache were the
  // same FilesApi the emitted tree would feed back as sources. Keep them disjoint.
  if (project === cache) {
    throw new Error("newProjectBuild: `project` and `cache` must be distinct FilesApi instances");
  }
  const target = opts.target ?? "browser";

  const ctx: PreprocessContext = {
    files: project,
    cache,
    target,
    basePath: "/",
    depsPath: "",
    depsFolder: normalizeDepsFolder(opts.depsFolder ?? "~deps"),
    tRoot: `/t/${target}`,
    lock: {},
    sources: opts.sources ?? [npmRegistrySource()],
    transform: opts.transform ?? newDefaultTransform(target === "browser"),
    css: opts.css ?? newDefaultCssTransform(),
    registry: newHostRegistry(),
    globals: defaultGlobals(target),
    inflight: new Map(),
    proxies: new Map(),
    transforms: newDefaultTransformRegistry(),
    policy: undefined as unknown as UrlPolicy,
    resolveEndpoint: undefined as unknown as EndpointResolver,
    onMissingFile: opts.onMissingFile,
  };
  ctx.policy = makeExtMapPolicy(ctx);
  ctx.resolveEndpoint = makeDefaultEndpointResolver(ctx);
  // BUILD-ONLY: register the Tailwind transform for `tailwind-css` inputs. The
  // request-time server never registers it, so `tailwind-css` falls back to the
  // plain `css` transform there — server behaviour is unchanged.
  ctx.transforms?.register(newTailwindTransform());

  const emitted = new Set<string>();
  // The opt-in incremental gate consulted by `walkFrom` for EVERY closure node
  // (entry + interior + shared): reuse the emitted artifact when the source is
  // byte-identical to the hash sidecar recorded beside it and the artifact still
  // exists; otherwise record the fresh hash and let the transform re-run. This is
  // the sole gate now — the per-entry builder gate is folded in here so all nodes are
  // gated uniformly (a diamond's shared node transforms once, not once per path).
  ctx.skipTransform = async (id, source) => {
    const path = ctx.policy.emittedPath(id);
    // A Tailwind input is generated generically (independent of the project
    // markup), so fold the pinned Tailwind version into the gate key: a version
    // bump re-generates even with byte-identical entry, while unchanged inputs stay
    // cached. Every other input keys on its source bytes alone (unchanged).
    const effective =
      detectInputType(id, source) === "tailwind-css"
        ? `${tailwindCacheKey(source)}\n${source}`
        : source;
    const hash = hashSource(effective);
    const prev = await tryReadText(cache, `${path}.hash`);
    if (prev === hash && (await cache.exists(path))) return true;
    await writeText(cache, `${path}.hash`, hash);
    emitted.add(id);
    return false;
  };
  const host: WebrunBuildHost = { project, cache, ctx, emitted };
  // Engine state (rows, queue, traces) lives in the project's `.project/state`
  // folder — a dot-folder, so the scanner never sees it.
  let engine: BuildEngine | undefined;
  const openEngine = async () =>
    (engine ??= new BuildEngine({
      store: await FilesKV.open(project, "/.project/state"),
      builders: webrunBuilders(host),
    }));

  return {
    async build() {
      const engine = await openEngine();
      await scanSources(engine, { files: project, root: "/" });
      // Retry what failed last time: a source's closure reads files the engine
      // does not track (its dependencies), so fixing one would not re-queue it.
      for (const d of await engine.deadLetters()) await engine.requeue(d.builder, d.key);
      await engine.run();
      const failed = await engine.deadLetters();
      if (failed.length > 0) {
        const [first] = failed;
        throw new Error(
          `newProjectBuild: ${failed.length} source(s) failed to build; first: ${first?.key}: ${first?.error}`,
        );
      }
      return { served: await engine.keys(SERVED_COLLECTION) };
    },

    async prune(options = {}) {
      let entries = options.entries?.map(normalizeEntry);
      if (!entries) {
        const text = await tryReadText(project, "/package.json");
        entries = text ? packageEntryPoints(JSON.parse(text)) : [];
      }
      if (entries.length === 0) {
        throw new Error(
          "prune: no entry points: pass `entries`, or declare `main` or `exports` in the project's package.json",
        );
      }
      for (const entry of entries) {
        if ((await project.stats(`/${entry}`))?.kind !== "file") {
          throw new Error(`prune: entry point ${JSON.stringify(entry)} is not a project file`);
        }
      }
      const reached = new Set<string>();
      const reachedIds = new Set<string>();
      for (const entry of entries) {
        for (const id of await walkEntry(toProjectId(entry), host)) {
          reachedIds.add(id);
          reached.add(ctx.policy.emittedPath(id));
        }
      }
      const segment = `/${ctx.depsFolder}/`;
      const removed: string[] = [];
      for await (const info of cache.list("/", { recursive: true })) {
        if (info.kind !== "file" || info.path.startsWith("/raw/")) continue;
        const suffix = SIDECARS.find((s) => info.path.endsWith(s));
        const artifact = suffix ? info.path.slice(0, -suffix.length) : info.path;
        if (!artifact.includes(segment) || reached.has(artifact)) continue;
        removed.push(info.path);
      }
      for (const path of removed) await cache.remove(path);
      // A source outside the closure may import a proxy just removed. Queue every
      // such source, so the next build re-walks it and re-emits what it imports
      // instead of skipping it as unchanged and leaving a broken import behind.
      if (removed.length > 0) {
        const engine = await openEngine();
        for (const key of await engine.keys(SOURCES_COLLECTION)) {
          if (!reachedIds.has(toProjectId(key))) await engine.requeue(PREPROCESS_BUILDER, key);
        }
      }
      // Forget the pruned proxies' accumulated shapes, so a later build in this
      // process starts them afresh, as a new process would.
      for (const id of [...ctx.proxies.keys()]) {
        if (!reached.has(ctx.policy.emittedPath(id))) ctx.proxies.delete(id);
      }
      return { entries, removed: removed.sort() };
    },
  };
}
