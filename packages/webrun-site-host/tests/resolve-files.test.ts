import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { resolveFilesSource } from "../src/resolve-files.js";

async function readText(
  files: Awaited<ReturnType<typeof resolveFilesSource>>,
  path: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of files.read(path)) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

describe("resolveFilesSource", () => {
  it("wraps a record of strings in a MemFilesApi", async () => {
    const files = await resolveFilesSource({ "/hello.txt": "hi", "/deep/a.txt": "A" });
    expect(await readText(files, "/hello.txt")).toBe("hi");
    expect(await readText(files, "/deep/a.txt")).toBe("A");
  });

  it("wraps a record of Uint8Array values", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const files = await resolveFilesSource({ "/data.bin": bytes });
    const stats = await files.stats("/data.bin");
    expect(stats?.size).toBe(3);
  });

  it("passes a FilesApi instance through without modification", async () => {
    const original = new MemFilesApi();
    await original.write("/x", [new TextEncoder().encode("x")]);
    const resolved = await resolveFilesSource(original);
    expect(resolved).toBe(original);
  });
});
