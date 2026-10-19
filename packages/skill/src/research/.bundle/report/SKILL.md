---
name: research:report
trigger: "Use during SYNTHESIZE phase to write the ONE-SHOT research report"
---

# Research:Report -- ONE-SHOT Synthesis

Write the research report in ONE-SHOT. No parallel section-writing (Cognition warning: parallel sections produce disjoint reports). Mirrors `harness:report`.

## When to Use

- After FILTER phase compresses evidence
- Before DECIDE produces the decision record
- This is the synthesis step: all evidence -> one coherent report

## Report Structure

Use template at `research/pipeline/templates/report.md`:

1. **Executive Summary** (1-3 paragraphs, answers the user's original question)
2. **Method** (how research was conducted, phases, tools)
3. **Findings** (evidence-based, each with source reference)
4. **Gap Analysis** (what exists vs what's planned)
5. **Recommendation** (concrete, actionable, evidence-backed)
6. **Risks & Open Items**
7. **Sources** (citation table: every claim traces to a source row)

## Citation Table

Required. Every finding must reference a source row. `research:tdd` checks this.

| # | Source | Type | Date | Verified |
|---|--------|------|------|----------|
| 1 | <source> | <academic|official|industry|blog> | <date> | [x] or [ ] |

## Rules

1. **ONE-SHOT**: write the full report in a single pass. No section-by-section parallel writing.
2. **Citation required**: no claim without a source reference.
3. **UNCORROBORATED preserved**: flagged claims from VERIFY phase carry through.
4. **Evidence policy**: legacy databank not citable; academic/official preferred.
5. **ASCII-only**: no emoji, no non-Latin characters in system artifacts.

## Output

Write `findings/<run-id>/report.md`. When promoted to final: `research/architecture/<DIR>-<TOPIC>-<TYPE>.md`.

## Gate

- Citation table present: PASS
- Every finding has at least 1 source: PASS
- Exit code: 0 (pass) or 1 (fail)
