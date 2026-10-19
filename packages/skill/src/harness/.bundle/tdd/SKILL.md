---
name: harness:tdd
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development (TDD)

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

## When to Use

**Always:** New features, bug fixes, refactoring, behavior changes.

**Exceptions (raise through harness:ask):** Throwaway prototypes, generated code, config files.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No exceptions. Don't keep as "reference". Don't "adapt" it. Delete means delete.

## Red-Green-Refactor

RED -> verify fails -> GREEN -> verify passes -> REFACTOR -> verify still green -> next test -> RED ...

1. **RED** - Write one failing test. Verify it fails correctly (wrong failure = fix test).
2. **GREEN** - Write minimal code to pass. No extra features.
3. **REFACTOR** - Clean up while staying green. Don't add behavior.
4. **Next** - back to RED with the next behavior.

### Key Rules

- One behavior per test. "and" in name? Split it.
- Real code, no mocks unless unavoidable.
- Name describes behavior, not implementation.
- Don't add features beyond the test.

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is tech debt. |
| "TDD will slow me down" | TDD faster than debugging. Pragmatic = test-first. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |

## Red Flags - STOP and Start Over

- Code before test
- Test passes immediately
- Can't explain why test failed
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"

**All of these mean: Delete code. Start over with TDD.**

## Verification Checklist

- [ ] Every new function has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason
- [ ] Wrote minimal code to pass
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |

## Detailed Reference

For code examples, rationalizations, and anti-patterns, see `<harness:tdd>/reference.md`.
