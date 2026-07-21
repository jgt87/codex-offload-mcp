---
description: Offload a task to Codex, then review its diff and send corrections until it's right.
argument-hint: <task for Codex to do, then you review>
---

The user wants the execute→review loop: Codex does the work, you check it.

Task: $ARGUMENTS

1. **Dispatch** with `codex_start(prompt, cwd)` — a self-contained prompt, since Codex cannot see
   this conversation. You get a jobId back immediately; keep working meanwhile.
2. **Collect and review** with `codex_result`. Trust `actualChanges` (git's account) over Codex's
   own report, and re-read each changed file before judging it. Check correctness, not just that it
   ran.
3. **Correct in place** with `codex_reply(jobId, ...)` — it keeps Codex's full context, so point at
   what's wrong ("you missed X", "this breaks Y") rather than starting a fresh cold job.
4. Repeat 2–3 until the diff is right, then summarise for the user what changed and what you verified.
