# CLAUDE.md

Working rules for Claude Code in this repository. AGENTS.md holds the code style and commit
conventions (shared with upstream); TOOLBOX.md holds the developer commands; docs/UPSTREAM-MAP.md
holds the ownership map. Read those three before changing anything. `docs/FORK-RULES.md` holds
the binding fork rules for every contributor and model (forbidden edits, security invariants,
port procedure); it wins on fork questions.

## What Hordecode is

Hordecode is a friendly fork of opencode that tracks upstream, carries a delta-port of MiMo Code,
and adds its own features. Primary command `horde`, alias `hordecode`, npm package `hordecode`,
GitHub `siliconstencil/hordecode`. Not affiliated with either upstream.

- Starting bases: opencode 1.17.18 (git ancestor tag `v1.17.18`) and MiMo Code 0.1.5.
- Current parity: opencode 1.18.34 for `core`, `opencode`, `tui`, `cli`, `server` and the small
  packages; the UI packages (`app`, `desktop`, `ui`, `session-ui`, `web`) still lag. MiMo Code
  parity 0.1.11; from 0.1.12 MiMo changed its orchestrator, so MiMo updates are selective.
- MiMo "actor" is Hordecode `supervisor`; MiMo "compose" is the Hordecode `harness` pipeline.
  Both are customized ports, not copies. The name "compose" is retired.
- Hordecode-only packages: agent, bus, control-plane, cron, global, inbox, memory, project,
  shared, skill, supervisor, task, team, workflow, worktree. Fork features surface as tools
  (`memory-*`, `supervisor`, `task`, `workflow`, `cron`, `fleet`, `skill*`), not as CLI commands.
- Config: `hordecode.json` / `hordecode.jsonc` and `.hordecode/` first, `opencode.*` and
  `.opencode/` as lower-priority compatibility. Env: `HORDECODE_*` first, `OPENCODE_*` fallback.
  `HORDECODE_HOME` must be absolute.

## Constitution

The product must be stable, robust, current, efficient and sustainable. Every decision is
measured against those five words.

## Reference sources

Read-only checkouts next to the repository under `../repos/`, from
https://github.com/anomalyco/opencode and https://github.com/XiaomiMiMo/MiMo-Code:

- `opencode-1.18.34/` (tag `v1.18.34`) parity reference (latest stable, 2026-09-30);
  `opencode-1.18.15/` (tag `v1.18.15`) previous parity. The upstream `v2.0.x` tags are a
  separate restructured line, not a port target yet.
- `mimocode-v0.1.5/` (commit `b3a8063b`) starting base; `mimocode-v0.1.11/` (tag `v0.1.11`)
  parity reference; `mimocode-0.1.12/` (tag `v0.1.12`) first version after the orchestrator
  change.

Create one with, for example,
`git clone --depth 1 --branch v1.18.34 https://github.com/anomalyco/opencode ../repos/opencode-1.18.34`.

Never cite a folder by its label alone; check `package.json` version or the git tag first.

## How fixes are made

1. Look the file up in `docs/upstream-map-files.tsv`.
   - PARITY or LAGGING: upstream owns it. Do not hand-edit; port the upstream version.
   - FORK_DELTA: edit only with a citation to the upstream file:line and, when the behavior
     comes from MiMo, the MiMo file:line.
   - FORK_ONLY: Hordecode owns it. Still check whether MiMo carries the same pattern.
2. Provenance before hypothesis. For a failing test or bug in ported code, answer four questions
   with evidence before forming any runtime theory: git history of the file, documented intent,
   upstream diff, MiMo pattern. Documented intent plus a matching reference pattern means the
   test harness is wrong, not the product.
3. No invention. If neither upstream nor MiMo has the answer, report it with the evidence gap.
   Humans decide; agents do not take initiative on product decisions.
4. Upstream infrastructure Hordecode cannot run (`infra/`, `sst.config.ts`, `github/`,
   `STATS.md`, the translated READMEs, `artifacts/`, the upstream-only workflows) stays at parity
   on purpose. It is never rebranded, hand-edited or removed.

## Upstream ports

A port is complete only when all three land together: the code, the `hordecodeBase` bump in
`package.json` and `packages/opencode/package.json`, and a marker commit
`git merge -s ours <upstream tag>` so git ancestry records the new base. Then run
`bun run script/upstream-map.ts` and commit the regenerated map.

## Verification

- Root `bun run typecheck` and root `bun test` are banned on purpose. Run per package:
  `cd packages/<name> && bun run typecheck` and `bun test`.
- Report numbers you measured, never numbers you expected. A fix verified in isolation is
  re-verified in the package suite after landing; neighbours share state.
- A claim that something landed is proven with `git merge-base --is-ancestor <sha> main`,
  not with an agent's report. Agent reports are input, not evidence.

## Git

- Conventional commits `type(scope): summary` (see AGENTS.md). No AI attribution trailers,
  no model or vendor name in any signature surface; identity is the role.
- Commit, merge and push only on a maintainer's explicit instruction. Push goes to `origin` only,
  never to `upstream`, never force.
- Zero delete: no file, directory or data is deleted, moved or renamed without an explicit
  instruction. Editing content and creating files is allowed.
- Do not commit measurement logs, scratch files or sessions.

## Working with agents

- Everything written to disk, every agent brief and every report is English, ASCII only,
  no emoji.
- Sweeps, mechanical renames and bulk edits may be delegated to implementer agents; the
  reviewer writes the brief, audits every diff and re-derives every count before reporting.
- A brief carries: the constitution, the reference paths, the ownership class of each file in
  scope, the verification commands, and "report open decisions, do not resolve them".
- Structure of a report: observation, root cause, action, evidence. No filler.

## Known open items

- `hordecodeBase` is 1.18.34 for the root and the non-UI packages; the UI packages keep 1.17.18
  until their own port. The marker commit for `v1.18.34` is recorded; `v1.18.15` was never
  recorded as a marker and is covered by it.
- `publish.yml` version bumping depends on upstream's API; releases are built locally with
  `packages/opencode/script/build.ts` until that is replaced.
- Fork-only subagent nesting has no limit and the upstream `subagent_depth` setting (upstream
  task tool) has no effect; listed in CHANGELOG. MiMo 0.1.12 added a no-nested-delegation guard
  (MiMo 0.1.11 had none); whether to adopt a limit is a maintainer decision for 0.1.2.
- Fork packages `agent`, `control-plane`, `project`, `shared`, `task`, `team`, `worktree` have
  no tests; `memory` has tests but no `test` script; `global` has no scripts at all.
- `packages/docs` is untouched upstream scaffolding; the fork subsystems are undocumented there.
- Type shortcuts: the session hot path is clean (`core/src/session/prompt.ts` 0 `as any`,
  `processor.ts` 2, `max-mode.ts` 5, `opencode/src/session/processor.ts` 0); the remaining
  `as any` in `packages/memory/src` are in its co-located `*.test.ts` files. Fix per file with the
  package typecheck and suite, not in bulk.
- The remote installer (`install`) is active again and resolves the latest release through the
  GitHub API; it works only after a GitHub release with `hordecode-<os>-<arch>` assets exists.
  `https://hordecode.com/install` redirects to the raw script on GitHub (site `_redirects`);
  there is no PowerShell installer, Windows installs via npm.
- macOS and Windows are not exercised on the Linux release machine; run the manual workflow
  `fork-platform-smoke` (builds the native package on GitHub runners, checks version, serve,
  the no-provider message and an npm install of the packed packages) before each release.
- `https://hordecode.com/config.json` (schema) is served by the site; editor validation depends on it.
- `horde web` serves the `app` package, which still carries upstream branding (title "OpenCode",
  wordmark, theme keys; 223 files mention opencode). Rebranding it is a package-level job; until
  then the web UI is an unbranded upstream surface.
- The bundled skills `claude-code` and `codex` are intentional product content. `codesearch`
  (MiMo-origin, Exa-backed) is no longer registered; `core/src/tool/codesearch.ts`,
  `opencode/src/tool/codesearch.ts` and `core/src/tool/mcp-exa.ts` remain on disk. `websearch`
  keeps upstream's gating (opencode tier or the Exa/Parallel flags); users add their own MCP
  servers for search. The `opencode` (Zen) and `opencode-go` providers stay in the connect dialog for users with
  an API key; only the credential-less public tier is disabled.
- Checkpoint writer: the runtime `SessionPrompt.layer` (`packages/opencode/src/session/prompt.ts`)
  populates `prefixCaptureRef` (mirror of MiMo prompt.ts:292-338); `core/src/session/prompt.ts` and
  `core/src/session/llm-request-prefix.ts` are the unmounted core copies (the latter is still a stub).
  `SessionPrune.fireCheckpoints` runs only from the second step of a turn (it needs the previous
  assistant message's token count), so a one-shot `horde run` never checkpoints.
