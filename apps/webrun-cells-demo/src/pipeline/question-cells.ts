import type { Cell } from "@statewalker/webrun-cells";
import { bm25, cosine, embed, summarize, tokenize } from "./fakes.js";
import type {
  Answer,
  BlockSummary,
  Candidates,
  ContextItem,
  FtsDoc,
  Hit,
  Queries,
  Question,
  VectorDoc,
} from "./types.js";

export const NO_MATCH = "No indexed content matches this question.";

export type ListRows = (signal: string) => Promise<{ key: string; value: unknown }[]>;

const TOP = 5;
const CONTEXT = 3;
const RRF_K = 60;
/** Below this cosine a vector hit is hash-collision noise, not similarity. */
const MIN_SIMILARITY = 0.3;

/** Split on "?", ";" and the word "and"; keep parts that still have search terms. */
export function subqueries(text: string): string[] {
  const parts = text
    .split(/\?|;|\band\b/i)
    .map((p) => p.trim())
    .filter((p) => tokenize(p).length > 0);
  return parts.length > 0 ? parts : [text.trim()];
}

/** Best score per key over several ranked lists, descending. */
function mergeMax(lists: { key: string; score: number }[][]): { key: string; score: number }[] {
  const best = new Map<string, number>();
  for (const ranked of lists)
    for (const r of ranked) best.set(r.key, Math.max(best.get(r.key) ?? 0, r.score));
  return [...best]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export function questionCells(list: ListRows): Cell[] {
  const plan: Cell = {
    id: "plan",
    inputs: ["questions"],
    outputs: ["queries"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { text, askedAt } = i.value as unknown as Question;
        const value: Queries = { text, subqueries: subqueries(text), askedAt };
        yield { signal: "queries", key: i.key, value: { ...value } };
      }
    },
  };

  const search: Cell = {
    id: "search",
    inputs: ["queries"],
    outputs: ["candidates"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { subqueries: parts } = i.value as unknown as Queries;
        const blocks = new Map(
          (await list("block-summaries")).map((r) => [r.key, r.value as BlockSummary]),
        );
        const fts = (await list("fts-terms")).map((r) => ({ key: r.key, doc: r.value as FtsDoc }));
        const vectors = (await list("vectors")).map((r) => ({
          key: r.key,
          doc: r.value as VectorDoc,
        }));
        // Independent of each other: the FTS and the vector lookups.
        const ftsRanked = mergeMax(parts.map((q) => bm25(tokenize(q), fts)));
        const vecRanked = mergeMax(
          parts.map((q) => {
            const qv = embed(q);
            return vectors
              .map((v) => ({ key: v.key, score: cosine(qv, v.doc.vector) }))
              .filter((r) => r.score >= MIN_SIMILARITY);
          }),
        );
        const toHit = (r: { key: string; score: number }): Hit[] => {
          const b = blocks.get(r.key);
          return b ? [{ key: r.key, path: b.path, score: r.score, text: b.text }] : [];
        };
        const value: Candidates = {
          fts: ftsRanked.slice(0, TOP).flatMap(toHit),
          vector: vecRanked.slice(0, TOP).flatMap(toHit),
        };
        yield {
          signal: "candidates",
          key: i.key,
          value: {
            fts: value.fts.map((h) => ({ ...h })),
            vector: value.vector.map((h) => ({ ...h })),
          },
        };
      }
    },
  };

  const rerank: Cell = {
    id: "rerank",
    inputs: ["candidates"],
    outputs: ["ranked"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { fts, vector } = i.value as unknown as Candidates;
        const fused = new Map<string, Hit>();
        for (const list of [fts, vector]) {
          list.forEach((hit, rank) => {
            const prev = fused.get(hit.key);
            const score = (prev?.score ?? 0) + 1 / (RRF_K + rank + 1);
            fused.set(hit.key, { ...hit, score: Math.round(score * 1e6) / 1e6 });
          });
        }
        const ranked = [...fused.values()]
          .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
          .slice(0, TOP);
        yield { signal: "ranked", key: i.key, value: ranked.map((h) => ({ ...h })) };
      }
    },
  };

  const condense: Cell = {
    id: "condense",
    inputs: ["ranked"],
    outputs: ["context"],
    async *run(inputs) {
      for await (const i of inputs) {
        const items: ContextItem[] = (i.value as unknown as Hit[])
          .slice(0, CONTEXT)
          .map((h) => ({ key: h.key, path: h.path, summary: summarize(h.text) }));
        yield { signal: "context", key: i.key, value: items.map((c) => ({ ...c })) };
      }
    },
  };

  const answer: Cell = {
    id: "answer",
    inputs: ["context"],
    outputs: ["answers"],
    async *run(inputs) {
      for await (const i of inputs) {
        const items = i.value as unknown as ContextItem[];
        const value: Answer =
          items.length === 0
            ? { text: NO_MATCH, citations: [] }
            : {
                text: items.map((c) => c.summary).join(" "),
                citations: [...new Set(items.map((c) => c.path))],
              };
        yield { signal: "answers", key: i.key, value: { ...value } };
      }
    },
  };

  return [plan, search, rerank, condense, answer];
}
