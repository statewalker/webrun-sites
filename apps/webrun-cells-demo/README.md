# @statewalker/webrun-cells-demo

A React single-page app that runs the real `@statewalker/webrun-cells` `CellEngine` on an in-browser
sqlite-wasm database. It re-indexes a handful of fake files (split, summarize, FTS index and vector
index) and answers questions about them (plan, search, rerank, condense, answer). Every AI step is a
deterministic fake, and every stage is visualised: the cell graph with queue counts, a step log, and
an inspector for the rows each stage produced. Edit or delete a file and watch which cells re-run.

## Layout

```
src/
  engine/     WasmSqlDriver: adapts sqlite-wasm (oo1.DB) to the SqlDriver the engine expects
  pipeline/   the cells (index-cells.ts, question-cells.ts), the fakes, the seed corpus, createPipeline
  model/      DemoModel: owns the engine, runs it, publishes snapshots (files, log, queue counts)
  views/      React panels: files, graph, log, inspector, ask bar (read the model, never the engine)
  components/ui/  shadcn-style primitives
public/       index.html, copied into dist/
scripts/      copy-assets.js (html + sqlite3.wasm into dist/), dev.js (watch build + server)
```

## How to run it

1. From the repository root, install: `pnpm install`.
2. Build the workspace packages the app imports: `pnpm --filter "@statewalker/webrun-cells-demo^..." run build`.
3. Start the dev server: `pnpm --filter @statewalker/webrun-cells-demo dev`.
4. Open `http://localhost:5180`.
5. Try it: edit a paragraph in a file (pencil icon) and watch only that block re-index; ask
   "how do I install it and what is the lease time?" in the bar at the bottom and select the question
   to see each stage's output in the inspector.

For a one-off production build served statically: `pnpm --filter @statewalker/webrun-cells-demo build`
then `pnpm --filter @statewalker/webrun-cells-demo preview` (also port 5180).

## Why the engine is real, not a simulation

The queue counts, early cut-off and retraction you see are the engine's own behaviour on a
real SQL database, so nothing on screen can drift from what the library does. Only the work inside
the cells is faked, and the fakes are deterministic on purpose: summaries are extractive (first
sentence; a file summary is the first three block summaries), vectors are 256-dimension hashed
bag-of-words with a cosine floor of 0.3, BM25 runs in JS, and the reranker is reciprocal-rank fusion.
Equal text therefore gives equal rows, and the engine's early cut-off (a cell emitting a value equal
to the stored row stops the cascade) becomes observable. A model with random output would never cut
off. The vector size is 256 because with 64 buckets unrelated words collide often enough that a
nonsense query still gets vector hits.

## Why the graph has a coarse summarize cell and one shared search cell

The engine has no aggregation or joins yet. Summarizing is therefore one cell per whole file
(`file-blocks` in, block summaries and the file summary out), because a per-block cell could not
assemble a file summary. Likewise FTS and vector search share the single `search` cell: a cell
cannot join two inputs, and the rerank step needs both candidate lists. The `search` cell reads the
index rows itself through the engine's `list`, which is why it does not depend on the index signals
(see "What will surprise you").

## Why one input runs at a time

One engine drives all cells, handling one input at a time. The FTS and vector cells are independent
and could run in parallel, but they do not. The sequential order is what makes the log and the
"running" badge readable, and the step delay (0 to 1000 ms, default 300) is applied before each cell
handles an input so you can watch the cascade.

## What will surprise you

- **Answers are a snapshot of the index at ask time.** Editing a file afterwards does not change an
  existing answer. Use "Ask again" in the question's inspector to re-run it.
- **A question waits for indexing.** `ask()` waits until indexing has drained before the question
  enters the engine, because `search` would otherwise read a half-built index. At a high step delay
  the question first shows as "waiting for indexing…" in the ask bar.
- **Inserting or removing a paragraph re-indexes every later block.** Blocks are keyed
  `path#<number>`, so numbers shift. An in-place edit re-indexes only the changed block: the other
  blocks produce equal rows and the cascade stops there.
- **Queue counts come straight from the engine's `cells_pending` table**, queried through the SQL
  driver, not from the demo's own bookkeeping.
- **A page reload resets everything.** The database is `:memory:`; the seed files return, questions
  and edits are gone.
- **A blank page whose console reads "wasm streaming compile failed: TypeError: Failed to execute
  'compile' on 'WebAssembly': HTTP status code is not ok"**, followed by "failed to asynchronously
  prepare wasm: both async and sync fetching of the wasm failed" and finally "Exception loading
  sqlite3 module: RuntimeError: Aborted(both async and sync fetching of the wasm failed)" means
  `dist/sqlite3.wasm` is missing (the 404 itself shows only in the Network panel). The build copies
  it (`scripts/copy-assets.js`), so run `build` (or `dev`, which runs the copy at startup) rather
  than only bundling.
- **`preview` can serve a truncated bundle after a rebuild.** `sirv` without `--dev` caches file
  sizes at startup, so a rebuilt `main.js` that is larger is cut off and the console shows
  "Unexpected end of input". Restart `preview`. `dev` runs `sirv --dev` and is not affected.
- **The port is requested as 5180, not guaranteed.** If 5180 is taken, `sirv` prints "Port 5180 is
  taken; using <n> instead" and serves there; open the URL it prints, not 5180.

## Commands

Run from `apps/webrun-cells-demo` (or with `pnpm --filter @statewalker/webrun-cells-demo <script>`).

| Script | What it does |
| --- | --- |
| `build` | rolldown bundle to `dist/main.js`, tailwind to `dist/styles.css`, copy `index.html` and `sqlite3.wasm` |
| `dev` | copy assets, then rolldown `--watch`, tailwind `--watch` and `sirv dist --dev` on port 5180 |
| `preview` | `sirv dist --port 5180` (no `--dev`; restart after a rebuild) |
| `test` | `vitest run` |
| `typecheck` | `tsc --noEmit` |

## Signals and cells

| Cell | Reads | Writes | Notes |
| --- | --- | --- | --- |
| `split` | `files` | `file-blocks` | paragraphs split on blank lines |
| `summarize` | `file-blocks` | `block-summaries` (`path#n`), `file-summaries` | whole-file cell |
| `fts-index` | `block-summaries` | `fts-terms` | term frequencies and length |
| `vector-index` | `block-summaries` | `vectors` | 256-dim hashed bag-of-words |
| `plan` | `questions` | `queries` | split on `?`, `;`, "and" |
| `search` | `queries` | `candidates` | BM25 and cosine over listed rows, top 5 each |
| `rerank` | `candidates` | `ranked` | reciprocal-rank fusion, k = 60, top 5 |
| `condense` | `ranked` | `context` | first sentence of the top 3 |
| `answer` | `context` | `answers` | joined summaries plus cited paths, or "No indexed content matches this question." |
