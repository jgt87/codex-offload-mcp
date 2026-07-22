---
description: Split a large task into independent chunks and run several Codex jobs at once.
argument-hint: <large task to parallelize>
---

The user wants to parallelize across Codex: several background jobs at once.

Task: $ARGUMENTS

1. **Decompose** the task into chunks that are genuinely independent — no chunk depends on another's
   output, and two chunks never edit the same file (concurrent jobs writing the same path collide).
   If you cannot split it cleanly, say so and fall back to a single job or `/codex-plan-execute`.
2. **Dispatch all chunks at once** with one `codex_start` per chunk, each a self-contained prompt.
   Collect the jobIds. Running them concurrently is the whole point.
3. **Collect each** with `codex_result` as they finish (`codex_list` shows what's still running),
   reviewing each diff against git.
4. **Reassemble**: integrate the pieces, resolve anything that spans chunks in-process, and run the
   full test suite once — per-chunk checks don't prove the whole fits together.
