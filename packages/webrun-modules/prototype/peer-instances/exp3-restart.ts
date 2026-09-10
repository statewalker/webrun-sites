/**
 * PROTOTYPE — experiment 3. Instance pins must survive a server restart.
 * Run 1 transforms oxc's graph. Before run 2 the transformed instance files are
 * evicted (a partially warm cache), so run 2 transforms them again in a process
 * that never created the instance. It must still bind the pinned emnapi.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { emnapiBindings, PROCESS_WITH_CWD, report, runInBrowser, startServer } from "./harness.js";

const s1 = await startServer({ globals: PROCESS_WITH_CWD });
report("exp3 · run 1 (cold)", await runInBrowser(s1.base, ["oxc"]), await emnapiBindings(s1.cacheDir));
await s1.close();

// Evict only the wasm-runtime INSTANCE artifacts; the binding's proxy (which
// names the instance URL) stays cached, exactly as after a partial eviction.
await rm(join(s1.cacheDir, "t/browser/@napi-rs"), { recursive: true, force: true });

const s2 = await startServer({ globals: PROCESS_WITH_CWD, cacheDir: s1.cacheDir });
report("exp3 · run 2 (restart, instance evicted)", await runInBrowser(s2.base, ["oxc"]), await emnapiBindings(s2.cacheDir));
await s2.close();
