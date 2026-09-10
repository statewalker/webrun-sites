/**
 * Peer-qualified package instances.
 *
 * A package that declares `peerDependencies` expects its CONSUMER to supply them,
 * but every module root has one `~deps/` of static proxy files — one version per
 * peer. So a package is served once per distinct resolution of its peers: the
 * instance root `name@version_p.<tag>` carries that resolution in its VERSION
 * segment, where every `name@version` parser (`depsRoot`, `proxyId`, the server's
 * URL mapping) captures the whole root unchanged and gives the instance its own
 * `~deps/`. Only reads of `/raw` strip the tag — the raw files are shared.
 *
 * `_` is the separator because it cannot occur in a semver version and is
 * URL-unreserved. `+` would be ambiguous (semver build metadata) and S3-style
 * static hosts decode a `+` in a path as a space.
 *
 * The tag is a hash, so the pins cannot be recovered from a URL: they are written
 * to `/instances/<root>.json` before the root is ever emitted.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";

/** Peer name → the exact version an instance binds it to. */
export type PeerPins = Record<string, string>;

const PEER_TAG = /_p\.[0-9a-f]{16}$/;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** The `/raw` cache key behind a module root: the plain `name@version`. */
export function rawKey(root: string): string {
  return root.replace(PEER_TAG, "");
}

export function isInstanceRoot(root: string): boolean {
  return PEER_TAG.test(root);
}

/** Pins with their keys sorted, so equal pins serialize identically. */
function sorted(pins: PeerPins): PeerPins {
  return Object.fromEntries(
    Object.keys(pins)
      .sort()
      .map((k) => [k, pins[k]]),
  );
}

/** `_p.` + a 64-bit FNV-1a hash of the sorted `name@version` pins, as 16 hex digits. */
export function peerTag(pins: PeerPins): string {
  const text = Object.entries(sorted(pins))
    .map(([name, version]) => `${name}@${version}`)
    .join(",");
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return `_p.${hash.toString(16).padStart(16, "0")}`;
}

/** The module root for `plainKey` bound to `pins`; the plain key when nothing is pinned. */
export function instanceRoot(plainKey: string, pins: PeerPins): string {
  return Object.keys(pins).length === 0 ? plainKey : plainKey + peerTag(pins);
}

export function instanceSidecarPath(root: string): string {
  return `/instances/${root}.json`;
}

/**
 * Record an instance's pins. Written once: repeating the same pins is a no-op, and
 * different pins under an existing root mean two resolutions hashed to one tag —
 * overwriting would silently rebind every file already emitted under it.
 */
export async function persistInstance(
  cache: FilesApi,
  root: string,
  pins: PeerPins,
): Promise<void> {
  const path = instanceSidecarPath(root);
  const body = JSON.stringify(sorted(pins));
  const existing = await tryReadText(cache, path);
  if (existing === undefined) {
    await writeText(cache, path, body);
    return;
  }
  if (existing !== body) {
    throw new Error(`peer tag collision for ${root}: stored ${existing}, minting ${body}`);
  }
}

/** An instance root's pins, or `undefined` for a plain root or a root never minted. */
export async function readInstancePins(
  cache: FilesApi,
  root: string,
): Promise<PeerPins | undefined> {
  if (!isInstanceRoot(root)) return undefined;
  const text = await tryReadText(cache, instanceSidecarPath(root));
  return text === undefined ? undefined : (JSON.parse(text) as PeerPins);
}
