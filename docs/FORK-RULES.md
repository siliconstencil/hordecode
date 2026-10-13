# Fork rules

Binding rules for anyone who changes this repository: humans, coding agents and any model or
tool. They apply regardless of which assistant is running. AGENTS.md and CLAUDE.md point here;
when they disagree, this file wins for fork questions and AGENTS.md wins for code style.

Every rule below exists because the mistake it prevents was found in this tree.

## 1. What this project is

Hordecode is a friendly fork of opencode with three layers, and every change belongs to exactly
one of them:

| Layer | Owner | Goal |
|---|---|---|
| Upstream opencode | opencode | Track the latest stable release. Do not deviate without a need. |
| MiMo Code delta-port | Hordecode, ported from MiMo | Bring selected MiMo behavior (supervisor, harness, memory, cron...) as a customized port, not a copy. |
| Hordecode features | Hordecode | Own design, own packages, own tests. |

Constitution: stable, robust, current, efficient, sustainable. A change that does not serve one
of these five words is not made.

The goal of the upstream layer is to stay current. Every unneeded edit to an upstream file makes
each future upstream port harder, so the smallest possible delta is a product requirement, not a
style preference.

## 2. Ownership decides how a file may change

Look the file up in `docs/upstream-map-files.tsv` before editing.

- PARITY / LAGGING: upstream owns it. Never hand-edit. Port the upstream version.
- FORK_DELTA: upstream file with a fork change. Edit only the fork hunk, cite the upstream
  file:line (and the MiMo file:line when the behavior comes from MiMo). Leave every other line
  byte-identical to upstream.
- FORK_ONLY: Hordecode owns it. Check whether MiMo has the same pattern first.
- Upstream infrastructure Hordecode cannot run (`infra/`, `github/`, upstream-only workflows,
  translated READMEs, `artifacts/`) stays at parity and is never rebranded or removed.

New fork behavior goes into a fork package or a new file, not into an upstream file, whenever
that is possible. A one-line hook in the upstream file is better than a rewritten upstream file.

## 3. Forbidden in upstream-owned files

Each item was found in this tree and had to be reverted.

1. Identifier rebranding. Do not rename code identifiers, Effect service keys (`@opencode/X`),
   keymap symbols, command IDs, provider IDs, theme keys or internal sentinels. Only text a user
   reads is rebranded. Example of the damage: provider id `"opencode"` renamed to `"hordecode"`
   broke the free-tier check, because no `hordecode` provider exists.
2. Environment variables without fallback. A new `HORDECODE_X` must keep reading `OPENCODE_X`
   as a fallback. Never replace the upstream name outright.
3. Cosmetic churn: reformatting, reindenting, reordering imports, renaming locals, swapping
   values for tokens, extracting helpers with identical behavior, line-ending changes.
4. Dropping upstream code. A whole-file re-port that loses upstream lines (features, error
   handling, guards, tests) is a regression. Port the fork hunk into the current upstream file,
   never the other way around.
5. Narrative comments. No comments that explain the fork's history, cite internal ticket or
   phase IDs, or argue with upstream. A fork hunk carries one short citation line at most.
6. Local workarounds. Fixes for one developer's environment (stale tokens, local paths, a
   particular shell) do not enter the product.

## 4. Forbidden everywhere in the product tree

1. Debug instrumentation left behind: writes to temp files, `console.log`, debug env switches,
   "temporary diagnostic" blocks. Use the `Log` service at debug level or remove it.
2. Process residue: phase, wave, ticket or agent-run names (`P7.12`, `KN-5`, `T25`) in code,
   comments, test fixtures or commit messages of product files.
3. Personal data: personal names, emails, home paths, quotes from chats, in code or fixtures.
4. Non-English or non-ASCII text in code, comments and docs (user-facing translations excepted).
5. Unverified facts in user-visible text: URLs, docker images, product names, commands. Verify
   that the target exists before writing it (example: tips pointed to a docker image and a
   "Hordecode Zen" product that do not exist).
6. Dead code or files that nothing imports (example: `core/src/util/scrap.ts`).
7. Weakening tests to make them pass: deleting upstream assertions, shrinking a suite, raising
   timeouts without a cause. A failing test is a question about the product first.

## 5. Security invariants

1. Nothing read from a repository (project config, `.hordecode/` files, task files, skills,
   workflows) may execute a command, write outside the project or reach the network without the
   permission system (`ctx.ask` or the equivalent permission service call). Opening a malicious
   repository must never run code. Example: `.hordecode/scheduled_tasks.json` executed its
   `shell` field on session start.
2. Model-controlled input that becomes a file path is validated as a safe single segment and
   checked for containment after `realpath`.
3. Every new tool that runs processes or writes files asks permission before acting, following
   `packages/opencode/src/tool/shell.ts`.
4. Network listeners on non-loopback interfaces require authentication.
5. Secrets are never logged, printed, embedded in URLs or committed.

## 6. Upstream port procedure

1. Target the latest stable upstream release (a GitHub release, not a prerelease line).
2. Before porting, list the fork delta of every upstream file the release touches and remove
   unneeded edits first (section 3). Smaller delta, fewer conflicts.
3. Copy PARITY files, add new upstream files, three-way merge FORK_DELTA files
   (`git merge-file ours base theirs`). Conflicts are resolved by reading both sides; never by
   taking the fork side wholesale.
4. A port is complete only when the code, the `hordecodeBase` bump in `package.json` and
   `packages/opencode/package.json`, the marker commit `git merge -s ours <tag>` and the
   regenerated `docs/upstream-map-files.tsv` land together.
5. MiMo updates are selective after MiMo 0.1.12; port behavior, not files.

## 7. Verification

- Root `bun run typecheck` and root `bun test` are banned. Run per package.
- Report measured numbers only. A claim that something landed is proven with
  `git merge-base --is-ancestor <sha> main`, not with an agent's report.
- A product change is proven on the installed binary, not only in unit tests.

## 8. Working with agents

- Roles: a reviewer plans, writes briefs and audits; implementer agents apply mechanical,
  fully specified steps; judgment work (conflict resolution, security code, product decisions)
  stays with the reviewer or a maintainer.
- A brief states: the constitution, the ownership class of each file, the reference paths, the
  verification commands, and "report open decisions, do not resolve them".
- The reviewer audits every diff against sections 3 to 5 before anything is committed.
  Agent reports are input, not evidence.
- Agents never take product decisions, never delete, never commit or push without a
  maintainer's explicit instruction.

## 9. Git

- Conventional commits `type(scope): summary`. No AI attribution trailers, no model or vendor
  names in any signature surface.
- Push only to `origin`, never to `upstream`, never force.
- Zero delete without an explicit maintainer instruction.
- No measurement logs, scratch files or sessions in commits.
