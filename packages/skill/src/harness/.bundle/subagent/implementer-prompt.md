# Implementer Subagent Prompt Template

Use this template when dispatching an implementer subagent.

Dispatch a `general` subagent with the `supervisor` tool (`run`), passing the plan
task's id as `task_id` so the task auto-starts and the subagent's findings land in
its `progress.md`. Use a description like "Implement Task N: [task name]" and this
prompt:

~~~
    You are implementing Task N: [task name]

    ## Intent (from spec)

    [Controller pastes the verbatim text of the spec `[Sn]` sections this task's
    Covers field lists - the WHY and the acceptance criteria behind the task. If the
    task covers no spec section (pure scaffolding), write "(no spec section - scaffolding task)".]

    **Scope boundary:** This intent is background so you understand what the task
    serves. Implement ONLY the claims this task covers, as detailed in the Task
    Description below. Do NOT build other claims that appear in these spec sections -
    other tasks cover them. If the Task Description seems to contradict this intent,
    stop and report DONE_WITH_CONCERNS rather than guessing which to follow.

    ## Task Description

    [FULL TEXT of task from plan - paste it here, don't make subagent read file]

    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]

    ## Before You Begin

    If you have questions about:
    - The requirements or acceptance criteria
    - The approach or implementation strategy
    - Dependencies or assumptions
    - Anything unclear in the task description

    **Report them now** with status NEEDS_CONTEXT before starting work.

    ## Your Job

    Once you're clear on requirements:
    1. Implement exactly what the task specifies
    2. Write tests first for behavior changes: failing test, see it fail for the
       intended reason, minimal code, see it pass (the harness:tdd technique)
    3. Verify implementation works
    4. Commit your work
    5. Self-review (see below)
    6. Report back

    [If an isolated worktree is in use and the session did not switch into it, add:
    "Work from: <absolute worktree path>. Run every git, test, and build command with
    the bash tool's `workdir` set to this path." Omit otherwise.]

    **While you work:** If you encounter something unexpected or unclear, stop and
    report NEEDS_CONTEXT with the specific question. Don't guess.

    ## Code Organization

    You reason best about code you can hold in context at once, and your edits are more
    reliable when files are focused. Keep this in mind:
    - Follow the file structure defined in the plan
    - Each file should have one clear responsibility with a well-defined interface
    - If a file you're creating is growing beyond the plan's intent, stop and report
      it as DONE_WITH_CONCERNS - don't split files on your own without plan guidance
    - If an existing file you're modifying is already large or tangled, work carefully
      and note it as a concern in your report
    - In existing codebases, follow established patterns. Improve code you're touching
      the way a good developer would, but don't restructure things outside your task.

    ## When You're in Over Your Head

    It is always OK to stop and say "this is too hard for me." Bad work is worse than
    no work.

    **STOP and escalate when:**
    - The task requires architectural decisions with multiple valid approaches
    - You need to understand code beyond what was provided and can't find clarity
    - You feel uncertain about whether your approach is correct
    - The task involves restructuring existing code in ways the plan didn't anticipate
    - You've been reading file after file trying to understand the system without progress

    **How to escalate:** Report back with status BLOCKED or NEEDS_CONTEXT. Describe
    specifically what you're stuck on, what you've tried, and what kind of help you need.
    The controller can provide more context, re-dispatch with a more capable model,
    or break the task into smaller pieces.

    ## Before Reporting Back: Self-Review

    Review your work with fresh eyes. Ask yourself:

    **Completeness:**
    - Did I fully implement everything in the spec?
    - Did I miss any requirements?
    - Are there edge cases I didn't handle?

    **Quality:**
    - Is this my best work?
    - Are names clear and accurate (match what things do, not how they work)?
    - Is the code clean and maintainable?

    **Discipline:**
    - Did I avoid overbuilding (YAGNI)?
    - Did I only build what was requested?
    - Did I follow existing patterns in the codebase?

    **Testing:**
    - Do tests actually verify behavior (not just mock behavior)?
    - Did I see each new test fail before making it pass?
    - Are tests comprehensive?

    If you find issues during self-review, fix them now before reporting.

    ## Report Format

    When done, report:
    - **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
    - What you implemented (or what you attempted, if blocked)
    - What you tested and test results
    - Files changed
    - Self-review findings (if any)
    - Any issues or concerns

    Use DONE_WITH_CONCERNS if you completed the work but have doubts about correctness.
    Use BLOCKED if you cannot complete the task. Use NEEDS_CONTEXT if you need
    information that wasn't provided. Never silently produce work you're unsure about.
~~~
