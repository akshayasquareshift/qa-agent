import * as fs from "fs";
import * as path from "path";
import { spawn, type SpawnOptions } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// File logging
//
// `setupFileLogging()` opens a tee'd log file at
//   tests/generated/logs/run-<ISO-timestamp>.log
// and patches process.stdout.write / process.stderr.write so every console.log,
// console.error, and direct stdout/stderr byte the agent emits is mirrored to
// the file. Subprocess output captured via `spawnTeed()` writes through
// process.stdout, so it ends up in the same log.
//
// Why patch process.stdout.write rather than just wrap console.log? The agent
// also writes raw bytes via process.stdout.write (the in-place progress lines
// in index.ts use it). Patching at the lowest Node-level entry point catches
// everything without us having to chase down every call site.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, "../../tests/generated/logs");

let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let patched = false;

export function setupFileLogging(): string {
  if (patched && logFilePath) return logFilePath;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  logFilePath = path.join(LOG_DIR, `run-${stamp}.log`);
  logStream = fs.createWriteStream(logFilePath, { flags: "a" });

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (this: unknown, ...args: unknown[]) {
    const chunk = args[0];
    if (logStream && chunk != null) {
      logStream.write(chunk as string | Buffer);
    }
    return (origStdout as (...a: unknown[]) => boolean)(...args);
  } as typeof process.stdout.write;

  process.stderr.write = function (this: unknown, ...args: unknown[]) {
    const chunk = args[0];
    if (logStream && chunk != null) {
      logStream.write(chunk as string | Buffer);
    }
    return (origStderr as (...a: unknown[]) => boolean)(...args);
  } as typeof process.stderr.write;

  // Best-effort flush on exit. WriteStreams normally flush automatically, but
  // be explicit so process.exit(code) calls don't lose the tail of the log.
  const flush = () => {
    if (logStream) {
      try { logStream.end(); } catch { /* noop */ }
      logStream = null;
    }
  };
  process.on("exit", flush);
  process.on("SIGINT", () => { flush(); process.exit(130); });
  process.on("SIGTERM", () => { flush(); process.exit(143); });

  patched = true;
  return logFilePath;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// spawnTeed — async spawn that pipes child stdout/stderr through the parent's
// (now-patched) process.stdout/process.stderr so the file logger captures it.
//
// Use instead of spawnSync(..., {stdio: "inherit"}) wherever subprocess output
// should land in the run log.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnTeedResult {
  status: number | null;
  signal: NodeJS.Signals | null;
}

export function spawnTeed(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnTeedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => { process.stdout.write(data); });
    child.stderr?.on("data", (data: Buffer) => { process.stderr.write(data); });

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ status: code, signal }));
  });
}
