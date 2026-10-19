# Evidence -- `<phase>` -- Run `<run-id>`

> Phase: `<SCOPE|GATHER|VERIFY|FILTER>`
> Date: `<YYYY-MM-DD>`

---

## Sources

| # | Source | Type | Date | Confidence | Notes |
|---|--------|------|------|------------|-------|
| 1 | `<URL or file:line>` | `<academic|official|industry|blog>` | `<date>` | `<high|medium|low>` | `<notes>` |

## Claims

| # | Claim | Source ref | UNCORROBORATED | Conflict |
|---|-------|------------|----------------|----------|
| 1 | `<claim text>` | Source #1 | `[ ]` | `[ ]` |

## Conflict Flags

<!-- Source disagreements found during VERIFY -->

- `<conflict description>`

## Tooling Preamble

<!-- Declare the bash preamble used for this phase. Required for bash-heavy phases (gather, verify, analyze). -->
- **Bash preamble**: `<e.g. sqlite3 -readonly hordecode.db -header -column "..." > or bun run typecheck 2>&1 | grep -c "error TS">`
- **Trajectory hits**: `<count from hordecode.db history_fts for this pattern, if queried>`
- **Read-only assertion**: `[ ] confirmed no DB writes / no file mutations / no git commits`
- **Repro script**: `<path to repro script or harness -- required for debug/verify gate, S1>`
- **Hypotheses (If X then Y, ranked 1-3)**: `<e.g. 1. If task-queue stalls then queue depth grows -- check queue.db; 2. If ...>`

## Repro & Hypotheses Gate Slots (S1)

<!-- Debug verification: gate checks these when present. Leave placeholder only if phase is not debug. -->
- **Repro script path**: `<./scripts/repro-<issue>.sh or <path> -- must be non-placeholder for debug>`
- **Hypothesis 1**: `<If X then Y -- falsifiable>`
- **Hypothesis 2**: `<If X then Y>`
- **Hypothesis 3**: `<If X then Y>`

## Review -- Standards vs Spec Slots (S3, conditional -- fill when spec/PR exists; delete-or-mark na otherwise)

### Standards

- **Standard pinned**: `<project norm -- e.g. ../AGENTS.md 13.5 or lint rule>`
- **Evidence**: `<file:line or log>`

### Spec

- **Spec pinned**: `<spec paragraph / PR line / mockup diff>`
- **Evidence**: `<file:line or three-dot diff>`

## TDD -- Seam / Slice / Stub Slots (S4, conditional -- only when code run / tdd/seam marker present; delete-or-mark na otherwise)

- **Seam:** `<interface/seam definition -- e.g. packages/foo/bar.ts:42 interface SeamName>`
- **Slice:** `<one-slice scope -- single seam, single behavior, e.g. add retry to SessionCheckpointNode>`
- **Stub check:** `<0 or result of grep -R "TODO|stub|placeholder" on seam files -- must be 0/no stubs, or mark na>`

## Phase Gate

- [ ] At least 1 source per question
- [ ] UNCORROBORATED claims flagged
- [ ] Conflicts surfaced
- [ ] Token budget under cap
- [ ] Tooling Preamble present (bash-heavy phases only)
- [ ] S3 review -- when spec/PR present, Standards + Spec headings non-placeholder
- [ ] S4 TDD -- when tdd/seam/one-slice present, Seam/Slice/Stub slots non-placeholder
