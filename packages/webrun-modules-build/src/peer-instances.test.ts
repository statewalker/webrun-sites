import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { PackageManifest, Source } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

type Version = {
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Two versions of `core`, one of everything else. A single-version package is
 *  loaded for any range; `core` only ever by exact version — every consumer here
 *  pins it — so no semver is needed. */
const REG: Record<string, Record<string, Version>> = {
  core: {
    "1.0.0": { files: { "index.js": `export const v = "core1";` } },
    "2.0.0": { files: { "index.js": `export const v = "core2";` } },
  },
  runtime: {
    "1.0.0": {
      peerDependencies: { core: "^1.0.0 || ^2.0.0" },
      files: { "index.js": `import { v } from "core";\nexport const which = v;` },
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
};

const source: Source = {
  matches: (ref) => "pkg" in ref && ref.pkg in REG,
  async load(ref) {
    if (!("pkg" in ref)) throw new Error("bad ref");
    const pkg = REG[ref.pkg];
    if (!pkg) throw new Error(`fixture has no package ${ref.pkg}`);
    const versions = Object.keys(pkg);
    const version = versions.length === 1 ? versions[0] : ref.version;
    const entry = version ? pkg[version] : undefined;
    if (!version || !entry) throw new Error(`fixture has no ${ref.pkg}@${ref.version}`);
    const { files: content, ...fields } = entry;
    const files = new MemFilesApi();
    for (const [path, text] of Object.entries(content)) await writeText(files, `/${path}`, text);
    return {
      name: ref.pkg,
      version,
      files,
      manifest: {
        name: ref.pkg,
        version,
        type: "module",
        main: "./index.js",
        ...fields,
      } as PackageManifest,
    };
  },
};

async function buildInto(cache: MemFilesApi) {
  const project = new MemFilesApi();
  await writeText(
    project,
    "/main.js",
    `import { which as a } from "alpha";\nimport { which as b } from "beta";\nexport const out = [a, b];`,
  );
  await newProjectBuild({ project, cache, sources: [source] }).build();
}

/** Every emitted `runtime` instance root → the `core` version its `~deps` binds. */
async function runtimeInstances(cache: MemFilesApi): Promise<Record<string, string>> {
  const roots = new Set<string>();
  for await (const info of cache.list("/", { recursive: true })) {
    const m = info.path.match(/^\/(runtime@1\.0\.0_p\.[0-9a-f]{16})\//);
    if (m?.[1]) roots.add(m[1]);
  }
  const out: Record<string, string> = {};
  for (const root of roots) {
    const proxy = await readText(cache, `/${root}/~deps/core/index.js`);
    out[root] = proxy.match(/core@([^/"]+)/)?.[1] ?? "(none)";
  }
  return out;
}

describe("batch build — peer-qualified instances", () => {
  it("emits one runtime tree per consumer's peer pin, each binding its own core", async () => {
    const cache = new MemFilesApi();
    await buildInto(cache);
    const instances = await runtimeInstances(cache);
    expect(Object.values(instances).sort()).toEqual(["1.0.0", "2.0.0"]);
    for (const root of Object.keys(instances)) {
      expect(await cache.exists(`/instances/${root}.json`)).toBe(true);
    }
  });

  it("rebuilds to the same instances from the persisted sidecars", async () => {
    const cache = new MemFilesApi();
    await buildInto(cache);
    const first = await runtimeInstances(cache);
    await buildInto(cache); // a fresh build context over the same cache
    expect(await runtimeInstances(cache)).toEqual(first);
  });
});
