---
name: harness:brainstorm
description: "Use when requirements or design are ambiguous, before planning or implementation - explores user intent, constraints, and approaches, and settles the design one decision at a time"
---

# Brainstorming Ideas Into Designs

Turn an ambiguous idea into a settled design through focused dialogue: understand the context, resolve one decision at a time, propose approaches, and get the design approved.

Step 0 of the mode prompt sends work here only when requirements or design are ambiguous. Once you are here, do not write code, scaffold, or invoke an implementation skill until the design is settled and, when a user is available, approved. Keep the design proportional: a few sentences for a small change.

## No User Available

Run the same thinking without the dialogue: explore the project context, pose the questions you would ask and answer each from the context, propose 2-3 approaches, pick one with its rationale, and state your assumptions and open questions in your response. Write the spec for multi-step changes unless your instructions say otherwise, then go to `harness:plan`. Do not wait for approval and do not start the visual companion.

## Checklist

Create a task per item with the `task` tool and complete them in order:

1. **Explore project context:** files, docs, recent commits. Do not ask what the repository already answers.
2. **Check scope:** if the request spans independent subsystems, decompose it first into sub-projects, each with its own spec, plan, and implementation cycle; brainstorm the first one.
3. **Clarify:** one question per `harness:ask` call, purpose, constraints, success criteria. Offer likely answers as options; use `options: []` only when answers cannot be enumerated.
4. **Propose 2-3 approaches** with trade-offs, leading with your recommendation and why.
5. **Present the design** in sections scaled to their complexity. After each section, ask through `harness:ask` (header `Design Review`, options `Looks good` / `Needs changes`).
6. **Write the spec** (multi-step features only) to the specs directory in the harness docs directory from the mode prompt, as `YYYY-MM-DD-<topic>-design.md`, and commit it. For small changes, keep the design in the conversation.
7. **Self-review the spec** (below).
8. **User review:** ask through `harness:ask` (header `Spec Review`, question `Spec written to <path>. Ready to plan?`, options `Approved` / `Changes needed`). Apply changes and re-review until approved.
9. **Next step:** `harness:plan`. It is the only skill you invoke after brainstorming.

## Design Content

Cover what affects the change: architecture, components, data flow, error behavior, testing boundaries.

- Break the system into units with one clear purpose and well-defined interfaces, each understandable and testable on its own. For each unit: what does it do, how is it used, what does it depend on?
- In existing codebases, follow established patterns. Include targeted improvements only where existing problems affect this work; no unrelated refactoring.
- YAGNI: remove features nobody asked for.

## Spec Section Anchors

Give every `##` heading in the spec a stable anchor so plan tasks and reviewers can reference it:

```markdown
## [S1] Problem
## [S2] Solution overview
## [S3] Out of scope
```

- IDs are `S` plus a number, unique, numbered in document order when first written.
- IDs are stable: when a heading is reworded, keep its ID and never renumber the others. Plan `Covers:` lines and review verdicts depend on them.

## Spec Self-Review

1. **Placeholders:** no "TBD", "TODO", incomplete sections, or vague requirements.
2. **Consistency:** no contradicting sections; architecture matches the feature description.
3. **Scope:** focused enough for one plan.
4. **Ambiguity:** any requirement readable two ways gets one explicit reading.

Fix issues inline.

For a large or durable spec, also dispatch an independent reviewer with `spec-document-reviewer-prompt.md`.

## Visual Companion (opt-in)

A local browser page for mockups, diagrams, and side-by-side visual options. It needs `node` on PATH, a browser, and a local port, so it is used only when the user opts in.

1. When upcoming questions are genuinely visual (layouts, mockups, diagrams), check for a saved preference: `memory_recall` with `scope: "global"`, query `harness-preference visual-companion`.
2. If none, offer it in its own `harness:ask` call: header `Visual Companion`, question `Some upcoming questions may be clearer as browser mockups. This uses more tokens and needs a local URL.`, options `Yes, this time` / `No, this time` / `Yes, always` / `No, never`.
3. For "always" or "never": `memory_add` with `scope: "global"`, `type: "decision"`, body `harness-preference visual-companion: always` (or `never`). If the write is refused, continue.

Even after acceptance, decide per question: use the browser only when the user would understand it better by seeing it; requirements, trade-offs, and scope questions stay in the terminal. When accepted, read `visual-companion.md` in this skill's directory before starting.
