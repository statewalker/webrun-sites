import { CursorEngine } from "../src/prototypes/cursors.js";
import { defineConformance } from "./conformance.js";

defineConformance("A cursors", (opts) => new CursorEngine(opts));
