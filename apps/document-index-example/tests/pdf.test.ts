import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { hashingEmbedder, openDocumentIndex } from "../src/index.js";
import { makePdf } from "./make-pdf.js";

describe("real PDFs through the default extractor (statewalker pdfExtractor / unpdf)", () => {
  it("indexes text from PDF pages and finds it by search; removal deletes it", async () => {
    const files = new MemFilesApi();
    await files.write("/papers/solar.pdf", [
      makePdf([
        [
          "Photovoltaic cells convert sunlight into electricity.",
          "Silicon wafers dominate production.",
        ],
        ["Perovskite tandems reach high efficiency in the laboratory."],
      ]),
    ]);
    await files.write("/papers/bees.pdf", [
      makePdf([["Honeybees communicate the location of flowers with a waggle dance."]]),
    ]);
    const index = await openDocumentIndex({
      files,
      root: "/papers",
      embed: hashingEmbedder(128),
      model: "hashing-128",
      dimensionality: 128,
      chunk: { targetChars: 80 },
    });
    await index.update();

    const [perovskite] = await index.search("perovskite tandems", { mode: "fulltext" });
    expect(perovskite?.path).toBe("solar.pdf");
    expect(perovskite?.text).toContain("Perovskite");
    const [dance] = await index.search("waggle dance of honeybees", { mode: "vector" });
    expect(dance?.path).toBe("bees.pdf");

    await files.remove("/papers/bees.pdf");
    await index.update();
    const hits = await index.search("waggle dance of honeybees", { topK: 10 });
    expect(hits.some((h) => h.path === "bees.pdf")).toBe(false);
  });
});
