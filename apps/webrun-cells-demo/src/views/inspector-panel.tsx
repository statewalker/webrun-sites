import { RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import type { DemoModel, FileStages, QuestionStages } from "../model/demo-model.js";
import type { Hit } from "../pipeline/types.js";
import type { Selection } from "./app.js";
import { useDemo } from "./use-demo.js";

/**
 * Loads `load()` for `key`, again whenever `refresh` changes; drops results that
 * arrive after the selection moved on.
 */
function useInspection<T>(key: string, refresh: unknown, load: () => Promise<T>): T | undefined {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is recreated each render; key + refresh decide when to reload
  useEffect(() => {
    let current = true;
    void load().then((value) => current && setLoaded({ key, value }));
    return () => {
      current = false;
    };
  }, [key, refresh]);
  return loaded?.key === key ? loaded.value : undefined;
}

export function InspectorPanel({
  model,
  selection,
  onSelectFile,
}: {
  model: DemoModel;
  selection: Selection;
  onSelectFile: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="border-b px-3 py-2 text-sm font-semibold">
        Inspector
        {selection && (
          <span className="ml-2 font-mono font-normal text-muted-foreground">
            {selection.kind === "file" ? selection.path : selection.id}
          </span>
        )}
      </h2>
      {/* Radix renders the viewport content as display:table, which defeats truncation. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-3 p-3 text-xs">
          {selection === null && (
            <p className="text-muted-foreground">Select a file or a question to see its stages.</p>
          )}
          {selection?.kind === "file" && <FileInspector model={model} path={selection.path} />}
          {selection?.kind === "question" && (
            <QuestionInspector model={model} id={selection.id} onSelectFile={onSelectFile} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

const Empty = () => <span className="text-muted-foreground italic">—</span>;
const blockOf = (key: string) => key.slice(key.lastIndexOf("#"));

function FileInspector({ model, path }: { model: DemoModel; path: string }) {
  const { busy, log } = useDemo(model);
  // Reload once on selection and when a run ends, not on every step.
  const stages = useInspection<FileStages>(path, busy ? "busy" : log.at(-1)?.id, () =>
    model.inspectFile(path),
  );
  if (!stages) return <p className="text-muted-foreground">Loading…</p>;
  if (stages.text === undefined && stages.blocks.length === 0)
    return (
      <p className="text-muted-foreground">No such file: everything it produced is retracted.</p>
    );
  return (
    <>
      <Section title="Text">
        <p className="whitespace-pre-wrap">{stages.text ?? <Empty />}</p>
      </Section>
      <Section title="Blocks">
        <ol className="flex flex-col gap-1">
          {stages.blocks.map((b, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are identified by position
            <li key={n} className="flex gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">#{n}</span>
              <span>{b}</span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Block summaries">
        {stages.blockSummaries.length === 0 && <Empty />}
        <ol className="flex flex-col gap-1">
          {stages.blockSummaries.map((s) => (
            <li key={s.n} className="flex gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">
                #{s.n}
              </span>
              <span>{s.summary}</span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="File summary">
        <p>{stages.fileSummary ?? <Empty />}</p>
      </Section>
      <Section title="FTS terms">
        {stages.ftsTerms.length === 0 && <Empty />}
        <ul className="flex flex-col gap-1">
          {stages.ftsTerms.map(({ key, terms }) => (
            <li key={key} className="flex gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">
                {blockOf(key)}
              </span>
              <span className="flex flex-wrap gap-1">
                {Object.entries(terms)
                  .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
                  .slice(0, 8)
                  .map(([term, n]) => (
                    <Badge key={term} variant="secondary" className="px-1.5 py-0 font-normal">
                      {term}
                      {n > 1 && <span className="text-muted-foreground">×{n}</span>}
                    </Badge>
                  ))}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Vectors">
        {stages.vectors.length === 0 && <Empty />}
        <div className="flex flex-wrap gap-3">
          {stages.vectors.map(({ key, vector }) => (
            <figure key={key} className="flex flex-col items-center gap-0.5">
              <HeatGrid vector={vector} />
              <figcaption className="font-mono text-muted-foreground">{blockOf(key)}</figcaption>
            </figure>
          ))}
        </div>
      </Section>
    </>
  );
}

/** A 256-dimension vector as a 16×16 grid; cell opacity is the value relative to the maximum. */
function HeatGrid({ vector }: { vector: number[] }) {
  const max = Math.max(...vector, 1e-9);
  return (
    <div className="grid grid-cols-16 gap-px rounded-sm border bg-border p-px">
      {vector.slice(0, 256).map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a vector dimension is its index
          key={i}
          className="size-1.5 bg-background"
          style={v > 0 ? { backgroundColor: `rgb(14 165 233 / ${0.2 + (0.8 * v) / max})` } : {}}
        />
      ))}
    </div>
  );
}

function QuestionInspector({
  model,
  id,
  onSelectFile,
}: {
  model: DemoModel;
  id: string;
  onSelectFile: (path: string) => void;
}) {
  const { busy, log } = useDemo(model);
  // Cheap to read: reload after each stage of this question so the stages fill in one by one.
  const lastStage = log.findLast((e) => e.key === id && e.type === "done")?.id;
  const stages = useInspection<QuestionStages>(id, `${busy}:${lastStage}`, () =>
    model.inspectQuestion(id),
  );
  if (!stages) return <p className="text-muted-foreground">Loading…</p>;
  return (
    <>
      <Section title="Question">
        <div className="flex items-start gap-2">
          <p className="flex-1 font-medium">{stages.question?.text ?? <Empty />}</p>
          <Button size="sm" variant="outline" onClick={() => void model.reask(id)}>
            <RotateCcw /> Ask again
          </Button>
        </div>
      </Section>
      <Section title="Sub-queries">
        {stages.queries ? (
          <ul className="list-disc pl-4">
            {stages.queries.subqueries.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Candidates">
        {stages.candidates ? (
          <>
            <p className="mb-1 text-muted-foreground">
              Two independent lookups: neither reads the other's result.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <HitList title="Full-text" hits={stages.candidates.fts} />
              <HitList title="Vector" hits={stages.candidates.vector} />
            </div>
          </>
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Reranked">
        {stages.ranked ? <HitList hits={stages.ranked} /> : <Empty />}
      </Section>
      <Section title="Context">
        {stages.context ? (
          <ul className="flex flex-col gap-1">
            {stages.context.map((c) => (
              <li key={c.key}>
                <span className="font-mono text-muted-foreground">{c.key}</span> {c.summary}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Answer">
        {stages.answer ? (
          <>
            <p className="mb-1">{stages.answer.text}</p>
            <div className="flex flex-wrap gap-1">
              {stages.answer.citations.map((path) => (
                <button key={path} type="button" onClick={() => onSelectFile(path)}>
                  <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                    {path}
                  </Badge>
                </button>
              ))}
            </div>
          </>
        ) : (
          <Empty />
        )}
      </Section>
    </>
  );
}

function HitList({ title, hits }: { title?: string; hits: Hit[] }) {
  return (
    <div className="min-w-0 rounded-md border p-1.5">
      {title && <h4 className="mb-1 font-semibold">{title}</h4>}
      {hits.length === 0 && <Empty />}
      <ol className="flex flex-col gap-0.5">
        {hits.map((h) => (
          <li key={h.key} className="flex gap-1.5 font-mono" title={h.text}>
            <span className="min-w-0 flex-1 truncate">{h.key}</span>
            <span className="text-muted-foreground tabular-nums">{h.score.toFixed(3)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
