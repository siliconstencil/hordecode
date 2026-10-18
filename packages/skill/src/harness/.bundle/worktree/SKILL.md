---
name: harness:worktree
description: Use before implementation when the work should be isolated from the current checkout - detects an existing linked worktree, or creates one under .worktrees/ with git worktree
---

# Using Git Worktrees

## Overview

Ensure implementation happens in an isolated workspace when the user wants one. Detect existing isolation first; never nest a worktree inside another. Never begin implementation on `main` or `master` without explicit user consent.

**Announce at start:** "I'm using the harness:worktree skill to set up an isolated workspace."

## Step 1: Detect Existing Isolation

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git branch --show-current
```

- **git-dir differs from git-common-dir** and the superproject query prints nothing: you are already in a linked worktree. Do not create another; go to Step 4. Report "Already in isolated workspace at `<path>` on branch `<name>`" (or "detached HEAD, externally managed").
- **Superproject query prints a path:** you are in a submodule; treat it as a normal checkout.
- **Normal checkout:** continue with Step 2.

## Step 2: Consent

1. If the user or the repository instructions (AGENTS.md) already chose the workspace, follow that.
2. Otherwise check for a saved preference: `memory_recall` with `scope: "global"` and query `harness-preference worktree-consent`. If the newest match says `always` or `never`, honor it silently.
3. Otherwise ask through `harness:ask`:
   - header: `Worktree`
   - question: `Set up an isolated worktree? It protects your current branch from changes.`
   - options: `Yes (Recommended)` (create a worktree for this work) / `No` (work on the current branch) / `Always use worktrees` / `Never use worktrees` (remember for future sessions)

   No user available: create the worktree.
4. For "Always" or "Never": `memory_add` with `scope: "global"`, `type: "decision"`, body `harness-preference worktree-consent: always` (or `never`). If the write is refused, continue without saving.

If the user declined, work in place on a non-base branch (create one with `git switch -c <branch>` if you are on the base branch) and go to Step 4.

## Step 3: Create the Worktree

**Location:** the path the user or AGENTS.md specifies; otherwise `.worktrees/<branch>` at the project root.

**Make sure the directory is ignored:**

```bash
git check-ignore -q .worktrees
```

If it is not ignored, write a file `.worktrees/.gitignore` containing the single line `*` (use the `write` tool). This keeps worktree contents out of git without touching the repository's own `.gitignore`. Change and commit the repository `.gitignore` only when the user or the repository instructions require a shared convention, and never unattended.

**Create it:**

```bash
git worktree add ".worktrees/<branch>" -b "<branch>"
```

Then switch the session into it with the `change_directory` tool (pass the worktree's absolute path). Later file tools, `bash` calls, and subagents resolve from there. For a one-off command elsewhere, pass `workdir` to `bash` instead.

**If creation fails** (sandbox or permission error): report the limitation and work in place on a non-base branch.

## Step 4: Project Setup

Install dependencies per the repository's instructions. Prefer lockfile-frozen modes that do not rewrite the lockfile (`bun install --frozen-lockfile`, `npm ci`, `uv sync --frozen`, `cargo fetch --locked`). Confirm the toolchain runs before continuing.

## Step 5: Baseline

Run the project's relevant tests once to record the starting state.

- **All pass:** report ready.
- **Failures:** record each as `PRE-EXISTING` with a short identifier (test name or error) so `harness:verify` can tell them apart from new failures. Then ask through `harness:ask`:
  - header: `Baseline Tests`
  - question: `Baseline has <N> pre-existing failures.`
  - options: `Proceed anyway (Recommended)` / `Investigate first` (load `harness:debug`)

  No user available: proceed.

### Report

```
Worktree ready at <full-path> on branch <branch>
Baseline: <N> passing, <M> PRE-EXISTING failures (<ids>)
```

**Next step:** `harness:subagent` or `harness:execute`.
