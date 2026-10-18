---
name: harness:verify
description: Use when about to claim work is complete, fixed, or passing, before review, commits, or reports - requires running verification commands fresh and reading the output; evidence before assertions always
---

# Verification Before Completion

**Core principle:** evidence before claims, always. Claiming work is complete without verification is dishonesty, not efficiency.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you have not run the verification command after your last change, you cannot claim it passes.

## The Gate

Before claiming any status:

1. **Identify** the command that proves the claim (tests, typecheck, build, reproduction).
2. **Run** the full command, fresh, from the correct directory (`bash` with `workdir` when it is not the session directory).
3. **Read** the full output: exit code, failure count, warnings.
4. **Compare** against the baseline: a failure recorded as PRE-EXISTING before your change (see `harness:worktree`) stays marked `PRE-EXISTING <id>`; every other failure is yours.
5. **Record** each command and its result.
6. **Only then** state the claim, with the evidence.

Do not substitute earlier output or a subagent's report for fresh evidence.

## What Counts as Evidence

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | Test output: 0 new failures | Previous run, "should pass" |
| Build succeeds | Build command: exit 0 | Linter passing |
| Bug fixed | Original symptom reproduced, now passes | Code changed, assumed fixed |
| Regression test works | Red-green: passes, fails with the fix reverted, passes again | Passes once |
| Subagent completed | Diff shows the changes, checks rerun by you | Subagent says "success" |
| Requirements met | Line-by-line check against spec or plan | Tests passing |

**Stale results:** any file edit, dependency change, or config change after a run invalidates it. Re-run before claiming.

## Plan Assumption Check

When verifying against a plan, compare each task's **Assumptions** with observed behavior. A wrong assumption is not a task failure if the work handled it; flag it ("Assumption X was wrong: Y did Z, not W"). Two or more wrong assumptions: recommend a plan revision before continuing.

## Red Flags

Stop and run the verification when you catch yourself:
- Using "should", "probably", "seems to"
- Expressing satisfaction ("Done!", "Perfect!") before running anything
- About to commit, report, or hand to review without fresh output
- Trusting a subagent's success report
- Relying on a partial check ("linter passed" is not a build)
- Thinking "just this once"

## Output

Produce a compact verification summary for `harness:review`, one line per command:

```
bun test (packages/foo): PASS 142/142
bun run typecheck (packages/foo): PASS
bun test (packages/bar): FAIL 1/37 PRE-EXISTING flaky-timeout-T12
```

## Sequencing

Verification and review are strictly sequential. Wait for every verification command to exit before dispatching a reviewer. Never overlap review with a resource-heavy test or application process in the same environment.

**Next step:** `harness:review`, with the summary above as reviewer input.
