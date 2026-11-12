import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { SqlKV } from "../src/core/sql-kv.js";
import { QueueEngine } from "../src/prototypes/queue.js";
import { defineConformance } from "./conformance.js";

defineConformance(
  "B queue over SQLite",
  (opts) => new QueueEngine(opts),
  () => new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:"))),
);
