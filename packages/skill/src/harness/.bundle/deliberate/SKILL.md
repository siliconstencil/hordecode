---
name: harness:deliberate
description: Gated deliberate wrapper over sequential-thinking (mirror of research:deliberate).
trigger: report/merge when alternatives>=3 or confidence<0.9 or conflict>0.3
aliases: ["research:deliberate"]
---

# harness:deliberate -- Gate: harness:report / harness:merge (conditional, mirror)

Identical contract to `research:deliberate`; map phases:
- research SYNTHESIZE -> harness:report synthesis section
- research DECIDE -> harness:merge decision consolidation

Trigger, artifact (`findings/<run-id>/seqthink-evidence.md` with Branch/Revision + hypotheses + reversal), and budget (2 min / 3K carved from stage-budgets.conf synthesize/report) identical. Gate: `harness-gate.sh report`/`merge` conditional check (same regex as research-gate).
