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
import { findModel, knownEfforts, listedModels, readModelIndex } from "./models.js";
import { route } from "./route.js";
import { offloadGuidance, readOffloadLevel } from "./offload.js";

const SANDBOX = z.enum(["read-only", "workspace-write", "danger-full-access"]);

// Read once at startup from Codex's own model index, so models and reasoning
// levels released after this server was written are picked up without a code
// change. Restart the server to re-read. Falls back safely when unreadable.
const MODEL_INDEX = readModelIndex();

// Operator bias on the whether-to-offload judgment, read once at startup like
// the model index. It only shifts the prose the calling model reads in the
// codex_start description — it enforces nothing. Restart to change it.
const OFFLOAD_LEVEL = readOffloadLevel();

// Built from the index rather than hand-written. A hardcoded list was wrong
// within an hour of being written: it invented "none" and "minimal", which no
// model advertises, and omitted "ultra", which two models support.
const REASONING = z.enum(knownEfforts(MODEL_INDEX) as [string, ...string[]]);

/** Compact menu of what is actually available, for tool descriptions. */
function modelMenu(): string {
  const listed = listedModels(MODEL_INDEX);
  if (listed.length === 0) return "(model index unavailable; Codex config defaults apply)";
  return listed
    .map((m) => `${m.slug} [${m.efforts.map((e) => e.effort).join("|")}]`)
    .join("; ");
}

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
    ...(meta.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
    ...(meta.routing ? { routing: meta.routing } : {}),
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
      "background while you keep working. Two reasons to reach for it. One: the task is " +
      "self-contained and slow (refactors, migrations, test writing, bulk edits across files), so " +
      "running it in the background buys concurrency. Two: the task is self-contained and " +
      "output-heavy (generating a lot of code, tests, or boilerplate), so letting Codex produce " +
      "those tokens conserves your own usage — this reason holds even when the task is fast, " +
      "because you and Codex bill separately. Codex edits files on disk directly in `cwd`, so " +
      "treat the working tree as modified once the job finishes. " +
      "Poll with codex_status and collect the answer with codex_result. " +
      "Still the wrong tool for a quick question you need answered right now, and for trivial " +
      "triage or classification (relevance filtering, labelling, risky-or-not) send those to a " +
      "local model instead — this returns a job id, not an answer, so anything cheaper to resolve " +
      "another way should be. " +
      "Model and reasoning effort are chosen automatically from the task text unless you set them; " +
      "the choice and its reasoning come back in the response, and setting either one explicitly " +
      "overrides it. Call codex_models to see what is available." +
      offloadGuidance(OFFLOAD_LEVEL),
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
      model: z
        .string()
        .optional()
        .describe(
          `Pin the model instead of letting it be chosen from the task. Available: ${modelMenu()}. ` +
            "Omit to let routing pick one.",
        ),
      documentation: z
        .boolean()
        .optional()
        .describe(
          "Default true for jobs that can write: Codex is asked to update the project's existing " +
            "documentation when the change alters behaviour, adds a feature, or makes an existing " +
            "statement untrue, and to report what it touched. It is told to edit existing docs " +
            "rather than invent a changelog, and to skip when the change does not warrant any. " +
            "Set false to suppress the instruction. Always off under read-only, which cannot write.",
        ),
      autoRoute: z
        .boolean()
        .optional()
        .describe(
          "Default true. Set false to suppress automatic selection entirely and use only what you " +
            "pass (or the Codex config defaults) — useful when the keyword heuristic misreads a " +
            "task and you want no inference at all.",
        ),
      reasoningEffort: REASONING.optional().describe(
        "How hard the model should think, overriding your Codex config for this job only. Match it " +
          "to the task: 'low' for mechanical work where the answer is obvious and the cost is " +
          "typing (renames, moving files, applying a stated pattern); 'medium' for ordinary " +
          "implementation; 'high' or 'xhigh' for genuinely hard reasoning — tricky concurrency, " +
          "subtle logic, design decisions with real trade-offs. Higher settings cost more and take " +
          "longer, so raising it for simple work buys nothing. Note that accepted values vary by " +
          "model: 'none', 'low', 'medium', 'high' and 'xhigh' are widely supported, while 'minimal' " +
          "and 'max' are rejected by some models and will fail the job on its first API call. " +
          "Omit to inherit the config default.",
      ),
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
  async ({
    prompt,
    cwd,
    model,
    sandbox,
    addDirs,
    structured,
    reasoningEffort,
    autoRoute,
    documentation,
  }) => {
    try {
      const chosen = route(MODEL_INDEX, { prompt, model, reasoningEffort, autoRoute });

      // Reject an effort this model cannot take before spawning. Codex forwards
      // the value unchecked, so otherwise it fails a turn minutes in.
      const info = chosen.model ? findModel(MODEL_INDEX, chosen.model) : undefined;
      if (chosen.reasoningEffort && info && info.efforts.length > 0) {
        const ok = info.efforts.map((e) => e.effort);
        if (!ok.includes(chosen.reasoningEffort)) {
          return {
            ...text(
              `Model ${chosen.model} does not accept reasoningEffort '${chosen.reasoningEffort}'. ` +
                `It supports: ${ok.join(", ")}.`,
            ),
            isError: true,
          };
        }
      }

      const meta = startJob({
        prompt,
        cwd,
        sandbox,
        addDirs,
        structured,
        model: chosen.model,
        reasoningEffort: chosen.reasoningEffort,
        routing: { tier: chosen.tier, rationale: chosen.rationale, auto: chosen.auto },
        documentation,
      });
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
  "codex_execute_plan",
  {
    title: "Hand Codex a plan to execute",
    description:
      "The execute half of plan→execute: you do the design thinking in this conversation, write a " +
      "concrete step-by-step plan, and hand it here for Codex to carry out in the background — " +
      "getting a jobId back immediately, exactly like codex_start. Codex is told the plan was " +
      "authored by another model and to follow it faithfully rather than redesign: if a step is " +
      "wrong or impossible it stops and reports in `blockers` instead of improvising, so you can " +
      "revise and resume with codex_reply. " +
      "Reach for this when the hard part was deciding *what* to do and the rest is faithful typing " +
      "across files — it keeps the reasoning on your side and the output tokens on Codex's. " +
      "Because the design is already done, the execution usually needs less reasoning effort than " +
      "the planning did, so consider pinning a lower `reasoningEffort` unless individual steps are " +
      "themselves subtle. The plan must be self-contained: Codex cannot see this conversation, so " +
      "state every step, file, and acceptance check in the plan text itself. " +
      "Poll with codex_status and collect the result with codex_result, which checks what Codex " +
      "did against git.",
    inputSchema: {
      plan: z
        .string()
        .min(1)
        .describe(
          "The step-by-step plan for Codex to execute. Write it as an ordered list of concrete " +
            "steps naming the files to touch and what each change is, plus how to tell it worked " +
            "(tests to run, behaviour to check). Self-contained: Codex cannot see this conversation.",
        ),
      cwd: z
        .string()
        .describe("Absolute path to the directory Codex should treat as its working root."),
      model: z
        .string()
        .optional()
        .describe(
          `Pin the model instead of letting it be chosen from the plan. Available: ${modelMenu()}. ` +
            "Omit to let routing pick one.",
        ),
      reasoningEffort: REASONING.optional().describe(
        "How hard Codex should think while executing. The planning is already done, so mechanical " +
          "execution can take a lower setting than the task as a whole would — raise it only when " +
          "individual steps are themselves subtle. Omit to let routing choose from the plan text.",
      ),
      autoRoute: z
        .boolean()
        .optional()
        .describe("Default true. Set false to use only the values you pass (or Codex defaults)."),
      sandbox: SANDBOX.optional().describe(
        "read-only = cannot modify anything; workspace-write (default) = may edit files under cwd; " +
          "danger-full-access = unrestricted, avoid unless the caller explicitly asked for it.",
      ),
      addDirs: z
        .array(z.string())
        .optional()
        .describe("Extra absolute directories Codex may write to, beyond cwd."),
      documentation: z
        .boolean()
        .optional()
        .describe(
          "Default true for jobs that can write: Codex updates existing docs the change makes " +
            "untrue and reports what it touched. Set false to suppress. Always off under read-only.",
        ),
      structured: z
        .boolean()
        .optional()
        .describe(
          "Default true: Codex returns a typed handoff report. Set false only for long prose where " +
            "the structure would get in the way.",
        ),
    },
  },
  async ({ plan, cwd, model, sandbox, addDirs, structured, reasoningEffort, autoRoute, documentation }) => {
    try {
      const chosen = route(MODEL_INDEX, { prompt: plan, model, reasoningEffort, autoRoute });

      const info = chosen.model ? findModel(MODEL_INDEX, chosen.model) : undefined;
      if (chosen.reasoningEffort && info && info.efforts.length > 0) {
        const ok = info.efforts.map((e) => e.effort);
        if (!ok.includes(chosen.reasoningEffort)) {
          return {
            ...text(
              `Model ${chosen.model} does not accept reasoningEffort '${chosen.reasoningEffort}'. ` +
                `It supports: ${ok.join(", ")}.`,
            ),
            isError: true,
          };
        }
      }

      const meta = startJob({
        prompt: plan,
        cwd,
        sandbox,
        addDirs,
        structured,
        model: chosen.model,
        reasoningEffort: chosen.reasoningEffort,
        routing: { tier: chosen.tier, rationale: chosen.rationale, auto: chosen.auto },
        documentation,
        planExecution: true,
      });
      return text({
        ...brief(meta),
        note:
          "Executing your plan in the background. Keep working; check codex_status when you need " +
          "it. If Codex reports a blocker, revise the plan and send it with codex_reply.",
      });
    } catch (err) {
      return { ...text(`Failed to start plan execution: ${(err as Error).message}`), isError: true };
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
        // events.failure is the structured turn.failed reason and names the
        // actual cause; meta.error is only a tail of stderr, which routinely
        // leads with unrelated warnings. Fall back to it when a job died
        // without ever reporting a failed turn. Full stderr is returned below
        // either way.
        ? { error: events.failure ?? meta.error, stderr: readStderr(jobId) || undefined }
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
      reasoningEffort: REASONING.optional().describe(
        "Reasoning effort for this follow-up. Defaults to the parent job's setting. Worth raising " +
          "when the first attempt got it wrong for want of thinking, and worth lowering when the " +
          "follow-up is a mechanical fixup of work already done.",
      ),
    },
  },
  async ({ jobId, prompt, structured, reasoningEffort }) => {
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
      const meta = replyJob(parent, prompt, structured, reasoningEffort);
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
  "codex_models",
  {
    title: "List available Codex models",
    description:
      "Show the models this Codex install offers and the reasoning efforts each one accepts, read " +
      "from Codex's own model index. Use it when you want to pin `model` or `reasoningEffort` on " +
      "codex_start and need to know what is legal — the accepted efforts differ per model, and a " +
      "value the model does not take fails the job rather than the call. Also reports how the " +
      "index was obtained, so a stale or missing one is visible rather than silent.",
    inputSchema: {},
  },
  async () => {
    const listed = listedModels(MODEL_INDEX);
    return text({
      source: MODEL_INDEX.source,
      fetchedAt: MODEL_INDEX.fetchedAt,
      clientVersion: MODEL_INDEX.clientVersion,
      ...(MODEL_INDEX.note ? { note: MODEL_INDEX.note } : {}),
      // Read at startup; restart the server to pick up a newer index.
      models: listed.map((m) => ({
        slug: m.slug,
        description: m.description,
        defaultEffort: m.defaultEffort,
        efforts: m.efforts,
      })),
      routing:
        "codex_start picks model and effort from the task text unless you pass them. " +
        "mechanical -> low, standard -> medium, hard -> high, clamped to what the model supports.",
      // Visible so an operator can confirm CODEX_MCP_OFFLOAD_LEVEL took effect;
      // it biases how readily the caller offloads, not how a job is routed.
      offloadBias: OFFLOAD_LEVEL,
    });
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
