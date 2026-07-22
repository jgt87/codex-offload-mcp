---
description: Plan a task yourself, then hand the finished plan to Codex to execute in the background.
argument-hint: <task to plan and execute>
---

The user wants the plan→execute collaboration: you do the design thinking, Codex does the typing.

Task: $ARGUMENTS

1. **Plan it yourself, in this conversation.** Work out the approach: which files change, what each
   change is, the order to do them in, and how to tell it worked (tests to run, behaviour to check).
   Investigate the codebase as much as you need — this is the part only you can do.
2. **Write the plan as a self-contained, ordered list.** Codex cannot see this conversation, so name
   every file and state every step and acceptance check in the plan text itself.
3. **Hand it off** with `codex_execute_plan(plan, cwd=<repo root>)`. Since the design is done,
   consider a lower `reasoningEffort` unless individual steps are themselves subtle. You get a jobId
   back immediately.
4. **Keep working or verify — don't sleep-poll.** The job runs detached; do real work meanwhile and
   collect with `codex_result` when you're ready, which checks Codex's report against git. Don't
   narrate a wait and fire `sleep` — foreground `sleep` is blocked by the harness, so the wait never
   happens and you just re-poll seconds later. If you genuinely have nothing else to do, block on
   completion with `Monitor` (an until-loop on the job finishing) instead of a timed poll. If Codex
   reports a blocker, revise the plan and resume with `codex_reply`.

If the task is exploratory (each step changes what you'd do next) or needs this conversation's
context to execute, say so and do it in-process instead — plan→execute only fits work whose shape is
known before it starts.
