import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../components/ui/badge.js";
import { Slider } from "../components/ui/slider.js";
import type { DemoModel } from "../model/demo-model.js";
import { FilesPanel } from "./files-panel.js";
import { useDemo } from "./use-demo.js";

export type Selection = { kind: "file"; path: string } | { kind: "question"; id: string } | null;

export function App({ model }: { model: DemoModel }) {
  const { busy, running } = useDemo(model);
  const [selection, setSelection] = useState<Selection>(null);
  const [delay, setDelay] = useState(300);

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto]">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <h1 className="font-semibold">webrun-cells demo</h1>
        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <span id="delay-label">Step delay</span>
          <Slider
            aria-labelledby="delay-label"
            className="w-40"
            min={0}
            max={1000}
            step={50}
            value={[delay]}
            onValueChange={([ms]) => {
              const v = ms ?? 0;
              setDelay(v);
              model.setDelay(v);
            }}
          />
          <span className="w-14 text-right tabular-nums">{delay} ms</span>
        </div>
        {busy ? (
          <Badge variant="secondary">
            <Loader2 className="size-3 animate-spin" />
            {running ? `${running.cell} ${running.key}` : "working"}
          </Badge>
        ) : (
          <Badge variant="outline">idle</Badge>
        )}
      </header>
      <main className="grid min-h-0 grid-cols-[16rem_1fr_24rem]">
        <section className="min-h-0 border-r">
          <FilesPanel
            model={model}
            selected={selection?.kind === "file" ? selection.path : null}
            onSelect={(path) => setSelection({ kind: "file", path })}
          />
        </section>
        <section className="min-h-0 p-4 text-sm text-muted-foreground">Graph</section>
        <section className="min-h-0 border-l p-4 text-sm text-muted-foreground">Inspector</section>
      </main>
      <footer className="border-t p-3 text-sm text-muted-foreground">Ask bar</footer>
    </div>
  );
}
