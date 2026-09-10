import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  instanceRoot,
  instanceSidecarPath,
  isInstanceRoot,
  peerTag,
  persistInstance,
  plainVersion,
  rawKey,
  readInstancePins,
} from "../src/preprocess/instances.js";

const WASM = "@napi-rs/wasm-runtime@1.2.4";

describe("peer-qualified instance roots", () => {
  it("leaves a package with no pins on its plain root", () => {
    expect(instanceRoot("lib@1.0.0", {})).toBe("lib@1.0.0");
  });

  it("tags the version segment with _p. and 16 hex digits", () => {
    expect(instanceRoot(WASM, { "@emnapi/core": "1.11.2" })).toMatch(
      /^@napi-rs\/wasm-runtime@1\.2\.4_p\.[0-9a-f]{16}$/,
    );
  });

  it("is deterministic and independent of the order pins are listed in", () => {
    expect(peerTag({ a: "1.0.0", b: "2.0.0" })).toBe(peerTag({ b: "2.0.0", a: "1.0.0" }));
    expect(peerTag({ a: "1.0.0" })).toBe(peerTag({ a: "1.0.0" }));
  });

  it("gives different pins different tags", () => {
    expect(peerTag({ "@emnapi/core": "1.11.2" })).not.toBe(
      peerTag({ "@emnapi/core": "2.0.0-alpha.4" }),
    );
  });

  it("never puts a character in the version segment that a parser or static host misreads", () => {
    // `+` is semver build metadata and S3-style hosts decode it as a space; `@` or
    // `/` would split the root under the `name@version` parser.
    const root = instanceRoot("x@1.0.0", { "@scope/p": "1.0.0-rc.1+build.5" });
    expect(root.slice("x@".length)).not.toMatch(/[+@/ ]/);
  });

  it("keeps the whole instance root under the existing name@version parser", () => {
    const root = instanceRoot(WASM, { "@emnapi/core": "1.11.2" });
    const m = `${root}/runtime.js`.match(/^((?:@[^/]+\/)?[^/]+)@([^/]+)\//);
    expect(`${m?.[1]}@${m?.[2]}`).toBe(root);
  });

  it("rawKey strips the tag and leaves plain roots alone", () => {
    const root = instanceRoot(WASM, { "@emnapi/core": "1.11.2" });
    expect(rawKey(root)).toBe(WASM);
    expect(rawKey("lib@1.0.0")).toBe("lib@1.0.0");
    expect(isInstanceRoot(root)).toBe(true);
    expect(isInstanceRoot("lib@1.0.0")).toBe(false);
  });

  it("plainVersion strips the tag from a version and leaves plain versions alone", () => {
    expect(plainVersion("1.2.4_p.0123456789abcdef")).toBe("1.2.4");
    expect(plainVersion("1.2.4")).toBe("1.2.4");
    expect(plainVersion("2.0.0-alpha.4")).toBe("2.0.0-alpha.4");
    expect(plainVersion("^1.0.0")).toBe("^1.0.0");
  });

  it("does not mistake a prerelease for a tag", () => {
    expect(isInstanceRoot("lib@1.0.0-p.1")).toBe(false);
    expect(rawKey("lib@2.0.0-alpha.4")).toBe("lib@2.0.0-alpha.4");
  });
});

describe("instance sidecars", () => {
  it("lives at /instances/<root>.json", () => {
    expect(instanceSidecarPath("lib@1.0.0_p.0123456789abcdef")).toBe(
      "/instances/lib@1.0.0_p.0123456789abcdef.json",
    );
  });

  it("persists pins and reads them back", async () => {
    const cache = new MemFilesApi();
    const pins = { "@emnapi/runtime": "1.11.2", "@emnapi/core": "1.11.2" };
    const root = instanceRoot(WASM, pins);
    await persistInstance(cache, root, pins);
    expect(await readInstancePins(cache, root)).toEqual(pins);
  });

  it("returns undefined for an instance root never minted, and for a plain root", async () => {
    const cache = new MemFilesApi();
    expect(
      await readInstancePins(cache, instanceRoot("lib@1.0.0", { p: "1.0.0" })),
    ).toBeUndefined();
    expect(await readInstancePins(cache, "lib@1.0.0")).toBeUndefined();
  });

  it("is idempotent for the same pins, whatever order they are listed in", async () => {
    const cache = new MemFilesApi();
    const root = instanceRoot("lib@1.0.0", { a: "1.0.0", b: "2.0.0" });
    await persistInstance(cache, root, { a: "1.0.0", b: "2.0.0" });
    await expect(persistInstance(cache, root, { b: "2.0.0", a: "1.0.0" })).resolves.toBeUndefined();
  });

  it("refuses to overwrite a root's pins with different ones", async () => {
    const cache = new MemFilesApi();
    const root = instanceRoot("lib@1.0.0", { p: "1.0.0" });
    await persistInstance(cache, root, { p: "1.0.0" });
    await expect(persistInstance(cache, root, { p: "2.0.0" })).rejects.toThrow(/collision/);
    expect(await readInstancePins(cache, root)).toEqual({ p: "1.0.0" });
  });
});
