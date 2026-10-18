---
name: research
description: Run a cited, multi-source investigation with parallel subagents and write one report (and a decision record when the question is a decision). Use for questions that need several independent sources. Not for lookups that one or two searches answer.
---

# Research

Gather in parallel, write alone. Subagents collect evidence into files; you write one report from
those files. Never let several agents write report sections.

Paths below (`reference/`, `templates/`) are relative to this skill's base directory.

## Step 0: always first

1. Run `date +%Y-%m-%d`. Use that date for freshness; never assume the year.
2. Triage. If one or two searches answer the question, answer it directly and stop.
3. Pick a depth (default standard; the user's words "quick" or "thorough" override):

| Depth | Subagents, round 1 | Follow-up rounds | Sources target |
|---|---|---|---|
| quick | 2-3 | 0 | 8+ |
| standard | 3-5 | 1 | 15+ |
| deep | 5-8 | 2 | 25+ |

These are hard budgets. At most 8 subagents run at once.

## Workspace

Keep all state on disk, never only in context:
`<reports directory from the mode prompt>/<YYYY-MM-DD>-<slug>/` with `brief.md`, `findings/F<n>.md`,
`REPORT.md` and, for decisions, `DECISION.md`. Create `findings/` first. On resume, re-read
`brief.md`, list `findings/`, skip finished angles.

## 1. Scope

- Unclear audience, time frame, region or decision at stake: load `research:ask`, one round at most.
  Otherwise write your assumptions into the brief.
- Write `brief.md` from `templates/brief.md`. The brief, not the conversation, is what every later
  step is measured against.
- Split the question into 3-8 independent angles. Lenses: core facts, developments in the last 12
  months, numbers and benchmarks, counter-arguments and failure cases, practitioner experience,
  academic work, alternatives, and what could be wrong with the question itself.
- Deep depth or a contested topic: confirm the angle list with the user before spending budget.

## 2. Gather

Spawn one subagent per angle in a single message:
`{"operation":{"action":"spawn","subagent_type":"general","description":"Research F<n>","prompt":"..."}}`
then `wait` on each `supervisor_id`. Build every prompt from `reference/subagent-prompt.md`,
replacing only its variables. Search sources and the fallback when `websearch` is missing are in
`reference/sources.md`; pass the relevant lines to the subagent. A failed or thin angle is noted
and does not block the others; retry an angle once, not the whole run.

## 3. Review

Load `research:review`. It reads `findings/`, checks coverage against the brief and flags
single-source, conflicting and stale claims. If gaps remain and a follow-up round is left, spawn
narrower subagents with the same template. Otherwise record the gaps for "Open questions".

## 4. Write

Alone, in one pass, following `reference/report.md`. Every `[n]` cites a URL that appears in a
findings file; nothing from memory. The report follows the user's language. If the user asked
whether to adopt, choose or change something, also write `DECISION.md` from `templates/decision.md`.

## 5. Finish

Tell the user the 5-10 most important conclusions and the report path. Do not paste the report.
