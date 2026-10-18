---
name: harness:execute
description: Use when executing a written implementation plan inline in this session, task by task, with TDD inside each task and verification checkpoints
---

# Executing Plans Inline

## Overview

Load the plan, review it critically, execute every task in dependency order in this session, then hand off to verification.

**Announce at start:** "I'm using the harness:execute skill to implement this plan."

For more than 3 independent tasks, `harness:subagent` (fresh subagent per task with two-stage review) usually gives higher quality.

## Step 1: Load and Review the Plan

1. Read the plan file.
2. Review it critically: contradictions, gaps, unclear instructions, wrong assumptions.
3. If there are concerns, raise them through `harness:ask` before starting. No user available: resolve conservatively (strictest reading) and note it.
4. Create one task per plan task with the `task` tool, for example `{"operation":{"action":"create","summary":"Task 1: Parser"}}`.

Never start implementation on `main` or `master` without explicit user consent.

## Step 2: Execute Tasks

For each task, in dependency order:
1. Start it: `{"operation":{"action":"start","id":"T1"}}`
2. Follow each step exactly. Behavior changes go test-first (`harness:tdd`): failing test, see it fail for the intended reason, minimal code, see it pass.
3. Run the verifications the task specifies and read the output.
4. Commit as the plan says.
5. Finish it: `{"operation":{"action":"done","id":"T1","event_summary":"3 tests pass, committed abc123"}}`. Only mark `done` when the work is fully accomplished; otherwise keep it in progress or `block` it with an `event_summary`.

Continue through tasks without routine approval pauses.

## When to Stop

Stop and use `harness:ask` (blocker plus options, not free text) when:
- A blocker cannot be worked around (missing dependency, unclear instruction, plan gap)
- An unresolved product decision appears
- A destructive action needs consent

No user available: take the best non-destructive path, document it, and continue.

**Failed fixes:** when a task's verification fails, use `harness:debug`. After two failed fixes, stop patching and re-derive the cause from the evidence before trying again. If the re-derived approach also fails, present the attempts and outcomes through `harness:ask`; no user available: `block` the task with a summary and continue with independent tasks.

**Plan wrong:** if 2 or more plan assumptions prove false, revise the plan (update the plan file) before continuing.

## Step 3: Hand Off

When all tasks are done, go to `harness:verify` (full verification), then `harness:review`, then `harness:report`, then `harness:merge`.
