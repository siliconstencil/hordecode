---
name: research:deliberate
description: Gated deliberate wrapper over sequential-thinking (standardized MCP call, conditional).
trigger: synthesize/decide when alternatives>=3 or confidence<0.9 or conflict>0.3
---

# research:deliberate -- Gate: SYNTHESIZE / DECIDE (conditional)

## Trigger (conditional -- skip = not deliberative)

Run ONLY when at least one holds:
- alternatives >= 3
- confidence < 0.9
- conflict > 0.3

Otherwise record `findings/<run-id>/seqthink-evidence.md` as `SKIPPED: <reason>` -- gate passes without MCP call.

## Invocation (when triggered)

Call `sequential-thinking` MCP with:
- `total_thoughts`: 5-7
- require `branchFromThought` or `isRevision` at least once (trace branches)
- output hypothesis list + reversal test per hypothesis

## Artifact

`findings/<run-id>/seqthink-evidence.md` MUST contain (non-placeholder):
- Trigger values (alternatives/confidence/conflict)
- Hypothesis count >= 2
- At least one `Branch:` or `Revision:` marker
- Reversal test sentence per hypothesis

Failure to produce artifact -> `research-gate.sh` SYNTHESIZE/DECIDE exits 1 (Section 21).

## Budget

Carved from `synthesize` Phase: **2 min / 3K tokens** (see `phase-budgets.conf`). Not additive -- synthesize total stays 10 min / 15K; 8 min / 12K remains for synthesis prose.
