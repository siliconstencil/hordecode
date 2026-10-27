# Configuration notes

Settings that change how Hordecode prices, caches and asks. Config files are `hordecode.jsonc` or
`hordecode.json` (`opencode.json` also works) in the project or in the global config directory.
Hordecode reads its configuration when a project starts and keeps it for that session of the
project: after editing a file, restart Hordecode or reopen the project.

## Model prices

Hordecode takes model prices from the model catalog. If a price is missing or wrong, set your own
for any model. Prices are in US dollars per million tokens:

```json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-5-5": {
          "cost": { "input": 2, "output": 10, "cache_read": 0.2, "cache_write": 2.5 }
        }
      }
    }
  }
}
```

`input` and `output` are required inside `cost`. `cache_read`, `cache_write` and
`context_over_200k` (a second set of the same four prices for prompts above 200K tokens) are
optional. A price you set is used as given.

## Cache lifetime

Anthropic keeps a prompt cache entry for five minutes after each request that reads or writes it.
For long pauses between turns you can ask for a one-hour entry per model:

```json
{ "provider": { "anthropic": { "models": { "claude-sonnet-5-5": { "cachePromptTTL": "1h" } } } } }
```

Allowed values are `"5m"` (the default, the same as leaving the setting out) and `"1h"`. A
one-hour entry costs more to write than a five-minute one, so it pays off when you often return to
a session after more than five minutes. The setting applies to Anthropic and OpenRouter models;
other providers ignore it.

## The TTL and Cache rows

For Anthropic models the sidebar Telemetry panel shows how the prompt cache stands. The `Cache`
row is the hit rate over the session. The `TTL` row shows the state of the last request's entry:

| Row | Meaning |
| --- | --- |
| `TTL     warm 03:41` | The entry is alive for 3 minutes 41 seconds more. The clock counts from the start of the last request and uses the model's lifetime from the section above. |
| `TTL     cold  next turn re-caches ~190K tokens (~$0.48)` | The entry has expired; the next request writes about 190K tokens again at the model's cache-write price. |

No `TTL` row appears before the first cached request or for other providers.

If the cache is not read on two turns in a row with more than 20K tokens of prompt, a warning is
written to the log.

## Default agent

`default_agent` chooses the agent a session starts on. It must be a primary agent that is not
hidden; if it is missing or invalid the session starts on `build`. The terminal UI honors it at
startup, and an agent you pick during a session wins over it.

```json
{ "default_agent": "plan" }
```

## Auto-approve is remembered per project

The auto-approve toggle (command palette: "Enable auto-approve permissions") is saved for the
project directory you are working in. When you reopen the project, auto-approve is switched on
again and a short notice says "Auto-approve restored for this project". Turning it off removes the
saved choice. Launching with `--auto` always starts in auto-approve for that run. Permission rules
that deny a tool, and confirmations that always require a person (such as deleting files outside
temporary folders), still apply.

## Permission requests that nobody answers

A permission prompt waits five minutes for a reply. If none arrives, the tool call is not run, the
prompt closes, and the session continues. The transcript shows `Permission request timed out after
300s, command not run.` (`tool call not run` for tools other than the shell) and the model receives
the same sentence as the tool result, so it can explain or try another approach. This is a timeout,
not a refusal: it does not count as you denying the action.

## Commands that work outside the project

Tools may touch paths inside the project directory freely. A path outside it, including a
directory reached through a symbolic link that leads out of the project, needs the
`external_directory` permission, which asks by default. A shell line such as
`cd ../other && bun test` asks for `/path/other` first and then for the `bun test` command. To
allow a directory without being asked, list it:

```json
{ "permission": { "external_directory": { "/home/me/shared/*": "allow" } } }
```

A leading `cd` into a directory inside the project does not change which command rule matches:
`cd packages/x && bun test` is matched as `bun test`.

## Experimental switches

`experimental.switches` turns on Hordecode features that are off by default. Set them in the global
config file (the `hordecode.jsonc` in your global config directory):

```json
{ "experimental": { "switches": { "permission_audit": true, "sandbox": true, "hashline": true } } }
```

| Key | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `workspaces` | `HORDECODE_EXPERIMENTAL_WORKSPACES` | off | Workspaces and Warp, which moves a session into a git worktree |
| `orchestrator` | `HORDECODE_EXPERIMENTAL_ORCHESTRATOR` | off | The orchestrator agent |
| `workflow_tool` | `HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL` | on | Workflow commands |
| `cron` | `HORDECODE_EXPERIMENTAL_CRON` | on | Cron commands |
| `permission_audit` | `HORDECODE_PERMISSION_AUDIT` | off | The permission audit log |
| `sandbox` | `HORDECODE_SANDBOX` | off | The shell sandbox on Linux (`true` sets `auto`) |
| `hashline` | `HORDECODE_HASHLINE` | off | The `hashline_read` and `hashline_edit` tools |

`workflow_tool` and `cron` stay on unless they are set to `false`. The other switches are on only when
set to `true`. An environment variable that is set wins over the config value. `HORDECODE_SANDBOX=required`
is set in the environment only. `HORDECODE_EXPERIMENTAL=true` also turns on `workspaces` and
`orchestrator`.

The switches are read once at startup, so restart Hordecode after you change one. The **Hordecode
features** command (Ctrl+P, then System) edits these switches and the `memory.embedding` setting, and
asks for a restart when you save. It shows the environment variable next to any row that an environment
variable sets.

## Permission audit log

With `HORDECODE_PERMISSION_AUDIT=1` (or the `permission_audit` switch) every permission decision and reply is
written as one JSON line to `<data>/log/permission.jsonl`. The file rotates at 5 MiB
(`HORDECODE_PERMISSION_AUDIT_MAX_BYTES`) and keeps three older files.

Each line carries `prev`, the SHA-256 of the line before it, and the chain continues across rotation.
`horde debug audit-verify [file]` walks the files oldest first and reports the first line that does not match,
so a line that was edited or removed in the middle of the log is found. Lines written before the chain existed
are counted as legacy.

The chain is a local integrity check without a secret key, which sets its scope:

- Someone who can write the file can also rewrite the whole chain consistently; keep the log where only you can
  write, or copy it elsewhere if you need tamper evidence against other users.
- Lines removed from the end of the newest file leave a shorter, valid chain.
- When the oldest file rotates out, the first remaining line becomes the start of the chain.
- Two Hordecode processes writing to the same log at the same time can interleave lines and break the chain;
  verify reports the first such line.

## OpenTelemetry

Hordecode sends traces, logs and metrics over OTLP/HTTP when an endpoint is set. Nothing is sent without
one.

| Variable | Use |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The common endpoint. `/v1/traces`, `/v1/logs` and `/v1/metrics` are appended. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The full URL for traces, used as given. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The full URL for logs, used as given. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | The full URL for metrics, used as given. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` pairs sent with each request. |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated `key=value` resource attributes. |
| `OTEL_SDK_DISABLED=true` | Turns every signal off. |

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**View status** (Ctrl+X S) lists the endpoints the server exports to, without credentials or query strings,
or "No OpenTelemetry export".

What is exported:

- Traces: one `chat <model>` span per model step, with the `gen_ai.*` token usage attributes, the reasoning
  and cache token counts, `hordecode.cost.usd`, `hordecode.latency_ms`, `hordecode.ttft_ms` and the finish
  reason. Supervisor spawn spans carry `supervisor.mode`, `agent.type`, `context.mode`, `session.id`,
  `parent.session.id` and `supervisor.background`.
- Logs: the Hordecode log records.
- Metrics, exported every 30 seconds: `gen_ai.client.token.usage` (by `gen_ai.token.type`),
  `hordecode.chat.cost` (US dollars) and `hordecode.chat.duration` (milliseconds). The attributes are the
  provider and the model only.

Prompt text, task text, file paths, tool arguments and error messages are never added to spans or metrics.

## Hashline edits

Hashline is an opt-in edit mode that addresses lines by number and checks a tag for the whole file, so an
edit applies only to the text the agent read. Turn it on with `HORDECODE_HASHLINE=1` (or `true`), or with
the `hashline` switch in `experimental.switches`. Two tools are then available:

- `hashline_read` returns a header `[path#tag]` followed by numbered rows (`n:content`). The tag is a short
  hash of the whole file. Binary files are refused, and one view is limited to 40 KB. Use `offset` and
  `limit` to read the rest of a large file.
- `hashline_edit` applies line operations, using the line numbers from the read and the tag from its
  header:

| Op | Effect |
| --- | --- |
| `replace` | Replaces lines `start` to `end` with `lines`. An empty `lines` deletes them. |
| `delete` | Removes lines `start` to `end`. |
| `insert_before` | Inserts `lines` before line `start`. |
| `insert_after` | Inserts `lines` after line `start`. `0` inserts at the top of the file. |

All operations in one call refer to the original numbering, and overlapping operations are rejected. If the
file changed after the read, the edit is rejected and the file is left as it was; read it again. A
successful edit reports a `New tag`, so the next edit can run without another read.

## Advisor

The advisor is an optional second model that reviews the current task when the work looks risky. It is off
by default. When a trigger fires, the advisor reads a compact transcript of the current turn and returns up
to a few short notes, each marked `nit`, `concern` or `blocker`. The notes reach the agent in its next model
call as a reminder, and the cost of the advisor call is added to that step. The advisor runs in primary sessions
only and cannot change files. Each review appears in the conversation as an **Advisor** row with its notes, or
"reviewed this step, no notes"; when the advisor model is unavailable, or the call fails or takes longer than 60
seconds, the row says "review failed" with the reason and the agent continues without notes. The row is shown to
you only; the agent sees the notes once, in that step. While the advisor is on, the prompt footer shows
`advisor`.

The triggers are checked at each step:

- files touched in the current turn
- failed tool calls, including a shell command that exits with a non-zero code
- the same error repeated
- context used, as a percentage of the model's context window

```json
{
  "experimental": {
    "advisor": {
      "enabled": true,
      "model": "anthropic/claude-sonnet-5-5",
      "sensitivity": "default",
      "min_severity": "concern",
      "triggers": { "files_touched": 8, "tool_failures": 3, "same_error": 2, "context_percent": 70 },
      "max_notes": 4,
      "cooldown_steps": 3
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | `true` turns the advisor on. `model` must be set as well. |
| `model` | A `provider/model` value or a model group name. |
| `sensitivity` | `low`, `default` or `high`. Sets the presets below. |
| `min_severity` | The lowest note that is kept: `nit`, `concern` (the default) or `blocker`. |
| `triggers` | Thresholds for the four triggers. An explicit value overrides the preset. |
| `max_notes` | The most non-blocker notes kept per review (default 4). Blockers are always kept. |
| `cooldown_steps` | Steps to wait after a review before the next one. An explicit value overrides the preset. |

Presets:

| Sensitivity | `files_touched` | `tool_failures` | `same_error` | `context_percent` | `cooldown_steps` |
| --- | --- | --- | --- | --- | --- |
| `low` | 12 | 4 | 3 | 85 | 6 |
| `default` | 8 | 3 | 2 | 70 | 3 |
| `high` | 5 | 2 | 2 | 60 | 2 |

A threshold of `0` turns that trigger off. Cooldown and repeat suppression reset on each new user message.
Within a turn, a review does not repeat for the same triggers, only when a new trigger joins them.

The **Advisor** command (palette: Advisor, or `/advisor`) turns the advisor on or off, picks its model from
the connected providers, sets the sensitivity and switches the notes between all notes and concerns and
blockers only. Changes apply without a restart.
