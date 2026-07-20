import test from "node:test";
import assert from "node:assert/strict";

import {
  composePrompt,
  shouldDocument,
  DOCUMENTATION_INSTRUCTION,
  HANDOFF_SCHEMA,
} from "../dist/handoff.js";

test("documents by default for a job that can write", () => {
  assert.equal(shouldDocument({ sandbox: "workspace-write" }), true);
  assert.equal(shouldDocument({ sandbox: "danger-full-access" }), true);
});

test("never documents under read-only, which cannot write files", () => {
  assert.equal(shouldDocument({ sandbox: "read-only" }), false);
  // Even when asked for explicitly — the job still could not comply.
  assert.equal(shouldDocument({ sandbox: "read-only", documentation: true }), false);
});

test("an explicit false suppresses the instruction", () => {
  assert.equal(shouldDocument({ sandbox: "workspace-write", documentation: false }), false);
});

test("composePrompt appends the instruction, leaving the task first", () => {
  const out = composePrompt("Migrate the auth module.", { sandbox: "workspace-write" });
  assert.ok(out.startsWith("Migrate the auth module."));
  assert.ok(out.includes(DOCUMENTATION_INSTRUCTION));
});

test("composePrompt returns the prompt untouched when not documenting", () => {
  const prompt = "Analyse the retry logic.";
  assert.equal(composePrompt(prompt, { sandbox: "read-only" }), prompt);
  assert.equal(
    composePrompt(prompt, { sandbox: "workspace-write", documentation: false }),
    prompt,
  );
});

test("the instruction steers away from inventing changelog files", () => {
  // Doc sprawl is the main way this feature goes wrong: an unqualified
  // "document your changes" produces a NOTES.md in every repo it touches.
  assert.match(DOCUMENTATION_INSTRUCTION, /Prefer editing existing files/);
  assert.match(DOCUMENTATION_INSTRUCTION, /Do not invent a changelog/);
  assert.match(DOCUMENTATION_INSTRUCTION, /CHANGES\.md, NOTES\.md/);
});

test("the instruction allows skipping when documentation is not warranted", () => {
  assert.match(DOCUMENTATION_INSTRUCTION, /Skip it when it does not apply/);
});

test("the handoff schema requires an account of documentation", () => {
  assert.ok(HANDOFF_SCHEMA.properties.documentation);
  // Strict schemas reject partially-specified objects, so every property must
  // appear in `required` or Codex's final message is rejected outright.
  assert.ok(HANDOFF_SCHEMA.required.includes("documentation"));
  assert.equal(
    HANDOFF_SCHEMA.required.length,
    Object.keys(HANDOFF_SCHEMA.properties).length,
  );
});
