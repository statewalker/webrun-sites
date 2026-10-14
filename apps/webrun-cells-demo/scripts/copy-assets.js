import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
mkdirSync(dist, { recursive: true });

copyFileSync(new URL("public/index.html", root), new URL("index.html", dist));
copyFileSync(
  fileURLToPath(import.meta.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm")),
  new URL("sqlite3.wasm", dist),
);
