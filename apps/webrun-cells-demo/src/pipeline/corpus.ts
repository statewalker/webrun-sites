export const CORPUS: Readonly<Record<string, string>> = {
  "docs/install.md": [
    "Install the package with pnpm. Run pnpm add @statewalker/webrun-cells in your project folder.",
    "The package needs Node 22 or newer. Older Node releases lack the built-in sqlite module.",
    "A browser build needs SQLite compiled to WebAssembly. Serve the wasm file next to your bundle.",
  ].join("\n\n"),
  "docs/config.md": [
    "Configure the engine through constructor options. The lease time defaults to thirty seconds.",
    "Set maxAttempts to change how often a failing input is retried. After the last attempt the input moves to the dead letter table.",
    "The batch size limits how many inputs one cell claims at once. Smaller batches release work sooner.",
  ].join("\n\n"),
  "docs/retraction.md": [
    "Removing a source row retracts everything derived from it. The engine follows provenance and deletes outputs without running cells.",
    "An output produced by two inputs survives until both producers are removed.",
  ].join("\n\n"),
  "docs/cutoff.md": [
    "When a cell emits a value equal to the stored row, the cascade stops. Downstream cells are not queued again.",
    "Early cut-off keeps a small edit cheap. Only the changed block reaches the index cells.",
  ].join("\n\n"),
  "docs/faq.md": [
    "Why SQLite? The queue is a table, so a crash replays at most one uncommitted input.",
    "Can two engines share a database? Yes, leases stop them from running the same input twice.",
  ].join("\n\n"),
};
