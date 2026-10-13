import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = Config.boolean("HORDECODE_EXPERIMENTAL").pipe(
  Config.orElse(() => Config.boolean("OPENCODE_EXPERIMENTAL")),
  Config.withDefault(false),
)
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: Config.boolean("HORDECODE_AUTO_SHARE").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_AUTO_SHARE")),
    Config.withDefault(false),
  ),
  pure: Config.boolean("HORDECODE_PURE").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_PURE")),
    Config.withDefault(false),
  ),
  disableDefaultPlugins: Config.boolean("HORDECODE_DISABLE_DEFAULT_PLUGINS").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_DISABLE_DEFAULT_PLUGINS")),
    Config.withDefault(false),
  ),
  disableEmbeddedWebUi: Config.boolean("HORDECODE_DISABLE_EMBEDDED_WEB_UI").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_DISABLE_EMBEDDED_WEB_UI")),
    Config.withDefault(false),
  ),
  disableExternalSkills: Config.boolean("HORDECODE_DISABLE_EXTERNAL_SKILLS").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_DISABLE_EXTERNAL_SKILLS")),
    Config.withDefault(false),
  ),
  disableLspDownload: Config.boolean("HORDECODE_DISABLE_LSP_DOWNLOAD").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_DISABLE_LSP_DOWNLOAD")),
    Config.withDefault(false),
  ),
  disableClaudeCodePrompt: Config.all({
    broad: Config.boolean("HORDECODE_DISABLE_CLAUDE_CODE").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_DISABLE_CLAUDE_CODE")),
      Config.withDefault(false),
    ),
    direct: Config.boolean("HORDECODE_DISABLE_CLAUDE_CODE_PROMPT").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")),
      Config.withDefault(false),
    ),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: Config.boolean("HORDECODE_DISABLE_CLAUDE_CODE").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_DISABLE_CLAUDE_CODE")),
      Config.withDefault(false),
    ),
    direct: Config.boolean("HORDECODE_DISABLE_CLAUDE_CODE_SKILLS").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")),
      Config.withDefault(false),
    ),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: Config.boolean("HORDECODE_ENABLE_EXA").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_ENABLE_EXA")),
      Config.withDefault(false),
    ),
    legacy: Config.boolean("HORDECODE_EXPERIMENTAL_EXA").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_EXPERIMENTAL_EXA")),
      Config.withDefault(false),
    ),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: Config.boolean("HORDECODE_ENABLE_PARALLEL").pipe(
      Config.orElse(() => Config.boolean("OPENCODE_ENABLE_PARALLEL")),
      Config.withDefault(false),
    ),
    legacy: bool("OPENCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: Config.boolean("HORDECODE_ENABLE_EXPERIMENTAL_MODELS").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_ENABLE_EXPERIMENTAL_MODELS")),
    Config.withDefault(false),
  ),
  enableQuestionTool: Config.boolean("HORDECODE_ENABLE_QUESTION_TOOL").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_ENABLE_QUESTION_TOOL")),
    Config.withDefault(false),
  ),
  experimentalReferences: enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: Config.boolean("HORDECODE_EXPERIMENTAL_LSP_TY").pipe(
    Config.orElse(() => Config.boolean("OPENCODE_EXPERIMENTAL_LSP_TY")),
    Config.withDefault(false),
  ),
  experimentalLspTool: enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OPENCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OPENCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OPENCODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("HORDECODE_CLIENT").pipe(
    Config.orElse(() => Config.string("OPENCODE_CLIENT")),
    Config.withDefault("cli"),
  ),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
