# F7: installed skills are read-only; self-edits become proposals

## Observation

RC 88a04430a7 edited five installed harness skill files under
`~/.local/share/hordecode/harness/0.1.6/skills` with the `edit` tool in eight calls and received no
permission prompt: `review/SKILL.md`, `review/code-reviewer.md`, `subagent/SKILL.md`,
`brainstorm/SKILL.md`, `eval/scoring-metrics.md`. Three more installed files (`verify`, `tdd`,
`plan`) had been edited the same way on 2026-11-16..18. Extraction is keyed by the bundle hash
(`packages/skill/src/harness/extract.ts`), so an edited file stayed edited until the bundle changed.
The owner restored the installed trees from the bundle and ruled on 2026-11-20 that no agent changes
the running system on its own.

## Root cause

`Agent.state` builds the default `external_directory` ruleset from every directory the Skill
service discovered (`skill.dirs()`), and marks each `.../<skill-dir>/*` as `allow`:

- opencode v1.19.6 `packages/opencode/src/agent/agent.ts:108-124` (`whitelistedDirs` from
  `skillDirs`, then `external_directory` allow at :122-124).
- MiMo Code v0.1.11 `packages/opencode/src/agent/agent.ts:107-119` (same shape, `whitelistedDirs`
  at :107 and the `external_directory` allow at :117-119).

The fork inherited that rule unchanged. Because the default permission is `*: allow`, the write
tools' `edit` ask also evaluated to allow, so `edit`/`write`/`apply_patch`/`multiedit`/
`notebook_edit` could write an installed skill with no prompt. The whitelist exists so skills can
be *read* outside the project.

`skill.dirs()` contains installed roots and user-authored roots (`~/.config/hordecode/skills`,
project `.hordecode/skills`, external agent skill dirs). The user-authored roots share the same
whitelist and stay writable as before; the lock is scoped to the installed roots only.

## Action

1. Write lock. New `packages/opencode/src/permission/installed-skill.ts`:
   - roots: `Global.Path.data/harness` and `Global.Path.data/research`;
   - `match()` compares the literal and realpath forms, so a symlink into the root is caught;
   - `ruleset()` returns deny rules for each root and `root/*`;
   - `assert()` asks the `installed_skill_write` permission.

   `Agent.runtimePermission` appends `InstalledSkill.ruleset()` last, after the user/session merge
   and `ProtectedPath.ruleset()`, so no user or session allow can relax it. The deny path in the
   permission service returns before any prompt. Reads are untouched: read tools call
   `assertExternalDirectoryEffect`, which does not run the lock.

2. Write tools. `assertWriteAllowed` calls `InstalledSkill.assert` before the memory/sandbox
   checks. Every file-writing tool funnels through that gate: `edit`, `write`, `apply_patch`
   (including `movePath`), `multiedit`, `notebook_edit`, `hashline_edit`. A grep for
   `writeFile|writeWithDirs|Bun.write` in `packages/opencode/src/tool/*.ts` and for
   `assertWriteAllowed` callers shows the same six tools plus the gate itself.

3. Shell. The existing tree-sitter scan already yields `file_redirect` nodes. A redirect
   destination is a reliable write, so a statically resolvable destination is matched against the
   installed roots and asserted as `installed_skill_write` before the normal bash/askDelete asks.
   No shell parser was added.

4. Integrity. On extraction, when the marker exists, every bundle file is compared with the
   bundle. A file modified after extraction is read; if its content differs it is rewritten from
   the bundle (never deleted) and one warning names the file. Files untouched since extraction are
   skipped by mtime, and a marker inode is verified once per process. This keeps a cached Skill
   layer build as cheap as before: the opencode skill test file is 9.6-10.7 s with the check and
   9.5-12.4 s on the base commit.

5. Proposals instead of edits. `harness:eval` Step 6 now says installed skill files are read-only
   and defines the proposal at `docs/harness/proposals/<run-id>-<skill>.md` (eval JSON path,
   occurrence counts, failing run ids, requirement, expected effect, exact diff against the
   bundle), then stop and ask the user. `harness:report` step 9 writes the same proposal instead of
   applying the fix. `research:debug` and `research/conf/failure-patterns.md` were changed the same
   way. `eval/example-output.md` uses "Proposed fix".

6. `CHANGELOG.md` [Unreleased]: one Security line and one Changed line.

## Evidence

Red first: `packages/opencode/test/permission/installed-skill.test.ts` failed with
`Cannot find module '../../src/permission/installed-skill'` before the module existed.

Typecheck (per package, `bun run typecheck`):

| package | rc |
|---------|----|
| packages/opencode | 0 |
| packages/skill | 0 |

Tests (per package, `bun run test`):

| package | result |
|---------|--------|
| packages/skill | 53 pass, 0 fail, 90 expect calls, 9 files, rc 0 |
| packages/opencode | 5181 pass, 25 skip, 1 todo, 0 fail, 50 snapshots, 18581 expect calls, 5207 tests, 485 files, rc 0 (762.07 s) |

Focused reruns:

- `test/permission/installed-skill.test.ts` + `test/permission/protected-path.test.ts` +
  `test/skill/skill.test.ts`: 30 pass, 0 fail, 118 expect calls, rc 0. Covers: match for
  harness/research only, no match for data memory/config skill dirs, hard deny over a permissive
  user/session ruleset, write gate denies, read path does not ask the lock, and a shell redirect
  into the harness tree asks `installed_skill_write`.
- `test/skill/skill.test.ts`: 18 pass, 0 fail, 6 consecutive runs after the inode fast path.
- `test/extract-cache.test.ts` + `test/extract-integrity.test.ts`: 5 pass, 0 fail. Covers restore,
  one content rewrite, the warning naming the file, and no rewrite for unchanged files.

Security review (one cycle, manual diff review):

- NEW Critical: none.
- NEW Important: a hard link created outside the installed roots (for example with `ln`) to an
  installed skill file is not detected by the path/realpath check. The edit tool would write
  through the project-side hard link and change the installed file. Path-based coverage cannot see
  it. Follow-up: inode comparison against the bundle, or a bash write-command check, is a separate
  decision.
- Residual bash gaps are the ones ruling 2 asked to report: `cp`, `mv`, `tee`, `sed -i`, `dd of=`,
  `install`, `touch`, `truncate`, interpreters, `~`, `$VAR`, globs, command substitution, and a `cd`
  earlier in the same command line (the redirect is resolved against the session cwd). Only a
  static redirect destination is covered.

## Open decisions

1. Bash coverage beyond static redirects: whether to add a write-command table (`cp`, `mv`, `tee`,
   `sed -i`, `dd`, `install`, `touch`, `truncate`), or to accept that only the file tools and static
   redirects are locked. The brief rules out inventing a shell parser.
2. Hard links: whether the write lock must also match inodes across the bundle, at the cost of a
   stat scan per write.
3. Builtin skills (`Global.Path.data/builtin_skills`): the lock and the integrity restore cover
   `harness/` and `research/` only, as ruled. Whether the official document skills need the same
   protection is open.
4. The brief named feedback, review, subagent and brainstorm as skills whose text tells the model
   to edit a skill file. The current bundle contains no such instruction in those four files; the
   self-edits were made under generic "apply feedback/improvement" wording. Only `harness:eval`,
   `harness:report` and `research:debug` contained an explicit edit instruction and were changed.
   Whether to add an explicit "never edit installed skills" line to the other four is open; the
   hard lock already covers them.
5. Integrity timing: verification runs once per process per marker inode. A file changed later in
   the same process through a path the write lock cannot see is restored on the next start, not on
   the next extraction. Whether every extraction must re-verify is open; re-verifying every cached
   Skill layer build put the opencode skill suite back over its per-test timeout.
6. The integrity fast path trusts a file whose mtime is not newer than the marker. A deliberate
   mtime-preserving write (`touch -r`) is not detected; that path is already a bash gap.
7. User-authored skill dirs stay writable because they are outside the two lock roots. This was
   checked against `skill.dirs()` and the inherited whitelist, and is reported, not changed.

## Files changed

- `packages/opencode/src/permission/installed-skill.ts` (new)
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/tool/external-directory.ts`
- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/test/permission/installed-skill.test.ts` (new)
- `packages/opencode/test/permission/protected-path.test.ts`
- `packages/skill/src/harness/extract.ts`
- `packages/skill/src/research/extract.ts`
- `packages/skill/test/extract-integrity.test.ts` (new)
- `packages/skill/test/extract-cache.test.ts`
- `packages/skill/src/harness/.bundle/eval/SKILL.md`
- `packages/skill/src/harness/.bundle/eval/example-output.md`
- `packages/skill/src/harness/.bundle/report/SKILL.md`
- `packages/skill/src/research/.bundle/debug/SKILL.md`
- `packages/skill/src/research/.bundle/research/conf/failure-patterns.md`
- `CHANGELOG.md`

F7 DONE
