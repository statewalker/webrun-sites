import { createRoot } from "react-dom/client";
import { openMemoryDb } from "./engine/wasm-sql-driver.js";
import { DemoModel } from "./model/demo-model.js";
import { CORPUS } from "./pipeline/corpus.js";
import { App } from "./views/app.js";

const model = await DemoModel.create({ db: await openMemoryDb(), seed: CORPUS, delayMs: 300 });
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");
createRoot(root).render(<App model={model} />);
