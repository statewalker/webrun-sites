/**
 * Incremental document indexing on `@statewalker/webrun-builder` +
 * statewalker-search.
 *
 *   scanSources ─► files ─[extract]─► text ─[chunk]─► chunks ─[embed]─► embeddings
 *                                              │   └─► layout             │
 *                                       [index-text]               [index-vectors]
 *                                              ▼                          ▼
 *                                   full-text sub-index          vector sub-index
 *
 * Every arrow is a map cell: one task per document (extract, chunk) or per
 * chunk (embed, index-text, index-vectors). The engine runs only tasks whose
 * inputs changed, so:
 *
 * - **Indexing** a new PDF runs extract → chunk → (embed + index) per chunk.
 * - **Updating** a PDF re-extracts and re-chunks it; chunk ids are content
 *   hashes, so unchanged chunks keep their rows and are neither re-embedded nor
 *   re-indexed (early cut-off). Only changed chunks are embedded.
 * - **Deleting** a PDF removes its `files` row; the extract task is dead, its
 *   `text` row is retracted, then the chunk task's rows, then every per-chunk
 *   task is dead and its `dispose` deletes the block from the sub-index.
 *
 * The search indexes are sinks the engine does not own, so the pipeline keeps
 * them consistent with the engine state across crashes: a `sys/index-dirty`
 * row is set before a run and cleared after the index is flushed; if a process
 * finds it set — or finds an empty index while the engine says chunks were
 * indexed — it rebuilds the index from the stored chunks and embeddings
 * (`invalidate` on the two index cells), without extracting or embedding again.
 */
import { pdfExtractor } from "@statewalker/content-extractors";
import type {
  EmbedFn,
  Index,
  Indexer,
  IndexerPersistence,
  SearchRequest,
} from "@statewalker/indexer-api";
import { chunkMarkdown } from "@statewalker/indexer-chunker";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { createMiniSearchIndexer } from "@statewalker/indexer-mem-minisearch";
import { newVectorAccess } from "@statewalker/indexer-vector";
import {
  type BuildEngine,
  type CellDef,
  createBuildEngine,
  type PersistenceConfig,
  type ScanResult,
  scanSources,
} from "@statewalker/webrun-builder";
import { type FilesApi, joinPath } from "@statewalker/webrun-files";
import { decodeEmbedding, encodeEmbedding } from "./embedders.js";

export interface DocumentIndexOptions {
  /** Where the documents are. */
  files: FilesApi;
  /** Folder to index (recursively). Document ids are paths relative to it. */
  root: string;
  /** Which files are documents (default: `*.pdf`). */
  accept?: (path: string) => boolean;
  /** Bytes → markdown text (default: statewalker `pdfExtractor`). */
  extract?: (bytes: Uint8Array, path: string) => Promise<string>;
  embed: EmbedFn;
  model: string;
  dimensionality: number;
  chunk?: { targetChars: number; overlap?: number };
  /** Engine state: rows, queue, traces (default memory). */
  persistence?: PersistenceConfig;
  /** Search-index state (default: in memory only). */
  indexPersistence?: IndexerPersistence;
  /** Concurrent tasks per batch, e.g. parallel embedding calls (default 4). */
  concurrency?: number;
  /**
   * Save the search index at the end of every `update()` that changed it
   * (default true). With `false`, call `flush()` yourself — e.g. on a timer —
   * since statewalker-search rewrites the whole index on each save; a crash
   * before the flush is recovered by rebuilding the index from the engine
   * state (no re-extraction, no re-embedding).
   */
  autoFlush?: boolean;
  /** Test hook: throw after the engine run, before the index flush. */
  crashBeforeIndexFlush?: boolean;
}

export interface SearchHit {
  /** Document id (path relative to the root). */
  path: string;
  /** Position of the chunk in the document. */
  chunk: number;
  text: string;
  score: number;
}

export interface UpdateReport {
  scanned: ScanResult;
  /** Engine tasks executed (extract, chunk, embed and index steps). */
  executed: number;
  failed: number;
}

export interface DocumentIndex {
  /** Scan the folder, run the pipeline to convergence, flush the search index (`autoFlush`). */
  update(): Promise<UpdateReport>;
  /** Save the search index if it changed since the last save. */
  flush(): Promise<void>;
  search(
    query: string,
    opts?: { topK?: number; mode?: "hybrid" | "fulltext" | "vector" },
  ): Promise<SearchHit[]>;
  status(): Promise<{
    documents: number;
    chunks: number;
    indexedText: number;
    indexedVectors: number;
  }>;
  /** Blocks of one document in each sub-index. */
  indexedBlocks(path: string): Promise<{ text: number; vectors: number }>;
  close(): Promise<void>;
  readonly engine: BuildEngine;
}

const INDEX_NAME = "documents";
const FILES = "files";
const SYS = "sys";
const ft = newFullTextAccess("text");
const vec = newVectorAccess("vectors");

/** Chunk row key: `<document>#<chunk id>`; ids are hex, so split at the last `#`. */
const chunkKey = (doc: string, id: string) => `${doc}#${id}`;
function parseChunkKey(key: string): { doc: string; id: string } {
  const i = key.lastIndexOf("#");
  return { doc: key.slice(0, i), id: key.slice(i + 1) };
}
const docPath = (doc: string) => `/${doc}` as const;

export async function openDocumentIndex(opts: DocumentIndexOptions): Promise<DocumentIndex> {
  const accept = opts.accept ?? ((p: string) => p.toLowerCase().endsWith(".pdf"));
  const extract =
    opts.extract ?? (async (bytes: Uint8Array) => String(await pdfExtractor([bytes])));
  const chunking = opts.chunk ?? { targetChars: 1200, overlap: 0 };

  const indexer: Indexer = createMiniSearchIndexer({ persistence: opts.indexPersistence });
  let index: Index | null = await indexer.getIndex(INDEX_NAME);
  const freshIndex = index === null;
  if (!index) {
    const params = { name: INDEX_NAME };
    ft.setConfig(params, { language: "en" });
    vec.setConfig(params, { dimensionality: opts.dimensionality, model: opts.model });
    index = await indexer.createIndex(params);
  }
  const idx = index;
  /** Whether the index changed since the last flush (an index task ran or disposed). */
  let touched = false;
  /** An `update()` is in progress: its run may commit index changes after any flush. */
  let updating = 0;

  const cells: CellDef[] = [
    {
      id: "extract",
      inputs: [FILES],
      outputs: ["text"],
      async run(ctx) {
        if (!accept(ctx.key)) return;
        const bytes = await readBytes(opts.files, joinPath(opts.root, ctx.key));
        ctx.emit("text", ctx.key, await extract(bytes, ctx.key));
      },
    },
    {
      id: "chunk",
      inputs: ["text"],
      outputs: ["chunks", "layout"],
      async run(ctx) {
        const text = String(await ctx.get("text", ctx.key));
        const ids: string[] = [];
        const seen = new Map<string, number>();
        for (const c of chunkMarkdown(text, chunking)) {
          // Content-addressed ids: an unchanged chunk keeps its key across edits.
          const base = fnv(c.content);
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const id = n === 0 ? base : `${base}-${n}`;
          ids.push(id);
          ctx.emit("chunks", chunkKey(ctx.key, id), c.content);
        }
        ctx.emit("layout", ctx.key, ids);
      },
    },
    {
      id: "embed",
      inputs: ["chunks"],
      outputs: ["embeddings"],
      async run(ctx) {
        const v = await opts.embed(String(await ctx.get("chunks", ctx.key)));
        if (v.length !== opts.dimensionality) {
          throw new Error(`Expected dimensionality ${opts.dimensionality}, got ${v.length}`);
        }
        ctx.emit("embeddings", ctx.key, encodeEmbedding(v));
      },
    },
    {
      id: "index-text",
      inputs: ["chunks"],
      outputs: ["indexed-text"],
      async run(ctx) {
        const { doc, id } = parseChunkKey(ctx.key);
        const content = String(await ctx.get("chunks", ctx.key));
        touched = true;
        await ft.get(idx).addDocument([{ path: docPath(doc), blockId: id, content }]);
        ctx.emit("indexed-text", ctx.key, true);
      },
      async dispose(key) {
        const { doc, id } = parseChunkKey(key);
        touched = true;
        await ft.get(idx).deleteDocuments([{ path: docPath(doc), blockId: id }]);
      },
    },
    {
      id: "index-vectors",
      inputs: ["embeddings"],
      outputs: ["indexed-vectors"],
      async run(ctx) {
        const { doc, id } = parseChunkKey(ctx.key);
        const embedding = decodeEmbedding(String(await ctx.get("embeddings", ctx.key)));
        touched = true;
        await vec.get(idx).addDocument([{ path: docPath(doc), blockId: id, embedding }]);
        ctx.emit("indexed-vectors", ctx.key, true);
      },
      async dispose(key) {
        const { doc, id } = parseChunkKey(key);
        touched = true;
        await vec.get(idx).deleteDocuments([{ path: docPath(doc), blockId: id }]);
      },
    },
  ];

  const engine = await createBuildEngine({
    cells,
    persistence: opts.persistence,
    concurrency: opts.concurrency ?? 4,
    batchSize: 128,
  });

  // The index lags the engine after a crash between run and flush (dirty), or
  // was lost while the engine state survived (fresh but rows exist): rebuild it
  // from stored chunks and embeddings.
  const dirty = (await engine.get(SYS, "index-dirty")) !== undefined;
  const lost = freshIndex && (await engine.keys("indexed-text")).length > 0;
  if (dirty || lost) {
    await ft.get(idx).deleteDocuments([{ path: "/" }]);
    await vec.get(idx).deleteDocuments([{ path: "/" }]);
    await engine.invalidate("index-text");
    await engine.invalidate("index-vectors");
    touched = true;
  }

  /** Persist the index if it changed since the last flush. */
  async function flushIndex(): Promise<void> {
    if (!touched) return;
    await idx.flush();
    await indexer.flush();
    touched = false;
  }

  return {
    engine,

    async update() {
      const scanned = await scanSources(engine, {
        files: opts.files,
        root: opts.root,
        signal: FILES,
      });
      // Mark the index dirty while engine commits may run ahead of its flush.
      await engine.put(SYS, "index-dirty", true);
      updating++;
      try {
        const stats = await engine.run();
        if (opts.crashBeforeIndexFlush) throw new Error("simulated crash before the index flush");
        if (opts.autoFlush ?? true) await flushIndex();
        // Clean once nothing is left unsaved (with autoFlush: false, after flush()).
        if (!touched) await engine.remove(SYS, "index-dirty");
        return { scanned, executed: stats.executed, failed: stats.failed };
      } finally {
        updating--;
      }
    },

    async flush() {
      await flushIndex();
      // During an update the run may still commit index changes after this
      // save: the marker stays until that update ends clean.
      if (updating === 0) await engine.remove(SYS, "index-dirty");
    },

    async search(query, { topK = 10, mode = "hybrid" } = {}) {
      const request: SearchRequest = { topK };
      if (mode !== "vector") ft.setQuery(request, { queries: [query], topK });
      if (mode !== "fulltext")
        vec.setQuery(request, { embeddings: [await opts.embed(query)], topK });
      const hits: SearchHit[] = [];
      for await (const r of idx.search(request)) {
        const doc = r.path.slice(1);
        const text = await engine.get("chunks", chunkKey(doc, r.blockId));
        if (text === undefined) continue; // not (yet) committed by the engine
        const layout = ((await engine.get("layout", doc)) as string[] | undefined) ?? [];
        hits.push({
          path: doc,
          chunk: layout.indexOf(r.blockId),
          text: String(text),
          score: r.score,
        });
      }
      return hits;
    },

    async status() {
      return {
        documents: (await engine.keys("text")).length,
        chunks: (await engine.keys("chunks")).length,
        indexedText: (await engine.keys("indexed-text")).length,
        indexedVectors: (await engine.keys("indexed-vectors")).length,
      };
    },

    async indexedBlocks(path) {
      return {
        text: await ft.get(idx).getSize(docPath(path)),
        vectors: await vec.get(idx).getSize(docPath(path)),
      };
    },

    async close() {
      await flushIndex();
      await indexer.close();
    },
  };
}

async function readBytes(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const p of files.read(path)) {
    parts.push(p);
    size += p.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** FNV-1a, 8 hex chars — chunk ids. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
