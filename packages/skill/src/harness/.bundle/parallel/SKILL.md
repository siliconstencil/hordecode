---
name: harness:parallel
description: Use when facing 2 or more independent problems (failures, investigations, tasks) that can be worked on without shared state or sequential dependencies
---

# Dispatching Parallel Agents

**Core principle:** one subagent per independent problem domain, running concurrently. Each gets exactly the context it needs, never your session history.

## When

Use when problems are independent: different test files with different root causes, separate subsystems, investigations that need no context from each other.

Don't use when failures may be related (fixing one may fix others), when understanding needs the whole system, when you don't yet know what is broken, or when agents would edit the same files or share resources.

## Dispatch

Spawn all subagents in the same turn with the `supervisor` tool, then wait on each:

```
{"operation":{"action":"spawn","subagent_type":"general","description":"Fix abort tests","prompt":"<focused prompt>"}}
{"operation":{"action":"wait","supervisor_id":"<id from spawn>"}}
```

By default at most 8 subagents run at once per session tree (setting `supervisor.max_subagents`); a spawn over the limit is refused, so wait for one to finish before dispatching more. Pass a `task_id` when the work belongs to a tracked task.

**Isolation:** give parallel implementers disjoint file sets in the same checkout, or a separate worktree each (`harness:worktree`). Keep commits with the orchestrator: subagents edit and report, you review the diffs and commit.

## The Prompt

Each prompt is:
1. **Focused:** one problem domain, one file or subsystem.
2. **Self-contained:** paths, error messages, test names, the worktree path, acceptance criteria, and the verification to run.
3. **Constrained:** what not to touch ("do not change production code", "only files under src/abort/").
4. **Specific about output:** "Return the root cause and the files you changed."

Example: "Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts: <names and messages>. Find the real cause; do not just increase timeouts. Only edit files under src/agents/. Return the root cause and changes."

## Integrate

1. Read each report; treat it as a claim and inspect the diff.
2. Check for conflicts between agents' changes.
3. Run the full relevant suite (`harness:verify`).
4. Spot-check: parallel agents can make the same systematic error.
