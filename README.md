# codex-offload-mcp

An MCP server that lets Claude hand coding tasks to the [Codex CLI](https://github.com/openai/codex) as **background jobs**.

`codex_start` returns a job id immediately instead of blocking, so Claude can dispatch slow work
(refactors, migrations, test suites) and carry on while Codex grinds through it.

## Why this exists

Codex already ships an MCP server — `codex mcp-server` — with `codex` and `codex-reply` tools.
Those are good, but they are **synchronous**: the tool call blocks until Codex finishes. A
fifteen-minute refactor means a fifteen-minute blocked call, and most MCP clients time out long
before that.

This server fills that gap. The two work well side by side:

| Need | Use |
| --- | --- |
| A quick answer, right now | built-in `codex` tool (`codex mcp-server`) |
| Slow work you want to offload | `codex_start` here |

## Tools

| Tool | Returns |
| --- | --- |
| `codex_start` | `{ jobId, state, … }` — immediately, job runs in the background |
| `codex_status` | State, elapsed time, commands run, files touched, recent activity |
| `codex_result` | Structured handoff report + git-verified changes; progress if still running |
| `codex_reply` | Continues a job's Codex thread with a follow-up; returns a new jobId |
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
six `codex_*` tools appear and are enabled. **MCP: List Servers** shows the server's status and its
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
| "Kill that job" | `codex_cancel` |

The pattern worth building a habit around is dispatch-then-continue: *"Offload the test migration
to Codex, and while that runs, walk me through the router."*

### Three things that will bite you

**Codex starts cold.** It cannot see your conversation with Claude, so "do the thing we discussed"
produces nothing useful. State what to change, which files, the constraints, and what done looks
like.

**It edits your files.** The default sandbox is `workspace-write`. Commit or stash first so the
diff is reviewable, and re-read files afterwards rather than trusting context from before the job.
Ask for read-only when you only want analysis.

**It is not free.** A substantial job runs a few hundred thousand input tokens. Worth it for a
refactor; wasteful for anything you would answer inline.

### Checking its work

`codex_result` gives you Codex's own report *and* `actualChanges` from git. When they disagree,
git wins. For anything that matters, go further than reading the report: run the tests, and break
the thing under test to confirm they actually fail. A suite that passes proves less than a suite
you have watched fail for the right reason.

## Orchestration

**There is no orchestrator.** Nothing in this server decides what gets delegated. There is no
router, no scheduler, no heuristic, no queue and no second model triaging work. The only thing
steering the choice is the `codex_start` tool description, which the calling model reads at call
time and judges against.

That is deliberate. The decision needs the one thing this process cannot see — the conversation.
Whether a task is self-contained, whether there is useful work to do while it runs, whether you are
about to change your mind about the approach: none of that is visible from inside an MCP server, so
the judgment stays with the model that has the context, and this server sticks to running the job
and checking the result.

The practical consequence is that **the tool description is the routing logic**. Editing it in
`src/index.ts` is how you change delegation behaviour; there is no config to tune.

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

## How it works

### What happens when a task is offloaded

1. **Baseline.** `codex_start` records the state of `cwd` before Codex touches anything: the current
   commit, plus the set of files already dirty. This is what makes the later verification honest —
   files you had already modified are flagged `preexisting` rather than blamed on Codex.
2. **Dispatch.** The prompt is written to `prompt.txt` and `codex exec --json` is spawned
   **detached**, with the prompt fed over stdin. The call returns a job id immediately; nothing
   blocks, ever.
3. **Streaming.** Codex writes JSONL events to `events.jsonl` as it works, and its final answer to
   `last-message.txt`. Both are on disk, not in memory.
4. **Polling.** `codex_status` parses the tail of the event stream into a progress view — commands
   run, files touched, recent activity. It reports; it never waits.
5. **Collection.** `codex_result` returns Codex's structured report *and* re-diffs the repo against
   the baseline from step 1 to produce `actualChanges`. Two independent accounts of the same work.
6. **Follow-up.** `codex_reply` resumes the original Codex thread by its `thread_id`, so a
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

## Writing good job prompts

Codex starts cold. It cannot see the Claude conversation, so a prompt must carry its own context:
what to change, which files, the constraints, and what "done" looks like.
