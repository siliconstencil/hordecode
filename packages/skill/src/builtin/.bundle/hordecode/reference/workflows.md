# Hordecode Dynamic Workflows Reference

Dynamic workflows orchestrate many subagents **deterministically** from a small JavaScript script: fan-out, pipelines, nested workflows. The script runs in a sandbox; it calls `agent()` to spawn work and combines results with plain JS.

## Running a workflow

Use the `workflow` tool (or ask the agent to run one):

| Operation | Purpose |
|-----------|---------|
| `run` | Start a run with `name` (a built-in workflow) **or** `script` (inline JS), never both. Optional `args`, `workspace` (absolute dir), `async` |
| `status` | Snapshot a run by `run_id` without blocking |
| `wait` | Block on a run's result (optional `timeout_ms`) |
| `cancel` | Best-effort cancel of a running workflow |
| `resume` | Re-launch a persisted run under the same `run_id` (journal replay makes it convergent) |

- By default `run` streams the transcript inline and returns the result.
- `async: true` returns a `run_id` at once; the result arrives as an inbox notification.
- Watch runs in the TUI: a bounded inline panel shows phase and status counters; select it, or use `/workflows`, to open the full page with per-agent cards and drill-down into each subagent's conversation.

## Built-in workflows

Runnable by `name` without writing a file:

- **`harness`**: unattended delivery pipeline (brainstorm, design, implement with TDD in parallel per-task worktrees, verify, review, report, then commit on a feature branch). Pass `args.task`; optional `type` (feature/bugfix/refactor/feedback), `feature_name`, `skip_brainstorm`, `skip_report`, `maxConcurrent`, `isolate_worktrees`. It never pushes, opens a PR or merges into the base branch; it reports the branch and the suggested closing commands.
- **`deep-research`**: cited research report (brief, plan angles, parallel research, reflect, single-writer report, cold review). Pass the question as a string, or `{ question, depth?: "quick" | "standard" | "deep", dir?, context? }`; the date is filled in by the host. Resumable from its file checkpoints. `/deep-research` runs it.
- **`fact-check`**: adversarial fact verification (plan, parallel web search, source extraction, grouping, 3-juror crosscheck, cited findings). Pass the question as `args`.
- **`research-experiment`**: autonomous metric-improvement loop (baseline, stateless iterations with keep/revert decided by the script, cheating audit, report traced to `results.tsv`). Pass `{ dir, goal, metric, evalCmd, editable }` plus optional `guardCmd`, `lowerIsBetter`, `maxIters`, `targetValue`; use the same `dir` as `workspace`.

### `harness` workflow vs `harness` agent

- **Workflow**: well-defined tasks that split into independent subtasks; runs non-interactively to completion.
- **Agent** (`Tab` to `harness`): exploratory or ambiguous work where you want to redirect mid-flow and answer questions.

## Writing a workflow

Save scripts as `.hordecode/workflows/<name>.js` (or `.claude/workflows/<name>.js`). A script calls a saved one with `workflow("<name>")`, found by file name, nearest-first from the cwd up to the worktree root. To run a saved file from the `workflow` tool, pass its contents as `script`.

Every workflow **must begin** with a `meta` export (a pure data literal; it is parsed, not executed):

```js
export const meta = {
  name: "triage-issues",              // required, non-empty
  description: "Triage open issues",   // required, non-empty
  whenToUse: "when the backlog needs sorting",          // optional
  phases: [{ title: "Fetch" }, { title: "Classify" }],  // optional
  // optional: permissions requested once at run start, inherited by the run's agents
  permissions: [{ permission: "bash", patterns: ["gh issue *"], reason: "read issues" }],
}

export default async function () {
  // ... orchestration ...
  return result   // becomes the workflow's result
}
```

## In-script API (sandbox globals)

| Global | Signature | Returns |
|--------|-----------|---------|
| `agent(prompt, opts?)` | spawn one subagent | Promise of its deliverable (text, or a validated object with `opts.schema`), or **`null`** on failure. Never throws |
| `parallel(thunks)` | run an array of `() => Promise` concurrently | `Promise<any[]>` (a throwing thunk rejects the batch) |
| `pipeline(items, ...stages)` | run each item through sequential stages, items in parallel | `Promise<any[]>` |
| `workflow(nameOrScript, args?, opts?)` | run a child workflow (saved name or inline script) and await it | Promise of the child result, or `null` on runtime failure |
| `readFile(path)` | read a workspace file | `Promise<string \| null>` (null if absent) |
| `writeFile(path, content)` | write a workspace file (creates dirs) | `Promise<void>` |
| `glob(pattern)` | list matching workspace paths (relative, sorted) | `Promise<string[]>` |
| `exists(path)` | whether a workspace path exists | `Promise<boolean>` |
| `phase(title)` | mark a progress phase | - |
| `log(message)` | emit a progress line | - |
| `args` | the JSON value passed at start | (value) |

File primitives are **jailed to the workspace root** (the worktree by default, or the `workspace` given at run). `..` and absolute escapes throw. Use `glob()` to enumerate work units instead of spawning an agent to list files.

### `agent()` options

```js
const out = await agent("Summarize src/parser.ts", {
  agentType: "explore",      // subagent type; default "general"
  model: "lite",             // provider/model literal or a model group name
  tools: ["read", "grep"],   // tool allowlist; omit to inherit
  schema: { type: "object", properties: { bug: { type: "string" } }, required: ["bug"] },
  isolation: "worktree",     // run in a fresh isolated worktree
  label: "parser-scan",      // observability tag
  timeoutMs: 120000,         // per-call timeout; on timeout resolves null
})
```

With `schema`, the deliverable is a **validated object**. Without it, you get the agent's final text. An unknown model group falls back to the run's model.

## Determinism constraints

The sandbox has no `Date`, `crypto`, `fetch`, timers or `process`; `Math.random` is a seeded PRNG, so a run replays identically on resume. Do network- or time-dependent work **inside** `agent()`.

## Semantics worth knowing

- **A failed `agent()` resolves to `null`**: check for it. A hung agent is cancelled and also yields `null`, so it cannot stall a `parallel`/`pipeline` barrier.
- **A failed child `workflow()` resolves to `null`** for runtime failures; **structural faults throw** up the whole tree: a cycle (a saved name calling itself), nesting deeper than 8 levels, or an unknown workflow name.
- **Limits**: one run spawns at most 1000 agents over its life (over-cap `agent()` returns `null`).
- **Concurrency** is one process-wide semaphore sized by `workflow.maxConcurrentAgents` (default min(16, 2x cores)); a per-run value can only narrow it. Excess `agent()` calls queue.
- **Deadline**: `workflow.scriptDeadlineMs` (default 12 h) is a hard wall-clock limit for the whole script.
- **Communicate by dataflow**: return a value from a child and pass it as `args` to the next, or `writeFile` a shared file and read it later.
