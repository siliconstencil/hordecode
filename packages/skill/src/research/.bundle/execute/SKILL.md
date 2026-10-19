---
name: research:execute
trigger: "Use during the GATHER phase to dispatch parallel research sub-agents on subtopics"
---

# Research:Execute -- Parallel Evidence Collection

Dispatch parallel research sub-agents, each in isolated context, on subtopics from the brief. Mirrors `harness:execute`.

## When to Use

- GATHER phase, after brief is approved and manifest is created
- Each subtopic from the brief gets its own sub-agent invocation

## Sub-Agent Contract

Each gather sub-agent receives:
1. **Subtopic**: the specific question from the brief
2. **Evidence template**: `../research/templates/evidence.md`
3. **Evidence policy**: academic/official > industry-primary > industry-secondary > blog
4. **Output path**: `findings/<run-id>/evidence-<subtopic>.md`
5. **Budget**: per manifest (default 15min / 40K tokens total across all sub-agents)

## Isolation Mechanism

Each sub-agent runs via `task` tool with `subagent_type: explore` or `general`. This gives:
- Fresh context (no cross-contamination between subtopics)
- Read-only for explorer agents (source collection)
- Summaries returned (not raw tokens), preserving context budget

## Parallelism

- Max 5 concurrent sub-agents (avoid overwhelming the system)
- Sub-agent failure is isolated: one failing sub-agent does NOT abort siblings
- If a sub-agent exceeds its budget, terminate and flag in evidence

## Output

Each sub-agent writes `evidence-<subtopic>.md` in the run's findings directory using the evidence template.

## Quality Gate

Before moving to VERIFY:
- [ ] At least 1 evidence file per subtopic
- [ ] Each evidence file has at least 1 source
- [ ] Total evidence files = total subtopics from brief

Mechanical gate (run it; the checks above are not self-enforcing): write
`findings/<run-id>/gather.evidence` from `../research/templates/evidence.md` and consolidate the sources and claims of every `evidence-<subtopic>.md` and fill the Tooling Preamble section.
Delete or mark `na` the conditional slots you do not use. Then, from the project root (the gate
reads `findings/` relative to the working directory), run the gate script, resolving its path
against this skill's base directory:

```bash
bash ../research/scripts/research-gate.sh <run-id> gather
```

Non-zero exit means this phase did not earn its evidence: STOP, fix the evidence file and re-run
the gate. Do not start the next phase until it exits 0.
