import test from "node:test";
import assert from "node:assert/strict";

import { classify, route } from "../dist/route.js";

// Hand-built index, so these assertions describe the routing rules rather than
// whatever models happen to be installed on the machine running the tests.
const INDEX = {
  source: "cache",
  models: [
    {
      slug: "frontier-one",
      description: "Latest frontier agentic coding model.",
      efforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "ultra" }],
      listed: true,
      priority: 1,
    },
    {
      slug: "balanced-one",
      description: "Balanced agentic coding model for everyday work.",
      efforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      listed: true,
      priority: 2,
    },
    {
      slug: "cheap-one",
      description: "Fast and affordable agentic coding model.",
      efforts: [{ effort: "low" }, { effort: "medium" }],
      listed: true,
      priority: 3,
    },
  ],
};

const EMPTY = { source: "fallback", models: [], note: "unreadable" };

test("classifies obviously mechanical work as mechanical", () => {
  assert.equal(classify("Rename getUser to fetchUser across the repo").tier, "mechanical");
  assert.equal(classify("Fix the typos in the README").tier, "mechanical");
});

test("classifies work with expensive failure modes as hard", () => {
  assert.equal(classify("Fix the race condition in the job scheduler").tier, "hard");
  assert.equal(classify("Investigate the memory leak in the worker pool").tier, "hard");
});

test("defaults to standard when there is no strong signal", () => {
  const c = classify("Add an endpoint that returns the current user's projects");
  assert.equal(c.tier, "standard");
  assert.match(c.rationale, /no strong signal/);
});

test("hard wins over mechanical when a prompt matches both", () => {
  // Under-thinking a subtle problem costs more than over-thinking a simple one.
  const c = classify("Rename the lock helper while fixing the deadlock it causes");
  assert.equal(c.tier, "hard");
});

test("routes each tier to a model matching the vendor's own wording", () => {
  assert.equal(route(INDEX, { prompt: "Rename the helper" }).model, "cheap-one");
  assert.equal(route(INDEX, { prompt: "Add a projects endpoint" }).model, "balanced-one");
  assert.equal(route(INDEX, { prompt: "Fix the race condition" }).model, "frontier-one");
});

test("maps tiers to efforts", () => {
  assert.equal(route(INDEX, { prompt: "Rename the helper" }).reasoningEffort, "low");
  assert.equal(route(INDEX, { prompt: "Add a projects endpoint" }).reasoningEffort, "medium");
  assert.equal(route(INDEX, { prompt: "Fix the race condition" }).reasoningEffort, "high");
});

test("an explicit model is never overridden", () => {
  const r = route(INDEX, { prompt: "Rename the helper", model: "frontier-one" });
  assert.equal(r.model, "frontier-one");
  assert.match(r.rationale, /pinned by caller/);
});

test("an explicit effort is never overridden, even beyond the tier's default", () => {
  const r = route(INDEX, { prompt: "Rename the helper", reasoningEffort: "ultra" });
  assert.equal(r.reasoningEffort, "ultra");
  assert.match(r.rationale, /pinned by caller/);
});

test("pinning both marks the job as not auto-routed", () => {
  const r = route(INDEX, { prompt: "anything", model: "cheap-one", reasoningEffort: "low" });
  assert.equal(r.auto, false);
});

test("autoRoute false suppresses inference entirely", () => {
  const r = route(INDEX, { prompt: "Fix the race condition", autoRoute: false });
  assert.equal(r.model, undefined);
  assert.equal(r.reasoningEffort, undefined);
  assert.equal(r.auto, false);
  assert.match(r.rationale, /disabled/);
});

test("a tier's effort is clamped to what the chosen model supports", () => {
  // Only the cheap model matches "mechanical", and it tops out at medium; a
  // hard task pinned to it must not be sent "high".
  const r = route(INDEX, { prompt: "Fix the race condition", model: "cheap-one" });
  assert.equal(r.reasoningEffort, "medium");
  assert.match(r.rationale, /unsupported here/);
});

test("falls back to Codex defaults when the index is empty", () => {
  const r = route(EMPTY, { prompt: "Rename the helper" });
  assert.equal(r.model, undefined);
  assert.match(r.rationale, /no model chosen/);
});

test("always explains itself", () => {
  for (const prompt of ["Rename x", "Fix the deadlock", "Add a feature"]) {
    const r = route(INDEX, { prompt });
    assert.ok(r.rationale.length > 0);
    assert.match(r.rationale, /classified as/);
  }
});
