---
name: research:plan
description: "Use after scope to create the run manifest: phases, agents, budgets, gates"
trigger: "Use after scope to create the run manifest: phases, agents, budgets, gates"
---

# Research:Plan -- Run Manifest

Create the run manifest: which agents, which phases, what budgets, what gates. Mirrors `harness:plan`.

## When to Use

- After `research:scope` produces the brief
- Before `research:execute` dispatches gather agents

## Run Manifest

Write `findings/<run-id>/manifest.yaml`:

```yaml
run_id: <YYYY-MM-DD>-<topic>-<seq>
intent: <verbatim user question>
brief: findings/<run-id>/brief.md
status: DRAFT
model_roles:
  research: <default or specific model>
  compression: <default>
  synthesis: <default>
  decision: <default>
agents:
  gather: <N sub-agents, one per subtopic from brief>
  verify: evidence-auditor
  filter: general
  synthesize: Architect role
  decide: Architect role
subtopics:
  - "<subtopic 1>"
  - "<subtopic 2>"
budgets:
  SCOPE: 5min / 10K tokens
  GATHER: 15min / 40K tokens
  VERIFY: 5min / 5K tokens
  FILTER: 3min / 5K tokens
  SYNTHESIZE: 10min / 15K tokens
  DECIDE: 5min / 5K tokens
  EVAL: 3min / 3K tokens
gates:
  SCOPE: brief.md exists + user approval
  GATHER: evidence.md exists, N >= coverage threshold
  VERIFY: research-cite.sh exit 0
  FILTER: token budget under cap
  SYNTHESIZE: report.md citation table complete
  DECIDE: decision.md + QUEUE/ADR row
  EVAL: research-score.sh scores recorded
```

## Budget Defaults

Per `../research/conf/phase-budgets.conf` (when available). Override in manifest if needed.

## Gate

Manifest must exist before GATHER starts. `research-gate.sh` checks manifest existence as part of GATHER gate.
