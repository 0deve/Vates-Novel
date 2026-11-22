// Full-screen log viewer: filter, copy, export, clear. Opened via openLogViewer().
import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { clearLogs, onOpenLogViewer, readLogs } from "../lib/log";
import { CloseIcon } from "./icons";

type Filter = "all" | "warn" | "error";

/** Group continuation lines (indented) with the entry they belong to. */
function entries(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("    ") && out.length) out[out.length - 1] += "\n" + line;
    else out.push(line);
  }
  return out;
}

const levelOf = (e: string) =>
  e.includes(" [ERROR] ") ? "error" : e.includes(" [WARN] ") ? "warn" : "info";

export default function LogViewer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => onOpenLogViewer(() => setOpen(true)), []);

  async function reload() {
    setText(await readLogs().catch((e) => `Could not read logs: ${e}`));
  }

  useEffect(() => {
    if (open) reload();
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries(text).filter((e) => {
      const lv = levelOf(e);
      if (filter === "error" && lv !== "error") return false;
      if (filter === "warn" && lv === "info") return false;
      return !q || e.toLowerCase().includes(q);
    });
  }, [text, filter, query]);

  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [shown.length, open]);

  if (!open) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown.join("\n"));
      setStatus("Copied.");
    } catch (e) {
      setStatus(`Copy failed: ${e}`);
    }
  }

  async function exportFile() {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const path = await save({
        title: "Export logs",
        defaultPath: `vates-novel-log-${stamp}.txt`,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, text);
      setStatus(`Exported to ${path}`);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  }

  async function clear() {
    await clearLogs();
    await reload();
    setStatus("Logs cleared.");
  }

  const btn = "rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Logs</h2>
        <button onClick={reload} className={btn}>Refresh</button>
        <button onClick={copy} className={btn}>Copy</button>
        <button onClick={exportFile} className={btn}>Export</button>
        <button onClick={clear} className={`${btn} hover:text-red-400`}>Clear</button>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {(["all", "warn", "error"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs ${
              filter === f ? "bg-orange-600 text-white" : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {f === "all" ? "All" : f === "warn" ? "Warnings + errors" : "Errors"}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter text"
          className="min-w-32 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs"
        />
      </div>
      {status && <p className="mb-2 break-all text-xs text-zinc-500">{status}</p>}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 ? (
          <p className="p-2 text-zinc-600">No log entries.</p>
        ) : (
          shown.map((e, i) => {
            const lv = levelOf(e);
            return (
              <pre
                key={i}
                className={`whitespace-pre-wrap break-all border-b border-zinc-800/50 py-1 ${
                  lv === "error" ? "text-red-400" : lv === "warn" ? "text-amber-300" : "text-zinc-400"
                }`}
              >
                {e}
              </pre>
            );
          })
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}
