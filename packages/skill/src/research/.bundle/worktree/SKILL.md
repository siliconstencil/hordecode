---
name: research:worktree
trigger: "Use at the start of a research run to create an isolated workspace"
---

# Research:Worktree -- Isolated Workspace

Create an isolated workspace for the research run. NOT a git worktree -- directory isolation only. Mirrors `harness:worktree` (name kept for parity).

## When to Use

- First step of every research pipeline run (before ASK)
- Each run gets its own findings directory

## Workspace Structure

```
findings/<run-id>/
  brief.md           # SCOPE output
  intent.md          # ASK output (optional)
  manifest.yaml      # PLAN output
  evidence-*.md      # GATHER output (one per subtopic)
  verified-evidence.md  # VERIFY output
  filtered-evidence.md  # FILTER output
  report.md          # SYNTHESIZE output
  decision.md        # DECIDE output
  metrics.md         # EVAL output
  *.gate             # Gate pass/fail records per phase
```

## Run ID

Format: `<YYYY-MM-DD>-<topic-kebab>-<seq>`
Example: `2026-07-31-db-metadata-taxonomy-01`

## Lifecycle

1. Create directory at run start
2. Populate during pipeline phases
3. Final state: all artifacts present, gates passed
4. Promotion: report.md -> `research/architecture/<DIR>-<TOPIC>-<TYPE>.md`
5. Archive: findings/<run-id>/ retained for audit trail (append-only)

## Anti-Patterns

- Using a single findings directory for multiple runs
- Deleting findings after promotion (append-only: never delete)
- Sharing findings directory between runs
