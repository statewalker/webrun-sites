import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "../src/index.js";

/**
 * statewalker/webrun-sites#9: a project file importing a path that does not exist
 * fails the build. An empty module emitted into a static tree cannot be repaired at
 * serve time. `onMissingFile` is the opt-in escape hatch.
 */
describe("newProjectBuild — a missing import fails the build", () => {
  it("fails, and emits no empty artifact for the missing path", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.ts", `import { x } from "./nope.js";\nconsole.log(x);`);
    const cache = new MemFilesApi();

    await expect(newProjectBuild({ project, cache }).build()).rejects.toThrow(/main\.ts/);
    expect(await cache.exists("/~/nope.js")).toBe(false);
  });

  it("onMissingFile supplies the source of a missing file", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.ts", `import { x } from "./nope.js";\nconsole.log(x);`);
    const cache = new MemFilesApi();
    const asked: string[] = [];

    await newProjectBuild({
      project,
      cache,
      onMissingFile: (id) => {
        asked.push(id);
        return "export const x = 'stub';";
      },
    }).build();

    expect(asked).toContain("~/nope.js");
    expect(await readText(cache, "/~/nope.js")).toContain("stub");
  });

  it("onMissingFile returning undefined still fails", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.ts", `import { x } from "./nope.js";\nconsole.log(x);`);
    const cache = new MemFilesApi();

    await expect(
      newProjectBuild({ project, cache, onMissingFile: () => undefined }).build(),
    ).rejects.toThrow(/main\.ts/);
  });
});
