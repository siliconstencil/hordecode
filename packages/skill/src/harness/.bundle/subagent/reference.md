# Subagent Reference

Detail behind harness:subagent. SKILL.md holds the process, status handling, model selection, and rules; this file adds the reasoning behind the review gate and a worked example.

## Spec-Anchored Review Gate

Each task's spec-compliance review replaces a single prose review with intent-grounded implementation and a two-phase, evidence-gated verdict.

**Working directory (only if isolated).** If harness:worktree created a worktree and the session switched into it with `change_directory`, subagents inherit that directory. Otherwise give every subagent the worktree's absolute path and tell it to run git, test, and build commands with `bash` `workdir` set to it. When a worktree is in use and this is missed, a reviewer's `git diff` and tests run against the wrong checkout and the verdict is meaningless.

**1. Create and bind a task before dispatching.** Create the work item with the `task` tool and capture its id. Pass that id as `task_id` on the `supervisor` call. Binding auto-starts the task (`in_progress`, owned by the subagent) and asks the subagent to record its commands, outcome, and discoveries in the task's `progress.md`. Pass only an id the `task` tool returned in this session. Do not mark the task done at dispatch; completion is gated on review (step 4).

**2. Inject intent.** Read the task's `Covers:` field, copy the verbatim text of those `[Sn]` sections, and paste it into the implementer prompt's Intent block. The implementer never reads the spec itself; it gets exactly the sections its task covers, with the scope boundary intact.

**3. Two review phases** (`spec-reviewer-prompt.md`):
- **Phase 1** sees the covered spec text and the diff only. The implementer's report is withheld because its claims anchor the reviewer toward confirming what was reported and away from noticing silent omissions.
- **Phase 2** runs only when phase 1 flagged something. The report may explain a flagged diff; phase 2 may downgrade a flag, never add a pass.

**4. Gate on the verdict.** A task is complete only when the final status is pass and every in-scope claim is pass with evidence. A structured pass without verifiable evidence (test name, command output, or file:line) counts as fail; prose is not evidence. Any fail or unverifiable claim goes back to the implementer, then to a fresh phase 1. If the loop stops converging, stop and report (see SKILL.md).

## Example Workflow

```
[Read plan, extract 5 tasks, create T1..T5]

Task 1: Hook installation script
[supervisor run, implementer-prompt.md filled, task_id T1]
Implementer: "Should the hook be installed per user or per project?"
You: "Per project, under the repository's hooks directory."
Implementer: DONE, tests 5/5, committed

[Spec review phase 1: spec + diff only]
Spec reviewer: Status: pass, every claim with evidence
[Code-quality review]
Code reviewer: Approved
[task {"operation":{"action":"done","id":"T1","event_summary":"spec gate pass, quality approved"}}]

Task 2: Recovery modes
Implementer: DONE, 8/8 tests, committed
[Spec review phase 1]
Spec reviewer: Status: fail, [S4] "report every 100 items" missing
[Phase 2 with report]: still fail
[Implementer fixes; fresh phase 1]: pass
[Code-quality review]: magic number (100) flagged
[Implementer fixes; re-review]: Approved
[task done for T2, with event_summary]

...

[All tasks done]
-> harness:verify, then harness:review on the whole change
```

## Why This Shape

- Fresh context per task: no confusion carried between tasks, and your own context stays free for coordination.
- Same session: no handoff, continuous progress.
- Two-stage review: spec compliance prevents over- and under-building; the quality review catches what the spec does not cover.
- Review loops make fixes prove themselves.
