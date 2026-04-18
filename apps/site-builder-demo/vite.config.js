import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Same-origin ServiceWorker mode (no relay): copy webrun-http-browser's
// pre-built SW runtime to `/sw-worker.js` at the site root. Its default
// scope is the site root (`/`), so the outer page sits under SW control —
// required by `SwHttpAdapter.start()` which waits for the controller.
const swRuntime = fileURLToPath(
  new URL("./node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js", import.meta.url),
);

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [{ src: swRuntime, dest: "." }],
    }),
  ],
  build: {
    // src/main.ts uses top-level await; modern target lets esbuild keep it.
    target: "esnext",
  },
  server: {
    port: 5173,
    fs: {
      // pnpm symlinks webrun-http-browser; allow the workspace root so the
      // pre-built SW runtime is readable.
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
