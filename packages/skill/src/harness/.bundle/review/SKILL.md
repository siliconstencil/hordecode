---
name: harness:review
description: Use after verification passes and before reporting or merging, or after a subagent task - dispatches an independent reviewer with the diff, the requirements, and a compact verification summary
---

# Requesting Code Review

Dispatch a fresh reviewer subagent with precisely crafted context, never your session history and never an implementer-authored narrative. This keeps the reviewer on the work product and keeps your own context free.

## When

- **Required:** after each task in `harness:subagent` (its own two-stage gate), and once for the whole change after `harness:verify` and before `harness:report`.
- **Useful:** when stuck, before a risky refactor, after a complex bug fix.

Start only after every verification command has exited; never overlap review with a heavy test or app process.

## Choose the Methodology

- **Code changes in the diff:** code review.
- **No code changes** (`git diff --stat` empty or only non-code files; pure investigation or analysis): methodology review. Do not skip review.
- **Mixed or unclear:** ask through `harness:ask`:
  - header: `Review Type`
  - question: `This change mixes code and investigation. What review should run?`
  - options: `Both (Recommended)` / `Code review` / `Methodology review`

  No user available: both.

## Code Review

1. **Get the range:**
   ```bash
   git merge-base HEAD <base-branch>
   git rev-parse HEAD
   ```
2. **Dispatch** a `general` subagent with the `supervisor` tool, building its prompt from `code-reviewer.md` in this skill's directory. Fill:
   - `{DESCRIPTION}`: what was built, in one or two sentences of fact, not a narrative
   - `{PLAN_OR_REQUIREMENTS}`: the applicable spec sections and acceptance criteria
   - `{BASE_SHA}`, `{HEAD_SHA}`: the range
   - `{VERIFICATION_SUMMARY}`: the compact summary from `harness:verify`, one line per command with PASS / FAIL / PRE-EXISTING and test counts; no full output unless a specific failure needs it

   If a worktree is in use and the session did not switch into it, include its absolute path for `workdir`.

The reviewer gives separate conclusions for spec compliance, correctness, and codebase consistency. It must not rerun a command reported as passing unless the result is stale or concretely suspect.

## Methodology Review

Use the same dispatch with a prompt that checks:
1. **Assumption accuracy:** did plan assumptions match reality?
2. **Command correctness:** were the right commands run, with the expected output?
3. **Reasoning chain:** is the path from question to evidence to conclusion sound?
4. **Evidence quality:** is every claim backed by fresh, verifiable evidence?
5. **Completeness:** are all questions in the plan answered?

## Act on Findings

- **Critical** (unmet or unverifiable acceptance criteria, correctness bugs): fix, re-verify with `harness:verify`, then re-review the affected area.
- **Important:** fix before proceeding.
- **Minor:** note for the report.
- **Wrong findings:** reject with technical evidence (code, tests, output). See `harness:feedback`.

**Non-convergence:** if the fix-and-re-review loop stops converging (repeated findings on the same area, or fixes that introduce new criticals), stop looping and report the impasse with the remaining findings instead of forcing a pass.

**Next step:** `harness:report`.
