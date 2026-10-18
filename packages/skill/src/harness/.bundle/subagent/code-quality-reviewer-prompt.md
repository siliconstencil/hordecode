# Code Quality Reviewer Prompt Template

Use this template when dispatching a code quality reviewer subagent for one task.

**Purpose:** Verify the implementation is well built (clean, tested, maintainable, consistent with the codebase).

**Only dispatch after the spec-compliance gate passes.**

Dispatch a `general` subagent with the `supervisor` tool (`run`). Build its prompt from `../review/code-reviewer.md` (relative to this skill's base directory), filling in:

- DESCRIPTION: [task summary, from the implementer's report]
- PLAN_OR_REQUIREMENTS: Task N from [plan file], with its covered spec sections
- BASE_SHA: [commit before the task]
- HEAD_SHA: [current commit]
- VERIFICATION_SUMMARY: [one line per command the implementer or you ran: PASS / FAIL / PRE-EXISTING, with test counts]

If the work was done in an isolated worktree the session did not switch into, add the `workdir` line described in the Git Range section of `../review/code-reviewer.md`.

**In addition to the standard checks, the reviewer should check:**
- Does each file have one clear responsibility with a well-defined interface?
- Are units decomposed so they can be understood and tested independently?
- Does the implementation follow the file structure from the plan?
- Did this change create new large files or significantly grow existing ones? (Don't flag pre-existing file sizes; focus on what this change contributed.)

**Code reviewer returns:** Strengths, Issues (Critical/Important/Minor), Assessment.
