---
name: research:review
trigger: "Use during VERIFY phase to audit evidence: check citations, flag UNCORROBORATED, surface conflicts"
---

# Research:Review -- Evidence Audit

Audit all evidence from GATHER phase. Check citations, flag UNCORROBORATED claims, surface source conflicts. Mirrors `harness:review`.

## When to Use

- After GATHER phase produces evidence files
- Before FILTER phase compresses evidence
- The lab differentiator: first-class evidence audit (not post-hoc)

## Audit Checklist

For each evidence file `findings/<run-id>/evidence-*.md`:

### 1. Citation Existence
- Every claim has a source reference (URL, file:line, or paper ID)
- Source is accessible (not broken link, not retracted paper)
- Source date is within freshness window (web 2026 Q2/Q3; academic 2025+)

### 2. UNCORROBORATED Flagging
- Any claim without a verifiable source is flagged `[x] UNCORROBORATED`
- Count: total claims vs uncorroborated claims
- Rate: UNCORROBORATED / total < 20% threshold

### 3. Source Reliability
- Academic/official sources: highest reliability
- Industry-primary (company blog, official docs): high
- Industry-secondary (tech press, analyst): medium
- Blog/social media: low (flag as `[ ] UNVERIFIED`)

### 4. Conflict Detection
- Two sources disagree on a factual claim -> flag as conflict
- Conflict rate: conflicts / total claims
- If conflict rate > 30%, escalate to HITL before proceeding

### 5. Freshness
- Web sources older than 6 months: flag `[x] STALE`
- Academic sources older than 2 years: flag `[x] STALE` (unless seminal)

## Output

Write `findings/<run-id>/verified-evidence.md`:
```markdown
# Verified Evidence -- Run <run-id>
## Summary: N sources, M claims, X UNCORROBORATED, Y conflicts, Z stale
## UNCORROBORATED Claims:
<list of flagged claims>
## Conflicts:
<list of source disagreements>
## Stale Sources:
<list of outdated sources>
## Gate: <PASS|FAIL> -- UNCORROBORATED rate X% (< 20% threshold)
```

## Gate

- UNCORROBORATED rate < 20%: PASS
- Conflict rate > 30%: FAIL (escalate to HITL)
- Exit code: 0 (pass) or 1 (fail)
