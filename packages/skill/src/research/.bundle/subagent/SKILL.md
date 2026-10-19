---
name: research:subagent
description: "Use to invoke a research sub-agent with the correct contract and context isolation"
trigger: "Use to invoke a research sub-agent with the correct contract and context isolation"
---

# Research:Subagent -- Invocation Contract

Define how research sub-agents are invoked. Ensures context isolation, evidence policy, and output format. Mirrors `harness:subagent`.

## When to Use

- GATHER phase: dispatching gather-researcher sub-agents
- VERIFY phase: dispatching evidence-auditor sub-agents
- Any phase that needs a dedicated agent

## Sub-Agent Types

| Role | subagent_type | Prompt template | Read-only | Purpose |
|------|---------------|-----------------|-----------|---------|
| gather-researcher | general | `researcher-prompt.md` | No (writes its own evidence file) | Source collection + evidence rows |
| evidence-auditor | explore | `research-auditor-prompt.md` | Yes | Citation check + UNCORROBORATED flags |
| filter-revisor | general | `research-revise-prompt.md` | No | Compression + dedup |

The templates live in this skill's directory. Dispatch each role through the `supervisor` tool
with its `subagent_type`; the evidence-auditor returns its audit and the controller writes
`verified-evidence.md`.

## Invocation Contract

Each sub-agent receives:
1. **Task description**: specific question or audit scope
2. **Evidence policy**: academic/official > industry-primary > industry-secondary > blog
3. **Output format**: evidence template (`../research/templates/evidence.md`)
4. **Output path**: `findings/<run-id>/evidence-<subtopic>.md` or `verified-evidence.md`
5. **Budget**: per manifest (time + token cap) -- state it as a CONCRETE number in the dispatch
   prompt itself, not just "per manifest" (the sub-agent never reads the manifest file):
   - **Target 8-10 sources per claim, hard cap 15.** Once you have enough corroborating/
     conflicting evidence to write the claim with a confidence rating, STOP searching --
     exhaustiveness past that point is cost with no evidence-quality gain.
   - **Hard cap ~15 tool calls per sub-agent invocation** (web search + fetch + codebase read
     combined). If the cap is hit before the task is done, write what you have with an explicit
     `INCOMPLETE: hit tool-call cap` note in the evidence file -- do not silently keep going.
   - After the run, verify the declared budget was respected:
     `bash ../research/scripts/research-budget-check.sh <run-id>` (checks output word count
     against `phase-budgets.conf` and each `manifest.yaml` `gather_agents[].budget` entry against
     that agent's own `evidence-<id>.md`). This does not catch tool-call-count overruns directly
     (that's the sub-agent's own discipline per the caps above) -- it catches the output-size
     symptom, use it as a secondary signal, not the primary control.
6. **Isolation**: fresh context per invocation (no cross-contamination)

## Context Isolation

Sub-agents run via the `supervisor` tool. Each invocation gets a fresh context. The sub-agent:
- Receives the task description + evidence policy
- Performs research (web search, codebase lookup, etc.)
- Returns a compact summary (NOT raw tokens)
- Writes evidence to the findings directory

The main pipeline never sees the sub-agent's full context -- only the summary and the evidence file.

## Anti-Patterns

- Sharing state between sub-agents (cross-contamination)
- Sub-agent exceeding its budget without termination
- Sub-agent making decisions (only gathers evidence; decisions are DECIDE phase)
