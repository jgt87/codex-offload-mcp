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

export interface ComposeOptions {
  /** Read-only jobs cannot write anything, so the instruction is pointless there. */
  sandbox: string;
  /** Explicit opt-out. Undefined means "decide from the sandbox". */
  documentation?: boolean;
}

/** True when a job is both allowed and asked to document itself. */
export function shouldDocument(opts: ComposeOptions): boolean {
  if (opts.documentation === false) return false;
  if (opts.sandbox === "read-only") return false;
  return true;
}

/** The text actually handed to Codex, which is not always the caller's prompt. */
export function composePrompt(prompt: string, opts: ComposeOptions): string {
  return shouldDocument(opts) ? `${prompt}\n\n${DOCUMENTATION_INSTRUCTION}\n` : prompt;
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
