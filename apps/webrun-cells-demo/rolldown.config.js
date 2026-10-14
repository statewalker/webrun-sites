import { defineConfig } from "rolldown";

// An app bundle: everything is inlined (unlike the published libraries, which use rolldown.preset.js).
export default defineConfig({
  input: "src/main.tsx",
  platform: "browser",
  // radix-ui / lucide-react ship "use client" directives, meaningless in a client-only bundle
  onLog(level, log, handler) {
    if (log.code !== "MODULE_LEVEL_DIRECTIVE") handler(level, log);
  },
  transform: {
    jsx: "react-jsx",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "main.js",
    minify: true,
  },
});
