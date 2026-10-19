---
name: research:ask
trigger: "Use at the start of a research run to clarify user intent before scope decomposition"
---

# Research:Ask -- Intent Clarification

Clarify the user's research question before decomposing. Mirrors `harness:ask`.

## When to Use

- First step of every research pipeline run
- User question is ambiguous, multi-part, or lacks scope boundaries
- Need to determine: what exactly to research, what NOT to research, depth level

## Rules

1. **Never assume.** Ask the user to confirm the question if ambiguous.
2. **Socratic approach.** Challenge assumptions before accepting them.
3. **Record verbatim.** User's exact words go into `brief.md` as "User intent".
4. **Determine depth.** Quick scan (2-3 sources) vs deep research (10+ sources)?
5. **Identify constraints.** Time limits, source preferences, freshness requirements, specific databases/APIs to search.

## Output

Record clarifications in `findings/<run-id>/intent.md`:
```markdown
# Intent -- Run <run-id>
## Original question: <verbatim>
## Clarified scope: <what exactly to research>
## Out of scope: <what NOT to research>
## Depth: <quick|standard|deep>
## Source preferences: <any constraints>
## Constraints: <time/depth/freshness>
```

## HITL Checkpoint

If the research is high-stakes or ambiguous, get explicit user approval before proceeding to SCOPE.
