import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { PackageManifest, Source } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "../src/index.js";

/**
 * statewalker/webrun-sites#2: `prune()` removes every `~deps` file its entry
 * points cannot reach. The entry points are the ones passed in, or else the
 * public ones the project's `package.json` declares (`main`, `exports`, …).
 */
function memSource(pkgs: Record<string, Record<string, string>>): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const files = new MemFilesApi();
      for (const [path, text] of Object.entries(pkgs[ref.pkg] ?? {})) {
        await writeText(files, `/${path}`, text);
      }
      const deps = Object.fromEntries(
        Object.keys(pkgs)
          .filter((n) => n !== ref.pkg)
          .map((n) => [n, "1.0.0"]),
      );
      return {
        name: ref.pkg,
        version: "1.0.0",
        files,
        manifest: {
          name: ref.pkg,
          version: "1.0.0",
          type: "module",
          main: "./index.js",
          dependencies: deps,
        } as PackageManifest,
      };
    },
  };
}

const PKGS = {
  greet: { "index.js": `import { up } from "shout";\nexport const hi = up("hi");` },
  shout: { "index.js": `export const up = (s) => s.toUpperCase();` },
  other: { "index.js": `export const o = 1;` },
};

/** A project whose public entry `main.ts` imports `greet`, plus a scanned
 *  non-public module `extra.ts` importing `other`. */
async function project(manifest: Record<string, unknown> | undefined) {
  const files = new MemFilesApi();
  if (manifest) await writeText(files, "/package.json", JSON.stringify(manifest));
  await writeText(files, "/main.ts", `import { hi } from "greet";\nexport const m = hi;`);
  await writeText(files, "/extra.ts", `import { o } from "other";\nexport const e = o;`);
  return files;
}

const GREET = "/~/~deps/greet/index.js";
const OTHER = "/~/~deps/other/index.js";
const SHOUT = "/greet@1.0.0/~deps/shout/index.js"; // the package's own deps folder

describe("ProjectBuild.prune (#2)", () => {
  it("by default keeps what the package.json entry points reach and removes the rest", async () => {
    const files = await project({ name: "app", main: "./main.ts" });
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();
    for (const p of [GREET, OTHER, SHOUT, `${OTHER}.shape.json`])
      expect(await cache.exists(p)).toBe(true);

    const { entries, removed } = await build.prune();

    expect(entries).toEqual(["main.ts"]);
    expect(await cache.exists(GREET)).toBe(true);
    expect(await cache.exists(SHOUT)).toBe(true); // reached through greet
    expect(await cache.exists(OTHER)).toBe(false);
    expect(await cache.exists(`${OTHER}.shape.json`)).toBe(false); // sidecars go too
    expect(removed).toEqual(expect.arrayContaining([OTHER, `${OTHER}.shape.json`]));
    expect(removed.every((p) => p.includes("/~deps/"))).toBe(true);
    // Only `~deps` files are pruned: the non-public module's own artifact stays.
    expect(await cache.exists("/~/extra.js")).toBe(true);
  });

  it("reads every string target of an exports map", async () => {
    const files = await project({
      name: "app",
      exports: { ".": { browser: "./main.ts", default: "./main.ts" }, "./extra": "./extra.ts" },
    });
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();

    const { entries, removed } = await build.prune();

    expect(entries.sort()).toEqual(["extra.ts", "main.ts"]);
    expect(removed).toEqual([]);
  });

  it("takes explicit entry points instead of package.json", async () => {
    const files = await project({ name: "app", main: "./main.ts" });
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();

    await build.prune({ entries: ["extra.ts"] });

    expect(await cache.exists(OTHER)).toBe(true);
    expect(await cache.exists(GREET)).toBe(false);
    expect(await cache.exists(SHOUT)).toBe(false);
  });

  it("removes the proxy of a dependency whose last importer was removed", async () => {
    const files = await project({ name: "app", main: "./main.ts" });
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();
    await writeText(files, "/main.ts", "export const m = 1;"); // greet no longer imported
    await build.build();
    expect(await cache.exists(GREET)).toBe(true); // the build alone leaves it behind

    await build.prune();

    expect(await cache.exists(GREET)).toBe(false);
    expect(await cache.exists(SHOUT)).toBe(false);
  });

  it("refuses to prune when there is no entry point, and removes nothing", async () => {
    const files = await project(undefined); // no package.json
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();

    await expect(build.prune()).rejects.toThrow(/no entry points/);
    await expect(build.prune({ entries: [] })).rejects.toThrow(/no entry points/);
    expect(await cache.exists(GREET)).toBe(true);
    expect(await cache.exists(OTHER)).toBe(true);
  });

  it("rejects an entry point that is not a project file", async () => {
    const files = await project({ name: "app", main: "./main.ts" });
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project: files, cache, sources: [memSource(PKGS)] });
    await build.build();

    await expect(build.prune({ entries: ["missing.ts"] })).rejects.toThrow(/missing\.ts/);
    expect(await cache.exists(GREET)).toBe(true);
  });
});
