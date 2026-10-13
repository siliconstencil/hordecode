---
name: product-design
description: Product design exploration — UX research, flow auditing and critique, visual ideation, cloning a live product surface, implementing a selected visual target, design QA, saved design context, and prototype sharing. Use when Product Design is explicitly invoked or the main task is product-design work.
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Product Design

Treat design as a series of small, verifiable steps: understand the user problem, map the flow, choose a visual direction, build, then QA against the original intent.

## Research and auditing

- Audit an existing flow by walking it as a user would: entry, primary action, edge cases, empty states, error states.
- For each issue found, state severity (blocks use / degrades experience / cosmetic) and the user-visible symptom.

## Visual ideation

- When cloning a live product surface, capture the exact spacing, type scale, and interaction details before building.
- Present 2-3 visual directions with trade-offs rather than a single guess.

## Implementation

- Build from a selected visual target; keep the source of truth (screenshot, spec, or saved design context) available for QA.
- Do not mix visual directions mid-build. If a change is needed, re-select the direction first.

## Design QA

- Verify against the original target, not against "looks reasonable".
- Check empty, loading, and error states; these are where design debt hides.
