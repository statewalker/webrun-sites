/// <reference lib="webworker" />
// Runs in a Dedicated Worker: esbuild-wasm bundles a project whose files live in OPFS
// (webrun-files-browser), with a package in its node_modules that ships compiled JS and a
// linked map to its TypeScript. Reports the bundle's result and where its lines trace to.
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import * as esbuild from "esbuild-wasm";
import { bundle } from "../src/index.js";

const PKG_SRC = `/** Greeting helpers. */
export interface Options {
  punctuation?: string;
}

export async function greet(name: string, opts: Options = {}): Promise<string> {
  await Promise.resolve();
  return "hello " + name + (opts.punctuation ?? "!") + "MARK_PKG".slice(99);
}
`;
const APP = `import { greet } from "greeter";

export async function main(name: string): Promise<string> {
  const g = (await greet(name)) + "MARK_APP".slice(99);
  return g.toUpperCase();
}
`;

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<{ wasmURL: string }>) => {
  try {
    await esbuild.initialize({ wasmURL: e.data.wasmURL, worker: false });
    const opfs = await getOPFSFilesApi();
    const root = `/bundler-e2e-${Math.random().toString(36).slice(2)}`;
    const write = (path: string, text: string) =>
      opfs.write(`${root}${path}`, [new TextEncoder().encode(text)]);
    // The package as npm ships it: compiled by esbuild-wasm here, map linked, no sourcesContent.
    const compiled = await esbuild.transform(PKG_SRC, {
      loader: "ts",
      sourcefile: "../src/index.ts",
      sourcemap: "external",
      format: "esm",
    });
    const pkgMap = JSON.parse(compiled.map);
    delete pkgMap.sourcesContent;
    await write("/src/app.ts", APP);
    await write(
      "/node_modules/greeter/package.json",
      JSON.stringify({
        name: "greeter",
        version: "3.1.4",
        type: "module",
        exports: "./dist/index.js",
      }),
    );
    await write(
      "/node_modules/greeter/dist/index.js",
      `${compiled.code}//# sourceMappingURL=index.js.map\n`,
    );
    await write("/node_modules/greeter/dist/index.js.map", JSON.stringify(pkgMap));
    await write("/node_modules/greeter/src/index.ts", PKG_SRC);

    const r = await bundle({ esbuild, files: opfs, root, entry: "/src/app.ts", lowerAwait: true });
    const url = URL.createObjectURL(new Blob([r.code], { type: "text/javascript" }));
    const answer = await (await import(/* @vite-ignore */ url)).main("bob");

    const tm = new TraceMap(r.map as never);
    const lines = r.code.split("\n");
    const traceOf = (marker: string) => {
      const line = lines.findIndex((l) => l.includes(marker));
      const text = lines[line] ?? "";
      for (let column = 0; column < text.length; column++) {
        const p = originalPositionFor(tm, { line: line + 1, column });
        if (p.source) return { source: p.source, line: p.line };
      }
      return null;
    };
    const lineOf = (text: string, marker: string) =>
      text.split("\n").findIndex((l) => l.includes(marker)) + 1;
    await opfs.remove(root);
    scope.postMessage({
      ok: true,
      answer,
      hasAwait: /\bawait\b/.test(r.code),
      app: traceOf("MARK_APP"),
      appExpected: { source: "~/src/app.ts", line: lineOf(APP, "MARK_APP") },
      pkg: traceOf("MARK_PKG"),
      pkgExpected: { source: "npm:greeter@3.1.4/src/index.ts", line: lineOf(PKG_SRC, "MARK_PKG") },
      pkgContent:
        r.map.sourcesContent?.[r.map.sources.indexOf("npm:greeter@3.1.4/src/index.ts")] === PKG_SRC,
    });
  } catch (err) {
    scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
