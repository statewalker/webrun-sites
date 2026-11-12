import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

/** A fake "PDF" extractor for fast tests: the file bytes are the text. */
export const textExtractor = async (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const VOCAB =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega".split(
    " ",
  );

/** A document of `paragraphs` paragraphs; paragraph p carries the marker `<doc>p<p>`. */
export function documentText(doc: string, paragraphs: number, variant = 0): string {
  const out: string[] = [`# Document ${doc}`];
  for (let p = 0; p < paragraphs; p++) {
    const words = Array.from(
      { length: 40 },
      (_, i) => VOCAB[(p * 7 + i * 3 + variant) % VOCAB.length],
    );
    out.push(`Paragraph ${p} of ${doc}: marker${doc}p${p} ${words.join(" ")}.`);
  }
  return out.join("\n\n");
}

export async function corpus(
  docs: number,
  paragraphs: number,
): Promise<{ files: MemFilesApi; names: string[] }> {
  const files = new MemFilesApi();
  const names: string[] = [];
  for (let d = 0; d < docs; d++) {
    const name = `doc${String(d).padStart(4, "0")}`;
    names.push(name);
    await writeText(files, `/library/${name}.pdf`, documentText(name, paragraphs));
  }
  await writeText(files, "/library/notes.txt", "not a pdf"); // ignored by the pipeline
  return { files, names };
}

export const tick = () => new Promise((r) => setTimeout(r, 5));
