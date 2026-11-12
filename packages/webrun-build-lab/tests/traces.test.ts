import { TraceEngine } from "../src/prototypes/traces.js";
import { defineConformance } from "./conformance.js";

defineConformance("C traces", (opts) => new TraceEngine(opts));
