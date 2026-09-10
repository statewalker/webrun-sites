import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import semver from "semver";
import type { PackageManifest, Source } from "../src/types.js";

/** One published version: its files plus the manifest fields resolution reads. */
export interface FixtureVersion {
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

/** name → version → what that version contains. */
export type FixtureRegistry = Record<string, Record<string, FixtureVersion>>;

/**
 * An in-memory `Source` over several versions per package, resolving a range to
 * its highest satisfying version the way the npm source does. `loads` counts
 * source loads per package name, so a test can prove something was NOT fetched.
 */
export function registrySource(pkgs: FixtureRegistry, loads: Record<string, number> = {}): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      loads[ref.pkg] = (loads[ref.pkg] ?? 0) + 1;
      const spec = ref.version ?? "*";
      const version = semver.maxSatisfying(
        Object.keys(pkgs[ref.pkg]),
        semver.validRange(spec) ? spec : "*",
        { includePrerelease: true },
      );
      const entry = version ? pkgs[ref.pkg][version] : undefined;
      if (!version || !entry) throw new Error(`fixture has no ${ref.pkg}@${spec}`);
      const { files: content, ...fields } = entry;
      const files = new MemFilesApi();
      for (const [path, text] of Object.entries(content)) await writeText(files, `/${path}`, text);
      return {
        name: ref.pkg,
        version,
        files,
        manifest: {
          name: ref.pkg,
          version,
          type: "module",
          main: "./index.js",
          ...fields,
        } as PackageManifest,
      };
    },
  };
}
