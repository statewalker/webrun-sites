import type { IndexerPersistence, PersistenceEntry } from "@statewalker/indexer-api";
import { type FilesApi, joinPath, tryReadText, writeText } from "@statewalker/webrun-files";

interface Head {
  generation: number;
  names: string[];
}

/**
 * statewalker-search `IndexerPersistence` over any `FilesApi`, so the search
 * index persists wherever the engine state does (Node fs, browser storage,
 * memory). Each `save` writes a new generation folder, then switches
 * `HEAD.json` to it (written via temp file + move), then removes the previous
 * generation: a crash mid-save leaves the last complete generation readable.
 */
export class FilesIndexerPersistence implements IndexerPersistence {
  constructor(
    private readonly files: FilesApi,
    private readonly dir: string,
  ) {}

  async save(entries: AsyncIterable<PersistenceEntry>): Promise<void> {
    const head = await this.#head();
    const generation = (head?.generation ?? 0) + 1;
    const names: string[] = [];
    for await (const entry of entries) {
      names.push(entry.name);
      await this.files.write(this.#entryPath(generation, entry.name), entry.content);
    }
    const tmp = joinPath(this.dir, `HEAD.${generation}.tmp`);
    await writeText(this.files, tmp, JSON.stringify({ generation, names } satisfies Head));
    await this.files.move(tmp, joinPath(this.dir, "HEAD.json"));
    if (head) await this.files.remove(joinPath(this.dir, `g${head.generation}`));
  }

  async *load(): AsyncIterable<PersistenceEntry> {
    const head = await this.#head();
    if (!head) return;
    for (const name of head.names) {
      yield { name, content: this.files.read(this.#entryPath(head.generation, name)) };
    }
  }

  async #head(): Promise<Head | undefined> {
    const text = await tryReadText(this.files, joinPath(this.dir, "HEAD.json"));
    return text === undefined ? undefined : (JSON.parse(text) as Head);
  }

  #entryPath(generation: number, name: string): string {
    return joinPath(this.dir, `g${generation}`, encodeURIComponent(name));
  }
}
