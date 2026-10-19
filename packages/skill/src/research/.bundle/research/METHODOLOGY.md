# Research Methodology Standard

> Production-line research model: each phase is the input of the next, and the last phase
> validates the result before anything is implemented.

This standard covers multi-report research series. A single pipeline run (ask -> scope ->
gather -> verify -> filter -> synthesize -> decide -> eval) produces one report; a series of
such reports on one topic follows the six phases below.

---

## 1. Directory Structure

```
research/<topic>/
  <TOPIC>-DETAILED-REPORT.md         # Phase 1: current state (codebase first)
  <TOPIC>-INDUSTRY-EQUIVALENTS.md    # Phase 2: the sector (web research)
  <TOPIC>-DEEP-DIVE.md               # Phase 3: improvement (targeted research)
  <TOPIC>-CONCLUSION.md              # Phase 4: expert report (synthesis + recommendation + cost-benefit)
  <TOPIC>-VALIDATION.md              # Phase 5: validation (prototype, test, measurement)
  <TOPIC>-COMPARISON.md              # Phase 6: A vs B (optional, decision support)
```

One directory, one research topic. Each phase is the input of the next.

**Production-line flow**:
```
Phase 1 (problem definition)
  -> Phase 2 (context gathering)
    -> Phase 3 (solution research)
      -> Phase 4 (expert report + decision)
        -> Phase 5 (prototype + validation)
          -> Phase 6 (comparison, if needed)
            -> IMPLEMENTATION (back to the codebase)
```

---

## 2. Report Sequence (6 phases)

| Phase | Report type | Question | Source type | Min sources |
|-------|-------------|----------|-------------|-------------|
| 1 | DETAILED-REPORT | What exists now? | Codebase analysis | 0 (codebase) |
| 2 | INDUSTRY-EQUIVALENTS | What is the sector doing? | Web research | 15+ |
| 3 | DEEP-DIVE | How can it be improved? | Targeted research | 5-10 |
| 4 | CONCLUSION | What should we do now? | Synthesis | N/A |
| 5 | VALIDATION | Does it work? | Prototype + test | N/A |
| 6 | COMPARISON | A or B? (optional) | Comparison | 5+ |

Each phase is the **mandatory input** of the next. Phase 5 does not start without Phase 4, and
implementation does not start without Phase 5.

Mechanical check: `bash scripts/research-gate.sh --check-methodology research/<topic> [--final]`
(path relative to this skill's base directory, run from the project root). It requires Phases 1,
2, 4 and 5 (Phase 2 can be exempted with `--allow-missing-industry-equivalents`). A DRAFT series
with missing phases only warns; FINAL promotion through `scripts/research-index.sh` is blocked.

---

## 3. Report Templates

### 3.1 DETAILED-REPORT (Phase 1)

```markdown
# <Topic> -- Detailed Report

## Executive Summary
- 3-5 bullet points

## 1. Current State
## 2. Architecture / Mechanism
## 3. Configuration
## 4. Limitations
## 5. Recommendations

## Sources
| # | Source | Type | Confidence |
```

### 3.2 INDUSTRY-EQUIVALENTS (Phase 2)

```markdown
# <Topic> -- Industry Equivalents

## Executive Summary
- 3-5 bullet points

## 1. Academic Research
## 2. Industry Implementations
## 3. Open Source Projects
## 4. Comparison Matrix
## 5. Lessons for This Project

## Sources
| # | Author/Company | Year | Type | Confidence |
```

### 3.3 DEEP-DIVE (Phase 3)

```markdown
# <Topic> -- Deep Dive: <Specific Improvement>

## Executive Summary
- 3-5 bullet points

## 1. Problem Statement
## 2. Current Approach
## 3. Proposed Improvement
## 4. Implementation Design
## 5. Risk/Reward Analysis

## Sources
| # | Source | Type | Confidence |
```

### 3.4 CONCLUSION (Phase 4, MANDATORY)

**Purpose**: the **expert report** written after all research findings. It synthesizes the
Phase 1-3 findings and answers "what should we do now?". It is actionable text for the decision
maker. It is also a **critical assessment**: gap detection, over-engineering risk, and whether
the work is on the wrong path.

**Rule**: the expert report **must be deterministic and rational**, but that alone is **not
enough**. Every decision must rest on **realistic, concrete findings**. "Looks reasonable" is
not enough; it must be "measured, proven, tested". If assumptions were not tested, say so. If
sources are missing, state it. If there is no real-world data, say "this is a lab result".

**Cost-benefit rule**: mandatory for every recommendation:
1. **Contribution**: what does it gain? (measured: X% reduction, +Y pp, Z times faster)
2. **Cost**: what does it cost? (code, maintenance, latency, added spend)
3. **Net benefit**: is the cost worth the gain? If not, do not do it.
4. **Alternative**: is there a simpler, cheaper, less risky solution?

"I recommend" is not enough; show why it is worth its cost. A recommendation without sources,
measurement or cost-benefit analysis is over-engineering and unnecessary.

```markdown
# <Topic> -- Conclusion

## Executive Summary
- 3-5 bullet points

## 1. Research Purpose
## 2. What We Have (reports, sources, findings)
## 3. What We Can Do (short/medium/long term)
## 4. Sector Position
## 5. Gains (measurable)
## 6. Pros/Cons (6+ each)
## 7. Use Cases
## 8. Gap Analysis
## 9. Over-Engineering Risk
## 10. Critical Assessment
## 11. Negative Ontology
## 12. Cost-Benefit Analysis
## 13. Empirical Grounding
## 14. Final Assessment
```

### 3.5 VALIDATION (Phase 5, MANDATORY)

**Purpose**: verify that the Phase 4 recommendations **actually work**: prototype, test,
measure. It answers "does it work?". Research is speculation; validation is evidence.

**Rule**: Phase 5 does not start without Phase 4, and implementation does not start without
Phase 5. An unvalidated recommendation is an assumption, not research.

**Single contract**: the mandatory output of Phase 5 is **validation evidence that carries
measurements** (test results, pass/fail, duration or cost metrics), not a plan. A VALIDATION
report is valid only if it contains measurements; validation without measurement is a plan and
does not count as Phase 5. The research gate's `validation` phase checks this on
`findings/<run-id>/validation.evidence`.

```markdown
# <Topic> -- Validation

## Executive Summary
- 3-5 bullet points (worked / did not work, what we learned)

## 1. Recommendation Tested
- Which recommendation did we test?
- How did we test it?

## 2. Test Method
- Prototype: what did we write, how many lines, how long did it take?
- Test scenarios: which cases did we test?
- Metrics: what was measured? (pass@k, duration, cost, error rate)

## 3. Results
- Before (baseline)
- After (test result)
- Difference (measured: X% reduction, +Y pp)

## 4. What We Learned
- What worked?
- What did not work?
- What differed from expectations?

## 5. Quality Control
- Side effects?
- Reversible?
- Will it work in production?

## 6. Decision
- ADOPT (yes, it works)
- DEFER (more testing needed)
- REJECT (does not work, other direction)
```

### 3.6 COMPARISON (Phase 6, OPTIONAL)

**Purpose**: compare two different solutions to support a decision. Written when needed.

```markdown
# <Topic> -- <Pattern A> vs <Pattern B>

## Executive Summary
- 3-5 bullet points

## 1. Mechanical Differences
## 2. Impact on Work Outcomes
## 3. Cost Analysis
## 4. When to Use Which
## 5. Combined Strategy

## Sources
| # | Source | Type | Confidence |
```

---

## 4. Quality Gates

| Gate | Requirement | Enforcement |
|------|-------------|-------------|
| Sources | min 5 per report (Phase 1 exempt) | Check before FINAL |
| Confidence | every claim has a source or an UNCORROBORATED flag | Check before FINAL |
| Freshness | web sources 2026 Q2/Q3 preferred | Flag STALE if older |
| No fabrication | if a source is not found, say so | Never approximate |
| Status | DRAFT -> FINAL after user approval | INDEX.md update |

---

## 5. Workflow

1. Check `INDEX.md` to avoid duplicates
2. Create the directory: `research/<topic>/`
3. Write the reports in sequence (1 -> 2 -> 3 -> 4 -> 5 -> [6])
4. Add entries to `INDEX.md` with status `DRAFT` (`scripts/research-index.sh`)
5. After user approval, update the status to `FINAL`

---

## 6. Naming Convention

- Directory: `research/<topic>/` (lowercase, hyphen-separated)
- Reports: `<TOPIC>-<TYPE>.md` (uppercase, hyphen-separated)
- Types: `DETAILED-REPORT`, `INDUSTRY-EQUIVALENTS`, `DEEP-DIVE`, `CONCLUSION`, `VALIDATION`,
  `COMPARISON` (legacy: `COMPREHENSIVE-ANALYSIS` is the old name of Phase 4 and is still
  recognized; new reports use `CONCLUSION`)

---

## 7. INDEX.md Entry Format

```markdown
| `<topic>/<TOPIC>-<TYPE>.md` | Aug 11 | DRAFT | **<1-line summary>**: <key sections> |
```
