/**
 * Key-tuple encoding for the ordered store. Parts are joined with U+0001, which
 * sorts below every printable character, so a prefix of parts is a prefix of
 * the key and tuples sort part by part. (Not U+0000: SQLite truncates TEXT at
 * NUL.) Collection names, builder ids and row keys must not contain U+0000–U+0002.
 */
export const SEP = "\u0001";

export function k(...parts: (string | number)[]): string {
  return parts.join(SEP);
}

/** Prefix matching every key that starts with the given parts. */
export function kp(...parts: (string | number)[]): string {
  return parts.join(SEP) + SEP;
}

export function split(key: string): string[] {
  return key.split(SEP);
}

/** Fixed-width, order-preserving encoding of a non-negative integer. */
export function seqKey(n: number): string {
  return n.toString(36).padStart(11, "0");
}

export function assertName(kind: string, name: string): void {
  if ([...name].some((ch) => ch.charCodeAt(0) <= 2)) {
    throw new Error(`${kind} ${JSON.stringify(name)} contains a reserved control character`);
  }
}
