import { execFileSync } from "node:child_process";

/**
 * The shape Codex is required to return when structured reporting is on.
 *
 * Every field is required — the model can emit empty arrays — because strict
 * schema enforcement rejects partially-specified objects.
 */
export const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "What you did, or the answer, in prose. This is the main handoff.",
    },
    status: {
      type: "string",
      enum: ["complete", "partial", "blocked"],
      description: "complete = the task is done; partial = some of it remains; blocked = could not proceed.",
    },
    filesChanged: {
      type: "array",
      description: "Every file you created, edited or deleted, and what you did to it.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          change: { type: "string", description: "What changed and why, in one line." },
        },
        required: ["path", "change"],
        additionalProperties: false,
      },
    },
    verification: {
      type: "array",
      description: "Commands you ran to check your work (tests, builds, linters) and their outcome.",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          passed: { type: "boolean" },
          details: { type: "string", description: "Failure output, or a one-line note on success." },
        },
        required: ["command", "passed", "details"],
        additionalProperties: false,
      },
    },
    followUps: {
      type: "array",
      description: "Work you deliberately left undone, and anything the caller should check.",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      description: "What stopped you, if status is partial or blocked. Empty otherwise.",
      items: { type: "string" },
    },
    documentation: {
      type: "string",
      description:
        "Which documentation files you created or updated for this work and what you changed in " +
        "them — or, if you updated none, why none were warranted. Answer either way; do not leave " +
        "it empty.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How sure you are the work is correct. Say low rather than overstating.",
    },
  },
  required: [
    "summary",
    "status",
    "filesChanged",
    "verification",
    "followUps",
    "blockers",
    "documentation",
    "confidence",
  ],
  additionalProperties: false,
} as const;

/**
 * Appended to the task so a job documents itself. Codex cannot see the calling
 * conversation, so without this the docs simply never get written — the caller
 * would have to remember to ask every time.
 *
 * The wording leans hard against creating new files. An instruction to
 * "document your changes" reliably produces a CHANGES.md or NOTES.md in every
 * repo it touches, which is worse than no documentation: it fragments what a
 * reader has to consult and rots immediately.
 */
export const DOCUMENTATION_INSTRUCTION = [
  "---",
  "Documentation requirement (added by the caller, applies to all work above):",
  "",
  "If this change alters behaviour, adds a feature, changes an interface, or introduces a",
  "constraint a future reader would need to know, update the project's existing documentation to",
  "match — typically README.md, AGENTS.md or CLAUDE.md, or files under docs/.",
  "",
  "- Prefer editing existing files. Only create a new one if the project has no documentation at",
  "  all, or clearly keeps that kind of information in separate files already.",
  "- Do not invent a changelog. Do not add CHANGES.md, NOTES.md or similar unless the repository",
  "  already maintains one.",
  "- Match the surrounding document: its voice, heading depth, and level of detail.",
  "- Update anything your change made untrue. Correcting a stale statement matters more than",
  "  adding a new one.",
  "- Skip it when it does not apply — an internal refactor with no observable change, or a fix too",
  "  small to be worth a reader's attention. Say so in the `documentation` field rather than",
  "  padding the docs.",
].join("\n");

/**
 * Prepended when a job is executing a plan another model already authored. The
 * design thinking is done and lives in the plan; the failure mode to guard
 * against is the executor quietly substituting its own approach. So the framing
 * asks for faithful execution and, crucially, for a *stop-and-report* on any
 * step it cannot carry out — the planner can then revise and resume rather than
 * discover a silent redesign after the fact. This is the executor half of the
 * plan→execute pair; the planning half is done in-process by the caller.
 */
export const PLAN_EXECUTION_INSTRUCTION = [
  "You are executing a plan authored by another model (the planner), which has already done the",
  "design thinking. Carry it out faithfully — do not redesign it.",
  "",
  "- Follow the steps in order and implement exactly what each one specifies.",
  "- Small, obvious fill-ins the plan left implicit (an import it omitted, an exact type) are fine.",
  "  Substituting a different algorithm, structure, or interface is not.",
  "- If a step is wrong, impossible, or unsafe, STOP at that step and record it in `blockers`",
  "  rather than improvising a different design. The planner can revise the plan and resume.",
  "- In `summary`, call out every step you completed, any you could not, and anywhere you had to",
  "  deviate and why.",
  "",
  "The plan follows.",
  "---",
].join("\n");

/**
 * Appended to every job, regardless of sandbox. Codex runs as a background job
 * for a driving model that is still active and can do things Codex cannot —
 * reach the conversation, obtain approvals, run outside the sandbox. So when
 * Codex hits a wall it genuinely cannot cross, the useful move is to stop and
 * hand that piece back cleanly, not to fake a result, quietly substitute a
 * weaker approach, disable a safety restriction, or grind until it times out.
 *
 * Two things about the wording are deliberate. It is unconditional (unlike the
 * documentation note) because privilege and tool walls happen under read-only
 * too. And it draws a hard line between *cannot* (a boundary — hand back) and
 * *hard* (a failing test, a stubborn bug — work to finish), because an
 * unqualified "stop when blocked" turns every difficulty into a premature
 * hand-back, which is worse than useless: it parks two models on work one could
 * have finished.
 */
export const HANDBACK_INSTRUCTION = [
  "---",
  "Handing work back (added by the caller, applies to all work above):",
  "",
  "You are running as a background job for another model that is still active and can do things you",
  "cannot. If you hit a boundary you genuinely cannot cross, stop and hand that piece back rather",
  "than forcing it. Boundaries that warrant a hand-back:",
  "",
  "- A command, file, or network access the sandbox denies, or an action needing an approval or",
  "  privilege escalation you cannot obtain here.",
  "- Missing credentials, tokens, or authentication you were not given and cannot safely acquire.",
  "- A tool or capability this environment does not give you.",
  "- Something that turns on a decision or context living in the caller's conversation, which you",
  "  cannot see.",
  "",
  "When that happens:",
  "",
  "- Do not fabricate a result, silently substitute a weaker approach, or claim a success you did",
  "  not achieve.",
  "- Do not disable, bypass, or widen a safety or sandbox restriction to force it through.",
  "- Do not retry the same blocked action in a loop or grind until you time out.",
  "- Do as much of the surrounding work as you legitimately can. Then set `status` to `blocked`, or",
  "  `partial` if other parts succeeded, and record each wall in `blockers` as a concrete request:",
  "  what you were doing, what stopped you, and the exact thing the caller must do to unblock it —",
  "  run the command themselves, grant network, supply credential X, widen the sandbox to",
  "  workspace-write, decide Y. If you are not returning a structured report, say the same plainly",
  "  at the start of your summary.",
  "",
  "This is only for things you truly cannot do, not for ordinary difficulty. A failing test, a",
  "compile error, or a hard bug is work to finish — not a wall to hand back.",
].join("\n");

export interface ComposeOptions {
  /** Read-only jobs cannot write anything, so the instruction is pointless there. */
  sandbox: string;
  /** Explicit opt-out. Undefined means "decide from the sandbox". */
  documentation?: boolean;
  /** Prepend the plan-execution framing — the prompt is a plan to be carried out, not a fresh task. */
  planExecution?: boolean;
}

/** True when a job is both allowed and asked to document itself. */
export function shouldDocument(opts: ComposeOptions): boolean {
  if (opts.documentation === false) return false;
  if (opts.sandbox === "read-only") return false;
  return true;
}

/** The text actually handed to Codex, which is not always the caller's prompt. */
export function composePrompt(prompt: string, opts: ComposeOptions): string {
  // Framing goes before the plan; the standing instructions go after the work,
  // as they do for an ordinary job. Order matters: the executor should read
  // "here is a plan to carry out" before the plan itself.
  let text = opts.planExecution ? `${PLAN_EXECUTION_INSTRUCTION}\n${prompt}` : prompt;
  // Hand-back is unconditional — a privilege or tool wall can stop a read-only
  // job as easily as a writing one — while documentation stays write-gated.
  text = `${text}\n\n${HANDBACK_INSTRUCTION}\n`;
  if (shouldDocument(opts)) text = `${text}\n${DOCUMENTATION_INSTRUCTION}\n`;
  return text;
}

export interface Handback {
  /** The report status that triggered the hand-back: "blocked" or "partial". */
  status: string;
  /** Each wall Codex could not cross, as it recorded them. */
  blockers: string[];
  /** What the caller should do about it, in prose. */
  note: string;
}

/**
 * Lift a blocked (or partial-with-blockers) report into a top-level hand-back
 * signal, so a job that stopped at a wall it could not cross is impossible to
 * miss under the nested report — the whole point of the hand-back is that the
 * driving model *acts* on it. Returns undefined when nothing was handed back:
 * a plain `complete`, or a `partial` that is ordinary leftover work rather than
 * a wall (no blockers), reads normally through the report.
 */
export function deriveHandback(report: unknown): Handback | undefined {
  if (!report || typeof report !== "object") return undefined;
  const r = report as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : undefined;
  if (status !== "blocked" && status !== "partial") return undefined;

  const blockers = Array.isArray(r.blockers)
    ? r.blockers.filter((b): b is string => typeof b === "string")
    : [];
  // A partial with no blocker named is just leftover work, not a hand-back.
  if (status === "partial" && blockers.length === 0) return undefined;

  const note =
    status === "blocked"
      ? "Codex stopped at a boundary it could not cross and handed this back. Take it over: act on " +
        "the blockers (run the command yourself, widen the sandbox, supply the missing access or " +
        "decision), then finish the work in-thread or send it back with codex_reply."
      : "Codex completed part of the work and handed the rest back. Act on the blockers, then either " +
        "finish those pieces yourself or unblock Codex and continue with codex_reply.";

  return { status, blockers, note };
}

export interface GitBaseline {
  head: string | null;
  /** Files already modified before the job started — their changes are not Codex's doing. */
  dirty: string[];
}

export interface GitChanges {
  modified: { path: string; status: string; preexisting: boolean }[];
  untracked: string[];
  stat: string;
  head: string | null;
  headMoved: boolean;
}

/**
 * Trailing whitespace only — `git status --porcelain` encodes the status in the
 * first two columns, so trimming the leading space would corrupt the first
 * line's path.
 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).replace(/\s+$/, "");
  } catch {
    return undefined; // not a repo, no commits, or git is missing
  }
}

/**
 * All git plumbing here runs with -z. In the human-readable formats git quotes
 * any path containing a space or non-ASCII character, and it quotes
 * inconsistently between commands — `status --porcelain` quotes "with space.txt"
 * while `diff --name-status` does not — so paths from the two would never match.
 * NUL-separated output is never quoted.
 */
function nulFields(out: string | undefined): string[] {
  return (out ?? "").split("\0").filter((s) => s.length > 0);
}

/** `status --porcelain -z` entries are `XY<space>path`; renames add an old-path field. */
function parseStatusZ(out: string | undefined): string[] {
  const fields = nulFields(out);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i += 1; // consume the paired old path
  }
  return paths;
}

/** `diff --name-status -z` emits status and path as separate fields. */
function parseNameStatusZ(out: string | undefined): { status: string; path: string }[] {
  const fields = nulFields(out);
  const rows: { status: string; path: string }[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]!;
    i += 1;
    if (status[0] === "R" || status[0] === "C") {
      i += 1; // old path
      const dest = fields[i];
      i += 1;
      if (dest !== undefined) rows.push({ status, path: dest });
    } else {
      const path = fields[i];
      i += 1;
      if (path !== undefined) rows.push({ status, path });
    }
  }
  return rows;
}

export function captureBaseline(cwd: string): GitBaseline | undefined {
  const inRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo !== "true") return undefined;
  return {
    head: git(cwd, ["rev-parse", "HEAD"])?.trim() ?? null,
    dirty: parseStatusZ(git(cwd, ["status", "--porcelain", "-z"])),
  };
}

/**
 * What actually changed on disk, according to git rather than according to Codex.
 * Diffing against the baseline commit catches work Codex committed as well as
 * work left in the working tree.
 */
export function diffSinceBaseline(cwd: string, baseline: GitBaseline): GitChanges | undefined {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim() ?? null;
  const base = baseline.head;
  if (!base) return undefined;

  const modified = parseNameStatusZ(git(cwd, ["diff", "--name-status", "-z", base])).map(
    ({ status, path }) => ({
      path,
      status,
      preexisting: baseline.dirty.includes(path),
    }),
  );

  const untracked = nulFields(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));

  return {
    modified,
    untracked,
    stat: git(cwd, ["diff", "--stat", base]) ?? "",
    head,
    headMoved: head !== base,
  };
}

/** Codex returns the structured report as a JSON string; parse it if we can. */
export function parseReport(raw: string): { report?: unknown; raw: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { raw: trimmed };
  try {
    return { report: JSON.parse(trimmed), raw: trimmed };
  } catch {
    return { raw: trimmed };
  }
}
