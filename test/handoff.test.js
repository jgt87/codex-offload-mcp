import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureBaseline, diffSinceBaseline } from "../dist/handoff.js";

function git(repo, ...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "codex-offload-handoff-"));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }));

  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Handoff Test");
  git(repo, "config", "user.email", "handoff-test@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  return repo;
}

function commitFiles(repo, files) {
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(repo, path), contents, "utf8");
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "initial");
}

function requireBaseline(repo) {
  const baseline = captureBaseline(repo);
  assert.ok(baseline, "expected a git baseline");
  assert.ok(baseline.head, "expected the repository to have a HEAD commit");
  return baseline;
}

function requireChanges(repo, baseline) {
  const changes = diffSinceBaseline(repo, baseline);
  assert.ok(changes, "expected changes since the git baseline");
  return changes;
}

test("marks files modified before baseline capture as preexisting", (t) => {
  const repo = createRepo(t);
  commitFiles(repo, {
    "already-modified.txt": "initial\n",
    "modified-after.txt": "initial\n",
  });

  appendFileSync(join(repo, "already-modified.txt"), "before baseline\n");
  const baseline = requireBaseline(repo);
  assert.deepEqual(baseline.dirty, ["already-modified.txt"]);

  appendFileSync(join(repo, "already-modified.txt"), "after baseline\n");
  appendFileSync(join(repo, "modified-after.txt"), "after baseline\n");
  const changes = requireChanges(repo, baseline);

  assert.deepEqual(changes.modified, [
    { path: "already-modified.txt", status: "M", preexisting: true },
    { path: "modified-after.txt", status: "M", preexisting: false },
  ]);
});

test("preserves spaces and non-ASCII characters in NUL-delimited paths", (t) => {
  const repo = createRepo(t);
  const names = ["with space.txt", "cafe\u0301.txt"];
  commitFiles(repo, Object.fromEntries(names.map((name) => [name, "initial\n"])));

  for (const name of names) appendFileSync(join(repo, name), "before baseline\n");
  const baseline = requireBaseline(repo);
  assert.deepEqual([...baseline.dirty].sort(), [...names].sort());

  for (const name of names) appendFileSync(join(repo, name), "after baseline\n");
  const changes = requireChanges(repo, baseline);
  const byPath = new Map(changes.modified.map((change) => [change.path, change]));

  for (const name of names) {
    assert.deepEqual(byPath.get(name), { path: name, status: "M", preexisting: true });
  }
  assert.equal(byPath.size, names.length);
});

test("reports a renamed file by its destination path", (t) => {
  const repo = createRepo(t);
  commitFiles(repo, { "old name.txt": "unchanged contents\n" });

  git(repo, "mv", "old name.txt", "renamed cafe\u0301.txt");
  const baseline = requireBaseline(repo);
  assert.deepEqual(baseline.dirty, ["renamed cafe\u0301.txt"]);

  const changes = requireChanges(repo, baseline);
  assert.deepEqual(changes.modified, [
    { path: "renamed cafe\u0301.txt", status: "R100", preexisting: true },
  ]);
});

test("reports an untracked file created after the baseline", (t) => {
  const repo = createRepo(t);
  commitFiles(repo, { "tracked.txt": "initial\n" });
  const baseline = requireBaseline(repo);

  writeFileSync(join(repo, "brand new.txt"), "untracked\n", "utf8");
  const changes = requireChanges(repo, baseline);

  assert.deepEqual(changes.modified, []);
  assert.deepEqual(changes.untracked, ["brand new.txt"]);
});
