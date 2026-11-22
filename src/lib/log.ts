// Frontend side of the shared app log (Rust writes the file; see applog.rs).
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "info" | "warn" | "error";

function stringify(v: unknown): string {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(level: LogLevel, scope: string, ...parts: unknown[]): void {
  const message = parts.map(stringify).join(" ");
  invoke("log_write", { level, scope, message }).catch(() => {});
}

export const logInfo = (scope: string, ...p: unknown[]) => log("info", scope, ...p);
export const logWarn = (scope: string, ...p: unknown[]) => log("warn", scope, ...p);
export const logError = (scope: string, ...p: unknown[]) => log("error", scope, ...p);

export const readLogs = () => invoke<string>("log_read");
export const clearLogs = () => invoke<void>("log_clear");

let installed = false;

/** Route uncaught errors and console.error/warn into the log file. */
export function installGlobalLogging(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => logError("uncaught", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => logError("unhandled", e.reason));
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => {
    origError(...a);
    log("error", "console", ...a);
  };
  console.warn = (...a: unknown[]) => {
    origWarn(...a);
    log("warn", "console", ...a);
  };
}

const viewerListeners = new Set<() => void>();
export function onOpenLogViewer(fn: () => void): () => void {
  viewerListeners.add(fn);
  return () => viewerListeners.delete(fn);
}
export function openLogViewer(): void {
  for (const fn of viewerListeners) fn();
}
