# CLAUDE.md

## What this is

An MCP server for running Claude Code and the Codex CLI as a pair: Claude drives and holds the
conversation, Codex takes self-contained work as background jobs. Claude calls `codex_start`, gets a
job id back immediately, keeps working, and collects the result later.

The point is **two models working concurrently**. Non-blocking delegation is the mechanism that
makes that possible, not the goal in itself — which matters when weighing a change. If a tool here
would block until Codex finishes, it does not belong in this server: a blocking call collapses the
pair back into one model at a time, with the driving model parked, which is the one outcome this
exists to avoid.

## When to offload

**Nothing here decides *whether* to delegate.** There is no scheduler and no queue — the only thing
steering that choice is the `codex_start` description in `src/index.ts`, which the calling model
reads at call time and judges against. Everything below is that judgment written down, not behaviour
the code enforces.

**The one operator lever on that judgment is `CODEX_MCP_OFFLOAD_LEVEL`** (`src/offload.ts`),
set in the MCP server's env. Because the whether-decision lives only in the description prose, the
knob works by appending a bias clause to that description — `aggressive` lowers the bar (offload
more, to conserve the driving model's usage), `conservative` raises it, `balanced` (default) adds
nothing. It steers the reading model; it enforces nothing, which is why it is a clause of prose and
not a branch in `route.ts`. Read once at startup like the model index, so restart to change it, and
surfaced in `codex_models`' `offloadBias` field so the active setting is visible. The hard
exclusions (needs conversation context, exploratory, trivial triage) still bind at every level — a
bias toward offloading must never override them.

**Model and effort *are* chosen here**, in `src/route.ts`, and that is the one exception to the
above. Keep the distinction sharp when editing: routing decides *how* a job runs, never *whether* it
runs. The facts it routes over — which models exist, which efforts each accepts — are read from
Codex's own index (`src/models.ts`), so they do not go stale; only the tier judgment is invented,
and it is a keyword heuristic by choice, since a classifier that called a model would add latency to
a tool whose entire promise is returning immediately. It is reported in every job's `routing` field
and overridden by any explicit `model` / `reasoningEffort`, or disabled with `autoRoute: false`.
A hardcoded effort list was tried first and was wrong within the hour: it invented `none` and
`minimal`, which no model advertises, and omitted `ultra`, which two models support. Do not
reintroduce one.

Offload when *all* of these hold:

- **Self-contained.** The task fits in a prompt. Codex cannot see the conversation, so anything
  depending on what was just worked out must be restated in full. If restating it is most of the
  work, offloading is a net loss.
- **Slow.** Minutes, not seconds. Below ~30s the round trip costs more than it saves.
- **There is real work to do meanwhile.** Dispatching and then polling gains nothing and makes the
  result harder to verify.
- **Verifiable afterwards.** Mechanical enough that `actualChanges` from git shows whether it went
  right.
- **Scoped to one `cwd`.** Codex writes to disk directly; ambiguous scope means unwanted edits.

Do it in-process when the task needs conversation context, is fast, is exploratory (direction
changes based on what each step finds), blocks the next decision, or is surgical enough that
specifying it precisely costs more than doing it.

**Exploratory work is the main trap.** Investigations where each measurement changes what you look
at next cannot be offloaded: by the time the prompt can be written, the thinking is done. A useful
tell is a wrong hypothesis — if you expect to have one, keep the work in-process.

Misjudging is asymmetric: a bad delegation writes files to disk. That asymmetry is why
`codex_result` checks Codex's self-report against git rather than trusting it — the design already
assumes a delegation can be wrong. Prefer `sandbox: "read-only"` for anything analytical.

### Policies

Standing rules that override the judgment above. The default is model judgment, and each entry is
a deliberate adjustment of it — usually a narrowing, occasionally a broadening. Append here rather
than editing the prose above, so the default and the exceptions stay separable.

Format: one bullet per rule, imperative, with the reason on the same line — the reason is what lets
a later reader tell a still-valid rule from a stale one.

<!-- Example of the intended shape (not an active rule):
- Never offload anything touching `src/jobs.ts` — process lifecycle changes need live verification,
  and a git diff cannot show that a job still survives its server.
-->

- **Usage arbitrage broadens offload: the "Slow" criterion is waived for output-heavy, specifiable
  work.** Offload generating a lot of code, tests, or boilerplate to Codex even when it would be
  fast. Reason: the driving model (Claude) and Codex bill separately, so letting Codex produce the
  expensive *output* tokens conserves Claude usage for reasoning, conversation, and verification —
  a saving that does not depend on the task being slow. The other criteria (self-contained,
  verifiable, single `cwd`, real work meanwhile) still hold; only "Slow" is relaxed. Do not confuse
  this with offloading *trivial* work — see the next rule — and remember the orchestration itself
  (writing the prompt, polling, verifying) costs Claude tokens, so the output has to be large enough
  to clear that overhead.
- **Trivial triage and classification go to the local model first, never Codex.** Relevance
  filtering, log/error labelling, "is this diff risky", short yes/no judgements over text → the
  `local-llm` MCP (`local_classify` / `local_ask`, qwen2.5-coder, runs on Ollama). Reason: it costs
  zero subscription usage on *either* vendor, and these are precisely the tasks where a wrong answer
  is cheap to detect — the condition that makes a small local model safe to lean on. Codex is the
  wrong tier for these: it returns a job id, not an answer, and bills a subscription to do it.

## Collaboration modes

The pair supports a handful of named ways to divide work between the driving model and Codex. Only
one needs machinery of its own; the rest are patterns over the existing tools, given a slash command
each so a human can start them from anywhere. The commands live canonically in `.claude/commands/`
(active in this repo, version-controlled) and are copied to `~/.claude/commands/` so they work in
every repo — the repo copy is the source of truth, so re-copy after editing one.

- **plan→execute** (`/plan-execute`, tool `codex_execute_plan`). The driving model does the design
  thinking in-conversation and hands Codex a finished, self-contained plan to carry out. This is the
  one mode with real machinery: `codex_execute_plan` prepends `PLAN_EXECUTION_INSTRUCTION`
  (`handoff.ts`) so Codex is told to follow the plan faithfully and *stop-and-report* on any step it
  cannot do, rather than silently substituting its own design — the failure mode the framing exists
  to catch. Because the reasoning is already extracted into the plan, execution usually wants a lower
  effort than the whole task would; routing still reads the plan text, and effort stays overridable.
  It threads through the same `composePrompt` seam as the documentation instruction (framing before
  the plan, doc note after), so `meta.prompt` still shows the caller's plan, not the machinery.
- **execute→review** (`/codex-review`). Codex does the work; the driving model reviews the git diff
  via `codex_result` and corrects in-thread with `codex_reply`. This is the verification loop given a
  front door — no new code.
- **split & parallelize** (`/codex-split`). Decompose into independent chunks (never two jobs writing
  the same file) and dispatch several `codex_start` calls at once. This is what non-blocking delegation
  is *for*; the command just names it.
- **draft→refine** (`/codex-draft`). Codex produces a fast bulk draft cheaply; the driving model
  refines it in-process where conversation context and taste are needed. Usage arbitrage on the
  output tokens, with the judgement kept on the driving side.

## Commands

```sh
npm run build     # tsc -> dist/
npm run watch     # tsc --watch
npm test          # build, then node --test test/*.test.js
```

Tests run against the **compiled** `dist/` output, not the TypeScript sources, which is why `npm
test` builds first. They cover `handoff.ts` git parsing and `jobs.ts` state reconciliation; the
spawn path in `startJob` / `replyJob` is deliberately not covered, since exercising it needs either
real Codex runs or a fake binary that Windows cannot spawn without a shell. Verify that path by
driving the built server over stdio with a JSON-RPC script (initialize →
`notifications/initialized` → `tools/call`); see "Verifying changes" below.

`test/jobs.test.js` sets `CODEX_MCP_JOBS_DIR` to a temp dir **before** a dynamic `import()` of the
compiled module. `JOBS_DIR` is a module-level const evaluated at import time, so a static import
would aim the tests at the real job store in the user's home directory — where `pruneJobs` would
delete from it. Keep any new job test on that same dynamic-import pattern.

Registered with Claude Code at user scope as `codex-offload`. After `npm run build`, restart the
MCP connection for changes to take effect — a running server keeps the old `dist/`.

## Layout

- `src/index.ts` — MCP server, tool definitions and their descriptions
- `src/jobs.ts` — job lifecycle: spawn, state reconciliation, event parsing, cancel, prune
- `src/handoff.ts` — the report schema Codex must fill in, the git-based change verification, and
  the standing instructions appended per job (documentation, plan-execution framing)
- `src/codexBin.ts` — locates the real Codex executable
- `src/models.ts` — tolerant reader for Codex's `models_cache.json`; the discovered facts.
  `getModelIndex()` re-reads on the file's mtime change, so routing tracks Codex rotating its lineup
- `src/route.ts` — the tier heuristic and tier→model/effort mapping; the invented part
- `src/offload.ts` — the `CODEX_MCP_OFFLOAD_LEVEL` operator lever; env var → bias clause on the
  `codex_start` description
- `.claude/commands/` — slash commands that start each collaboration mode; copied to
  `~/.claude/commands/` for use in every repo (see "Collaboration modes")

**Write-capable jobs are asked to document themselves.** `composePrompt` in `handoff.ts` appends a
standing instruction, and the report carries a required `documentation` field. Two things about it
are deliberate and easy to break. It biases hard toward editing existing files, because an
unqualified version produces a `NOTES.md` in every repo it touches; and it is appended only to the
text written to `prompt.txt`, never to `meta.prompt`, so status output keeps showing the caller's
actual prompt. `launch()` takes the composed text as a separate argument for exactly that reason.

## Architecture notes

**The model index is read at launch time, not frozen at startup.** `getModelIndex()` re-reads
`models_cache.json` whenever its mtime changes, and the launch handlers route over that rather than
the startup `MODEL_INDEX`. This is not a micro-optimisation to undo: Codex rewrites the cache during
normal use, and a server that read the lineup once would keep routing to a model Codex has since
dropped — the job then fails *after* it spawns with "model not available", which is exactly the
minutes-later failure the pre-spawn effort check exists to avoid. `MODEL_INDEX` survives only for the
static schema strings (the effort enum, the model menus in tool descriptions), which are fixed for an
MCP session and genuinely cannot change after registration; everything that picks a model for a real
job goes through `getModelIndex()`. A missing file is deliberately not cached, so a transient read
failure cannot pin the fallback until restart.

**Jobs are detached and disk-backed.** State lives in `~/.codex-mcp/jobs/<jobId>/`
(`meta.json`, `events.jsonl`, `stderr.log`, `last-message.txt`, `prompt.txt`), not in memory,
because a job outlives the server process that started it. Never move job state into a module-level
map — a job started by a previous server would become unreadable.

**`running` is a claim, not a fact.** `getJob()` reconciles it against the pid: if the recorded
state is `running` but the process is gone, the job is resolved to `done` or `failed` depending on
whether a result file was produced. Any new code path that reads job state must go through
`getJob()` / `listJobs()` rather than reading `meta.json` directly.

**The prompt travels over stdin**, never as an argv element — it is arbitrary user text and can be
long. Keep it that way.

**Spawn without a shell.** `resolveCodexBin()` finds the real platform binary inside the npm
package so we can pass an argv array. The `useShell: true` fallback exists only for when that
resolution fails; do not make it the default path.

**stdout is the MCP transport.** Anything written to stdout corrupts the protocol. Diagnostics go
to stderr or nowhere. This is why startup pruning is wrapped in a bare `catch`.

**Event parsing is tolerant.** `events.jsonl` is parsed while Codex is still writing to it, so a
trailing partial line is normal — unparseable lines are skipped, never thrown on. Files are read
tail-first with a byte cap so a chatty job cannot exhaust memory.

**The handoff does not trust Codex's self-report.** `--output-schema` gets a typed report out of
Codex, but `codex_result` pairs it with `actualChanges` derived from git against a baseline
captured before the job started. Keep both. The report says what Codex believes it did; git says
what happened. Dropping the git half would leave nothing to check the model against.

**All git plumbing runs with `-z`.** This is not stylistic. In human-readable mode git quotes paths
containing spaces or non-ASCII, and does so *inconsistently between commands* —
`status --porcelain` yields `"with space.txt"` while `diff --name-status` yields `with space.txt`,
so baseline paths silently stop matching diff paths and every such file is misreported as not
preexisting. NUL-separated output is never quoted. Related: `git()` trims trailing whitespace only,
because `status --porcelain` encodes status in the first two columns and a leading trim would eat a
character off the first line's path. Both of these were real bugs.

## Codex CLI facts worth keeping

Verified against codex-cli 0.144.4:

- `codex exec --json` emits JSONL: `thread.started`, `turn.started`, `item.completed`
  (`item.type` of `agent_message` / `reasoning` / `command_execution` / `file_change`),
  `turn.completed` (with `usage`), `turn.failed`.
- `codex exec` reads the prompt from stdin when no prompt argument is given.
- `-o FILE` writes the final agent message; `-C DIR` sets the working root; `-s` sets the sandbox.
- `--output-schema FILE` constrains the final message to a JSON Schema. Every property must be
  listed in `required` with `additionalProperties: false`; partially-specified objects are rejected.
- `codex exec resume <SESSION_ID>` continues a thread with full context. It accepts `--json`, `-o`,
  `--output-schema`, `-m`, `-c` — but **not** `-C` or `-s`, which it inherits from the original
  session. The session id is the `thread_id` from the `thread.started` event.
- `-c model_reasoning_effort=<value>` sets reasoning effort for one run without touching
  `config.toml`. **Which values are legal depends on the model, not the CLI.** The generic API error
  advertises `none|minimal|low|medium|high|xhigh|max`, but `gpt-5.6-sol` accepts only
  `none|low|medium|high|xhigh` and rejects `minimal` and `max`. Codex does not validate locally — it
  forwards the value, so a bad one surfaces as an `error` + `turn.failed` event *after* the job has
  started, not as a spawn error. The zod enum at the tool boundary therefore catches typos only; it
  cannot promise a value will work.
- A failed turn's real cause is in `events.jsonl`, not `stderr.log`. stderr routinely leads with an
  unrelated `codex_models_manager::cache` warning, so prefer `summarizeEvents().failure` over a tail
  of stderr when reporting why a job failed.
- The real binary is at
  `<npm-root>/@openai/codex/node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex[.exe]`.
- On Windows the `codex.cmd` shim cannot be spawned without `shell: true` (Node throws `EINVAL`).

## Verifying changes

Exercise the real thing, not just the types — the interesting failures are in process lifecycle,
and `tsc` passing proves nothing about them. The paths that have actually broken or needed care:

- a job completing and its result being collected
- `codex_cancel` killing the whole process tree (Windows needs `taskkill /T /F`)
- a job surviving the server being killed, and a fresh server recovering its state
- an unknown job id returning a clean error rather than throwing
- `codex_reply` recalling context from the parent job
- change verification in a repo containing a file that was **already dirty** before the job, plus
  paths with spaces and non-ASCII names — this is where the git parsing bugs lived, and a repo of
  simple ASCII filenames will happily hide them
