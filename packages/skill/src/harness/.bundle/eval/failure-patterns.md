# Harness Eval -- Failure Pattern Taxonomy

Common failure types, their root causes, and recommended fixes.

## failure_type: skill_gap

**Definition:** The skill's instructions don't cover a scenario that occurred.

**Examples:**
- harness:verify didn't instruct to check for type errors (only checked tests)
- harness:plan didn't account for database migration needs
- harness:tdd didn't cover async test patterns

**Detection:** Failure occurs in a scenario NOT mentioned in the SKILL.md.

**Fix pattern:** Add explicit instruction for the uncovered scenario.

---

## failure_type: wrong_tool

**Definition:** Agent used the wrong tool or approach for a task.

**Examples:**
- Used `bash cat` instead of `read` tool (violates AGENTS.md)
- Used `grep` instead of `codebase-memory` for cross-package search
- Used `edit` instead of `write` for full file rewrite

**Detection:** Agent's tool choice violates documented tool doctrine.

**Fix pattern:** Add explicit tool selection rules to the relevant skill.

---

## failure_type: retry_loop

**Definition:** Agent retried the same approach multiple times without progress.

**Examples:**
- Same edit applied 3 times to fix a type error
- Same test run 5 times hoping for different result
- Same grep query executed repeatedly

**Detection:** Same action signature repeated 3+ times (Section 10.1 rule).

**Fix pattern:** Add "if this fails, pivot to X" escalation instructions.

---

## failure_type: context_loss

**Definition:** Agent lost track of earlier decisions, requirements, or constraints.

**Examples:**
- Agent re-asked question already answered
- Agent forgot a constraint from the design doc
- Agent's subagent didn't receive full context

**Detection:** Contradiction between current action and earlier decision.

**Fix pattern:** Add context checkpoint instructions (reference earlier outputs explicitly).

---

## failure_type: scope_creep

**Definition:** Agent did more than requested, modifying files outside task scope.

**Examples:**
- Agent refactored adjacent code while fixing a bug
- Agent added features not in the plan
- Agent modified test files when only source files were in scope

**Detection:** Files modified that aren't listed in the task's scope.

**Fix pattern:** Add explicit scope boundaries to task descriptions.

---

## failure_type: false_claim

**Definition:** Agent claimed success without verification, or with stale evidence.

**Examples:**
- "All tests pass" without running tests
- "Typecheck clean" based on LSP, not CLI
- Verification run before last edit

**Detection:** Claim made without corresponding verification command in same message.

**Fix pattern:** Strengthen harness:verify gate (this is what it's designed to catch).

---

## failure_type: rationalization

**Definition:** Agent justified skipping a required step.

**Examples:**
- "This is too simple for TDD" (violates harness:tdd Iron Law)
- "I'll skip review since it's a small change" (violates harness:review)
- "No need to eval, it went well" (violates harness:eval Iron Law)

**Detection:** Agent explicitly stated skipping a required step with justification.

**Fix pattern:** Remove escape hatches from the skill, or add "no exceptions" language.

---

## Pattern Detection Rules

A **PATTERN** is detected when:
- Same `failure_type` appears 3+ times across recent evals (last 10 pipelines)
- Same `failure_type` affects the same stage 2+ times consecutively

When a pattern is detected:
1. Flag it in the eval summary as `PATTERN: <failure_type>`
2. Prioritize the recommended fix
3. Track whether the fix resolves it (measure before/after)

## Severity Classification

| Severity | Definition | Action Required |
|----------|-----------|----------------|
| critical | Pipeline produced wrong output, data loss, or security issue | Fix immediately, block pipeline |
| major | Pipeline produced suboptimal output, significant rework needed | Fix before next pipeline |
| minor | Pipeline worked but could be improved | Fix when convenient |
