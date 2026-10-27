import type { Source } from "@statewalker/webrun-modules";
import { dirOf, readManifest } from "./paths.js";
import type { Importer, Mount, PackageStore } from "./types.js";

const mountPrefix = (name: string, version: string | undefined) =>
  `npm:${name}@${version ?? "0.0.0"}`;

/**
 * Packages from `node_modules` folders, found as Node finds them: in the importing
 * file's directory and each parent, inside the importer's own FilesApi. A package
 * installed in the project (or in another package's `node_modules`) is read where it is.
 *
 * pnpm layouts: a package's own dependencies sit next to its real directory in
 * `node_modules/.pnpm`, which Node reaches through the symlink's real path and a FilesApi
 * cannot see. When the walk finds nothing, each ancestor's `node_modules/.pnpm/node_modules`
 * (pnpm's hoisted links to every installed package) is tried too.
 */
export function nodeModulesPackages(): PackageStore {
  const mounts = new Map<string, Mount>();
  const at = async (files: Mount["files"], root: string, name: string) => {
    const known = mounts.get(root);
    if (known && known.files === files) return known;
    const manifest = await readManifest(files, root);
    if (!manifest) return undefined;
    const mount: Mount = { prefix: mountPrefix(name, manifest.version), files, root, manifest };
    mounts.set(root, mount);
    return mount;
  };
  const ancestors = (path: string) => {
    const dirs: string[] = [];
    for (let dir = dirOf(path); ; dir = dirOf(dir)) {
      dirs.push(dir === "/" ? "" : dir);
      if (dir === "/") return dirs;
    }
  };
  return {
    async get(name, importer) {
      const files = importer.mount.files;
      const dirs = ancestors(importer.path);
      for (const dir of dirs) {
        const m = await at(files, `${dir}/node_modules/${name}`, name);
        if (m) return m;
      }
      for (const dir of dirs) {
        const m = await at(files, `${dir}/node_modules/.pnpm/node_modules/${name}`, name);
        if (m) return m;
      }
      return undefined;
    },
  };
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

/** The version range `importer`'s `package.json` gives `name`, if any. */
function rangeFor(name: string, importer: Importer): string | undefined {
  const m = importer.mount.manifest;
  for (const field of DEPENDENCY_FIELDS) {
    const range = m?.[field]?.[name];
    if (range) return range;
  }
  return undefined;
}

/**
 * Packages fetched on demand (default: the npm registry, through webrun-modules'
 * `npmRegistrySource`) and kept in memory: each one is its own FilesApi tree. The
 * version is the range the importer's `package.json` declares (the project's for the
 * project's files), else the latest; one range loads once.
 */
export function npmPackages(opts: { source?: Source } = {}): PackageStore {
  // Loaded only when used: a bundle of the bundler that brings its own source stays small.
  let registry: Promise<Source> | undefined;
  const source: Source = opts.source ?? {
    matches: (ref) => "pkg" in ref,
    load: async (ref) => {
      registry ??= import("@statewalker/webrun-modules").then((m) => m.npmRegistrySource());
      return (await registry).load(ref);
    },
  };
  const byRange = new Map<string, Promise<Mount>>();
  const byVersion = new Map<string, Mount>();
  return {
    get(name, importer) {
      const range = rangeFor(name, importer);
      const key = `${name}@${range ?? "latest"}`;
      let mount = byRange.get(key);
      if (!mount) {
        mount = source.load({ pkg: name, version: range }).then((p) => {
          const prefix = mountPrefix(p.name, p.version);
          const seen = byVersion.get(prefix);
          if (seen) return seen; // two ranges, one version: one copy of the package
          const m: Mount = { prefix, files: p.files, root: "/", manifest: p.manifest };
          byVersion.set(prefix, m);
          return m;
        });
        byRange.set(key, mount);
      }
      return mount;
    },
  };
}

/** The first store that has the package wins (`node_modules` first, then the registry). */
export function chainPackages(...stores: PackageStore[]): PackageStore {
  return {
    async get(name, importer) {
      let failure: unknown;
      for (const s of stores) {
        try {
          const m = await s.get(name, importer);
          if (m) return m;
        } catch (e) {
          failure ??= e; // the next store may still have it
        }
      }
      if (failure) throw failure;
      return undefined;
    },
  };
}
