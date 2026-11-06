# rnd/dev-0.1.6-steps

Branch: `dev/0.1.6-steps` (worktree `build-worktrees/p3-steps`). Feature base: `db0cf05f3a`.
Scope: a user-settable step limit (config key + TUI entry + docs). No upstream port, no re-port.

## Observation

- A step limit could be expressed in two places only before this branch: per agent
  (`agent.<name>.steps`, `packages/core/src/v1/config/agent.ts:34`) and per subagent spawn
  (`PromptInput.steps`, `packages/opencode/src/session/prompt.ts:2811-2813`). There was no key that
  bounded every agent at once.
- The fork's session loop already carried a hard-coded ceiling of 100 steps:
  `packages/opencode/src/session/prompt.ts` read `const maxSteps = steps ?? agent.steps ?? 100`
  before `a9bcb4d171`. The number was not configurable. The only other bound was the fork-only
  200-step safety cap at `packages/opencode/src/session/prompt.ts:1589-1594`.
- User-visible effect: a project-wide cost ceiling could not be written into the config file at
  all; it had to be repeated per agent entry.

## Root cause

A missing feature, not a defect. The fork's loop predates a root-level step key. Upstream
opencode 1.19.5 has no root-level `steps` either (its `agent` key sits at
`packages/core/src/v1/config/config.ts:96` in `v1.19.5`, and the fork records the same fact in its
provenance comment at `packages/core/src/v1/config/config.ts:132-134`), and MiMo Code v0.1.11 has
none (same comment).

## Action

| Commit | Change |
|---|---|
| `a9bcb4d171` | `feat(opencode)`: global `steps` config key, its two consumption sites, targeted tests |
| `b3fbb7940f` | `feat(tui)`: "Step limit" command-palette entry that writes the root-level `steps` key |
| `064a979086` | `fix(web)`: MDX comment syntax so the docs build |
| `44254f5c2d` | `docs(web)`: the `### Steps` section in the config reference |

### 1. `a9bcb4d171` - the global config key

- New root-level key `steps` in `ConfigV1.Info`:
  `packages/core/src/v1/config/config.ts:135` (`Schema.optional(PositiveInt)`), described at
  `packages/core/src/v1/config/config.ts:136-138`. `PositiveInt` is
  `Schema.Int.check(Schema.isGreaterThan(0))` (`packages/schema/src/schema.ts:3`), so the value must
  be an integer greater than zero.
- Two consumption sites in the session loop, both reading the key live (no restart needed):
  - `packages/opencode/src/session/prompt.ts:1986-1988` - the loop itself:
    `const globalSteps = (yield* config.get()).steps`, `const maxSteps = steps ?? agent.steps ?? globalSteps ?? 100`.
  - `packages/opencode/src/session/prompt.ts:1465-1466` - the DSML salvage path, which must not
    spend more steps than the loop would allow:
    `if (input.step >= (input.steps ?? agent.steps ?? globalSteps ?? 100)) return undefined`.
- Hard vs soft: a spawn-level budget is a hard cap (the loop ends after the last allowed step,
  `packages/opencode/src/session/prompt.ts:2565-2568`, `site: "steps:cap"`). `agent.steps` and the
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

### 3. `064a979086` + `44254f5c2d` - the docs

- `064a979086` converted two HTML comments to MDX comment syntax so the docs build.
- `44254f5c2d` added the `### Steps` section to the config reference
  (`packages/web/src/content/docs/config.mdx:563-587`), with the fork provenance comment at
  `packages/web/src/content/docs/config.mdx:563` citing `packages/core/src/v1/config/config.ts:135`
  and upstream `1.19.5 config.mdx:563`.

## The config key

Name: `steps`, at the root of the config file (not under `agent`).

Rationale: the limit has to apply to every agent, including agents the user did not write down.
The per-agent key (`agent.<name>.steps`) cannot cover built-in and dynamically created agents, and
the spawn key (`PromptInput.steps`) is only reachable from code that spawns a subagent. A root-level
key is the only place that reaches all of them, and it matches how the loop already resolved the
limit (`packages/opencode/src/session/prompt.ts:1987`).

Type: positive integer (`packages/core/src/v1/config/config.ts:135` +
`packages/schema/src/schema.ts:3`).

## Precedence and default

The limit of a session is the first of these that is set
(`packages/opencode/src/session/prompt.ts:1987`):

1. `steps` budget the session was spawned with - HARD cap, the loop ends when the budget is used up
   (`packages/opencode/src/session/prompt.ts:2565-2568`).
2. `agent.<name>.steps` - SOFT limit, the last allowed step is forced to text
   (`packages/opencode/src/session/prompt.ts:1988`, `:2220`).
3. global `steps` - SOFT limit, the last allowed step is forced to text
   (`packages/opencode/src/session/prompt.ts:1986`, `:1988`, `:2220`).
4. default `100` (`packages/opencode/src/session/prompt.ts:1987`).

The global key therefore does not lower an agent's own `steps` and does not raise a spawn budget.
The same expression guards the DSML salvage path
(`packages/opencode/src/session/prompt.ts:1466`).

## Evidence

All commands were run in the foreground from `/home/hank/Desktop/developer/build-worktrees/p3-steps`
with `TMPDIR=/home/hank/Desktop/developer/build-worktrees/tmp` exported before every build or test
command.

### Targeted test (agent run, this branch)

```
cd packages/opencode && bun test --timeout 30000 test/session/step-limit.test.ts
 4 pass
 0 fail
 10 expect() calls
Ran 4 tests across 1 file. [12.81s]
TARGETED_TEST_EXIT=0
```

The four cases (`packages/opencode/test/session/step-limit.test.ts:30,60,88,120`):
the global limit forces the text-only answer at the configured step; the agent limit wins over the
global limit; the spawn budget wins over the agent limit; without a configured limit the loop does
not force the text answer early.

### Measurements made by the coordinator (not by an agent)

- The B.1 targeted test was measured by the coordinator at **4 pass / 0 fail** on commit `a9bcb4d171`.
- The coordinator measured `packages/tui` typecheck at **exit 0** at HEAD `064a979086`.

Both numbers are coordinator measurements and are quoted as such; the agent measurement above is a
second, independent run of the same targeted file on this branch's HEAD.

### Per-package typecheck and tests (agent run, this branch)

```
cd packages/tui     && bun run typecheck   -> exit 0
cd packages/tui     && bun run test        -> 417 pass, 1 skip, 0 fail, 418 tests across 85 files, 8.73s, exit 0
cd packages/core    && bun run typecheck   -> exit 0
cd packages/opencode && bun run typecheck  -> exit 0
```

### Docs build (agent run, this branch)

```
cd packages/web && bun run build
  Indexed 648 pages
  Server built in 70.63s
  [build] Complete!
WEB_BUILD_EXIT=0
```

The built page carries the new section: `dist/docs/config/index.html` contains `id="steps"`, the
sentence "default step limit for every agent with the", and the link
`href="/docs/agents#max-steps"`. The target heading exists: `### Max steps` is at
`packages/web/src/content/docs/agents.mdx:291`.

### Schema proof: the generated JSON contains the root-level `steps` key

The config JSON schema is generated from `ConfigV1.Info` by `packages/opencode/script/schema.ts`
(`Schema.toJsonSchemaDocument` at `:12`, `Bun.write` at `:72`). It is invoked from
`packages/web/astro.config.mjs:321` and from `nix/opencode.nix:57`.

```
cd packages/opencode
bun --bun ./script/schema.ts /home/hank/Desktop/developer/build-worktrees/tmp/config-schema-proof.json
/home/hank/Desktop/developer/build-worktrees/tmp/config-schema-proof.json
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

## OPEN DECISION: the 200-step safety cap bounds every configured value

`packages/opencode/src/session/prompt.ts:1589-1594`:

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
`packages/opencode/src/session/prompt.ts:1589-1592` records that an unbounded loop hung in practice
and that the cap must not be reverted before that hang is root-caused; raising or removing it is an
owner decision with a recorded failure mode behind it. The cheap, reversible half of option 1 is to
make the TUI not offer a value the loop silently overrides (drop 300 from
`packages/tui/src/component/dialog-step-limit.tsx:14`, or document the ceiling next to it), and to
add the ceiling to the docs section, which currently states only "The value must be a positive
integer" (`packages/web/src/content/docs/config.mdx:575`).

Nothing in this branch changes, raises or removes the cap.

## Deviations from the task spec

1. **The `### Steps` section lives in `config.mdx`, not `agents.mdx`.** Reason: `steps` is a root
   level config key and `config.mdx` is the reference page for config keys, while `agents.mdx`
   documents agent-level options. Ownership class decides the edit: `config.mdx` is FORK_DELTA
   (`docs/upstream-map-files.tsv:6579`), so the fork hunk is allowed there with one provenance line
   (used, `packages/web/src/content/docs/config.mdx:563`); `agents.mdx` is PARITY
   (`docs/upstream-map-files.tsv:6508`) and PARITY/LAGGING files are never hand-edited
   (`AGENTS.md`, fork rules).
2. **No cross-reference sentence was added to the `### Max steps` section of `agents.mdx`.** It was
   requested, but `packages/web/src/content/docs/agents.mdx` is PARITY
   (`docs/upstream-map-files.tsv:6508`) and therefore never hand-edited. Its 17 locale copies
   (`packages/web/src/content/docs/<locale>/agents.mdx`) are PARITY as well
   (`docs/upstream-map-files.tsv:6510,6544,6582,6616,6652,6687,6726,6760,6795,6832,6868,6905,6940,6979,7015,7054,7088`),
   so a translated sentence would have had to be added 18 times into files that must not change.
   Fork hunks in the English docs are not mirrored into the locale copies in this tree: the locale
   `config.mdx` files carry no fork provenance comment at all (measured: `grep -c "{/\* Hordecode"`
   returns 0 for `packages/web/src/content/docs/tr/config.mdx`, while the English file has two,
   at `:563` and `:674`), and the locale `config.mdx` files are still upstream on the fork hunk at
   `packages/web/src/content/docs/config.mdx:674`. The cross-reference was therefore dropped, and
   the reader path is documented in the report instead.
3. **The 200-step cap is not mentioned in `config.mdx`.** It is an open owner decision (above), so
   the committed docs do not freeze behaviour that may change. Follow-up if the cap stays: one
   sentence stating the effective ceiling, and the 300 preset question.

## Findings not fixed here (post-release backlog)

1. **The fork twin of the session loop does not know the global key.**
   `packages/core/src/session/prompt.ts:2480` still reads
   `const maxSteps = steps ?? agent.steps ?? Infinity` and has no 200-step cap. It is mounted:
   `packages/core/src/session/prompt.ts` is imported by `packages/supervisor/src/spawn.ts:6` and
   `packages/opencode/src/effect/supervisor-node.ts:3`, and `Prompt.prompt` reaches that `runLoop`
   (`packages/core/src/session/prompt.ts:438` -> `:3135` -> `:2480`). The supervisor passes its own
   spawn budget down (`packages/supervisor/src/spawn.ts:474`, `:980`, `:1112`), so a budgeted
   subagent is still capped; a turn with no budget and no `agent.steps` is unbounded there. Whether
   that path is live for user-visible agent turns was not settled in this report. The live copy
   (`packages/opencode/src/session/prompt.ts`) is the one this branch changed.
2. **The web build's schema hook does not run in this tree.** `packages/web/astro.config.mjs:321`
   spawns `../opencode/script/schema.ts` with the working directory `packages/web`; that fails with
   `SyntaxError: Export named 'jsxDEV' not found in module .../solid-js/dist/solid.js`, because the
   web tsconfig sets `"jsxImportSource": "solid-js"`
   (`packages/web/tsconfig.json:6-7`) while the script imports the TSX TUI config. The same script
   succeeds from `packages/opencode` (the `nix/opencode.nix:57` working directory), with or
   without `--bun`. None of `packages/opencode/script/schema.ts`,
   `packages/tui/src/config/index.tsx` or `packages/web/tsconfig.json` was touched by this branch
   (measured with `git diff --name-only db0cf05f3a..HEAD`), so this is pre-existing. Effect: the
   docs build does not emit `dist/config.json` here; the shipped schema comes from the nix build.
3. **`packages/web/src/content/docs/agents.mdx:295` is stale in the fork.** It says that an agent
   without `steps` "will continue to iterate until the model chooses to stop", but the fork's
   default is 100 (`packages/opencode/src/session/prompt.ts:1987`). The file is PARITY, so it was
   not touched; fixing it needs an ownership decision.
