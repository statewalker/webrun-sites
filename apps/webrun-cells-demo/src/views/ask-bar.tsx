import { Loader2, Send } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";
import type { DemoModel } from "../model/demo-model.js";
import { useDemo } from "./use-demo.js";

export function AskBar({
  model,
  selected,
  onSelect,
}: {
  model: DemoModel;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { questions } = useDemo(model);
  const [text, setText] = useState("");
  // `ask()` waits for indexing to settle before the question enters the snapshot;
  // until then the bar shows it here.
  const [waiting, setWaiting] = useState<{ n: number; text: string }[]>([]);
  const counter = useRef(0);

  const submit = async () => {
    const q = text.trim();
    if (!q) return;
    setText("");
    const entry = { n: ++counter.current, text: q };
    setWaiting((w) => [...w, entry]);
    try {
      onSelect(await model.ask(q));
    } finally {
      setWaiting((w) => w.filter((e) => e !== entry));
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          placeholder="Ask about the files, e.g. how do I install it and what is the lease time?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" disabled={text.trim() === ""}>
          <Send /> Ask
        </Button>
      </form>
      {(questions.length > 0 || waiting.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {questions.map((q) => (
            <button key={q.id} type="button" onClick={() => onSelect(q.id)}>
              <Badge
                variant={selected === q.id ? "default" : "outline"}
                className={cn("max-w-72 cursor-pointer", selected !== q.id && "hover:bg-accent")}
              >
                <span className="font-mono opacity-70">{q.id}</span>
                <span className="truncate">{q.text}</span>
              </Badge>
            </button>
          ))}
          {waiting.map((w) => (
            <Badge key={w.n} variant="secondary" className="max-w-96">
              <Loader2 className="size-3 animate-spin" />
              <span className="truncate">{w.text}</span>
              <span className="text-muted-foreground">waiting for indexing…</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
