# rnd/dev-0.1.6-steps

Branch: `dev/0.1.6-steps` (worktree `build-worktrees/p3-steps`). Feature base: `db0cf05f3a`.
Scope: a user-settable step limit (config key + TUI entry + the fork session twin). No upstream port,
no re-port.

## Observation

- A step limit could be expressed in two places only before this branch: per agent
  (`agent.<name>.steps`, `packages/core/src/v1/config/agent.ts:34`) and per subagent spawn
  (`PromptInput.steps`, `packages/opencode/src/session/prompt.ts:1457`, `:1526-1527`). There was no
  key that bounded every agent at once.
- The fork's session loop already carried a hard-coded ceiling of 100 steps:
  `packages/opencode/src/session/prompt.ts` read `const maxSteps = steps ?? agent.steps ?? 100`
  before `a9bcb4d171`. The number was not configurable. The only other bound was the fork-only
  200-step safety cap at `packages/opencode/src/session/prompt.ts:1588-1594`.
- The fork twin of the loop (`packages/core/src/session/prompt.ts`) ignored the key entirely:
  `const maxSteps = steps ?? agent.steps ?? Infinity` at `:2480` before `d607bdbf69`. That twin is
  mounted on a live path: `packages/supervisor/src/spawn.ts:6` imports it as `SessionPrompt` and
  `packages/opencode/src/effect/supervisor-node.ts:3` imports it as `CoreSessionPrompt`.
- User-visible effect: a project-wide cost ceiling could not be written into the config file at
  all; it had to be repeated per agent entry, and a supervisor-spawned session did not see a global
  limit even when one was configured.

## Root cause

A missing feature, not a defect. The fork's loop predates a root-level step key. Upstream
opencode 1.19.5 has no root-level `steps` either (its `agent` key sits at
`packages/core/src/v1/config/config.ts:96` in `v1.19.5`, and the fork records the same fact in its
provenance comment at `packages/core/src/v1/config/config.ts:132-134`), and MiMo Code v0.1.11 has
none (same comment).

The twin was a second copy of the loop, so it carried its own copy of the limit resolution: the
global key was added to the live copy only, and the twin kept the pre-feature expression.

## Action

| Commit | Change |
|---|---|
| `a9bcb4d171` | `feat(opencode)`: global `steps` config key, its two consumption sites, targeted tests |
| `b3fbb7940f` | `feat(tui)`: "Step limit" command-palette entry that writes the root-level `steps` key |
| `064a979086` | `fix(web)`: MDX comment syntax so the docs build (reverted by `ab62ea25b2`) |
| `44254f5c2d` | `docs(web)`: the `### Steps` section in the config reference (reverted by `1f832afd02`) |
| `56c701dcbc` | `docs(rnd)`: this report |
| `1f832afd02`, `ab62ea25b2` | the two `packages/web` commits reverted (owner decision, see section 4) |
| `d607bdbf69` | `fix(core)`: the fork session twin honours the global step limit |

`git diff --name-only db0cf05f3a..HEAD -- packages/web` is empty: no file under `packages/web` is
touched by the final tree.

### 1. `a9bcb4d171` - the global config key

- New root-level key `steps` in `ConfigV1.Info`:
  `packages/core/src/v1/config/config.ts:135` (`Schema.optional(PositiveInt)`), described at
  `packages/core/src/v1/config/config.ts:136-138`. `PositiveInt` is
  `Schema.Int.check(Schema.isGreaterThan(0))` (`packages/schema/src/schema.ts:3`), so the value must
  be an integer greater than zero.
- Two consumption sites in the session loop, both reading the key live (no restart needed):
  - `packages/opencode/src/session/prompt.ts:1986-1987` - the loop itself:
    `const globalSteps = (yield* config.get()).steps`, `const maxSteps = steps ?? agent.steps ?? globalSteps ?? 100`.
  - `packages/opencode/src/session/prompt.ts:1466` - the DSML salvage path, which must not
    spend more steps than the loop would allow:
    `if (input.step >= (input.steps ?? agent.steps ?? globalSteps ?? 100)) return undefined`.
- Hard vs soft: a spawn-level budget is a hard cap (the loop ends after the last allowed step,
  `packages/opencode/src/session/prompt.ts:2566`, `site: "steps:cap"`). `agent.steps` and the
  global `steps` are soft limits: on the last allowed step the request carries the max-steps system
  prompt and `tool_choice: "none"`, so the model answers with text only
  (`packages/opencode/src/session/prompt.ts:2220-2226`, and the same shape at `:2391-2397` and
  `:2415-2421`).
- Tests: `packages/opencode/test/session/step-limit.test.ts` (4 cases, listed under Evidence).

### 2. `b3fbb7940f` - the TUI entry

- Dialog: `packages/tui/src/component/dialog-step-limit.tsx`. It writes the root-level `steps` key of
  the main user config (`stepLimitPatch`, `:28-30`) through
  `sdk.client.global.config.update` (`:49`), so the value is read by the loop on the next step.
- Presets `[100, 200, 300]` (`packages/tui/src/component/dialog-step-limit.tsx:14`) plus a custom
  value; the custom value must be a positive integer (`parseStepLimit`, `:17-22`, rejects 0,
  negatives, text and non-integers).
- Palette command `step.limit`, category "System" (`packages/tui/src/feature-plugins/system/step-limit.tsx:14-21`),
  registered in the builtin plugin list (`packages/tui/src/feature-plugins/builtins.ts:21,51`).
- Six i18n keys in `packages/tui/src/i18n/en.ts:300-305` and `packages/tui/src/i18n/tr.ts:420-425`.
- Tests: `packages/tui/test/component/dialog-step-limit.test.ts` (6 cases).

### 3. `d607bdbf69` - the fork session twin

- The twin now reads the global key from the config service it already uses:
  `packages/core/src/session/prompt.ts:2484`
  `const globalSteps = (yield* config.get()).steps`, and `:2485`
  `const maxSteps = steps ?? agent.steps ?? globalSteps ?? Infinity`.
  The precedence is identical to the live copy: spawn budget (hard) > `agent.steps` (soft) >
  global `steps` (soft) > the twin's own fallback.
- The twin takes the config service from the core module
  (`packages/core/src/session/prompt.ts:67` imports `Config` from `../config/index`, `:355` takes
  `Config.Service`), and its own layer graph provides the core config service
  (`packages/core/src/session/prompt.ts:3228` provides `Config.defaultLayer`). The twin therefore
  reads the CORE config service, not the app's.
- That is why the core schema needs the key. The core config service loads the global config file
  (`packages/core/src/config/config.ts:717`, `~/.config/hordecode/config.json`) and parses it with
  the strict core schema (`packages/core/src/config/config.ts:566-568`, `Info = zod(InfoSchema).strict()`;
  the load path is `ConfigParse.jsonc` + `ConfigParse.schema` at `:685-686`). The TUI writes that
  same file through `sdk.client.global.config.update`, and the core service writes it back
  (`packages/core/src/config/config.ts:734`). Once the global `steps` key exists in that file, a
  strict schema without the key rejects the file and the twin's config load breaks.
- The core schema therefore gains the root-level key:
  `packages/core/src/config/config.ts:199`
  `steps: Schema.optional(PositiveInt)`, mirroring `packages/core/src/v1/config/config.ts:135`.
- The mirror comment in the live copy was moved with the code:
  `packages/opencode/src/session/prompt.ts:1984` cites `core/src/session/prompt.ts:2485`.
- Tests: `packages/opencode/test/session/step-limit-fork-twin.test.ts` (5 cases: two source
  assertions on the twin's own resolution, two on the core config side, one runtime case on the
  app config service). Red-then-green evidence is under Evidence.

### 4. The docs are not in this repository

Owner decision: `packages/web` is the UPSTREAM docs site and stays at PARITY; it is never
hand-edited. The Hordecode docs site lives outside this repository
(`/home/hank/Desktop/Silicon-Stencil/web/hordecode/`) and is updated in the RELEASE phase, not now.

Consequence for this branch: the two `packages/web` commits were reverted
(`1f832afd02`, `ab62ea25b2`) and the branch carries no docs hunk at all. The ready-to-paste
`### Steps` docs section for the release phase lives in the coordinator's report at
`/home/hank/Desktop/developer/reports/0.1.6/p3-steps-report.md` (section "Ready-to-paste docs
section (release phase)"); it is referenced here, not duplicated, so the section has exactly one
source. Nothing in this branch touches `packages/web`.

## The config key

Name: `steps`, at the root of the config file (not under `agent`).

Rationale: the limit has to apply to every agent, including agents the user did not write down.
The per-agent key (`agent.<name>.steps`) cannot cover built-in and dynamically created agents, and
the spawn key (`PromptInput.steps`) is only reachable from code that spawns a subagent. A root-level
key is the only place that reaches all of them, and it matches how the loop already resolved the
limit (`packages/opencode/src/session/prompt.ts:1987`).

Type: positive integer (`packages/core/src/v1/config/config.ts:135` +
`packages/schema/src/schema.ts:3`). The same key exists in the core schema
(`packages/core/src/config/config.ts:199`) for the reason given in section 3.

## Precedence and default

The limit of a session is the first of these that is set
(`packages/opencode/src/session/prompt.ts:1987`):

1. `steps` budget the session was spawned with - HARD cap, the loop ends when the budget is used up
   (`packages/opencode/src/session/prompt.ts:2566`).
2. `agent.<name>.steps` - SOFT limit, the last allowed step is forced to text
   (`packages/opencode/src/session/prompt.ts:1988`, `:2220`).
3. global `steps` - SOFT limit, the last allowed step is forced to text
   (`packages/opencode/src/session/prompt.ts:1986`, `:1987`, `:2220`).
4. default `100` (`packages/opencode/src/session/prompt.ts:1987`).

The global key therefore does not lower an agent's own `steps` and does not raise a spawn budget.
The same expression guards the DSML salvage path
(`packages/opencode/src/session/prompt.ts:1466`).

The fork twin resolves the same chain
(`packages/core/src/session/prompt.ts:2485`): spawn budget > `agent.steps` > global `steps` > the
twin's own fallback. The fallback is `Infinity` there, not `100`, and the twin has no 200-step cap
(measured: `grep -n "> 200" packages/core/src/session/prompt.ts` returns nothing). Both differences
are left untouched on purpose; see OPEN DECISION 2.

## Evidence

All commands were run in the foreground from `/home/hank/Desktop/developer/build-worktrees/p3-steps`
with `TMPDIR=/home/hank/Desktop/developer/build-worktrees/tmp` exported before every build or test
command.

### Targeted tests (agent run, this branch, at `d607bdbf69`)

```
cd packages/opencode && bun test --timeout 30000 test/session/step-limit-fork-twin.test.ts test/session/step-limit.test.ts
 9 pass
 0 fail
 15 expect() calls
Ran 9 tests across 2 files. [12.45s]
```

The four cases of `packages/opencode/test/session/step-limit.test.ts` (`:30,60,88,120`):
the global limit forces the text-only answer at the configured step; the agent limit wins over the
global limit; the spawn budget wins over the agent limit; without a configured limit the loop does
not force the text answer early.

The five cases of `packages/opencode/test/session/step-limit-fork-twin.test.ts`:
the twin reads the global key from its own config service; the twin keeps the spawn > agent >
global > fallback precedence; the core config schema accepts the root-level `steps` key; the core
config load path accepts a global config file that carries `steps`; the app config service exposes
a user-set global `steps` at runtime.

### Red-then-green proof for the twin (agent run, this branch)

Red: the pre-fix twin was put back into the working tree with
`git checkout HEAD~1 -- packages/core/src/session/prompt.ts` after the commit, so the commit itself
stayed intact (no stash, no reset).

```
cd packages/opencode && bun test --timeout 30000 test/session/step-limit-fork-twin.test.ts
(fail) fork session twin > reads the global step limit from the config service it already uses [0.91ms]
(fail) fork session twin > keeps the spawn, agent, global and fallback precedence of the main loop [0.08ms]
 3 pass
 2 fail
 5 expect() calls
Ran 5 tests across 1 file. [2.81s]
```

The two failures show the pre-fix twin exactly: `Received: [ "const maxSteps = steps ?? agent.steps
?? Infinity", "const isLastStep = step >= maxSteps" ]`.

Green: `git checkout HEAD -- packages/core/src/session/prompt.ts` restored the committed twin.

```
cd packages/opencode && bun test --timeout 30000 test/session/step-limit-fork-twin.test.ts
 5 pass
 0 fail
 5 expect() calls
Ran 5 tests across 1 file. [1.79s]
```

`git status --short` was empty after the restore.

### Measurements made by the coordinator (not by an agent)

- `packages/core` typecheck: **exit 0**.
- `packages/tui` typecheck: **exit 0**.
- `packages/tui` test: **417 pass / 1 skip / 0 fail** (418 tests, 85 files, 8.53s).
- `packages/opencode` typecheck: **exit 0**.
- `packages/opencode` FULL suite: **4728 pass / 25 skip / 1 todo / 0 fail** (4754 tests, 441 files,
  50 snapshots, 17434 expect() calls, 905.21s).
- The B.1 targeted test was measured at **4 pass / 0 fail** on commit `a9bcb4d171`.

These are coordinator measurements and are quoted as such.

### Per-package typecheck (agent run, this branch, at `d607bdbf69`)

```
cd packages/core     && bun run typecheck   -> exit 0
cd packages/opencode && bun run typecheck   -> exit 0
```

The full `packages/opencode` suite was not re-run by this agent (905 s); the coordinator's run above
covers it. The `packages/tui` typecheck and test numbers are the coordinator's.

### Schema proof: the generated JSON contains the root-level `steps` key

The config JSON schema is generated from `ConfigV1.Info` by `packages/opencode/script/schema.ts`
(`Schema.toJsonSchemaDocument` at `:12`, `Bun.write` at `:72`). It is invoked from
`packages/web/astro.config.mjs:321` and from `nix/opencode.nix:57`.

The generator was run FROM `packages/opencode`, which is the working directory `nix/opencode.nix:57`
uses:

```
cd packages/opencode
bun --bun ./script/schema.ts /home/hank/Desktop/developer/build-worktrees/tmp/config-schema-proof.json
EXIT=0
-rw-rw-r-- 1 hank hank 76703 Nov  5 21:15 /home/hank/Desktop/developer/build-worktrees/tmp/config-schema-proof.json
```

Grep of the generated document:

```
$ grep -n '"steps"' /home/hank/Desktop/developer/build-worktrees/tmp/config-schema-proof.json
239:        "steps": {
1148:        "steps": {
```

Line 239 is the agent-level key inside `"AgentConfig"` (def starts at `:169`). Line 1148 is the
root-level key inside `"Config"` (def starts at `:860`); the generated document root is
`"$ref": "#/$defs/Config"`:

```
1146:          "description": "Agent configuration, see https://opencode.ai/docs/agents"
1147:        },
1148:        "steps": {
1149:          "exclusiveMinimum": 0,
1150:          "type": "integer",
1151:          "maximum": 9007199254740991,
1152:          "description": "Default maximum number of agentic iterations before the model is forced to answer with text only. Applies to every agent that does not set its own 'steps'. Overridden by 'agent.<name>.steps'. Default: 100."
1153:        },
```

`"exclusiveMinimum": 0` with `"type": "integer"` is the machine-readable form of "positive integer",
and the description matches the schema annotation at
`packages/core/src/v1/config/config.ts:136-138`. The generator was run to a path under
`build-worktrees/tmp`; no generated file was hand-edited, and no generated artifact is committed.

The same generator run FROM `packages/web` (the working directory
`packages/web/astro.config.mjs:321` uses) fails in this tree for a pre-existing reason; see
OPEN DECISION 3.

## OPEN DECISION 1: the 200-step safety cap bounds every configured value

`packages/opencode/src/session/prompt.ts:1588-1595`:

```ts
// Intentional divergence from v0.1.11 (packages/opencode/src/session/prompt.ts:3251,3661),
// which uses while(true) + agent.steps ?? Infinity. Fork caps at the global `steps` config key,
// else 100/200, because an unbounded loop hung in practice (see commit f6cac78ae0).
// Do not revert to Infinity without first root-causing that hang.
if (step > 200) {
  yield* Effect.logWarning("rl:hard-cap breached, forcing exit", { "session.id": sessionID, step })
  break
}
```

Consequence: this cap is checked before the configured limit is consulted, so a configured value
above 200 never takes effect in this loop. The TUI preset 300
(`packages/tui/src/component/dialog-step-limit.tsx:14`) is therefore unreachable there. The same was
already true before this branch for a per-agent `steps` above 200.

Options:

1. Leave the cap at 200 and flag the 300 preset (the TUI offers a value the server cannot honour).
2. Raise the cap (for example to 1000) and keep 300 reachable.
3. Let the cap follow the configured limit (remove the fixed 200 and rely on the configured value).

Recommendation: **option 1, leave the cap alone.** The comment at
`packages/opencode/src/session/prompt.ts:1588-1591` records that an unbounded loop hung in practice
and that the cap must not be reverted before that hang is root-caused; raising or removing it is an
owner decision with a recorded failure mode behind it. The cheap, reversible half of option 1 is to
make the TUI not offer a value the loop silently overrides (drop 300 from
`packages/tui/src/component/dialog-step-limit.tsx:14`, or document the ceiling next to it), and to
add the ceiling to the release-phase docs section, which currently states only "The value must be a
positive integer".

Nothing in this branch changes, raises or removes the cap.

## OPEN DECISION 2: the twin keeps `Infinity` as its fallback and has no 200-cap

The live copy resolves the budget as `steps ?? agent.steps ?? globalSteps ?? 100`
(`packages/opencode/src/session/prompt.ts:1987`). The fork twin resolves the same chain but falls
back to `Infinity` (`packages/core/src/session/prompt.ts:2485`), and it has no 200-step cap
(measured: `grep -n "> 200" packages/core/src/session/prompt.ts` returns nothing, while the live
copy has it at `packages/opencode/src/session/prompt.ts:1592`).

Consequence: a supervisor-spawned session with no spawn budget, no `agent.steps` and no global
`steps` is unbounded on the twin's path, while the live copy is bounded at 100 steps. The global key
now reaches the twin, but the two defaults still differ.

Options:

1. Leave both as they are: the twin's `Infinity` fallback and its missing cap.
2. Unify the fallback with the live copy's `100`.
3. Unify the fallback and give the twin the same 200-step safety cap.

Recommendation: **option 1 for this branch, option 2 as the owner decision to take next.** The twin's
fallback and the 200-cap are separate changes with separate failure modes (the 200-cap is recorded
in OPEN DECISION 1 and must not be copied before that hang is root-caused). Changing the fallback
from `Infinity` to `100` is a behaviour change on the supervisor path that this branch did not
measure, so it is an owner decision rather than a mechanical edit.

## OPEN DECISION 3: the web build cannot produce `dist/config.json` in this tree

`packages/web/astro.config.mjs:321` spawns `../opencode/script/schema.ts` with the working
directory `packages/web`. In this tree that run fails for a pre-existing reason: the script's
import graph reaches the TSX TUI config and `packages/web/tsconfig.json:6-7` sets
`"jsxImportSource": "solid-js"`, so the import dies with
`SyntaxError: Export named 'jsxDEV' not found in module .../solid-js/dist/solid.js`. The same
script succeeds from `packages/opencode` (the working directory `nix/opencode.nix:57` uses), with or
without `--bun`, which is how the schema proof above was produced.

None of `packages/opencode/script/schema.ts`, `packages/tui/src/config/index.tsx` or
`packages/web/tsconfig.json` was touched by this branch (measured with
`git diff --name-only db0cf05f3a..HEAD`), so the failure is pre-existing. Effect: the docs build
here emits no `dist/config.json`; the shipped schema comes from the nix build.

Decision needed: whether the web build must emit a schema file in this tree, and if so, whether the
generator's import graph or the web tsconfig is the side that changes. Not resolved here.

## OPEN DECISION 4: `packages/web/src/content/docs/agents.mdx:295` is stale in the fork

It says that an agent without `steps` "will continue to iterate until the model chooses to stop",
while the fork default is 100 (`packages/opencode/src/session/prompt.ts:1987`). The file is PARITY
(`docs/upstream-map-files.tsv:6508`) and PARITY/LAGGING files are never hand-edited
(`AGENTS.md`, fork rules), so it was not touched. Fixing it needs an ownership decision, or a
sentence in the release-phase docs section of the Hordecode docs site.

## Deviations from the task spec

1. **The `### Steps` docs section is not in this repository.** Reason: owner decision.
   `packages/web` is the upstream docs site and stays at PARITY; the Hordecode docs site lives
   outside this repository and is updated in the release phase. The section is therefore not in
   `packages/web/src/content/docs/config.mdx` (nor in any other file of this repo), the two
   `packages/web` commits were reverted (`1f832afd02`, `ab62ea25b2`), and the ready-to-paste
   section lives in the coordinator's report at
   `/home/hank/Desktop/developer/reports/0.1.6/p3-steps-report.md`.
2. **No cross-reference sentence was added to the `### Max steps` section of `agents.mdx`.** It was
   requested, but `packages/web/src/content/docs/agents.mdx` is PARITY
   (`docs/upstream-map-files.tsv:6508`) and its 17 locale copies
   (`packages/web/src/content/docs/<locale>/agents.mdx`) are PARITY as well
   (`docs/upstream-map-files.tsv:6510,6544,6582,6616,6652,6687,6726,6760,6795,6832,6868,6905,6940,6979,7015,7054,7088`),
   so a translated sentence would have had to be added 18 times into files that must not change.
   The reader path belongs to the release-phase docs section instead.
3. **The 200-step cap is not documented in this repository.** It is an open owner decision
   (OPEN DECISION 1), so nothing here freezes behaviour that may change. Follow-up if the cap
   stays: one sentence stating the effective ceiling in the release-phase docs section, and the
   300 preset question.

## Findings not fixed here (post-release backlog)

1. **The core config service is not mounted in the fork-twin test.** The twin reads the core
   config service (`packages/core/src/session/prompt.ts:355`, provided by
   `packages/core/src/session/prompt.ts:3228`), but the core service carries the same
   `"@opencode/Config"` tag as the app's config service
   (`packages/core/src/config/config.ts:613`, `packages/opencode/src/config/config.ts:144`), it
   needs the core instance context, and its load path reads the real global config directory
   (`packages/core/src/config/config.ts:717`) and seeds a starter file there when none exists
   (`packages/core/src/config/config.ts:742-750`). The test therefore asserts the core side on the
   core load path's own parse functions (`packages/core/src/config/config.ts:685-686`) rather than
   on a mounted service. A dedicated core-package test that mounts the core config service against
   a temporary global config directory would close this gap.
2. **The core and the app config service share one tag.** The fork twin provides the core config
   service inside its own layer (`packages/core/src/session/prompt.ts:3228`), so it reads the core
   schema, while the rest of the app reads the app config service under the same tag. The same
   collision was already worked around elsewhere in the tree
   (`packages/core/src/tool/memory.ts:98-106`). It is not a defect of this branch, but it is the
   reason the schema key had to be added to the core schema as well.
