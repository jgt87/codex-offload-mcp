/**
 * Not part of the public module graph — this file is spawned directly as a
 * separate `node` process (see `winSpawn.ts`), never imported. It exists so
 * Codex can be given a real (though hidden) console of its own instead of
 * none at all: a process created with no console forces every console-mode
 * child it spawns to allocate a fresh, briefly-visible one, which is what
 * made every command Codex ran flash a window on screen. This wrapper gets
 * created with a real console, hides it immediately, then launches Codex as
 * its own child — Codex and everything it runs in turn correctly reuse this
 * hidden console instead of creating new ones.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface WrapperConfig {
  command: string;
  args: string[];
  cwd: string;
  stdinFile: string;
  stdoutFile: string;
  stderrFile: string;
  useShell: boolean;
}

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("winWrapperEntry: missing config path argument\n");
  process.exit(1);
}

const cfg: WrapperConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

// This process's own stdio goes nowhere anyone reads (a hidden console), so
// an uncaught exception here would otherwise vanish without a trace.
process.on("uncaughtException", (err) => {
  try {
    fs.appendFileSync(cfg.stderrFile, `[winWrapperEntry:uncaught] ${err.stack ?? err.message}\n`);
  } catch {
    // nothing more we can do
  }
  process.exit(1);
});

// Best-effort. Hiding must happen in THIS process — hiding this same window
// from the launching process instead (via AttachConsole from outside) was
// tried and does not have the same effect on whether children later reuse
// the console; verified empirically. If koffi is missing or fails to load,
// this window just stays visible for this one job; Codex still runs fine.
try {
  const koffi = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const user32 = koffi.load("user32.dll");
  const GetConsoleWindow = kernel32.func("__stdcall", "GetConsoleWindow", "void *", []);
  const ShowWindow = user32.func("__stdcall", "ShowWindow", "bool", ["void *", "int"]);
  const hwnd = GetConsoleWindow();
  if (hwnd) ShowWindow(hwnd, 0); // SW_HIDE
} catch {
  // proceed without hiding
}

// Pipe-based stdio, not raw file descriptors. Passing this process's own
// stdio as raw fds is specifically what breaks console reuse for whatever
// IT spawns: verified that with raw fds, Codex's own commands kept
// allocating fresh visible consoles even with this wrapper's console
// already hidden; switching to pipes (with this process copying the bytes
// to/from the job's files itself) fixed it. Do not change this back to raw
// fds without re-verifying against a real conhost-count test on Windows.
const child = spawn(cfg.command, cfg.args, {
  cwd: cfg.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: cfg.useShell,
});

const outStream = fs.createWriteStream(cfg.stdoutFile, { flags: "a" });
const errStream = fs.createWriteStream(cfg.stderrFile, { flags: "a" });
const inStream = fs.createReadStream(cfg.stdinFile);

// An unhandled 'error' on any of these throws and crashes this process
// silently (its own stdio goes to a hidden console nobody reads), which
// looks identical to Codex itself failing. Surface anything that goes
// wrong here into the job's own stderr file instead.
function logWrapperError(source: string, err: Error): void {
  try {
    fs.appendFileSync(cfg.stderrFile, `[winWrapperEntry:${source}] ${err.stack ?? err.message}\n`);
  } catch {
    // nothing more we can do
  }
}
inStream.on("error", (e) => logWrapperError("stdin-read", e));
child.stdin.on("error", (e) => logWrapperError("stdin-write", e));
outStream.on("error", (e) => logWrapperError("stdout", e));
errStream.on("error", (e) => logWrapperError("stderr", e));

inStream.pipe(child.stdin);
child.stdout.pipe(outStream);
child.stderr.pipe(errStream);

// Wait for both the child to exit AND its output to finish flushing to disk
// before this process exits — process.exit() does not wait for pending
// stream writes, so exiting on the child's 'exit' event alone can truncate
// events.jsonl for a job with enough output.
let exitCode: number | null = null;
let pendingStreams = 2;
function maybeExit(): void {
  if (exitCode !== null && pendingStreams === 0) process.exit(exitCode);
}
outStream.on("finish", () => {
  pendingStreams -= 1;
  maybeExit();
});
errStream.on("finish", () => {
  pendingStreams -= 1;
  maybeExit();
});
child.on("exit", (code) => {
  exitCode = code ?? 1;
  maybeExit();
});
child.on("error", () => {
  exitCode = 1;
  maybeExit();
});
