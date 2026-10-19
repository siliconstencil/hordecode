---
name: harness:subagent
description: Use when executing implementation plans with independent tasks in the current session
---

# Subagent-Driven Development

Execute plan by dispatching fresh subagent per task, with two-stage review after each: spec compliance review first, then code quality review.

**Core principle:** Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration

**Continuous execution:** Do not pause to check in with your human partner between tasks. Execute all tasks from the plan without stopping. The only reasons to stop are: BLOCKED status you cannot resolve, ambiguity that genuinely prevents progress, or all tasks complete.

## When to Use

1. Have implementation plan? -- No -> brainstorm first or manual execution
2. Tasks mostly independent? -- No (tightly coupled) -> brainstorm first or manual execution
3. Stay in this session? -- Yes -> **harness:subagent** / No -> harness:execute (parallel session)

## The Process

**Setup:** Read plan -> extract all tasks with full text -> note context -> create a task per plan task (task create)

**Per Task:**

- **Dispatch implementer** -- create+bind task (--task TID, auto-starts), inject covered spec as Intent
- **Implementer asks questions?** -- Yes -> answer, provide context, re-dispatch
- **Implementer implements** -- tests, commits, self-reviews
- **Spec review phase 1** -- dispatch with spec + diff only, no report
- **Phase 1 flagged anything?** -- Yes -> dispatch phase 2 (report explains flags, downgrade-only)
- **Spec gate: all in-scope claims pass with evidence?** -- No -> implementer fixes -> back to spec review
- **Code quality review** -- dispatch reviewer
- **Quality approved?** -- No -> implementer fixes -> back to quality review
- **Mark task done** -- task done TID

**More tasks remain?** -- Yes -> next task (dispatch implementer)

**Finish:** Dispatch final code reviewer for entire implementation -> **harness:merge**

## Model Selection

Use the least powerful model that can handle each role.

- **Mechanical implementation** (isolated functions, clear specs, 1-2 files): cheap model
- **Integration and judgment** (multi-file, debugging): standard model
- **Architecture, design, review**: most capable model

**Reviewer tier:** Spec reviewer at least as capable as implementer. Weaker reviewer = blind spots.

## Handling Implementer Status

- **DONE:** Proceed to spec compliance review
- **DONE_WITH_CONCERNS:** Read concerns before proceeding
- **NEEDS_CONTEXT:** Provide missing context, re-dispatch
- **BLOCKED:** Assess (context -> re-dispatch, reasoning -> upgrade model, size -> split, plan wrong -> escalate)

Never ignore an escalation or force the same model to retry without changes.

## Pre-Flight Review

Before Task 1: scan entire plan for conflicts, contradictions, ambiguous contracts. Present as one batched question via harness:ask.

## Red Flags

**Never:**
- Start on main/master without user consent
- Skip reviews (spec compliance OR code quality)
- Proceed with unfixed issues
- Dispatch multiple implementation subagents in parallel (conflicts)
- Make subagent read plan file (provide full text instead)
- Start code quality review before spec compliance pass
- Include implementer report in phase-1 spec review
- Mark task complete while any in-scope claim is fail/unverifiable

## Detailed Reference

For spec-anchored review gate, full example workflow, advantages, and prompt templates, see `<harness:subagent>/reference.md`.

## Integration

- **harness:worktree** - Isolated workspace
- **harness:plan** - Creates the plan
- **harness:review** - Code review template
- **harness:merge** - Complete development
- **harness:tdd** - TDD workflow in subagent prompts
