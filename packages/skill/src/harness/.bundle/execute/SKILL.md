---
name: harness:execute
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the harness:execute skill to implement this plan."

**Note:** Harness works much better with access to subagents. If subagents are available, use harness:subagent instead of this skill for significantly higher quality.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create a task per plan task with the `task` tool and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
- Use harness:report to write the final report (summarizes what was built in human-readable form)
- Report skill will transition to harness:merge on completion

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Use `harness:ask` to present the blocker and options rather than describing it in free text.** If no user is available, resolve the blocker with your best judgment and continue.

**3-Strike Rule:**
If the same task fails 3 times with the same approach:
1. **Strike 1:** Fix the error, re-verify
2. **Strike 2:** Try a different approach, re-verify
3. **Strike 3:** STOP. Use `harness:ask` to present the blocker with all 3 attempts and their outcomes. Do NOT attempt a 4th approach without user guidance.

If no user is available after Strike 3: pivot to a fundamentally different strategy and document the failed attempts.

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

**Required workflow skills:**
- **harness:worktree** - Ensures isolated workspace (creates one or verifies existing)
- **harness:plan** - Creates the plan this skill executes
- **harness:report** - Write final report after all tasks complete
- **harness:merge** - Complete development (invoked by report skill)
