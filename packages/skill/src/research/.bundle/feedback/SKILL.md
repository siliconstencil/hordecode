---
name: research:feedback
trigger: "Use when receiving user feedback on a research brief, report, or decision"
---

# Research:Feedback -- User Feedback Loop

Handle user feedback on research artifacts. Mirrors `harness:feedback`.

## When to Use

- User reviews the brief and wants changes
- User reviews the report and wants corrections
- User disagrees with the decision
- User provides additional sources or constraints

## Rules

1. **Verify first, then act**: if the user challenges a claim, verify the source before accepting or rejecting the feedback
2. **No performative agreement**: if the feedback is technically wrong, say so with evidence
3. **Capture the change**: update the relevant artifact (brief, evidence, report, decision) with the feedback applied
4. **Re-run affected phase**: if feedback changes the scope, re-run from that phase forward

## Integration

- Feedback becomes part of the evidence chain (what was challenged, why, what changed)
- If feedback reveals a systemic issue, add to `../research/conf/failure-patterns.md`
