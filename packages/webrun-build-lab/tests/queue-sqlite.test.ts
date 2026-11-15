import { DatabaseSync } from "node:sqlite";
import { SqlKV } from "../src/core/sql-kv.js";
import { QueueEngine } from "../src/prototypes/queue.js";
import { defineConformance } from "./conformance.js";
import { NodeSqlDriver } from "./node-sql-driver.js";

defineConformance(
  "B queue over SQLite",
  (opts) => new QueueEngine(opts),
  () => new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:"))),
);
