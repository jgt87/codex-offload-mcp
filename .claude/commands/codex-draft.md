---
description: Have Codex produce a fast first draft, then refine it yourself with full context.
argument-hint: <thing to draft then refine>
---

The user wants draft→refine: Codex writes the bulk cheaply, you polish it with context.

Task: $ARGUMENTS

1. **Draft on Codex** with `codex_start(prompt, cwd)` — ask for a straightforward first pass, not a
   finished product. A lower `reasoningEffort` is usually right; the goal is bulk output fast, and
   this keeps the expensive output tokens on Codex's side, not yours.
2. **Collect** with `codex_result` and read the changed files.
3. **Refine in-process.** Do the judgement-heavy part yourself — the edits that need this
   conversation's context, taste, or knowledge of the wider codebase. This is the half worth your
   tokens.

Reach for this when the bulk is cheap to generate but the polish needs context. If the whole thing
needs your judgement, just do it in-process; if none of it does, a plain `codex_start` is enough.
