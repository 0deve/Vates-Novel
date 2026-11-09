// Library backups stream to and from disk a line at a time, so a large library
// never has to fit in memory as one string.
import { open, readTextFile, type FileHandle } from "@tauri-apps/plugin-fs";
import {
  importLibraryJson,
  isBackupHeader,
  readLibraryBackup,
  writeLibraryBackup,
  type RestoreResult,
} from "./db";

const READ_CHUNK = 256 * 1024;

export async function exportBackupFile(path: string): Promise<void> {
  const file = await open(path, { write: true, create: true, truncate: true });
  const encoder = new TextEncoder();
  try {
    await writeLibraryBackup(async (line) => {
      let bytes = encoder.encode(line + "\n");
      while (bytes.length > 0) {
        bytes = bytes.subarray(await file.write(bytes));
      }
    });
  } finally {
    await file.close();
  }
}

async function* fileLines(file: FileHandle): AsyncGenerator<string> {
  const buffer = new Uint8Array(READ_CHUNK);
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const n = await file.read(buffer);
    if (n === null) break;
    pending += decoder.decode(buffer.subarray(0, n), { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function parseHeader(line: string | undefined): unknown {
  try {
    return JSON.parse(line ?? "");
  } catch {
    return null; // pre-streaming backups are one pretty-printed document
  }
}

export async function restoreBackupFile(path: string): Promise<RestoreResult> {
  const file = await open(path, { read: true });
  try {
    const lines = fileLines(file);
    const header = parseHeader((await lines.next()).value);
    if (isBackupHeader(header)) return await readLibraryBackup(header, lines);
  } finally {
    await file.close();
  }
  return importLibraryJson(await readTextFile(path));
}
