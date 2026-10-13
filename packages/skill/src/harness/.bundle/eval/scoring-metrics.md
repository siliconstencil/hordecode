# Harness Eval -- Scoring Metrics Reference

Detailed metrics for each harness pipeline stage. Score each 0.0-1.0.

## harness:brainstorm

| Metric | Description | How to Score |
|--------|-------------|-------------|
| requirement_coverage | % of user requirements captured in design | Count user requirements mentioned in output / total requirements expressed |
| ambiguity_count | Unresolved questions left in design | 0 = perfect, 1-2 = acceptable, 3+ = poor |
| scope_clarity | Scope boundaries clearly defined | 1.0 if in/out scope explicit, 0.5 if vague, 0.0 if missing |
| stakeholder_identification | All affected parties identified | 1.0 if all affected files/modules noted, 0.5 if partial, 0.0 if missing |
| approach_quality | Proposed approaches have clear trade-offs | 1.0 if 2-3 approaches with pros/cons, 0.5 if only 1, 0.0 if none |
| user_approval | Did user approve the design? | 1.0 if approved, 0.5 if revised then approved, 0.0 if rejected |

## harness:plan

| Metric | Description | How to Score |
|--------|-------------|-------------|
| task_completeness | All requirements have corresponding tasks | Count requirements with tasks / total requirements |
| dependency_accuracy | Dependency graph is valid and complete | 1.0 if no missing/false deps, 0.5 if minor gaps, 0.0 if critical deps missing |
| estimate_accuracy | Estimated vs actual effort ratio | 1.0 if within 30%, 0.5 if within 100%, 0.0 if >2x off |
| risk_identification | Known risks documented | 1.0 if risks + mitigations, 0.5 if risks listed but no mitigations, 0.0 if none |
| task_granularity | Tasks are right-sized (not too big, not too small) | 1.0 if most tasks 1-4 hours, 0.5 if some >8 hours, 0.0 if most >8 hours |
| verification_defined | Each task has clear verification criteria | 1.0 if every task has verification, 0.5 if partial, 0.0 if none |

## harness:tdd

| Metric | Description | How to Score |
|--------|-------------|-------------|
| test_first_compliance | Code written before test = FAIL | 1.0 = always test-first, 0.0 = any code-before-test |
| test_coverage | Lines/branches covered by tests | Run coverage tool; 1.0 if >90%, 0.8 if >80%, 0.6 if >60%, <0.6 = poor |
| red_green_refactor | Proper cycle followed | 1.0 if RED-GREEN-REFACTOR visible in commit history, 0.5 if partial, 0.0 if not followed |
| assertion_quality | Assertions test behavior, not implementation | 1.0 if assertions test outcomes, 0.5 if some test internals, 0.0 if mostly mock assertions |
| edge_case_coverage | Edge cases have tests | 1.0 if boundary/error/null cases tested, 0.5 if some, 0.0 if none |
| test_isolation | Tests don't depend on each other | 1.0 if tests run independently, 0.5 if some order-dependent, 0.0 if all coupled |

## harness:execute

| Metric | Description | How to Score |
|--------|-------------|-------------|
| subagent_success_rate | % of subagents completing successfully | completed / total spawned |
| parallel_efficiency | Actual vs theoretical speedup | 1.0 if 80%+ of theoretical, 0.5 if 50%+, 0.0 if sequential |
| context_preservation | Subagent results correctly integrated | 1.0 if all results used correctly, 0.5 if some lost, 0.0 if major gaps |
| scope_adherence | Work stayed within task boundaries | 1.0 if no scope creep, 0.5 if minor, 0.0 if major drift |
| error_handling | Failures handled gracefully | 1.0 if all failures caught and retried, 0.5 if some silent failures, 0.0 if crashes |

## harness:verify

| Metric | Description | How to Score |
|--------|-------------|-------------|
| evidence_freshness | Verification used latest code state | 1.0 if verified after last edit, 0.0 if stale |
| gate_pass_rate | % of verifications passing on first attempt | passes / total attempts |
| false_positive_rate | Claims success when actually failing | 1.0 if 0%, 0.5 if 1-2%, 0.0 if >2% |
| regression_detection | Caught regressions before merge | 1.0 if all regressions caught, 0.5 if some missed, 0.0 if none caught |
| completeness | All verification steps executed | 1.0 if IDENTIFY->RUN->READ->VERIFY->CLAIM all done, 0.5 if skipped steps |

## harness:review

| Metric | Description | How to Score |
|--------|-------------|-------------|
| issue_detection_rate | Found real issues (Critical + Important) | issues_found / issues_existed (estimated) |
| false_alarm_rate | Flagged non-issues as problems | false_positives / total_issues_flagged |
| actionable_feedback | % of issues with clear fix guidance | issues_with_fix / total_issues |
| review_coverage | % of changed code reviewed | files_reviewed / files_changed |
| severity_accuracy | Issues categorized at correct severity | 1.0 if all correct, 0.5 if 1-2 misclassified, 0.0 if most wrong |

## harness:report

| Metric | Description | How to Score |
|--------|-------------|-------------|
| accuracy | Report matches actual implementation | 1.0 if 100% accurate, 0.5 if minor inaccuracies, 0.0 if major errors |
| completeness | All changes documented | 1.0 if all changes covered, 0.5 if some missing, 0.0 if major omissions |
| clarity | Report is understandable without code | 1.0 if clear to non-author, 0.5 if needs code context, 0.0 if confusing |

## harness:merge

| Metric | Description | How to Score |
|--------|-------------|-------------|
| conflict_resolution | Merge conflicts handled correctly | 1.0 if all resolved correctly, 0.5 if needed manual intervention, 0.0 if wrong resolution |
| post_merge_tests | All tests pass after merge | 1.0 if all pass, 0.0 if any fail |
| rollback_rate | % of merges requiring rollback | 1.0 if 0%, 0.5 if 1-2%, 0.0 if >2% |
| commit_quality | Commit messages accurate and atomic | 1.0 if clear + atomic, 0.5 if clear but big, 0.0 if unclear |

## Overall Pipeline Score

Weighted average across stages:

| Stage | Weight |
|-------|--------|
| brainstorm | 0.12 |
| plan | 0.13 |
| tdd | 0.20 |
| execute | 0.15 |
| verify | 0.20 |
| review | 0.10 |
| report | 0.05 |
| merge | 0.05 |

**Pass threshold:** overall >= 0.7 AND zero critical failures
**Warning threshold:** overall 0.5-0.7 OR 1-2 major failures
**Fail threshold:** overall < 0.5 OR any critical failure
