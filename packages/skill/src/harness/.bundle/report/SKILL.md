---
name: harness:report
description: "Use after implementation is verified and reviewed, before merge - consolidates spec and plan iterations into a single final-state report, marks related specs and plans, and records key lessons"
---

# Writing Final Reports

## Overview

Consolidate a feature's spec history into one human-readable final report. It presents the implemented state: what WAS BUILT, not what was tried. A short Journey Log at the end keeps notable dead ends and pivots for future work.

**Core principle:** final state first. A reader understands the feature from this report alone.

**Announce at start:** "I'm using the harness:report skill to write the final report for this feature."

**Save reports to:** the reports directory in the harness docs directory from the mode prompt, as `<feature-name>.md`. No date in the filename: the report is overwritten in place when the feature evolves, and git tracks revisions. A user-specified location overrides this.

## Update Semantics

Specs and plans accumulate (a new file per iteration); the report is overwritten in place:
- If a report exists for this feature, read it first, then overwrite it with updated content.
- Keep earlier Journey Log entries and append this iteration's.
- Add any new specs and plans to the frontmatter lists.

**Skip** when the user asks to, or for a trivially small change (single fix, typo, config tweak).

## Checklist

1. **Find related specs and plans** in the specs and plans directories.
2. **Read the implemented code**; code is truth when it and the spec disagree.
3. **Draft** What Was Built, Architecture, Usage, Verification, scaled to the feature and never longer than the plan.
4. **Draft the Journey Log:** at most 5 bullets.
5. **Assemble and save** with frontmatter.
6. **Self-review** (below).
7. **Mark specs and plans** with the note block.
8. **Commit** the report and markers on the feature branch.

## Report Structure

```markdown
---
feature: <feature-name>
status: delivered
specs:
  - <spec-path>
plans:
  - <plan-path>
branch: <branch-name>
commits: <base-sha>..<head-sha>
---

# [Feature Name] - Final Report

## What Was Built

[1-3 paragraphs: what the feature does and what problem it solves, written as
if it always existed in this form.]

## Architecture

[Final architecture as implemented, derived from code: components, boundaries,
data flow, key interfaces, file paths.]

### Design Decisions

[Only non-obvious choices, as "we chose X because Y".]

## Usage

[Commands, config options, API surface, concrete examples.]

## Verification

[Commands run and their observed results, from the harness:verify summary;
PRE-EXISTING failures named; review outcome.]

## Journey Log

- [dead end] Tried X; failed because Y
- [pivot] Switched from A to B after discovering C
- [lesson] Transferable insight

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `path/to/spec.md` | Initial design | Superseded by this report |
| `path/to/plan.md` | Implementation plan | Complete |
```

## Marking Specs and Plans

Insert this block between the H1 title and the rest of each listed spec and plan:

```markdown
> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/<feature-name>.md)
```

Never move or delete the files and never edit the body below the marker; re-applying the marker is idempotent.

## Self-Review

1. **Accuracy:** grep key names and confirm file paths exist.
2. **Self-contained:** understandable without any spec.
3. **No placeholders:** no "TBD", "TODO", "fill in later".
4. **Proportional:** not longer than the plan; at least a paragraph per section.
5. **Journey Log:** at most 5 items, each 1-2 sentences, each useful to a future designer.

**Next step:** `harness:merge`. Announce: "Final report written to `<path>`. Related specs marked."
