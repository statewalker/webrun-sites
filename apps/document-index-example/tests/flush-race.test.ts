import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { expect, it } from "vitest";
import { FilesIndexerPersistence, hashingEmbedder, openDocumentIndex } from "../src/index.js";

// Regression test from the review of PR #28.
it("A1: flush() during update() clears the dirty marker; a crash afterwards leaves index behind engine forever", async () => {
  const files = new MemFilesApi();
  const state = new MemFilesApi();
  await writeText(files, "/library/a.pdf", "alpha beta gamma paragraph one");
  const emb = hashingEmbedder(16);
  let gate: Promise<void> | undefined;
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => {
    reached = r;
  });
  let release!: () => void;
  const opts = (crash: boolean) => ({
    files,
    root: "/library",
    model: "h",
    dimensionality: 16,
    chunk: { targetChars: 300 },
    extract: async (b: Uint8Array) => new TextDecoder().decode(b),
    embed: async (t: string) => {
      if (gate) {
        reached();
        await gate;
      }
      return emb(t);
    },
    persistence: { kind: "files" as const, files: state, path: "/engine" },
    indexPersistence: new FilesIndexerPersistence(state, "/index"),
    autoFlush: false,
    crashBeforeIndexFlush: crash,
  });
  const i1 = await openDocumentIndex(opts(false));
  await i1.update();
  await i1.flush();
  // second process: add a document, flush on a "timer" mid-update, then die before the end
  const i2 = await openDocumentIndex(opts(true));
  await writeText(files, "/library/b.pdf", "zeta omega distinctword paragraph two");
  gate = new Promise((r) => {
    release = r;
  });
  const up = i2.update();
  await reachedP;
  await i2.flush(); // timer flush while run() is in progress
  release();
  gate = undefined;
  await expect(up).rejects.toThrow(/simulated crash/);
  // third process
  const i3 = await openDocumentIndex(opts(false));
  await i3.update();

  const blocks = await i3.indexedBlocks("b.pdf");
  expect(blocks.text).toBeGreaterThan(0);
});
