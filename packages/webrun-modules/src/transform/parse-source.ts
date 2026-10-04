import { parse, type Program } from "acorn";
import type { SourceFormat } from "../types.js";
import { toJs } from "./to-js.js";

/** A module's source, stripped to JS, and its ESTree (acorn) syntax tree. */
export interface ParsedSource {
  /** The JS the tree was parsed from: node `start` / `end` offsets index into it. */
  js: string;
  ast: Program;
}

/**
 * Parse TS / TSX / JS source into an ESTree syntax tree, without executing it.
 * Types are stripped first (`toJs`, sucrase); sucrase keeps line numbers, so
 * `node.loc.start.line` is the line in the original source. Meant for static
 * analysis of values (calls, literals, object shapes), not of types.
 */
export function parseSource(source: string, format: SourceFormat = "ts", path?: string): ParsedSource {
  const js = toJs(source, format, path);
  const ast = parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  return { js, ast };
}
