# CLAUDE.md

## What this is

An MCP server that offloads coding tasks to the Codex CLI as background jobs. Claude calls
`codex_start`, gets a job id back immediately, keeps working, and collects the result later.

The point of the whole project is **non-blocking delegation**. Codex's own `codex mcp-server`
already covers the synchronous case; if a change here would make a tool block until Codex
finishes, it belongs in the built-in server instead, not this one.

## Commands

```sh
npm run build     # tsc -> dist/
npm run watch     # tsc --watch
```

There is no test runner. Verify changes by driving the built server over stdio with a JSON-RPC
script (initialize → `notifications/initialized` → `tools/call`); see "Verifying changes" below.

Registered with Claude Code at user scope as `codex-offload`. After `npm run build`, restart the
MCP connection for changes to take effect — a running server keeps the old `dist/`.

## Layout

- `src/index.ts` — MCP server, tool definitions and their descriptions
- `src/jobs.ts` — job lifecycle: spawn, state reconciliation, event parsing, cancel, prune
- `src/handoff.ts` — the report schema Codex must fill in, and git-based change verification
- `src/codexBin.ts` — locates the real Codex executable

## Architecture notes

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
  `--output-schema`, `-m` — but **not** `-C` or `-s`, which it inherits from the original session.
  The session id is the `thread_id` from the `thread.started` event.
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
