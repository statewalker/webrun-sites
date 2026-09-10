/**
 * PROTOTYPE — experiment 1 (zero code change).
 * Pin @emnapi/* server-wide through the lockfile. If the emnapi version is the
 * whole cause, each package works under exactly ONE pin, and no pin serves both.
 */
import { emnapiBindings, PROCESS_WITH_CWD, report, runInBrowser, startServer } from "./harness.js";

const CONFIGS = [
  { title: "current behaviour (no pin)", lock: undefined },
  { title: "lock @emnapi/* = 1.11.2 (oxc's pin)", lock: { "@emnapi/core": "1.11.2", "@emnapi/runtime": "1.11.2" } },
  { title: "lock @emnapi/* = 2.0.0-alpha.4 (rolldown's pin)", lock: { "@emnapi/core": "2.0.0-alpha.4", "@emnapi/runtime": "2.0.0-alpha.4" } },
];

for (const c of CONFIGS) {
  // Each package on its OWN fresh server, so the verdict is about the pin, not order.
  const results = [];
  const bindings: string[] = [];
  for (const pkg of ["oxc", "rolldown"] as const) {
    const s = await startServer({ lock: c.lock, globals: PROCESS_WITH_CWD });
    try {
      results.push(...(await runInBrowser(s.base, [pkg])));
      bindings.push(...(await emnapiBindings(s.cacheDir)));
    } finally {
      await s.close();
    }
  }
  report(`exp1 · ${c.title}`, results, [...new Set(bindings)]);
}
