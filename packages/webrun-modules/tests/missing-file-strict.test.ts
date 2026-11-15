import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * statewalker/webrun-sites#9: a missing file must fail, not become an empty
 * module. `missing-module-404.test.ts` covers the `.js` 404s; this file covers the
 * rest of the issue: the extensionless regression guard, the `onMissingFile`
 * escape hatch, and a manifest naming a file its package does not ship.
 */
function source(
  name: string,
  manifest: Partial<PackageManifest>,
  files: Record<string, string>,
): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === name,
    async load() {
      const api = new MemFilesApi();
      for (const [path, text] of Object.entries(files)) await writeText(api, path, text);
      return {
        name,
        version: "1.0.0",
        files: api,
        manifest: { name, version: "1.0.0", ...manifest } as PackageManifest,
      };
    },
  };
}

const p = () =>
  source("p", { type: "module", main: "./index.js" }, { "/index.js": "export const v = 1;" });

describe("missing files fail (webrun-sites#9)", () => {
  it("404s a missing extensionless package path (regression guard)", async () => {
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [p()] });
    await server.fetch(new Request("http://h/p@1.0.0/index.js")); // warm the package
    const res = await server.fetch(new Request("http://h/p@1.0.0/nope"));
    expect(res.status).toBe(404);
  });

  it("onMissingFile returning a string supplies the source", async () => {
    const asked: string[] = [];
    const server = newModuleServer({
      cache: new MemFilesApi(),
      sources: [p()],
      onMissingFile: (id) => {
        asked.push(id);
        return "export const stub = 42;";
      },
    });
    await server.fetch(new Request("http://h/p@1.0.0/index.js"));
    const res = await server.fetch(new Request("http://h/p@1.0.0/nope.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("stub = 42");
    expect(asked).toContain("p@1.0.0/nope.js");
  });

  it("onMissingFile returning undefined still fails", async () => {
    const asked: string[] = [];
    const server = newModuleServer({
      cache: new MemFilesApi(),
      sources: [p()],
      onMissingFile: async (id) => {
        asked.push(id);
        return undefined;
      },
    });
    await server.fetch(new Request("http://h/p@1.0.0/index.js"));
    const res = await server.fetch(new Request("http://h/p@1.0.0/nope.js"));
    expect(res.status).toBe(404);
    expect(asked).toContain("p@1.0.0/nope.js");
  });

  it("onMissingFile also covers project files", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/a.js", "export const a = 1;");
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project,
      onMissingFile: () => "export const fromHook = true;",
    });
    const res = await server.fetch(new Request("http://h/~/missing.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fromHook");
  });

  it("names the package and the declared target when exports points at an unshipped file", async () => {
    const broken = source(
      "broken",
      { type: "module", exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" } },
      { "/dist/index.js": "export const ok = 1;" },
    );
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [broken] });
    const err = await server.resolve({ pkg: "broken", subpath: "extra" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("broken@1.0.0");
    expect(err?.message).toContain("./extra");
    expect(err?.message).toContain("dist/extra.js");
  });

  it("names the package when main points at an unshipped file", async () => {
    const broken = source("broken-main", { main: "./lib/main.js" }, { "/lib/other.js": "" });
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [broken] });
    await expect(server.resolve({ pkg: "broken-main" })).rejects.toThrow(
      /broken-main@1\.0\.0.*lib\/main\.js/,
    );
  });

  it("still resolves a package that declares nothing and ships nothing lazily (ghost)", async () => {
    // No manifest entry ⇒ the `index.js` fallback is a guess, not a claim: no error
    // at resolution (optional-require relies on this, see optional-require.test.ts).
    const ghost = source("ghost", {}, { "/package.json": `{"name":"ghost","version":"1.0.0"}` });
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [ghost] });
    await expect(server.resolve({ pkg: "ghost" })).resolves.toBeDefined();
  });
});
