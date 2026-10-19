---
name: harness:eval
description: Use after completing a harness pipeline run to evaluate skill quality, detect failure patterns, and recommend improvements - measures HOW WELL harness skills worked, not just whether they worked
---

# Harness Pipeline Eval

## Overview

Measure harness skill quality after every pipeline run. Store results. Detect patterns. Recommend improvements.

**Core principle:** What gets measured gets improved.

**Violating the letter of this process is violating the spirit of evaluation.**

## The Iron Law

```
NO SKILL MODIFICATION WITHOUT EVAL DATA
```

If you haven't measured pipeline quality, you cannot recommend skill changes. "I think this could be better" is not evidence.

## When to Use

**Mandatory:**
- After ANY harness pipeline completes (brainstorm -> plan -> tdd -> execute -> verify -> review -> report)
- Before modifying any harness SKILL.md (baseline first)

**Optional but valuable:**
- After a single harness skill produces poor results
- When the user asks "how is harness working?"
- Periodically to detect slow quality drift

**Don't skip when:**
- Pipeline went well (good results need measurement too -- baseline for regression)
- In a hurry (measurement takes 2 minutes, regressions take hours)
- "There's nothing to evaluate" (absence of failure is data too)

## The Eval Process

You MUST complete each step in order.

### Step 1: Read Pipeline History

**Evidence priority:** Stage summaries under `docs/harness/stages/<pipeline-id>/`
are the PRIMARY evidence source. Read them first. Conversation history (last 50 messages)
is the FALLBACK for stages without summaries and for cross-stage interaction analysis.

Read the conversation history from the current session. Identify every harness skill invocation:

**Limit:** Read at most the last 50 messages. Older messages are unlikely to contain relevant pipeline data and waste tokens.

```
For each harness skill found:
- skill name (e.g. harness:brainstorm)
- what it produced (design doc, plan, tests, etc.)
- how long it took (estimate)
- how many subagents it spawned
- any issues encountered
```

### Step 2: Read Historical Baseline

Read `docs/harness/eval/SUMMARY.md` to check existing patterns:

- If a failure_type appeared 3+ times: flag as **PATTERN**, prioritize fix
- If a stage score dropped >0.1 from last run: flag as **REGRESSION**
- If a stage score improved >0.1: flag as **IMPROVEMENT**, note what changed

### Step 2.5: Recurring Failure Detection

Scan SUMMARY.md for failure types that appear 3+ times across different runs:
- **3+ occurrences**: This is a systemic issue. Apply -0.1 penalty to the affected stage score.
- **5+ occurrences**: This is a critical pattern. Apply -0.15 penalty AND flag for immediate skill modification.
- **Same failure in consecutive runs**: The previous fix didn't work. Escalate severity by one level.

Record the recurring pattern in the eval JSON under `recurring_failures`:
```json
{
  "recurring_failures": [
    {
      "failure_type": "retry_loop",
      "occurrence_count": 4,
      "consecutive": true,
      "penalty_applied": -0.15
    }
  ]
}
```

### Step 3: Score Each Stage Independently

For EACH harness skill invoked in this pipeline (from Step 1):

1. **Locate the stage summary** at `docs/harness/stages/<pipeline-id>/<skill-name>.md`
   (written by harness:report step 6.5). If missing, fall back to conversation evidence.
2. **Run keyword scoring:** `<harness:eval>/scripts/score-helper.sh <stage> <stage-summary-file>`
   to get keyword-based initial scores. The script also outputs estimated_tokens and budget_status.
3. **Apply metrics** from `<harness:eval>/scoring-metrics.md`. Score each metric 0.0-1.0
   using the script output as a starting point. Adjust based on actual quality assessment.
4. **Assign per-stage verdict:**
   - avg >= 0.7 => PASS
   - 0.4 <= avg < 0.7 => WARN
   - avg < 0.4 => FAIL
5. **Record** in eval JSON under `stage_verdicts`:
   `{ "stage": "<name>", "scores": {...}, "verdict": "PASS|WARN|FAIL", "evidence": "path/to/summary" }`

**Verdict caps:**
- A stage with verdict FAIL caps the pipeline verdict at WARN regardless of other stages.
- Two or more FAIL stages => pipeline verdict FAIL.

**Cost circuit breaker:** A stage with budget_status OVERRUN(2x) caps its verdict at WARN
and produces a `cost_overrun` failure record. Two OVERRUN stages in one pipeline =>
pipeline verdict WARN minimum, with a recommendation to split the task.

### Step 4: Detect Failures

Classify any issues found. See `<harness:eval>/failure-patterns.md` for the full taxonomy.

```
failure_type: skill_gap | wrong_tool | retry_loop | context_loss | scope_creep
severity: critical | major | minor
description: what went wrong
root_cause: why it went wrong
suggestion: how to fix the skill
```

### Step 5: Write Results

Write two files:

**1. JSON trace** (machine-readable):
```
File: docs/harness/eval/<YYYYMMDD>-<HHMMSS>-<random4>.json
```
Format: date-time + 4 random hex chars (e.g. `20260721-143022-a7f3.json`). This prevents collision when multiple evals run in the same second.

Use the template at `<harness:eval>/eval-template.md`.

**2. Summary** (human-readable, append-only):
```
File: docs/harness/eval/SUMMARY.md
```

Append a new section. NEVER overwrite existing entries.

### Step 6: Recommend Improvements

For each failure or pattern, produce a concrete recommendation:

```
RECOMMENDATION for harness:<skill>:
- Problem: <what's failing>
- Evidence: <eval data showing the failure>
- Suggested fix: <specific change to SKILL.md>
- Expected impact: <what should improve>
```

**Rule:** Never recommend a skill change without eval evidence.

**Closure rule:** A recommendation tied to a recurring failure (3+) is not advisory --
harness:report is obligated to apply it before merge or escalate. See harness:report step 9.

## Anti-Patterns

1. **Eval-skip because "it went well"** -- good results need measurement (baseline for regression detection)
2. **Eval-and-fix in same turn** -- eval first, record, then fix in a separate action
3. **Overwriting old eval records** -- append only, like MEMORY.md
4. **Claiming "harness is working well" without data** -- show the scores
5. **Scoring without reading history** -- you MUST read the conversation to score accurately
6. **Vague recommendations** -- "improve error handling" is useless; "add timeout to forkQuery call in tool/session.ts" is actionable

## Example Pipeline Eval

See `<harness:eval>/example-output.md` for a complete worked example.

## Integration with Harness Pipeline

This skill is designed to be called AFTER a harness pipeline completes. It does NOT replace harness:verify or harness:review -- those are per-task checks. This is system-level quality measurement.

**Relationship:**
- harness:verify = "did THIS task pass verification?" (per-task)
- harness:review = "is THIS code change good?" (per-task)
- harness:eval = "how well did the PIPELINE work?" (system-level)

## Integration with Reflexion (M4)

When M4 Reflexion is implemented:
- Eval failure patterns feed into the reflexion loop
- Skill improvements are tracked with before/after scores
- Dream/Distill consolidation of high-scoring pipeline patterns

## Integration with Memory Lifecycle

When Memory Lifecycle Rules are implemented:
- Eval results older than 90 days: archive to Aurelius
- Patterns resolved 3+ times: promote to project knowledge
- Recurring failures: escalate to user for manual review
