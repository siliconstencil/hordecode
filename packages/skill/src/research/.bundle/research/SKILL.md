---
name: research
description: "Use to run the research pipeline end-to-end: ask -> scope -> gather -> verify -> filter -> synthesize -> decide -> eval"
trigger: "Use to run the research pipeline end-to-end: ask -> scope -> gather -> verify -> filter -> synthesize -> decide -> eval"
---

# Research Pipeline -- Root Orchestrator

Orchestrate a complete research pipeline run. Mirrors `harness` root skill.

## Pipeline Phases

```
ASK -> SCOPE -> GATHER -> VERIFY -> FILTER -> SYNTHESIZE -> DECIDE -> EVAL
```

## When to Use

- User asks a research question that needs multiple sources
- Complex analysis requiring evidence, citation audit, and a decision
- Any task that needs a structured research document

## Workflow

1. **ASK**: Clarify user intent via `research:ask`. Never assume. Record verbatim intent.
2. **SCOPE**: Decompose via `research:scope`. Produce `brief.md` in `findings/<run-id>/`. Get user approval on brief before proceeding.
3. **PLAN**: Create run manifest via `research:plan`. Assign agents, budgets, gates.
4. **GATHER**: Execute parallel research via `research:execute` + `research:parallel`. Each sub-agent writes `evidence.md` with source + confidence.
5. **VERIFY**: Audit evidence via `research:review`. Check citations, flag UNCORROBORATED, surface conflicts.
6. **FILTER**: Compress via `research:verify`. Keep source+confidence only. Enforce token budget.
7. **SYNTHESIZE**: Write ONE-SHOT report via `research:report`. Citation table required.
8. **DECIDE**: Produce decision record via `research:merge`. ADOPT/DEFER/REJECT + reason + milestone.
9. **EVAL**: Score the run via `research:tdd`. Record metrics.

## Run ID

Format: `<YYYY-MM-DD>-<topic-kebab>-<seq>`. Example: `2026-07-31-db-metadata-taxonomy-01`.

## Findings Directory

Every run writes to `findings/<run-id>/`, relative to the project root where the research scripts run:
- `brief.md` (SCOPE output)
- `evidence.md` (GATHER output, per-phase)
- `report.md` (SYNTHESIZE output)
- `decision.md` (DECIDE output)
- `<phase>.gate` (gate pass/fail record)

## Evidence Policy (binding)

- Sources: academic/official > industry-primary > industry-secondary > blog
- UNCORROBORATED: any claim without verifiable source is flagged
- Freshness: web 2026 Q2/Q3; older flagged stale

## Parallelism

- Max 5 sub-agents in GATHER phase (isolated context per sub-agent)
- Sub-agent failure isolated (does not abort siblings)
- Synthesis is ONE-SHOT, never multi-agent

## Gate Ordering

Sequential: evidence -> citation -> token. Each gate must pass before next phase.

## Integration

- QUEUE.md: add Decision column per finding
- ADR-LOG.md: decision records from DECIDE phase
- MEMORY.md: every run appends timestamped entry
- Aurelius: per-run decision nodes + task_log

## Scripts

- `scripts/research-gate.sh` -- evidence check, DRAFT/FINAL
- `scripts/research-score.sh` -- per-phase keyword scoring
- `scripts/research-aggregate.sh` -- run-level aggregation
- `scripts/research-cite.sh` -- citation audit
- `scripts/research-index.sh` -- INDEX.md maintenance
- `scripts/research-distill.sh` -- monthly distillation
