import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_REGISTRY_KEY, newHostRegistry } from "../src/deps/host-registry.js";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { ModuleServer, ModuleServerOptions } from "../src/types.js";
import { type FixtureRegistry, registrySource } from "./_packages.js";

// `newModuleServer` wires `ctx.registry` from `globalHostRegistry()`, a deliberate
// realm-global singleton (see `host-registry.test.ts`) so served host-proxies and
// `providedNames` read the same object a live `provided:` registry becomes. That
// singleton otherwise leaks across `it` blocks in this file: the one test below
// that passes a live `provided:` registry containing `core` would silently make
// every later test's `core` (a real fixture package here, not host-provided) look
// host-provided too. Reset it after each test so only that one test sees it.
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOST_REGISTRY_KEY];
});

/**
 * `runtime` needs a `core` its consumer supplies; `alpha` and `beta` supply
 * different ones. This is the shape of oxc-resolver and @rolldown/browser both
 * reaching @napi-rs/wasm-runtime with different @emnapi/core pins.
 */
const REG: FixtureRegistry = {
  core: {
    "1.0.0": { files: { "index.js": `export const v = "core1";` } },
    "2.0.0": { files: { "index.js": `export const v = "core2";` } },
  },
  extra: { "1.0.0": { files: { "index.js": `export const e = 1;` } } },
  runtime: {
    "1.0.0": {
      peerDependencies: { core: "^1.0.0 || ^2.0.0" },
      files: { "index.js": `import { v } from "core";\nexport const which = v;` },
    },
  },
  strict: {
    "1.0.0": {
      peerDependencies: { core: "^2.0.0" },
      files: { "index.js": `import { v } from "core";\nexport const which = v;` },
    },
  },
  opt: {
    "1.0.0": {
      peerDependencies: { core: "*", extra: "^1.0.0" },
      peerDependenciesMeta: { extra: { optional: true } },
      files: { "index.js": `import { v } from "core";\nexport const which = v;` },
    },
  },
  wrapper: {
    "1.0.0": {
      peerDependencies: { core: "*" },
      dependencies: { runtime: "^1.0.0" },
      files: { "index.js": `export { which } from "runtime";` },
    },
  },
  alpha: {
    "1.0.0": {
      dependencies: { runtime: "^1.0.0", core: "1.0.0" },
      files: { "index.js": `export { which } from "runtime";` },
    },
  },
  beta: {
    "1.0.0": {
      dependencies: { runtime: "^1.0.0", core: "2.0.0" },
      files: { "index.js": `export { which } from "runtime";` },
    },
  },
  gamma: {
    "1.0.0": {
      dependencies: { runtime: "^1.0.0" },
      files: { "index.js": `export { which } from "runtime";` },
    },
  },
  legacy: {
    "1.0.0": {
      dependencies: { strict: "^1.0.0", core: "1.0.0" },
      files: { "index.js": `export { which } from "strict";` },
    },
  },
  usesOpt: {
    "1.0.0": {
      dependencies: { opt: "^1.0.0", core: "1.0.0" },
      files: { "index.js": `export { which } from "opt";` },
    },
  },
  app: {
    "1.0.0": {
      dependencies: { wrapper: "^1.0.0", core: "1.0.0" },
      files: { "index.js": `export { which } from "wrapper";` },
    },
  },
};

const TAGGED = (name: string) => new RegExp(`^${name}@1\\.0\\.0_p\\.[0-9a-f]{16}$`);

function server(opts: Partial<ModuleServerOptions> = {}) {
  const cache = opts.cache ?? new MemFilesApi();
  return newModuleServer({ cache, sources: [registrySource(REG)], ...opts });
}

const get = async (s: ModuleServer, path: string) =>
  (await s.fetch(new Request(`http://x${path}`))).text();

/** Transform `consumer`'s entry, then read which module root its `~deps/<dep>` proxy names. */
async function rootVia(s: ModuleServer, consumer: string, dep: string): Promise<string> {
  await get(s, `/${consumer}/index.js`);
  const proxy = await get(s, `/${consumer}/~deps/${dep}/index.js`);
  const found = proxy.match(new RegExp(`${dep}@[^/"]+`))?.[0];
  if (!found) throw new Error(`no ${dep} root in ${JSON.stringify(proxy)}`);
  return found;
}

/** Transform `root`'s entry, then read the version its `~deps/<peer>` proxy binds. */
async function peerVia(s: ModuleServer, root: string, peer: string): Promise<string> {
  await get(s, `/${root}/index.js`);
  const proxy = await get(s, `/${root}/~deps/${peer}/index.js`);
  return proxy.match(new RegExp(`${peer}@([^/"]+)`))?.[1] ?? "(none)";
}

describe("peer-qualified instances", () => {
  it("serves two consumers' different peer pins as two instances, each binding its own", async () => {
    const s = server();
    const a = await rootVia(s, "alpha@1.0.0", "runtime");
    const b = await rootVia(s, "beta@1.0.0", "runtime");
    expect(a).toMatch(TAGGED("runtime"));
    expect(b).toMatch(TAGGED("runtime"));
    expect(a).not.toBe(b);
    expect(await peerVia(s, a, "core")).toBe("1.0.0");
    expect(await peerVia(s, b, "core")).toBe("2.0.0");
  });

  it("names the same instances whichever consumer is linked first", async () => {
    const s1 = server();
    const a1 = await rootVia(s1, "alpha@1.0.0", "runtime");
    const b1 = await rootVia(s1, "beta@1.0.0", "runtime");
    const s2 = server();
    const b2 = await rootVia(s2, "beta@1.0.0", "runtime");
    const a2 = await rootVia(s2, "alpha@1.0.0", "runtime");
    expect(a1).not.toBe(b1); // without this, two untagged roots would "match" vacuously
    expect([a2, b2]).toEqual([a1, b1]);
  });

  it("falls back to the target's own peer range when the consumer declares nothing", async () => {
    const s = server();
    const g = await rootVia(s, "gamma@1.0.0", "runtime");
    expect(g).toMatch(TAGGED("runtime"));
    expect(await peerVia(s, g, "core")).toBe("2.0.0"); // highest match of ^1 || ^2
  });

  it("lets the consumer's declaration win even outside the target's peer range", async () => {
    const s = server();
    const root = await rootVia(s, "legacy@1.0.0", "strict");
    expect(await peerVia(s, root, "core")).toBe("1.0.0"); // strict asks ^2, legacy supplies 1.0.0
  });

  it("propagates a pin through a package that is itself an instance", async () => {
    const s = server();
    const wrapper = await rootVia(s, "app@1.0.0", "wrapper");
    expect(wrapper).toMatch(TAGGED("wrapper"));
    const runtime = await rootVia(s, wrapper, "runtime");
    expect(await peerVia(s, runtime, "core")).toBe("1.0.0");
    // Same pins, same tag: the runtime alpha reaches directly is the same instance.
    expect(runtime).toBe(await rootVia(s, "alpha@1.0.0", "runtime"));
  });

  it("leaves a host-provided peer out of the tag", async () => {
    const s = server({ provided: newHostRegistry({ core: { v: "host" } }) });
    expect(await rootVia(s, "alpha@1.0.0", "runtime")).toBe("runtime@1.0.0");
  });

  it("does not pin, or download, an optional peer the consumer does not declare", async () => {
    const loads: Record<string, number> = {};
    const cache = new MemFilesApi();
    const s = newModuleServer({ cache, sources: [registrySource(REG, loads)] });
    const root = await rootVia(s, "usesOpt@1.0.0", "opt");
    expect(root).toMatch(TAGGED("opt"));
    expect(JSON.parse(await readText(cache, `/instances/${root}.json`))).toEqual({ core: "1.0.0" });
    expect(loads.extra ?? 0).toBe(0);
  });

  it("keeps a package without peers on its plain root", async () => {
    const s = server();
    const a = await rootVia(s, "alpha@1.0.0", "runtime");
    await get(s, `/${a}/index.js`);
    const proxy = await get(s, `/${a}/~deps/core/index.js`);
    expect(proxy).toMatch(/core@1\.0\.0\/index\.js/);
    expect(proxy).not.toContain("_p.");
  });

  it("persists pins before the instance is reachable, so a restart binds the same peer", async () => {
    const cache = new MemFilesApi();
    const s1 = newModuleServer({ cache, sources: [registrySource(REG)] });
    const a = await rootVia(s1, "alpha@1.0.0", "runtime");
    expect(JSON.parse(await readText(cache, `/instances/${a}.json`))).toEqual({ core: "1.0.0" });
    // Evict the instance's transformed files, as a partially warm cache would.
    await cache.remove(`/t/browser/${a}`);
    const s2 = newModuleServer({ cache, sources: [registrySource(REG)] });
    expect(await peerVia(s2, a, "core")).toBe("1.0.0");
  });
});
