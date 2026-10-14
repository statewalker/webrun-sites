import type { FtsDoc } from "./types.js";

const STOP = new Set(
  "the and for with how does what why can you your are its this that from into not was were has have will yes".split(
    " ",
  ),
);

/** Paragraphs: split on blank lines, trimmed, empty ones dropped. */
export const splitBlocks = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

const sentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);

/** Extractive: the first sentence. */
export const summarize = (text: string): string => sentences(text)[0] ?? "";

/** Extractive: the first three block summaries. */
export const fileSummary = (summaries: string[]): string => summaries.slice(0, 3).join(" ");

/** Lower-case words of three or more letters, stop words removed. */
export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));

export function termFreqs(text: string): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokenize(text)) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** 256 buckets: with 64, unrelated words collide often enough that a nonsense query still gets vector hits. */
export const DIM = 256;

function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Hashed bag of words, L2-normalised, rounded so equal text gives an equal row. */
export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const t of tokenize(text)) v[hash(t) % DIM] = (v[hash(t) % DIM] ?? 0) + 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => round(x / norm));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return round(dot);
}

/** Okapi BM25 (k1 = 1.2, b = 0.75), descending, zero scores dropped. */
export function bm25(
  query: string[],
  docs: { key: string; doc: FtsDoc }[],
): { key: string; score: number }[] {
  const n = docs.length;
  if (n === 0) return [];
  const avg = docs.reduce((s, d) => s + d.doc.length, 0) / n || 1;
  const df = (t: string) => docs.filter((d) => (d.doc.terms[t] ?? 0) > 0).length;
  return docs
    .map(({ key, doc }) => {
      let score = 0;
      for (const t of query) {
        const tf = doc.terms[t] ?? 0;
        if (tf === 0) continue;
        const idf = Math.log(1 + (n - df(t) + 0.5) / (df(t) + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (1 - 0.75 + (0.75 * doc.length) / avg));
      }
      return { key, score: round(score) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
