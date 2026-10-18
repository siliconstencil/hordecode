---
name: harness:subagent
description: Use when executing an implementation plan in this session by dispatching a fresh subagent per task, with a spec-compliance review and then a code-quality review after each task
---

# Subagent-Driven Development

Execute the plan by dispatching a fresh implementer subagent per task, then two reviews per task: spec compliance first, code quality second.

**Continuous execution:** do not pause between tasks. Stop only for a BLOCKED status you cannot resolve, ambiguity that genuinely prevents progress, a destructive action needing consent, or completion.

## Prompt Templates

All in this skill's base directory:
- `implementer-prompt.md`: implementer dispatch
- `spec-reviewer-prompt.md`: spec-compliance reviewer (two-phase, evidence-gated verdict)
- `code-quality-reviewer-prompt.md`: code-quality reviewer (builds on `../review/code-reviewer.md`)

Dispatch every subagent with the `supervisor` tool, for example:

```
{"operation":{"action":"run","subagent_type":"general","description":"Implement Task 1: Parser","prompt":"<filled implementer-prompt.md>","task_id":"T1"}}
```

## Setup

1. Read the plan once; extract every task's full text, its `Covers:` anchors, and the Global Constraints.
2. **Pre-flight:** scan the whole plan for contradictions, conflicts with Global Constraints, and inconsistent interface contracts. Present them as one batched question through `harness:ask`. No user available: resolve conservatively (strictest reading).
3. Create one task per plan task with the `task` tool: `{"operation":{"action":"create","summary":"Task 1: Parser"}}`.

Never start on `main` or `master` without explicit user consent.

## Per Task

1. **Dispatch the implementer** from `implementer-prompt.md`, passing the task's id as `task_id` (binding auto-starts the task). Paste the verbatim `[Sn]` spec sections listed in `Covers:` into its Intent block and the full task text into its Task block; never make the subagent read the plan. If a worktree is in use, give its absolute path and tell the subagent to run commands with `bash` `workdir` set to it.
2. **Questions** (NEEDS_CONTEXT): answer, add context, re-dispatch.
3. **Spec review, phase 1** from `spec-reviewer-prompt.md`: covered spec text plus the diff only, never the implementer's report.
4. **Phase 2** only if phase 1 flagged anything: same reviewer, phase-1 verdict plus the implementer report; it may only downgrade flags.
5. **Spec gate:** pass only when every in-scope claim is `pass` with evidence (test name, command output, or file:line). Otherwise the implementer fixes and spec review restarts at phase 1.
6. **Code-quality review** from `code-quality-reviewer-prompt.md`, only after the spec gate passes. Critical or Important issues: implementer fixes, quality review repeats.
7. **Mark done:** `{"operation":{"action":"done","id":"T1","event_summary":"spec gate pass, quality approved"}}`.

**Non-convergence:** if a fix-and-re-review loop stops converging (the same findings return on the same area, or fixes introduce new critical findings), stop looping. `block` the task with the remaining findings as `event_summary` and report the impasse instead of forcing a pass.

## Implementer Status

- **DONE:** go to spec review.
- **DONE_WITH_CONCERNS:** read the concerns; correctness or scope concerns are addressed before review.
- **NEEDS_CONTEXT:** provide it, re-dispatch.
- **BLOCKED:** context problem -> more context; needs more reasoning -> more capable model; too large -> split; plan wrong -> escalate through `harness:ask`.

Never force the same model to retry without changing something.

## Model Selection

Use the least powerful model that handles each role: cheap for mechanical 1-2 file tasks, standard for multi-file integration, most capable for design and review. Reviewers are at least as capable as the implementer they review. `{"operation":{"action":"models"}}` lists the configured models.

## Rules

- Never skip either review, and never start quality review before the spec gate passes.
- Never include the implementer report in phase 1.
- Never mark a task done while an in-scope claim is `fail` or `unverifiable`.
- Do not dispatch parallel implementers into the same checkout; they collide. For independent work, see `harness:parallel`.
- Treat every subagent report as a claim; inspect the diff.

## Finish

When all tasks are done, go to `harness:verify` for full verification, then `harness:review` for the whole change, then `harness:report`, then `harness:merge`.

`reference.md` in this directory has the detailed review gate and a worked example.
