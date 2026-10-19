# Decision -- `<topic>` -- Run `<run-id>`

> Date: `<YYYY-MM-DD>`
> Run ID: `<run-id>`
> Finding: `<brief description>`

---

## Decision

`<ADOPT|DEFER|REJECT>`

## Reasoning

`<evidence-based rationale for the decision>`

## Evidence

| Finding | Source | Confidence | UNCORROBORATED |
|---------|--------|------------|----------------|
| `<finding>` | `<source>` | `<confidence>` | `[x]` or `[ ]` |

## Target

- **Milestone**: `<M7|M10|M12|M13|...>`
- **Task**: `<task ID or "new task needed">`
- **Queue**: `<QUEUE row # or "no queue entry">`

## Context Delta (S3, merge -- CONTEXT.md linkage, conditional on ARCH/decide)

- **CONTEXT.md delta**: `<what changed in CONTEXT.md or "no CONTEXT change -- link to diff/patch">`

## ADR 3-Gate Checklist (S3, conditional on ADR linkage)

- [ ] Gate 1 -- decision state ADOPT/DEFER/REJECT recorded
- [ ] Gate 2 -- consequences enumerated
- [ ] Gate 3 -- linkage exists (ADR-LOG row / QUEUE row / file:line ref non-placeholder)

## ADR

- **ADR ID**: `<ADR-xxx or "new ADR needed">`
- **Consequences**: `<what changes if this is adopted>`

---

<!-- Decision state: ADOPT/DEFER/REJECT + reason + milestone + ADR linkage -->
<!-- This record feeds into: QUEUE.md Decision column, ADR-LOG.md, monthly distillation -->
