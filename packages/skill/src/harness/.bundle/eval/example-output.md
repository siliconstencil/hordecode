# Harness Eval -- Example Output

Worked example of a complete pipeline eval.

## Pipeline Context

User asked to implement a session search feature for Hordecode TUI. Pipeline ran:
1. harness:brainstorm (requirements gathering)
2. harness:plan (8-task implementation plan)
3. harness:execute (3 subagents in parallel)
4. harness:verify (typecheck + tests)
5. harness:review (code review)

## Step 1: Pipeline History

| Stage | Status | Duration | Subagents | Key Output |
|-------|--------|----------|-----------|------------|
| brainstorm | success | 3 min | 0 | Design doc: session search with FTS5 backend |
| plan | success | 2 min | 0 | 8-task plan, critical path identified |
| execute | partial | 8 min | 3 | 6/8 tasks complete, 2 need rework |
| verify | success | 1 min | 0 | typecheck 0 errors, 12/12 tests pass |
| review | success | 2 min | 1 | 0 Critical, 2 Important, 3 Minor |
| report | skipped | 0 | 0 | N/A |
| merge | skipped | 0 | 0 | N/A |

## Step 2: Historical Baseline

First eval for this project -- no historical baseline. This is EVAL-001.

## Step 3: Stage Scores

### harness:brainstorm (0.87)
- requirement_coverage: 0.9 (all 5 requirements captured)
- ambiguity_count: 1 (unresolved: search scope for tool output)
- scope_clarity: 1.0 (in/out scope explicit)
- stakeholder_identification: 0.8 (missed TUI scroll integration)
- approach_quality: 0.9 (3 approaches with trade-offs)
- user_approval: 1.0 (approved on first presentation)

### harness:plan (0.91)
- task_completeness: 1.0 (all requirements have tasks)
- dependency_accuracy: 1.0 (correct dependency graph)
- estimate_accuracy: 0.8 (actual: 13 min, estimated: 10 min)
- risk_identroduction: 0.7 (listed FTS performance risk, missed keybinding conflict)
- task_granularity: 1.0 (all tasks 1-3 hours)
- verification_defined: 1.0 (every task has verification)

### harness:execute (0.68)
- subagent_success_rate: 0.67 (2/3 completed, 1 failed)
- parallel_efficiency: 0.7 (2 of 3 ran parallel, 1 blocked on deps)
- context_preservation: 0.8 (2/3 results integrated, 1 partial)
- scope_adherence: 0.6 (subagent 2 modified 2 extra files)
- error_handling: 0.7 (1 failure caught and retried)

### harness:verify (0.95)
- evidence_freshness: 1.0 (verified after last edit)
- gate_pass_rate: 1.0 (passed on first attempt)
- false_positive_rate: 1.0 (no false claims)
- regression_detection: 0.8 (caught type error, missed 1 unused import)
- completeness: 1.0 (all steps executed)

### harness:review (0.82)
- issue_detection_rate: 0.8 (found 2/3 Important issues)
- false_alarm_rate: 1.0 (no false alarms)
- actionable_feedback: 1.0 (all issues have fix guidance)
- review_coverage: 0.9 (10/11 changed files reviewed)
- severity_accuracy: 0.8 (1 issue misclassified as Important, should be Minor)

## Step 4: Failures

```
failure_type: scope_creep
severity: major
stage: harness:execute
description: Subagent 2 modified src/util/error.ts and src/config.ts (not in task scope)
root_cause: harness:execute scope instructions say "implement the task" without listing allowed files
suggestion: Add explicit file list to each task, and "only modify listed files" rule to harness:execute
first_seen: 2026-07-20
occurrence_count: 1
```

## Step 5: Write Results

### JSON trace: `docs/harness/eval/2026-07-20-EVAL-001.json`

(See eval-template.md for full structure)

### Summary: `docs/harness/eval/SUMMARY.md`

```markdown
## 2026-07-20 Pipeline EVAL-001
- **Overall:** 0.85/1.0 -- PASS
- **Strongest:** harness:verify (0.95)
- **Weakest:** harness:execute (0.68) -- scope creep in subagent 2
- **Failures:** 0 critical, 1 major, 0 minor
- **Patterns:** none (first eval)
- **Recommendations:** 1 (add file scope rules to harness:execute)
- **Regression:** N/A (first eval)
- **Improvement:** N/A (first eval)
```

## Step 6: Recommendations

```
RECOMMENDATION for harness:execute:
- Problem: Subagent modified files outside task scope
- Evidence: EVAL-001, subagent 2 modified error.ts and config.ts (not in task)
- Suggested fix: Add to harness:execute SKILL.md:
  "Each task MUST list allowed files. Subagents may ONLY modify listed files.
   If a subagent needs to modify an unlisted file, it must STOP and request scope expansion."
- Expected impact: scope_adherence score 0.6 -> 0.9+
```

## Overall Score Calculation

```
brainstorm:  0.87 * 0.12 = 0.104
plan:        0.91 * 0.13 = 0.118
tdd:         skipped     = 0.000 (not in this pipeline)
execute:     0.68 * 0.15 = 0.102
verify:      0.95 * 0.20 = 0.190
review:      0.82 * 0.10 = 0.082
report:      skipped     = 0.000
merge:       skipped     = 0.000

Adjusted weights (exclude skipped):
total weight = 0.12 + 0.13 + 0.15 + 0.20 + 0.10 = 0.70
overall = (0.104 + 0.118 + 0.102 + 0.190 + 0.082) / 0.70 = 0.851

Result: 0.85 -- PASS (>= 0.7, zero critical failures)
```
