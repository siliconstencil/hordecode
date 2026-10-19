# Harness Eval -- Output Template

Use this template when writing eval results.

## JSON Trace

Write to `docs/harness/eval/<YYYY-MM-DD>-<pipeline-id>.json`:

```json
{
  "date": "2026-07-20",
  "pipeline_id": "EVAL-001",
  "project": "<project name>",
  "session_id": "<session id if available>",
  "stages": [
    {
      "stage": "harness:brainstorm",
      "status": "success",
      "started_at": "<timestamp>",
      "completed_at": "<timestamp>",
      "subagents": 0,
      "key_output": "Design doc for auth system with 3 approaches",
      "scores": {
        "requirement_coverage": 0.9,
        "ambiguity_count": 1,
        "scope_clarity": 1.0,
        "stakeholder_identification": 0.8,
        "approach_quality": 0.9,
        "user_approval": 1.0
      },
      "issues": []
    },
    {
      "stage": "harness:plan",
      "status": "success",
      "started_at": "<timestamp>",
      "completed_at": "<timestamp>",
      "subagents": 0,
      "key_output": "8-task implementation plan with dependencies",
      "scores": {
        "task_completeness": 1.0,
        "dependency_accuracy": 1.0,
        "estimate_accuracy": 0.8,
        "risk_identification": 0.7,
        "task_granularity": 0.9,
        "verification_defined": 1.0
      },
      "issues": []
    }
  ],
  "stage_verdicts": [
    {
      "stage": "brainstorm",
      "scores": { "completeness": 0.85, "user_alignment": 0.80 },
      "verdict": "PASS",
      "evidence": "docs/harness/stages/<pipeline-id>/brainstorm.md"
    }
  ],
  "token_usage": [
    {
      "stage": "execute",
      "estimated_tokens": 31000,
      "budget": 25000,
      "budget_status": "OVER"
    }
  ],
  "overall_score": 0.85,
  "pass": true,
  "failures": [],
  "patterns_detected": [],
  "recommendations": []
}
```

## Summary Entry

Append to `docs/harness/eval/SUMMARY.md`:

```markdown
## <YYYY-MM-DD> Pipeline <pipeline-id>
- **Overall:** <score>/1.0 -- PASS | WARN | FAIL
- **Strongest:** <stage> (<score>)
- **Weakest:** <stage> (<score>) -- <reason>
- **Failures:** <N> critical, <N> major, <N> minor
- **Patterns:** <detected patterns or "none">
- **Recommendations:** <N> skill improvement suggestions
- **Regression:** <stage> dropped <X> from last run (if applicable)
- **Improvement:** <stage> improved <X> from last run (if applicable)
```

## Failure Record

If failures found, append to the JSON trace:

```json
"failures": [
  {
    "failure_type": "scope_creep",
    "severity": "major",
    "stage": "harness:execute",
    "description": "Subagent added unrequested error handling to 3 files",
    "root_cause": "harness:execute scope instructions too vague",
    "suggestion": "Add explicit 'only modify files listed in task' rule to harness:execute",
    "first_seen": "2026-07-20",
    "occurrence_count": 1
  }
]
```
