import { DatabaseSync } from "node:sqlite";
import { BuildEngine, SqlKV } from "@statewalker/webrun-builder";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { defineConformance } from "./conformance.js";

// The real implementation (packages/webrun-builder) against the same suite:
// one task per commit, the default group commit, concurrent execution, SQLite.
defineConformance(
  "R webrun-builder (batch 1)",
  ({ kv, cells, maxAttempts }) => new BuildEngine({ store: kv, cells, maxAttempts, batchSize: 1 }),
);
defineConformance(
  "R webrun-builder (batch 64)",
  ({ kv, cells, maxAttempts }) => new BuildEngine({ store: kv, cells, maxAttempts }),
);
defineConformance(
  "R webrun-builder (batch 64, concurrency 4)",
  ({ kv, cells, maxAttempts }) =>
    new BuildEngine({ store: kv, cells, maxAttempts, concurrency: 4 }),
);
defineConformance(
  "R webrun-builder over SQLite",
  ({ kv, cells, maxAttempts }) => new BuildEngine({ store: kv, cells, maxAttempts }),
  () => new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:"))),
);
