# Stage Summary Template

Use this template when writing stage summaries in harness:report Step 6.5.
Write one summary per harness skill invoked during the pipeline.

## Template

```markdown
## Stage: <skill-name>

### Trace (mandatory)
- invoked_at: <ISO-8601>
- inputs: <1-line: what the skill received -- spec path, plan path, user request>
- outputs: <1-line: what the skill produced -- file paths, verdict>
- files_modified: <comma-separated paths or "none">
- subagents_spawned: <count>
- tool_calls_estimate: <count>

**Duration:** <estimated time>
- <issue 1: description + resolution>
- <issue 2: description + resolution>
- None (if clean)

### Key Decisions
- <decision 1: what was chosen and why>
- None (if no decisions made)

### Quality Notes
- <any observations about quality, completeness, or concerns>

**Timestamp:** <ISO 8601>
```

## Example

```markdown
## Stage: harness:tdd

**Input:** Plan task T2: "Add retry logic with 3 attempts"
**Output:** 3 test files (retry.test.ts, retry-edge.test.ts, retry-integration.test.ts)
**Duration:** ~4 minutes
**Subagents spawned:** 0

### Issues Encountered
- None

### Key Decisions
- Used in-memory mock for network calls (no real HTTP in tests)
- Added integration test for retry-after-header (not in original plan)

### Quality Notes
- All tests follow RED-GREEN-REFACTOR cycle
- Edge cases covered: timeout, network error, rate limit

**Timestamp:** 2026-07-21T14:30:00-07:00
```

## When to Write

Write stage summaries in harness:report Step 6.5, AFTER the final report is written but BEFORE harness:eval. The summaries provide context for eval scoring.

## File Location

Stage summaries are written to:
```
docs/harness/stages/<pipeline-id>/<skill-name>.md
```

Example:
```
docs/harness/stages/20260721-143022-a7f3/harness-tdd.md
docs/harness/stages/20260721-143022-a7f3/harness-execute.md
docs/harness/stages/20260721-143022-a7f3/harness-verify.md
```
