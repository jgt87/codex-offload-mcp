#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelJob,
  elapsedSeconds,
  getJob,
  JOBS_DIR,
  listJobs,
  pruneJobs,
  readResult,
  readStderr,
  replyJob,
  startJob,
  summarizeEvents,
  type JobMeta,
} from "./jobs.js";
import { diffSinceBaseline, parseReport } from "./handoff.js";

const SANDBOX = z.enum(["read-only", "workspace-write", "danger-full-access"]);

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function notFound(jobId: string) {
  return {
    ...text(`No job with id "${jobId}". Use codex_list to see known jobs.`),
    isError: true as const,
  };
}

/** The shape shared by status/list, kept small so polling stays cheap. */
function brief(meta: JobMeta) {
  return {
    jobId: meta.jobId,
    state: meta.state,
    elapsedSeconds: elapsedSeconds(meta),
    cwd: meta.cwd,
    model: meta.model ?? "(codex default)",
    sandbox: meta.sandbox,
    prompt: meta.prompt.length > 160 ? `${meta.prompt.slice(0, 160)}…` : meta.prompt,
    ...(meta.parentJobId ? { parentJobId: meta.parentJobId } : {}),
  };
}

const server = new McpServer({ name: "codex-offload", version: "0.1.0" });

server.registerTool(
  "codex_start",
  {
    title: "Start a Codex job",
    description:
      "Hand a coding task to the Codex CLI and get a jobId back immediately — Codex runs in the " +
      "background while you keep working. Use this for work that is self-contained and slow " +
      "(refactors, migrations, test writing, bulk edits across files). Codex edits files on disk " +
      "directly in `cwd`, so treat the working tree as modified once the job finishes. " +
      "Poll with codex_status and collect the answer with codex_result. " +
      "For a quick question where you need the answer right now, prefer the built-in `codex` tool " +
      "(from `codex mcp-server`), which blocks until it is done.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "The task for Codex. Be specific and self-contained: Codex cannot see this conversation, " +
            "so restate the relevant context, constraints, and what 'done' looks like.",
        ),
      cwd: z
        .string()
        .describe("Absolute path to the directory Codex should treat as its working root."),
      model: z.string().optional().describe("Model override, e.g. 'gpt-5-codex'. Omit for the Codex default."),
      sandbox: SANDBOX.optional().describe(
        "read-only = cannot modify anything; workspace-write (default) = may edit files under cwd; " +
          "danger-full-access = unrestricted, avoid unless the caller explicitly asked for it.",
      ),
      addDirs: z
        .array(z.string())
        .optional()
        .describe("Extra absolute directories Codex may write to, beyond cwd."),
      structured: z
        .boolean()
        .optional()
        .describe(
          "Default true: Codex must return a typed handoff report (summary, status, filesChanged, " +
            "verification, followUps, blockers, confidence). Set false only when you want a long " +
            "prose explanation and the structure would get in the way.",
        ),
    },
  },
  async ({ prompt, cwd, model, sandbox, addDirs, structured }) => {
    try {
      const meta = startJob({ prompt, cwd, model, sandbox, addDirs, structured });
      return text({
        ...brief(meta),
        note: "Started in the background. Keep working; check codex_status when you need it.",
      });
    } catch (err) {
      return { ...text(`Failed to start Codex job: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "codex_status",
  {
    title: "Check a Codex job",
    description:
      "Report whether a job is still running and what it has done so far (commands run, files " +
      "edited, latest messages). Cheap to call. Does not block — if the job is still running, it " +
      "says so rather than waiting.",
    inputSchema: {
      jobId: z.string().describe("Id returned by codex_start."),
      verbose: z
        .boolean()
        .optional()
        .describe("Include the full recent activity trace instead of just the last few entries."),
    },
  },
  async ({ jobId, verbose }) => {
    const meta = getJob(jobId);
    if (!meta) return notFound(jobId);
    const events = summarizeEvents(jobId, verbose ? 100 : 5);
    return text({
      ...brief(meta),
      commandsRun: events.commandsRun,
      filesTouched: events.filesTouched,
      recentActivity: events.activity,
      ...(meta.error ? { error: meta.error } : {}),
      ...(events.failure ? { failure: events.failure } : {}),
    });
  },
);

server.registerTool(
  "codex_result",
  {
    title: "Collect a Codex job's output",
    description:
      "Collect a finished job's handoff: Codex's structured report (what it did, what it verified, " +
      "what it left undone, how confident it is) alongside `actualChanges` — the file changes " +
      "according to git, independent of what Codex claims. Trust `actualChanges` over the report " +
      "when they disagree, and re-read any changed file before reasoning about it. " +
      "If the job is still running this returns progress instead; it never blocks.",
    inputSchema: {
      jobId: z.string().describe("Id returned by codex_start."),
      includeActivity: z
        .boolean()
        .optional()
        .describe("Also return the full trace of what Codex did to get there."),
    },
  },
  async ({ jobId, includeActivity }) => {
    const meta = getJob(jobId);
    if (!meta) return notFound(jobId);

    const events = summarizeEvents(jobId, includeActivity ? 200 : 0);

    if (meta.state === "running") {
      return text({
        ...brief(meta),
        note: "Still running — no final answer yet. Retry once codex_status reports 'done'.",
        commandsRun: events.commandsRun,
        filesTouched: events.filesTouched,
      });
    }

    const { report, raw } = parseReport(readResult(jobId));
    const changes = meta.git ? diffSinceBaseline(meta.cwd, meta.git) : undefined;

    return text({
      ...brief(meta),
      threadId: meta.threadId,
      ...(report ? { report } : { output: raw || "(no final message was produced)" }),
      actualChanges: changes
        ? {
            ...changes,
            note:
              "From git, measured against the working tree as it was when the job started. " +
              "Entries flagged preexisting were already modified beforehand and are not Codex's work.",
          }
        : "unavailable — cwd is not a git repository, so file changes could not be verified independently",
      commandsRun: events.commandsRun,
      ...(events.usage ? { usage: events.usage } : {}),
      ...(includeActivity ? { activity: events.activity } : {}),
      ...(meta.state !== "done"
        ? { error: meta.error ?? events.failure, stderr: readStderr(jobId) || undefined }
        : {}),
      nextStep: meta.threadId
        ? "Use codex_reply with this jobId to send corrections or follow-ups — Codex keeps its context."
        : undefined,
    });
  },
);

server.registerTool(
  "codex_reply",
  {
    title: "Follow up on a Codex job",
    description:
      "Send a follow-up into a finished job's Codex thread — corrections, review comments, 'you " +
      "missed X', 'now do Y as well'. Codex retains everything from the original job, so this is " +
      "far better than starting a fresh job that would begin cold. " +
      "Returns a new jobId that you poll exactly like codex_start. " +
      "The follow-up reuses the original job's working directory and sandbox.",
    inputSchema: {
      jobId: z.string().describe("The job to continue. May itself be a previous codex_reply job."),
      prompt: z.string().min(1).describe("The follow-up message for Codex."),
      structured: z
        .boolean()
        .optional()
        .describe("Whether to require a typed report. Defaults to the parent job's setting."),
    },
  },
  async ({ jobId, prompt, structured }) => {
    const parent = getJob(jobId);
    if (!parent) return notFound(jobId);
    if (parent.state === "running") {
      return {
        ...text(
          `Job ${jobId} is still running. Wait for it to finish before replying, or cancel it first.`,
        ),
        isError: true,
      };
    }
    try {
      const meta = replyJob(parent, prompt, structured);
      return text({
        ...brief(meta),
        threadId: meta.threadId,
        note: "Follow-up started in the background, continuing the same Codex thread.",
      });
    } catch (err) {
      return { ...text(`Failed to start follow-up: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "codex_cancel",
  {
    title: "Cancel a Codex job",
    description:
      "Stop a running job and its child processes. Any file edits Codex already made stay on " +
      "disk — cancelling does not roll anything back.",
    inputSchema: { jobId: z.string().describe("Id returned by codex_start.") },
  },
  async ({ jobId }) => {
    const meta = cancelJob(jobId);
    if (!meta) return notFound(jobId);
    return text({
      ...brief(meta),
      note:
        meta.state === "cancelled"
          ? "Cancelled. Files already edited were left as-is."
          : `Job was already ${meta.state}; nothing to cancel.`,
    });
  },
);

server.registerTool(
  "codex_list",
  {
    title: "List Codex jobs",
    description:
      "List known jobs, newest first, with their current state. Use this to find a jobId you " +
      "lost track of, or to check whether anything is still running.",
    inputSchema: {
      state: z
        .enum(["running", "done", "failed", "cancelled"])
        .optional()
        .describe("Only return jobs in this state."),
      limit: z.number().int().positive().max(100).optional().describe("Default 20."),
    },
  },
  async ({ state, limit }) => {
    const jobs = listJobs()
      .filter((m) => !state || m.state === state)
      .slice(0, limit ?? 20)
      .map(brief);
    return text({ count: jobs.length, jobsDir: JOBS_DIR, jobs });
  },
);

// Finished jobs accumulate on disk; drop anything older than a week at startup.
try {
  pruneJobs(7 * 24 * 60 * 60 * 1000);
} catch {
  // pruning is best-effort and must never stop the server from starting
}

const transport = new StdioServerTransport();
await server.connect(transport);
