import { Dices, FilePlus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { Textarea } from "../components/ui/textarea.js";
import { cn } from "../lib/utils.js";
import type { DemoModel } from "../model/demo-model.js";
import { useDemo } from "./use-demo.js";

/** `path === null` means a new file: the dialog then also asks for the path. */
interface Editing {
  path: string | null;
  text: string;
}

export function FilesPanel({
  model,
  selected,
  onSelect,
}: {
  model: DemoModel;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { files } = useDemo(model);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [newPath, setNewPath] = useState("");

  const save = () => {
    if (!editing) return;
    const path = editing.path ?? newPath.trim();
    if (path) void model.editFile(path, editing.text);
    setEditing(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Files</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setNewPath("");
            setEditing({ path: null, text: "" });
          }}
        >
          <FilePlus /> New file
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="p-2">
          {files.map((f) => (
            <li
              key={f.path}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 hover:bg-accent",
                selected === f.path && "bg-accent",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                onClick={() => onSelect(f.path)}
              >
                {f.path}
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Edit ${f.path}`}
                onClick={() => setEditing({ path: f.path, text: f.text })}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Random edit ${f.path}`}
                onClick={() => void model.randomEdit(f.path)}
              >
                <Dices />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${f.path}`}
                onClick={() => void model.deleteFile(f.path)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.path ?? "New file"}</DialogTitle>
          </DialogHeader>
          {editing?.path === null && (
            <Input
              placeholder="docs/new-file.md"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
            />
          )}
          <Textarea
            className="h-64 font-mono"
            value={editing?.text ?? ""}
            onChange={(e) => setEditing((cur) => cur && { ...cur, text: e.target.value })}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
