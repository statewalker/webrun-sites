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
