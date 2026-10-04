/**
 * HTTP basic auth helpers.
 *
 * `newBasicAuth(credentials)` builds an auth predicate compatible with
 * `SiteBuilder.setAuth`: returns a 401 challenge when the `Authorization`
 * header is missing or invalid, and `undefined` when the request is
 * authorized.
 */

export interface BasicAuthOptions {
  /** Realm shown in the `WWW-Authenticate` challenge. Defaults to `"Protected"`. */
  realm?: string;
}

/**
 * Build a basic-auth predicate from a map of `username → password`.
 *
 * The returned function returns a `401` `Response` when the request lacks
 * a matching `Authorization: Basic …` header, or `undefined` when the
 * credentials check out and the request should be allowed through.
 */
export function newBasicAuth(
  credentials: Record<string, string>,
  { realm = "Protected" }: BasicAuthOptions = {},
): (request: Request) => Response | undefined {
  const challenge = new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` },
  });
  return (request: Request): Response | undefined => {
    const header = request.headers.get("Authorization");
    if (!header?.startsWith("Basic ")) return challenge.clone();
    const decoded = tryDecodeBase64(header.substring("Basic ".length).trim());
    if (decoded === null) return challenge.clone();
    const sep = decoded.indexOf(":");
    if (sep < 0) return challenge.clone();
    const username = decoded.substring(0, sep);
    const password = decoded.substring(sep + 1);
    const expected = credentials[username];
    if (expected === undefined) return challenge.clone();
    if (!constantTimeEqual(password, expected)) return challenge.clone();
    return undefined;
  };
}

function tryDecodeBase64(input: string): string | null {
  try {
    // `atob` gives a binary string; decode as UTF-8 for non-ASCII credentials.
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Length-independent equality check. Prevents a timing oracle from leaking
 * the prefix of the expected password. Both arguments are compared up to
 * the longer length so equal-prefix-unequal-length pairs don't short-circuit.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i)) | 0;
  }
  return diff === 0;
}
