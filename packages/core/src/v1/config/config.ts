export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"
import { ConfigHarness } from "../../config/harness"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for opencode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Check for new versions and show an update notice. Updates are never installed automatically; confirm the notice or run `horde upgrade`. Set to false to disable update checks. true and 'notify' behave the same",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  vision_model: Schema.optional(Schema.String).annotate({
    description:
      "Model to use for image/vision subagent tasks in the format of provider/model. If unset, a vision-capable model is chosen automatically (in-house models preferred, then cheapest).",
  }),
  model_groups: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        // string shorthand: group is just its default model
        Schema.String,
        Schema.Struct({
          default: Schema.String,
          models: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
        }),
      ]),
    ),
  ).annotate({
    description:
      "Named model groups (capability tiers, e.g. ultra/standard/lite). Each group has a default model and optional member models. A group name can be used anywhere a provider/model string is accepted.",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  subagent_depth: Schema.optional(NonNegativeInt).annotate({
    description:
      "Maximum subagent nesting depth. Defaults to 3 (main agent, coordinating supervisor, workers, helpers). Values above 8 are capped at 8. Set 1 to keep subagents from launching subagents.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  harness: Schema.optional(ConfigHarness.Info).annotate({ description: "Harness mode configuration" }),
  workflow: Schema.optional(
    Schema.Struct({
      maxConcurrentAgents: Schema.optional(Schema.Number).annotate({
        description: "Process-wide ceiling on subagents running concurrently across ALL workflow runs.",
      }),
      scriptDeadlineMs: Schema.optional(Schema.Number).annotate({
        description: "Wall-clock budget for a whole workflow script, in milliseconds.",
      }),
    }),
  ).annotate({ description: "Dynamic workflow runtime settings." }),
  supervisor: Schema.optional(
    Schema.Struct({
      max_subagents: Schema.optional(PositiveInt).annotate({
        description:
          "Subagents the supervisor tool runs at once in one session tree (the session and every session under it). Default: 8. Values above 16 are capped at 16. Workflow agents have their own limit (workflow.maxConcurrentAgents).",
      }),
    }),
  ).annotate({ description: "Supervisor tool settings." }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  tool: Schema.optional(
    Schema.Struct({
      invocation_style: Schema.optional(Schema.Literals(["json", "shell"])).annotate({
        description:
          "Default invocation style for all tools. 'json' (default) exposes the original Zod schema; 'shell' exposes a single `script` parameter and uses the tool's shell.parse mapping.",
      }),
      invocation_style_by_tool: Schema.optional(
        Schema.Record(Schema.String, Schema.Literals(["json", "shell"])),
      ).annotate({
        description:
          "Per-tool override of invocation_style. Keys are tool IDs. A tool without a `shell` field falls back to JSON regardless of this setting.",
      }),
    }),
  ).annotate({
    description: "Tool invocation style configuration (JSON vs shell-style).",
  }),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Maximum number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction. By default retention is limited only by the preserved token budget.",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
      max_context: Schema.optional(
        Schema.Union([Schema.Union([NonNegativeInt, Schema.String]), Schema.Record(Schema.String, Schema.Union([NonNegativeInt, Schema.String]))]),
      ).annotate({
        description:
          'Compact earlier than the model window. A token count (300000), a shorthand string ("300K", "1M", "50%"), ' +
          'or a map keyed by "<providerID>/<modelID>" with wildcards ("openai/gpt-5*"). Always clamped to the ' +
          "model's real window — it can only lower the compaction trigger, never raise it. 0 means no budget.",
      }),
    }),
  ),
  checkpoint: Schema.optional(
    Schema.Struct({
      thresholds: Schema.optional(Schema.Array(Schema.String)).annotate({
        description:
          "Context fill thresholds that trigger checkpoint writes. Strings may be percentages (\"40%\"), absolute tokens (\"100K\", \"1.5M\"), or mixed (\"100K\", \"50%\"). Each threshold must be <= window - 20K reserved. Default: [\"40%\", \"60%\", \"80%\"].",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer reserved for checkpoint operations. Default: 20000.",
      }),
      max_writer_failures: Schema.optional(PositiveInt).annotate({
        description:
          "Deprecated: has no effect; kept so existing configs still load.",
      }),
      fork: Schema.optional(Schema.Boolean).annotate({
        description:
          "Whether to fork the parent agent's message prefix into the writer session for prefix-cache reuse. Requires provider cache-breakpoint support. Default: false.",
      }),
      push_caps: Schema.optional(
        Schema.Struct({
          tasks_ledger: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the tasks ledger section of rebuild context. Default: 2000.",
          }),
          focus_task: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the focus task body in rebuild context. Default: 4000.",
          }),
          supervisor_ledger: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the supervisor ledger section of rebuild context. Default: 500.",
          }),
          memory_titles: Schema.optional(PositiveInt).annotate({
            description: "Token cap for memory titles in rebuild context. Default: 500.",
          }),
          global: Schema.optional(PositiveInt).annotate({
            description:
              "Token cap for the global memory section (global/MEMORY.md) of rebuild context. Default: 6000.",
          }),
          checkpoint: Schema.optional(PositiveInt).annotate({
            description:
              "Token cap for the session checkpoint section (checkpoint.md) of rebuild context. Default: 11000.",
          }),
          memory: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the project memory section (MEMORY.md) of rebuild context. Default: 10000.",
          }),
          notes: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the session notes (notes.md) of rebuild context. Default: 6000.",
          }),
          design_decisions: Schema.optional(PositiveInt).annotate({
            description: "Token cap for §10 Design decisions section of checkpoint.md (writer-side budget validation). Default: 3000.",
          }),
          open_notes: Schema.optional(PositiveInt).annotate({
            description: "Token cap for §11 Open notes section of checkpoint.md (writer-side budget validation). Default: 800.",
          }),
          recent_user: Schema.optional(NonNegativeInt).annotate({
            description: "Token cap for the recent user input section (verbatim user messages from the live DB, FIFO eviction). Default: 16000. Set 0 to disable.",
          }),
          recent_user_per_msg: Schema.optional(PositiveInt).annotate({
            description: "Per-message cap inside recent user input section; oversized messages get head/tail truncation with messageID elision marker. Default: 2000.",
          }),
        }),
      ).annotate({
        description:
          "Per-section token caps for rebuild context (renderRebuildContext). Each section is loaded up to its cap so the rebuild stays within a predictable budget.",
      }),
      task_archive_days: Schema.optional(PositiveInt).annotate({
        description: "Days after a task is done or abandoned before it is hidden from task lists that exclude archived tasks. Rows are kept, not deleted. Default: 7.",
      }),
      task_cleanup_days: Schema.optional(PositiveInt).annotate({
        description: "Deprecated alias of task_archive_days.",
      }),
      memory_reconcile_on_search: Schema.optional(Schema.Boolean).annotate({
        description: "Whether to reconcile memory state on search operations. Default: true.",
      }),
      memory_search_score_floor: Schema.optional(Schema.Number).annotate({
        description:
          "Relative BM25 floor for memory.search (OR-joined query): keep results scoring >= this fraction of the top hit, dropping common-word-only noise. The #1 result is always kept. Default: 0.15. Set 0 to keep all matches.",
      }),
    }),
  ),
  memory: Schema.optional(
    Schema.Struct({
      disable_write: Schema.optional(Schema.Boolean).annotate({
        description:
          "Stop WRITING new memory. Default: false (memory is written). When true, no new memory is produced — session checkpoint.md, project MEMORY.md, notes.md and per-task progress.md are never written, the high-pressure 'save your learnings to memory' nudge is suppressed, and automatic dream/distill runs are skipped. Existing memory stays READABLE on demand: the builtin `memory` search tool keeps working and the files can still be read directly. What does stop is the AUTOMATIC injection — checkpoint rebuild is short-circuited to compaction while writing is off, and the memory dumps that a rebuild would have placed in context are only produced by that rebuild, so nothing is loaded on its own; an agent that wants memory has to search or read for it. Nothing is ever deleted — set it back to false to resume writing on top of the existing files.",
      }),
      cc_index: Schema.optional(Schema.Boolean).annotate({
        description:
          "Index Claude Code memory (~/.claude/projects/<slug>/memory) and expose under scope='cc'. Default: false. Note: when enabled, every hordecode agent (build/explore/subagents) can search these memories via the builtin `memory` tool — including CC's `type: user` (your role/preferences) and `type: feedback` (your guidance) categories. CC originally writes them for future CC sessions; flipping this on widens the consumer set to hordecode agents on the same machine. Leave disabled (default) if you don't want personal context recallable from a prompt-injection-vulnerable agent.",
      }),
      embedding: Schema.optional(Schema.Boolean).annotate({
        description:
          "Enable semantic (vector) memory search. Default false. When true the embedding model (about 133 MB) is downloaded once into <cache>/models on first use; search stays keyword-only until it is ready.",
      }),
    }),
  ),
  history: Schema.optional(
    Schema.Struct({
      kinds: Schema.optional(
        Schema.Array(
          Schema.Literals(["user_text", "assistant_text", "tool_input", "tool_error", "reasoning", "tool_output"]),
        ),
      ).annotate({
        description:
          "Which part kinds the history FTS index should cover. Defaults to text (user/assistant) + tool input + tool errors. Add 'reasoning' or 'tool_output' to grow recall at the cost of database size. Note: enabling 'tool_output' reclassifies completed tools from kind='tool_input' to kind='tool_output' (input remains searchable in the body, but kind:['tool_input'] filter will then only match pending/error tools).",
      }),
    }),
  ).annotate({
    description: "Trajectory (conversation history) FTS index configuration.",
  }),
  dream: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger dream memory consolidation on new session start. Default: false (no background work without opting in).",
      }),
      interval_days: Schema.optional(NonNegativeInt).annotate({
        description: "Minimum days between automatic dream runs. Set to 0 to trigger on every new session. Default: 7.",
      }),
    }),
  ),
  distill: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger distill workflow packaging on new session start. Default: false (no background work without opting in).",
      }),
      interval_days: Schema.optional(NonNegativeInt).annotate({
        description: "Minimum days between automatic distill runs. Default: 30.",
      }),
    }),
  ),
  cron: Schema.optional(
    Schema.Struct({
      timezone: Schema.optional(Schema.String).annotate({
        description:
          "Default timezone (IANA, e.g. Europe/Istanbul) for cron schedule jobs. Omit = system local timezone.",
      }),
    }),
  ).annotate({ description: "Cron scheduling defaults." }),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      switches: Schema.optional(
        Schema.Struct({
          workspaces: Schema.optional(Schema.Boolean),
          orchestrator: Schema.optional(Schema.Boolean),
          workflow_tool: Schema.optional(Schema.Boolean),
          cron: Schema.optional(Schema.Boolean),
          permission_audit: Schema.optional(Schema.Boolean),
          sandbox: Schema.optional(Schema.Boolean),
          hashline: Schema.optional(Schema.Boolean),
        }),
      ).annotate({
        description:
          "Turn on Hordecode experimental features. Read once at startup; restart to apply. An environment variable that is set always wins.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      predict_next_prompt: Schema.optional(Schema.Boolean).annotate({
        description:
          "Predict the user's likely next prompt after each turn and show it as inline ghost text (Tab to accept). Enabled by default; set to false to disable.",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
      maxMode: Schema.optional(
        Schema.Struct({
          candidates: Schema.optional(PositiveInt).annotate({
            description: "Number of parallel reasoning candidates per step in max mode (default 5).",
          }),
        }),
      ).annotate({
        description:
          "Max mode (experimental): the 'max' agent runs N parallel reasoning candidates each step, picks the best via a judge call, and executes only the winner.",
      }),
      try_best: Schema.optional(
        Schema.Struct({
          edit_window: Schema.optional(Schema.Number),
          edit_similarity: Schema.optional(Schema.Number),
          edit_matches: Schema.optional(Schema.Number),
          action_streak: Schema.optional(Schema.Number),
          bash_retries: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
