/**
 * PROTOTYPE — throwaway. Runs real WASM packages through an in-process
 * webrun-modules server in a real Chromium, from a cross-origin-isolated page.
 */
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import semver from "semver";
import { corsHeaders, newModuleServer, npmRegistrySource } from "../../src/index.js";
import type { Lockfile } from "../../src/types.js";

const PLAYWRIGHT =
  process.env.PLAYWRIGHT_MODULE ??
  "/home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

/** One warm `/raw` cache shared by every run, so npm is hit once per package. */
const RAW_TEMPLATE = join(tmpdir(), "PROTOTYPE-peer-instances-raw-cache");

export const ENTRIES = {
  oxc: "/oxc-resolver@11.24.2/browser.js",
  rolldown: "/@rolldown/browser@1.2.8/dist/index.browser.mjs",
} as const;
export type Pkg = keyof typeof ENTRIES;

/** A fresh cache dir seeded with the shared raw template (never `/t` or the lock). */
async function freshCache(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "PROTOTYPE-peer-instances-"));
  try {
    for (const e of await readdir(join(RAW_TEMPLATE, "raw"))) {
      await cp(join(RAW_TEMPLATE, "raw", e), join(dir, "raw", e), { recursive: true });
    }
  } catch {
    /* first run — template empty */
  }
  return dir;
}

async function saveRawTemplate(dir: string): Promise<void> {
  await cp(join(dir, "raw"), join(RAW_TEMPLATE, "raw"), { recursive: true, force: false }).catch(
    () => {},
  );
}

const ISOLATED_PAGE = `<!doctype html><meta charset="utf-8"><title>proto</title><p>proto</p>`;

/** Start a server on an ephemeral port; `/` is a cross-origin isolated document. */
export async function startServer(opts: {
  lock?: Lockfile;
  /** Default true. `false` reproduces the blocked-worker failure. */
  workerCoep?: boolean;
  /** Free-global overrides, passed straight to the server's `globals` option. */
  globals?: Record<string, string>;
  /** Reuse an existing cache dir (a server RESTART) instead of a fresh one. */
  cacheDir?: string;
  makeServer?: typeof newModuleServer;
}): Promise<{ base: string; close: () => Promise<void>; cacheDir: string }> {
  const cacheDir = opts.cacheDir ?? (await freshCache());
  const make = opts.makeServer ?? newModuleServer;
  const server = make({
    cache: new NodeFilesApi({ rootDir: cacheDir }),
    sources: [npmRegistrySource()],
    target: "browser",
    cors: true,
    lock: opts.lock,
    globals: opts.globals,
  });
  const CORS = corsHeaders(true);
  const http: Server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    // A worker spawned from an isolated page must have COEP on its OWN script
    // response, or Chrome blocks it (net::ERR_BLOCKED_BY_RESPONSE). Any JS file can
    // be a worker script, so every response carries it.
    if (opts.workerCoep !== false) res.setHeader("cross-origin-embedder-policy", "require-corp");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.setHeader("cross-origin-opener-policy", "same-origin");
      res.setHeader("cross-origin-embedder-policy", "require-corp");
      res.end(ISOLATED_PAGE);
      return;
    }
    try {
      const r = await server.fetch(new Request(url, { method: req.method }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((ok) => http.listen(0, ok));
  const base = `http://localhost:${(http.address() as AddressInfo).port}`;
  return {
    base,
    cacheDir,
    close: async () => {
      await new Promise<void>((ok) => http.close(() => ok()));
      await saveRawTemplate(cacheDir);
    },
  };
}

/** In-page exercises: a REAL call into each WASM binding, not just an import. */
const EXERCISES: Record<Pkg, string> = {
  oxc: `async (base, entry) => {
    const m = await import(base + entry);
    const r = new m.ResolverFactory({}).sync("/", "./nowhere");
    return "resolver ran → " + JSON.stringify(r).slice(0, 60);
  }`,
  rolldown: `async (base, entry) => {
    const { rolldown } = await import(base + entry);
    const bundle = await rolldown({
      input: "entry",
      plugins: [{ name: "v",
        resolveId: (id) => (id === "entry" ? id : null),
        load: (id) => (id === "entry" ? "export const x = 40 + 2;" : null) }],
    });
    const { output } = await bundle.generate({ format: "esm" });
    return "bundled → " + JSON.stringify(output[0].code.trim().split("\\n").slice(-2).join(" "));
  }`,
};

export interface RunResult {
  pkg: Pkg;
  ok: boolean;
  detail: string;
}

/** Load `order` into ONE page, one after another, reporting each. */
export async function runInBrowser(base: string, order: Pkg[]): Promise<RunResult[]> {
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const isolated = await page.evaluate(() => self.crossOriginIsolated);
    if (!isolated) throw new Error("page is not cross-origin isolated");
    const out: RunResult[] = [];
    for (const pkg of order) {
      const r = await page.evaluate(
        async ([fnSrc, b, e]: [string, string, string]) => {
          const fn = (0, eval)(`(${fnSrc})`);
          try {
            const detail = await Promise.race([
              fn(b, e),
              new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT 60s")), 60_000)),
            ]);
            return { ok: true, detail: String(detail) };
          } catch (err) {
            const e2 = err as Error;
            return { ok: false, detail: `${e2.name}: ${String(e2.message).split("\n")[0]}` };
          }
        },
        [EXERCISES[pkg], base, ENTRIES[pkg]] as [string, string, string],
      );
      out.push({ pkg, ...r });
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Every `@emnapi/*` and wasm-runtime module root reachable from `entry`, as served. */
export async function servedRoots(base: string, entry: string): Promise<string[]> {
  const r = await fetch(`${base}${entry}?graph`).catch(() => undefined);
  if (!r?.ok) {
    // `?graph` is an example-server route; ask the module server's own listing.
    return [];
  }
  const urls: string[] = await r.json();
  return [...new Set(urls.map((u) => u.match(/(@emnapi\/[a-z]+|@napi-rs\/wasm-runtime)@[^/]+/)?.[0]))]
    .filter((x): x is string => !!x)
    .sort((a, b) => a.localeCompare(b) || semver.compare("0.0.0", "0.0.0"));
}

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const X = "\x1b[0m";
export function report(title: string, results: RunResult[], extra: string[] = []): void {
  console.log(`\n${B}${title}${X}`);
  for (const l of extra) console.log(`  ${D}${l}${X}`);
  for (const r of results) {
    console.log(`  ${r.ok ? `${G}PASS${X}` : `${R}FAIL${X}`}  ${B}${r.pkg.padEnd(9)}${X} ${r.detail}`);
  }
}

/** Surface the state: for every served module root, which emnapi its `~deps` proxy binds to. */
export async function emnapiBindings(cacheDir: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const { glob } = await import("node:fs/promises");
  const out: string[] = [];
  for await (const f of glob("t/**/~deps/@emnapi/core/index.js", { cwd: cacheDir })) {
    const body = await readFile(join(cacheDir, f), "utf8");
    const root = f.replace(/^t\/[^/]+\//, "").replace(/\/~deps\/.*$/, "");
    const to = body.match(/@emnapi\/core@[^/"]+/)?.[0] ?? "?";
    out.push(`${root}  →  ${to}`);
  }
  return out.sort();
}

/** A `process` that also answers `cwd()` — rolldown calls it to default its cwd. */
export const PROCESS_WITH_CWD = {
  process: `globalThis.process ?? { env: { NODE_ENV: "production" }, cwd: () => "/", platform: "browser" }`,
};
