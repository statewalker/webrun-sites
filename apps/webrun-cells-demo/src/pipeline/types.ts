export type PipelineEvent =
  | { type: "start" | "emit" | "done"; cell: string; signal: string; key: string }
  | { type: "fail"; cell: string; signal: string; key: string; error: string };
export interface BlockSummary {
  path: string;
  n: number;
  text: string;
  summary: string;
}
export interface FtsDoc {
  path: string;
  terms: Record<string, number>;
  length: number;
}
export interface VectorDoc {
  path: string;
  vector: number[];
}
export interface Question {
  text: string;
  askedAt: number;
}
export interface Queries {
  text: string;
  subqueries: string[];
}
export interface Hit {
  key: string;
  path: string;
  score: number;
  text: string;
}
export interface Candidates {
  fts: Hit[];
  vector: Hit[];
}
export interface ContextItem {
  key: string;
  path: string;
  summary: string;
}
export interface Answer {
  text: string;
  citations: string[];
}
