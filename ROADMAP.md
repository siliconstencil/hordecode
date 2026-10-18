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

## 0.1.2 (in progress)

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
- Port the web, desktop and shared UI packages to the current base.
- Publish the benchmark method and results in the repository.
