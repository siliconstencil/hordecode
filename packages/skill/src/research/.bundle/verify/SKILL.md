---
name: research:verify
trigger: "Use during FILTER phase to compress and deduplicate verified evidence"
---

# Research:Verify -- Compression & Dedup

Compress verified evidence: keep source + confidence + flags only. Deduplicate overlapping sources. Enforce token budget. Mirrors `harness:verify`.

## When to Use

- After VERIFY phase audits evidence
- Before SYNTHESIZE writes the report
- Goal: reduce token cost for the synthesizer while preserving signal

## Compression Rules

1. **Keep**: source reference, confidence level, UNCORROBORATED flag, conflict flag
2. **Drop**: raw evidence text, verbatim quotes, tool output details
3. **Deduplicate**: two evidence rows about the same source -> merge into one
4. **Merge**: overlapping evidence about the same fact -> keep highest-confidence source

## Token Budget

Per manifest (default 5K tokens for FILTER output). If over budget:
- Drop lowest-confidence sources first
- Drop stale-flagged sources next
- Never drop all sources for a subtopic (minimum 1 per subtopic)

## Output

Write `findings/<run-id>/filtered-evidence.md`:
```markdown
# Filtered Evidence -- Run <run-id>
## Sources (deduplicated): N
| # | Source | Confidence | Flags | Subtopic |
|---|--------|------------|-------|----------|
| 1 | <source> | <high|medium|low> | <UNCORROBORATED|CONFLICT|STALE|--> | <subtopic> |
```

## Gate

- At least 1 source per subtopic: PASS
- Token budget under cap: PASS
- Exit code: 0 (pass) or 1 (fail)
