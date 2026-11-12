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

/** Options with call counters around the expensive steps. */
function counted(base: Partial<DocumentIndexOptions> & Pick<DocumentIndexOptions, "files">) {
  const calls = { extract: [] as string[], embed: 0 };
  const embedder = hashingEmbedder(64);
  const opts: DocumentIndexOptions = {
    root: "/library",
    extract: async (bytes, path) => {
      calls.extract.push(path);
      return textExtractor(bytes);
    },
    embed: async (text) => {
      calls.embed++;
      return embedder(text);
    },
    model: "hashing-64",
    dimensionality: 64,
    chunk: { targetChars: 300 },
    ...base,
  };
  return { opts, calls };
}

describe("document index — indexing", () => {
  it("extracts, chunks, embeds and indexes every PDF; ignores other files", async () => {
    const { files } = await corpus(5, 12);
    const { opts, calls } = counted({ files });
    const index = await openDocumentIndex(opts);
    const report = await index.update();
    expect(report.scanned).toEqual({ seen: 6, changed: 6, removed: 0 }); // notes.txt is scanned...
    expect(calls.extract.sort()).toEqual([
      "doc0000.pdf",
      "doc0001.pdf",
      "doc0002.pdf",
      "doc0003.pdf",
      "doc0004.pdf",
    ]); // ...but not extracted
    const status = await index.status();
    expect(status.documents).toBe(5);
    expect(status.chunks).toBeGreaterThanOrEqual(5 * 12);
    expect(status.indexedText).toBe(status.chunks);
    expect(status.indexedVectors).toBe(status.chunks);
    expect(calls.embed).toBe(status.chunks);
  });
});

describe("document index — search", () => {
  it("finds chunks by full text, by vector similarity, and by both (hybrid)", async () => {
    const { files } = await corpus(5, 12);
    const index = await openDocumentIndex(counted({ files }).opts);
    await index.update();

    const [ft] = await index.search("markerdoc0003p7", { mode: "fulltext", topK: 3 });
    expect(ft?.path).toBe("doc0003.pdf");
    expect(ft?.text).toContain("marker" + "doc0003p7");

    const [vec] = await index.search(documentText("doc0002", 12).split("\n\n")[5] as string, {
      mode: "vector",
      topK: 3,
    });
    expect(vec?.path).toBe("doc0002.pdf");

    const hybrid = await index.search("markerdoc0001p4", { topK: 5 });
    expect(hybrid[0]?.path).toBe("doc0001.pdf");
    expect(hybrid[0]?.text).toContain("markerdoc0001p4");
    expect(hybrid.every((h) => typeof h.score === "number" && h.chunk >= 0)).toBe(true);
  });
});

describe("document index — updates and deletes", () => {
  it("a no-op update does no work", async () => {
    const { files } = await corpus(4, 10);
    const { opts, calls } = counted({ files });
    const index = await openDocumentIndex(opts);
    await index.update();
    calls.extract.length = 0;
    calls.embed = 0;
    const report = await index.update();
    expect(report.executed).toBe(0);
    expect(calls).toEqual({ extract: [], embed: 0 });
  });

  it("editing one document re-extracts it and re-embeds only its changed chunks", async () => {
    const { files } = await corpus(4, 10);
    const { opts, calls } = counted({ files });
    const index = await openDocumentIndex(opts);
    await index.update();
    const before = await index.status();
    calls.extract.length = 0;
    calls.embed = 0;

    await tick();
    const text = documentText("doc0001", 10).replace("markerdoc0001p6", "freshlyeditedword");
    await writeText(files, "/library/doc0001.pdf", text);
    await index.update();

    expect(calls.extract).toEqual(["doc0001.pdf"]);
    expect(calls.embed).toBeGreaterThan(0);
    expect(calls.embed).toBeLessThanOrEqual(2); // only the chunk(s) whose text changed
    expect((await index.status()).chunks).toBe(before.chunks);
    expect((await index.search("freshlyeditedword", { mode: "fulltext" }))[0]?.path).toBe(
      "doc0001.pdf",
    );
    // Full-text search is fuzzy (neighbouring markers match), so check content, not emptiness.
    const stale = await index.search("markerdoc0001p6", { mode: "fulltext", topK: 50 });
    expect(stale.some((h) => h.text.includes("markerdoc0001p6"))).toBe(false);
  });

  it("deleting a document removes its chunks from both indexes and from the engine", async () => {
    const { files } = await corpus(4, 10);
    const index = await openDocumentIndex(counted({ files }).opts);
    await index.update();
    expect(await index.indexedBlocks("doc0002.pdf")).toEqual({
      text: expect.any(Number),
      vectors: expect.any(Number),
    });
    expect((await index.indexedBlocks("doc0002.pdf")).text).toBeGreaterThan(0);

    await files.remove("/library/doc0002.pdf");
    const report = await index.update();
    expect(report.scanned.removed).toBe(1);
    expect(await index.indexedBlocks("doc0002.pdf")).toEqual({ text: 0, vectors: 0 });
    const gone = await index.search("markerdoc0002p3", { mode: "fulltext", topK: 50 });
    expect(gone.some((h) => h.path === "doc0002.pdf")).toBe(false);
    const hits = await index.search(documentText("doc0002", 10), { mode: "vector", topK: 50 });
    expect(hits.some((h) => h.path === "doc0002.pdf")).toBe(false);
    expect((await index.status()).documents).toBe(3);
    expect(await index.engine.keys("chunks")).not.toContainEqual(expect.stringMatching(/^doc0002/));
  });

  it("a document that shrinks drops its vanished chunks from the indexes", async () => {
    const { files } = await corpus(2, 12);
    const index = await openDocumentIndex(counted({ files }).opts);
    await index.update();
    const big = (await index.indexedBlocks("doc0000.pdf")).text;
    await tick();
    await writeText(files, "/library/doc0000.pdf", documentText("doc0000", 3));
    await index.update();
    const small = await index.indexedBlocks("doc0000.pdf");
    expect(small.text).toBeLessThan(big);
    expect(small.vectors).toBe(small.text);
    const vanished = await index.search("markerdoc0000p9", { mode: "fulltext", topK: 50 });
    expect(vanished.some((h) => h.text.includes("markerdoc0000p9"))).toBe(false);
  });
});

describe("document index — configurable persistence", () => {
  it("autoFlush: false defers index saves to flush(); a crash before it is recovered", async () => {
    const { files } = await corpus(3, 6);
    const state = new MemFilesApi();
    const persistence = new FilesIndexerPersistence(state, "/index");
    let saves = 0;
    const counting = {
      save: (entries: Parameters<typeof persistence.save>[0]) => {
        saves++;
        return persistence.save(entries);
      },
      load: () => persistence.load(),
    };
    const make = () => {
      const c = counted({ files });
      c.opts.persistence = { kind: "files", files: state, path: "/engine" };
      c.opts.indexPersistence = counting;
      c.opts.autoFlush = false;
      return c;
    };
    const first = make();
    const index = await openDocumentIndex(first.opts);
    await index.update();
    await tick();
    await writeText(files, "/library/doc0001.pdf", "another text");
    await index.update();
    expect(saves).toBe(0);
    await index.flush();
    expect(saves).toBe(1);

    // Changes after the last flush, then the process dies: the next process rebuilds.
    await tick();
    await writeText(files, "/library/doc0002.pdf", "unflushed words");
    await index.update();
    const second = make();
    const reopened = await openDocumentIndex(second.opts);
    await reopened.update();
    expect(second.calls.embed).toBe(0);
    expect((await reopened.search("unflushed words", { mode: "fulltext" }))[0]?.path).toBe(
      "doc0002.pdf",
    );
  });

  it("rewrites the persisted index only when an update changed it", async () => {
    const { files } = await corpus(3, 6);
    const state = new MemFilesApi();
    const persistence = new FilesIndexerPersistence(state, "/index");
    let saves = 0;
    const counting = {
      save: (entries: Parameters<typeof persistence.save>[0]) => {
        saves++;
        return persistence.save(entries);
      },
      load: () => persistence.load(),
    };
    const c = counted({ files });
    const index = await openDocumentIndex({ ...c.opts, indexPersistence: counting });
    await index.update();
    expect(saves).toBe(1);
    await index.update(); // nothing changed
    await index.update();
    expect(saves).toBe(1);
    await tick();
    await writeText(files, "/library/doc0001.pdf", "a brand new text");
    await index.update();
    expect(saves).toBe(2);
  });

  it("engine state on files and index state on files: a new process searches at once and updates nothing", async () => {
    const { files } = await corpus(3, 8);
    const state = new MemFilesApi();
    const config = (calls?: ReturnType<typeof counted>) => {
      const c = calls ?? counted({ files });
      c.opts.persistence = { kind: "files", files: state, path: "/engine" };
      c.opts.indexPersistence = new FilesIndexerPersistence(state, "/index");
      return c;
    };
    const first = await openDocumentIndex(config().opts);
    await first.update();
    await first.close();

    const again = config();
    const second = await openDocumentIndex(again.opts);
    expect((await second.search("markerdoc0002p5", { mode: "fulltext" }))[0]?.path).toBe(
      "doc0002.pdf",
    );
    const report = await second.update();
    expect(report.executed).toBe(0);
    expect(again.calls).toEqual({ extract: [], embed: 0 });
  });

  it("recovers from a crash between the engine commit and the index flush without re-embedding", async () => {
    const { files } = await corpus(3, 8);
    const state = new MemFilesApi();
    const make = () => {
      const c = counted({ files });
      c.opts.persistence = { kind: "files", files: state, path: "/engine" };
      c.opts.indexPersistence = new FilesIndexerPersistence(state, "/index");
      return c;
    };
    const first = make();
    const crashing = await openDocumentIndex({ ...first.opts, crashBeforeIndexFlush: true });
    await expect(crashing.update()).rejects.toThrow(/simulated crash/);

    const second = make();
    const recovered = await openDocumentIndex(second.opts);
    await recovered.update();
    expect(second.calls.embed).toBe(0); // embeddings were already committed
    expect(second.calls.extract).toEqual([]);
    expect((await recovered.search("markerdoc0001p2", { mode: "fulltext" }))[0]?.path).toBe(
      "doc0001.pdf",
    );
    const status = await recovered.status();
    expect(status.indexedText).toBe(status.chunks);
  });
});
