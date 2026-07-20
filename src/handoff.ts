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
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How sure you are the work is correct. Say low rather than overstating.",
    },
  },
  required: ["summary", "status", "filesChanged", "verification", "followUps", "blockers", "confidence"],
  additionalProperties: false,
} as const;

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
