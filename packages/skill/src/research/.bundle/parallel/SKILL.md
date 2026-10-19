---
name: research:parallel
description: "Use during GATHER to decompose subtopics and run parallel research"
trigger: "Use during GATHER to decompose subtopics and run parallel research"
---

# Research:Parallel -- Subtopic Decomposition + Parallel Contexts

Decompose the brief into subtopics and run parallel research with isolated contexts. Mirrors `harness:parallel`.

## When to Use

- GATHER phase, after brief is approved
- Multiple subtopics from the brief need parallel evidence collection

## Decomposition Rules

1. **One sub-agent per subtopic** from the brief
2. **Isolated context**: each sub-agent runs in its own context (no shared state)
3. **Max 5 parallel sub-agents**: system resource cap
4. **Failure isolation**: one sub-agent failure does not abort siblings

## Parallelism Pattern

```
Brief subtopics: [S1, S2, S3, S4]
  |
  v
[supervisor(subagent_type=general, prompt=researcher-prompt+S1+evidence_policy)] -> evidence-S1.md
[supervisor(subagent_type=general, prompt=researcher-prompt+S2+evidence_policy)] -> evidence-S2.md
[supervisor(subagent_type=general, prompt=researcher-prompt+S3+evidence_policy)] -> evidence-S3.md
[supervisor(subagent_type=general, prompt=researcher-prompt+S4+evidence_policy)] -> evidence-S4.md
  |
  v (all complete)
VERIFY phase audits all evidence files
```

## When NOT to Parallelize

- Only 1 subtopic (run single gather sub-agent)
- Subtopics have dependencies (run sequentially)
- Budget is too tight for parallel (single agent with sequential subtopics)
