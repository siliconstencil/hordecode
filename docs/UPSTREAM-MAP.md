# Upstream map

What in this tree belongs to upstream opencode, what Hordecode changed, and what only Hordecode has.
Regenerate with `bun run script/upstream-map.ts` (writes this file and `docs/upstream-map-files.tsv`).

Reference points:

- Git base: upstream tag `v1.17.18` (an ancestor of `main`).
- Parity reference: opencode 1.18.34 checkout at `../repos/opencode-1.18.34`.
- MiMo Code references: `../repos/mimocode-v0.1.5` (starting base) and `../repos/mimocode-v0.1.11` (parity), selective from 0.1.12.

## Classes

| class | meaning | rule for changes |
|---|---|---|
| PARITY | identical to opencode 1.18.34 | Do not edit. Upstream owns it; take the next upstream version as-is. |
| LAGGING | identical to v1.17.18, upstream has moved on | Port the upstream change, do not hand-edit. |
| FORK_DELTA | upstream file that Hordecode modified | Every edit must cite the upstream and MiMo reference. Ports must re-apply the delta. |
| FORK_ONLY | exists only in Hordecode | Hordecode owns it. Custom features and the MiMo delta-port live here. |
| kept (upstream removed) | Hordecode still carries a file upstream deleted | Decide per file at the next port. |
| UPSTREAM_ONLY | present in 1.18.34, absent here | Not yet ported (deliberately dropped: `packages/console`, `packages/stats`). |

Totals: PARITY 4500, LAGGING 452, FORK_DELTA 689, FORK_ONLY 1132, FORK_KEPT_UPSTREAM_REMOVED 8, UPSTREAM_ONLY 293.

## Packages that are entirely Hordecode's

agent, bus, control-plane, cron, global, inbox, memory, project, shared, skill, supervisor, task, team, workflow, worktree.

`packages/skill` carries the harness skill bundle; `packages/supervisor` is the MiMo "actor" port; the harness pipeline is the MiMo "compose" port. Both are customized, neither is a verbatim copy.

## Shared packages (upstream-owned, with a Hordecode delta)

| path | parity | lagging | fork delta | fork only | kept (upstream removed) | upstream only |
|---|---|---|---|---|---|---|
| packages/core | 371 | 0 | 117 | 329 | 0 | 5 |
| packages/opencode | 598 | 0 | 232 | 159 | 0 | 8 |
| packages/tui | 122 | 0 | 117 | 135 | 0 | 2 |
| packages/web | 554 | 94 | 55 | 0 | 0 | 2 |
| packages/ui | 1542 | 53 | 45 | 0 | 0 | 55 |
| packages/app | 265 | 208 | 37 | 0 | 5 | 133 |
| packages/server | 27 | 0 | 4 | 14 | 0 | 0 |
| packages/desktop | 197 | 40 | 11 | 1 | 1 | 58 |
| packages/cli | 22 | 0 | 3 | 7 | 0 | 0 |
| packages/client | 11 | 0 | 10 | 0 | 0 | 0 |
| packages/plugin | 35 | 0 | 6 | 4 | 0 | 1 |
| packages/schema | 67 | 0 | 7 | 0 | 0 | 0 |
| packages/sdk | 43 | 0 | 5 | 0 | 0 | 0 |
| packages/enterprise | 17 | 15 | 4 | 0 | 0 | 0 |
| packages/protocol | 23 | 0 | 3 | 0 | 0 | 0 |
| packages/function | 2 | 0 | 2 | 0 | 0 | 2 |
| packages/sdk-next | 7 | 0 | 2 | 0 | 0 | 0 |
| packages/slack | 5 | 0 | 2 | 0 | 0 | 0 |
| packages/codemode | 39 | 0 | 1 | 0 | 0 | 1 |
| packages/effect-drizzle-sqlite | 25 | 0 | 1 | 0 | 0 | 0 |
| packages/http-recorder | 23 | 0 | 1 | 0 | 0 | 0 |
| packages/httpapi-codegen | 15 | 0 | 1 | 0 | 0 | 0 |
| packages/llm | 151 | 0 | 1 | 0 | 0 | 0 |
| packages/session-ui | 69 | 30 | 1 | 0 | 2 | 18 |
| packages/storybook | 17 | 8 | 1 | 0 | 0 | 2 |
| packages/containers | 8 | 0 | 0 | 0 | 0 | 0 |
| packages/docs | 23 | 1 | 0 | 0 | 0 | 0 |
| packages/effect-sqlite-node | 0 | 0 | 0 | 0 | 0 | 4 |
| packages/identity | 6 | 0 | 0 | 0 | 0 | 0 |
| packages/script | 4 | 0 | 0 | 0 | 0 | 0 |

A package with zero LAGGING and zero UPSTREAM_ONLY rows is at parity. Packages with large LAGGING or UPSTREAM_ONLY counts are upstream-owned and behind; port them, do not hand-fix.

## Root and tooling

| path | parity | lagging | fork delta | fork only | kept (upstream removed) | upstream only |
|---|---|---|---|---|---|---|
| .github | 31 | 0 | 5 | 3 | 0 | 0 |
| script | 15 | 0 | 3 | 2 | 0 | 0 |
| docs | 0 | 0 | 0 | 3 | 0 | 0 |
| patches | 19 | 0 | 1 | 1 | 0 | 0 |
| .gitignore | 0 | 0 | 1 | 0 | 0 | 0 |
| .husky | 0 | 0 | 1 | 0 | 0 | 0 |
| .oxlintrc.json | 0 | 0 | 1 | 0 | 0 | 0 |
| AGENTS.md | 0 | 0 | 1 | 0 | 0 | 0 |
| assets | 0 | 0 | 0 | 1 | 0 | 0 |
| CHANGELOG.md | 0 | 0 | 0 | 1 | 0 | 0 |
| CLAUDE.md | 0 | 0 | 0 | 1 | 0 | 0 |
| CODE_OF_CONDUCT.md | 0 | 0 | 0 | 1 | 0 | 0 |
| CONTRIBUTING.md | 0 | 0 | 1 | 0 | 0 | 0 |
| install | 0 | 0 | 1 | 0 | 0 | 0 |
| LICENSE | 0 | 0 | 1 | 0 | 0 | 0 |
| package.json | 0 | 0 | 1 | 0 | 0 | 0 |
| README.md | 0 | 0 | 1 | 0 | 0 | 0 |
| sdks | 12 | 3 | 1 | 0 | 0 | 0 |
| SECURITY.md | 0 | 0 | 1 | 0 | 0 | 0 |
| TOOLBOX.md | 0 | 0 | 0 | 1 | 0 | 0 |
| .dockerignore | 1 | 0 | 0 | 0 | 0 | 0 |
| .editorconfig | 1 | 0 | 0 | 0 | 0 | 0 |
| .gitattributes | 1 | 0 | 0 | 0 | 0 | 0 |
| .gitleaksignore | 1 | 0 | 0 | 0 | 0 | 0 |
| .opencode | 38 | 0 | 0 | 0 | 0 | 1 |
| .prettierignore | 1 | 0 | 0 | 0 | 0 | 0 |
| .vscode | 2 | 0 | 0 | 0 | 0 | 0 |
| .zed | 1 | 0 | 0 | 0 | 0 | 0 |
| artifacts | 19 | 0 | 0 | 0 | 0 | 1 |
| bunfig.toml | 1 | 0 | 0 | 0 | 0 | 0 |
| CONTEXT.md | 1 | 0 | 0 | 0 | 0 | 0 |
| flake.lock | 1 | 0 | 0 | 0 | 0 | 0 |
| flake.nix | 1 | 0 | 0 | 0 | 0 | 0 |
| github | 10 | 0 | 0 | 0 | 0 | 0 |
| infra | 8 | 0 | 0 | 0 | 0 | 0 |
| nix | 6 | 0 | 0 | 0 | 0 | 0 |
| perf | 1 | 0 | 0 | 0 | 0 | 0 |
| README.ar.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.bn.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.br.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.bs.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.da.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.de.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.es.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.fr.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.gr.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.it.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.ja.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.ko.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.no.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.pl.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.ru.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.th.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.tr.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.uk.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.vi.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.zh.md | 1 | 0 | 0 | 0 | 0 | 0 |
| README.zht.md | 1 | 0 | 0 | 0 | 0 | 0 |
| screenshot-uk.png | 1 | 0 | 0 | 0 | 0 | 0 |
| specs | 14 | 0 | 0 | 0 | 0 | 0 |
| sst-env.d.ts | 1 | 0 | 0 | 0 | 0 | 0 |
| sst.config.ts | 1 | 0 | 0 | 0 | 0 | 0 |
| STATS.md | 1 | 0 | 0 | 0 | 0 | 0 |
| tsconfig.json | 1 | 0 | 0 | 0 | 0 | 0 |
| turbo.json | 1 | 0 | 0 | 0 | 0 | 0 |

Upstream infrastructure that Hordecode cannot run (`infra/`, `sst.config.ts`, `github/`, `STATS.md`, the `stats`/`deploy`/`docs-update`/`opencode` workflows, the translated READMEs, `artifacts/`) is kept at parity on purpose: it is not part of the product, and keeping it identical to upstream makes every port a clean fast-forward for those paths. It is never rebranded or hand-edited.

## Working rules

1. Before editing any file, look it up in `docs/upstream-map-files.tsv`. PARITY and LAGGING files are not edited by hand.
2. A FORK_DELTA edit cites the upstream file:line and, where the behavior comes from MiMo, the MiMo file:line.
3. A port is complete only when: the code lands, `hordecodeBase` is bumped, and a `git merge -s ours <upstream tag>` marker commit records the new ancestry. Then regenerate this map.
4. If neither upstream nor MiMo has the answer, report it; do not invent. Humans decide.
