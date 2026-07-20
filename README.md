# codex-offload-mcp

An MCP server for running Claude Code and the [Codex CLI](https://github.com/openai/codex) as a
pair: Claude drives, and hands self-contained tasks to Codex as **background jobs**.

`codex_start` returns a job id immediately instead of blocking, so the driving model keeps working
while Codex works alongside it — two agents on the problem at once, rather than one waiting on the
other.

## Why this exists

To use two coding models together rather than one at a time. Claude Code holds the conversation,
the context and the judgment about what to do next; Codex is a capable second agent that can be
given a well-specified piece of work and left to get on with it. Neither replaces the other, and
the interesting part is what they do concurrently.

**Blocking would defeat the entire point.** If handing work to Codex meant waiting for Codex, there
would be no pair — just one model parked while the other runs, which is strictly worse than doing
the work yourself. So dispatch returns in about a second and the job continues in a detached process
that outlives even this server. The driving model carries on reasoning, reading and answering, and
collects the result when it is ready.

That concurrency is also what makes the delegation worth specifying carefully. Codex cannot see the
conversation, so a task has to travel as a complete brief — and the work that comes back is checked
against git rather than taken on trust, because handing work between models is precisely where
"I did the thing" and "the thing got done" come apart.

## Tools

| Tool | Returns |
| --- | --- |
| `codex_start` | `{ jobId, state, … }` — immediately, job runs in the background |
| `codex_status` | State, elapsed time, commands run, files touched, recent activity |
| `codex_result` | Structured handoff report + git-verified changes; progress if still running |
| `codex_reply` | Continues a job's Codex thread with a follow-up; returns a new jobId |
| `codex_models` | Available models and the reasoning efforts each one accepts |
| `codex_cancel` | Kills the job and its child processes |
| `codex_list` | Known jobs, newest first, optionally filtered by state |

None of them block.

## The handoff

Getting work *back* from Codex matters as much as sending it. Three things make the return trip
trustworthy:

**1. A typed report.** Jobs run with `--output-schema`, so the final message is not prose but a
fixed shape:

```json
{
  "summary": "...",
  "status": "complete | partial | blocked",
  "filesChanged": [{ "path": "...", "change": "..." }],
  "verification": [{ "command": "...", "passed": false, "details": "..." }],
  "followUps": ["..."],
  "blockers": ["..."],
  "documentation": "which docs were updated, or why none were warranted",
  "confidence": "high | medium | low"
}
```

This makes Codex commit to whether it actually finished and whether its checks passed, instead of
burying a failed test in a paragraph. Pass `structured: false` for a job where you want prose.

**2. Changes verified against git, not self-reported.** `codex_result` also returns
`actualChanges`, computed by diffing the repo against the commit and dirty-file set recorded when
the job started. Files already modified beforehand are flagged `preexisting` so they are not
mistaken for Codex's work. When the report and `actualChanges` disagree, `actualChanges` is the
one to trust.

**3. A way to push back.** `codex_reply` continues the original Codex thread, so corrections
("you missed the error path", "now update the tests") land with all of Codex's context intact
rather than starting a cold job that has to rediscover everything.

## Install

### Prerequisites

- **Node.js 20+**
- **The Codex CLI**, installed and authenticated — run `codex login` and confirm `codex --version`
  works. This server drives that binary; without it every job fails immediately.

### Build

```sh
git clone https://github.com/jgt87/codex-offload-mcp.git
cd codex-offload-mcp
npm install
npm run build
```

This produces `dist/index.js`. Note its **absolute** path — every step below needs it.

### Add to VS Code

MCP support is built into current VS Code; if the Command Palette lists `MCP:` commands, you have
it. Pick either route:

**Guided.** Command Palette (`Ctrl+Shift+P`) → **MCP: Add Server** → **Command (stdio)**. Enter
`node` as the command and the absolute path to `dist/index.js` as the argument, then name it
`codex-offload`.

**By hand.** Command Palette → **MCP: Open User Configuration** to open your user `mcp.json`
(`%APPDATA%\Code\User\mcp.json` on Windows), and add the server:

```json
{
  "servers": {
    "codex-offload": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/codex-offload-mcp/dist/index.js"]
    }
  }
}
```

Use forward slashes on Windows, or escape backslashes as `\\` — a raw `C:\path` is invalid JSON and
the server will silently fail to start.

To scope it to one project instead of your whole profile, use **MCP: Open Workspace Folder
Configuration** and put the same `servers` block in `.vscode/mcp.json`. That file can be committed,
which gives everyone on the repo the same tools.

**Verify.** Open the Chat view, switch to **Agent** mode, click **Configure Tools**, and confirm the
`codex_*` tools appear and are enabled. **MCP: List Servers** shows the server's status and its
logs if it failed to start.

### Add to Claude Code

```sh
claude mcp add codex-offload --scope user -- node /absolute/path/to/dist/index.js
```

Confirm with `/mcp` in a session, or `claude mcp list` from a shell.

### After changing the code

A running server keeps serving the old `dist/`, so rebuild **and** restart it:

```sh
npm run build
```

- **VS Code** — **MCP: List Servers** → select the server → **Restart**. (The experimental
  `chat.mcp.autoStart` setting can do this for you.)
- **Claude Code** — restart the session; MCP servers connect at session start.

## Using it

You do not call the tools by name. Ask for what you want and Claude selects them:

| You say | Tool |
| --- | --- |
| "Offload to Codex: migrate the auth module to the new API" | `codex_start` → jobId, immediately |
| "How's that Codex job doing?" | `codex_status` |
| "Get the Codex result" | `codex_result` |
| "Tell Codex it missed the error path" | `codex_reply` |
| "What Codex jobs are running?" | `codex_list` |
| "Which models can Codex use?" | `codex_models` |
| "Kill that job" | `codex_cancel` |

The pattern worth building a habit around is dispatch-then-continue: *"Offload the test migration
to Codex, and while that runs, walk me through the router."*

### Checking its work

`codex_result` gives you Codex's own report *and* `actualChanges` from git. When they disagree,
git wins. For anything that matters, go further than reading the report: run the tests, and break
the thing under test to confirm they actually fail. A suite that passes proves less than a suite
you have watched fail for the right reason.

## Orchestration

Two decisions get made per task, and they are handled very differently.

**Whether to delegate is not decided here.** There is no scheduler, no queue and no second model
triaging work. The only thing steering that choice is the `codex_start` tool description, which the
calling model reads at call time and judges against.

That is deliberate. The decision needs the one thing this process cannot see — the conversation.
Whether a task is self-contained, whether there is useful work to do while it runs, whether you are
about to change your mind about the approach: none of that is visible from inside an MCP server, so
the judgment stays with the model that has the context, and this server sticks to running the job
and checking the result. Editing that description in `src/index.ts` is how you change delegation
behaviour; there is no config to tune.

**Which model and how hard it thinks *are* decided here** — see below. That part is a genuine
heuristic, and the honest framing is that it is the one invented thing in the pipeline: no API
reports "this task is mechanical". So it is built to be inspectable rather than trusted. Every job
records the tier and the reason it was picked, and any explicit value overrides it.

### What should be offloaded

All of these need to hold:

| Test | Why |
| --- | --- |
| **Self-contained** | Codex cannot see the conversation. Anything resting on what was just worked out must be restated in full — and if restating it is most of the work, offloading is a net loss. |
| **Slow** | Minutes, not seconds. Below ~30s the round trip costs more than it saves. |
| **Real work to do meanwhile** | Dispatching and then sitting on `codex_status` gains nothing. |
| **Verifiable afterwards** | Mechanical enough that `actualChanges` from git shows whether it went right. |
| **Scoped to one `cwd`** | Codex writes to disk directly; ambiguous scope means unwanted edits. |

Keep it in-process when the task needs conversation context, is fast, blocks the next decision, or
is surgical enough that specifying it precisely costs more than just doing it.

**Exploratory work is the main trap.** Investigations where each measurement changes what you look
at next cannot be offloaded — by the time the prompt can be written, the thinking is already done.
A useful tell is a wrong hypothesis: if you expect to have one, keep the work in-process.

**Misjudging is asymmetric.** A bad question wastes a minute; a bad delegation writes files to disk.
That asymmetry is why `codex_result` checks Codex's self-report against git instead of trusting it —
the design already assumes a delegation can be wrong. Prefer `sandbox: "read-only"` for anything
analytical.

### Choosing model and effort

`codex_start` picks both from the task text unless you pass them. Here is the whole path a call
takes, from prompt to spawned process:

```
codex_start(prompt, model?, reasoningEffort?, autoRoute?)
   │
   ├── autoRoute: false ────────────────────► skip everything below
   │                                          (caller's values, else config.toml)
   ▼
classify(prompt)                              src/route.ts — keyword match, no model call
   │
   ├── matches HARD patterns?      ── yes ──► tier = hard
   ├── matches MECHANICAL patterns? ─ yes ──► tier = mechanical
   └── neither ─────────────────────────────► tier = standard          (hard wins ties)
   │
   ▼
pick model            match tier's wording against each model's vendor description
   │                  ("frontier" / "balanced" / "fast, affordable")
   │                  no match → Codex's own first-ranked model
   ▼
pick effort           mechanical → low   standard → medium   hard → high
   │
   ▼
clamp to model        effort not in this model's supported list?
   │                  → nearest supported level at or below it
   ▼
apply overrides       explicit model / reasoningEffort replace whatever was chosen
   │
   ▼
validate              model accepts this effort?
   │                        │
   │                        └── no ──► error returned in ms, nothing spawned
   ▼
spawn `codex exec --json` detached, recording {tier, rationale, auto} on the job
```

Only the `classify` step is invented. Everything from "pick model" down is driven by the model index
Codex itself maintains, so the lineup and the legal effort levels are facts rather than guesses.

The tiers:

| Tier | Signals | Effort | Model |
| --- | --- | --- | --- |
| `mechanical` | renames, moving files, formatting, typos, applying a stated pattern | `low` | the one described as fast/affordable |
| `standard` | anything without a strong signal — the default | `medium` | the one described as balanced/everyday |
| `hard` | concurrency, races, deadlocks, leaks, security, architecture, trade-offs, root-cause work | `high` | the one described as frontier |

A prompt matching both `mechanical` and `hard` is treated as `hard`: under-thinking a subtle problem
costs more than over-thinking a simple one.

Resolved against a real lineup, the assignment looks like this — the model column is whatever the
index currently offers, not a fixed list:

```
  TASK                                         TIER          MODEL            EFFORT
  ───────────────────────────────────────────  ────────────  ───────────────  ──────
  "Rename getUser to fetchUser across the      mechanical    gpt-5.6-luna     low
   repo and update the call sites"             │             fast, affordable
                                               └─ matched: "rename"

  "Add an endpoint returning the current       standard      gpt-5.6-terra    medium
   user's projects"                            │             balanced/everyday
                                               └─ no strong signal → default

  "Fix the race condition in the job           hard          gpt-5.6-sol      high
   scheduler that drops events under load"     │             frontier
                                               └─ matched: "race condition"

  "Rename the lock helper while fixing the     hard          gpt-5.6-sol      high
   deadlock it causes"                         │
                                               └─ matched both; hard wins
```

**The model lineup is discovered, not hardcoded.** Models and their accepted effort levels are read
at startup from Codex's own index (`~/.codex/models_cache.json`), so a model released after this
server was written is picked up on restart. Tiers map onto that lineup by matching the vendor's own
descriptions, which means a renamed model still routes sensibly. `codex_models` shows what was
found, including whether the index was actually readable.

This matters more than it sounds. The first version of this feature hardcoded the effort list, and
it was wrong within the hour — it invented `none` and `minimal`, which no model advertises, and
omitted `ultra`, which two models support.

**Effort is clamped to what the chosen model accepts**, so a model topping out at `xhigh` never
receives `ultra`. If you pin a model *and* an effort it cannot take, the call fails immediately with
the model's real list — rather than failing the job minutes later, which is what Codex does on its
own, since it forwards the value unchecked.

**Overriding.** An explicit `model` or `reasoningEffort` always wins, and partial pinning works —
fix the model, let the effort be routed, or the reverse. `autoRoute: false` disables inference
entirely and falls back to your `~/.codex/config.toml` defaults. Worth knowing that if that file
sets `model_reasoning_effort = "high"`, every un-routed job runs at `high` until you say otherwise.

Every job records what was chosen and why:

```json
"routing": {
  "tier": "mechanical",
  "rationale": "classified as mechanical — matched mechanical wording (rename); model gpt-5.6-luna chosen for this tier; effort low",
  "auto": true
}
```

The classifier is keyword matching, and deliberately so — a cleverer one would need a model call,
which would add latency to a tool whose whole promise is returning immediately. It will misread
things. That is why it explains itself and why every part of it can be overridden.

`codex_reply` takes `reasoningEffort` too, defaulting to the parent job's. Worth raising when a first
attempt failed for want of thinking, and lowering when the follow-up is a mechanical fixup.

### The feedback loop

Work does not come back trusted. Every job produces two independent accounts of itself, and the loop
closes by comparing them:

```
  codex_start
      │    git baseline captured first: current commit + already-dirty files
      ▼
  codex exec --json   (detached — outlives this server)
      │    streams events.jsonl while it works
      ▼
  codex_status  ──  poll as often as you like; never blocks
      │
      ▼
  codex_result
      │
      ├───────────────────────────┐
      ▼                           ▼
  Codex's report             actualChanges
  what it believes it did    what git says changed,
  summary, verification,     measured against the
  confidence                 baseline above; files
      │                      already dirty flagged
      │                      preexisting
      │                           │
      └─────────────┬─────────────┘
                    ▼
           caller compares them   ── git wins any disagreement
                    │
         ┌──────────┴───────────┐
         ▼                      ▼
   agree, tests pass      disagree, or partial
         │                      │
         ▼                      ▼
      accept              codex_reply
                                │
                                ▼
                 new job on the SAME Codex thread
                 full context retained, effort adjustable
                                │
                                └──►  back to codex_status, above
```

Three properties make this worth the machinery:

**The two accounts are produced independently.** The report is what Codex says; `actualChanges` is
computed by diffing the repo against the baseline captured *before* the job started. Files you had
already modified are flagged `preexisting`, so they are never mistaken for Codex's work. When the two
disagree, git wins.

**The correction path keeps context.** `codex_reply` resumes the original thread by its `thread_id`,
so "you missed the error path" lands with everything Codex already knows, instead of a cold job that
has to rediscover the codebase.

**The loop is closed by you, not by the router.** Nothing here learns. A job records its tier and
rationale so you can look back and see whether the classification was reasonable, but a misrouted
task does not adjust anything for next time — you pin `model` or `reasoningEffort` on the retry, or
edit the patterns in `src/route.ts`. If routing keeps getting a particular kind of task wrong, that
is a signal to change the keyword lists, and it is meant to be done by hand.

## How it works

### What happens when a task is offloaded

1. **Baseline.** `codex_start` records the state of `cwd` before Codex touches anything: the current
   commit, plus the set of files already dirty. This is what makes the later verification honest —
   files you had already modified are flagged `preexisting` rather than blamed on Codex.
2. **Routing.** Unless you pinned them, model and reasoning effort are chosen from the task text and
   clamped to what that model accepts. An effort the model cannot take is rejected here, before
   anything is spawned.
3. **Dispatch.** The prompt is written to `prompt.txt` and `codex exec --json` is spawned
   **detached**, with the prompt fed over stdin. The call returns a job id immediately; nothing
   blocks, ever.
4. **Streaming.** Codex writes JSONL events to `events.jsonl` as it works, and its final answer to
   `last-message.txt`. Both are on disk, not in memory.
5. **Polling.** `codex_status` parses the tail of the event stream into a progress view — commands
   run, files touched, recent activity. It reports; it never waits.
6. **Collection.** `codex_result` returns Codex's structured report *and* re-diffs the repo against
   the baseline from step 1 to produce `actualChanges`. Two independent accounts of the same work.
7. **Follow-up.** `codex_reply` resumes the original Codex thread by its `thread_id`, so a
   correction lands with all of Codex's context intact rather than starting cold.

### Under the hood

Each job spawns `codex exec --json` as a **detached** process, with:

- the prompt piped over **stdin** — no command-line length or quoting limits
- `--json` events streamed to `events.jsonl` (parsed for the progress view)
- `-o last-message.txt` capturing the final answer
- metadata in `meta.json`

Jobs live in `~/.codex-mcp/jobs/<jobId>/` (override with `CODEX_MCP_JOBS_DIR`). Finished jobs
older than seven days are pruned at startup.

Because jobs are detached, **they survive this server restarting**. A job started by a previous
process has nobody listening for its exit, so `running` is only trusted while its pid is alive;
otherwise state is recovered from whether a result file was produced.

The Codex binary is resolved to the real platform executable inside the npm package, so jobs spawn
with an argv array rather than through a shell. Override with `CODEX_BIN` if needed.

## Sandbox

`sandbox` defaults to `workspace-write`: Codex may edit files under `cwd`. That is the point — it
does real work — but it means **the working tree changes underneath you**. Re-read files after a
job finishes rather than trusting anything cached from before.

- `read-only` — analysis and review, no writes
- `workspace-write` *(default)* — edits within `cwd` (plus any `addDirs`)
- `danger-full-access` — unrestricted; only when explicitly asked for

Cancelling does not roll back edits already made.

## Documentation

Jobs that can write are asked to document themselves. A standing instruction is appended to the
prompt telling Codex to update the project's existing documentation — `README.md`, `AGENTS.md`,
`CLAUDE.md`, files under `docs/` — when the change alters behaviour, adds a feature, or makes an
existing statement untrue.

This exists because Codex starts cold. It cannot see the conversation that led to the task, so
unless something asks, documentation simply never gets written and the caller has to remember every
single time.

The instruction leans hard in one direction: **edit what exists, do not create new files.** An
unqualified "document your changes" reliably produces a `CHANGES.md` or `NOTES.md` in every
repository it touches, which is worse than nothing — it fragments what a reader has to consult and
goes stale immediately. Codex is told not to invent a changelog, to match the surrounding document's
voice and structure, and to prioritise correcting statements the change made untrue over adding new
prose. It is also told to skip documentation when the work does not warrant it, and to say so.

The structured report carries a required `documentation` field, so a job has to account for what it
wrote or explain why it wrote nothing. `actualChanges` from git shows which `.md` files were actually
touched, so the claim is checkable rather than taken on faith — the same split the rest of the
handoff uses.

| Setting | Behaviour |
| --- | --- |
| default | On for `workspace-write` and `danger-full-access` |
| `documentation: false` | Suppressed; the prompt is passed through untouched |
| `sandbox: "read-only"` | Always off — the job could not write a file even if asked |

A `codex_reply` follow-up inherits the parent job's setting, so a correction to documented work keeps
the docs in step with it. The instruction is appended only to what Codex receives; `codex_status` and
`codex_list` still show the prompt you actually wrote.

## Writing good job prompts

Codex starts cold. It cannot see the Claude conversation, so a prompt must carry its own context:
what to change, which files, the constraints, and what "done" looks like.
