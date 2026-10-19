---
name: research:merge
trigger: "Use during DECIDE phase to produce the decision record: ADOPT/DEFER/REJECT + reason + milestone"
---

# Research:Merge -- Decision Record

Produce the decision record: ADOPT, DEFER, or REJECT each finding with reasoning, evidence basis, and target milestone. Mirrors `harness:merge`.

## When to Use

- After SYNTHESIZE writes the report
- Every research run ends with a decision, not just a document
- Decision feeds into QUEUE.md and ADR-LOG.md

## Decision States

- **ADOPT**: finding is actionable, implement now or in near-term milestone
- **DEFER**: finding is valid but implementation is deferred (specify when)
- **REJECT**: finding is not actionable (specify why)

## Decision Record Structure

Use template at `../research/templates/decision.md`:

1. **Decision**: ADOPT / DEFER / REJECT
2. **Reasoning**: evidence-based rationale
3. **Evidence**: finding -> source mapping with confidence
4. **Target**: milestone + task ID or "new task needed"
5. **ADR**: ADR ID or "new ADR needed"

## Integration

- **QUEUE.md**: add Decision column row with `ADOPT/DEFER/REJECT + reason + milestone`
- **ADR-LOG.md**: if ADOPT, create ADR entry with context/decision/consequences
- **MEMORY.md**: append timestamped entry recording the decision
- **Aurelius**: create decision node + relate to project

## Gate

- Decision state present: PASS
- Reasoning documented: PASS
- Target milestone identified (for ADOPT): PASS
- Exit code: 0

Mechanical gate (run it; the checks above are not self-enforcing): write
`findings/<run-id>/decide.evidence` from `../research/templates/evidence.md` and carry the decision state (ADOPT, DEFER or REJECT), the reasoning and the evidence table.
Delete or mark `na` the conditional slots you do not use. Then, from the project root (the gate
reads `findings/` relative to the working directory), run the gate script, resolving its path
against this skill's base directory:

```bash
bash ../research/scripts/research-gate.sh <run-id> decide
```

Non-zero exit means this phase did not earn its evidence: STOP, fix the evidence file and re-run
the gate. Do not start the next phase until it exits 0.
