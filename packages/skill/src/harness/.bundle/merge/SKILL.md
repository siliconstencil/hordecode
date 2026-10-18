---
name: harness:merge
description: Use when implementation is verified, reviewed, and reported - presents finishing options (local merge, pull request, keep, discard) through the question tool; never auto-finishes when no user is available
---

# Finishing a Development Branch

**Core principle:** verify, detect the environment, offer options, execute only the choice the user made. **Never auto-finish.**

**Announce at start:** "I'm using the harness:merge skill to finish this work."

## Step 1: Confirm Fresh Verification

The latest `harness:verify` summary must postdate the last change. If anything changed since, run `harness:verify` again. If tests fail (other than PRE-EXISTING), stop: report the failures; do not offer merge or PR.

## Step 2: Detect the Environment

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git branch --show-current
git worktree list
```

| State | Options |
|-------|---------|
| Normal checkout (git-dir equals git-common-dir) | Merge locally, Create PR, Keep, Discard |
| Linked worktree on a named branch | Merge locally, Create PR, Keep, Discard |
| Linked worktree, detached HEAD | Create PR, Keep, Discard |

Find the base branch with `git merge-base HEAD main` (or `master`, or the branch the user named). The main checkout is the first entry of `git worktree list`; call it MAIN_ROOT.

## Step 3: No User Available: Report and Stop

If the `question` tool is absent or returns `[Never-Ask]`, do not merge, pull, push, open a pull request, delete anything, or commit the repository's `.gitignore`. Committing the feature work itself on the feature branch is fine. Report and stop:

```
Branch: <branch>   Base: <base>   Head: <sha>
Worktree: <path or "none">   Report: <report path>
Verification: <one-line summary>
Suggested closing action: <merge locally | open PR | keep>, because <reason>
```

## Step 4: Offer Options (user available)

Ask through `harness:ask`:
- header: `Complete Work`
- question: `Implementation complete on <branch>. What would you like to do?`
- options: `Merge locally` (merge into <base>) / `Create PR` (push the branch and open a pull request) / `Keep as-is` (leave branch and worktree) / `Discard` (delete branch and commits)

Omit `Merge locally` for detached HEAD. If the base branch is uncertain, settle it in the same call with a second question (header `Base Branch`, options for the candidates).

## Step 5: Execute the Choice

Run git commands against MAIN_ROOT with `bash` `workdir` set to it (or `git -C <MAIN_ROOT>`). The base branch cannot be checked out while another worktree holds it, so local merges happen in the main checkout.

**Merge locally**
```bash
git checkout <base>
git merge <branch>
<test command>
```
Only after the merge and tests succeed: clean up the worktree (Step 6), then `git branch -d <branch>`.

**Create PR**
```bash
git push -u origin <branch>
gh pr create --title "<title>" --body "<summary and test plan>"
```
Keep the worktree; the user needs it for review feedback.

**Keep as-is**
Report "Keeping branch <branch>. Worktree preserved at <path>." No cleanup.

**Discard**
Confirm with a second `question`: header `Confirm Discard`, question `This permanently deletes branch <branch>, its commits, and the worktree at <path>.`, options `Cancel (Recommended)` / `Discard permanently`. Proceed only on `Discard permanently`; on `Cancel`, return to Step 4. Then clean up (Step 6) and `git branch -D <branch>`.

## Step 6: Clean Up the Worktree (Merge or Discard only)

- No linked worktree: nothing to do.
- Worktree under `.worktrees/` or the path the user or AGENTS.md scoped: run from MAIN_ROOT (`workdir`), never from inside the worktree:
  ```bash
  git worktree remove <worktree-path>
  git worktree prune
  ```
  If the session was switched into the worktree, call `change_directory` with `~` first.
- Any other worktree was created by something else: leave it in place.

## Rules

- Never proceed with new failing tests; verify the merged result.
- Never force-push unless the user asks.
- Remove the worktree before deleting its branch.
