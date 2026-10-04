import { describe, expect, it } from "vitest";
import { type AcornAst, parseSource, toJs } from "../src/index.js";

describe("parseSource", () => {
  it("strips types and parses values, keeping original line numbers", () => {
    const source = [
      "import { z } from 'zod';",
      "type Opts = { a: string };",
      "",
      "export const cmd = contribute({",
      "  key: 'demo.run' as const,",
      "  input: z.object({ n: z.number().min(1) }),",
      "} satisfies Opts);",
    ].join("\n");
    const { js, ast } = parseSource(source);
    const decl = ast.body.find(
      (n): n is AcornAst.ExportNamedDeclaration => n.type === "ExportNamedDeclaration",
    );
    const init = (decl?.declaration as AcornAst.VariableDeclaration | undefined)?.declarations[0]
      ?.init;
    expect(init?.type).toBe("CallExpression");
    expect(init?.loc?.start.line).toBe(4);
    const arg = (init as AcornAst.CallExpression).arguments[0] as AcornAst.ObjectExpression;
    const key = arg.properties[0] as AcornAst.Property;
    expect(js.slice(key.value.start, key.value.end)).toBe("'demo.run'");
  });

  it("parses TSX and plain JS", () => {
    const tsx = parseSource("export const a = <b>{1}</b>;", "tsx");
    // the automatic JSX runtime adds its import next to the export
    expect(tsx.ast.body.map((n) => n.type)).toContain("ExportNamedDeclaration");
    expect(tsx.js).toContain("react/jsx");
    expect(parseSource("export default 1;", "esm").js).toBe("export default 1;");
  });

  it("toJs leaves JS untouched and strips TS", () => {
    expect(toJs("const x = 1;", "esm")).toBe("const x = 1;");
    expect(toJs("const x: number = 1;", "ts")).not.toContain("number");
  });
});
