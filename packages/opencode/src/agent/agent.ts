import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"
import { Flag } from "@opencode-ai/core/flag/flag"
import PROMPT_DREAM from "@opencode-ai/agent/prompt/dream.txt"
import PROMPT_DISTILL from "@opencode-ai/agent/prompt/distill.txt"
import PROMPT_ORCHESTRATOR from "@opencode-ai/core/session/prompt/orchestrator"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { usesGPTToolset } from "@/tool/gpt"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_GENERAL from "./prompt/general.txt"
import PROMPT_GENERATE_GPT from "./prompt/generate-gpt.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { ProtectedPath } from "@/permission/protected-path"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  // Non-overridable rules re-appended AFTER the user/session permissions during
  // runtime evaluation (see runtimePermission). Use for agent invariants that
  // config must not be able to relax — e.g. plan mode's edit/write block.
  hardPermission: Schema.optional(PermissionV1.Ruleset),
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  completionGate: Schema.optional(Schema.Boolean),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  // Mode-specific skill pipeline namespace. When set, the session prompt
  // injection loads skills from this pipeline's bundle (e.g. "harness" loads
  // harness:*, "research" loads research:*).
  skillPipeline: Schema.optional(Schema.String),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

// Merge an agent's permission with the user/session ruleset, then re-append the
// agent's hardPermission so those invariants win over any allow rule a user or
// session approval could introduce. Every permission-evaluation site routes
// through this — there is no per-agent name special-casing.
export function runtimePermission(agent: Info, permission?: PermissionV1.Ruleset): PermissionV1.Ruleset {
  return Permission.merge(agent.permission ?? [], permission ?? [], agent.hardPermission ?? [], ProtectedPath.ruleset())
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
              }),
              user,
            ),
            // Plan mode's one hard invariant: writes to non-plan files are
            // blocked and user/session config must NOT be able to relax it.
            // Re-appended after the user merge by runtimePermission so it always
            // wins. (Every write tool — write/edit/multiedit/apply_patch/
            // notebook_edit — funnels through ctx.ask({ permission: "edit" }),
            // so this single rule governs all file writes.) Deliberately scoped
            // to edit only: bash/change_directory/workflow are left to the
            // model's own read-only discipline + plan prompt, matching the
            // project's "trust the model, permission layer is a backstop"
            // stance. The "*":"deny" carries a non-"*" allow exception, so the
            // edit tool stays in the schema (no tool-list mutation on mode
            // switch).
            hardPermission: Permission.fromConfig({
              edit: {
                "*": "deny",
                [path.join(".hordecode", "plans", "*.md")]: "allow",
                [path.join(".opencode", "plans", "*.md")]: "allow",
                [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
              },
            }),
            mode: "primary",
            native: true,
          },
          harness: {
            name: "harness",
            description: "Harness mode. Orchestrates workflows with built-in harness skills.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                skill: { "harness:*": "allow" },
              }),
              user,
            ),
            skillPipeline: "harness",
            color: "#a7a3d8",
            mode: "primary",
            native: true,
          },
          research: {
            name: "research",
            description: "Research mode. Orchestrates research workflows with built-in research skills.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                skill: { "research:*": "allow" },
              }),
              user,
            ),
            skillPipeline: "research",
            color: "#7fb3d5",
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description:
              "Full-capability general-purpose subagent for autonomous read/write work, including investigation, implementation, debugging, testing, and multi-step delivery. It inherits the parent's available tool surface and can complete a delegated task end to end.",
            permission: Permission.merge(defaults, user),
            options: {},
            mode: "subagent",
            prompt: PROMPT_GENERAL,
            completionGate: true,
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                codesearch: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "subagent",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          max: {
            name: "max",
            description: "Max mode (experimental). Runs N parallel candidates and executes the best one.",
            mode: "primary",
            native: true,
            hidden: false,
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
              }),
              user,
            ),
          },
          summary: {
            name: "summary",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
          // Personas built inline, not via agent-package factory functions,
          // because agent-package factories use Permission from @opencode-ai/core/permission
          // while opencode uses its own local @/permission module. Using the factories
          // would require opencode to talk to core's Permission module, creating a
          // dependency that boot-time module resolution cannot satisfy.)
          dream: {
            name: "dream",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            prompt: PROMPT_DREAM,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                write: "allow",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                memory: "allow",
                bash: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "memory")]: "allow",
                  [path.join(Global.Path.data, "memory", "*")]: "allow",
                },
              }),
              user,
            ),
          },
          distill: {
            name: "distill",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            prompt: PROMPT_DISTILL,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                write: "allow",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                memory: "allow",
                bash: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "memory")]: "allow",
                  [path.join(Global.Path.data, "memory", "*")]: "allow",
                },
              }),
              user,
            ),
          },
          "checkpoint-writer": {
            name: "checkpoint-writer",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            // opencode's agent registry is the one that wins at runtime (per the
            // Core<->opencode DI-tag gate; both share `@opencode/Agent`). core's
            // twin already registers this entry (packages/agent/src/agent.ts),
            // but without it here, spawning checkpoint-writer at runtime fails
            // with `Agent not found: "checkpoint-writer"` (/ live
            // regression). No `prompt` field — fork captures the parent's full
            // LLM request prefix into a frozen ForkContext at spawn time
            // (tryStartCheckpointWriter), so the writer reads from that snapshot
            // instead of recomputing from this agent's identity. Permission
            // inherits `defaults` (+ user) only; runtime write authority is
            // bounded by the supervisor.tools whitelist set in
            // tryStartCheckpointWriter and the memory-path-guard, so inheriting
            // `defaults` over-grants nothing in practice.
            permission: Permission.merge(defaults, user),
          },
          ...(Flag.HORDECODE_EXPERIMENTAL_ORCHESTRATOR
            ? {
                orchestrator: {
                  name: "orchestrator",
                  color: "#7fb3d5",
                  description:
                    "Orchestrator mode. A general-purpose coordinator that accomplishes goals by delegating work to child sessions; use the `session` tool to create/switch/list/cancel children running in their own mode and model.",
                  prompt: PROMPT_ORCHESTRATOR,
                  options: {},
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({
                      question: "allow",
                    }),
                    user,
                  ),
                  mode: "primary",
                  native: true,
                },
              }
            : {}),
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name === "orchestrator", "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE, ...(usesGPTToolset(resolved.id) ? [PROMPT_GENERATE_GPT] : [])]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"
