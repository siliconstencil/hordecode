---
name: harness:debug
description: Use when encountering any bug, test failure, build failure, or unexpected behavior, before proposing fixes - four phases from root cause to verified fix
---

# Systematic Debugging

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** find the root cause before attempting a fix. A symptom fix is a failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If Phase 1 is not complete, you cannot propose fixes. This holds for simple-looking bugs, under time pressure, and especially after a fix already failed.

## Phase 1: Root Cause Investigation

1. **Read error messages completely:** full stack traces, line numbers, file paths, error codes. They often contain the answer.
2. **Reproduce consistently:** exact steps, every time? If it is not reproducible, gather more data instead of guessing.
3. **Check recent changes:** `git diff`, recent commits, new dependencies, config and environment differences.
4. **Instrument component boundaries** in multi-component systems (CI -> build -> signing, API -> service -> database): log what enters and exits each component and whether config and environment propagate. Run once to see WHERE it breaks, then investigate that component.
5. **Trace data flow** when the error is deep in the call stack: where does the bad value originate, what called this with it? Keep tracing up to the source and fix there. See `root-cause-tracing.md` in this skill's directory.

## Phase 2: Pattern Analysis

1. **Find working examples** of similar code in the same codebase.
2. **Read the reference completely** when implementing a known pattern; do not skim.
3. **List every difference** between working and broken, however small.
4. **Understand dependencies:** components, settings, environment, assumptions.

## Phase 3: Hypothesis and Testing

1. **One hypothesis:** "X is the root cause because Y." Be specific.
2. **Test minimally:** the smallest change that tests it, one variable at a time.
3. **Check:** confirmed -> Phase 4. Not confirmed -> form a new hypothesis; do not stack fixes.
4. **When you don't know,** say so. Present what you tried through `harness:ask` with next-step options. No user available: take the most promising next step and continue.

## Phase 4: Implementation

1. **Failing test first:** the simplest reproduction, automated if possible (see `harness:tdd`).
2. **One fix** addressing the root cause. No "while I'm here" changes, no bundled refactoring.
3. **Verify:** the test passes, no other test broke, the original symptom is gone (`harness:verify`).
4. **If the fix fails,** return to Phase 1 with the new information.

**After two failed fixes, stop patching and re-derive the cause.** Discard the current theory, go back to the evidence (errors, diffs, recent commits, boundary instrumentation), and question the approach itself. Signs of a wrong architecture: each fix reveals a new problem in a different place, fixes need massive refactoring, or each fix creates new symptoms elsewhere. Present the concern through `harness:ask` with options such as `Re-derive and continue` / `Propose refactor` / `Discuss first`. No user available: choose the re-derived approach and continue.

## Red Flags: Return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- Several changes at once, then run the tests
- "Skip the test, I'll verify manually"
- "It's probably X" without evidence
- Proposing fixes before tracing data flow
- "One more fix attempt" after two have failed

| Excuse | Reality |
|--------|---------|
| "Issue is simple" | Simple issues have root causes too; the process is fast for them. |
| "Emergency, no time" | Systematic debugging is faster than thrashing. |
| "I see the problem" | Seeing symptoms is not understanding the cause. |
| "Multiple fixes at once saves time" | You cannot tell what worked, and new bugs appear. |

## When There Is No Root Cause

If investigation shows the issue is truly environmental, timing-dependent, or external: document what you investigated, implement appropriate handling (retry, timeout, clear error), and add logging for future investigation. Most "no root cause" conclusions are incomplete investigations; be sure first.

## Supporting Techniques

In this skill's directory:
- `root-cause-tracing.md`: trace backward through the call stack to the original trigger
- `condition-based-waiting.md`: replace arbitrary timeouts with condition polling in flaky tests
