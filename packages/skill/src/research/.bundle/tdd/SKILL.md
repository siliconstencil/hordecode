---
name: research:tdd
description: "Use during EVAL phase to verify report quality: every claim traces to evidence"
trigger: "Use during EVAL phase to verify report quality: every claim traces to evidence"
---

# Research:TDD -- Report Quality Gate

Verify the report quality: every claim traces to an evidence row, every source is real, metrics are recorded. Mirrors `harness:tdd`.

## When to Use

- After DECIDE produces the decision record
- Final quality gate before the run is considered complete
- Records metrics for research-distill.sh aggregation

## Checklist

### 1. Claim-to-Evidence Traceability
For every claim in the report:
- [ ] Claim has a source reference in the citation table
- [ ] Source is listed in filtered-evidence.md (not fabricated)
- [ ] UNCORROBORATED flags from VERIFY are preserved in the report

### 2. Source Verification
For every source in the citation table:
- [ ] Source URL/reference is accessible (not broken)
- [ ] Source date is within freshness window
- [ ] Source type is correctly labeled (academic/official/industry/blog)

### 3. Decision Completeness
- [ ] Decision state present (ADOPT/DEFER/REJECT)
- [ ] Reasoning documented
- [ ] Target milestone identified (for ADOPT)

### 4. Metrics
Record to `findings/<run-id>/metrics.md`:
```markdown
# Metrics -- Run <run-id>
sources_consulted: <N>
claims_made: <M>
claims_with_source: <X>
uncorroborated_rate: <X/M>
conflicts_found: <Y>
stale_sources: <Z>
decision: <ADOPT|DEFER|REJECT>
tokens_used: <total across all phases>
wall_clock_s: <seconds>
```

## Gate

- Claim-to-evidence trace: PASS if all claims have sources
- Source verification: PASS if no broken links in top-5 sources
- Metrics recorded: PASS
- Exit code: 0 (pass) or 1 (fail)

Mechanical gate (run it; the checks above are not self-enforcing): write
`findings/<run-id>/eval.evidence` from `../research/templates/evidence.md` and record the run metrics: claims traced, source count, scores, token use.
Delete or mark `na` the conditional slots you do not use. Then, from the project root (the gate
reads `findings/` relative to the working directory), run the gate script, resolving its path
against this skill's base directory:

```bash
bash ../research/scripts/research-gate.sh <run-id> eval
```

Non-zero exit means this phase did not earn its evidence: STOP, fix the evidence file and re-run
the gate. Do not start the next phase until it exits 0.
