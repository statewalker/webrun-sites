import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newDefaultTransform, type Transform } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

describe("newProjectBuild — failures are retried by the next build", () => {
  it("a source that failed (e.g. a broken dependency) is retried without touching its file", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.ts", `export const x = 1;`);
    const real = newDefaultTransform();
    let broken = true;
    const transform: Transform = {
      transform(file, rewrite) {
        if (broken) throw new Error("transient failure");
        return real.transform(file, rewrite);
      },
    };
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project, cache, transform });
    await expect(build.build()).rejects.toThrow(/failed to build/);
    broken = false; // e.g. the dependency was fixed elsewhere
    const { served } = await build.build();
    expect(served).toContain("/~/main.js");
    expect(await readText(cache, "/~/main.js")).toContain("x = 1");
  });
});
