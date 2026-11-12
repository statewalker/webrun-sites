import { type CellDef, SOURCES_SIGNAL } from "@statewalker/webrun-builder";
import { urlPath, walkFrom } from "@statewalker/webrun-modules";
import { emitBuildForms, isAsset } from "./emit-forms.js";
import type { WebrunBuildHost } from "./host.js";

export const PREPROCESS_CELL = "Preprocess";
/** Signal of emitted entry pointers: key = emitted path, value = source uri. */
export const SERVED_SIGNAL = "served";

/** Sources the transform builds as entries: JS/TS modules, CSS and JSON. */
const ENTRY = /\.(?:(?:m|c)?[jt]sx?|css|json)$/;

/** Map a scanned project-relative source uri (`src/main.tsx`) to its core id
 *  (`~/src/main.tsx`) — the `~/` id-space the preprocess core reads project files in. */
function toProjectId(uri: string): string {
  return `~/${uri}`;
}

/**
 * The batch build's cells over the `webrun-builder` engine. One map cell per
 * source file:
 *
 *   sources (scanned) → [Preprocess] → served
 *
 * - `run` walks an entry's transitive closure (entry + project deps → `.js`;
 *   `~deps` proxies and npm endpoints as side effects into `host.cache`) and
 *   emits the entry's `served` pointer. Non-entry sources emit nothing. The
 *   per-id content-hash gate (`ctx.skipTransform`) re-transforms only changed
 *   nodes.
 * - `dispose` runs when a source disappears (or becomes ignored): it prunes the
 *   emitted artifact and its sidecars. The engine retracts the `served` row.
 */
export function webrunCells(host: WebrunBuildHost): CellDef[] {
  return [
    {
      id: PREPROCESS_CELL,
      inputs: [SOURCES_SIGNAL],
      outputs: [SERVED_SIGNAL],
      async run(ctx) {
        if (!ENTRY.test(ctx.key)) return;
        const id = toProjectId(ctx.key);
        host.emitted.clear();
        const ids = await walkFrom(id, host.ctx);
        // Static emit forms: JSON is idempotent (re-derived from raw source), so
        // always (re)form it; a CSS injector is re-wrapped ONLY for a freshly
        // emitted node — the raw stylesheet `walkFrom` overwrites `emitted` with
        // is only present when the transform actually ran (else it's already the
        // wrapped `.js`, which must not be double-wrapped).
        await emitBuildForms(
          ids.filter((x) => x.endsWith(".json") || isAsset(x) || host.emitted.has(x)),
          host.ctx,
        );
        ctx.emit(SERVED_SIGNAL, host.ctx.policy.emittedPath(id), ctx.key);
      },
      async dispose(key) {
        const id = toProjectId(key);
        const emitted = host.ctx.policy.emittedPath(id);
        // Prune the emitted artifact and its sidecars (source-hash gate, the CSS
        // class-map, and the accumulated proxy shape), plus the raw `.css` emit
        // (`/${urlPath(id)}`, which differs from `emitted` only for a `.css`
        // source), so a removed source leaves no orphan behind. (A removed asset's
        // own bytes are `emitted` already.) `.shape.json` is listed so a proxy's
        // durable shape can never outlive the artifact it describes — this is the
        // one place an emitted artifact is ever removed.
        for (const path of [
          emitted,
          `${emitted}.hash`,
          `${emitted}.exports.json`,
          `${emitted}.shape.json`,
          `/${urlPath(id, host.ctx)}`,
        ]) {
          if (await host.cache.exists(path)) await host.cache.remove(path);
        }
      },
    },
  ];
}
