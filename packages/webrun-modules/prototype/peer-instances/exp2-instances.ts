/**
 * PROTOTYPE — experiment 2 (needs the spike on branch proto/peer-instances).
 * One server, one page, BOTH packages, no pin. Peer-qualified instances must let
 * each consumer of @napi-rs/wasm-runtime get the emnapi it declares — in either
 * load order, since an order-dependent answer would only be a lock race.
 */
import { emnapiBindings, PROCESS_WITH_CWD, report, runInBrowser, startServer } from "./harness.js";

for (const order of [["oxc", "rolldown"], ["rolldown", "oxc"]] as const) {
  const s = await startServer({ globals: PROCESS_WITH_CWD });
  try {
    const results = await runInBrowser(s.base, [...order]);
    report(`exp2 · one server, one page, order ${order.join(" → ")}`, results, await emnapiBindings(s.cacheDir));
  } finally {
    await s.close();
  }
}
