import {
  clampEffort,
  findModel,
  listedModels,
  type ModelIndex,
  type ModelInfo,
} from "./models.js";

/**
 * Automatic selection of model and reasoning effort from the task text.
 *
 * This is a heuristic, and it is the one part of this server that is *not*
 * derived from anything authoritative. Which models exist and which efforts
 * they accept come from Codex's own index; the judgment of "this task is
 * mechanical" does not, and cannot — no API reports it. So the rule here is
 * that the choice is always **reported and always overridable**: an explicit
 * `model` or `reasoningEffort` wins outright, `autoRoute: false` disables it,
 * and every job records the tier and the reason it was picked.
 *
 * Keyword matching is crude on purpose. A cleverer classifier would need a
 * model call, which would add latency to a tool whose entire promise is
 * returning immediately.
 */

export type Tier = "mechanical" | "standard" | "hard";

export interface Routing {
  tier: Tier;
  model?: string;
  reasoningEffort?: string;
  /** Human-readable account of why, surfaced to the caller. */
  rationale: string;
  /** False when the caller supplied the values explicitly. */
  auto: boolean;
}

/** Work whose shape is known before it starts; the cost is typing, not thinking. */
const MECHANICAL = [
  /\brename\b/i,
  /\bmove (?:the )?(?:file|function|class|module)/i,
  /\bformat(?:ting)?\b/i,
  /\blint(?:ing)?\b/i,
  /\btypos?\b/i,
  /\bbump (?:the )?version\b/i,
  /\bsort (?:the )?imports\b/i,
  /\b(?:add|update) (?:the )?(?:licence|license|copyright) header/i,
  /\bboilerplate\b/i,
  /\bmechanical(?:ly)?\b/i,
  /\bfind and replace\b/i,
  /\bapply the (?:same )?pattern\b/i,
  /\bregenerate\b/i,
];

/** Work where being wrong is expensive and the answer is not obvious up front. */
const HARD = [
  /\bconcurren(?:t|cy)\b/i,
  /\brace condition\b/i,
  /\bdeadlock\b/i,
  /\bmemory leak\b/i,
  /\bsecurity\b/i,
  /\bvulnerabilit(?:y|ies)\b/i,
  /\bperformance regression\b/i,
  /\barchitect(?:ure|ural)\b/i,
  /\bredesign\b/i,
  /\btrade-?offs?\b/i,
  /\broot cause\b/i,
  /\bsubtle\b/i,
  /\bthread[- ]safe(?:ty)?\b/i,
  /\bdata (?:loss|corruption)\b/i,
  /\bmigrate .{0,40}\b(?:framework|architecture|database)\b/i,
];

function matched(patterns: RegExp[], text: string): string[] {
  return patterns.map((p) => text.match(p)?.[0]).filter((m): m is string => !!m);
}

export function classify(prompt: string): { tier: Tier; rationale: string } {
  const hard = matched(HARD, prompt);
  const mech = matched(MECHANICAL, prompt);

  // Hard wins ties: under-thinking a subtle problem costs more than
  // over-thinking a simple one, and a prompt hitting both is not mechanical.
  if (hard.length > 0) {
    return {
      tier: "hard",
      rationale: `matched high-complexity wording (${[...new Set(hard)].slice(0, 3).join(", ")})`,
    };
  }
  if (mech.length > 0) {
    return {
      tier: "mechanical",
      rationale: `matched mechanical wording (${[...new Set(mech)].slice(0, 3).join(", ")})`,
    };
  }
  return { tier: "standard", rationale: "no strong signal either way; treated as ordinary work" };
}

const TIER_EFFORT: Record<Tier, string> = {
  mechanical: "low",
  standard: "medium",
  hard: "high",
};

/**
 * Vendor descriptions carry the capability signal; `priority` does not, since
 * Codex ranks a "fast and affordable" model above a "frontier" one there.
 * Matching on their wording means a renamed lineup still routes sensibly, and
 * when nothing matches we fall back to Codex's own first choice.
 */
const TIER_MODEL: Record<Tier, RegExp> = {
  mechanical: /\b(fast|affordable|cost[- ]efficient|small|mini|lightweight)\b/i,
  standard: /\b(balanced|everyday)\b/i,
  hard: /\b(frontier|advanced|most capable)\b/i,
};

function pickModel(index: ModelIndex, tier: Tier): ModelInfo | undefined {
  const listed = listedModels(index);
  if (listed.length === 0) return undefined;
  const want = TIER_MODEL[tier];
  return listed.find((m) => m.description && want.test(m.description)) ?? listed[0];
}

export interface RouteInput {
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  autoRoute?: boolean;
}

export function route(index: ModelIndex, input: RouteInput): Routing {
  const { tier, rationale } = classify(input.prompt);

  // Explicit beats inferred, always — and partial explicitness is honoured, so
  // pinning a model still lets effort be routed and vice versa.
  if (input.autoRoute === false) {
    return {
      tier,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      rationale: "auto-routing disabled; using the caller's values (or Codex defaults)",
      auto: false,
    };
  }

  const chosenModel = input.model ?? pickModel(index, tier)?.slug;
  const modelInfo = chosenModel ? findModel(index, chosenModel) : undefined;

  const targetEffort = input.reasoningEffort ?? TIER_EFFORT[tier];
  const effort = input.reasoningEffort
    ? input.reasoningEffort
    : clampEffort(modelInfo, targetEffort);

  const parts: string[] = [`classified as ${tier} — ${rationale}`];
  if (input.model) parts.push(`model pinned by caller (${input.model})`);
  else if (chosenModel) parts.push(`model ${chosenModel} chosen for this tier`);
  else parts.push("no model chosen; Codex config default applies");

  if (input.reasoningEffort) parts.push(`effort pinned by caller (${input.reasoningEffort})`);
  else if (effort && effort !== targetEffort) {
    parts.push(`effort ${targetEffort} unsupported here, using nearest supported (${effort})`);
  } else if (effort) parts.push(`effort ${effort}`);

  return {
    tier,
    model: chosenModel,
    reasoningEffort: effort,
    rationale: parts.join("; "),
    auto: !(input.model && input.reasoningEffort),
  };
}
