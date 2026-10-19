---
name: research:scope
trigger: "Use after ask to decompose the research question into perspectives and produce the brief"
---

# Research:Scope -- Question Decomposition & Brief

Decompose the research question into perspectives (STORM-inspired) and produce the research brief. Mirrors `harness:brainstorm`.

## When to Use

- After `research:ask` clarifies intent
- Before any research agents are dispatched
- The brief is the "north star" for the entire run

## Perspective-Guided Decomposition (STORM)

Based on Shao et al. (arXiv:2402.14207):
1. **Survey similar work.** Check existing docs in `research/INDEX.md` for related research.
2. **Discover N perspectives.** For each dimension of the question:
   - What does the user NEED to know? (core facts)
   - What does the user ASSUME to be true? (validate assumptions)
   - What does the user NOT KNOW they don't know? (blind spots)
   - What could go WRONG with the question itself? (meta-critique)
3. **One question per perspective.** Each perspective becomes a subtopic for a gather sub-agent.
4. **Basic fact writer (p0).** Cover foundational facts first before deeper analysis.

## Output

Write `findings/<run-id>/brief.md` using the template at `research/pipeline/templates/brief.md`.

## Gate

Brief must be approved before GATHER starts. In non-interactive mode, proceed with the brief as-is.

## Anti-Patterns

- Accepting the user's question at face value without decomposition
- More than 7 perspectives (diminishing returns, token bloat)
- Skipping the "what could go wrong with the question itself" step
