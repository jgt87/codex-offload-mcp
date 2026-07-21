import test from "node:test";
import assert from "node:assert/strict";

import { readOffloadLevel, offloadGuidance } from "../dist/offload.js";

test("defaults to balanced when the env var is unset", () => {
  assert.equal(readOffloadLevel({}), "balanced");
});

test("defaults to balanced for an unrecognised value", () => {
  assert.equal(readOffloadLevel({ CODEX_MCP_OFFLOAD_LEVEL: "maximum" }), "balanced");
});

test("reads each recognised level, case- and whitespace-insensitively", () => {
  assert.equal(readOffloadLevel({ CODEX_MCP_OFFLOAD_LEVEL: "aggressive" }), "aggressive");
  assert.equal(readOffloadLevel({ CODEX_MCP_OFFLOAD_LEVEL: "  Conservative " }), "conservative");
  assert.equal(readOffloadLevel({ CODEX_MCP_OFFLOAD_LEVEL: "BALANCED" }), "balanced");
});

test("balanced adds nothing — the base description already encodes it", () => {
  assert.equal(offloadGuidance("balanced"), "");
});

test("aggressive lowers the bar but keeps the hard exclusions", () => {
  const g = offloadGuidance("aggressive");
  assert.match(g, /aggressive/);
  assert.match(g, /conserve this model's usage/);
  assert.match(g, /Lower the bar/);
  // The exploratory/context/trivial exclusions must survive a bias toward offloading.
  assert.match(g, /exploratory/);
  assert.match(g, /local model/);
});

test("conservative raises the bar", () => {
  const g = offloadGuidance("conservative");
  assert.match(g, /conservative/);
  assert.match(g, /Raise the bar/);
  assert.match(g, /kept in-process/);
});

test("every level's clause is safe to concatenate onto a description", () => {
  // Non-empty clauses lead with a space so they read as a new sentence when
  // appended; the empty (balanced) clause needs no leading space.
  for (const level of ["conservative", "aggressive"]) {
    assert.match(offloadGuidance(level), /^ /);
  }
});
