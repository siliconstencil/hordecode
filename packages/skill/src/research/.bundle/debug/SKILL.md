---
name: research:debug
description: "Use when a research run fails or produces unexpected results"
trigger: "Use when a research run fails or produces unexpected results"
---

# Research:Debug -- Failed Run Triage

Triage failed research runs. Diagnose which phase failed, why, and what to fix. Mirrors `harness:debug`.

## When to Use

- A gate fails (exit code 1)
- Evidence is incomplete or contradictory
- Report quality is below threshold
- User feedback identifies a problem

## Diagnostic Flow

1. **Identify failed phase**: check gate exit codes or evidence files
2. **Root cause**: why did it fail?
   - No sources found -> broaden search terms
   - Too many UNCORROBORATED -> need better sources
   - Conflicts unresolved -> need HITL decision
   - Token budget exceeded -> reduce scope
   - Gate script error -> check script + fix
3. **Fix**: apply the fix
4. **Re-run**: retry the failed phase (not the entire pipeline)
5. **3-strike limit**: 3 failures on same phase -> stop and escalate

## Failure Patterns

The catalog lives in `../research/conf/failure-patterns.md`. It is read-only: to add a
pattern, write a proposal to `docs/harness/proposals/<run-id>-research-debug.md` with the
evidence (run id, phase, detection output), the pattern, and the exact diff against the
bundled file; then stop and ask the user.

## Anti-Patterns

- Re-running the entire pipeline instead of the failed phase
- Skipping the failed phase instead of fixing
- More than 3 retries without progress (circuit breaker)
