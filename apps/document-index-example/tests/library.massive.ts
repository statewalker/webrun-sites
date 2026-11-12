/**
 * 1000 PDFs × ~100 chunks (scale with DOCS / CHUNKS): cold indexing, search,
 * a 1 % edit, deletions, and a restart over persisted engine + index state.
 * Prints timings. Run: `pnpm test:massive`.
 */
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  type DocumentIndexOptions,
  FilesIndexerPersistence,
  hashingEmbedder,
  openDocumentIndex,
} from "../src/index.js";
import { corpus, documentText, textExtractor, tick } from "./helpers.js";

const DOCS = Number(process.env.DOCS ?? 1000);
const CHUNKS = Number(process.env.CHUNKS ?? 100);

describe(`massive — ${DOCS} documents × ~${CHUNKS} chunks`, () => {
  it("indexes, searches, updates, deletes and restarts incrementally", async () => {
    const { files, names } = await corpus(DOCS, CHUNKS);
    const state = new MemFilesApi();
    const calls = { extract: 0, embed: 0 };
    const embedder = hashingEmbedder(64);
    const options = (): DocumentIndexOptions => ({
      files,
      root: "/library",
      extract: async (bytes) => {
        calls.extract++;
        return textExtractor(bytes);
      },
      embed: async (text) => {
        calls.embed++;
        return embedder(text);
      },
      model: "hashing-64",
      dimensionality: 64,
      chunk: { targetChars: 300 },
      persistence: { kind: "files", files: state, path: "/engine" },
      indexPersistence: new FilesIndexerPersistence(state, "/index"),
    });
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`, calls);
      return r;
    };

    const index = await openDocumentIndex(options());
    await time("cold index", () => index.update());
    const status = await index.status();
    console.log(status);
    expect(status.documents).toBe(DOCS);
    expect(status.chunks).toBeGreaterThanOrEqual(DOCS * CHUNKS);
    expect(status.indexedText).toBe(status.chunks);
    expect(status.indexedVectors).toBe(status.chunks);
    expect(calls.embed).toBe(status.chunks);

    const target = names[Math.floor(DOCS / 2)] as string;
    const [hit] = await time("search", () => index.search(`marker${target}p42`, { topK: 5 }));
    expect(hit?.path).toBe(`${target}.pdf`);

    // 1 % of documents edited: one paragraph each.
    calls.extract = 0;
    calls.embed = 0;
    await tick();
    const edited = names.filter((_, i) => i % 100 === 1);
    for (const name of edited) {
      await writeText(
        files,
        `/library/${name}.pdf`,
        documentText(name, CHUNKS).replace(`marker${name}p10`, `edited${name}`),
      );
    }
    await time("1% edit", () => index.update());
    expect(calls.extract).toBe(edited.length);
    expect(calls.embed).toBeLessThanOrEqual(edited.length * 2);
    expect((await index.search(`edited${edited[0]}`, { mode: "fulltext" }))[0]?.path).toBe(
      `${edited[0]}.pdf`,
    );

    // Delete 5 documents.
    const removed = names.slice(0, 5);
    for (const name of removed) await files.remove(`/library/${name}.pdf`);
    await time("delete 5", () => index.update());
    for (const name of removed)
      expect(await index.indexedBlocks(`${name}.pdf`)).toEqual({ text: 0, vectors: 0 });
    expect((await index.status()).documents).toBe(DOCS - 5);
    await index.close();

    // Restart: a new process over the persisted engine + index state.
    calls.extract = 0;
    calls.embed = 0;
    const restarted = await time("reopen", () => openDocumentIndex(options()));
    const report = await time("no-op update after restart", () => restarted.update());
    expect(report.executed).toBe(0);
    expect(calls).toEqual({ extract: 0, embed: 0 });
    expect((await restarted.search(`marker${target}p42`, { mode: "fulltext" }))[0]?.path).toBe(
      `${target}.pdf`,
    );
  });
});
