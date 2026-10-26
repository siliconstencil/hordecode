# Roadmap

## Upstream tracking

- **opencode 1.x.** Hordecode 0.1.x follows the opencode 1.x line. Every 1.x release upstream
  publishes is ported before the next Hordecode release. If upstream stops publishing 1.x
  releases, Hordecode stays on the last one and maintains it.
- **opencode 2.x.** The 2.x line is a restructured product, followed for reference. Building a
  later Hordecode line on it is a separate decision, made when users ask for it.
- **MiMo Code.** The supervisor and harness designs come from MiMo Code 0.1.11. From 0.1.12
  MiMo Code changed its orchestrator, so its later changes are taken one by one when they help
  Hordecode.

How a port is done and recorded: [docs/UPSTREAM-MAP.md](docs/UPSTREAM-MAP.md) and
[docs/FORK-RULES.md](docs/FORK-RULES.md).

## 0.1.4 (in progress)

- Base: opencode 1.19.4, the latest 1.x release.
- Command palette: every listed command runs; commands that cannot run in the current context
  stay out of the list.
- Configuration: model group names in `model`, warnings for unknown keys,
  `experimental.primary_tools` for subagents, saved workflows by name, `mcp remove`.
- Proofs on the installed binary: a memory benchmark and a long soak run.

## 0.1.3 (released 2026-10-25)

- Base: opencode 1.19.4, including the web, desktop and shared UI packages.
- Security: protected credential files, an optional permission audit log and an optional
  command sandbox on Linux.
- Cost and cache: the prompt cache state in the sidebar, `cachePromptTTL` and one hour cache
  write pricing.
- Memory: on-device embeddings for hybrid search on Linux, Windows and macOS on Apple silicon.

## 0.1.2 (released 2026-10-20)

- Base: opencode 1.19.3.
- Supervisor: nested subagents to a configurable depth, a configurable number of subagents
  running at once, and fixes to run, wait, notification and message handling.
- Network: update checks that never install by themselves, a verified install script, model
  requests that identify Hordecode, and a page listing every outbound connection
  ([docs/NETWORK.md](docs/NETWORK.md)).
- Footprint: a smaller npm install.
- Proofs on the installed binary: cost visibility, a memory benchmark and a long soak run.

## Next

- Port each new opencode 1.x release.
- Publish the benchmark method and results in the repository.
