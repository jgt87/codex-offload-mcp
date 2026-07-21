/**
 * Operator control over how aggressively the calling model should offload work
 * to Codex.
 *
 * The whether-to-delegate decision lives nowhere in this code — the calling
 * model reads the `codex_start` description and judges against it (see
 * CLAUDE.md, "When to offload"). Routing decides *how* a job runs, never
 * *whether* it runs. So the only honest place for a knob that shifts *whether*
 * is the text that description carries: this module turns an env var into a bias
 * clause appended to it. It steers the model's judgment; it enforces nothing,
 * which is why it is a clause of prose and not a branch in `route.ts`.
 *
 * Set `CODEX_MCP_OFFLOAD_LEVEL` in the MCP server's env to `conservative`,
 * `balanced` (default), or `aggressive`. Read once at startup like the model
 * index, so restart the server to change it.
 */

export type OffloadLevel = "conservative" | "balanced" | "aggressive";

const LEVELS: readonly OffloadLevel[] = ["conservative", "balanced", "aggressive"];

/** Parse the env var, defaulting to `balanced` for anything unset or unknown. */
export function readOffloadLevel(env: NodeJS.ProcessEnv = process.env): OffloadLevel {
  const raw = env.CODEX_MCP_OFFLOAD_LEVEL?.trim().toLowerCase() ?? "";
  return (LEVELS as readonly string[]).includes(raw) ? (raw as OffloadLevel) : "balanced";
}

/**
 * The clause appended to the `codex_start` description for a given level.
 * `balanced` is the description's built-in default, so it adds nothing — the
 * base prose already encodes balanced judgment, and emitting a "you are
 * balanced" note would be noise the model has to read on every call.
 */
export function offloadGuidance(level: OffloadLevel): string {
  switch (level) {
    case "aggressive":
      return (
        " OFFLOAD BIAS: aggressive — the operator has asked to conserve this model's usage. " +
        "Lower the bar for reaching for codex_start: when a task is self-contained, prefer a " +
        "background job even for medium-sized or fast work, and resolve genuine judgement calls " +
        "toward offloading rather than doing it inline. The hard exclusions still bind — never " +
        "offload work that needs this conversation's context, is exploratory (direction changes as " +
        "you learn each step), or is trivial triage/classification (that goes to a local model)."
      );
    case "conservative":
      return (
        " OFFLOAD BIAS: conservative — the operator prefers work kept in-process. Raise the bar for " +
        "reaching for codex_start: use it only when a task is clearly self-contained and either slow " +
        "or genuinely output-heavy, and resolve borderline cases by doing them inline."
      );
    case "balanced":
      return "";
  }
}
