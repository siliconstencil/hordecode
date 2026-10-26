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
