---
name: research:review
description: Audit research findings against the brief before writing - coverage gaps, single-source claims, conflicts, stale and weak sources. Use from the research skill after the gather step.
---

# Review the evidence

Read `brief.md` and every `findings/F<n>.md` in the workspace. Do not search in this step.

Check:
1. Coverage: which questions and angles in the brief have no findings, or only weak ones?
2. Single source: a major claim backed by one source only gets `[single source]`.
3. Conflict: two sources disagree on a fact. Mark both `CONFLICT`; prefer the newer primary source
   and keep both in the report.
4. Freshness: a source older than the brief's time frame gets `STALE` unless it is the original
   or a standard reference.
5. Weak support: a claim whose quote does not support it, or whose source is a blog, forum or
   content farm with no primary backing, gets `UNCORROBORATED`.
6. Source rank: official or primary > peer-reviewed or reputable press > forums and blogs.

Write the result to `<workspace>/review.md`:

```markdown
# Review
- Findings files: <n>; claims: <n>; sources: <n>
- Gaps: <angle or question, one line each, or "none">
- Flags: <claim -> flag, one line each>
- Follow-up angles: <narrower questions for another round, or "none">
```

Then return to the research skill: spawn the follow-up angles if a round is left in the budget,
otherwise carry the gaps into "Open questions".
