import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readModelIndex,
  getModelIndex,
  listedModels,
  knownEfforts,
  clampEffort,
  findModel,
} from "../dist/models.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "models-test-"));

function fixture(contents) {
  const file = path.join(tmp(), "models_cache.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

// Mirrors the real cache's shape, including a model that tops out below the
// highest level any model offers.
const CACHE = {
  fetched_at: "2026-07-20T15:37:37Z",
  client_version: "0.145.0",
  models: [
    {
      slug: "top",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "low",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "ultra", description: "Maximum reasoning" },
      ],
    },
    {
      slug: "cheap",
      description: "Fast and affordable agentic coding model.",
      visibility: "list",
      priority: 3,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
    },
    {
      slug: "hidden",
      description: "Internal.",
      visibility: "hide",
      priority: 9,
      supported_reasoning_levels: [{ effort: "low" }],
    },
  ],
};

test("reads models, efforts and metadata from a cache file", () => {
  const idx = readModelIndex(fixture(CACHE));
  assert.equal(idx.source, "cache");
  assert.equal(idx.clientVersion, "0.145.0");
  assert.equal(idx.models.length, 3);
  assert.deepEqual(
    findModel(idx, "top").efforts.map((e) => e.effort),
    ["low", "medium", "high", "ultra"],
  );
});

test("hidden models are excluded from the offered list but stay resolvable", () => {
  const idx = readModelIndex(fixture(CACHE));
  assert.deepEqual(
    listedModels(idx).map((m) => m.slug),
    ["top", "cheap"],
  );
  // Still findable, so a caller pinning it explicitly is not blocked.
  assert.ok(findModel(idx, "hidden"));
});

test("listed models come back in Codex's own priority order", () => {
  const shuffled = { ...CACHE, models: [CACHE.models[1], CACHE.models[0]] };
  assert.deepEqual(
    listedModels(readModelIndex(fixture(shuffled))).map((m) => m.slug),
    ["top", "cheap"],
  );
});

test("knownEfforts unions across models, picking up levels no static list had", () => {
  const efforts = knownEfforts(readModelIndex(fixture(CACHE)));
  assert.ok(efforts.includes("ultra"));
  assert.ok(efforts.includes("low"));
  // Never invented: no model advertises these.
  assert.ok(!efforts.includes("minimal"));
  assert.ok(!efforts.includes("none"));
});

test("falls back rather than throwing when the file is missing", () => {
  const idx = readModelIndex(path.join(tmp(), "absent.json"));
  assert.equal(idx.source, "fallback");
  assert.deepEqual(idx.models, []);
  assert.match(idx.note, /no file at/);
});

test("falls back when the file is not JSON", () => {
  const idx = readModelIndex(fixture("{not json"));
  assert.equal(idx.source, "fallback");
  assert.match(idx.note, /invalid JSON/);
});

test("falls back when the schema has shifted beyond recognition", () => {
  // The real failure mode: a newer client writes a shape this code cannot read.
  const idx = readModelIndex(fixture({ models: [{ id: "no-slug-field" }] }));
  assert.equal(idx.source, "fallback");
  assert.match(idx.note, /no usable model entries/);
});

test("tolerates unknown and missing fields on a model entry", () => {
  const idx = readModelIndex(
    fixture({ models: [{ slug: "bare", some_future_field: 42 }] }),
  );
  assert.equal(idx.source, "cache");
  assert.equal(idx.models[0].slug, "bare");
  assert.deepEqual(idx.models[0].efforts, []);
  assert.equal(idx.models[0].listed, true);
});

test("clampEffort keeps a supported value untouched", () => {
  const idx = readModelIndex(fixture(CACHE));
  assert.equal(clampEffort(findModel(idx, "top"), "high"), "high");
});

test("clampEffort drops to the nearest supported level below the target", () => {
  const idx = readModelIndex(fixture(CACHE));
  // "cheap" tops out at medium, so a high target must not be sent as-is.
  assert.equal(clampEffort(findModel(idx, "cheap"), "high"), "medium");
});

test("clampEffort rises to the lowest supported level when nothing is below", () => {
  const idx = readModelIndex(fixture({ models: [{ slug: "m", supported_reasoning_levels: [{ effort: "high" }] }] }));
  assert.equal(clampEffort(findModel(idx, "m"), "low"), "high");
});

test("clampEffort passes the target through for a model with no known efforts", () => {
  const idx = readModelIndex(fixture({ models: [{ slug: "bare" }] }));
  assert.equal(clampEffort(findModel(idx, "bare"), "medium"), "medium");
});

test("getModelIndex re-reads when the cache file changes on disk", () => {
  // The bug this guards: a long-running server routes to a model Codex has
  // since dropped, because it read the lineup once at startup.
  const file = fixture({ models: [{ slug: "old-model" }] });

  const first = getModelIndex(file);
  assert.deepEqual(first.models.map((m) => m.slug), ["old-model"]);

  // Codex rewrites its cache with a new lineup. Push the mtime forward so the
  // change is visible even on filesystems with coarse timestamp resolution.
  fs.writeFileSync(file, JSON.stringify({ models: [{ slug: "new-model" }] }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(file, future, future);

  const second = getModelIndex(file);
  assert.deepEqual(
    second.models.map((m) => m.slug),
    ["new-model"],
    "getModelIndex must pick up the rewritten cache without a restart",
  );
});

test("getModelIndex does not pin the fallback when the file is temporarily missing", () => {
  // A missing file must not be cached, or a transient read failure would freeze
  // the server on the fallback until restart — the opposite of the goal.
  const dir = tmp();
  const file = path.join(dir, "models_cache.json");

  assert.equal(getModelIndex(file).source, "fallback");

  fs.writeFileSync(file, JSON.stringify({ models: [{ slug: "arrived" }] }));
  assert.deepEqual(getModelIndex(file).models.map((m) => m.slug), ["arrived"]);
});
