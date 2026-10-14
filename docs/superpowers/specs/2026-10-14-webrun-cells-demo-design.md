# webrun-cells demo — design

**Date:** 2026-10-14 · **Status:** approved in conversation (design sections 1–3), "go" given.

## Purpose

A single-page app that runs the real `@statewalker/webrun-cells` `CellEngine` in the browser and shows,
stage by stage, how a small corpus of fake files is re-indexed when the user edits it, and how a question is
answered from that index. Its point is to make the engine's behaviour visible: per-input queueing, early
cut-off of unchanged outputs, retraction on delete, and which cells actually ran for a change.

## Decisions

| Topic | Decision |
| --- | --- |
| Location | `apps/webrun-cells-demo`, package `@statewalker/webrun-cells-demo`, `private: true` |
| Stack | React 19, Tailwind v4, shadcn/ui components copied into `src/components/ui`, Vitest, Biome |
| Bundler | Rolldown directly (`rolldown -c`); CSS via `@tailwindcss/cli`; `dev` = both in watch mode + `sirv-cli` |
| Engine | Real `CellEngine`, one instance, single runner |
| Storage | `@sqlite.org/sqlite-wasm`, in-memory DB, behind `WasmSqlDriver implements SqlDriver`; reload resets |
| AI steps | Fake and deterministic: extractive summaries, 256-dim hashed bag-of-words vectors (vector hits need cosine ≥ 0.3), BM25 in JS; a per-stage delay from a speed slider |
| Parallelism | None. FTS and vector cells are labelled *independent* in the UI. Detecting and running independent stages in parallel is future engine work (todo) |
| Aggregation | Coarse `summarize` cell: consumes the per-file block list, emits every block summary and the file summary. Engine has no `groupBy` yet |
| Joins | FTS and vector search share one `search` cell, because `rerank` must join both and the engine cannot join two producers into one key yet |
| Question freshness | `search` reads the index with `engine.list()` (unrecorded read): an answer is a snapshot at ask time; asking again changes `askedAt` and re-queues |
| Queue view | The UI reads `cells_pending` directly (read-only peek at engine internals), grouped by cell |

## Signals and cells

Indexing — source `files` (path → text):

```
files            ─split────────▶ file-blocks      (path → string[])
file-blocks      ─summarize────▶ block-summaries  (path#n → {path, n, text, summary})
                               └▶ file-summaries   (path → string)
block-summaries  ─fts-index────▶ fts-terms        (path#n → {path, terms: {term: tf}, length})
block-summaries  ─vector-index─▶ vectors          (path#n → {path, vector: number[256]})
```

Questions — source `questions` (id → {text, askedAt}):

```
questions  ─plan──────▶ queries     (id → {text, subqueries: string[]})
queries    ─search────▶ candidates  (id → {fts: Hit[], vector: Hit[]})
candidates ─rerank────▶ ranked      (id → Hit[])            Hit = {key, path, score, text}
ranked     ─condense──▶ context     (id → {key, path, summary}[])
context    ─answer────▶ answers     (id → {text, citations: string[]})
```

## UI

Files | Graph | Inspector, Ask bar at the bottom.

- Files: list of paths; click opens an editor dialog; "random edit" changes one sentence; new / delete file.
- Graph: the cells of both pipelines with their signals, the running cell highlighted, pending count per cell
  (from `cells_pending`), FTS/vector siblings marked independent.
- Log: one line per cell input (cell, key, started/done/failed).
- Inspector: for a selected file, its rows at each stage; for a selected question, each step's row through to
  the answer with citations.
- Each change calls `engine.run()`; cells are wrapped so start/emit/done/fail events reach the UI.

## Testing (public seams only, red/green TDD)

All under Vitest in Node.

- `WasmSqlDriver`: the engine converges a two-cell chain on sqlite-wasm, and `transaction` rolls back on failure.
- `createPipeline({ db, delayMs: 0, onEvent })` over `NodeSqlDriver`: seeded corpus converges; a one-sentence edit
  runs `vector-index` and `fts-index` only for the changed block; deleting a file removes its rows from every
  signal; a seeded-topic question is answered citing the right file; asking the same text again re-queues it.
- `DemoModel` (framework-free state behind the views): edit / delete / ask update its snapshot (rows per stage,
  pending counts, log) after the run settles.
- No React component tests; the views render a `DemoModel` snapshot. Verified by build, typecheck and a browser smoke.

## Out of scope

Real LLMs/embeddings; persistence across reloads; running the engine in a worker; parallel execution;
React component tests.
