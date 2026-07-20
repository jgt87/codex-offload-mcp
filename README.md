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

```sh
npm install
npm run build
claude mcp add codex-offload --scope user -- node /absolute/path/to/dist/index.js
```

Requires the `codex` CLI installed and authenticated (`codex login`).

MCP servers connect when a session starts, so after installing — or after any `npm run build` —
restart Claude Code before the changes take effect. Confirm the tools loaded with `/mcp` in-session
or `claude mcp list` from a shell; you should see `codex-offload` and its six tools.

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

## How it works

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
