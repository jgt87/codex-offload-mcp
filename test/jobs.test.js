import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const previousJobsDir = process.env.CODEX_MCP_JOBS_DIR;
const jobsDir = mkdtempSync(join(tmpdir(), "codex-offload-jobs-"));
process.env.CODEX_MCP_JOBS_DIR = jobsDir;

const {
  elapsedSeconds,
  getJob,
  listJobs,
  pruneJobs,
  readResult,
  readStderr,
  summarizeEvents,
} = await import("../dist/jobs.js");

after(() => {
  rmSync(jobsDir, { recursive: true, force: true, maxRetries: 3 });
  if (previousJobsDir === undefined) delete process.env.CODEX_MCP_JOBS_DIR;
  else process.env.CODEX_MCP_JOBS_DIR = previousJobsDir;
});

let nextJobNumber = 0;

function createJob(t, overrides = {}) {
  const jobId = overrides.jobId ?? `job-${++nextJobNumber}`;
  const dir = join(jobsDir, jobId);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  const meta = {
    jobId,
    prompt: "test prompt",
    cwd: jobsDir,
    sandbox: "workspace-write",
    pid: process.pid,
    state: "done",
    startedAt: Date.now(),
    structured: true,
    ...overrides,
    jobId,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return { dir, meta };
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  assert.ok(child.pid, "expected the short-lived process to have a pid");
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

test("summarizeEvents extracts details and ignores a truncated trailing line", (t) => {
  const { dir, meta } = createJob(t);
  const events = [
    { type: "thread.started", thread_id: "thread-123" },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "npm test" },
    },
    {
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [{ path: "src/a.ts" }, { path: "README.md" }, { path: "src/a.ts" }],
      },
    },
    {
      type: "item.completed",
      item: { type: "reasoning", text: "checking the implementation" },
    },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "npm run build" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "finished successfully" },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 25 },
    },
  ];
  const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n{"type":"item.com`;
  writeFileSync(join(dir, "events.jsonl"), jsonl, "utf8");

  const summary = summarizeEvents(meta.jobId, 2);

  assert.equal(summary.threadId, "thread-123");
  assert.deepEqual(summary.usage, {
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 25,
  });
  assert.equal(summary.commandsRun, 2);
  assert.deepEqual(summary.filesTouched, ["src/a.ts", "README.md"]);
  assert.deepEqual(summary.activity, [
    "ran: npm run build",
    "message: finished successfully",
  ]);
});

test("getJob marks a dead running job with a result as done", async (t) => {
  const { dir, meta } = createJob(t, { state: "running", pid: await exitedPid() });
  writeFileSync(join(dir, "last-message.txt"), "completed result\n", "utf8");

  const reconciled = getJob(meta.jobId);

  assert.equal(reconciled?.state, "done");
  assert.equal(typeof reconciled?.endedAt, "number");
  assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).state, "done");
});

test("getJob marks a dead running job without a result as failed", async (t) => {
  const { dir, meta } = createJob(t, { state: "running", pid: await exitedPid() });

  const reconciled = getJob(meta.jobId);

  assert.equal(reconciled?.state, "failed");
  assert.equal(reconciled?.error, "process exited without producing a result");
  assert.equal(typeof reconciled?.endedAt, "number");
  const persisted = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.error, "process exited without producing a result");
});

test("getJob returns a terminal job unchanged", (t) => {
  const { meta } = createJob(t, {
    state: "cancelled",
    startedAt: 1_000,
    endedAt: 4_000,
    exitCode: null,
  });

  assert.deepEqual(getJob(meta.jobId), meta);
});

test("getJob returns undefined for an unknown job id", () => {
  assert.equal(getJob("job-that-does-not-exist"), undefined);
});

test("listJobs returns jobs newest first", (t) => {
  const older = createJob(t, { startedAt: 1_000 }).meta;
  const newest = createJob(t, { startedAt: 3_000 }).meta;
  const middle = createJob(t, { startedAt: 2_000 }).meta;
  const ids = new Set([older.jobId, newest.jobId, middle.jobId]);

  const listedIds = listJobs()
    .filter((meta) => ids.has(meta.jobId))
    .map((meta) => meta.jobId);

  assert.deepEqual(listedIds, [newest.jobId, middle.jobId, older.jobId]);
});

test("pruneJobs removes old finished jobs but never running jobs", (t) => {
  const now = Date.now();
  const oldFinished = createJob(t, {
    state: "done",
    startedAt: now - 120_000,
    endedAt: now - 120_000,
  });
  const recentFinished = createJob(t, {
    state: "failed",
    startedAt: now - 500,
    endedAt: now - 500,
  });
  const oldRunning = createJob(t, {
    state: "running",
    pid: process.pid,
    startedAt: now - 120_000,
  });

  assert.equal(pruneJobs(60_000), 1);
  assert.equal(existsSync(oldFinished.dir), false);
  assert.equal(existsSync(recentFinished.dir), true);
  assert.equal(existsSync(oldRunning.dir), true);
  assert.equal(getJob(oldRunning.meta.jobId)?.state, "running");
});

test("elapsedSeconds rounds the elapsed duration to whole seconds", () => {
  assert.equal(elapsedSeconds({ startedAt: 1_000, endedAt: 4_600 }), 4);
});

test("readResult and readStderr return empty strings for missing files", (t) => {
  const { meta } = createJob(t);

  assert.equal(readResult(meta.jobId), "");
  assert.equal(readStderr(meta.jobId), "");
});
