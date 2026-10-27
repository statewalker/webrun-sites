import { normalizePath, tryReadText } from "@statewalker/webrun-files";
import type { Mount, PackageManifest } from "./types.js";

/** `path` joined to `dir`, with `.` and `..` resolved; `undefined` when it leaves `root`. */
export function joinWithin(root: string, dir: string, path: string): string | undefined {
  const parts = (path.startsWith("/") ? path : `${dir}/${path}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(p);
  }
  const joined = `/${out.join("/")}`;
  const r = normalizePath(root);
  return r === "/" || joined === r || joined.startsWith(`${r}/`) ? joined : undefined;
}

export const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** The id of a mount's file: `<prefix>/<path below root>`. */
export function idOf(mount: Mount, path: string): string {
  const r = normalizePath(mount.root);
  const rel = r === "/" ? path : path.slice(r.length);
  return `${mount.prefix}${rel || "/"}`;
}

/** A mount's file from its id; `undefined` when the id is not the mount's. */
export function pathOf(mount: Mount, id: string): string | undefined {
  if (!id.startsWith(`${mount.prefix}/`)) return undefined;
  const r = normalizePath(mount.root);
  const rel = id.slice(mount.prefix.length);
  return r === "/" ? rel : `${r}${rel}`;
}

export async function isFile(mount: Mount, path: string): Promise<boolean> {
  const s = await mount.files.stats(path);
  return s?.kind === "file";
}

export async function readManifest(
  files: Mount["files"],
  dir: string,
): Promise<PackageManifest | undefined> {
  const text = await tryReadText(files, `${dir === "/" ? "" : dir}/package.json`);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** `react` → `{ name: "react" }`; `@a/b/c.js` → `{ name: "@a/b", subpath: "c.js" }`. */
export function parsePackageSpecifier(spec: string): { name: string; subpath?: string } {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const subpath = parts.slice(n).join("/");
  return subpath ? { name, subpath } : { name };
}
