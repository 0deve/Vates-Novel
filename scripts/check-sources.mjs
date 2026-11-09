// Live health check: runs each novel source's smoke test (search, details,
// chapter text) and prints one line per source. Exits 1 if any are broken.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const cargo = (...args) => spawnSync("cargo", args, { cwd, encoding: "utf8" });

console.log("Building tests...");
const list = cargo("test", "--lib", "--", "--list");
if (list.status !== 0) {
  console.error(list.stderr);
  process.exit(1);
}

const tests = list.stdout
  .split("\n")
  .map((l) => l.match(/^(sources::\S+_smoke): test/)?.[1])
  .filter(Boolean);
if (tests.length === 0) {
  console.error("No source smoke tests found. Is the private/ folder present?");
  process.exit(1);
}

let broken = 0;
for (const test of tests) {
  const name = test.split("::").pop().replace(/_smoke$/, "");
  const started = Date.now();
  const run = cargo("test", "--lib", "--", "--exact", test, "--nocapture", "--test-threads=1");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const output = run.stdout + run.stderr;

  if (run.status === 0) {
    const detail = output.match(/\bok: (.+)/)?.[1] ?? "";
    console.log(`ok    ${name.padEnd(12)} ${secs.padStart(5)}s  ${detail}`);
  } else {
    broken++;
    const reason = output.match(/panicked at [^\n]*\n([^\n]+)/)?.[1] ?? "see cargo output";
    console.log(`FAIL  ${name.padEnd(12)} ${secs.padStart(5)}s  ${reason}`);
  }
}

console.log(`\n${tests.length - broken}/${tests.length} sources healthy.`);
process.exit(broken > 0 ? 1 : 0);
