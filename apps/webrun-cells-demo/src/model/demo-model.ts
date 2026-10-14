import type { Cell, CellEngine } from "@statewalker/webrun-cells";
import type { SqlDriver } from "@statewalker/webrun-files-sqlite";
import { createPipeline } from "../pipeline/pipeline.js";
import type {
  Answer,
  BlockSummary,
  Candidates,
  ContextItem,
  FtsDoc,
  Hit,
  PipelineEvent,
  Queries,
  Question,
  VectorDoc,
} from "../pipeline/types.js";

export interface LogEntry {
  id: number;
  type: PipelineEvent["type"];
  cell: string;
  signal: string;
  key: string;
  error?: string;
}

export interface DemoSnapshot {
  files: { path: string; text: string }[];
  questions: { id: string; text: string }[];
  running: { cell: string; key: string } | null;
  pending: Record<string, number>;
  log: LogEntry[];
  busy: boolean;
}

export interface FileStages {
  text?: string;
  blocks: string[];
  blockSummaries: BlockSummary[];
  fileSummary?: string;
  ftsTerms: { key: string; terms: Record<string, number> }[];
  vectors: { key: string; vector: number[] }[];
}

export interface QuestionStages {
  question?: Question;
  queries?: Queries;
  candidates?: Candidates;
  ranked?: Hit[];
  context?: ContextItem[];
  answer?: Answer;
}

const LOG_LIMIT = 200;
const blockNumber = (key: string) => Number(key.slice(key.lastIndexOf("#") + 1));

export class DemoModel {
  static async create(opts: {
    db: SqlDriver;
    seed?: Readonly<Record<string, string>>;
    delayMs?: number;
  }): Promise<DemoModel> {
    const model = new DemoModel(opts.db, opts.delayMs ?? 0);
    for (const [path, text] of Object.entries(opts.seed ?? {})) {
      await model.engine.put("files", path, text);
    }
    await model.refreshFiles();
    model.kick();
    return model;
  }

  readonly cells: readonly Cell[];
  private readonly engine: CellEngine;
  private snapshot: DemoSnapshot = {
    files: [],
    questions: [],
    running: null,
    pending: {},
    log: [],
    busy: false,
  };
  private readonly listeners = new Set<() => void>();
  private delayMs: number;
  private dirty = false;
  private readonly mutations = new Set<Promise<void>>();
  private loop: Promise<void> | null = null;
  private refreshing: Promise<void> = Promise.resolve();
  private logId = 0;
  private rev = 0;
  private questionCount = 0;

  private constructor(
    private readonly db: SqlDriver,
    delayMs: number,
  ) {
    this.delayMs = delayMs;
    const pipeline = createPipeline({
      db,
      delay: () => this.delayMs,
      onEvent: (e) => this.onEvent(e),
    });
    this.engine = pipeline.engine;
    this.cells = pipeline.cells;
  }

  getSnapshot = (): DemoSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  editFile(path: string, text: string): Promise<void> {
    return this.track(async () => {
      await this.engine.put("files", path, text);
      await this.refreshFiles();
      this.kick();
    });
  }

  randomEdit(path: string, random: () => number = Math.random): Promise<void> {
    return this.track(() => this.randomEditNow(path, random));
  }

  private async randomEditNow(path: string, random: () => number): Promise<void> {
    const text = String((await this.engine.get("files", path)) ?? "");
    const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
    if (sentences.length === 0) return;
    const i = Math.floor(random() * sentences.length);
    sentences[i] = (sentences[i] as string).replace(/[.!?]*$/, ` (rev ${++this.rev}).`);
    await this.editFile(path, sentences.join(""));
  }

  deleteFile(path: string): Promise<void> {
    return this.track(async () => {
      await this.engine.remove("files", path);
      await this.refreshFiles();
      this.kick();
    });
  }

  async ask(text: string): Promise<string> {
    const id = `q${++this.questionCount}`;
    // The search cell does not depend on the index signals, so a question handled
    // alongside pending indexing would search a half-built index. Let it drain first.
    await this.settled();
    await this.track(async () => {
      await this.engine.put("questions", id, { text, askedAt: Date.now() });
      this.update({ questions: [...this.snapshot.questions, { id, text }] });
      this.kick();
    });
    return id;
  }

  async reask(id: string): Promise<void> {
    // Same gate as ask(): search must not run beside pending indexing.
    await this.settled();
    await this.track(async () => {
      const q = (await this.engine.get("questions", id)) as unknown as Question | undefined;
      if (!q) return;
      const now = Date.now();
      await this.engine.put("questions", id, {
        text: q.text,
        askedAt: now === q.askedAt ? now + 1 : now,
      });
      this.kick();
    });
  }

  async inspectFile(path: string): Promise<FileStages> {
    const text = await this.engine.get("files", path);
    const blocks = await this.engine.get("file-blocks", path);
    const fileSummary = await this.engine.get("file-summaries", path);
    const prefix = `${path}#`;
    const forFile = async (signal: string) =>
      (await this.engine.list(signal))
        .filter((r) => r.key.startsWith(prefix))
        .sort((a, b) => blockNumber(a.key) - blockNumber(b.key));
    const stages: FileStages = {
      blocks: (blocks as string[] | undefined) ?? [],
      blockSummaries: (await forFile("block-summaries")).map(
        (r) => r.value as unknown as BlockSummary,
      ),
      ftsTerms: (await forFile("fts-terms")).map((r) => ({
        key: r.key,
        terms: (r.value as unknown as FtsDoc).terms,
      })),
      vectors: (await forFile("vectors")).map((r) => ({
        key: r.key,
        vector: (r.value as unknown as VectorDoc).vector,
      })),
    };
    if (text !== undefined) stages.text = String(text);
    if (fileSummary !== undefined) stages.fileSummary = String(fileSummary);
    return stages;
  }

  async inspectQuestion(id: string): Promise<QuestionStages> {
    const stages: QuestionStages = {};
    const read = async <T>(signal: string) =>
      (await this.engine.get(signal, id)) as unknown as T | undefined;
    const fields = [
      ["question", "questions"],
      ["queries", "queries"],
      ["candidates", "candidates"],
      ["ranked", "ranked"],
      ["context", "context"],
      ["answer", "answers"],
    ] as const;
    for (const [field, signal] of fields) {
      const value = await read<never>(signal);
      if (value !== undefined) stages[field] = value;
    }
    return stages;
  }

  async settled(): Promise<void> {
    for (;;) {
      await Promise.all([...this.mutations]);
      if (this.loop) await this.loop;
      await this.refreshing;
      if (!this.loop && !this.dirty && this.mutations.size === 0) return;
    }
  }

  /** A mutation is visible to settled() from its first synchronous step until it has kicked the run loop. */
  private track(fn: () => Promise<void>): Promise<void> {
    const p = fn().finally(() => this.mutations.delete(p));
    this.mutations.add(p);
    return p;
  }

  private update(patch: Partial<DemoSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private kick(): void {
    this.dirty = true;
    if (this.loop) return;
    this.update({ busy: true });
    this.loop = (async () => {
      try {
        do {
          this.dirty = false;
          await this.engine.run();
        } while (this.dirty);
      } finally {
        this.loop = null;
        await this.queuePendingRefresh();
        // A mutation may have kicked a new loop meanwhile; it owns busy/running now.
        if (!this.loop && !this.dirty) this.update({ busy: false, running: null });
      }
    })();
  }

  private onEvent(e: PipelineEvent): void {
    const entry: LogEntry = {
      id: ++this.logId,
      type: e.type,
      cell: e.cell,
      signal: e.signal,
      key: e.key,
    };
    if (e.type === "fail") entry.error = e.error;
    const running =
      e.type === "start"
        ? { cell: e.cell, key: e.key }
        : e.type === "done" || e.type === "fail"
          ? null
          : this.snapshot.running;
    this.update({ log: [...this.snapshot.log, entry].slice(-LOG_LIMIT), running });
    void this.queuePendingRefresh();
  }

  private queuePendingRefresh(): Promise<void> {
    this.refreshing = this.refreshing.then(async () => {
      const pending: Record<string, number> = {};
      try {
        const rows = (await this.db.all(
          "SELECT cell, COUNT(*) AS n FROM cells_pending GROUP BY cell",
        )) as { cell: string; n: number }[];
        for (const r of rows) pending[r.cell] = Number(r.n);
      } catch (err) {
        // the queue table exists only after the engine's first call; anything else is a real fault
        if (!/no such table/i.test(String((err as Error)?.message ?? err))) throw err;
      }
      this.update({ pending });
    });
    return this.refreshing;
  }

  private async refreshFiles(): Promise<void> {
    const rows = await this.engine.list("files");
    const files = rows
      .map((r) => ({ path: r.key, text: String(r.value) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.update({ files });
  }
}
