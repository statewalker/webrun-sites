import { useEffect, useRef } from "react";
import { Badge } from "../components/ui/badge.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { cn } from "../lib/utils.js";
import type { DemoModel, LogEntry } from "../model/demo-model.js";
import { useDemo } from "./use-demo.js";

const TYPE_STYLE: Record<LogEntry["type"], string> = {
  start: "border-sky-200 bg-sky-100 text-sky-900",
  emit: "border-violet-200 bg-violet-50 text-violet-900",
  done: "border-emerald-200 bg-emerald-100 text-emerald-900",
  fail: "border-red-200 bg-red-100 text-red-900",
};

export function LogPanel({ model }: { model: DemoModel }) {
  const { log } = useDemo(model);
  const list = useRef<HTMLOListElement>(null);
  const last = log.at(-1)?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever a new entry arrives
  useEffect(() => {
    // Scroll only the log's own viewport, never the page.
    const viewport = list.current?.closest("[data-slot=scroll-area-viewport]");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [last]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="border-b px-3 py-2 text-sm font-semibold">Log</h2>
      {/* Radix renders the viewport content as display:table, which defeats truncation. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <ol ref={list} className="px-3 py-1 font-mono text-xs">
          {log.map((e) => (
            <li key={e.id} className="flex items-baseline gap-2 py-0.5">
              <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                {e.id}
              </span>
              <Badge variant="outline" className={cn("w-12 px-1 py-0", TYPE_STYLE[e.type])}>
                {e.type}
              </Badge>
              <span className="w-24 shrink-0 font-semibold">{e.cell}</span>
              <span className="min-w-0 truncate">
                {e.type === "emit" ? `${e.signal} ${e.key}` : e.key}
              </span>
              {e.error && <span className="truncate text-red-700">{e.error}</span>}
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
}
