/** PROTOTYPE — diagnose rolldown's failure under its own emnapi pin. */
import { startServer } from "./harness.js";

const PLAYWRIGHT = "/home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
const lock = { "@emnapi/core": "2.0.0-alpha.4", "@emnapi/runtime": "2.0.0-alpha.4" };
const s = await startServer({ lock });
const { chromium } = await import(PLAYWRIGHT);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m: any) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e: any) => console.log(`  [pageerror] ${e.message}`));
page.on("requestfailed", (r: any) => console.log(`  [requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r: any) => { if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.url()}`); });
page.on("worker", (w: any) => console.log(`  [worker] ${w.url()}`));
await page.goto(`${s.base}/`);
const FN = `async (base) => {
  const describe = (v) => {
    if (v == null) return String(v);
    const o = { type: Object.prototype.toString.call(v) };
    for (const k of Object.getOwnPropertyNames(v)) { try { o[k] = String(v[k]).slice(0, 400); } catch {} }
    if (v && v.error) o.inner = describe(v.error);
    if (v && v.errorOutputs) o.errorOutputs = JSON.stringify(v.errorOutputs).slice(0, 600);
    return o;
  };
  let step = "import";
  try {
    const { rolldown } = await import(base + "/@rolldown/browser@1.2.8/dist/index.browser.mjs");
    step = "rolldown()";
    const bundle = await rolldown({ input: "entry", plugins: [{ name: "v",
      resolveId: (id) => (id === "entry" ? id : null),
      load: (id) => (id === "entry" ? "export const x = 40 + 2;" : null) }] });
    step = "generate()";
    const { output } = await bundle.generate({ format: "esm" });
    return { ok: true, code: output[0].code };
  } catch (e) {
    return { ok: false, step, thrown: describe(e) };
  }
}`;
const r = await page.evaluate(([src, base]: [string, string]) => (0, eval)(`(${src})`)(base), [FN, s.base] as [string, string]);
console.log(JSON.stringify(r, null, 2));
await browser.close();
await s.close();
