# Subagent Reference

Detailed workflow, review gates, and examples for harness:subagent. Read SKILL.md for the core process.

## Spec-Anchored Review Gate

This is how each task's spec-compliance review works. It replaces a single
prose review with intent-grounded implementation and a two-phase, evidence-gated
verdict.

**Working directory (only if isolated).** Subagents run with fresh context and start
in the repo root. If harness:worktree set up an isolated worktree, the work does NOT
live there -- tell every subagent to `cd` into the worktree first. Otherwise the
current checkout is correct.

**1. Create and bind a task before dispatching.** Before the implementer runs, create
a work-item with the task tool and capture its TID. Dispatch the implementer bound to
that task by passing --task TID on the supervisor call. Binding auto-starts the task to
in_progress with the subagent as owner. Do NOT mark the task done here -- completion
is gated on review (step 4).

**2. Inject intent before dispatching the implementer.** Read the task's Covers:
field, pull the verbatim text of those [Sn] spec sections, and paste it into the
implementer prompt's ## Intent (from spec) block. The implementer never reads the
spec itself -- you hand it exactly the sections its task covers.

**3. Run the spec reviewer in two phases:**
- **Phase 1:** dispatch with the covered spec section text + git diff ONLY. Do NOT
  include the implementer's report. Phase 1 returns a structured per-claim verdict.
- **Phase 2:** only if phase 1 flagged anything. Re-dispatch with phase-1 verdict +
  implementer's report. Phase 2 may downgrade; it cannot add passes.

**4. Gate on the verdict.** Task complete ONLY when final verdict is pass AND every
in-scope claim is pass with evidence. Any fail or unverifiable in-scope claim ->
re-dispatch implementer with failing claims, re-review. Loop until gate passes.

A structured pass without verifiable evidence (test name, command output, or
file:line) does not satisfy the gate -- treat it as fail. Prose is not evidence.

## Pre-Flight Plan Review

Before dispatching Task 1, scan the entire plan once for conflicts:

- Tasks that contradict each other or Global Constraints
- Anything a reviewer would flag as a defect
- Ambiguous or inconsistent interface contracts between tasks

Present everything as one batched question before execution begins. Use harness:ask.
If no user is available, resolve contradictions conservatively (strictest interpretation).

## Model Selection

Use the least powerful model that can handle each role.

- **Mechanical implementation** (isolated functions, clear specs, 1-2 files): cheap model
- **Integration and judgment** (multi-file, debugging): standard model
- **Architecture, design, review**: most capable model

**Reviewer tier:** Dispatch spec reviewer at least as capable as implementer. A weaker
reviewer shares its blind spots and rubber-stamps the same misreadings.

## Handling Implementer Status

**DONE:** Proceed to spec compliance review.

**DONE_WITH_CONCERNS:** Read concerns before proceeding. Correctness/scope concerns
= address before review. Observations = note and proceed.

**NEEDS_CONTEXT:** Provide missing context and re-dispatch.

**BLOCKED:** Assess the blocker:
1. Context problem -> provide more context, re-dispatch same model
2. Needs more reasoning -> re-dispatch more capable model
3. Too large -> break into smaller pieces
4. Plan wrong -> escalate to human

Never ignore an escalation or force the same model to retry without changes.

## Example Workflow

```
You: I'm using Subagent-Driven Development to execute this plan.

[Read plan, extract 5 tasks, create task per plan task]

Task 1: Hook installation script
[Dispatch implementation subagent with task text + context, bound to T1]

Implementer: "Should the hook be installed at user or system level?"
You: "User level (~/.config/harness/hooks/)"
Implementer: Implements, tests 5/5, commits

[Dispatch spec reviewer phase 1: spec + diff only]
Spec reviewer: Status: pass -- all claims pass with evidence
[Gate passes]

[Dispatch code quality reviewer]
Code reviewer: Approved

[Mark Task 1 done]

Task 2: Recovery modes
[Dispatch implementer]
Implementer: 8/8 tests, committed

[Dispatch spec reviewer phase 1]
Spec reviewer: Status: fail -- [S4] "report every 100 items" missing
[Phase 2 with report]: still fail

[Implementer fixes, re-dispatch phase 1]
Spec reviewer: pass

[Code quality review]
Code reviewer: Magic number (100) flagged
[Implementer fixes, re-review]
Code reviewer: Approved

[Mark Task 2 done]

...

[After all tasks]
[Dispatch final code-reviewer]
Final reviewer: All requirements met, ready to merge
Done!
```

## Advantages

**vs. Manual execution:**
- Subagents follow TDD naturally
- Fresh context per task (no confusion)
- Parallel-safe (subagents don't interfere)

**vs. Executing Plans:**
- Same session (no handoff)
- Continuous progress (no waiting)
- Review checkpoints automatic

**Quality gates:**
- Two-stage review: spec compliance, then code quality
- Review loops ensure fixes actually work
- Spec compliance prevents over/under-building

## Detailed Red Flags

**Never:**
- Start on main/master without user consent
- Skip reviews (spec compliance OR code quality)
- Proceed with unfixed issues
- Dispatch multiple implementation subagents in parallel (conflicts)
- Make subagent read plan file (provide full text instead)
- Skip scene-setting context
- Ignore subagent questions
- Accept "close enough" on spec compliance
- Start code quality review before spec compliance is pass
- Include implementer's report in phase-1 spec review
- Mark task complete while any in-scope claim is fail or unverifiable

## Integration

**Required workflow skills:**
- harness:worktree - Isolated workspace
- harness:plan - Creates the plan
- harness:review - Code review template
- harness:merge - Complete development

**Subagents should use:**
- harness:tdd - TDD workflow in subagent prompts
