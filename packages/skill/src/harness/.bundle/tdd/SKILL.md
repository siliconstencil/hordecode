---
name: harness:tdd
description: Technique used inside each plan task and by implementers for any behavior change or bug fix - write the failing test first, watch it fail, then write the minimal code to pass
---

# Test-Driven Development (TDD)

A technique applied inside each implementation task, not a separate stage. Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** if you didn't watch the test fail, you don't know whether it tests the right thing.

## When to Use

**Always** for new behavior, bug fixes (a regression test whenever one can be written), and behavior-changing refactors.

**Exceptions:** generated code, configuration-only changes, throwaway prototypes, or explicit user direction. If unsure, ask through `harness:ask`.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before the test? Delete it and start over. Don't keep it as "reference" and don't "adapt" it.

## Red-Green-Refactor

1. **RED:** write one failing test. Run it. It must fail for the intended reason (a typo or import error is the wrong failure; fix the test).
2. **GREEN:** write the minimal code to pass. No extra features.
3. **REFACTOR:** clean up while staying green. Don't add behavior.
4. **Next:** back to RED with the next behavior.

### Key Rules

- One behavior per test. "and" in the name? Split it.
- Test public behavior. Prefer real implementations; mock only what you cannot run.
- Don't duplicate production logic in expected values, add test-only production APIs, or assert only that mocks were called.
- Name the behavior, not the implementation.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. The test takes 30 seconds. |
| "I'll test after" | A test that passes immediately proves nothing. |
| "Deleting X hours is wasteful" | Sunk cost. Unverified code is debt. |
| "Need to explore first" | Fine. Throw the exploration away, then start with TDD. |

## Red Flags: Start Over

- Code before test
- Test passes immediately
- You can't explain why the test failed
- "Keep as reference" or "adapt existing code"

## Checklist

- [ ] Every new function or behavior has a test
- [ ] Watched each test fail for the expected reason
- [ ] Wrote minimal code to pass
- [ ] All tests pass; output pristine (no new errors or warnings)

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write the wished-for API; write the assertion first. |
| Test too complicated | Design too complicated; simplify the interface. |
| Must mock everything | Code too coupled; use dependency injection. |

`reference.md` in this skill's directory has worked examples; `testing-anti-patterns.md` covers mock and test-utility pitfalls.
