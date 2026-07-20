import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexBin } from "./codexBin.js";
import { captureBaseline, HANDOFF_SCHEMA, type GitBaseline } from "./handoff.js";

export type JobState = "running" | "done" | "failed" | "cancelled";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface JobMeta {
  jobId: string;
  prompt: string;
  cwd: string;
  model?: string;
  sandbox: SandboxMode;
  pid: number;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  /** Codex thread this job belongs to; lets codex_reply continue the conversation. */
  threadId?: string;
  /** Set when this job is a follow-up to an earlier one. */
  parentJobId?: string;
  structured: boolean;
  git?: GitBaseline;
}

export const JOBS_DIR =
  process.env.CODEX_MCP_JOBS_DIR ?? path.join(os.homedir(), ".codex-mcp", "jobs");

const F = {
  meta: "meta.json",
  events: "events.jsonl",
  stderr: "stderr.log",
  result: "last-message.txt",
  prompt: "prompt.txt",
  schema: "schema.json",
};

const jobDir = (jobId: string) => path.join(JOBS_DIR, jobId);
const jobFile = (jobId: string, name: string) => path.join(jobDir(jobId), name);

function readMeta(jobId: string): JobMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(jobFile(jobId, F.meta), "utf8")) as JobMeta;
  } catch {
    return undefined;
  }
}

function writeMeta(meta: JobMeta): void {
  fs.writeFileSync(jobFile(meta.jobId, F.meta), JSON.stringify(meta, null, 2));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read at most the last `maxBytes` of a file, so a chatty job can't blow up memory. */
function readTail(file: string, maxBytes = 512 * 1024): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len === 0) return "";
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface EventSummary {
  threadId?: string;
  /** Human-readable trace of what Codex did, newest last. */
  activity: string[];
  filesTouched: string[];
  commandsRun: number;
  usage?: Record<string, number>;
  failure?: string;
}

/** Parse the JSONL emitted by `codex exec --json` into something worth showing. */
export function summarizeEvents(jobId: string, activityLimit = 20): EventSummary {
  const out: EventSummary = { activity: [], filesTouched: [], commandsRun: 0 };
  const raw = readTail(jobFile(jobId, F.events));

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a truncated head line, or a partial tail while still writing
    }

    if (ev.type === "thread.started" && ev.thread_id) out.threadId = ev.thread_id;
    if (ev.type === "turn.completed" && ev.usage) out.usage = ev.usage;
    if (ev.type === "turn.failed") {
      out.failure = ev.error?.message ?? JSON.stringify(ev.error ?? {});
    }

    if (ev.type === "item.completed" && ev.item) {
      const item = ev.item;
      switch (item.type) {
        case "agent_message":
          out.activity.push(`message: ${truncate(item.text ?? "", 200)}`);
          break;
        case "reasoning":
          out.activity.push(`thinking: ${truncate(item.text ?? "", 120)}`);
          break;
        case "command_execution":
          out.commandsRun += 1;
          out.activity.push(`ran: ${truncate(item.command ?? "", 160)}`);
          break;
        case "file_change": {
          const changes: any[] = item.changes ?? [];
          for (const c of changes) {
            if (c.path && !out.filesTouched.includes(c.path)) out.filesTouched.push(c.path);
          }
          out.activity.push(`edited: ${changes.map((c) => c.path).join(", ")}`);
          break;
        }
        default:
          out.activity.push(item.type);
      }
    }
  }

  if (out.activity.length > activityLimit) {
    out.activity = out.activity.slice(-activityLimit);
  }
  return out;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export interface StartOptions {
  prompt: string;
  cwd: string;
  model?: string;
  sandbox?: SandboxMode;
  /** Extra directories Codex may write to, beyond cwd. */
  addDirs?: string[];
  /** Require a typed handoff report instead of free prose. Defaults to true. */
  structured?: boolean;
}

function newJobId(): string {
  return `j-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function startJob(opts: StartOptions): JobMeta {
  const cwd = path.resolve(opts.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not an existing directory: ${cwd}`);
  }

  const jobId = newJobId();
  fs.mkdirSync(jobDir(jobId), { recursive: true });

  const sandbox: SandboxMode = opts.sandbox ?? "workspace-write";
  const structured = opts.structured ?? true;

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-s",
    sandbox,
    "-o",
    jobFile(jobId, F.result),
  ];
  if (opts.model) args.push("-m", opts.model);
  for (const d of opts.addDirs ?? []) args.push("--add-dir", path.resolve(d));
  if (structured) args.push("--output-schema", writeSchema(jobId));

  return launch(jobId, args, cwd, {
    jobId,
    prompt: opts.prompt,
    cwd,
    model: opts.model,
    sandbox,
    structured,
    // Recorded before Codex touches anything, so we can later report what
    // actually changed rather than what Codex says changed.
    git: captureBaseline(cwd),
    pid: -1,
    state: "running",
    startedAt: Date.now(),
  });
}

/**
 * Continue an existing Codex thread with a follow-up. Creates a new job that
 * shares the parent's thread, so Codex keeps all of its earlier context.
 *
 * `codex exec resume` does not accept -C or -s; the resumed session reuses the
 * working directory and sandbox it was originally started with.
 */
export function replyJob(parent: JobMeta, prompt: string, structured?: boolean): JobMeta {
  const threadId = parent.threadId ?? getThreadId(parent.jobId);
  if (!threadId) {
    throw new Error(
      `job ${parent.jobId} has no thread id yet — it may not have started properly`,
    );
  }

  const jobId = newJobId();
  fs.mkdirSync(jobDir(jobId), { recursive: true });

  const useStructured = structured ?? parent.structured;
  const args = [
    "exec",
    "resume",
    threadId,
    "--json",
    "--skip-git-repo-check",
    "-o",
    jobFile(jobId, F.result),
  ];
  if (parent.model) args.push("-m", parent.model);
  if (useStructured) args.push("--output-schema", writeSchema(jobId));

  return launch(jobId, args, parent.cwd, {
    jobId,
    prompt,
    cwd: parent.cwd,
    model: parent.model,
    sandbox: parent.sandbox,
    structured: useStructured,
    threadId,
    parentJobId: parent.jobId,
    git: captureBaseline(parent.cwd),
    pid: -1,
    state: "running",
    startedAt: Date.now(),
  });
}

function writeSchema(jobId: string): string {
  const file = jobFile(jobId, F.schema);
  fs.writeFileSync(file, JSON.stringify(HANDOFF_SCHEMA, null, 2));
  return file;
}

function launch(jobId: string, args: string[], cwd: string, base: JobMeta): JobMeta {
  // The prompt goes in over stdin so no amount of quoting or length can break
  // the command line.
  fs.writeFileSync(jobFile(jobId, F.prompt), base.prompt, "utf8");

  const stdinFd = fs.openSync(jobFile(jobId, F.prompt), "r");
  const outFd = fs.openSync(jobFile(jobId, F.events), "a");
  const errFd = fs.openSync(jobFile(jobId, F.stderr), "a");

  const bin = resolveCodexBin();
  let child;
  try {
    child = spawn(bin.command, args, {
      cwd,
      // Required for the job to outlive this server. On Windows this maps to
      // DETACHED_PROCESS, which has a measured cost: Codex then has no console,
      // so each console-mode grandchild it spawns (~20 git probes per job)
      // allocates a console of its own, and those orphan and never exit.
      //
      // How that surfaces depends on the machine's default terminal
      // application. Set to "Windows Console Host" they are invisible
      // conhost.exe processes (~10 MB each). Left at the Windows 11 default,
      // which resolves to Windows Terminal, every one of them opens a *visible
      // Terminal window* — ~20 new windows per job, all owned by a single
      // WindowsTerminal.exe, which is what makes this impossible to live with.
      // Switching the default to Console Host hides the symptom; it does not
      // stop the leak.
      //
      // Dropping this flag on Windows does fix the leak outright, but the job
      // is then killed the moment this server exits, which defeats the whole
      // point of the server. Verified both ways. A real fix needs a Job Object
      // with CREATE_BREAKAWAY_FROM_JOB, which Node cannot express without a
      // native addon. Do not "optimise" this without re-testing survival.
      detached: true,
      stdio: [stdinFd, outFd, errFd],
      shell: bin.useShell,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdinFd);
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const meta: JobMeta = { ...base, pid: child.pid ?? -1 };
  writeMeta(meta);

  // Detaching means the job outlives this server; while we are alive we still
  // get the exit event and can record the real exit code.
  child.on("exit", (code) => {
    const current = readMeta(jobId);
    if (!current || current.state === "cancelled") return;
    current.state = code === 0 ? "done" : "failed";
    current.exitCode = code;
    current.endedAt = Date.now();
    current.threadId ??= getThreadId(jobId);
    if (code !== 0) {
      const err = readTail(jobFile(jobId, F.stderr), 4000).trim();
      if (err) current.error = truncate(err, 600);
    }
    writeMeta(current);
  });
  child.on("error", (err) => {
    const current = readMeta(jobId);
    if (!current) return;
    current.state = "failed";
    current.error = err.message;
    current.endedAt = Date.now();
    writeMeta(current);
  });
  child.unref();

  return meta;
}

/**
 * Read a job's metadata, reconciling the recorded state against reality. A job
 * started by a previous server process has nobody listening for its exit, so
 * "running" is only trusted while the pid is actually alive.
 */
/** The Codex thread a job belongs to, recovered from its event stream. */
export function getThreadId(jobId: string): string | undefined {
  return summarizeEvents(jobId, 0).threadId;
}

export function getJob(jobId: string): JobMeta | undefined {
  const meta = readMeta(jobId);
  if (!meta) return undefined;
  // A thread id only exists once Codex has started; fill it in opportunistically
  // so a follow-up can be sent even to a job we never saw exit.
  if (!meta.threadId) {
    const threadId = getThreadId(jobId);
    if (threadId) {
      meta.threadId = threadId;
      writeMeta(meta);
    }
  }
  if (meta.state !== "running") return meta;
  if (pidAlive(meta.pid)) return meta;

  const result = jobFile(jobId, F.result);
  const produced = fs.existsSync(result) && fs.statSync(result).size > 0;
  meta.state = produced ? "done" : "failed";
  meta.endedAt = Date.now();
  if (!produced) {
    meta.error =
      truncate(readTail(jobFile(jobId, F.stderr), 4000).trim(), 600) ||
      "process exited without producing a result";
  }
  writeMeta(meta);
  return meta;
}

export function listJobs(): JobMeta[] {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs
    .readdirSync(JOBS_DIR)
    .map((id) => getJob(id))
    .filter((m): m is JobMeta => m !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function readResult(jobId: string): string {
  try {
    return fs.readFileSync(jobFile(jobId, F.result), "utf8").trim();
  } catch {
    return "";
  }
}

export function readStderr(jobId: string): string {
  return readTail(jobFile(jobId, F.stderr), 8000).trim();
}

export function cancelJob(jobId: string): JobMeta | undefined {
  const meta = getJob(jobId);
  if (!meta) return undefined;
  if (meta.state !== "running") return meta;

  if (process.platform === "win32") {
    // Codex spawns its own children; /T takes the whole tree with it.
    execFile("taskkill", ["/PID", String(meta.pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-meta.pid, "SIGTERM");
    } catch {
      try {
        process.kill(meta.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  meta.state = "cancelled";
  meta.endedAt = Date.now();
  writeMeta(meta);
  return meta;
}

/** Delete finished jobs older than `maxAgeMs`. Running jobs are never touched. */
export function pruneJobs(maxAgeMs: number): number {
  let removed = 0;
  for (const meta of listJobs()) {
    if (meta.state === "running") continue;
    const ended = meta.endedAt ?? meta.startedAt;
    if (Date.now() - ended > maxAgeMs) {
      fs.rmSync(jobDir(meta.jobId), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export function elapsedSeconds(meta: JobMeta): number {
  return Math.round(((meta.endedAt ?? Date.now()) - meta.startedAt) / 1000);
}
