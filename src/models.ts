import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Codex maintains a models index at `$CODEX_HOME/models_cache.json`, refreshed
 * from the server as part of normal use. Reading it is how this server learns
 * about models and reasoning levels released after it was written.
 *
 * This file is Codex's internal state, not a published API. Its schema changes:
 * the cache observed here was written by client 0.145.0 while the installed
 * binary was 0.144.4, and Codex itself could not parse it
 * (`missing field supports_reasoning_summaries`). So every field is treated as
 * optional and any shape that does not match is skipped rather than thrown on —
 * a stale index degrades to the fallback below, it never breaks a job.
 */

export interface EffortLevel {
  effort: string;
  description?: string;
}

export interface ModelInfo {
  slug: string;
  displayName?: string;
  description?: string;
  defaultEffort?: string;
  efforts: EffortLevel[];
  /** Codex hides some models from its own picker; we honour that. */
  listed: boolean;
  priority?: number;
}

export interface ModelIndex {
  models: ModelInfo[];
  /** "cache" when read from disk, "fallback" when we could not. */
  source: "cache" | "fallback";
  fetchedAt?: string;
  clientVersion?: string;
  /** Why the fallback was used, when it was. */
  note?: string;
}

/**
 * Used only when the cache is unreadable. Deliberately minimal: the four levels
 * every observed model supports, and no model slugs at all, since a guessed
 * slug is worse than letting Codex apply its own configured default.
 */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];

const FALLBACK: ModelIndex = {
  models: [],
  source: "fallback",
  note: "models_cache.json unreadable; effort validation falls back to a conservative list and model choice is left to Codex config",
};

export function cachePath(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(home, "models_cache.json");
}

/** Tolerant projection of one raw cache entry. Returns undefined if unusable. */
function toModel(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : undefined;
  if (!slug) return undefined;

  const levels = Array.isArray(r.supported_reasoning_levels) ? r.supported_reasoning_levels : [];
  const efforts: EffortLevel[] = [];
  for (const lv of levels) {
    if (lv && typeof lv === "object" && typeof (lv as any).effort === "string") {
      efforts.push({
        effort: (lv as any).effort,
        description:
          typeof (lv as any).description === "string" ? (lv as any).description : undefined,
      });
    } else if (typeof lv === "string") {
      // Tolerate a future shape where levels are bare strings.
      efforts.push({ effort: lv });
    }
  }

  return {
    slug,
    displayName: typeof r.display_name === "string" ? r.display_name : undefined,
    description: typeof r.description === "string" ? r.description : undefined,
    defaultEffort:
      typeof r.default_reasoning_level === "string" ? r.default_reasoning_level : undefined,
    efforts,
    // Absent visibility is treated as listed; hiding is the explicit signal.
    listed: r.visibility !== "hide" && r.supported_in_api !== false,
    priority: typeof r.priority === "number" ? r.priority : undefined,
  };
}

export function readModelIndex(file = cachePath()): ModelIndex {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ...FALLBACK, note: `${FALLBACK.note} (no file at ${file})` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...FALLBACK, note: `${FALLBACK.note} (invalid JSON at ${file})` };
  }

  const list = Array.isArray(parsed?.models) ? parsed.models : [];
  const models = list.map(toModel).filter((m: ModelInfo | undefined): m is ModelInfo => !!m);
  if (models.length === 0) {
    return { ...FALLBACK, note: `${FALLBACK.note} (no usable model entries at ${file})` };
  }

  return {
    models,
    source: "cache",
    fetchedAt: typeof parsed.fetched_at === "string" ? parsed.fetched_at : undefined,
    clientVersion: typeof parsed.client_version === "string" ? parsed.client_version : undefined,
  };
}

let cached: { index: ModelIndex; mtimeMs: number; file: string } | undefined;

/**
 * `readModelIndex` re-reading only when the cache file's mtime changes.
 *
 * The index is consulted on the hot path of every job launch, and Codex rewrites
 * `models_cache.json` during normal use — rotating its lineup, dropping models.
 * A server that read the index once at startup keeps routing to whatever was
 * current then, so once Codex drops a model the server still picks it and the
 * job fails *after* it spawns, with "model not available", minutes of nothing.
 * Refreshing on mtime change closes that gap without a restart, and costs only a
 * `stat` on the calls where nothing changed.
 */
export function getModelIndex(file = cachePath()): ModelIndex {
  let mtimeMs: number | undefined;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = undefined; // missing file: fall through, readModelIndex returns the fallback
  }
  if (cached && cached.file === file && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.index;
  }
  const index = readModelIndex(file);
  // Only remember a real mtime. If the file is missing we re-read next call
  // rather than pinning the fallback until restart — the opposite of the bug
  // this function exists to fix.
  if (mtimeMs !== undefined) cached = { index, mtimeMs, file };
  return index;
}

/** Models Codex would itself offer, best-first by its own priority ordering. */
export function listedModels(index: ModelIndex): ModelInfo[] {
  return index.models
    .filter((m) => m.listed)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
}

export function findModel(index: ModelIndex, slug: string): ModelInfo | undefined {
  return index.models.find((m) => m.slug === slug);
}

/**
 * Effort names known to be valid somewhere. Union across the index so a level
 * introduced with a new model is accepted without a code change — `ultra` was
 * already live and absent from this project's first hand-written list.
 */
export function knownEfforts(index: ModelIndex): string[] {
  const seen = new Set<string>();
  for (const m of index.models) for (const e of m.efforts) seen.add(e.effort);
  if (seen.size === 0) FALLBACK_EFFORTS.forEach((e) => seen.add(e));
  return [...seen];
}

/** Increasing order of thinking. Unknown names sort last so they are never auto-chosen. */
const LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function rankEffort(effort: string): number {
  const i = LADDER.indexOf(effort);
  return i === -1 ? LADDER.length : i;
}

/**
 * Nearest effort a given model actually supports, at or below the target, so a
 * model that tops out at `xhigh` never receives `ultra`. Falls back upward if
 * nothing at or below exists.
 */
export function clampEffort(model: ModelInfo | undefined, target: string): string | undefined {
  if (!model || model.efforts.length === 0) return target;
  const supported = model.efforts.map((e) => e.effort);
  if (supported.includes(target)) return target;

  const want = rankEffort(target);
  const below = supported
    .filter((e) => rankEffort(e) <= want)
    .sort((a, b) => rankEffort(b) - rankEffort(a))[0];
  if (below) return below;
  return supported.sort((a, b) => rankEffort(a) - rankEffort(b))[0];
}
