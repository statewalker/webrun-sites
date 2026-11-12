import { QueueEngine } from "../src/prototypes/queue.js";
import { defineConformance } from "./conformance.js";

defineConformance("B queue", (opts) => new QueueEngine(opts));
