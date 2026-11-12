# @statewalker/document-index-example (private)

## What it is

A worked example of incremental document indexing: PDFs in a `FilesApi` folder are extracted,
split into chunks and embedded, and the chunks are indexed in a full-text and a vector index
([statewalker-search](https://github.com/statewalker/statewalker-search)). The pipeline runs on
[`@statewalker/webrun-builder`](../../packages/webrun-builder), so after the first build only
what changed is redone: an edited PDF re-embeds only its changed chunks, and a removed PDF
disappears from both indexes.

## How to use

```ts
import { FilesIndexerPersistence, openDocumentIndex } from "@statewalker/document-index-example";

const index = await openDocumentIndex({
  files,                       // any FilesApi (Node fs, browser storage, memory)
  root: "/library",            // folder with the PDFs (recursive)
  embed,                       // (text) => Promise<Float32Array> — your embedding model
  model: "my-model", dimensionality: 384,
  chunk: { targetChars: 1200 },
  persistence: { kind: "files", files: stateFiles, path: "/engine" },   // engine state
  indexPersistence: new FilesIndexerPersistence(stateFiles, "/index"),   // search-index state
});

await index.update();                                    // scan + incremental build + flush
const hits = await index.search("perovskite tandem cells", { topK: 10 });
// [{ path: "solar.pdf", chunk: 3, text: "…", score: 0.031 }, …]
```

| Option | Default | |
|---|---|---|
| `accept(path)` | `*.pdf` | which files are documents |
| `extract(bytes, path)` | statewalker `pdfExtractor` (unpdf; one `## Page N` section per page) | bytes → markdown |
| `chunk` | `{ targetChars: 1200 }` | `chunkMarkdown` options (`@statewalker/indexer-chunker`) |
| `persistence` | `{ kind: "memory" }` | engine state: `memory`, `files`, `sql`, `custom` |
| `indexPersistence` | none (in memory) | any statewalker-search `IndexerPersistence`; `FilesIndexerPersistence` stores it in a `FilesApi` |
| `concurrency` | 4 | tasks run concurrently, e.g. parallel embedding calls |

`hashingEmbedder(dim)` is a deterministic bag-of-words embedder for demos and tests; use a real model
in production.

## How it works

### The pipeline is five map cells

```
scanSources ─► files ─[extract]─► text ─[chunk]─► chunks ─[embed]─► embeddings
                                          │   └─► layout             │
                                   [index-text]               [index-vectors]
                                          ▼                          ▼
                               full-text sub-index          vector sub-index
```

| Cell | One task per | Reads | Emits |
|---|---|---|---|
| `extract` | file | the PDF bytes | `text/<doc>` = markdown (non-PDFs emit nothing) |
| `chunk` | document | `text/<doc>` | `chunks/<doc>#<hash>` = chunk text, `layout/<doc>` = ordered chunk ids |
| `embed` | chunk | `chunks/…` | `embeddings/<doc>#<hash>` = base64 Float32 |
| `index-text` | chunk | `chunks/…` | full-text block `{ path: "/<doc>", blockId: <hash> }`; `dispose` deletes it |
| `index-vectors` | chunk | `embeddings/…` | vector block, same ids; `dispose` deletes it |

Chunk ids are **content hashes**. Embeddings are rows in the engine store, which makes them a
durable cache: the indexes can be rebuilt without calling the model again.

### Indexing

`update()` mirrors the folder into the `files` signal (`scanSources`: one row per file, valued by
`{ mtime, size }`), runs the engine to convergence, then flushes the search index. On the first run,
each PDF is extracted once, chunked once, and each chunk is embedded once and added to both
sub-indexes.

### Search

`search(query, { topK, mode })` builds one statewalker-search `SearchRequest`:

- `"fulltext"`: a full-text sub-query only;
- `"vector"`: the query is embedded and sent as a vector sub-query;
- `"hybrid"` (default): both, blended by the composite index (reciprocal rank fusion).

Each hit `{ path, blockId, score }` is resolved to its chunk text (`chunks/<doc>#<blockId>`) and its
position (`layout/<doc>`) from the engine store.

### Updates

An edited PDF has a new mtime, so its `files` row changes and only its tasks run:

1. `extract/<doc>` re-reads the file. If the text came out identical, the cascade stops here.
2. `chunk/<doc>` re-chunks. Unchanged chunks re-emit equal rows, which changes nothing. A changed
   chunk gets a new id, i.e. a new row.
3. Only the new rows are embedded and indexed. The rows the document no longer emits (the old
   versions of the changed chunks) are retracted, and their index tasks' `dispose` deletes the old
   blocks.

At 1 000 documents × 100 chunks, editing 1 % of the documents (one paragraph each) extracts 10
documents and embeds 10 chunks.

### Deletes

A removed PDF loses its `files` row. Its `extract` task is dead, so `text/<doc>` is retracted. Then
the `chunk` task is dead, so its chunks and layout are retracted. Then every per-chunk task is dead:
embeddings are retracted, and both index cells' `dispose` delete the blocks. Nothing is left in the
engine store or in either index. A file that becomes ignored is handled the same way.

### Keeping the indexes consistent with the engine

The indexes are sinks the engine does not own, and statewalker-search persists them as a whole on
`flush()`. `update()` therefore sets a `sys/index-dirty` row before running and removes it after the
flush, and it flushes only if an index task ran.

When a process opens the index it checks two things:
- the dirty row is still set: a previous process died between the engine commit and the flush;
- the index is empty while the engine says chunks were indexed: the index state was lost.

In either case it clears the index and invalidates the two index cells. The next `update()`
re-indexes from the stored chunks and embeddings, without extracting or embedding again.

## Tests

| Command | What |
|---|---|
| `pnpm test` | indexing, all search modes, no-op, edit, delete, shrink, files persistence + restart, crash recovery, a real-PDF run through `pdfExtractor`, `FilesIndexerPersistence` |
| `pnpm test:massive` | 1 000 documents × ~100 chunks (scale with `DOCS` / `CHUNKS`): cold build, search, 1 % edit, deletes, restart over persisted state, with timings |

## License

MIT
