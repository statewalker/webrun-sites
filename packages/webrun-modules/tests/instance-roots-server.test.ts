import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { instanceRoot, persistInstance } from "../src/preprocess/instances.js";
import { newModuleServer } from "../src/server/new-module-server.js";
import { type FixtureRegistry, registrySource } from "./_packages.js";

const REG: FixtureRegistry = {
  lib: {
    "1.0.0": {
      dependencies: { dep: "^1.0.0" },
      files: {
        "index.js": `import { d } from "dep";\nimport { own } from "lib/own.js";\nexport const out = d + own;`,
        "own.js": `export const own = "own";`,
        "data.json": `{"k":1}`,
      },
    },
    "2.0.0": {
      files: { "index.js": `export const out = "lib2";`, "own.js": `export const own = "WRONG";` },
    },
  },
  dep: {
    "1.0.0": { files: { "index.js": `export const d = "dep1";` } },
    "2.0.0": { files: { "index.js": `export const d = "dep2";` } },
  },
};

const PINS = { p: "1.0.0" };
const ROOT = instanceRoot("lib@1.0.0", PINS);

async function mintedServer() {
  const cache = new MemFilesApi();
  await persistInstance(cache, ROOT, PINS);
  const server = newModuleServer({ cache, sources: [registrySource(REG)] });
  const get = (path: string) => server.fetch(new Request(`http://x${path}`));
  return { cache, get };
}

describe("serving a peer-qualified instance root", () => {
  it("serves the plain package's raw files under the instance root", async () => {
    const { get } = await mintedServer();
    const res = await get(`/${ROOT}/index.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`from "./~deps/dep/index.js"`);
  });

  it("gives the instance its own ~deps, resolved from the package's own manifest", async () => {
    const { cache, get } = await mintedServer();
    await get(`/${ROOT}/index.js`);
    expect(await cache.exists(`/t/browser/${ROOT}/~deps/dep/index.js`)).toBe(true);
    const proxy = await (await get(`/${ROOT}/~deps/dep/index.js`)).text();
    expect(proxy).toContain("dep@1.0.0/index.js"); // lib@1.0.0 declares dep ^1.0.0
    expect(proxy).not.toContain("dep@2.0.0");
  });

  it("resolves a self-reference inside an instance to the package's own version", async () => {
    const { get } = await mintedServer();
    await get(`/${ROOT}/index.js`);
    const proxy = await (await get(`/${ROOT}/~deps/lib/own.js`)).text();
    expect(proxy).toContain("lib@1.0.0/own.js");
    expect(proxy).not.toContain("lib@2.0.0");
  });

  it("serves a non-module asset and ?raw bytes under an instance root", async () => {
    const { get } = await mintedServer();
    expect(await (await get(`/${ROOT}/data.json`)).text()).toBe(`{"k":1}`);
    expect(await (await get(`/${ROOT}/index.js?raw`)).text()).toContain(`from "dep"`);
  });

  it("404s an instance root that was never minted, rather than guessing its peers", async () => {
    const { get } = await mintedServer();
    const forged = instanceRoot("lib@1.0.0", { p: "9.9.9" });
    expect((await get(`/${forged}/index.js`)).status).toBe(404);
    expect((await get(`/${forged}/data.json`)).status).toBe(404);
  });
});
