import { imports as resolveImports, exports as resolvePackageExports } from "resolve.exports";
import { dirOf, isFile, joinWithin, parsePackageSpecifier } from "./paths.js";
import type { Importer, Mount, PackageManifest, PackageStore } from "./types.js";

/** Extensions tried, in order, for a path written without one (or with `.js` for a `.ts` file). */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

export interface Resolved {
  mount: Mount;
  path: string;
}

/** `path` as written, else with an extension, else its `index` file. */
async function resolveFile(mount: Mount, path: string): Promise<string | undefined> {
  if (await isFile(mount, path)) return path;
  // TypeScript sources import `./x.js` for `./x.ts`.
  const js = /\.(m|c)?jsx?$/.exec(path);
  if (js) {
    const base = path.slice(0, -js[0].length);
    for (const ext of [`.${js[1] ?? ""}ts`, ".tsx"])
      if (await isFile(mount, base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) if (await isFile(mount, path + ext)) return path + ext;
  const dir = path.endsWith("/") ? path.slice(0, -1) : path;
  for (const ext of EXTENSIONS)
    if (await isFile(mount, `${dir}/index${ext}`)) return `${dir}/index${ext}`;
  return undefined;
}

type Conditions = { conditions: string[]; require: boolean; browser: boolean };

function exportsTarget(
  manifest: PackageManifest,
  entry: string,
  c: Conditions,
): string | undefined {
  try {
    const out = resolvePackageExports(manifest, entry, {
      conditions: c.conditions,
      require: c.require,
      browser: c.browser,
    }) as string[] | undefined;
    return out?.[0];
  } catch {
    return undefined;
  }
}

/** A package's file for `subpath`: `exports` first, then `module`/`main` (and `browser` when it is a string). */
async function resolvePackageEntry(
  mount: Mount,
  subpath: string | undefined,
  c: Conditions,
): Promise<string | undefined> {
  const manifest = mount.manifest ?? {};
  const entry = subpath ? `./${subpath}` : ".";
  if (manifest.exports !== undefined) {
    const target = exportsTarget(manifest, entry, c);
    if (!target) return undefined; // not exported: Node refuses it as well
    return joinWithin(mount.root, mount.root, target);
  }
  if (subpath) return resolveFile(mount, joinWithin(mount.root, mount.root, subpath) ?? "");
  const fields = [
    ...(c.browser && typeof manifest.browser === "string" ? [manifest.browser] : []),
    ...(c.require ? [] : [manifest.module]),
    manifest.main,
    "index.js",
  ].filter((f): f is string => typeof f === "string");
  for (const f of fields) {
    const p = joinWithin(mount.root, mount.root, f);
    const file = p && (await resolveFile(mount, p));
    if (file) return file;
  }
  return undefined;
}

/**
 * Resolves `spec` as written in `importer`: a path of the same tree (`./x`, `../y.js`,
 * `/z`), a `#imports` alias of the importer's package, or a package found by `packages`
 * (with its `exports`, `module` and `main`).
 */
export async function resolveSpecifier(
  spec: string,
  importer: Importer,
  packages: PackageStore,
  c: Conditions,
): Promise<Resolved | undefined> {
  const { mount } = importer;
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec === ".") {
    const base = spec.startsWith("/") ? mount.root : dirOf(importer.path);
    const target = joinWithin(mount.root, base, spec.startsWith("/") ? spec.slice(1) : spec);
    const path = target && (await resolveFile(mount, target));
    return path ? { mount, path } : undefined;
  }
  if (spec.startsWith("#")) {
    try {
      const out = resolveImports(mount.manifest ?? {}, spec, {
        conditions: c.conditions,
        require: c.require,
        browser: c.browser,
      }) as string[] | undefined;
      const target = out?.[0];
      if (!target) return undefined;
      if (!target.startsWith(".")) return resolveSpecifier(target, importer, packages, c);
      const path = joinWithin(mount.root, mount.root, target);
      return path && (await isFile(mount, path)) ? { mount, path } : undefined;
    } catch {
      return undefined;
    }
  }
  const { name, subpath } = parsePackageSpecifier(spec);
  const pkg = await packages.get(name, importer);
  if (!pkg) return undefined;
  const path = await resolvePackageEntry(pkg, subpath, c);
  return path && (await isFile(pkg, path)) ? { mount: pkg, path } : undefined;
}
