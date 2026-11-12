import type { EmbedFn } from "@statewalker/indexer-api";

/**
 * A deterministic bag-of-words embedder (feature hashing + L2 norm) for demos
 * and tests: texts sharing words are close. Replace with a real model (an
 * embeddings API, transformers.js, …) — the pipeline only needs an `EmbedFn`.
 */
export function hashingEmbedder(dimensionality: number): EmbedFn {
  return async (text) => {
    const v = new Float32Array(dimensionality);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0x811c9dc5;
      for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
      const at = (h >>> 0) % dimensionality;
      v[at] = (v[at] as number) + 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
    return v;
  };
}

/** Float32 embedding ⇄ base64 text, for storing embeddings as engine rows. */
export function encodeEmbedding(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeEmbedding(text: string): Float32Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
