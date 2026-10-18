---
name: harness:plan
description: Use when requirements are clear for a multi-step or durable change, before touching code - writes the implementation plan with tasks, files, tests, and spec coverage
---

# Writing Plans

## Overview

Write an implementation plan that an engineer with zero context for this codebase can follow. Document which files each task touches, the code, the tests, and how to verify it. Bite-sized tasks. DRY. YAGNI. TDD inside each task. Frequent commits.

**Announce at start:** "I'm using the harness:plan skill to create the implementation plan."

**Save plans to:** the plans directory in the harness docs directory from the mode prompt, as `YYYY-MM-DD-<feature-name>.md`. A user-specified location overrides this.

## Scope Check

If the spec covers multiple independent subsystems, split it into one plan per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map which files will be created or modified and what each is responsible for.

- Each file has one clear responsibility and a well-defined interface. Prefer smaller, focused files.
- Files that change together live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. Include a split only when a file you modify has grown unwieldy.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate:

- Fold setup, configuration, scaffolding, and documentation into the task whose deliverable needs them.
- Split only where a reviewer could reject one task while approving its neighbor.
- Each task ends with an independently testable deliverable.

Each step is one action (2-5 minutes): write the failing test; run it and see it fail; write the minimal code; run it and see it pass; commit. This red-green cycle is the `harness:tdd` technique applied per task.

## Plan Document Header

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Use harness:subagent (recommended) or harness:execute to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence]

**Architecture:** [2-3 sentences]

**Tech Stack:** [Key technologies/libraries]

## Global Constraints

[Project-wide requirements that bind EVERY task: version floors, dependency limits,
naming and copy rules, exact values. One line each, copied verbatim from the spec.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Covers:** [S3, S7]
<!-- spec section anchors this task implements; omit only for pure scaffolding -->

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Assumptions:** [what must be true for this task to succeed, e.g. "file Y exists",
"API returns field W". Verification checks these; a wrong assumption means plan revision.]

**Interfaces:**
- Consumes: [exact signatures and types used from earlier tasks]
- Produces: [exact names, parameter and return types later tasks rely on]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step contains the actual content an engineer needs. These are plan failures:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" without test code
- "Similar to Task N" (repeat the code; tasks may be read out of order)
- Steps that say what to do without showing how
- References to types or functions defined in no task

## Self-Review

After writing the plan, check it against the spec yourself:

1. **Spec coverage:** every `[Sn]` section is listed in some task's **Covers:**, and every `Covers:` ID resolves to a real section. Add or fix tasks for any gap.
2. **Placeholder scan:** remove every pattern from "No Placeholders".
3. **Type consistency:** names and signatures in later tasks match earlier tasks (`clearLayers()` in Task 3 vs `clearFullLayers()` in Task 7 is a bug).

Fix issues inline; no re-review needed.

For a plan with many tasks, also dispatch an independent reviewer with `plan-document-reviewer-prompt.md`.

If a user is available, request plan approval through `harness:ask`; otherwise continue.

## Execution Handoff

1. **Check for a saved preference:** `memory_recall` with `scope: "global"` and query `harness-preference execution-style`. If the newest match says `subagent` or `inline`, use it.
2. **Otherwise ask through `harness:ask`:**
   - header: `Execution`
   - question: `Plan saved. How would you like to execute it?`
   - options: `Subagent, always` / `Subagent, this time` (fresh subagent per task with two-stage review) / `Inline, always` / `Inline, this time` (execute in this session)

   No user available: Inline for 3 or fewer or tightly coupled tasks, Subagent for more than 3 independent tasks.
3. **For an "always" choice:** `memory_add` with `scope: "global"`, `type: "decision"`, body `harness-preference execution-style: subagent` (or `inline`). If the write is refused, continue without saving.

**Next step:** `harness:worktree` if isolation is wanted, then `harness:subagent` or `harness:execute`.
