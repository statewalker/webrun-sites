import { Fragment, type ReactNode } from "react";
import { Badge } from "../components/ui/badge.js";
import { Card } from "../components/ui/card.js";
import { cn } from "../lib/utils.js";
import type { DemoModel } from "../model/demo-model.js";
import { type CellNode, layoutCells } from "./graph-layout.js";
import { useDemo } from "./use-demo.js";

type CellShape = DemoModel["cells"][number];

/** Cells fed, directly or through other cells, by the `files` signal. */
function splitByFiles(cells: readonly CellShape[]): [CellShape[], CellShape[]] {
  const signals = new Set(["files"]);
  const indexing = new Set<CellShape>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of cells) {
      if (indexing.has(c) || !c.inputs.some((s) => signals.has(s))) continue;
      indexing.add(c);
      for (const s of c.outputs) signals.add(s);
      grew = true;
    }
  }
  return [cells.filter((c) => indexing.has(c)), cells.filter((c) => !indexing.has(c))];
}

export function GraphPanel({ model }: { model: DemoModel }) {
  const [indexing, questions] = splitByFiles(model.cells);
  return (
    <div className="flex flex-col gap-3 p-3">
      <GraphSection title="Indexing" layers={layoutCells(indexing)} model={model}>
        fts-index and vector-index are independent: they could run in parallel; this engine runs one
        input at a time.
      </GraphSection>
      <GraphSection title="Questions" layers={layoutCells(questions)} model={model} />
    </div>
  );
}

function GraphSection({
  title,
  layers,
  model,
  children,
}: {
  title: string;
  layers: CellNode[][];
  model: DemoModel;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-1.5 text-sm font-semibold">{title}</h2>
      <div className="flex items-center gap-1.5">
        {layers.map((layer, i) => (
          <Fragment key={layer.map((c) => c.id).join()}>
            {i > 0 && <span className="shrink-0 text-muted-foreground">→</span>}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {layer.map((cell) => (
                <CellCard key={cell.id} cell={cell} model={model} />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
      {children && <p className="mt-1.5 text-xs text-muted-foreground">{children}</p>}
    </section>
  );
}

function CellCard({ cell, model }: { cell: CellNode; model: DemoModel }) {
  const { running, pending } = useDemo(model);
  const isRunning = running?.cell === cell.id;
  const queued = pending[cell.id] ?? 0;
  return (
    <Card
      className={cn(
        "gap-0.5 rounded-lg px-2.5 py-1.5 text-xs shadow-none transition-colors",
        isRunning && "bg-sky-50 ring-2 ring-sky-500 dark:bg-sky-950",
      )}
    >
      <div className="flex items-center gap-1.5">
        {isRunning && (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400" />
            <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
          </span>
        )}
        <span className="font-mono font-semibold">{cell.id}</span>
        <Badge
          variant="outline"
          className={cn(
            "ml-auto px-1.5 py-0 tabular-nums",
            queued > 0 ? "border-amber-300 bg-amber-100 text-amber-900" : "text-muted-foreground",
          )}
        >
          {queued} pending
        </Badge>
      </div>
      <div className="break-words text-muted-foreground">
        {cell.inputs.join(", ")} → {cell.outputs.join(", ")}
      </div>
      {/* Always present, so a card does not change height when its cell starts running. */}
      <div className="h-4 truncate font-mono text-sky-700 dark:text-sky-300">
        {isRunning && `▶ ${running.key}`}
      </div>
      {cell.independentOf.length > 0 && (
        <div className="text-muted-foreground italic">
          independent of {cell.independentOf.join(", ")}
        </div>
      )}
    </Card>
  );
}
