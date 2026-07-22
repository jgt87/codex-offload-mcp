import test from "node:test";
import assert from "node:assert/strict";

import {
  composePrompt,
  shouldDocument,
  deriveHandback,
  DOCUMENTATION_INSTRUCTION,
  PLAN_EXECUTION_INSTRUCTION,
  HANDBACK_INSTRUCTION,
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

test("composePrompt leads with the task and omits the doc note when not documenting", () => {
  const prompt = "Analyse the retry logic.";
  // The hand-back instruction is unconditional, so the prompt is never returned
  // wholesale — but the task still leads and the documentation note stays out.
  for (const opts of [
    { sandbox: "read-only" },
    { sandbox: "workspace-write", documentation: false },
  ]) {
    const out = composePrompt(prompt, opts);
    assert.ok(out.startsWith(prompt));
    assert.ok(!out.includes(DOCUMENTATION_INSTRUCTION));
  }
});

test("the hand-back instruction is appended to every job, read-only included", () => {
  // Privilege and tool walls stop a read-only job as easily as a writing one,
  // so the hand-back note is not gated on the sandbox.
  for (const opts of [
    { sandbox: "read-only" },
    { sandbox: "workspace-write" },
    { sandbox: "workspace-write", documentation: false },
    { sandbox: "danger-full-access", planExecution: true },
  ]) {
    assert.ok(composePrompt("Do the thing", opts).includes(HANDBACK_INSTRUCTION));
  }
});

test("the hand-back instruction separates a wall from ordinary difficulty", () => {
  // The guardrail that keeps it from firing on every hard task: cannot vs hard.
  assert.match(HANDBACK_INSTRUCTION, /genuinely cannot cross/i);
  assert.match(HANDBACK_INSTRUCTION, /not for ordinary difficulty/i);
  assert.match(HANDBACK_INSTRUCTION, /work to finish/i);
  // And it forbids the failure modes: faking, bypassing safety, grinding.
  assert.match(HANDBACK_INSTRUCTION, /Do not fabricate/i);
  assert.match(HANDBACK_INSTRUCTION, /Do not disable, bypass, or widen/i);
  assert.match(HANDBACK_INSTRUCTION, /Do not retry the same blocked action in a loop/i);
});

test("deriveHandback surfaces a blocked report and stays quiet on a clean one", () => {
  const blocked = deriveHandback({ status: "blocked", blockers: ["needs network to fetch deps"] });
  assert.equal(blocked?.status, "blocked");
  assert.deepEqual(blocked?.blockers, ["needs network to fetch deps"]);
  assert.match(blocked?.note ?? "", /handed this back/i);

  // A blocked status with no blocker listed is still a hand-back — the summary
  // carries the detail — so it must surface.
  assert.ok(deriveHandback({ status: "blocked", blockers: [] }));

  // Complete work is not a hand-back.
  assert.equal(deriveHandback({ status: "complete", blockers: [] }), undefined);
});

test("deriveHandback treats a partial only as a hand-back when it names a wall", () => {
  // Partial with blockers = stopped at a wall partway; surface it.
  assert.ok(deriveHandback({ status: "partial", blockers: ["missing API token"] }));
  // Partial with none = ordinary leftover work, not a hand-back.
  assert.equal(deriveHandback({ status: "partial", blockers: [] }), undefined);
});

test("deriveHandback tolerates a missing or malformed report", () => {
  assert.equal(deriveHandback(undefined), undefined);
  assert.equal(deriveHandback("not an object"), undefined);
  assert.equal(deriveHandback({}), undefined);
  // Non-string blocker entries are dropped rather than thrown on.
  const h = deriveHandback({ status: "blocked", blockers: ["real", 42, null] });
  assert.deepEqual(h?.blockers, ["real"]);
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

test("plan execution prepends the faithful-execution framing before the plan", () => {
  const out = composePrompt("1. Edit foo.ts\n2. Add a test", {
    sandbox: "workspace-write",
    planExecution: true,
  });
  assert.ok(out.startsWith(PLAN_EXECUTION_INSTRUCTION));
  assert.ok(out.includes("1. Edit foo.ts"));
  // The plan comes after the framing, not before it.
  assert.ok(out.indexOf(PLAN_EXECUTION_INSTRUCTION) < out.indexOf("1. Edit foo.ts"));
});

test("plan execution and documentation compose: framing first, plan, then doc note", () => {
  const out = composePrompt("Do the steps", { sandbox: "workspace-write", planExecution: true });
  const framing = out.indexOf(PLAN_EXECUTION_INSTRUCTION);
  const plan = out.indexOf("Do the steps");
  const doc = out.indexOf(DOCUMENTATION_INSTRUCTION);
  assert.ok(framing < plan && plan < doc, "expected framing < plan < documentation");
});

test("plan execution framing is absent unless asked for", () => {
  const out = composePrompt("Do the steps", { sandbox: "workspace-write" });
  assert.ok(!out.includes(PLAN_EXECUTION_INSTRUCTION));
});

test("the plan-execution framing insists on stop-and-report over silent redesign", () => {
  // The whole point of the mode: the executor must not quietly substitute its
  // own design when a step is wrong — it must surface it so the planner revises.
  assert.match(PLAN_EXECUTION_INSTRUCTION, /do not redesign/i);
  assert.match(PLAN_EXECUTION_INSTRUCTION, /STOP at that step/);
  assert.match(PLAN_EXECUTION_INSTRUCTION, /blockers/);
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
