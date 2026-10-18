---
name: harness:feedback
description: Use when receiving code review feedback from a reviewer or the user, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires verification and technical rigor, not performative agreement or blind implementation
---

# Code Review Reception

**Core principle:** verify before implementing, clarify before assuming, technical correctness over social comfort. Review feedback is a set of suggestions to evaluate, not orders to follow.

## The Pattern

1. **Read** all the feedback before reacting.
2. **Understand:** restate each item as a technical requirement.
3. **Verify** it against the codebase: is it correct for THIS code, does it break existing behavior, is there a reason for the current implementation, does the reviewer have the full context?
4. **Clarify first:** if any item is unclear, implement nothing yet; items may be related. Ask through `harness:ask`, presenting your interpretations as options. No user available: take the most reasonable interpretation, state it, and proceed.
5. **Implement** validated items one at a time, verifying each: blocking issues (breakage, security) first, then simple fixes, then complex ones. Check for regressions.

## YAGNI Check

When a reviewer asks to "implement properly" something speculative, grep for actual usage first. Unused: propose removing it instead. Used: implement it properly.

## Push Back When

- The suggestion breaks existing functionality or is wrong for this stack
- The reviewer lacks context (legacy or compatibility reasons)
- It adds an unused feature
- It conflicts with the user's prior decisions; surface the conflict through `harness:ask` instead of silently complying

Push back with technical reasoning: cite code, tests, or command output. If you cannot verify a claim, say what you would need.

## Responding

- No performative agreement ("You're absolutely right!", "Great point!") and no thanks; state the fix instead: "Fixed: <what changed> in <location>."
- If your pushback was wrong: "Verified: you're correct, because <reason>. Fixing." No long apology.
- On GitHub, reply inside the inline comment thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level comment.
