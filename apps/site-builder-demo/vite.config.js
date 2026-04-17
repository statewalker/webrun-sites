import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// The relay mode needs the ServiceWorker + its HTML shim to live at a stable
// URL on the site origin. Copy `@statewalker/webrun-http-browser`'s
// `public-relay/` out of node_modules into the dev/build output as
// `/public-relay/`. Resolve via node_modules so pnpm's symlinks work.
const packageRoot = fileURLToPath(
  new URL("./node_modules/@statewalker/webrun-http-browser/", import.meta.url),
);

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        // `relay.html` and `relay-sw.js` both reference sibling files at
        // `../dist/index.js` and `../dist/relay-sw.js`. Copy both folders
        // out of node_modules so the paths resolve at runtime.
        { src: `${packageRoot}public-relay/*`, dest: "public-relay" },
        { src: `${packageRoot}dist/index.js`, dest: "dist" },
        { src: `${packageRoot}dist/relay-sw.js`, dest: "dist" },
      ],
    }),
  ],
  build: {
    // We use top-level await in src/main.js; modern target lets esbuild keep it.
    target: "esnext",
  },
  server: {
    port: 5173,
    fs: {
      // pnpm links webrun-http-browser into a workspace-local node_modules
      // symlink. Vite's default fs guard restricts reads to the project root;
      // allow the workspace root so the relay package is visible.
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
