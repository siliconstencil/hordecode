# Report format

Write `REPORT.md` alone, in one pass, from `brief.md` and every `findings/*.md`. Do not search
again while writing; if a gap blocks a section, state the gap.

```markdown
# <the refined research question>

> <date> - depth: <depth> - <N> sources - workspace: <path>

## Summary
5-10 bullets, each with citations [n]. Useful on its own to a reader who stops here.

## Scope
2-4 sentences from brief.md: question, boundaries, assumptions.

## <Body, organized by theme, not by subagent>
Merge overlapping claims and show disagreements:
- citations: "... grew 40% in 2025 [3][7]."
- conflicts: "A (2026-03) reports X [2]; B (2025-11) reports Y [5]; A is newer and primary."
- flags: [single source], [speculative], UNCORROBORATED, CONFLICT, STALE (see research:review).

## Comparison (when the question compares options)
| Option | <dimensions from the brief> | Sources |

## Open questions
Gaps the evidence could not settle.

## Sources
[1] <title> - <URL> (published <date>, accessed <today>)
```

Rules:
- Every `[n]` resolves to a Sources entry whose URL appears in a findings file. Number sources in
  order of first mention and remove duplicate URLs.
- Use the user's language; keep technical terms and quotes in the original.
- Length follows the evidence: quick 1-2 pages, standard 3-5, deep 5-10.

Critique pass (standard and deep), then fix in place:
1. A claim that needs a citation and has none?
2. A citation whose source does not support the sentence?
3. A section that rests only on sources older than the brief's time frame?
4. Is the strongest counter-argument present?
5. Does the summary match the body?
