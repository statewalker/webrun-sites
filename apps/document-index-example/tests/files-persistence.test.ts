import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { FilesIndexerPersistence } from "../src/index.js";

async function* entries(map: Record<string, string>) {
  for (const [name, text] of Object.entries(map)) {
    yield {
      name,
      content: (async function* () {
        yield new TextEncoder().encode(text);
      })(),
    };
  }
}

async function read(p: FilesIndexerPersistence): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of p.load()) {
    const parts: Uint8Array[] = [];
    for await (const c of e.content) parts.push(c);
    out[e.name] = new TextDecoder().decode(Buffer.concat(parts));
  }
  return out;
}

describe("FilesIndexerPersistence", () => {
  it("round-trips entries (names with slashes included) and replaces them as a whole", async () => {
    const files = new MemFilesApi();
    const p = new FilesIndexerPersistence(files, "/idx");
    expect(await read(p)).toEqual({});
    await p.save(
      entries({ __manifest__: "m1", "documents/text/data": "t1", "documents/vec": "v1" }),
    );
    expect(await read(new FilesIndexerPersistence(files, "/idx"))).toEqual({
      __manifest__: "m1",
      "documents/text/data": "t1",
      "documents/vec": "v1",
    });
    await p.save(entries({ __manifest__: "m2" }));
    expect(await read(p)).toEqual({ __manifest__: "m2" });
  });
});
